/**
 * Convex action: multi-source aggregated market snapshot.
 *
 * Calls ALL data sources server-side (avoids CORS) and merges results
 * into a single MarketSnapshot that feeds the existing route computation.
 *
 * Sources: DexScreener + GeckoTerminal + DexPaprika + DEXTools + Dexview
 * + GMGN + Birdeye (fetchers live in ../lib/market-sources — pure and
 * probeable without the Convex runtime).
 *
 * Per-source health (real pair counts, real latency, HTTP failure flag) is
 * measured for every cycle and returned on the snapshot so the Scanner can
 * show exactly which sources are feeding the live route feed.
 *
 * Every value is real, live data — nothing is simulated or mocked.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  fetchMarketSnapshot,
  discoverLoanAssets,
  CHAIN_INFO,
  type ChainKey,
  type MarketSnapshot,
  type SourceHealth,
} from "../lib/flashbolt";
import {
  fetchGeckoTerminalPairs,
  fetchGeckoNewPoolPairs,
  fetchDexPaprikaPairs,
  fetchDexToolsPairs,
  fetchDexviewPairs,
  fetchGMGNPairs,
  fetchBirdeyePairs,
  mergeExternalPairs,
  dropPriceOutliers,
  type ExternalPair,
} from "../lib/market-sources";

/**
 * Fetch a MarketSnapshot aggregated from ALL data sources.
 * Runs server-side to avoid CORS. Accepts an optional chainKey to scan
 * any supported chain (bsc, ethereum, arbitrum, polygon).
 */
export const fetchAggregatedSnapshot = action({
  args: { chainKey: v.optional(v.string()) },
  handler: async (_ctx, args): Promise<MarketSnapshot> => {
    const chainKey: ChainKey = (args.chainKey as ChainKey) || "bsc";
    const chain = CHAIN_INFO[chainKey];
    const quoteSymbol = chain.quoteSymbol;

    // 1. Enhanced DexScreener-based snapshot (multi-fetch per DEX) — timed
    //    and health-tracked like every other source.
    const t0 = Date.now();
    const snapshot = await fetchMarketSnapshot(chainKey);
    const dexScreenerPairs = Object.values(snapshot.quotes).reduce(
      (n, perToken) => n + Object.keys(perToken).length,
      0,
    );
    const sourceHealth: Record<string, SourceHealth> = {
      dexscreener: { pairs: dexScreenerPairs, ms: Date.now() - t0, ok: dexScreenerPairs > 0 },
    };

    // 2. Fetch from ALL additional sources in parallel. Each source is
    //    isolated (one failure must never sink the snapshot) and timed so
    //    the health chips report real contribution, not guesses.
    const sourceDefs: Array<{ name: string; run: () => Promise<ExternalPair[]> }> = [
      // Gecko + Paprika use their own network ids ("eth", "polygon_pos", …)
      // — not DexScreener's — so the chain key is passed and mapped inside.
      { name: "geckoterminal", run: () => fetchGeckoTerminalPairs(quoteSymbol, chainKey) },
      { name: "gecko-new-pools", run: () => fetchGeckoNewPoolPairs(quoteSymbol, chainKey) },
      { name: "dexpaprika", run: () => fetchDexPaprikaPairs(quoteSymbol, chainKey) },
      { name: "dextools", run: () => fetchDexToolsPairs(quoteSymbol, chain.dexScreenerChainId) },
      { name: "dexview", run: () => fetchDexviewPairs(quoteSymbol, chain.chainId) },
      { name: "gmgn", run: () => fetchGMGNPairs(quoteSymbol, chain.dexScreenerChainId) },
      { name: "birdeye", run: () => fetchBirdeyePairs(quoteSymbol, chain.dexScreenerChainId) },
    ];
    const results = await Promise.all(
      sourceDefs.map(async ({ name, run }): Promise<{ name: string; pairs: ExternalPair[]; ms: number; ok: boolean }> => {
        const started = Date.now();
        try {
          const pairs = await run();
          sourceHealth[name] = { pairs: pairs.length, ms: Date.now() - started, ok: true };
          return { name, pairs, ms: Date.now() - started, ok: true };
        } catch {
          sourceHealth[name] = { pairs: 0, ms: Date.now() - started, ok: false };
          return { name, pairs: [], ms: Date.now() - started, ok: false };
        }
      }),
    );

    // 3. Merge (poison-resistant) — every source's real pairs feed the same
    //    snapshot, deepest quote per (venue, symbol) wins.
    const allPairs = results.flatMap((r) => r.pairs);
    mergeExternalPairs(snapshot, allPairs, chain.dexes);
    dropPriceOutliers(snapshot);

    // 4. Recompute quote-token USD from enriched data
    const candidates: number[] = [];
    for (const dexKey of Object.keys(snapshot.quotes)) {
      const q = snapshot.quotes[dexKey][quoteSymbol];
      if (q && q.usdPerToken > 0) candidates.push(q.usdPerToken);
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => a - b);
      snapshot.wbnbUsd = candidates[Math.floor(candidates.length / 2)];
    }

    // 5. Re-discover flash-loan assets from the ENRICHED snapshot. The merge
    //    above may have added deep wrapped-native pairs (USDT, USDC, BTCB, …)
    //    on venues DexScreener alone does not cover — so the discovery must
    //    run on the final quote data, not the pre-merge one. Nothing is
    //    hard-coded: every entry comes from live pool data (deepest-first,
    //    ≥2 venues, ≥ $250k depth). The wrapped native itself stays first.
    const quoteLiq = Math.max(...Object.values(snapshot.wbnbUsdByDex ?? {}), 0);
    snapshot.loanAssets = [
      {
        symbol: quoteSymbol,
        address: chain.quoteAddress.toLowerCase(),
        liquidityUsd: quoteLiq,
        venues: Object.keys(snapshot.wbnbUsdByDex ?? {}).length,
        venueKeys: Object.keys(snapshot.wbnbUsdByDex ?? {}),
      },
      ...discoverLoanAssets({
        quotes: snapshot.quotes,
        tokenAddresses: snapshot.tokenAddresses,
        quoteSymbol,
      }),
    ];

    // 6. Publish per-source health so the Scanner's chips show exactly
    //    which sources fed this cycle's live route feed.
    snapshot.sourceHealth = sourceHealth;

    return snapshot;
  },
});
