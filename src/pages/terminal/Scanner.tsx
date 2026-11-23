import { api } from "@/convex/_generated/api";
import { DailyTargetBadge } from "@/pages/terminal/Sniper";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useGasPrice } from "@/hooks/use-gas-price";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { useMempoolMonitor } from "@/hooks/use-mempool-monitor";
import { useTokenDiscovery } from "@/hooks/use-token-discovery";
import { TokenDiscoveryPanel } from "@/components/TokenDiscoveryPanel";
import { ScannerAlertBanner, type ScannerEvent } from "@/components/ScannerAlertBanner";
import { copyText } from "@/components/copy-text";
import { useTerminal } from "@/hooks/use-terminal";
import {
  BNB_NETWORKS,
  buildExecuteData,
  computeAmountOutMin,
  estimateFlashLoanGas,
  getInjectedProvider,
  getWalletAddress,
  isFlashBoltOwner,
  sendFlashLoanExecution,
  waitForFlashLoanReceipt,
  type NetworkKey,
} from "@/lib/chain";
import { arbitrageSignerVerdict, contractArmVerdict, type SignerSource } from "@/lib/wallet-guard";
import { preflightExecution } from "@/chains/execution/preflight";
import { sendSignedTransaction, gasPriceWeiFor, nextNonce } from "@/lib/swap-executor";
import { probeWalletSession } from "@/lib/wallet-session";
import {
  CHAIN_INFO,
  CHAIN_KEYS,
  effectiveRpc,
  resolveLoanAssetAddress,
  gasCostBnb,
  HONEY_POT_MIN_LIQUIDITY_USD,
  HONEY_POT_MIN_PROFIT_PCT,
  isBscChain,
  isHoneyPot,
  lenderFeeLabel,
  lenderFeePct,
  routeLabel,
  routePathAddresses,
  routeProfitBnb,
  riskLevel,
  BNB_MAX_LOAN_CAP,
  BNB_MIN_LOAN,
  DEFAULT_FEED_SETTINGS,
  simulateFlashLoanTx,
  loadDailyTracker,
  saveDailyTracker,
  incrementTracker,
  canExecute,
  type ChainKey,
  type FeedSettings,
  type FlashRoute,
} from "@/lib/flashbolt";
import { detectCrossChainSpreads, actionableForChain, type CrossChainSpread } from "@/lib/crosschain-spread";
import { flashRouteForSpread } from "@/lib/crosschain-route";
import TelecopierBotPanel from "@/components/TelecopierBotPanel";
import type { TelecopierRoute } from "@/lib/telecopier-routes";
import { networkInfoFor, type NetworkKey as ChainNetworkKey } from "@/lib/chains";
import { isPrivateRpcAvailable } from "@/lib/private-rpc";
import { generateMnemonic, english, privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  getVaultHotWallet as evmGetVaultHotWallet,
} from "@/lib/evm-vault";
import { verifyRouteLive, type RouteVerification } from "@/lib/profit-guarantor";
import type { Hex } from "viem";
import { cn } from "@/lib/utils";
import {
  BellRing,
  CheckCircle2,
  Clock,
  Gauge,
  KeyRound,
  Landmark,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  WifiOff,
  Zap,
} from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTradeSounds } from "@/hooks/use-trade-sounds";
import { useTelegramAlerts } from "@/hooks/use-telegram-alerts";
import { generateWBNBRoutes, toFlashRoute, type GeneratedRoute } from "@/lib/route-generator";
import { scoreFlashRoute, discoverRoutes, type CandidateCapture } from "@/lib/ai-agent-determinants";
import { analyzeMevPass, analyzeMevPassBatch, nlpAwareGuardDecision, type NlpMevResult } from "@/lib/nlp-mev-analyzer";
import { AgentChipStrip, AgentVoteDots, ConsensusBadge } from "@/components/AgentStrip";
import { toast } from "sonner";

