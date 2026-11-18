/**
 * useAutoSell — monitors active sniped positions with LIVE prices and
 * auto-sells through the real PancakeSwap router when the profit margin is
 * met (high sellability), or when price starts dropping — locking profit
 * before it fades.
 *
 * Every sell is a REAL router transaction, pre-flighted with a full
 * eth_estimateGas simulation: if the sell would revert (honeypot sell-tax
 * trap, pulled liquidity), nothing is broadcast and ZERO gas is spent.
 * Failed sells flip the win/loss tracker exactly like failed buys.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchTokenPriceUsd, sellToken, type SellResult, type SwapSigner } from "@/lib/swap-executor";
import { executionEnvFor, type ChainKey } from "@/lib/chains";
import type { ChainExecutionEnv } from "@/lib/chains";
import { classifyExit, fetchTokenPairTvlNative } from "@/lib/profit-guarantor";

export interface SnipedPosition {
  id: string;
  symbol: string;
  address: string;
  /** Chain the position lives on ("bsc" | "ethereum" | "arbitrum" | "polygon"). */
  chain: ChainKey;
  buyPriceUsd: number;
  buyAmountBnb: number;
  /** Tokens actually received from the real buy (wei) — drives the real sell. */
  tokensWei: bigint | null;
  decimals: number;
  buyTimestamp: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  pnlPct: number;
  sellPct: number;
  /** Sell amount: % of the sellPct slice a sell event disposes of (partial exits). */
  sellAmountPct: number;
  profitTargetPct: number;
  trailingStopPct: number;
  status: "holding" | "selling" | "sold";
  /** Wrapped-native TVL at entry (profit guarantor baseline). */
  entryTvlNative: number | null;
  /** Price one poll window ago (fast value-drop detection). */
  prevPriceUsd: number;
  /** Last exit signal from the guarantor (for logs/toasts). */
  lastExitSignal: "drastic-liquidity-drop" | "value-drop" | null;
}

export interface UseAutoSellOptions {
  /** Whether auto-sell is enabled (default: true). */
  enabled?: boolean;
  /** Default profit target percentage (default: 10%). */
  profitTargetPct?: number;
  /** Default sell amount: % of the sellPct slice each sell disposes of (default: 100). */
  sellAmountPct?: number;
  /** Trailing stop percentage below peak (default: 5%). */
  trailingStopPct?: number;
  /** Poll interval in ms for price checks (default: 2500). */
  pollIntervalMs?: number;
  /** Slippage tolerance percent for sells. */
  slippagePct?: number;
  /** Default chain for positions added without an explicit chain. */
  defaultChain?: ChainKey;
  /** Which network of each chain to execute on (mirrors the terminal switch). */
  network?: "mainnet" | "testnet";
  /** Private-relay submission for hot-wallet sells (anti-frontrun). */
  privateSubmit?: { enabled: boolean; network: "mainnet" | "testnet" };
  /** Operator's private RPC override for a chain, when set on the Contract page. */
  rpcOverride?: string;
  /** Resolves the active signer (hot wallet first — automatic). */
  getSigner?: () => SwapSigner | null;
  /** Fired when a position sell completes (success or simulated-fail-free revert-free path). */
  onSell?: (position: SnipedPosition, sellPnl: number, relay?: string, signingLatencyMs?: number) => void;
  /** Fired when a sell fails or reverts (counts as a loss). */
  onSellFailed?: (position: SnipedPosition, reason: string) => void;
  /**
   * Fired when policy refused the sell before anything was built. Separate from
   * onSellFailed because a refusal is not a loss — the position stays open and
   * the caller decides whether to record it.
   */
  onBlocked?: (
    position: SnipedPosition,
    block: { code: string; reason: string; chainId: number; router: string },
  ) => void;
}

