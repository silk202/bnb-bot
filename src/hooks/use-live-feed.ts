import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CHAIN_INFO, networkInfoFor, type NetworkKey } from "@/lib/chains";
import {
  computeRoutes,
  DEFAULT_FEED_SETTINGS,
  lenderForRun,
  type ChainKey,
  type FeedSettings,
  type FlashRoute,
  type MarketSnapshot,
} from "@/lib/flashbolt";
import { buildTestnetSnapshot, type TestnetPair } from "@/lib/testnet-feed";
import {
  claimPoll,
  releasePoll,
  MARKET_FEED_GAP_MS,
} from "@/lib/poller-gate";

interface UseLiveFeedOptions {
  settings?: FeedSettings;
  paused?: boolean;
  cadence?: number;
  onScan?: () => void;
  rescanKey?: number;
  balanced?: boolean;
  chainKey?: ChainKey;
  /** Which network of the chain to scan (testnet uses the on-chain engine). */
  network?: NetworkKey;
  /** Operator's private RPC override for the chain+network. */
  rpcOverride?: string;
  /** Live RPC gas price (gwei) for per-route gas pricing; null = conservative fallback. */
  gasPriceGwei?: number | null;
}

export interface LiveFeed {
  routes: FlashRoute[];
  /** Near-miss routes below the profit floor but with a positive edge. */
  nearMissRoutes: FlashRoute[];
  loading: boolean;
  error: string | null;
  lastScan: number | null;
  lender: string;
  run: number;
  lenders: readonly string[];
  snapshot: MarketSnapshot | null;
  chainKey: ChainKey;
  /** Which network this feed scans. */
  network: NetworkKey;
  /** Newly discovered + priced testnet pairs (empty on mainnet). */
  testnetPairs: TestnetPair[];
  /** Where the testnet data came from (empty on mainnet). */
  testnetNotes: string[];
  rescan: () => void;
}

/**
 * Live multi-DEX arbitrage feed. Market data is aggregated from 10+ real
 * sources via a server-side Convex action. Routes are never simulated.
 */
