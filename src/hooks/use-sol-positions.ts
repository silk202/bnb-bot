/**
 * use-sol-positions — the live position manager behind the SOL sniper's
 * auto-exit (profit target / trailing stop / partial sells).
 *
 * Every number is REAL:
 *   · balance — getTokenAccountsByOwner against the active RPC
 *   · valuation — a live Jupiter quote for the actual balance
 *   · exits — executeLiveSnipeSell (sign → simulate → Jito/public → confirm)
 *   · realized proceeds — getBalance delta across the confirmed sell
 *
 * The engine (solana-exit-engine.ts) decides; this hook executes. When the
 * operator has not configured any exit automation (target 100% + no trail)
 * positions are still tracked and hand-sellable — the manager never invents
 * a reason to fire.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSolBalanceLamports,
  fetchTokenBalanceRaw,
  jupiterQuoteTokenToSol,
  executeLiveSnipeSell,
  type SolSigningProvider,
} from "@/lib/solana-live-execution";
import { decideExit, type ExitReason } from "@/lib/solana-exit-engine";
import type { SolCluster } from "@/lib/solana-jito";

const STORAGE_KEY = "fb.sol-positions.v2";
const TICK_MS = 30_000;

export interface LivePosition {
  id: string;
  mint: string;
  symbol: string;
  owner: string;
  /** SOL lamports actually spent to open (cost basis). */
  entryLamports: number;
  /** Token raw units held when the position opened. */
  openBalanceRaw: string;
  openedAt: number;
  buySig: string;
  cluster: SolCluster;
  peakRoiPct: number;
  status: "open" | "closed";
  closeSig?: string;
  closeReason?: ExitReason;
  /** Real measured net across the closing sell (lamports, incl. fees). */
  realizedNetLamports?: number;
  closedAt?: number;
}

export interface ExitEvent {
  position: LivePosition;
  reason: ExitReason;
  /** Token raw units actually sold in this exit leg. */
  soldRaw: string;
  sellSig: string;
  engine: string;
  /** Real measured SOL delta across the sell (lamports; negative = cost). */
  realizedNetLamports: number;
  roiPctAtDecision: number;
}

function loadPositions(): LivePosition[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LivePosition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(positions: LivePosition[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions.slice(-100)));
  } catch {
    // storage unavailable — session-only tracking, honestly degraded
  }
}