export function useAutoSell(options: UseAutoSellOptions = {}) {
  const {
    enabled = true,
    profitTargetPct = 10,
    sellAmountPct: defaultSellAmountPct = 100,
    trailingStopPct = 5,
    pollIntervalMs = 2_500,
    slippagePct = 3,
    defaultChain = "bsc",
    network = "mainnet",
    privateSubmit,
    rpcOverride,
    getSigner,
    onSell,
    onSellFailed,
    onBlocked,
  } = options;

  /** Real execution environment for a position's chain on the ACTIVE network. */
  const envFor = useCallback(
    (chain: ChainKey): ChainExecutionEnv => executionEnvFor(chain, network, rpcOverride),
    [rpcOverride, network],
  );

  const [positions, setPositions] = useState<SnipedPosition[]>([]);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const sellingRef = useRef(new Set<string>());

  /**
   * Add a new position to track (called right after the real buy tx confirms).
   */
  const addPosition = useCallback(
    (
      symbol: string,
      address: string,
      buyPriceUsd: number,
      buyAmountBnb: number,
      sellPct: number,
      tokensWei: bigint | null,
      decimals: number,
      chain: ChainKey = defaultChain,
      entryTvlNative: number | null = null,
      sellAmountPct: number = defaultSellAmountPct,
    ): SnipedPosition => {
      const pos: SnipedPosition = {
        id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        address,
        chain,
        buyPriceUsd,
        buyAmountBnb,
        tokensWei,
        decimals,
        buyTimestamp: Date.now(),
        currentPriceUsd: buyPriceUsd,
        peakPriceUsd: buyPriceUsd,
        pnlPct: 0,
        sellPct,
        sellAmountPct: Math.max(1, Math.min(100, sellAmountPct)),
        profitTargetPct,
        trailingStopPct,
        status: "holding",
        entryTvlNative,
        prevPriceUsd: buyPriceUsd,
        lastExitSignal: null,
      };
      setPositions((prev) => [...prev, pos]);
      return pos;
    },
    [profitTargetPct, trailingStopPct, defaultChain, defaultSellAmountPct],
  );

  const removePosition = useCallback((id: string) => {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  /**
   * Execute a REAL sell for a position through the router. Returns the sell
   * tx hash, or null when the full eth_estimateGas simulation failed — in
   * which case NOTHING was broadcast and zero gas was spent.
   */
  const executeSell = useCallback(
    async (position: SnipedPosition): Promise<Hex | null> => {
      const signer = getSigner?.();
      if (!signer) {
        toast.error("No signer — sell skipped", {
          description: "Generate a hot wallet or connect the direct wallet to auto-sell.",
        });
        return null;
      }

      // Mark as selling
      setPositions((prev) =>
        prev.map((p) => (p.id === position.id ? { ...p, status: "selling" as const } : p)),
      );
      sellingRef.current.add(position.id);

      toast.loading(`Simulating sell: ${position.symbol}`, {
        id: `sell-${position.id}`,
        description: "Full eth_estimateGas pre-flight — zero gas if it would fail",
      });

      // Sell on the position's OWN chain — every chain executes identically
      // through its real execution environment (router / wrapped / RPC).
      const env = envFor(position.chain);
      let result: SellResult;
      try {
        result = await sellToken({
          signer,
          env,
          tokenAddress: position.address,
          // Composed disposal (mirrors the overlay): sell % (position slice)
          // × sell amount % (share of that slice), clamped to ≤100%.
          sellPct: Math.min(
            100,
            (position.sellPct * Math.max(1, Math.min(100, position.sellAmountPct ?? 100))) / 100,
          ),
          slippagePct,
          recipient: signer.from,
          privateSubmit,
        });
      } catch (e) {
        result = { simulationPassed: false, simulationError: e instanceof Error ? e.message : "Sell failed" };
      }

      if (!result.simulationPassed) {
        // Simulation failed → nothing broadcast → zero gas. Keep holding so
        // the position can be retried (liquidity/tax may recover), but flag it.
        sellingRef.current.delete(position.id);
        setPositions((prev) =>
          prev.map((p) =>
            p.id === position.id ? { ...p, status: "holding" as const } : p,
          ),
        );
        if (result.blocked) {
          toast.error("Sell refused by policy", {
            description: `${result.blocked.reason} — the position stays open. Nothing was built or signed.`,
          });
          // A refusal is not a loss: report it through its own channel.
          onBlocked?.(position, {
            code: result.blocked.code,
            reason: result.blocked.reason,
            chainId: env.chainId,
            router: env.router,
          });
          return null;
        }
        onSellFailed?.(position, result.simulationError ?? "Simulation failed");
        toast.error(`Sell blocked — zero gas spent: ${position.symbol}`, {
          id: `sell-${position.id}`,
          description: `${result.simulationError ?? "Would revert"} — position stays open for retry.`,
        });
        return null;
      }

      if (result.status !== "success") {
        sellingRef.current.delete(position.id);
        setPositions((prev) =>
          prev.map((p) => (p.id === position.id ? { ...p, status: "holding" as const } : p)),
        );
        onSellFailed?.(position, "Sell transaction reverted on-chain");
        toast.error(`Sell reverted: ${position.symbol}`, {
          id: `sell-${position.id}`,
          description: "On-chain revert — position stays open for retry.",
        });
        return null;
      }

      // Sold. Compute realized PnL from the live price at execution.
      const livePrice = await fetchTokenPriceUsd(position.address);
      const exitPrice = livePrice ?? position.currentPriceUsd;
      const sellPnl =
        position.buyPriceUsd > 0
          ? ((exitPrice - position.buyPriceUsd) / position.buyPriceUsd) * 100
          : 0;

      setPositions((prev) =>
        prev.map((p) =>
          p.id === position.id
            ? { ...p, status: "sold" as const, currentPriceUsd: exitPrice, pnlPct: sellPnl }
            : p,
        ),
      );
      onSell?.(position, sellPnl, result.relay, result.signingLatencyMs);
      toast.success(`Sold ${position.symbol}`, {
        id: `sell-${position.id}`,
        description: `Tx ${result.txHash?.slice(0, 10)}… · PnL ${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(2)}%${result.relayDegraded ? " · ⚠ relays in cooldown → public RPC" : result.relay ? ` · via ${result.relay.replace(/^https:\/\//, "")}` : " · public RPC"}`,
      });
      setTimeout(() => removePosition(position.id), 5_000);
      return result.txHash ?? null;
    },
    [getSigner, envFor, slippagePct, onSell, onSellFailed, removePosition],
  );

  // Price monitoring loop — live prices, triggers sells
  useEffect(() => {
    if (!enabled || positionsRef.current.length === 0) {
      if (isMonitoring) setIsMonitoring(false);
      return;
    }
    if (!isMonitoring) setIsMonitoring(true);

    let cancelled = false;
    const tick = async () => {
      const current = positionsRef.current;
      for (const pos of current) {
        if (pos.status !== "holding" || sellingRef.current.has(pos.id)) continue;
        if (cancelled) return;

        // LIVE price — real DexScreener pair data scoped to the position's
        // chain, no fabrication.
        const live = await fetchTokenPriceUsd(pos.address, envFor(pos.chain).chainId);
        if (live === null || live <= 0) continue;
        const price = live;
        const pnl =
          pos.buyPriceUsd > 0 ? ((price - pos.buyPriceUsd) / pos.buyPriceUsd) * 100 : 0;
        const peak = Math.max(pos.peakPriceUsd, price);
        const peakDropPct =
          peak > 0 ? ((peak - price) / peak) * 100 : 0;

        // ── PROFIT GUARANTOR: live exit classification ──
        // Real TVL from the chain (getReserves on the token's wrapped-native
        // pair). A drastic liquidity drop = rug in progress → exit NOW.
        let tvlNative: number | null = null;
        try {
          const env = envFor(pos.chain);
          if (env.router) {
            tvlNative = await fetchTokenPairTvlNative(
              env.rpcUrl,
              env.chainId,
              env.router,
              pos.address,
              env.wrapped,
            );
          }
        } catch {
          tvlNative = null;
        }
        const exit = classifyExit({
          tvlNative: tvlNative ?? pos.entryTvlNative ?? 0,
          entryTvlNative: pos.entryTvlNative ?? tvlNative ?? 0,
          price,
          prevPrice: pos.prevPriceUsd,
        });

        setPositions((prev) =>
          prev.map((p) =>
            p.id === pos.id
              ? { ...p, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak, prevPriceUsd: price, lastExitSignal: exit.exitSignal }
              : p,
          ),
        );
        positionsRef.current = positionsRef.current.map((p) =>
          p.id === pos.id
            ? { ...p, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak, prevPriceUsd: price, lastExitSignal: exit.exitSignal }
            : p,
        );

        // Exit signal (drastic liquidity drop / fast value % drop) → sell
        // immediately as the fastest gainer — before target/trailing checks.
        if (exit.exitSignal !== null) {
          toast.warning(
            exit.exitSignal === "drastic-liquidity-drop"
              ? `🚨 Liquidity drop: ${pos.symbol}`
              : `📉 Value drop: ${pos.symbol}`,
            {
              description: `${exit.reason} — selling immediately to lock value`,
            },
          );
          void executeSell({ ...pos, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak });
          continue;
        }

        if (pnl >= pos.profitTargetPct) {
          toast.info(`🎯 Profit target: ${pos.symbol} +${pnl.toFixed(2)}%`, {
            description: `Auto-selling at ${pos.profitTargetPct}% target`,
          });
          void executeSell({ ...pos, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak });
          continue;
        }
        if (peak > pos.buyPriceUsd && peakDropPct >= pos.trailingStopPct) {
          toast.info(`📉 Trailing stop: ${pos.symbol}`, {
            description: `Dropped ${peakDropPct.toFixed(1)}% from peak — locking profit`,
          });
          void executeSell({ ...pos, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak });
          continue;
        }
        const holdTimeMs = Date.now() - pos.buyTimestamp;
        if (holdTimeMs > 30 * 60_000 && pnl < 0) {
          toast.warning(`⏰ Hold timeout: ${pos.symbol}`, {
            description: `${Math.floor(holdTimeMs / 60_000)}m at ${pnl.toFixed(2)}% — cutting loss`,
          });
          void executeSell({ ...pos, currentPriceUsd: price, pnlPct: pnl, peakPriceUsd: peak });
        }
      }
    };

    const timer = setInterval(() => void tick(), pollIntervalMs);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
      setIsMonitoring(false);
    };
  }, [enabled, pollIntervalMs, executeSell, isMonitoring]);

  return {
    positions,
    isMonitoring,
    addPosition,
    removePosition,
    executeSell,
    profitTargetPct,
    trailingStopPct,
  };
}

type Hex = `0x${string}`;