export function useLiveFeed(options: UseLiveFeedOptions = {}): LiveFeed {
  const {
    settings = DEFAULT_FEED_SETTINGS,
    paused = false,
    cadence = 15,
    onScan,
    rescanKey = 0,
    balanced = false,
    chainKey = "bsc",
    network = "mainnet",
    rpcOverride,
    gasPriceGwei = null,
  } = options;
  const settingsKey = JSON.stringify(settings);
  const chainLenders = useMemo(
    () => CHAIN_INFO[chainKey].lenders,
    [chainKey],
  );

  const fetchAggregatedSnapshot = useAction(
    api.marketData.fetchAggregatedSnapshot,
  );

  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [run, setRun] = useState(0);
  const inflightRef = useRef(false);
  const onScanRef = useRef(onScan);
  // Mirror of `snapshot` for the compute gate: a feed instance with no data
  // yet must still fetch even when a sibling instance already claimed the
  // gate (its own data lives in ITS state — React state is not shared).
  const snapshotRef = useRef<MarketSnapshot | null>(null);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const [testnetPairs, setTestnetPairs] = useState<TestnetPair[]>([]);
  const [testnetNotes, setTestnetNotes] = useState<string[]>([]);

  const refresh = useCallback(async (opts?: { manual?: boolean }) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      if (network === "testnet") {
        // Testnet: REAL on-chain data — factory logs + live router quotes.
        // The aggregator action has no testnet coverage, so we go straight to
        // the chain (same guarantees: nothing simulated).
        const info = networkInfoFor(chainKey, "testnet", rpcOverride);
        if (info.venues.length === 0 && !info.geckoNetwork) {
          throw new Error(
            `${info.label} has no verified public V2 venue — set a private RPC + deploy venues on the Contract page, or switch to mainnet`,
          );
        }
        const result = await buildTestnetSnapshot(chainKey, "testnet");
        setRun((r) => r + 1);
        setSnapshot(result.snapshot);
        setTestnetPairs(result.pairs);
        setTestnetNotes(result.notes);
      } else {
        // COMPUTE GATE — fetchAggregatedSnapshot fans out to 9+ external
        // sources inside a Convex ACTION (the Free plan's 20 GB-h/month
        // action-compute allowance; queries/mutations never touch it).
        // Interval ticks coalesce through ONE shared per-chain gate across
        // every mounted feed in this tab (was a full fan-out every 15 s).
        // An instance with no data yet still fetches — the racing sibling's
        // claim is already stamped, so this cannot storm — and manual
        // rescans (mount boot, rescanKey, rescan()) always bypass.
        if (!opts?.manual) {
          const gateKey = `feed:market:${chainKey}`;
          const claimed = claimPoll(gateKey, MARKET_FEED_GAP_MS);
          if (!claimed && snapshotRef.current) return; // coalesced
        }
        const snap = await fetchAggregatedSnapshot({ chainKey });
        setRun((r) => r + 1);
        setSnapshot(snap);
        snapshotRef.current = snap;
        setTestnetPairs([]);
        setTestnetNotes([]);
      }
      setLastScan(Date.now());
      setError(null);
      onScanRef.current?.();
    } catch (e) {
      // Failed fetch — give the gate slot back so the next tick retries.
      if (network !== "testnet") {
        releasePoll(`feed:market:${chainKey}`);
      }
      setError(e instanceof Error ? e.message : "Market feed unreachable");
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, [fetchAggregatedSnapshot, chainKey, network, rpcOverride]);

  useEffect(() => {
    const boot = window.setTimeout(() => {
      // Mount boot AND rescanKey changes are operator-visible moments —
      // they fetch immediately, bypassing the compute gate.
      void refresh({ manual: true });
    }, 0);
    if (paused) {
      return () => window.clearTimeout(boot);
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, cadence * 1000);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(timer);
    };
  }, [refresh, paused, cadence, rescanKey]);

  const routes = useMemo(() => {
    if (!snapshot) return [];
    return computeRoutes(
      snapshot,
      JSON.parse(settingsKey) as FeedSettings,
      run,
      8,
      balanced,
      gasPriceGwei,
    );
  }, [snapshot, settingsKey, run, balanced, gasPriceGwei]);

  // Near-miss routes: routes whose REAL gross cross-venue edge is positive
  // but whose all-in net sits below the operator's margin (usually below
  // break-even — the actual market state most of the time). ALWAYS computed
  // (not only when the live tier is empty) so the feed never starves when
  // spreads are thin — capped at 25, with live-tier routes removed (those
  // already surface above). Same engine, same real data — the data-
  // plausibility guards (real depth, real spread, sane profit cap) are kept;
  // only the profitability cut is loosened to gross-edge-positive.
  const nearMissRoutes = useMemo(() => {
    if (!snapshot) return [];
    const looseSettings: FeedSettings = {
      ...(JSON.parse(settingsKey) as FeedSettings),
      minProfit: 0,
    };
    const liveIds = new Set(routes.map((r) => r.id));
    return computeRoutes(
      snapshot,
      looseSettings,
      run,
      40,
      balanced,
      gasPriceGwei,
      true,
    )
      .filter((r) => !liveIds.has(r.id))
      .slice(0, 25);
  }, [snapshot, settingsKey, run, balanced, gasPriceGwei, routes]);

  const feedLenders = useMemo(
    () => snapshot?.lenders ?? CHAIN_INFO[chainKey].lenders,
    [snapshot, chainKey],
  );

  return {
    routes,
    nearMissRoutes,
    loading,
    error,
    lastScan,
    lender: lenderForRun(run, balanced, feedLenders),
    run,
    lenders: feedLenders,
    snapshot,
    chainKey,
    network,
    testnetPairs,
    testnetNotes,
    rescan: () => void refresh({ manual: true }),
  };
}
