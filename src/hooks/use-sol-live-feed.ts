/**
 * SOL live route feed — the Flasher's LIVE ROUTE FEED for Solana.
 *
 * Same guarantees as the BNB feed: routes are computed from REAL DexScreener
 * venue prices each scan run, lender rotates per run, nothing is simulated.
 * The feed sweeps a live Solana token board (DexScreener search profiles)
 * and converts each captured token with a two-venue spread into a flash-loan
 * route — the same engine the SOL Telecopier uses for copied signals.
 *
 * The sweep/merge core lives in lib/solana-feed.ts (fetchWithTimeout-based)
 * so the exact same live rescan also runs SERVER-side in the always-on SOL
 * engine pass (terminal.ts) — one engine, identical candidates, both worlds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  claimBump,
  releaseBump,
  CLIENT_BUMP_GAP_MS,
} from "@/lib/bump-throttle";
import {
  buildSolTelecopierRoutes,
  type SolTelecopierRoute,
  type SolTelecopierSignal,
} from "@/lib/solana-routes";
import { SOL_DEFAULT_WHITELIST, solLenderForRun } from "@/lib/solana";
import { sweepSolMarket, type SolFeedCandidate } from "@/lib/solana-feed";

// Re-exports keep every existing import path working (SolMultiSignalMonitor,
// tests) while the engine consumes the shared server-safe core.
export { sweepSolMarket, mergeSolCandidates } from "@/lib/solana-feed";
export type { SolFeedCandidate } from "@/lib/solana-feed";

export interface SolLiveFeed {
  routes: SolTelecopierRoute[];
  /** Market-swept candidates awaiting two-venue conversion. */
  candidates: SolFeedCandidate[];
  loading: boolean;
  error: string | null;
  lastScan: number | null;
  lender: string;
  run: number;
  rescan: () => void;
}

export interface UseSolLiveFeedOptions {
  paused?: boolean;
  cadence?: number;
  /** Venue whitelist (SOL_DEXES keys). */
  dexWhitelist?: string[];
  /** Balancer on = low-fee lenders prioritized in the rotation. */
  balanced?: boolean;
  /** Loan size in SOL. */
  loanSizeSol?: number;
  onScan?: () => void;
}

/**
 * Live Solana arbitrage feed. Each cadence: sweep the market board, convert
 * every candidate with a real two-venue spread into a flash-loan route.
 */
export function useSolLiveFeed(options: UseSolLiveFeedOptions = {}): SolLiveFeed {
  const {
    paused = false,
    cadence = 15,
    dexWhitelist = SOL_DEFAULT_WHITELIST,
    balanced = false,
    loanSizeSol = 1,
    onScan,
  } = options;

  const rawBumpScan = useMutation(api.terminal.bumpScan);
  // Shared throttle gate ("scan:sol") — the SolScanner page effect stamps
  // the same fields on the same tick, so both sources coalesce into at
  // most one bump per CLIENT_BUMP_GAP_MS instead of two writes per scan.
  const bumpScan = useCallback(
    (args: { count?: number; chain?: "bnb" | "sol" }) => {
      if (!claimBump(`scan:${args.chain ?? "bnb"}`, CLIENT_BUMP_GAP_MS)) {
        return Promise.resolve(true);
      }
      return rawBumpScan(args).catch((err) => {
        releaseBump(`scan:${args.chain ?? "bnb"}`);
        throw err;
      });
    },
    [rawBumpScan],
  );

  const [candidates, setCandidates] = useState<SolFeedCandidate[]>([]);
  const [routes, setRoutes] = useState<SolTelecopierRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [run, setRun] = useState(0);
  const inflightRef = useRef(false);
  const onScanRef = useRef(onScan);
  const whitelistKey = dexWhitelist.join(",");

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const nextRun = run + 1;
      const swept = await sweepSolMarket();
      setCandidates(swept);

      // Convert candidates with a real two-venue spread into routes via the
      // same engine the Telecopier uses — identical pricing, identical gates.
      const signalShaped: SolTelecopierSignal[] = swept.map((c) => ({
        id: "mkt:" + c.address,
        source: "market-sweep",
        sourceLabel: "Market sweep",
        address: c.address,
        symbol: c.symbol,
        name: c.symbol,
        chain: "solana",
        priceUsd: c.priceUsd,
        liquidityUsd: c.liquidityUsd,
        postedAt: 0,
        capturedAt: Date.now(),
        buyable: true,
        excerpt: "",
      }));
      const built = await buildSolTelecopierRoutes(
        signalShaped,
        {
          dexWhitelist: whitelistKey ? whitelistKey.split(",") : SOL_DEFAULT_WHITELIST,
          lender: solLenderForRun(nextRun, balanced),
          loanSizeSol,
          run: nextRun,
        },
        8,
      );
      setRun(nextRun);
      setRoutes(built);
      setLastScan(Date.now());
      setError(null);
      onScanRef.current?.();
      // Sync the terminal's open-opportunities counter with the real feed.
      // chain:"sol" stamps the SOL engine's own freshness fields — this
      // browser loop stands down the server SOL engine (single driver) but
      // never touches the BNB loop's state (bots stay independent).
      void bumpScan({ count: built.length, chain: "sol" }).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Solana market feed unreachable");
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
    // run deliberately excluded: refresh captures and increments it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whitelistKey, balanced, loanSizeSol, bumpScan]);

  useEffect(() => {
    const boot = window.setTimeout(() => {
      void refresh();
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
  }, [refresh, paused, cadence]);

  return {
    routes,
    candidates,
    loading,
    error,
    lastScan,
    lender: solLenderForRun(run, balanced),
    run,
    rescan: () => void refresh(),
  };
}