export default function Scanner() {
  const {
    state,
    recordExecution,
    bumpScan,
    setSettings,
    recordNotification,
  } = useTerminal();
  const { playExecute, playSuccess, playFail, playScan, playArbDetected, playFlashSubmitted, playFlashConfirmed, playFlashFailed, playAlert } = useTradeSounds();
  const tg = useTelegramAlerts();
  const [dexFilter, setDexFilter] = useState<string>("All");
  const [minProfit, setMinProfit] = useState(() =>
    String(state?.minProfit ?? DEFAULT_FEED_SETTINGS.minProfit),
  );
  const [mevGuard, setMevGuard] = useState(() => state?.mevGuard ?? true);
  const [honeypot, setHoneypot] = useState(false);
  const [dailyFlashLimit, setDailyFlashLimit] = useState(() => DEFAULT_FEED_SETTINGS.dailyFlashLimit);
  const [minLoan, setMinLoan] = useState(() => String(DEFAULT_FEED_SETTINGS.minLoan));
  // Flasher is flash-loan arbitrage ONLY — sniping is removed entirely.
  const dailyTracker = loadDailyTracker("flasher");
  const [rescanKey, setRescanKey] = useState(0);

  // Operator-tuned honeypot thresholds from the terminalConfig table
  // (fall back to the documented defaults while loading / when unset).
  const terminalCfg = useQuery(api.terminalConfig.getTerminalConfig);
  const consumeExecutionSlot = useMutation(api.terminal.consumeExecutionSlot);
  const myExecutionLimit = useQuery(api.terminal.myExecutionLimit);
  // Real execution trail — paper-mode successes feed the EXECUTED tier of
  // LIVE ROUTE FEED (reactive: a fresh paper execution appears instantly).
  const executionTrail = useQuery(api.terminal.listExecutions, { limit: 60 });
  const honeyProfitPct =
    terminalCfg?.honeyMinProfitPct ?? HONEY_POT_MIN_PROFIT_PCT;
  const honeyLiquidityUsd =
    terminalCfg?.honeyMinLiquidityUsd ?? HONEY_POT_MIN_LIQUIDITY_USD;
  const [now, setNow] = useState(() => Date.now());
  const [scannerEvents, setScannerEvents] = useState<ScannerEvent[]>([]);
  const eventIdRef = useRef(0);

  const addScannerEvent = useCallback((
    kind: ScannerEvent["kind"],
    label: string,
    opts?: Partial<Pick<ScannerEvent, "symbol" | "spreadPct" | "method" | "lender" | "txHash" | "details">>,
  ) => {
    const id = `evt-${++eventIdRef.current}-${Date.now()}`;
    setScannerEvents((prev) => [{ id, ts: Date.now(), kind, label, ...opts }, ...prev].slice(0, 50));
  }, []);
  const [executingId, setExecutingId] = useState<string | null>(null);
  // Telecopier — Telegram signal routes injected into the LIVE ROUTE FEED.
  // Routes are real cross-venue spreads priced from live DexScreener data
  // (see src/lib/telecopier-routes.ts); AUTO mode forwards them instantly.
  const [telecopierRoutes, setTelecopierRoutes] = useState<TelecopierRoute[]>([]);
  const handleTelecopierRoute = useCallback((route: TelecopierRoute) => {
    setTelecopierRoutes((prev) => {
      if (prev.some((r) => r.signalId === route.signalId)) return prev;
      return [route, ...prev].slice(0, 20);
    });
  }, []);
  // Flasher hot wallet — session-only state (never persisted to disk),
  // identical crypto to the Sniper's (BIP39 12-word + secp256k1 key).
  // A hot wallet CAN drive the flasher only when it is the DEPLOYER of the
  // armed contract (execute() is onlyOwner) — verified on-chain per execution.
  const [hotWallet, setHotWallet] = useState<{ mnemonic: string; privateKey: string; address: string } | null>(null);
  const generateFlasherHotWallet = useCallback(() => {
    try {
      const mnemonic = generateMnemonic(english, 128); // 128 bits = 12 words
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      setHotWallet({ mnemonic, privateKey: pk, address: account.address });
      addScannerEvent("guarantor_pass", `Flasher hot wallet generated: ${account.address.slice(0, 10)}…`, { details: "Session-only — copy the mnemonic now; it is not stored." });
    } catch {
      addScannerEvent("flash_failed", "Hot wallet generation failed");
    }
  }, [addScannerEvent]);
  // Profit guarantor live stats — surfaced in the guarantor status strip.
  const [guarantorStats, setGuarantorStats] = useState({ passed: 0, blocked: 0, lastLatencyMs: 0, lastNetPct: 0 });
  const bumpGuarantor = useCallback((passed: boolean, latencyMs: number, netPct: number) => {
    setGuarantorStats((prev) => ({
      passed: prev.passed + (passed ? 1 : 0),
      blocked: prev.blocked + (passed ? 0 : 1),
      lastLatencyMs: latencyMs,
      lastNetPct: netPct,
    }));
  }, []);

  // Min BNB loan: default 0.1, clamped into [0.1, 10] (never past the cap).
  const minLoanBnb = useMemo(
    () => Math.min(BNB_MAX_LOAN_CAP, Math.max(BNB_MIN_LOAN, Number(minLoan) || BNB_MIN_LOAN)),
    [minLoan],
  );

  const chainKey: ChainKey = state?.chainKey ?? "bsc";
  const chain = CHAIN_INFO[chainKey];
  const networkKey: NetworkKey = state?.network === "testnet" ? "testnet" : "mainnet";
  // RPC for the selected chain ON THE SELECTED NETWORK — private overrides
  // (Contract page) win; testnets use their verified public endpoints.
  const rpcUrl = networkInfoFor(
    chainKey,
    networkKey,
    state?.rpcOverrides?.[chainKey],
  ).rpc;
  const { gasPriceGwei } = useGasPrice(rpcUrl, rescanKey);

  // Operator's minimum NET margin (%). Every route's profitPct from the live
  // engine is already ALL-IN net — its actual venue swap fees, the documented
  // lender fee, liquidity-derived slippage, the live-RPC gas share of its own
  // loan size and the safety margin are deducted PER ROUTE inside the engine
  // — so this floor applies to true net instead of a flat worst-case
  // break-even. Per-route pricing is what lets genuinely profitable low-fee
  // routes surface instead of being drowned by a one-size assumption.
  const floor = useMemo(() => Number(minProfit) || 0, [minProfit]);

  const dexFilters = useMemo(
    () => ["All", ...chain.dexes.map((d) => d.key)],
    [chain],
  );

  const feedSettings = useMemo<FeedSettings>(
    () => ({
      dexWhitelist:
        state?.dexWhitelists?.[chainKey] ??
        (isBscChain(chainKey)
          ? state?.dexWhitelist ?? DEFAULT_FEED_SETTINGS.dexWhitelist
          : chain.dexes.map((d) => d.key)),
      minProfit: floor,
      maxHops: state?.maxHops === 2 ? 2 : 3,
      mevGuard,
      maxLoan: state?.maxLoan ?? DEFAULT_FEED_SETTINGS.maxLoan,
      minLoan: minLoanBnb,
      dailyFlashLimit,
      ttlWindow: 90,
      // Multi-asset flash loans: the operator's persisted discovered-symbol
      // selection routes beyond the wrapped-native denomination.
      loanAssets: state?.loanAssets,
    }),
    [
      state?.dexWhitelists,
      state?.dexWhitelist,
      state?.maxHops,
      state?.maxLoan,
      floor,
      mevGuard,
      minLoanBnb,
      dailyFlashLimit,
      state?.loanAssets,
      chain,
      chainKey,
    ],
  );

  // Effective RPC for the selected chain ON THE SELECTED NETWORK. Testnets
  // scan the chain itself (factory logs + live router quotes) instead of the
  // mainnet-only aggregators — both networks run the same engine.
  const networkRpcUrl = isBscChain(chainKey) || state?.network !== "testnet"
    ? rpcUrl
    : networkInfoFor(chainKey, networkKey).rpc;

  const feed = useLiveFeed({
    settings: feedSettings,
    paused: !(state?.botRunning ?? true),
    network: networkKey,
    rpcOverride: isBscChain(chainKey) ? undefined : state?.rpcOverrides?.[chainKey],
    cadence: state?.cadence ?? 15,
    rescanKey,
    balanced: !!state?.lenderBalancer,
    chainKey,
    gasPriceGwei,
  });

  // Mempool monitor — detects pending DEX swaps before block confirmation
  const mempool = useMempoolMonitor({
    paused: !(state?.botRunning ?? true),
    chainKey,
  });

  // Forward new mempool swaps as scanner events with sound alerts
  const seenSwapHashesRef = useRef(new Set<string>());
  useEffect(() => {
    for (const swap of mempool.pendingSwaps) {
      if (seenSwapHashesRef.current.has(swap.txHash)) continue;
      seenSwapHashesRef.current.add(swap.txHash);
      addScannerEvent("token_discovered", `Pending swap: ${swap.tokenIn} → ${swap.tokenOut} on ${swap.dex}`, {
        symbol: `${swap.tokenIn.slice(0, 6)}…${swap.tokenOut.slice(0, 6)}`,
      });
      playAlert();
    }
    // Trim old hashes to prevent memory leak
    if (seenSwapHashesRef.current.size > 500) {
      const arr = [...seenSwapHashesRef.current];
      seenSwapHashesRef.current = new Set(arr.slice(-250));
    }
  }, [mempool.pendingSwaps, addScannerEvent, playAlert]);

  // Triangular route generator — discovers ASSET→A→B→ASSET combos for every
  // enabled loan denomination (wrapped native + discovered assets like WETH).
  const generatedRoutes = useMemo(() => {
    if (!feed.snapshot) return [];
    return generateWBNBRoutes(feed.snapshot, feedSettings, feed.run, gasPriceGwei, 120);
  }, [feed.snapshot, feedSettings, feed.run, gasPriceGwei]);

  const profitableRoutes = useMemo(
    () => generatedRoutes.filter((r) => r.isProfitable),
    [generatedRoutes],
  );

  // ─── Cross-chain DEX arbitrage detection (real DexScreener data) ───
  // Every scan cycle compares the same asset's live price across BSC,
  // Ethereum, Arbitrum and Polygon. Spreads actionable on the SELECTED
  // chain surface first — they execute through that chain's own execution
  // path (flash-loan contract / router), each leg fully simulated first.
  const [crossChainSpreads, setCrossChainSpreads] = useState<CrossChainSpread[]>([]);
  const lastXcsScan = useRef<number | null>(null);
  useEffect(() => {
    if (!feed.lastScan || lastXcsScan.current === feed.lastScan) return;
    lastXcsScan.current = feed.lastScan;
    // Symbols come from TWO real sources: the route feed's mid-legs plus the
    // live snapshot's own token universe (deepest-liquidity-first) — so
    // cross-chain discovery keeps running even when no in-chain route
    // qualifies this cycle. Nothing is fabricated.
    const snapshotSymbols = feed.snapshot
      ? Object.values(feed.snapshot.quotes)
          .flatMap((perToken) => Object.entries(perToken))
          .sort((a, b) => (b[1].liquidityUsd ?? 0) - (a[1].liquidityUsd ?? 0))
          .map(([symbol]) => symbol)
      : [];
    const symbols = [
      ...(feed.routes.map((r) => r.legs[2]).filter(Boolean) as string[]),
      ...snapshotSymbols,
    ].filter((s, i, arr) => arr.indexOf(s) === i);
    if (symbols.length === 0) return;
    void detectCrossChainSpreads(symbols, { maxSymbols: 20, minLiquidityUsd: 5_000 })
      .then((spreads) => {
        setCrossChainSpreads(spreads);
        const actionable = actionableForChain(spreads, chainKey);
        if (actionable.length > 0) {
          addScannerEvent(
            "cross_chain_spread",
            `${actionable.length} cross-chain spread${actionable.length !== 1 ? "s" : ""} actionable on ${chain.label}`,
            {
              symbol: actionable[0].symbol,
              spreadPct: actionable[0].spreadPct,
              details: `${actionable[0].cheapChain}/${actionable[0].cheapDex} $${actionable[0].cheapPriceUsd.toPrecision(6)} → ${actionable[0].dearChain}/${actionable[0].dearDex} $${actionable[0].dearPriceUsd.toPrecision(6)}`,
            },
          );
        }
      })
      .catch(() => undefined);
  }, [feed.lastScan, feed.routes, chainKey, chain.label, addScannerEvent]);
  const actionableSpreads = useMemo(
    () => actionableForChain(crossChainSpreads, chainKey),
    [crossChainSpreads, chainKey],
  );

  // 1s clock for TTL countdowns
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Sync the real open-opportunity count into Convex once per scan tick.
  const lastCountedScan = useRef<number | null>(null);
  useEffect(() => {
    if (!feed.lastScan || lastCountedScan.current === feed.lastScan) return;
    lastCountedScan.current = feed.lastScan;
    if (state?.botRunning) {
      void bumpScan({ count: feed.routes.length }).catch(() => undefined);
      // Scanner tick event + sound
      addScannerEvent("scan_tick", `Scan complete — ${feed.routes.length} route${feed.routes.length !== 1 ? "s" : ""} found`, {
        details: `Lender: ${feed.lender}`,
      });
      playScan();
    }
  }, [feed.lastScan, feed.routes.length, feed.lender, bumpScan, state?.botRunning, addScannerEvent, playScan]);

  // Ping the notification center the moment a NEW honeypot route appears
  // (per session). Real filter on real data — never fabricated.
  const notifiedHoneyPotRef = useRef(new Set<string>());
  useEffect(() => {
    const fresh = feed.routes
      .filter(
        (r) =>
          isHoneyPot(r, honeyProfitPct, honeyLiquidityUsd) &&
          !notifiedHoneyPotRef.current.has(r.id),
      )
      .slice(0, 3);
    if (fresh.length === 0) return;
    fresh.forEach((r) => notifiedHoneyPotRef.current.add(r.id));
    const first = fresh[0];
    const title = "Honeypot detected";
    const body = `+${first.profitPct.toFixed(2)}% · ${routeLabel(first)} · $${Math.round(first.liquidityUsd / 1000)}k liquidity · ${first.lender}`;
    // Honeypot detections stay in-app only — the Telegram channel is
    // reserved exclusively for flash-loan trades and earnings.
    void recordNotification({
      kind: "honey_pot",
      title,
      body,
      chainKey,
    }).catch(() => undefined);
    toast.success("Honeypot detected", {
      description: `+${first.profitPct.toFixed(2)}% on ${chain.label} — ${routeLabel(first)}`,
    });
    // Arb detected alert + sound
    addScannerEvent("arb_detected", `Honeypot: ${routeLabel(first)}`, {
      symbol: first.legs[2],
      spreadPct: first.profitPct,
      lender: first.lender,
    });
    playArbDetected();
    tg.honeyPot(first.legs[2] ?? "route", first.profitPct, first.liquidityUsd);
  }, [
    feed.routes,
    recordNotification,
    chain.label,
    chainKey,
    honeyProfitPct,
    honeyLiquidityUsd,
    addScannerEvent,
    playArbDetected,
  ]);

  const filtered = useMemo(
    () =>
      feed.routes.filter(
        (route) =>
          (dexFilter === "All" || route.dexes.includes(dexFilter)) &&
          (!honeypot || isHoneyPot(route, honeyProfitPct, honeyLiquidityUsd)),
      ),
    [feed.routes, dexFilter, honeypot, honeyProfitPct, honeyLiquidityUsd],
  );

  const honeyCount = useMemo(
    () =>
      feed.routes.filter((route) =>
        isHoneyPot(route, honeyProfitPct, honeyLiquidityUsd),
      ).length,
    [feed.routes, honeyProfitPct, honeyLiquidityUsd],
  );

  // Stable per-cycle agent state. Declared BEFORE displayRoutes because the
  // memo factory runs synchronously during render — referencing bindings
  // declared later is a temporal-dead-zone error (the preview crash).
  const routeAgentConsensusRef = useRef(new Map<string, ReturnType<typeof scoreFlashRoute>>());
  const agentCapturesRef = useRef(new Map<string, CandidateCapture>());
  // NLP MEV-pass analyses per route (refilled each cycle in displayRoutes).
  const nlpMevRef = useRef(new Map<string, NlpMevResult>());
  // Paper-mode executed arbitrages — pulled from the real execution trail
  // (status "success" with no txHash = executed under paper mode) and pinned
  // into LIVE ROUTE FEED as their own newest-first tier, so every paper arb
  // stays populated in the feed 24/7 instead of vanishing on the next cycle.
  const paperExecutedRows = useMemo(() => {
    const rows = (executionTrail ?? []).filter(
      (e) => e.status === "success" && !e.txHash,
    );
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      legs: string[];
      dexes: string[];
      profitPct: number;
      lender: string;
      spreadBps: number;
      ttlSeconds: number;
      mevRisk: number;
      loanSizeBnb: number;
      loanAsset: string;
      liquidityUsd: number;
      isProfitable: boolean;
      source: "executed";
      executedAt: number;
    }> = [];
    for (const e of rows) {
      const legs = e.label.split(" → ");
      const key = legs.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `exec-${e._id}`,
        legs,
        dexes: e.dexes ? e.dexes.split(" → ") : legs,
        profitPct: e.profitPct,
        lender: e.lender ?? "flash-loan",
        // The captured edge in bps, straight from the trail — not fabricated.
        spreadBps: Math.round(e.profitPct * 100),
        ttlSeconds: 0,
        mevRisk: 0,
        // Paper gain = loanSize × pct/100 → recover the exact loan size used.
        loanSizeBnb:
          e.profitPct > 0
            ? Math.round(((e.amountBnb * 100) / e.profitPct) * 1e4) / 1e4
            : 0,
        // The trail stores the full leg label; the loan asset is its head.
        loanAsset: legs[0] ?? chain.quoteSymbol,
        liquidityUsd: 0,
        isProfitable: true,
        source: "executed",
        executedAt: e.ts,
      });
    }
    return out;
  }, [executionTrail]);

  const SOURCE_RANK: Record<string, number> = { executed: 0, live: 1, "near-miss": 2, generated: 3 };

  // Combined display feed — always 100+ routes/tokens shown, never zero.
  // Merges profitable filtered routes + near-miss routes + generated multi-denomination routes
  // so the scanner always has visible opportunities every cycle 24/7.
  // Runs in strict order: (1) simultaneous 21-agent discovery/capture pass,
  // (2) 21-agent ensemble scoring, (3) consensus+capture-ranked ordering.
  const displayRoutes = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ id: string; legs: string[]; dexes: string[]; profitPct: number; lender: string; spreadBps: number; ttlSeconds: number; mevRisk: number; loanSizeBnb: number; loanAsset: string; liquidityUsd: number; isProfitable: boolean; source: "executed" | "live" | "near-miss" | "generated"; executedAt?: number }> = [];
    const seenLegs = new Set<string>();

    // 0. Paper-mode executed arbitrages (real trail) — newest first. Every arb
    // executed under paper mode is populated inside LIVE ROUTE FEED here.
    for (const p of paperExecutedRows) {
      const key = p.legs.join(">");
      if (seenLegs.has(key)) continue;
      seenLegs.add(key);
      seen.add(p.id);
      result.push(p);
    }

    // 1. Profitable filtered routes first (highest priority)
    for (const r of filtered) {
      const key = r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      seenLegs.add(r.legs.join(">"));
      result.push({ id: r.id, legs: r.legs, dexes: r.dexes, profitPct: r.profitPct, lender: r.lender, spreadBps: r.spreadBps, ttlSeconds: r.ttlSeconds, mevRisk: r.mevRisk, loanSizeBnb: r.loanSizeBnb, loanAsset: r.loanAsset, liquidityUsd: r.liquidityUsd, isProfitable: true, source: "live" });
    }

    // 2. Near-miss routes (below floor but real cross-DEX spreads)
    for (const r of feed.nearMissRoutes) {
      const key = r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      seenLegs.add(r.legs.join(">"));
      result.push({ id: r.id, legs: r.legs, dexes: r.dexes, profitPct: r.profitPct, lender: r.lender, spreadBps: r.spreadBps, ttlSeconds: r.ttlSeconds, mevRisk: r.mevRisk, loanSizeBnb: r.loanSizeBnb, loanAsset: r.loanAsset, liquidityUsd: r.liquidityUsd, isProfitable: false, source: "near-miss" });
    }

    // 3. Telecopier routes — real Telegram-signal cross-venue arbitrages,
    // surfaced directly inside LIVE ROUTE FEED so they can auto-execute.
    for (const t of telecopierRoutes) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      seenLegs.add(t.legs.join(">"));
      result.push({ id: t.id, legs: t.legs, dexes: t.dexes, profitPct: t.profitPct, lender: t.lender, spreadBps: t.spreadBps, ttlSeconds: t.ttlSeconds, mevRisk: t.mevRisk, loanSizeBnb: t.loanSizeBnb, loanAsset: t.loanAsset, liquidityUsd: t.liquidityUsd, isProfitable: t.profitPct > 0, source: "live" });
    }

    // 3.5 Actionable cross-chain spreads — real same-asset spreads across
    // chains that are executable on the SELECTED chain, materialized with
    // the exact flashRouteForSpread builder the auto-exec path fires. They
    // populate LIVE ROUTE FEED as first-class rows (previously they only
    // rendered as chips in the strip above, so detected cross-chain routes
    // looked "missing" from the feed). Every field comes from the live
    // spread itself — nothing mocked, nothing simulated.
    for (const s of actionableSpreads) {
      const route = flashRouteForSpread(s, chainKey, feed.lender);
      if (seen.has(route.id)) continue;
      seen.add(route.id);
      seenLegs.add(route.legs.join(">"));
      result.push({
        id: route.id,
        legs: route.legs,
        dexes: route.dexes,
        profitPct: route.profitPct,
        lender: route.lender,
        spreadBps: route.spreadBps,
        ttlSeconds: route.ttlSeconds,
        mevRisk: route.mevRisk,
        loanSizeBnb: route.loanSizeBnb,
        loanAsset: route.loanAsset,
        liquidityUsd: route.liquidityUsd,
        isProfitable: route.profitPct > 0,
        source: "live",
      });
    }

    // 4. Generated triangular routes across every enabled loan denomination
    for (const g of generatedRoutes) {
      const key = g.legs.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      seenLegs.add(key);
      result.push({ id: key, legs: g.legs, dexes: g.dexes, profitPct: g.netProfitPct, lender: g.lender, spreadBps: g.spreadBps, ttlSeconds: g.ttlSeconds, mevRisk: g.mevRisk, loanSizeBnb: g.loanSizeBnb, loanAsset: g.loanAsset, liquidityUsd: g.minLiquidityUsd, isProfitable: g.isProfitable, source: "generated" });
    }

    // PHASE 1 — simultaneous per-agent discovery/capture BEFORE scoring:
    // every one of the 21 agents scans the assembled candidate universe in the
    // SAME pass with its own capture profile (priority feature + threshold +
    // listing-age window), so brand-new routes are individually captured by
    // each agent the moment they enter the feed.
    const pass = discoverRoutes(result, (r) => r.id);
    agentCapturesRef.current.clear();
    for (const { key, capture } of pass.captured) {
      agentCapturesRef.current.set(key, capture);
    }

    // PHASE 2 — per-route 21-agent consensus scoring (sub-ms, measured).
    // Cached per cycle inside this memo so row renders reuse it.
    routeAgentConsensusRef.current.clear();
    for (const r of result) {
      routeAgentConsensusRef.current.set(r.id, scoreFlashRoute(r));
    }

    // PHASE 2b — NLP MEV-pass analysis: composes each route's real market
    // description and classifies P(MEV-guard pass) sub-millisecond, so routes
    // the guard would block but whose structure genuinely passes are
    // identified for auto-execution (and doomed routes are shielded).
    const nlpBatch = analyzeMevPassBatch(
      result.map((r) => ({
        id: r.id,
        legs: r.legs,
        dexes: r.dexes,
        profitPct: r.profitPct,
        spreadBps: r.spreadBps,
        ttlSeconds: r.ttlSeconds,
        mevRisk: r.mevRisk,
        lender: r.lender,
        loanSizeBnb: r.loanSizeBnb,
        loanAsset: r.loanAsset,
        liquidityUsd: r.liquidityUsd,
      })),
      { pendingSwaps: mempool.pendingSwaps.length, congestion: Math.min(1, mempool.pendingSwaps.length / 60) },
      gasPriceGwei,
    );
    nlpMevRef.current = nlpBatch;

    // PHASE 3 — AI-consensus + capture-ranked ordering within each source
    // tier: agent-discovered, bullish-voted routes surface instantly.
    return result.sort((a, b) => {
      if (a.source !== b.source) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
      if (a.isProfitable !== b.isProfitable) return a.isProfitable ? -1 : 1;
      const rankA =
        (routeAgentConsensusRef.current.get(a.id)?.consensus ?? 0) +
        2 * (agentCapturesRef.current.get(a.id)?.discoveringAgents.length ?? 0);
      const rankB =
        (routeAgentConsensusRef.current.get(b.id)?.consensus ?? 0) +
        2 * (agentCapturesRef.current.get(b.id)?.discoveringAgents.length ?? 0);
      return rankB - rankA;
    });
  }, [filtered, feed.nearMissRoutes, feed.lender, generatedRoutes, telecopierRoutes, paperExecutedRows, mempool.pendingSwaps, gasPriceGwei, actionableSpreads, chainKey]);

  /**
   * Always-on profit guard: engine routes carry an ALL-IN net profitPct —
   * venue swap fees, the documented lender fee, liquidity-derived slippage,
   * the live-RPC gas share of the route's own loan size and the safety margin
   * were each deducted per route inside the engine — so the guard verifies
   * that true net edge directly. Anything ≤ 0 is refused — paper AND live.
   * The live guarantor (verifyRouteLive) re-quotes every leg on-chain right
   * before broadcast as the second, harder gate.
   */
  const profitGuard = (route: FlashRoute): number | null =>
    route.profitPct > 0 ? route.profitPct : null;

  const handleChainSwitch = async (next: ChainKey) => {
    if (next === chainKey) return;
    await setSettings({ chainKey: next });
    setDexFilter("All");
    setHoneypot(false);
    setRescanKey((k) => k + 1);
    toast.success(`Scanning ${CHAIN_INFO[next].label}`, {
      description: `Real DexScreener pairs via ${CHAIN_INFO[next].quoteSymbol} — lenders scoped to the chain's actual protocols.`,
    });
  };

  /**
   * Real on-chain execution for live mode: build calldata from the live
   * snapshot's token addresses and send the flash-loan tx via the injected
   * wallet on the active chain. Nothing here is simulated — the tx either
   * confirms or reverts.
   */
  const executeLive = async (route: FlashRoute) => {
    // Execution gate: live arbitrage signs and broadcasts, so it is gated before
    // any provider call. Paper mode is unaffected (it signs nothing).
    const gateWallet = state?.connectedWallets?.[0] ?? "";
    const committed = state?.deployedContractAddress ?? "";
    const gate = preflightExecution({
      chainKey,
      network: isBscChain(chainKey) ? (state?.network ?? "mainnet") : "mainnet",
      wallet: gateWallet,
      executor: committed,
      // The armed deployment for THIS chain is the evidence; a committed
      // address that is not armed here cannot clear the gate.
      armedExecutor: state?.deployments?.[chainKey]?.contractAddress ?? "",
    });
    if (!gate.allowed) {
      addScannerEvent("error", `Execution gate refused: ${gate.reasons[0] ?? "execution disabled"}`);
      toast.error("Execution gate refused this arbitrage", {
        description: gate.reasons[0] ?? "Execution is disabled on this network.",
      });
      return;
    }
    const provider = getInjectedProvider();
    if (!provider) {
      toast.error("No wallet detected", {
        description:
          "Install MetaMask, Trust, OKX or Binance Wallet and connect it on the Wallets page.",
      });
      return;
    }
    if (!state?.connectedWallets?.length) {
      toast.error("Connect a wallet first", {
        description:
          "Open the Wallets page and connect your extension before executing live.",
      });
      return;
    }
    if (!state?.deployedContractAddress) {
      toast.error("No deployed contract", {
        description:
          "Deploy FlashBoltArbitrage.sol and arm it on the Contract page before executing live.",
      });
      return;
    }
    if (!feed.snapshot) {
      toast.error("Feed not ready", {
        description: "Wait for the next live market refresh, then retry.",
      });
      return;
    }
    const txChain = isBscChain(chainKey)
      ? BNB_NETWORKS[networkKey]
      : networkInfoFor(chainKey, networkKey);
    const netAfterCosts = profitGuard(route);
    if (netAfterCosts === null) {
      toast.error("Profit guard blocked this route", {
        description: `All-in net of ${route.profitPct.toFixed(2)}% — after the ${lenderFeeLabel(route.lender)} fee, slippage and ${gasPriceGwei !== null ? `${gasCostBnb(gasPriceGwei).toFixed(6)} ${txChain.nativeSymbol} gas` : "gas"} — is ≤ 0. Executing would lose money, so the bot refuses.`,
      });
      return;
    }
    const quoteAddress = feed.snapshot.quoteAddress ??
      (isBscChain(chainKey) ? BNB_NETWORKS[networkKey].wbnb : networkInfoFor(chainKey, networkKey).wrapped);
    const path = routePathAddresses(route, feed.snapshot, quoteAddress);
    if (!path) {
      toast.error("Live path unavailable", {
        description:
          "One of this route's token addresses is missing from the live feed — run it in paper mode instead.",
      });
      return;
    }
    // ── Submission path: hot wallet (private relay) vs injected wallet ──
    // The contract gates execute() to the DEPLOYER. A hot wallet can only
    // drive the flasher when it IS the deployer — verified with a real
    // owner() eth_call before anything is signed. When no hot wallet exists
    // (or it does not own the contract), the original injected-wallet path
    // runs unchanged.
    const injectedFrom = await getWalletAddress(provider);
    const vaultHwManual = evmGetVaultHotWallet();
    const effectiveHot = vaultHwManual
      ? { privateKey: vaultHwManual.privateKey, address: vaultHwManual.address }
      : hotWallet;
    // Flash-loan arbitrage is signed by the vault/hot wallet ONLY. The old
    // injected-wallet fallback is gone on purpose: an injected wallet is the
    // signer a site compromise reaches, and execute() moves borrowed principal.
    const armManual = contractArmVerdict(state?.deployments?.[chainKey]?.signerAddress ?? null);
    if (!armManual.allowed) {
      addScannerEvent("flash_failed", "Armed contract refused by the wallet guard", { details: armManual.reason });
      toast.error("Contract not eligible for flash loans", { description: armManual.reason });
      return;
    }
    const signerSourceManual: SignerSource = vaultHwManual ? "vault" : hotWallet ? "hot" : "none";
    const ownsManual = effectiveHot
      ? await isFlashBoltOwner(rpcUrl, state.deployedContractAddress, effectiveHot.address)
      : false;
    const signerVerdictManual = arbitrageSignerVerdict(signerSourceManual, { ownsContract: ownsManual });
    if (!signerVerdictManual.allowed || !effectiveHot) {
      addScannerEvent("flash_failed", "Flash-loan blocked by the wallet guard", {
        details: `${signerVerdictManual.reason}${injectedFrom ? ` An injected wallet (${injectedFrom.slice(0, 10)}…) is connected but may not sign this.` : ""}`,
      });
      toast.error("Flash-loan arbitrage blocked", { description: signerVerdictManual.reason });
      return;
    }
    const from: string = effectiveHot.address;
    const hotPk: `0x${string}` = effectiveHot.privateKey as `0x${string}`;
    const signerFrom: string = from;
    const contractAddress: string = state.deployedContractAddress;
    const privSubmit: boolean = state?.privateSubmit ?? true;

    const slippage = state?.slippage ?? 0.5;

    // ── PROFIT GUARANTOR: live leg-by-leg re-verification ──
    // Real getAmountsOut on each venue router RIGHT NOW. Only routes whose
    // LIVE net (after every fee, slippage and gas) still clears the floor
    // proceed to simulation/broadcast — and their fresh profit figure (which
    // auto-boosts the passing margin) drives amountOutMin.
    const guarantor = await verifyRouteLive({
      chainKey,
      network: networkKey,
      rpcUrl,
      legs: route.legs,
      tokenAddresses: feed.snapshot.tokenAddresses,
      wrapped: isBscChain(chainKey) ? BNB_NETWORKS[networkKey].wbnb : networkInfoFor(chainKey, networkKey).wrapped,
      lender: route.lender,
      venueFees: Object.fromEntries(
        (feed.snapshot.venues ?? chain.dexes).map((d) => [d.key, d.fee]),
      ),
      loanSize: Math.max(minLoanBnb, Math.min(route.loanSizeBnb, state?.maxLoan ?? DEFAULT_FEED_SETTINGS.maxLoan)),
      slippagePct: slippage,
      gasPriceGwei,
      minProfitPct: floor,
      hotPath: true,
    });
    if (!guarantor.passed) {
      bumpGuarantor(false, guarantor.latencyMs, guarantor.liveNetProfitPct);
      addScannerEvent("profit_guard_blocked", `Guarantor blocked: ${route.legs[2] ?? "route"}`, {
        symbol: route.legs[2],
        spreadPct: route.profitPct,
        details: `${guarantor.reason ?? "live re-quote no longer profitable"} · verified in ${guarantor.latencyMs.toFixed(0)}ms`,
      });
      playAlert();
      toast.error("Guarantor blocked — live re-quote lost the edge", {
        description: `${guarantor.reason ?? "Route no longer profitable on-chain."} Zero gas spent.`,
      });
      setExecutingId(null);
      return;
    }
    bumpGuarantor(true, guarantor.latencyMs, guarantor.liveNetProfitPct);
    addScannerEvent("guarantor_pass", `Guarantor pass: ${route.legs[2] ?? "route"} LIVE +${guarantor.liveNetProfitPct.toFixed(3)}%`, {
      symbol: route.legs[2],
      spreadPct: guarantor.liveNetProfitPct,
      details: `${guarantor.legs.length} legs re-quoted in ${guarantor.latencyMs.toFixed(0)}ms`,
    });

    // Fresh numbers drive the slippage-protected minimum out. The loan
    // asset is the route's own head leg (native-quote routes, or a discovered
    // deep asset like USDT/USDC for stable-denominated routes). Stable
    // routes bridge through the wrapped native: ASSET → QUOTE → legs → QUOTE →
    // ASSET, so the executable path wraps the feed's displayed legs.
    const loanAssetSymbol = route.loanAsset ?? route.legs[0] ?? feed.snapshot.quoteSymbol ?? "";
    const loanAssetAddress = resolveLoanAssetAddress(
      loanAssetSymbol,
      feed.snapshot,
      quoteAddress,
    );
    if (!loanAssetAddress) {
      toast.error("Loan asset unavailable on-chain", {
        description: `${loanAssetSymbol} has no live address in the feed — run this route in paper mode instead.`,
      });
      setExecutingId(null);
      return;
    }
    const loanAssetIsQuote = loanAssetSymbol === (feed.snapshot.quoteSymbol ?? chain.quoteSymbol);
    const bridgedPath: Hex[] = loanAssetIsQuote
      ? (path as Hex[])
      : [
          loanAssetAddress as Hex,
          quoteAddress as Hex,
          ...(path as Hex[]).slice(1, -1),
          quoteAddress as Hex,
          loanAssetAddress as Hex,
        ];
    // All majors on the chain share 18 decimals; principal in the asset's
    // own wei (recovered from the loan size — never fabricated).
    const loanWei = BigInt(Math.round(Math.max(0, route.loanSizeBnb) * 1e18));
    const amountOutMin = computeAmountOutMin(loanWei, guarantor.liveNetProfitPct, slippage);
    const data = buildExecuteData(loanAssetAddress as Hex, loanWei, bridgedPath, amountOutMin);

    // HOT-PATH PREFETCH: gas + gasPrice + nonce fire NOW as one parallel RPC
    // burst and overlap the daily-target check + eth_call simulation below —
    // the hot path then awaits ready numbers instead of paying three
    // sequential round-trips after the sim. Pure reads: if the sim blocks,
    // the results are discarded (zero gas spent either way).
    const hotPreflight =
      hotPk !== null
        ? Promise.all([
            estimateFlashLoanGas(rpcUrl, signerFrom, contractAddress, data),
            gasPriceWeiFor(rpcUrl),
            nextNonce(rpcUrl, signerFrom),
          ]).catch(() => null)
        : null;

    // Operator/guest-chosen daily flash target (1–∞, 0 = unlimited). The
    // SERVER subscriber cap (3) is enforced separately below and never
    // applies to operator/guest — their local choice is the only limit.
    if (!canExecute("flasher", "flash", dailyFlashLimit)) {
      toast.warning("Daily flash loan limit reached", {
        description: `${dailyFlashLimit} flash loans executed today. Increase limit in Strategy settings.`,
      });
      return;
    }

    // Subscriber daily target (server-enforced) — manual execute path. One
    // slot is consumed server-side BEFORE broadcasting; sim-fails never consume.
    try {
      const slot = await consumeExecutionSlot({ kind: "flash", chain: "bnb", label: routeLabel(route) });
      if (slot.blocked) {
        toast.warning("Daily target reached", { description: slot.reason });
        return;
      }
    } catch {
      toast.error("Could not verify your daily target — execution aborted.");
      return;
    }
    setExecutingId(route.id);
    try {
      const simResult = await simulateFlashLoanTx(
        rpcUrl,
        state.deployedContractAddress,
        from,
        data,
        txChain.chainId,
      );
      if (!simResult.success) {
        addScannerEvent("profit_guard_blocked", `Simulation failed: ${route.legs[2] ?? "route"}`, {
          symbol: route.legs[2],
          spreadPct: route.profitPct,
          details: `${simResult.error ?? "would revert"} · sim ${simResult.latencyMs.toFixed(0)}ms across ${simResult.raced} RPCs`,
        });
        playAlert();
        toast.error("eth_call simulation failed — zero gas saved", {
          description: `${simResult.error ?? "Transaction would revert."} No gas was spent (sim ${simResult.latencyMs.toFixed(0)}ms).`,
        });
        setExecutingId(null);
        return;
      }
      // REAL measured signing latency (hot path only — the injected wallet
      // signs inside the extension where the app cannot measure honestly).
      let manualSignMs: number | undefined;
      const txHash = await (async () => {
        if (hotPk) {
          // HOT-WALLET PATH: signed locally → private relay (Flashbots /
          // bloXroute) with automatic failover, then public RPC. Gas and
          // nonce come from real RPC reads; nothing changes vs the wallet
          // path except who signs and how it is broadcast.
          // Prefetched during the simulation (parallel RPC burst) — the
          // fast lane awaits ready numbers instead of three sequential reads.
          const pre = await hotPreflight;
          if (!pre) {
            throw new Error(
              "Gas/nonce preflight failed — the RPC was unreachable. Nothing was signed or broadcast.",
            );
          }
          const [gas, { wei }, nonce] = pre;
          const sent = await sendSignedTransaction(
            rpcUrl,
            txChain.chainId,
            hotPk,
            { to: contractAddress as Hex, data, microsecond: true, gas, gasPriceWei: wei, nonce },
            { enabled: privSubmit, network: networkKey },
          );
          manualSignMs = sent.signingLatencyMs;
          addScannerEvent("flash_submitted", `Flash-loan submitted (hot wallet): ${routeLabel(route)}`, {
            symbol: route.legs[2],
            spreadPct: route.profitPct,
            lender: route.lender,
            txHash: sent.txHash,
            details: `submission channel: ${sent.relay ?? "public RPC"}${sent.relayDegraded ? " (all relays in cooldown)" : ""} · signer: ${signerFrom.slice(0, 10)}…`,
          });
          return sent.txHash;
        }
        // INJECTED-WALLET PATH. Session freshness first: a real eth_accounts
        // probe refuses a locked/disconnected wallet honestly instead of
        // dead-ending mid-broadcast. Chain mismatches stay seamless —
        // ensureWalletChainId inside the sender auto-switches the wallet.
        const probe = await probeWalletSession();
        if (!probe.address) {
          throw new Error(
            "Wallet session lost — unlock or reconnect your extension (Wallets page), then retry. Nothing was signed.",
          );
        }
        return sendFlashLoanExecution({
          provider,
          chain: txChain,
          from: signerFrom,
          contractAddress,
          data,
        });
      })();
      const submittedViaHot = hotPk !== null;
      addScannerEvent("flash_submitted", `Flash-loan submitted: ${routeLabel(route)}`, {
        symbol: route.legs[2],
        spreadPct: route.profitPct,
        lender: route.lender,
        txHash,
        details: submittedViaHot ? undefined : `submission channel: wallet RPC${(state?.privateSubmit ?? true) && isPrivateRpcAvailable(txChain.chainId, networkKey) ? " (set the wallet to a Protect RPC for private submission)" : ""}`,
      });
      playFlashSubmitted();
      tg.flashSubmitted(route.legs[2] ?? "route", route.profitPct, route.lender);
      toast.loading("Flash-loan tx submitted", {
        description: `${txHash.slice(0, 10)}… — waiting for the block to confirm borrow, swap, repay and payout.`,
      });
      const receipt = await waitForFlashLoanReceipt(provider, txHash);
      const gain = routeProfitBnb(route);
      if (receipt.status === "success") {
        const payout = state?.autoPayout ? gain : 0;
        await recordExecution({
          label: routeLabel(route),
          profitPct: route.profitPct,
          amountBnb: gain,
          status: "success",
          lender: route.lender,
          dexes: route.dexes.join(" → "),
          payoutBnb: payout,
          network: isBscChain(chainKey) ? state?.network : chainKey,
          txHash,
          chainId: txChain.chainId,
          method: route.method,
          gasUsedBnb: receipt.gasUsedBnb,
          signingLatencyMs: manualSignMs,          });
          addScannerEvent("flash_confirmed", `Flash-loan confirmed: ${routeLabel(route)} +${route.profitPct.toFixed(2)}%`, {
            symbol: route.legs[2],
            spreadPct: route.profitPct,
            lender: route.lender,
            txHash,
          });
          playFlashConfirmed();
          incrementTracker("flasher", "flash", "win");
          tg.flashConfirmed(route.legs[2] ?? "route", route.profitPct, route.lender, gain, txHash, manualSignMs);
          toast.success(`+${route.profitPct.toFixed(2)}% executed on-chain`, {
            description:
              payout > 0
                ? `Tx ${txHash.slice(0, 10)}… confirmed · ${gain.toFixed(4)} ${txChain.nativeSymbol} profit auto-paid to your wallet (${route.lender} flash loan).`
                : `Tx ${txHash.slice(0, 10)}… confirmed · ${gain.toFixed(4)} ${txChain.nativeSymbol} profit (auto-payout off).`,
          });
      } else {
        await recordExecution({
          label: routeLabel(route),
          profitPct: route.profitPct,
          amountBnb: 0,
          status: "failed",
          lender: route.lender,
          dexes: route.dexes.join(" → "),
          network: isBscChain(chainKey) ? state?.network : chainKey,
          txHash,
          chainId: txChain.chainId,
          method: route.method,
          gasUsedBnb: receipt.gasUsedBnb,          });
          addScannerEvent("flash_failed", `Flash-loan reverted: ${routeLabel(route)}`, {
            symbol: route.legs[2],
            spreadPct: route.profitPct,
            lender: route.lender,
            txHash,
          });
          playFlashFailed();
          incrementTracker("flasher", "flash", "loss");
          tg.flashFailed(route.legs[2] ?? "route", route.lender, "Transaction reverted");
          toast.error("Transaction reverted on-chain", {
            description:
              "The profit gate or a slippage cap rejected the swap — no funds moved beyond gas. Zero gas fee on revert.",
          });
      }
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code === 4001) {
        toast.error("Transaction rejected", {
          description: "You declined the flash-loan execution in your wallet.",
        });
      } else {
        toast.error("Live execution failed", {
          description:
            error instanceof Error
              ? error.message
              : "Check the wallet and contract setup, then retry.",
        });
      }
    } finally {
      setExecutingId(null);
    }
  };

  const handleExecute = async (route: FlashRoute) => {
    if (state?.mode === "live") {
      await executeLive(route);
      return;
    }
    const label = routeLabel(route);
    const gain = routeProfitBnb(route);
    // Always-on profit guard — checked before everything else.
    const netAfterCosts = profitGuard(route);
    if (netAfterCosts === null) {      await recordExecution({
        label,
        profitPct: route.profitPct,
        amountBnb: 0,
        status: "below_floor",
        lender: route.lender,
        dexes: route.dexes.join(" → "),
        network: isBscChain(chainKey) ? state?.network : chainKey,
        method: route.method,
      });
      playFail();
      toast.error("Profit guard blocked this route", {
        description: `All-in net of ${route.profitPct.toFixed(2)}% — after the ${lenderFeeLabel(route.lender)} fee, slippage and ${gasPriceGwei !== null ? `${gasCostBnb(gasPriceGwei).toFixed(6)} ${isBscChain(chainKey) ? "BNB" : chain.nativeSymbol} live gas` : "gas"} — is ≤ 0. Only profitable arbitrage is ever executed.`,
      });
      return;
    }
    // NLP-aware MEV guard: the route's real market structure is analyzed
    // sub-millisecond (lexicon + entities + mempool facts). Routes whose
    // structure genuinely passes (atomic, deep, major-venue, short-window)
    // are allowed through even when the static scalar says block — doomed
    // structures stay shielded.
    const nlpAnalysis = analyzeMevPass(
      route,
      { pendingSwaps: mempool.pendingSwaps.length, congestion: Math.min(1, mempool.pendingSwaps.length / 60) },
      gasPriceGwei,
    );
    const mevDecision = nlpAwareGuardDecision(route, mevGuard, nlpAnalysis);
    if (!mevDecision.allow) {
      await recordExecution({
        label,
        profitPct: route.profitPct,
        amountBnb: 0,
        status: "blocked",
        lender: route.lender,
        dexes: route.dexes.join(" → "),
        network: isBscChain(chainKey) ? state?.network : chainKey,
        method: route.method,
      });
      playFail();
      addScannerEvent("mev_blocked", `MEV guard blocked: ${route.legs[2] ?? "route"}`, {
        symbol: route.legs[2],
        spreadPct: route.profitPct,
        details: mevDecision.reason,
      });
      toast.error("MEV guard blocked this route", {
        description: `High sandwich / front-running risk (MEV ${route.mevRisk}) via ${route.lender}. ${mevDecision.reason}.`,
      });
      return;
    }
    if (route.profitPct < floor) {
      await recordExecution({
        label,
        profitPct: route.profitPct,
        amountBnb: 0,
        status: "below_floor",
        lender: route.lender,
        dexes: route.dexes.join(" → "),
        network: isBscChain(chainKey) ? state?.network : chainKey,
        method: route.method,
      });
      playFail();
      toast.warning("Below your profitability floor", {
        description: `${route.profitPct.toFixed(2)}% < ${floor.toFixed(2)}% minimum — skipped.`,
      });
      return;
    }
    const payout = state?.autoPayout ? gain : 0;
    await recordExecution({
      label,
      profitPct: route.profitPct,
      amountBnb: gain,
      status: "success",
      lender: route.lender,
      dexes: route.dexes.join(" → "),
      payoutBnb: payout,
      network: isBscChain(chainKey) ? state?.network : chainKey,
      method: route.method,
    });
    addScannerEvent("flash_confirmed", `Paper execution: ${routeLabel(route)} +${route.profitPct.toFixed(2)}%`, {
      symbol: route.legs[2],
      spreadPct: route.profitPct,
      lender: route.lender,
    });
    playSuccess();
    tg.flashConfirmed(route.legs[2] ?? "route", route.profitPct, route.lender, gain);
    toast.success(`+${route.profitPct.toFixed(2)}% executed in one atomic tx`, {
      description:
        payout > 0
          ? `${gain.toFixed(4)} ${isBscChain(chainKey) ? "BNB" : chain.nativeSymbol} profit auto-paid to your wallet (${route.lender} flash loan).`
          : `${gain.toFixed(4)} ${isBscChain(chainKey) ? "BNB" : chain.nativeSymbol} credited to the paper account. Auto-payout is off.`,
    });
  };

  /**
   * Auto-execute flash-loan for deep-pair arbitrage routes detected by
   * the multi-source token discovery pipeline. Initiates instantly when
   * spread >= 0.5% and MEV risk is acceptable.
   */
  const handleArbAutoExecute = useCallback(async (route: { address: string; symbol: string; dexes: string[]; spreadPct: number; method: string }) => {
    const provider = getInjectedProvider();
    if (!provider) {
      toast.error("No wallet detected — auto-arb skipped", {
        description: "Connect a wallet to enable automatic flash-loan execution.",
      });
      return;
    }
    if (!state?.deployedContractAddress) {
      toast.error("No deployed contract — auto-arb skipped", {
        description: "Deploy FlashBoltArbitrage.sol and arm it for auto-execution.",
      });
      return;
    }
    if (!feed.snapshot) {
      toast.error("Feed not ready — auto-arb deferred", {
        description: "Waiting for next market snapshot.",
      });
      return;
    }

    // Raw discovery spread is NOT engine-priced (it bypasses computeRoutes),
    // so the all-in cost model is applied here explicitly: the documented
    // lender fee, the configured slippage tolerance and the live gas share of
    // a 1-unit loan — identical economics to the engine's per-route pricing.
    const rawNetPct = Math.round(
      (route.spreadPct -
        lenderFeePct(feed.lender) -
        (state?.slippage ?? 0.5) -
        (gasPriceGwei !== null ? gasCostBnb(gasPriceGwei) * 100 : 0)) * 10000,
    ) / 10000;

    if (rawNetPct <= 0) {
      addScannerEvent("profit_guard_blocked", `Profit guard blocked: ${route.symbol}`, { symbol: route.symbol, spreadPct: route.spreadPct, method: route.method });
      playAlert();
      toast.warning("Auto-arb profit guard blocked", {
        description: `${route.symbol} +${route.spreadPct.toFixed(2)}% via ${route.method} — net after costs is ≤ 0.`,
      });
      return;
    }

    // NLP-aware MEV guard for auto-arb: same sub-millisecond structural
    // analysis — routes that genuinely pass are executed automatically,
    // doomed structures are shielded before any eth_call is spent.
    {
      const arbRoute: FlashRoute = {
        id: `arb-${route.address}`,
        legs: [chain.quoteSymbol, route.dexes[0], route.symbol, route.dexes[1] || route.dexes[0], chain.quoteSymbol],
        dexes: route.dexes,
        profitPct: route.spreadPct,
        spreadBps: Math.round(route.spreadPct * 100),
        ttlSeconds: 90,
        mevRisk: route.method === "triangular" ? 30 : route.method === "statistical" ? 50 : 20,
        lender: feed.lender,
        loanSizeBnb: 1,
        loanAsset: chain.quoteSymbol,
        liquidityUsd: 10000,
      };
      const nlpAnalysis = analyzeMevPass(
        arbRoute,
        { pendingSwaps: mempool.pendingSwaps.length, congestion: Math.min(1, mempool.pendingSwaps.length / 60) },
        gasPriceGwei,
      );
      const mevDecision = nlpAwareGuardDecision(arbRoute, mevGuard, nlpAnalysis);
      if (!mevDecision.allow) {
        addScannerEvent("mev_blocked", `MEV guard blocked: ${route.symbol}`, { symbol: route.symbol, spreadPct: route.spreadPct, method: route.method, details: mevDecision.reason });
        playAlert();
        toast.warning("Auto-arb MEV guard blocked", {
          description: `${route.symbol} high MEV risk via ${route.method}. ${mevDecision.reason}.`,
        });
        return;
      }
    }

    // Build the flash-loan path
    const quoteAddress = feed.snapshot.quoteAddress ??
      (isBscChain(chainKey) ? BNB_NETWORKS[networkKey].wbnb : networkInfoFor(chainKey, networkKey).wrapped);
    const injectedFromAuto = await getWalletAddress(provider);

    const mockRoute: FlashRoute = {
      id: `arb-${route.address}`,
      legs: [chain.quoteSymbol, route.dexes[0], route.symbol, route.dexes[1] || route.dexes[0], chain.quoteSymbol],
      dexes: route.dexes,
      profitPct: route.spreadPct,
      spreadBps: Math.round(route.spreadPct * 100),
      ttlSeconds: 90,
      mevRisk: route.method === "triangular" ? 30 : route.method === "statistical" ? 50 : 20,
      lender: feed.lender,
      loanSizeBnb: 1,
      loanAsset: chain.quoteSymbol,
      liquidityUsd: 10000,
    };
    const path = routePathAddresses(mockRoute, feed.snapshot, quoteAddress);
    if (!path) {
      toast.error("Auto-arb path unavailable", {
        description: `Token address for ${route.symbol} missing from live feed.`,
      });
      return;
    }

    const slippage = state?.slippage ?? 0.5;

    // ── PROFIT GUARANTOR (auto-arb): live leg-by-leg re-verification ──
    const guarantor = await verifyRouteLive({
      chainKey,
      network: networkKey,
      rpcUrl,
      legs: mockRoute.legs,
      tokenAddresses: feed.snapshot.tokenAddresses,
      wrapped: quoteAddress,
      lender: feed.lender,
      venueFees: Object.fromEntries(
        (feed.snapshot.venues ?? chain.dexes).map((d) => [d.key, d.fee]),
      ),
      loanSize: Math.max(minLoanBnb, Math.min(1, state?.maxLoan ?? DEFAULT_FEED_SETTINGS.maxLoan)),
      slippagePct: slippage,
      gasPriceGwei,
      minProfitPct: floor,
      hotPath: true,
    });
    if (!guarantor.passed) {
      bumpGuarantor(false, guarantor.latencyMs, guarantor.liveNetProfitPct);
      addScannerEvent("profit_guard_blocked", `Guarantor blocked auto-arb: ${route.symbol}`, {
        symbol: route.symbol,
        spreadPct: route.spreadPct,
        method: route.method,
        details: `${guarantor.reason ?? "live re-quote no longer profitable"} · ${guarantor.latencyMs.toFixed(0)}ms`,
      });
      playAlert();
      return;
    }
    bumpGuarantor(true, guarantor.latencyMs, guarantor.liveNetProfitPct);
    addScannerEvent("guarantor_pass", `Guarantor pass auto-arb: ${route.symbol} LIVE +${guarantor.liveNetProfitPct.toFixed(3)}%`, {
      symbol: route.symbol,
      spreadPct: guarantor.liveNetProfitPct,
      method: route.method,
      details: `${guarantor.legs.length} legs re-quoted in ${guarantor.latencyMs.toFixed(0)}ms`,
    });

    // Auto-arb discovers raw tokens (always quoted in the wrapped native),
    // so these routes borrow the quote asset — the bridging logic stays
    // uniform for any future discovery source that carries its own asset.
    const loanAssetSymbol = feed.snapshot.quoteSymbol ?? chain.quoteSymbol;
    const loanAssetAddress = resolveLoanAssetAddress(
      loanAssetSymbol,
      feed.snapshot,
      quoteAddress,
    );
    if (!loanAssetAddress) {
      toast.error("Loan asset unavailable on-chain", {
        description: `${loanAssetSymbol} has no live address in the feed — paper mode only.`,
      });
      return;
    }
    const loanAssetIsQuote = loanAssetSymbol === (feed.snapshot.quoteSymbol ?? chain.quoteSymbol);
    const bridgedPath: Hex[] = loanAssetIsQuote
      ? (path as Hex[])
      : [
          loanAssetAddress as Hex,
          quoteAddress as Hex,
          ...(path as Hex[]).slice(1, -1),
          quoteAddress as Hex,
          loanAssetAddress as Hex,
        ];
    // Quote-denominated auto-arb borrows 1 unit, matching the strategy floor.
    const loanWei = BigInt(Math.round(Math.max(minLoanBnb, 1) * 1e18));
    const amountOutMin = computeAmountOutMin(loanWei, guarantor.liveNetProfitPct, slippage);
    const data = buildExecuteData(loanAssetAddress as Hex, loanWei, bridgedPath, amountOutMin);

    // HOT-PATH PREFETCH (same trick as the manual path): the reads overlap
    // the daily-target check + simulation; discarded if the injected path
    // ends up broadcasting instead.
    const vaultHwAuto = evmGetVaultHotWallet();
    const effectiveHotAuto = vaultHwAuto
      ? { privateKey: vaultHwAuto.privateKey, address: vaultHwAuto.address }
      : hotWallet;
    const hotPreflightArb =
      effectiveHotAuto !== null
        ? Promise.all([
            estimateFlashLoanGas(rpcUrl, effectiveHotAuto.address, state.deployedContractAddress, data),
            gasPriceWeiFor(rpcUrl),
            nextNonce(rpcUrl, effectiveHotAuto.address),
          ]).catch(() => null)
        : null;
    // Same policy on the auto path — no injected signer, no injected-armed contract.
    const armAuto = contractArmVerdict(state?.deployments?.[chainKey]?.signerAddress ?? null);
    if (!armAuto.allowed) {
      addScannerEvent("flash_failed", "Armed contract refused by the wallet guard (auto)", { details: armAuto.reason });
      toast.error("Contract not eligible for flash loans", { description: armAuto.reason });
      return;
    }
    const signerSourceAuto: SignerSource = vaultHwAuto ? "vault" : hotWallet ? "hot" : "none";
    const ownsAuto = effectiveHotAuto
      ? await isFlashBoltOwner(rpcUrl, state.deployedContractAddress, effectiveHotAuto.address)
      : false;
    const signerVerdictAuto = arbitrageSignerVerdict(signerSourceAuto, { ownsContract: ownsAuto });
    if (!signerVerdictAuto.allowed) {
      addScannerEvent("flash_failed", "Auto-arb blocked by the wallet guard", {
        details: `${signerVerdictAuto.reason}${injectedFromAuto ? ` An injected wallet (${injectedFromAuto.slice(0, 10)}…) is connected but may not sign this.` : ""}`,
      });
      toast.error("Auto-arb blocked", { description: signerVerdictAuto.reason });
      return;
    }

    // Operator/guest-chosen daily flash target (1–∞, 0 = unlimited). The
    // SERVER subscriber cap (3) is enforced separately below and never
    // applies to operator/guest — their local choice is the only limit.
    if (!canExecute("flasher", "flash", dailyFlashLimit)) {
      toast.warning("Daily flash loan limit reached", {
        description: `${dailyFlashLimit} flash loans executed today. Increase limit in Strategy settings.`,
      });
      return;
    }
    // Subscriber daily target (server-enforced) — auto-arb path.
    try {
      const slot = await consumeExecutionSlot({ kind: "flash", chain: "bnb", label: routeLabel(mockRoute) });
      if (slot.blocked) {
        toast.warning("Daily target reached", { description: slot.reason });
        return;
      }
    } catch {
      toast.error("Could not verify your daily target — execution aborted.");
      return;
    }

    // eth_call simulation — zero-gas pre-flight check
    setExecutingId(`arb-${route.address}`);
    try {
      const simResult = await simulateFlashLoanTx(
        rpcUrl,
        state.deployedContractAddress,
        effectiveHotAuto!.address,
        data,
        (isBscChain(chainKey) ? BNB_NETWORKS[networkKey] : networkInfoFor(chainKey, networkKey)).chainId,
      );
      if (!simResult.success) {
        addScannerEvent("profit_guard_blocked", `Simulation failed: ${route.symbol}`, {
          symbol: route.symbol,
          spreadPct: route.spreadPct,
          details: `${simResult.error ?? "would revert"} · sim ${simResult.latencyMs.toFixed(0)}ms across ${simResult.raced} RPCs`,
        });
        playAlert();
        toast.error("eth_call simulation failed — zero gas saved", {
          description: `${simResult.error ?? "Transaction would revert."} No gas was spent (sim ${simResult.latencyMs.toFixed(0)}ms).`,
        });
        setExecutingId(null);
        return;
      }
      addScannerEvent("flash_submitted", `Flash-loan submitted: ${route.symbol}`, {
        symbol: route.symbol,
        spreadPct: route.spreadPct,
        method: route.method,
        lender: feed.lender,
        txHash: `sim-${simResult.latencyMs.toFixed(0)}ms-${simResult.raced}rpc`,
        details: `submission channel: wallet RPC${(state?.privateSubmit ?? true) && isPrivateRpcAvailable((isBscChain(chainKey) ? BNB_NETWORKS[networkKey] : networkInfoFor(chainKey, networkKey)).chainId, networkKey) ? " (set the wallet to a Protect RPC for private submission)" : ""}`,
      });
      playFlashSubmitted();
      tg.flashSubmitted(route.symbol, route.spreadPct, feed.lender);
      toast.loading(`Auto-arb: ${route.symbol} +${route.spreadPct.toFixed(2)}% via ${route.method}`, {
        description: `Flash-loan via ${feed.lender} → ${route.dexes.join(" → ")} → repay.`,
      });
      // Dual submission path, same ownership rule as manual execution: a
      // hot wallet drives the flash-loan ONLY when it is the deployer
      // (execute() is onlyOwner — verified with a real owner() eth_call).
      let arbHash: Hex | undefined;
      let arbSignMs: number | undefined;
      const arbChain = isBscChain(chainKey) ? BNB_NETWORKS[networkKey] : networkInfoFor(chainKey, networkKey);
      if (effectiveHotAuto) {
        const owns = await isFlashBoltOwner(rpcUrl, state.deployedContractAddress, effectiveHotAuto.address);
        const pre = owns ? await hotPreflightArb : null;
        if (owns && !pre) {
          addScannerEvent("flash_failed", "Hot-wallet preflight failed — falling back to the injected wallet", {
            details: "Gas or nonce read failed on the RPC. Nothing was signed or broadcast by the hot path.",
          });
        }
        if (owns && pre) {
          const [gas, { wei }, nonce] = pre;
          const sent = await sendSignedTransaction(
            rpcUrl,
            arbChain.chainId,
            effectiveHotAuto.privateKey as `0x${string}`,
            { to: state.deployedContractAddress as Hex, data, microsecond: true, gas, gasPriceWei: wei, nonce },
            { enabled: state?.privateSubmit ?? true, network: networkKey },
          );
          arbHash = sent.txHash;
          arbSignMs = sent.signingLatencyMs;
          addScannerEvent("flash_submitted", `Flash-loan submitted (hot wallet): ${route.symbol}`, {
            symbol: route.symbol,
            spreadPct: route.spreadPct,
            method: route.method,
            lender: feed.lender,
            txHash: sent.txHash,
            details: `submission channel: ${sent.relay ?? "public RPC"}${sent.relayDegraded ? " (all relays in cooldown)" : ""} · signer: ${effectiveHotAuto.address.slice(0, 10)}…${vaultHwAuto ? " (vault import)" : ""}`,
          });
        }
      }
      if (!arbHash) {
        // No injected fallback: without the vault/hot submission there is no
        // permitted signer, so nothing is signed rather than switching wallets.
        addScannerEvent("flash_failed", "Flash-loan not submitted — hot-wallet submission unavailable", {
          details: "The wallet guard forbids an injected wallet from signing execute(); nothing was signed.",
        });
        toast.error("Flash-loan not submitted", {
          description: "Hot-wallet submission was unavailable (relay, gas or nonce). Nothing was signed — retry.",
        });
        return;
      }
      const txHash = arbHash;
      const receipt = await waitForFlashLoanReceipt(provider, txHash);
      const loanBnb = 1;
      const gain = loanBnb * (route.spreadPct / 100);
      if (receipt.status === "success") {
        await recordExecution({
          label: `ARB ${route.symbol} (${route.method})`,
          profitPct: route.spreadPct,
          amountBnb: gain,
          status: "success",
          lender: feed.lender,
          dexes: route.dexes.join(" → "),
          payoutBnb: state?.autoPayout ? gain : 0,
          network: isBscChain(chainKey) ? state?.network : chainKey,
          txHash,
          chainId: (isBscChain(chainKey) ? BNB_NETWORKS[networkKey] : networkInfoFor(chainKey, networkKey)).chainId,
          gasUsedBnb: receipt.gasUsedBnb,
          signingLatencyMs: arbSignMs,
          method: "statistical",
        });
        addScannerEvent("flash_confirmed", `Flash-loan confirmed: ${route.symbol} +${route.spreadPct.toFixed(2)}%`, {
          symbol: route.symbol,
          spreadPct: route.spreadPct,
          method: route.method,
          lender: feed.lender,
          txHash,
        });
        playFlashConfirmed();
        incrementTracker("flasher", "flash", "win");
        tg.flashConfirmed(route.symbol, route.spreadPct, feed.lender, gain, txHash, arbSignMs);
        toast.success(`Auto-arb +${route.spreadPct.toFixed(2)}% ${route.symbol} confirmed`, {
          description: `Flash-loan via ${feed.lender} → ${route.method} arb → ${gain.toFixed(4)} BNB profit.`,
        });
      } else {
        await recordExecution({
          label: `ARB ${route.symbol} (${route.method})`,
          profitPct: route.spreadPct,
          amountBnb: 0,
          status: "failed",
          lender: feed.lender,
          dexes: route.dexes.join(" → "),
          network: isBscChain(chainKey) ? state?.network : chainKey,
          txHash,
          chainId: (isBscChain(chainKey) ? BNB_NETWORKS[networkKey] : networkInfoFor(chainKey, networkKey)).chainId,
          gasUsedBnb: receipt.gasUsedBnb,
          method: "statistical",
        });
        addScannerEvent("flash_failed", `Flash-loan failed: ${route.symbol}`, {
          symbol: route.symbol,
          spreadPct: route.spreadPct,
          lender: feed.lender,
          txHash,
        });
        playFlashFailed();
        incrementTracker("flasher", "flash", "loss");
        tg.flashFailed(route.symbol, feed.lender);
      }
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code !== 4001) {
        incrementTracker("flasher", "flash", "loss");
        addScannerEvent("error", `Auto-arb error: ${route.symbol}`, { symbol: route.symbol });
        playAlert();
        toast.error(`Auto-arb failed: ${route.symbol}`, {
          description: error instanceof Error ? error.message : "Execution reverted. Zero gas fee on revert.",
        });
      }
    } finally {
      setExecutingId(null);
    }
  }, [feed.snapshot, feed.lender, feed.lenders, chainKey, networkKey, state, chain, mevGuard, profitGuard, recordExecution, playSuccess, playFail, playFlashSubmitted, playFlashConfirmed, playFlashFailed, playAlert, addScannerEvent]);

  // ─── Automatic cross-chain flash-loan execution (selected chain) ───
  // Actionable spreads on the SELECTED chain that clear the profitability
  // floor are initiated automatically, the instant the cross-chain strip
  // lights up. Every route flows through the full guard stack inside
  // handleExecute (profit guard → NLP-aware MEV guard → profit guarantor →
  // eth_call simulation → zero gas on failure), so only genuinely passing
  // spreads ever reach the chain. The daily flash-loan limit guard still
  // applies inside the executor.
  const autoExecXcsRef = useRef(new Set<string>());
  const autoExecXcsBusyRef = useRef(false);
  useEffect(() => {
    if (!(state?.botRunning ?? true)) return;
    if (autoExecXcsBusyRef.current) return;
    const fresh = actionableSpreads.filter(
      (s) =>
        s.spreadPct >= floor &&
        !autoExecXcsRef.current.has(`${s.symbol}:${s.cheapChain}:${s.dearChain}`),
    );
    if (fresh.length === 0) return;
    autoExecXcsBusyRef.current = true;
    for (const spread of fresh) {
      autoExecXcsRef.current.add(`${spread.symbol}:${spread.cheapChain}:${spread.dearChain}`);
      addScannerEvent("arb_detected", `Auto-arb cross-chain: ${spread.symbol} +${spread.spreadPct.toFixed(2)}% on ${chain.label}`, {
        symbol: spread.symbol,
        spreadPct: spread.spreadPct,
        method: "cross-chain",
      });
      playArbDetected();
      tg.arbDetected(spread.symbol, spread.spreadPct, "cross-chain");
      void handleExecute(flashRouteForSpread(spread, chainKey, feed.lender));
    }
    if (autoExecXcsRef.current.size > 500) {
      const arr = [...autoExecXcsRef.current];
      autoExecXcsRef.current = new Set(arr.slice(-200));
    }
    autoExecXcsBusyRef.current = false;
  }, [actionableSpreads, floor, state?.botRunning, feed.lender, chainKey, chain.label, addScannerEvent, playArbDetected, handleExecute]);

  // Auto-execute ALL profitable generated routes: every NEW route that
  // passes the profitability floor is automatically initiated for flash-loan
  // execution — not just the single best one. Each still flows through the
  // full guard stack (profit guard → NLP-aware MEV guard → floor → full
  // eth_call simulation → zero gas on failure) inside handleExecute, so only
  // genuinely passing routes ever reach the chain. The daily flash-loan limit
  // guard still applies inside the executor.
  const autoExecGenRef = useRef(new Set<string>());
  const autoExecBusyRef = useRef(false);
  useEffect(() => {
    if (!(state?.botRunning ?? true)) return;
    if (autoExecBusyRef.current) return;
    // Flasher only runs flash-loan arbitrage — no snipe mode.
    const fresh = profitableRoutes.filter(
      (r) => r.netProfitPct >= floor && !autoExecGenRef.current.has(r.legs.join(">")),
    );
    if (fresh.length === 0) return;
    autoExecBusyRef.current = true;
    // Execute every passed route (newest/highest ranked first); each one is
    // individually guarded and simulated inside handleExecute.
    for (const r of fresh) {
      const key = r.legs.join(">");
      autoExecGenRef.current.add(key);
      addScannerEvent("arb_detected", `Auto-arb: ${routeLabel(toFlashRoute(r, feed.run))} +${r.netProfitPct.toFixed(2)}%`, {
        symbol: r.legs[2],
        spreadPct: r.netProfitPct,
        method: "triangular",
        lender: r.lender,
      });
      playArbDetected();
      tg.arbDetected(r.legs[2] ?? "route", r.netProfitPct, "triangular");
      void handleExecute(toFlashRoute(r, feed.run));
    }
    if (autoExecGenRef.current.size > 500) {
      const arr = [...autoExecGenRef.current];
      autoExecGenRef.current = new Set(arr.slice(-200));
    }
    autoExecBusyRef.current = false;
  }, [profitableRoutes, floor, state?.botRunning, feed.run, addScannerEvent, playArbDetected, handleExecute]);

  return (
    <div className="flex flex-col gap-6">
      <header className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-primary/5 px-6 py-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(34,197,94,0.08),transparent_50%)]" />
        <div className="relative">
          <div className="flex items-center gap-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
              FlashBolt Terminal
            </p>
          </div>
          <h1 className="mt-1.5 text-3xl font-extrabold tracking-tight text-foreground">
            <span className="bg-gradient-to-r from-emerald-400 via-primary to-primary bg-clip-text text-transparent">Scanner</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Sub-millisecond flash-loan arbitrage scanner — discovers {chain.quoteSymbol}→A→B→{chain.quoteSymbol}
            triangular routes across whitelisted AMMs in real time. Only profitable
            flash-loan arbitrage is executed. Break-even spread guard ensures minimum
            profitability after all fees. Live gas prices from the chain&apos;s real RPC.
          </p>
        </div>
      </header>

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      {/* ─── TELECOPIER — Telegram signal copier bot (Flasher) ─── */}
      <TelecopierBotPanel
        onRoute={handleTelecopierRoute}
        chainKey={chainKey}
        dexWhitelist={feedSettings.dexWhitelist}
        lender={feed.lender}
        loanSizeBnb={feedSettings.maxLoan}
        run={feed.run}
      />

      {/* Automated scanner + flash-loan alert banner */}
      <ScannerAlertBanner
        events={scannerEvents}
        running={state?.botRunning ?? true}
        cadence={state?.cadence ?? 15}
        lastScanAt={state?.lastScanAt}
        gasPriceGwei={gasPriceGwei}
        lender={feed.lender}
        mempoolCount={mempool.pendingSwaps.length}
        mempoolLastPoll={mempool.lastPoll}
        mempoolError={mempool.error}
      />

      {/* Chain selector */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-card/40 px-4 py-3">
        <span className="text-xs font-semibold text-muted-foreground">
          Scanning chain:
        </span>
        {CHAIN_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => void handleChainSwitch(key)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
              chainKey === key
                ? "bg-primary text-primary-foreground"
                : "border border-border/70 text-muted-foreground hover:text-foreground",
            )}
          >
            {CHAIN_INFO[key].label}
            {state?.network === "testnet" ? " (testnet)" : ""}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {state?.network === "testnet"
            ? `${networkInfoFor(chainKey, networkKey).label} · on-chain discovery${feed.testnetPairs.length > 0 ? ` · ${feed.testnetPairs.length} live pairs` : ""}`
            : `${chain.quoteSymbol} pairs · ${chain.dexes.length} AMMs · real data`}
        </span>
        <DailyTargetBadge />
      </div>

      {/* Profit guarantor status — live gates on every automatic execution */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-400" />
          <span className="text-xs font-bold uppercase tracking-wide text-emerald-400">Profit Guarantor</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          Every execution is re-quoted leg-by-leg on its venue router right before the flash-loan — stale edges are blocked with zero gas.
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-semibold">
          <span className="text-emerald-400">{guarantorStats.passed} passed</span>
          <span className="text-amber-400">{guarantorStats.blocked} blocked</span>
          <span className="text-muted-foreground">
            last: {guarantorStats.lastLatencyMs > 0 ? `${guarantorStats.lastLatencyMs.toFixed(0)}ms` : "—"}
            {guarantorStats.lastNetPct !== 0 ? ` · LIVE ${guarantorStats.lastNetPct >= 0 ? "+" : ""}${guarantorStats.lastNetPct.toFixed(3)}%` : ""}
          </span>
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 px-4 py-3.5 lg:flex-row lg:items-center">
        <div className="flex flex-wrap gap-1.5">
          {dexFilters.map((dex) => (
            <button
              key={dex}
              type="button"
              onClick={() => setDexFilter(dex)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                dexFilter === dex
                  ? "bg-primary text-primary-foreground"
                  : "border border-border/70 text-muted-foreground hover:text-foreground",
              )}
            >
              {dex !== "All" && (
                <span
                  className="size-1.5 rounded-full"
                  style={{
                    background:
                      chain.dexes.find((d) => d.key === dex)?.color ?? "currentColor",
                  }}
                />
              )}
              {dex}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setHoneypot((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
              honeypot
                ? "bg-amber-400 text-amber-950"
                : "border border-amber-500/30 text-amber-400 hover:bg-amber-500/10",
            )}
          >
            <Sparkles className="size-3.5" />
            Honey pot{honeyCount > 0 && !honeypot ? ` (${honeyCount})` : ""}
          </button>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-4 lg:justify-end">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Min profit
            <Input
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={minProfit}
              onChange={(e) => setMinProfit(e.target.value)}
              onBlur={() =>
                void setSettings({ minProfit: floor }).catch(() => undefined)
              }
              className="h-8 w-20 font-mono"
            />
            %
          </label>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 text-primary" />
            MEV guard
            <Switch
              checked={mevGuard}
              onCheckedChange={(checked) => {
                setMevGuard(checked);
                void setSettings({ mevGuard: checked }).catch(() => undefined);
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground" title="Flashbots Protect / bloXroute Protect — signed hot-wallet txs bypass the public mempool (anti-frontrun). The injected-wallet flash-loan path uses the wallet's own RPC: set the wallet to a Protect RPC for private submission there.">
            <ShieldCheck className="size-4 text-sky-400" />
            <span className="flex flex-col leading-tight">
              <span>Private submission</span>
              <span className="text-[10px] text-muted-foreground/80">
                {state?.privateSubmit
                  ? isPrivateRpcAvailable(networkInfoFor(chainKey, networkKey).chainId, networkKey)
                    ? networkInfoFor(chainKey, networkKey).nativeSymbol === "ETH"
                      ? "Flashbots Protect ON (hot wallet)"
                      : "bloXroute ON (hot wallet)"
                    : `no relay — public RPC (${chain.label})`
                  : "OFF"}
              </span>
            </span>
            <Switch
              checked={state?.privateSubmit ?? true}
              onCheckedChange={(checked) => {
                void setSettings({ privateSubmit: checked }).catch(() => undefined);
              }}
            />
          </div>
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title="Generate a session-only hot wallet to sign flash-loan txs locally and broadcast through the private relays (Flashbots/bloXroute). The hot wallet must be the DEPLOYER of the armed contract — execute() is onlyOwner."
          >
            <KeyRound className="size-4 text-amber-400" />
            <span className="flex flex-col leading-tight">
              <span>Hot-wallet signer</span>
              <span className="text-[10px] text-muted-foreground/80">
                {hotWallet
                  ? `${hotWallet.address.slice(0, 6)}…${hotWallet.address.slice(-4)} — private relay`
                  : "injected wallet RPC"}
              </span>
            </span>
            {hotWallet ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => {
                  void copyText(hotWallet.mnemonic, {
                    message: "Mnemonic copied",
                    description: "Paste it somewhere safe — this wallet is NOT stored and disappears on reload.",
                  });
                }}
              >
                Copy seed
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={generateFlasherHotWallet}
              >
                Generate
              </Button>
            )}
            {hotWallet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300"
                onClick={() => {
                  setHotWallet(null);
                  addScannerEvent("flash_failed", "Hot wallet cleared from session");
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setRescanKey((k) => k + 1)}
          >
            <RefreshCw className="size-4" />
            Re-scan
          </Button>
        </div>
      </div>

      {/* ─── STRATEGY: Flash-loan daily limit, min/max loan, mode selector ─── */}
      <div className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card/60 to-primary/5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-primary" />
            STRATEGY — Flash Loan Arbitrage Automation
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-muted-foreground">Today:</span>
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">W {dailyTracker.wins}</Badge>
            <Badge className="border-red-500/25 bg-red-500/10 text-red-400">L {dailyTracker.losses}</Badge>
            <Badge className="border-primary/25 bg-primary/10 text-primary">Flash {dailyTracker.flashCount}/{dailyFlashLimit === Infinity ? '∞' : dailyFlashLimit}</Badge>
          </div>
        </div>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Daily Flash Limit</label>
            <Input
              type="number"
              min={1}
              max={9999}
              value={dailyFlashLimit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 1) setDailyFlashLimit(v);
              }}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground/60">Max flash-loan executions per day (1–∞)</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Min Profit Floor (%)</label>
            <Input
              type="number"
              min={0}
              max={10}
              step={0.01}
              value={minProfit}
              onChange={(e) => setMinProfit(e.target.value)}
              onBlur={() => void setSettings({ minProfit: floor }).catch(() => undefined)}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground/60">Minimum net profit after costs (default 0.1%)</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Max Flash Loan (BNB)</label>
            <Input
              type="number"
              min={0.1}
              max={100}
              step={0.1}
              value={state?.maxLoan ?? DEFAULT_FEED_SETTINGS.maxLoan}
              onChange={(e) => void setSettings({ maxLoan: Number(e.target.value) }).catch(() => undefined)}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground/60">Upper bound for flash loan (default 10)</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Min Flash Loan (BNB)</label>
            <Input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={minLoan}
              onChange={(e) => setMinLoan(e.target.value)}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground/60">Minimum flash loan size (default 0.1)</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border/40 px-5 py-3">
          <span className="rounded-full bg-primary/15 px-3 py-1.5 text-[11px] font-semibold text-primary">⚡ Flash Loan Arbitrage ONLY</span>
          <span className="ml-auto text-[10px] text-muted-foreground/60">Flasher is flash-loan arbitrage only — sniper handles sniping</span>
        </div>
      </div>

      {/* Lender rotation strip */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-card/40 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Landmark className="size-3.5 text-primary" />
          Flash-loan lender this run:
        </span>
        <Badge className="border-primary/30 bg-primary/10 text-primary">
          {feed.lender}
        </Badge>
        <span className="mx-1 text-xs text-muted-foreground">rotates →</span>
        {feed.lenders.map((lender) => (
          <span
            key={lender}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
              lender === feed.lender
                ? "bg-primary/15 text-primary"
                : "border border-border/60 text-muted-foreground",
            )}
          >
            {lender}
          </span>        ))}
      </div>

      {/* ─── PER-ROUTE COST PRICING ─── */}
      <div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
        <span className="text-[11px] font-semibold text-muted-foreground">Min Net Margin:</span>
        <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400 font-mono">
          {floor.toFixed(3)}%
        </Badge>
        <span className="text-[10px] text-muted-foreground/60">
          priced per route — venue fees + lender fee + liquidity slippage + live gas + 0.15% safety, deducted from every route's profit
        </span>
      </div>

  {/* FLASH ROUTE GENERATOR — profitable triangular arbitrage routes */}
      {generatedRoutes.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              {chain.quoteSymbol} ROUTE GENERATOR
              {profitableRoutes.length > 0 && (
                <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
                  {profitableRoutes.length} profitable
                </Badge>
              )}
              <Badge className="border-border/50 text-[10px]">
                {generatedRoutes.length} scanned
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              {chain.quoteSymbol}→A→B→{chain.quoteSymbol} · gas+fees+slippage deducted · MEV guarded
            </span>
          </div>
          <div className="divide-y divide-border/40">
            {generatedRoutes.map((route, idx) => (
              <div
                key={`${route.legs.join(">")}-${idx}`}
                className={cn(
                  "flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between",
                  !route.isProfitable && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[13px]">
                    {route.legs.map((leg, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        <span
                          className={
                            i % 2 === 1
                              ? "font-semibold text-primary"
                              : "text-foreground/90"
                          }
                        >
                          {leg}
                        </span>
                        {i < route.legs.length - 1 && (
                          <span className="text-muted-foreground/50">→</span>
                        )}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Landmark className="size-3 text-primary" />
                      {route.lender}
                    </span>
                    <span className={cn(
                      "font-mono font-semibold",
                      route.isProfitable ? "text-emerald-400" : "text-red-400",
                    )}>
                      gross +{route.grossProfitPct.toFixed(3)}%
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                      −gas {route.gasCostBnb.toFixed(6)} · −fees {route.totalFeesPct.toFixed(2)}% · −slip {route.slippageCostPct.toFixed(2)}% · −safe 0.15%
                    </span>
                    <span
                      className={
                        route.mevRisk >= 70
                          ? "text-red-400"
                          : route.mevRisk >= 40
                            ? "text-amber-400"
                            : "text-emerald-400"
                      }
                    >
                      MEV {route.mevRisk}
                    </span>
                    <span>
                      liq ${route.minLiquidityUsd >= 1_000_000
                        ? `${(route.minLiquidityUsd / 1_000_000).toFixed(1)}M`
                        : `${Math.round(route.minLiquidityUsd / 1000)}k`}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <div className="text-right">
                    <div className={cn(
                      "font-mono text-lg font-bold",
                      route.isProfitable ? "text-emerald-400" : "text-red-400",
                    )}>
                      {route.isProfitable ? "+" : ""}{route.netProfitPct.toFixed(3)}%
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      net after costs
                    </div>
                  </div>
                  {route.isProfitable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="gap-1.5"
                      onClick={() => {
                        const flashRoute = toFlashRoute(route, feed.run);
                        void handleExecute(flashRoute);
                      }}
                    >
                      <Zap className="size-4" />
                      Execute
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feed */}
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/40 shadow-[0_0_30px_-10px_rgba(239,68,68,0.15)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-red-500" />
            </span>
            LIVE ROUTE FEED — {chain.label.toUpperCase()} ({displayRoutes.length}+ routes)
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
              REAL MARKET DATA
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {displayRoutes.length} total · {feed.routes.length} live · {feed.nearMissRoutes.length} near-miss · {generatedRoutes.length} generated · <span className="font-semibold text-emerald-400">{paperExecutedRows.length} paper-executed</span> · <span className="font-semibold text-fuchsia-400">{agentCapturesRef.current.size} agent-captured</span> · <span className="font-semibold text-emerald-400">{[...nlpMevRef.current.values()].filter((n) => n.label === "PASS").length} NLP-pass</span>{mempool.pendingSwaps.length > 0 ? (
              <>{" "}· <span className="font-semibold text-violet-400">{mempool.pendingSwaps.length} mempool</span></>
            ) : null}
            {honeypot ? (
              <>
                {" "}· <span className="font-semibold text-amber-400">{filtered.length} honey pots</span>
              </>
            ) : honeyCount > 0 ? (
              <>
                {" "}· <span className="font-semibold text-amber-400">{honeyCount} honey pots</span>
              </>
            ) : null}{" "}
            · scan every {state?.cadence ?? 15}s · lender {feed.lender} · gas{" "}
            <span className="font-mono text-foreground/80">
              {gasPriceGwei !== null
                ? `${gasPriceGwei.toFixed(3)} gwei`
                : "—"}
            </span>{" "}
            (live RPC)
          </span>
        </div>

        {/* Cross-chain DEX arbitrage strip — real same-asset spreads across chains */}
        {/* Per-source health — which data sources actually fed this cycle's
            feed. Real pair counts + real latency from the aggregated
            snapshot: green = contributed pairs, amber = reachable but empty,
            red = request failed. Nothing simulated. */}
        {(() => {
          const health = feed.snapshot?.sourceHealth;
          const entries = Object.entries(health ?? {});
          if (entries.length === 0) return null;
          return (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-background/30 px-5 py-1.5 text-[10px]">
              <span className="font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Sources
              </span>
              {entries.map(([name, h]) => (
                <span
                  key={name}
                  title={`${name}: ${h.pairs} pair${h.pairs === 1 ? "" : "s"} in ${h.ms}ms${h.ok ? "" : " - request failed"}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono transition-colors",
                    !h.ok
                      ? "border-red-500/30 bg-red-500/10 text-red-400"
                      : h.pairs > 0
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-400",
                  )}
                >
                  {name}
                  <span className="font-semibold">{h.ok ? h.pairs : "err"}</span>
                  <span className="text-muted-foreground/70">{h.ms}ms</span>
                </span>
              ))}
            </div>
          );
        })()}

        {crossChainSpreads.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-cyan-500/5 px-5 py-2 text-xs">
            <span className="font-semibold text-cyan-400">CROSS-CHAIN:</span>
            {actionableSpreads.slice(0, 4).map((s) => (
              <Badge key={`${s.symbol}-${s.cheapChain}-${s.dearChain}`} className="border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                {s.symbol} +{s.spreadPct.toFixed(2)}% · {s.cheapChain}→{s.dearChain} (exec on {chainKey})
              </Badge>
            ))}
            {actionableSpreads.some((s) => s.spreadPct >= floor) && (
              <span className="inline-flex items-center gap-1 font-semibold text-emerald-400">
                <Zap className="size-3" /> AUTO-EXEC ACTIVE
              </span>
            )}
            {crossChainSpreads.length > actionableSpreads.length && (
              <span className="text-muted-foreground">
                +{crossChainSpreads.length - actionableSpreads.length} on other chains
              </span>
            )}
          </div>
        )}

        {/* 21 AI agent determinant strip — each agent scores every route */}
        <AgentChipStrip />

        {feed.error ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <WifiOff className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">
              Market feed unreachable
            </p>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              {feed.error} — prices come live from DexScreener. Check the network
              connection, then retry.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => feed.rescan()}
            >
              <RefreshCw className="size-4" />
              Retry now
            </Button>
          </div>
        ) : feed.loading && feed.routes.length === 0 && generatedRoutes.length === 0 ? (
          <div className="divide-y divide-border/40">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
                <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
                <div className="h-8 w-24 animate-pulse rounded-full bg-muted/60" />
              </div>
            ))}
            <div className="flex items-center justify-center gap-2 px-5 py-3 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Initial scan in progress — {10} skeleton rows shown. Live routes will populate shortly.
            </div>
          </div>
        ) : displayRoutes.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
            <div className="flex flex-col items-center gap-2">
              <span className="relative flex size-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex size-3 rounded-full bg-emerald-400" />
              </span>
              <p className="text-sm font-medium text-foreground">
                Scanning {chain.label} markets — next check in {state?.cadence ?? 15}s
              </p>
              <p className="text-xs text-muted-foreground">
                Live routes, near-miss spreads, and {chain.quoteSymbol} triangular arbitrage will appear here automatically.
                The scanner fetches real DexScreener data every cycle and never shows zero.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/60">
              <span>Chain: {chain.label}</span>
              <span>·</span>
              <span>DEXes: {chain.dexes.length}</span>
              <span>·</span>
              <span>Lender: {feed.lender}</span>
              <span>·</span>
              <span>Route count: {generatedRoutes.length} generated</span>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {displayRoutes.map((route) => {
              const risk = riskLevel(route.mevRisk);
              const ttlLeft = Math.max(
                0,
                Math.ceil(
                  (feed.lastScan ?? now) + route.ttlSeconds * 1000 - now,
                ) / 1000,
              );
              const expired = ttlLeft <= 0;
              const blocked = mevGuard && route.mevRisk >= 70;
              const belowFloor = route.profitPct < floor;
              const netAfterCosts = route.profitPct; // already ALL-IN net from the engine — never deduct costs twice
              const isHoney = isHoneyPot(route, honeyProfitPct, honeyLiquidityUsd);
              return (
                <div
                  key={route.id}
                  className={cn(
                    "flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center",
                    expired && route.source !== "executed" && "opacity-45",
                    route.source === "executed" && "border-l-2 border-l-emerald-500/60 bg-emerald-500/[0.04]",
                    !route.isProfitable && route.source === "near-miss" && "opacity-60",
                    route.source === "generated" && !route.isProfitable && "opacity-40",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[13px]">
                      {route.legs.map((leg, i) => (
                        <span key={i} className="flex items-center gap-1.5">
                          <span
                            className={
                              i % 2 === 1
                                ? "font-semibold text-primary"
                                : "text-foreground/90"
                            }
                          >
                            {leg}
                          </span>
                          {i < route.legs.length - 1 && (
                            <span className="text-muted-foreground/50">→</span>
                          )}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Landmark className="size-3 text-primary" />
                        {route.lender}
                        <span className="text-muted-foreground/60">
                          ({lenderFeeLabel(route.lender)} fee)
                        </span>
                      </span>
                      {isHoney && (
                        <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                          <Sparkles className="size-3" />
                          honey pot
                        </span>
                      )}
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase",
                        route.source === "executed" ? "bg-emerald-500/20 text-emerald-300" : route.source === "live" ? "bg-emerald-500/15 text-emerald-400" : route.source === "near-miss" ? "bg-amber-500/15 text-amber-400" : "bg-blue-500/15 text-blue-400",
                      )}>
                        {route.source === "executed" ? "EXEC" : route.source === "live" ? "LIVE" : route.source === "near-miss" ? "NEAR" : "GEN"}
                      </span>
                      {route.source === "executed" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400" title="Executed under paper mode - recorded in the real execution trail (no on-chain tx)">
                          <CheckCircle2 className="size-3" />
                          paper · {new Date(route.executedAt ?? 0).toLocaleTimeString()}
                        </span>
                      )}
                      {(() => {
                        const c = routeAgentConsensusRef.current.get(route.id);
                        const cap = agentCapturesRef.current.get(route.id);
                        const nlp = nlpMevRef.current.get(route.id);
                        return (
                          <>
                            {cap && cap.isNewListing ? (
                              <span
                                className="rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-fuchsia-400"
                                title={`Brand-new listing captured by ${cap.discoveringAgents.length} agents`}
                              >
                                new
                              </span>
                            ) : null}
                            {cap ? (
                              <span
                                className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-violet-400"
                                title={`Discovered by: ${cap.discoveringAgents.join(", ")}`}
                              >
                                ⚡{cap.discoveringAgents.length}
                              </span>
                            ) : null}
                            {c ? (
                              <>
                                <ConsensusBadge consensus={c} label={c.bullish ? "AI-EXEC" : "AI"} />
                                <AgentVoteDots scores={c.perAgent} />
                              </>
                            ) : null}
                            {nlp ? (
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                  nlp.label === "PASS"
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : nlp.label === "WATCH"
                                      ? "bg-amber-500/15 text-amber-400"
                                      : "bg-red-500/15 text-red-400",
                                )}
                                title={`NLP MEV analysis (${nlp.latencyMs.toFixed(3)}ms): P(pass)=${(nlp.mevPassProb * 100).toFixed(0)}% — ${nlp.description}`}
                              >
                                NLP-{nlp.label} {(nlp.mevPassProb * 100).toFixed(0)}%
                              </span>
                            ) : null}
                          </>
                        );
                      })()}
                      <span className="inline-flex items-center gap-1">
                        <Gauge className="size-3" />
                        {route.spreadBps} bps spread
                      </span>
                      <span
                        className={
                          risk === "high"
                            ? "text-red-400"
                            : risk === "medium"
                              ? "text-amber-400"
                              : "text-emerald-400"
                        }
                      >
                        MEV {route.mevRisk}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {route.source === "executed"
                          ? `executed ${new Date(route.executedAt ?? 0).toLocaleTimeString()}`
                          : `TTL ${expired ? "expired" : `${Math.ceil(ttlLeft)}s`}`}
                      </span>
                      <span>
                        loan {route.loanSizeBnb.toFixed(1)} {route.loanAsset ?? chain.quoteSymbol} · $
                        {route.liquidityUsd >= 1_000_000
                          ? `${(route.liquidityUsd / 1_000_000).toFixed(1)}M`
                          : `${Math.round(route.liquidityUsd / 1000)}k`}{" "}
                        liq
                      </span>
                      {blocked && (
                        <span className="inline-flex items-center gap-1 text-red-400">
                          <ShieldAlert className="size-3" />
                          MEV-blocked
                        </span>
                      )}
                      {!blocked && belowFloor && (
                        <span className="text-amber-400">below floor</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
                    <div className="text-right">
                      <div className="font-mono text-lg font-bold text-amber-400">
                        +{route.profitPct.toFixed(2)}%
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        est. +{routeProfitBnb(route).toFixed(4)}{" "}
                        {chain.quoteSymbol} · net{" "}
                        <span
                          className={cn(
                            "font-mono font-semibold",
                            netAfterCosts > 0 ? "text-emerald-400" : "text-red-400",
                          )}
                        >
                          {netAfterCosts.toFixed(2)}%
                        </span>{" "}
                        after all-in costs (fees + slippage + gas)
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={blocked ? "outline" : "default"}
                      disabled={expired || executingId === route.id}
                      className="gap-1.5"
                      onClick={() => void handleExecute(route)}
                    >
                      {executingId === route.id ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Sending…
                        </>
                      ) : blocked ? (
                        <>
                          <ShieldAlert className="size-4" />
                          Blocked
                        </>
                      ) : (
                        <>
                          <Zap className="size-4" />
                          Execute
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <BellRing className="size-3.5 shrink-0 text-primary" />
        New honey-pot routes and every execution ping the notification bell
        instantly — real events only, nothing simulated.
      </div>

      {/* Multi-source token discovery */}
      <TokenDiscoverySection chainKey={chainKey} onArbAutoExecute={handleArbAutoExecute} onArbDetected={(sym, pct) => { addScannerEvent("arb_detected", `Arb detected: ${sym}`, { symbol: sym, spreadPct: pct }); playArbDetected(); }} />
    </div>
  );
}

/**
 * Multi-source token discovery panel — 100+ tokens per cycle from 20+ real APIs.
 * Runs as a separate sub-component so it manages its own polling.
 */
function TokenDiscoverySection({ chainKey, onArbAutoExecute, onArbDetected }: { chainKey: ChainKey; onArbAutoExecute?: (route: { address: string; symbol: string; dexes: string[]; spreadPct: number; method: string }) => void; onArbDetected?: (symbol: string, spreadPct: number) => void }) {
  const discoveryFeed = useTokenDiscovery({ pollInterval: 10 });
  const explorerUrl = isBscChain(chainKey)
    ? "https://bscscan.com"
    : CHAIN_INFO[chainKey].explorerUrl;
  return <TokenDiscoveryPanel feed={discoveryFeed} explorerUrl={explorerUrl} onAutoExecute={onArbAutoExecute} onArbDetected={onArbDetected} />;
}
