/**
 * useTokenDiscovery — polls the multi-source token discovery pipeline
 * and returns ranked, filtered token candidates from 10+ real APIs.
 *
 * All data is real-time live. Nothing is mocked or simulated.
 */
import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { DiscoverySnapshot, DiscoveryFilter, TokenCandidate } from "@/lib/token-discovery";
import {
  claimPoll,
  coolDownPoll,
  DISCOVERY_FEED_GAP_MS,
  DISCOVERY_FAILURE_COOLDOWN_MS,
} from "@/lib/poller-gate";

export interface TokenDiscoveryFeed {
  /** Ranked token candidates from the pipeline. */
  tokens: TokenCandidate[];
  /** Per-source stats (count, latency, errors). */
  sourceStats: Record<string, { count: number; latencyMs: number; error?: string }>;
  /** Total unique candidates before filtering. */
  totalCandidates: number;
  /** Total candidates that passed filters. */
  totalPassed: number;
  /** Whether the first poll is still loading. */
  loading: boolean;
  /** Error message if the pipeline failed. */
  error: string | null;
  /** Timestamp of the last successful fetch. */
  lastFetch: number | null;
  /** Trigger an immediate re-poll. */
  refresh: () => void;
}

interface UseTokenDiscoveryOptions {
  /** Poll interval in seconds. Default: 60 (apis are rate-limited). */
  pollInterval?: number;
  /** When true, polling pauses. */
  paused?: boolean;
  /** Custom filter overrides. */
  filter?: Partial<DiscoveryFilter>;
}

export function useTokenDiscovery(
  options: UseTokenDiscoveryOptions = {},
): TokenDiscoveryFeed {
  const {
    // 120 s default (was 30 s): the discovery pipeline fans out to 10+ real
    // APIs inside a Convex ACTION (the Free plan's 20 GB-h/month action-
    // compute allowance), and new-pool listings move on a minutes scale —
    // a 4× slower cadence costs no real freshness and saves ~2,160 action
    // fan-outs/day per open tab. The poll gate below coalesces further.
    pollInterval = 120,
    paused = false,
    filter,
  } = options;

  const discoverTokens = useAction(api.tokenDiscovery.discoverTokens);
  const discoverWithFilter = useAction(api.tokenDiscovery.discoverTokensWithFilter);

  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const inflightRef = useRef(false);
  // Mirror of the last snapshot for the compute gate — an instance with no
  // data yet must still fetch even when the gate is closed.
  const snapshotRef = useRef<DiscoverySnapshot | null>(null);

  const fetch = useCallback(async (opts?: { manual?: boolean }) => {
    if (inflightRef.current) return;
    // COMPUTE GATE — interval ticks coalesce through one shared gate per
    // tab; manual refreshes and filter changes (effect re-run) bypass.
    if (!opts?.manual) {
      const claimed = claimPoll("feed:discovery", DISCOVERY_FEED_GAP_MS);
      if (!claimed && snapshotRef.current) return; // coalesced
    }
    inflightRef.current = true;
    try {
      let result: DiscoverySnapshot;
      if (filter && Object.keys(filter).length > 0) {
        result = await discoverWithFilter({
          minLiquidityUsd: filter.minLiquidityUsd ?? 5_000,
          maxAgeHours: filter.maxAgeHours ?? 168,
          minHolders: filter.minHolders ?? 10,
          minTransactions24h: filter.minTransactions24h ?? 20,
          maxBuyTaxPct: filter.maxBuyTaxPct ?? 10,
          maxSellTaxPct: filter.maxSellTaxPct ?? 10,
          excludeHoneypots: filter.excludeHoneypots ?? true,
          minSecurityScore: filter.minSecurityScore ?? 30,
          minVolume24hUsd: filter.minVolume24hUsd ?? 1_000,
          maxRiskLevel: filter.maxRiskLevel ?? "high",
        });
      } else {
        result = await discoverTokens();
      }
      setSnapshot(result);
      snapshotRef.current = result;
      setLastFetch(Date.now());
      setError(null);
    } catch (e) {
      // Failed run — stretch the gate to the failure cooldown so a dead
      // upstream can't burn action compute on every 120 s tick.
      coolDownPoll("feed:discovery", DISCOVERY_FAILURE_COOLDOWN_MS);
      setError(e instanceof Error ? e.message : "Token discovery failed");
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, [discoverTokens, discoverWithFilter, filter]);

  // Poll loop — the boot timeout is the manual path (mount, filter change,
  // and the exposed refresh() which bumps refreshKey); only the interval
  // is gated.
  useEffect(() => {
    const boot = window.setTimeout(() => { void fetch({ manual: true }); }, 0);
    if (paused) return () => window.clearTimeout(boot);
    const timer = window.setInterval(() => { void fetch(); }, pollInterval * 1000);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(timer);
    };
  }, [fetch, paused, pollInterval, refreshKey]);

  return {
    tokens: snapshot?.tokens ?? [],
    sourceStats: snapshot?.sourceStats ?? {},
    totalCandidates: snapshot?.totalCandidates ?? 0,
    totalPassed: snapshot?.totalPassed ?? 0,
    loading,
    error,
    lastFetch,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}