export function useSolPositions(opts: {
  enabled: boolean;
  getSigner: () => SolSigningProvider | null;
  rpcUrl: string;
  jitoEngines: string[] | null;
  slippagePct: number;
  profitTargetPct: number;
  sellAmountPct: number;
  trailingStopPct: number;
  onExit: (ev: ExitEvent) => void;
  onExitError?: (position: LivePosition, error: string) => void;
}) {
  const [positions, setPositions] = useState<LivePosition[]>(() => loadPositions());
  const [evaluating, setEvaluating] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const busyRef = useRef(false);

  useEffect(() => {
    persist(positions);
  }, [positions]);

  const patchPosition = useCallback((id: string, patch: Partial<LivePosition>) => {
    setPositions((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  /** Register a freshly opened live position (called by the sniper after the buy confirms). */
  const openPosition = useCallback(
    (p: Omit<LivePosition, "id" | "peakRoiPct" | "status">) => {
      const pos: LivePosition = {
        ...p,
        id: `${p.mint}:${p.openedAt}`,
        peakRoiPct: 0,
        status: "open",
      };
      setPositions((prev) => [...prev.filter((x) => x.id !== pos.id), pos].slice(-100));
      return pos;
    },
    [],
  );

  /** Manual full exit — the "Sell now" button. Same real sell path as auto. */
  const sellNow = useCallback(
    async (positionId: string, reasonOverride: ExitReason = "none"): Promise<boolean> => {
      const pos = optsRef.current
        ? (loadPositions().find((x) => x.id === positionId) ?? undefined)
        : undefined;
      if (!pos || pos.status !== "open") return false;
      const signer = optsRef.current.getSigner();
      if (!signer?.publicKey) return false;
      const balance = await fetchTokenBalanceRaw(optsRef.current.rpcUrl, pos.owner, pos.mint);
      if (balance === "0") {
        // Nothing held — close the ghost honestly.
        patchPosition(pos.id, { status: "closed", closeReason: "none", realizedNetLamports: 0, closedAt: Date.now() });
        return true;
      }
      const lamportsBefore = await fetchSolBalanceLamports(optsRef.current.rpcUrl, pos.owner);
      const sell = await executeLiveSnipeSell({
        mint: pos.mint,
        tokenAmountRaw: balance,
        slippageBps: Math.round(optsRef.current.slippagePct * 100),
        solRpcUrl: optsRef.current.rpcUrl,
        jitoEngines: optsRef.current.jitoEngines ?? undefined,
        provider: signer,
      });
      if (!sell.ok) {
        optsRef.current.onExitError?.(pos, sell.error ?? "manual sell failed");
        return false;
      }
      const lamportsAfter = await fetchSolBalanceLamports(optsRef.current.rpcUrl, pos.owner);
      const realized = lamportsAfter - lamportsBefore;
      const closed: LivePosition = {
        ...pos,
        status: "closed",
        closeSig: sell.sellSig,
        closeReason: reasonOverride,
        realizedNetLamports: realized,
        closedAt: Date.now(),
      };
      setPositions((prev) => prev.map((x) => (x.id === pos.id ? closed : x)));
      optsRef.current.onExit({
        position: closed,
        reason: reasonOverride,
        soldRaw: sell.soldRaw ?? balance,
        sellSig: sell.sellSig ?? "",
        engine: sell.engine,
        realizedNetLamports: realized,
        roiPctAtDecision: (realized / Math.max(1, pos.entryLamports)) * 100,
      });
      return true;
    },
    [patchPosition],
  );

  /** One evaluation pass over every open position — real balance, real quote, real exits. */
  const evaluateAll = useCallback(async () => {
    if (busyRef.current) return;
    const o = optsRef.current;
    const open = loadPositions().filter((p) => p.status === "open");
    if (!o.enabled || open.length === 0) return;
    const signer = o.getSigner();
    if (!signer?.publicKey) return;
    busyRef.current = true;
    setEvaluating(true);
    try {
      for (const pos of open) {
        try {
          // 1. REAL on-chain balance for this mint.
          const balance = await fetchTokenBalanceRaw(o.rpcUrl, pos.owner, pos.mint);
          if (balance === "0") continue; // nothing held (manual exit already moved it)
          // 2. REAL Jupiter quote for the full balance.
          let sellOut: number | null = null;
          try {
            const q = await jupiterQuoteTokenToSol(pos.mint, balance, Math.round(o.slippagePct * 100));
            sellOut = Number(q.outAmount);
          } catch {
            sellOut = null; // no route right now → honest hold this tick
          }
          // 3. Engine decision (pure).
          const decision = decideExit({
            entryLamports: pos.entryLamports,
            balanceRaw: balance,
            sellOutLamports: sellOut,
            peakRoiPct: pos.peakRoiPct,
            profitTargetPct: o.profitTargetPct,
            sellAmountPct: o.sellAmountPct,
            trailingStopPct: o.trailingStopPct,
          });
          patchPosition(pos.id, { peakRoiPct: decision.newPeakRoiPct });
          if (!decision.shouldExit) continue;
          // 4. REAL exit — measure the owner's SOL across the confirmed sell.
          const lamportsBefore = await fetchSolBalanceLamports(o.rpcUrl, pos.owner);
          const sell = await executeLiveSnipeSell({
            mint: pos.mint,
            tokenAmountRaw: decision.amountRaw,
            slippageBps: Math.round(o.slippagePct * 100),
            solRpcUrl: o.rpcUrl,
            jitoEngines: o.jitoEngines ?? undefined,
            provider: signer,
          });
          if (!sell.ok) {
            o.onExitError?.(pos, sell.error ?? "auto exit failed");
            continue;
          }
          const lamportsAfter = await fetchSolBalanceLamports(o.rpcUrl, pos.owner);
          const realized = lamportsAfter - lamportsBefore;
          const remainingRaw = (BigInt(balance) - BigInt(sell.soldRaw ?? "0")).toString();
          const closed =
            BigInt(remainingRaw) === 0n ||
            decision.reason === "trailing_stop" ||
            decision.reason === "stop_loss_floor";
          // Proportional cost-basis on partial exits (real accounting).
          const basisAfterPartial = closed
            ? 0
            : Math.round((pos.entryLamports * Number(remainingRaw)) / Number(pos.openBalanceRaw));
          const patched: Partial<LivePosition> = closed
            ? {
                status: "closed",
                closeSig: sell.sellSig,
                closeReason: decision.reason,
                realizedNetLamports: realized,
                closedAt: Date.now(),
              }
            : {
                entryLamports: basisAfterPartial,
                openBalanceRaw: remainingRaw,
              };
          setPositions((prev) =>
            prev.map((x) => (x.id === pos.id ? { ...x, ...patched } : x)),
          );
          o.onExit({
            position: { ...pos, ...patched } as LivePosition,
            reason: decision.reason,
            soldRaw: sell.soldRaw ?? decision.amountRaw,
            sellSig: sell.sellSig ?? "",
            engine: sell.engine,
            realizedNetLamports: realized,
            roiPctAtDecision: decision.currentRoiPct,
          });
        } catch (e) {
          o.onExitError?.(pos, e instanceof Error ? e.message : "evaluation failed");
        }
      }
    } finally {
      busyRef.current = false;
      setEvaluating(false);
    }
  }, [patchPosition]);

  // Ticker — evaluate while armed; re-evaluate immediately when a position opens.
  useEffect(() => {
    if (!opts.enabled) return;
    void evaluateAll();
    const t = setInterval(() => void evaluateAll(), TICK_MS);
    return () => clearInterval(t);
  }, [opts.enabled, evaluateAll]);

  const open = useMemo(() => positions.filter((p) => p.status === "open"), [positions]);
  const closed = useMemo(
    () => positions.filter((p) => p.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    [positions],
  );

  return { positions, open, closed, openPosition, sellNow, evaluateAll, evaluating };
}
