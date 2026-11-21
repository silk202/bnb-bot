/**
 * SOL Scanner — the Flasher's LIVE ROUTE FEED for Solana.
 *
 * Mirrors the BNB Scanner: a live cross-venue feed of flash-loan routes
 * computed from real DexScreener Solana venue prices, a break-even spread
 * strip, manual/auto execution through the guard stack (profit floor →
 * lender fee check → execution), and honest execution recording. Nothing is
 * simulated — routes exist only when real venue prices carry the spread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import SolTelecopierBotPanel from "@/components/SolTelecopierBotPanel";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DailyTargetBadge } from "@/pages/terminal/Sniper";
import { useSolLiveFeed } from "@/hooks/use-sol-live-feed";
import { useTerminal } from "@/hooks/use-terminal";
import { useTradeSounds } from "@/hooks/use-trade-sounds";
import {
  JITO_MIN_TIP_LAMPORTS,
  JITO_RELAY_LABEL,
  LAMPORTS_PER_SOL,
  jitoSendProtectedTx,
  simulateSolTx,
  solSendPublicTx,
  solSubmissionPath,
  resolveSolRpcUrl,
  type SolCluster,
} from "@/lib/solana-jito";
import {
  SOL_DEXES,
  SOL_FLASH_LENDERS,
  solDexByKey,
  solLenderFeeLabel,
} from "@/lib/solana";
import {
  LAMPORTS_PER_SOL as LAMPORTS_SOL,
  executeLiveArb,
  fitRouteLoanToWallet,
  getInjectedSolProvider,
  resolveLiveSigner,
  solRpcCall,
} from "@/lib/solana-live-execution";
import {
  SOL_CLUSTER_GENESIS,
  SOL_VAULT_MIN_SWAP_LAMPORTS,
  solRailVerdict,
  solWalletRole,
  type SolExecutionRail,
  type SolWalletRole,
} from "@/lib/solana-policy";
import { SOL_MAX_LOAN_CAP, SOL_MIN_LOAN } from "@/lib/flashbolt";
import type { SolTelecopierRoute } from "@/lib/solana-routes";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowRightLeft,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

const MIN_PROFIT_FLOOR = 0.2; // % — same profit floor as the BNB terminal

/* ─── Daily arb tracker (localStorage, UTC day key — mirrors the sniper) ─── */
interface SolArbTracker {
  date: string;
  arbCount: number;
}
const ARB_TRACKER_KEY = "tracker_sol-scanner";
function solTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
function loadSolArbTracker(): SolArbTracker {
  try {
    const raw = localStorage.getItem(ARB_TRACKER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SolArbTracker;
      if (parsed.date === solTodayKey()) return parsed;
    }
  } catch { /* ignore */ }
  return { date: solTodayKey(), arbCount: 0 };
}
function incrementSolArbTracker(): void {
  const t = loadSolArbTracker();
  t.arbCount += 1;
  t.date = solTodayKey();
  try { localStorage.setItem(ARB_TRACKER_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}
function canSolArbExecute(limit: number): boolean {
  if (limit <= 0 || !isFinite(limit)) return true; // 0 = unlimited
  return loadSolArbTracker().arbCount < limit;
}

/** Resolve a leg's venue color for the feed row. */
function legColor(key: string): string {
  return solDexByKey(key)?.color ?? "var(--muted-foreground)";
}

export default function SolScanner() {
  const { state, recordExecution, recordNotification, bumpScan } = useTerminal();
  // Server-enforced subscriber daily target (shared with the snipers and BNB
  // FlashBolt) — the operator's increase/decrease/block applies here too.
  const consumeExecutionSlot = useMutation(api.terminal.consumeExecutionSlot);
  const {
    playExecute,
    playSuccess,
    playFail,
    playScan,
    playArbDetected,
    playFlashSubmitted,
    playFlashConfirmed,
    playFlashFailed,
    playAlert,
  } = useTradeSounds();
  const dexWhitelist = state?.dexWhitelists?.solana ?? [];
  const whitelist = dexWhitelist.length > 0 ? dexWhitelist : SOL_DEXES.map((d) => d.key);
  const maxLoan = state?.maxLoan ?? 5;
  const balanced = state?.lenderBalancer ?? false;
  const minProfit = state?.minProfit ?? MIN_PROFIT_FLOOR;
  const mode = state?.mode ?? "paper";
  const botRunning = state?.botRunning ?? true;
  // Private-RPC submission (Jito-style on SOL, mirroring BNB's privateSubmit):
  // signed route txs go to the Jito block-engine — outside the public mempool
  // path, with revert protection (bundleOnly) so failing routes never land.
  const privateSubmit = state?.privateSubmit ?? true;
  // Testnet/Mainnet cluster from the flasher's Strategy setup (default mainnet).
  const solCluster: SolCluster = state?.solNetwork === "testnet" ? "testnet" : "mainnet";
  const solRpcUrl = resolveSolRpcUrl(solCluster, state?.solRpcOverrides);
  const submission = useMemo(() => solSubmissionPath(solCluster), [solCluster]);
  // Execution rail: Jupiter swaps or the FlashboltSolana program. The rail
  // verdict is the exact gate the engine enforces (program ID, authorization,
  // mainnet audit) — an unarmed rail refuses before any signing.
  const rail: SolExecutionRail = state?.solExecutionRail ?? "jupiter";
  const railVerdict = useMemo(
    () =>
      solRailVerdict({
        rail,
        cluster: solCluster,
        programId: state?.solContractProgramId ?? "",
        authorized: state?.solContractAuthorized ?? false,
        auditApproved: state?.solAuditApproved ?? false,
      }),
    [
      rail,
      solCluster,
      state?.solContractProgramId,
      state?.solContractAuthorized,
      state?.solAuditApproved,
    ],
  );
  // The genesis hash the RPC must report before signing: the operator's pin,
  // or the canonical hash for the selected cluster.
  const expectedGenesis =
    state?.solPinnedGenesis?.trim() ||
    SOL_CLUSTER_GENESIS[solCluster === "testnet" ? "devnet" : "mainnet"];

  const feed = useSolLiveFeed({
    paused: !botRunning,
    cadence: state?.cadence ?? 15,
    dexWhitelist: whitelist,
    balanced,
    // Strategy bounds: borrow between min 0.5 SOL and the strategy max,
    // hard-capped at 5/50 SOL (maxLoan defaults to 5 until raised).
    loanSizeSol: Math.min(
      SOL_MAX_LOAN_CAP,
      Math.max(SOL_MIN_LOAN, (state?.maxLoan ?? 5) / 2),
    ),
  });

  // ── Telecopier routes — copied Telegram signals with a live spread ──
  const [telecopierRoutes, setTelecopierRoutes] = useState<SolTelecopierRoute[]>([]);
  const handleTelecopierRoute = useCallback((r: SolTelecopierRoute) => {
    setTelecopierRoutes((prev) => [r, ...prev.filter((p) => p.id !== r.id)].slice(0, 20));
  }, []);

  // ── Execution recording (honest statuses only) ──
  const recordRef = useRef(recordExecution);
  recordRef.current = recordExecution;

  // ── Merged feed: market routes + telecopier routes ──
  const allRoutes = useMemo(
    () => [...telecopierRoutes, ...feed.routes],
    [telecopierRoutes, feed.routes],
  );
  const [executedIds, setExecutedIds] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState<string | null>(null);
  const [autoExec, setAutoExec] = useState(true);

  // ── Live wallet balance — powers the feed's wallet-fit preview ──
  // Live mode only: resolve the same signer execution uses and read its real
  // lamports (nothing simulated). Refreshes each scan tick and after every
  // execution; null = unknown (paper mode / no wallet / RPC hiccup) → rows
  // show the plain loan size.
  const [walletLamports, setWalletLamports] = useState<number | null>(null);
  // Which wallet signs: the in-app vault or a connected extension (external).
  const [walletRole, setWalletRole] = useState<SolWalletRole>("none");
  useEffect(() => {
    if (mode !== "live") {
      setWalletLamports(null);
      setWalletRole("none");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const signer = await resolveLiveSigner();
        if (!signer?.publicKey) {
          if (!cancelled) {
            setWalletLamports(null);
            setWalletRole("none");
          }
          return;
        }
        const address = signer.publicKey.toString();
        const { vaultSignerAddresses } = await import("@/lib/solana-vault");
        const role = solWalletRole(address, vaultSignerAddresses());
        if (!cancelled) setWalletRole(role);
        const bal = await solRpcCall<number>(solRpcUrl, "getBalance", [address]);
        if (!cancelled) setWalletLamports(typeof bal === "number" ? bal : null);
      } catch {
        if (!cancelled) {
          setWalletLamports(null);
          setWalletRole("none");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, solRpcUrl, feed.run, executedIds]);

  const executeRoute = useCallback(
    async (r: SolTelecopierRoute) => {
      if (executing || executedIds.has(r.id)) return;
      // GUARD: the selected execution rail must be armed, and the contract
      // rail must never fall through to a Jupiter swap. Refused configs never
      // reach a wallet prompt (paper mode credits locally).
      if (mode === "live" && rail === "solcontract") {
        setExecutedIds((prev) => new Set(prev).add(r.id));
        await recordRef.current({
          label: r.legs.join(" → "),
          profitPct: r.profitPct,
          amountBnb: 0,
          status: "failed",
          lender: r.lender,
          dexes: r.dexes.join("+"),
          chain: "solana",
          nativeSymbol: "SOL",
          relay: "rail:solcontract",
        });
        toast.error("solcontract rail cannot execute yet", {
          description: railVerdict.ok
            ? "The rail is authorized, but the engine has no flash_arb instruction builder yet — no contract call is fabricated and no Jupiter swap runs under a contract label. Switch to the Jupiter rail to trade."
            : railVerdict.message,
        });
        return;
      }
      if (mode === "live" && !railVerdict.ok) {
        setExecutedIds((prev) => new Set(prev).add(r.id));
        await recordRef.current({
          label: r.legs.join(" → "),
          profitPct: r.profitPct,
          amountBnb: 0,
          status: "failed",
          lender: r.lender,
          dexes: r.dexes.join("+"),
          chain: "solana",
          nativeSymbol: "SOL",
          relay: `rail:${rail}`,
        });
        toast.error("Execution rail blocked", { description: railVerdict.message });
        return;
      }
      // GUARD STACK (mirrors the BNB scanner): daily arb target first.
      const dailyTarget = state?.dailyArbTarget ?? 0;
      if (!canSolArbExecute(dailyTarget)) {
        setExecutedIds((prev) => new Set(prev).add(r.id));
        toast.error(`Daily arbitrage target reached (${loadSolArbTracker().arbCount}/${dailyTarget})`, {
          description: "Raise the target in Strategy → Daily arbitrage target.",
        });
        return;
      }
      // GUARD: subscriber daily target (server-enforced) — shared with snipes
      // and BNB FlashBolt. Consumed only when the route actually executes.
      try {
        const slot = await consumeExecutionSlot({ kind: "flash", chain: "sol", label: r.legs.join(" → ") });
        if (slot.blocked) {
          setExecutedIds((prev) => new Set(prev).add(r.id));
          toast.warning("Daily target reached", { description: slot.reason });
          return;
        }
      } catch {
        toast.error("Could not verify your daily target — execution aborted.");
        return;
      }
      // GUARD: profit floor.
      if (r.profitPct < minProfit) {
        setExecutedIds((prev) => new Set(prev).add(r.id));
        await recordRef.current({
          label: r.legs.join(" → "),
          profitPct: r.profitPct,
          amountBnb: 0,
          status: "below_floor",
          lender: r.lender,
          dexes: r.dexes.join("+"),
          chain: "solana",
          nativeSymbol: "SOL",
        });
        toast.info("Route below the profit floor", {
          description: `${r.legs.join(" → ")} nets ${r.profitPct.toFixed(2)}% < ${minProfit}% floor.`,
        });
        return;
      }
      setExecuting(r.id);
      playExecute();
      try {
        // Atomic round trip: spread must cover both venue fees (already
        // netted into profitPct) — positive = success, zero/negative fails.
        const ok = r.profitPct > 0;
        // LIVE MODE — REAL execution with the connected wallet: Jupiter
        // quotes both legs, the wallet signs, the buy lands, then the sell.
        // Paper mode never broadcasts — the credit stays local.
        let relay: string | undefined;
        let txHash: string | undefined;
        if (ok && mode === "live" && r.tokenAddress) {
          // Shared signer resolution: imported vault signer (in-memory
          // ed25519) first, then the connected extension — same rule the
          // sniper uses. Neither armed → honest refusal, never paper.
          const provider = await resolveLiveSigner();
          if (!provider?.publicKey) {
            toast.error("No unlocked wallet", {
              description:
                "Import a wallet (passphrase vault) or connect/unlock Phantom/Solflare/Backpack — live mode signs with YOUR key; nothing is simulated.",
            });
            await recordRef.current({
              label: r.legs.join(" → "),
              profitPct: r.profitPct,
              amountBnb: 0,
              status: "failed",
              lender: r.lender,
              dexes: r.dexes.join("+"),
              chain: "solana",
              nativeSymbol: "SOL",
              relay: "no-wallet",
            });
            setExecutedIds((prev) => new Set(prev).add(r.id));
            return;
          }
          const loanLamports = Math.max(
            1,
            Math.floor((r.loanSizeSol ?? r.loanSizeBnb) * LAMPORTS_SOL),
          );
          const out = await executeLiveArb({
            mint: r.tokenAddress,
            loanLamports,
            provider,
            slippageBps: Math.round((state?.slippage ?? 0.5) * 100),
            solRpcUrl,
            // Jito block-engine when protected submission is ON; otherwise the
            // public RPC carries the signed txs — live is live either way.
            jitoEngines:
              privateSubmit && submission.relay === "jito" ? [...submission.engines] : undefined,
            // Wallet-fit: the wallet FRONTS the clip on Solana, so a signal
            // bigger than the balance is fitted DOWN to what the wallet can
            // actually front (balance − fees/rent, min 0.05 SOL) and lands as
            // a real, smaller trade instead of a doomed Phantom popup.
            fitToWallet: true,
            // Cluster pin (pinned or canonical genesis) and the operator's
            // execution-time profit floor on the clip that actually lands.
            expectedGenesis,
            minProfitPct: minProfit,
            minLoanLamports:
              walletRole === "vault" ? SOL_VAULT_MIN_SWAP_LAMPORTS : undefined,
            onPhase: (phase) => {
              if (phase === "buy") playFlashSubmitted();
              if (phase === "sell") playFlashConfirmed();
            },
          });
          relay = out.engine;
          txHash = out.ok ? out.sellSig : out.buySig;
          if (!out.ok) {
            // Honest ledger: pre-flight refusals never reached the chain —
            // record them as plain failures, not "below_floor" profits.
            const refusedBeforeWallet =
              out.error === "no-wallet" || out.engine === "preflight-balance";
            await recordRef.current({
              label: r.legs.join(" → "),
              profitPct: r.profitPct,
              amountBnb: 0,
              status: refusedBeforeWallet ? "failed" : "below_floor",
              lender: r.lender,
              dexes: r.dexes.join("+"),
              chain: "solana",
              nativeSymbol: "SOL",
              relay,
              txHash,
            });
            toast.error(
              out.engine === "preflight-balance"
                ? "Route refused before the wallet"
                : "Live route did not land",
              {
                description:
                  out.error === "no-wallet"
                    ? "Unlock your wallet and retry — nothing was broadcast."
                    : out.error ?? "The route was dropped honestly; zero gas burned.",
              },
            );
            if (!refusedBeforeWallet) playFlashFailed();
            setExecutedIds((prev) => new Set(prev).add(r.id));
            return;
          }
          // REAL outcome: net SOL from the executed quotes, attributed with
          // the real sell signature. Rows carry txHash → live ledger.
          const netSol = Math.round((out.netLamports / LAMPORTS_SOL) * 1e6) / 1e6;
          await recordRef.current({
            label: `LIVE ${r.legs.join(" → ")}`,
            profitPct: Math.round(out.netPct * 100) / 100,
            amountBnb: netSol,
            status: "success",
            lender: r.lender,
            dexes: [...out.venues].join("+") || r.dexes.join("+"),
            chain: "solana",
            nativeSymbol: "SOL",
            relay,
            txHash,
          });
          incrementSolArbTracker();
          // Decent report: when the clip was fitted to the wallet, say so
          // first — requested → executed — then the real venues/net/sig.
          const fitNote = out.fit
            ? `fitted ${(out.fit.requestedLamports / LAMPORTS_SOL).toFixed(4)} → ${(
                out.fit.loanLamports / LAMPORTS_SOL
              ).toFixed(4)} SOL to the wallet · `
            : "";
          const walletNote = out.walletRole === "vault" ? "vault wallet · " : "external wallet · ";
          const floorNote =
            out.floorMet === false
              ? " · exit quote fell below the profit floor after the buy landed"
              : "";
          const pnlNote = out.netMeasured === false
            ? " · closing balance unreadable, PnL not measured"
            : "";
          toast.success(`Live arb landed +${out.netPct.toFixed(2)}%`, {
            description: `${fitNote}${walletNote}${out.venues.slice(0, 2).join(" + ") || "Jupiter"} · net ${netSol.toFixed(4)} SOL · sell ${out.sellSig?.slice(0, 10)}…${floorNote}${pnlNote}`,
          });
          setExecutedIds((prev) => new Set(prev).add(r.id));
          return;
        }
        if (mode === "live" && !r.tokenAddress) {
          // LIVE but unexecutable (no mint on the route): honest failure —
          // live mode NEVER falls back to paper credits.
          await recordRef.current({
            label: r.legs.join(" → "),
            profitPct: r.profitPct,
            amountBnb: 0,
            status: "failed",
            lender: r.lender,
            dexes: r.dexes.join("+"),
            chain: "solana",
            nativeSymbol: "SOL",
            relay: "no-mint",
          });
          toast.info("Route skipped in live mode", {
            description: "This signal carries no token mint — nothing was broadcast or credited.",
          });
          setExecutedIds((prev) => new Set(prev).add(r.id));
          return;
        }
        await recordRef.current({
          label: r.legs.join(" → "),
          profitPct: r.profitPct,
          // Paper credit: profit % of the loan, denominated in SOL.
          amountBnb: ok
            ? Math.round(((r.loanSizeSol ?? r.loanSizeBnb) * r.profitPct) / 100 * 1e6) / 1e6
            : 0,
          status: ok ? "success" : "failed",
          lender: r.lender,
          dexes: r.dexes.join("+"),
          chain: "solana",
          nativeSymbol: "SOL",
          relay,
          txHash,
        });
        if (ok) {
          playFlashConfirmed();
          incrementSolArbTracker();
          toast.success("Route executed", {
            description: `+${r.profitPct.toFixed(2)}% on ${(r.loanSizeSol ?? r.loanSizeBnb).toFixed(1)} SOL borrowed from ${r.lender}.`,
          });
        } else {
          playFlashFailed();
          toast.error("Route failed", {
            description: "Round trip would not cover fees — recorded as failed.",
          });
        }
      } finally {
        setExecuting(null);
        setExecutedIds((prev) => new Set(prev).add(r.id));
      }
    },
    [
      executing,
      executedIds,
      minProfit,
      mode,
      rail,
      railVerdict,
      expectedGenesis,
      walletRole,
      solRpcUrl,
      submission,
      privateSubmit,
      state?.slippage,
      playExecute,
      playFlashConfirmed,
      playFlashFailed,
      playFlashSubmitted,
      playAlert,
    ]);

  // AUTO execution — fires for every fresh profitable route once.
  useEffect(() => {
    if (!autoExec || !botRunning) return;
    if (!canSolArbExecute(state?.dailyArbTarget ?? 0)) return;
    for (const r of allRoutes) {
      if (executedIds.has(r.id) || r.profitPct <= 0) continue;
      if (executing) return;
      void executeRoute(r);
    }
  }, [allRoutes, autoExec, botRunning, executedIds, executing, executeRoute, state?.dailyArbTarget]);

  // Honey-pot display alerts — same rule as the BNB scanner: high profit +
  // high liquidity routes ping the notification center (in-app bell + sound).
  const notifiedHoneyRef = useRef(new Set<string>());
  useEffect(() => {
    const HONEY_PROFIT = 1.0; // % — same defaults as the BNB honey-pot guard
    const HONEY_LIQ = 50_000; // $
    const fresh = feed.routes
      .filter(
        (r) =>
          r.profitPct >= HONEY_PROFIT &&
          r.liquidityUsd >= HONEY_LIQ &&
          !notifiedHoneyRef.current.has(r.id),
      )
      .slice(0, 3);
    if (fresh.length === 0) return;
    fresh.forEach((r) => notifiedHoneyRef.current.add(r.id));
    const first = fresh[0]!;
    // In-app display alert (bell) — Telegram stays flash-loan-trade-only.
    void recordNotification({
      kind: "honey_pot",
      title: "Honey pot detected",
      body: `+${first.profitPct.toFixed(2)}% · ${first.legs.join(" → ")} · $${Math.round(first.liquidityUsd / 1000)}k liquidity · ${first.lender}`,
      chainKey: "solana",
    }).catch(() => undefined);
    toast.success("Honey pot detected", {
      description: `+${first.profitPct.toFixed(2)}% on Solana — ${first.legs.join(" → ")}`,
    });
    playArbDetected();
  }, [feed.routes, recordNotification, playArbDetected]);

  // Scanner tick sound — one ping per fresh scan run (like BNB's scan tick).
  const lastScanRef = useRef<number | null>(null);
  useEffect(() => {
    if (feed.lastScan === null) return;
    if (lastScanRef.current === null) {
      lastScanRef.current = feed.lastScan;
      return;
    }
    if (feed.lastScan !== lastScanRef.current) {
      lastScanRef.current = feed.lastScan;
      playScan();
    }
  }, [feed.lastScan, playScan]);

  // Sync the real open-opportunity count into Convex once per scan tick
  // (mirrors the BNB Scanner): scansToday advances and openOpportunities
  // tracks the merged live feed — telecopier routes included, never fabricated.
  const lastCountedSolScan = useRef<number | null>(null);
  useEffect(() => {
    if (!feed.lastScan || lastCountedSolScan.current === feed.lastScan) return;
    lastCountedSolScan.current = feed.lastScan;
    if (state?.botRunning) {
      // chain:"sol" — the SOL terminal's browser loop stamps the SOL engine's
      // own freshness fields, never the BNB loop's (bots stay independent).
      void bumpScan({ count: allRoutes.length, chain: "sol" }).catch(() => undefined);
    }
  }, [feed.lastScan, allRoutes.length, bumpScan, state?.botRunning]);

  const breakEvenPct = useMemo(() => {
    // Cheapest possible round trip: the two lowest-fee venues on Solana
    // (Raydium 0.25% + Meteora 0.2%) + the cheapest lender in the rotation
    // (Jupiter Lend / MarginFi, both 0% — read from the registry, not typed).
    const fees = SOL_DEXES.map((d) => d.fee).sort((a, b) => a - b);
    const lenderFee = Math.min(...SOL_FLASH_LENDERS.map((l) => l.feePct));
    return Math.round(((fees[0]! + fees[1]!) * 100 + lenderFee) * 100) / 100;
  }, []);

  const loanDisplay = Math.min(SOL_MAX_LOAN_CAP, Math.max(SOL_MIN_LOAN, maxLoan / 2));
  const dailyArbTarget = state?.dailyArbTarget ?? 0;
  const arbUsedToday = loadSolArbTracker().arbCount;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Scanner
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Live cross-venue arbitrage on Solana — Raydium · Orca · Meteora · PumpSwap · daily target {arbUsedToday}/{dailyArbTarget === 0 ? "∞" : dailyArbTarget}
        </p>
      </header>

      {/* Break-even spread strip */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
        <span className="text-[11px] font-semibold text-muted-foreground">
          Min Spread (Break-Even):
        </span>
        <span className="font-mono text-sm font-bold text-foreground">
          {breakEvenPct.toFixed(2)}%
        </span>
        <span className="text-[10px] text-muted-foreground">
          cheapest two-venue round trip + {Math.min(...SOL_FLASH_LENDERS.map((l) => l.feePct)).toFixed(2)}% flash fee · WSOL → token → WSOL
          {privateSubmit && (
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-500">
              <ShieldCheck className="inline size-3" />
              {JITO_RELAY_LABEL} · revert protection (min tip {JITO_MIN_TIP_LAMPORTS.toLocaleString()} lamports =
              {(JITO_MIN_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL)
            </span>
          )}
        </span>
      </div>

      {/* Settings · contract · strategy — the exact state the engine enforces */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border/60 bg-card/40 px-4 py-2.5 text-[10px] text-muted-foreground">
        <span>
          Rail:{" "}
          <span className="font-semibold text-foreground">
            {rail === "jupiter" ? "Vault · Jupiter swaps" : "Vault · solcontract"}
          </span>
        </span>
        <span>
          Wallet:{" "}
          <span className="font-semibold text-foreground">
            {walletRole === "vault" ? "Vault" : walletRole === "external" ? "External" : "none"}
          </span>
        </span>
        <span>
          Cluster pin:{" "}
          <span className="font-mono text-foreground">
            {solCluster === "testnet" ? "devnet" : "mainnet"} · {expectedGenesis.slice(0, 6)}…{expectedGenesis.slice(-4)}
          </span>
        </span>
        <span>
          Profit floor: <span className="font-semibold text-foreground">{minProfit}%</span> of the executed clip
        </span>
        <span>
          Submission:{" "}
          <span className="font-semibold text-foreground">
            {privateSubmit && submission.relay === "jito" ? "Jito protected" : "Public RPC"}
          </span>
        </span>
      </div>

      {!railVerdict.ok && mode === "live" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-semibold">Execution rail is blocked — no route can sign</div>
            <div className="mt-0.5 text-[11px]">{railVerdict.message}</div>
          </div>
        </div>
      )}

      <SolTelecopierBotPanel
        onRoute={handleTelecopierRoute}
        dexWhitelist={whitelist}
        lender={feed.lender}
        loanSizeSol={loanDisplay}
        run={feed.run}
      />

      {/* Feed header controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">
            LIVE ROUTE FEED
          </h2>
          <Badge variant="outline" className="text-[10px]">
            {allRoutes.length} routes
          </Badge>
          <DailyTargetBadge />
          {feed.loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            <Switch checked={autoExec} onCheckedChange={setAutoExec} className="scale-90" />
            Auto-execute
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={feed.rescan}
            disabled={feed.loading}
          >
            <RefreshCw className={cn("size-3", feed.loading && "animate-spin")} />
            Rescan
          </Button>
        </div>
      </div>

      {feed.error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-500">
          <AlertTriangle className="size-4 shrink-0" />
          {feed.error}
        </div>
      )}

      {/* LIVE ROUTE FEED */}
      {allRoutes.length === 0 ? (
        <Card className="border-dashed border-border/70 bg-card/30">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <ArrowRightLeft className="size-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              {feed.loading
                ? "Sweeping the Solana venue board…"
                : "No two-venue spread above the fees right now — the feed reticks every " +
                  (state?.cadence ?? 15) +
                  "s. Nothing is fabricated."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70">
          <div className="divide-y divide-border/40">
            {allRoutes.map((r) => {
              const isExecuted = executedIds.has(r.id);
              const isExecuting = executing === r.id;
              const belowFloor = r.profitPct < minProfit;
              const loanSol = r.loanSizeSol ?? r.loanSizeBnb;
              // Wallet-fit preview — the exact sizing execution will use.
              const walletFit =
                walletLamports === null
                  ? null
                  : fitRouteLoanToWallet(
                      walletLamports,
                      Math.max(1, Math.floor(loanSol * LAMPORTS_SOL)),
                    );
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-accent/30 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.legs.map((leg, i) => (
                        <span key={`${leg}-${i}`} className="flex items-center gap-1.5">
                          {i > 0 && <span className="text-[10px] text-muted-foreground/60">→</span>}
                          <span
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                              solDexByKey(leg)
                                ? "border-border/70 bg-background/60"
                                : "border-primary/30 bg-primary/10 text-primary",
                            )}
                            style={solDexByKey(leg) ? { color: legColor(leg) } : undefined}
                          >
                            {leg}
                          </span>
                        </span>
                      ))}
                      {r.signalSource && r.signalSource !== "Market sweep" && (
                        <Badge variant="outline" className="ml-1 text-[9px] uppercase">
                          {r.signalSource}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span>{solLenderFeeLabel(r.lender)}</span>
                      <span>liq ${Math.round(r.liquidityUsd / 1000)}k</span>
                      <span>venue spread +{r.venueSpreadPct.toFixed(2)}%</span>
                      <span>ttl {r.ttlSeconds}s</span>
                      <span>MEV risk {r.mevRisk}/100</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <div
                        className={cn(
                          "font-mono text-sm font-bold",
                          r.profitPct > 0 ? "text-emerald-400" : "text-red-400",
                        )}
                      >
                        {r.profitPct > 0 ? "+" : ""}
                        {r.profitPct.toFixed(2)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {walletFit?.fitted ? (
                          <>
                            loan {loanSol.toFixed(1)} →{" "}
                            <span className="font-semibold text-primary">
                              fit {(walletFit.loanLamports / LAMPORTS_SOL).toFixed(4)} SOL
                            </span>
                          </>
                        ) : walletFit && !walletFit.ok ? (
                          <>
                            loan {loanSol.toFixed(1)} · wallet below{" "}
                            {(
                              (walletFit.minFitLamports + walletFit.reserveLamports) /
                              LAMPORTS_SOL
                            ).toFixed(4)}{" "}
                            SOL
                          </>
                        ) : (
                          <>loan {loanSol.toFixed(1)} SOL</>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-[10px]"
                      variant={belowFloor ? "outline" : "default"}
                      disabled={isExecuted || Boolean(executing) || (autoExec && !belowFloor)}
                      onClick={() => void executeRoute(r)}
                    >
                      {isExecuting ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : isExecuted ? (
                        "Done"
                      ) : (
                        <>
                          <Zap className="size-3" />
                          Execute
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        <ShieldCheck className="mr-1 inline size-3 text-primary" />
        Guard stack: cluster pin (getGenesisHash) → rail gate → profit floor {minProfit}%
        of the executed clip (checked against the quotes that build the txs) → read-abort on any
        failed balance read →
        {privateSubmit ? " Jito protected submission with a real tip →" : ""} execution.
        Paper mode credits the paper account; live mode carries the signed route
        tx through the Jito block-engine outside the public mempool. Nothing is
        simulated — routes exist only when real DexScreener venue prices carry
        the spread.
      </p>
    </div>
  );
}
