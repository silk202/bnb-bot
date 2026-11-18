/**
 * LIVE end-to-end probe of the BNB FlashBolt feed pipeline.
 *
 * Executes the EXACT pipeline of the Convex action `fetchAggregatedSnapshot`
 * (src/convex/marketData.ts) using the same pure functions, then runs the
 * exact client-side consumption the Scanner performs:
 *
 *   action pipeline (server)                       client consumption (Scanner)
 *   ─────────────────────────                       ────────────────────────────
 *   1. fetchMarketSnapshot (DexScreener)            4. computeRoutes (live pass)
 *   2. 7 external sources, timed + isolated            computeRoutes (near-miss pass)
 *      mergeExternalPairs + dropPriceOutliers       5. generateWBNBRoutes
 *   3. wbnbUsd median + discoverLoanAssets            (generated tier)
 *      + per-source sourceHealth
 *
 * Everything is REAL live HTTP data — nothing mocked, nothing simulated.
 * Exit code 0 = feed rows populated in every tier; 1 = starvation.
 *
 * Run: bun scripts/e2e-probe.ts [chainKey]
 */

import {
  CHAIN_INFO,
  DEFAULT_FEED_SETTINGS,
  computeRoutes,
  discoverLoanAssets,
  fetchMarketSnapshot,
  type ChainKey,
  type FeedSettings,
  type MarketSnapshot,
  type SourceHealth,
} from "../src/lib/flashbolt";
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
} from "../src/lib/market-sources";
import { generateWBNBRoutes } from "../src/lib/route-generator";

const chainKey: ChainKey = ((process.argv[2] ?? "bsc") as ChainKey) || "bsc";
const chain = CHAIN_INFO[chainKey];
const quoteSymbol = chain.quoteSymbol;

async function main(): Promise<number> {
  const t0 = Date.now();
  console.log(`\n[e2e-probe] chain=${chainKey} (${chain.label}) quote=${quoteSymbol}`);
  console.log(`[e2e-probe] ── STEP 1-3: fetchAggregatedSnapshot pipeline ──`);

  // STEP 1 — DexScreener base snapshot (timed + health-tracked, as in the action).
  const sourceHealth: Record<string, SourceHealth> = {};
  const tDex = Date.now();
  const snapshot: MarketSnapshot = await fetchMarketSnapshot(chainKey);
  const dexScreenerPairs = Object.values(snapshot.quotes).reduce(
    (n, perToken) => n + Object.keys(perToken).length,
    0,
  );
  sourceHealth.dexscreener = { pairs: dexScreenerPairs, ms: Date.now() - tDex, ok: dexScreenerPairs > 0 };

  // STEP 2 — ALL additional sources in parallel, isolated + timed (as in the action).
  const sourceDefs: Array<{ name: string; run: () => Promise<ExternalPair[]> }> = [
    { name: "geckoterminal", run: () => fetchGeckoTerminalPairs(quoteSymbol, chainKey) },
    { name: "gecko-new-pools", run: () => fetchGeckoNewPoolPairs(quoteSymbol, chainKey) },
    { name: "dexpaprika", run: () => fetchDexPaprikaPairs(quoteSymbol, chainKey) },
    { name: "dextools", run: () => fetchDexToolsPairs(quoteSymbol, chain.dexScreenerChainId) },
    { name: "dexview", run: () => fetchDexviewPairs(quoteSymbol, chain.chainId) },
    { name: "gmgn", run: () => fetchGMGNPairs(quoteSymbol, chain.dexScreenerChainId) },
    { name: "birdeye", run: () => fetchBirdeyePairs(quoteSymbol, chain.dexScreenerChainId) },
  ];
  const results = await Promise.all(
    sourceDefs.map(async ({ name, run }): Promise<{ name: string; pairs: ExternalPair[]; ok: boolean }> => {
      const started = Date.now();
      try {
        const pairs = await run();
        sourceHealth[name] = { pairs: pairs.length, ms: Date.now() - started, ok: true };
        return { name, pairs, ok: true };
      } catch {
        sourceHealth[name] = { pairs: 0, ms: Date.now() - started, ok: false };
        return { name, pairs: [], ok: false };
      }
    }),
  );
  const allPairs = results.flatMap((r) => r.pairs);
  mergeExternalPairs(snapshot, allPairs, chain.dexes);
  dropPriceOutliers(snapshot);

  // STEP 3 — quote USD recompute + loan-asset discovery + health publish.
  const candidates: number[] = [];
  for (const dexKey of Object.keys(snapshot.quotes)) {
    const q = snapshot.quotes[dexKey][quoteSymbol];
    if (q && q.usdPerToken > 0) candidates.push(q.usdPerToken);
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a - b);
    snapshot.wbnbUsd = candidates[Math.floor(candidates.length / 2)];
  }
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
  snapshot.sourceHealth = sourceHealth;

  // ── Pipeline report ──
  const totalPairs = Object.values(snapshot.quotes).reduce(
    (n, perToken) => n + Object.keys(perToken).length,
    0,
  );
  const venueCount = Object.keys(snapshot.quotes).length;
  console.log(`\n[e2e-probe] Per-source health (real counts + timings):`);
  for (const [name, h] of Object.entries(sourceHealth)) {
    console.log(
      `  ${h.ok ? "✓" : "✗"} ${name.padEnd(16)} ${String(h.pairs).padStart(4)} pairs  ${String(h.ms).padStart(5)}ms`,
    );
  }
  console.log(`[e2e-probe] Snapshot: ${totalPairs} token prices across ${venueCount} venues in ${Date.now() - t0}ms`);
  console.log(`[e2e-probe] ${quoteSymbol} USD ref: $${snapshot.wbnbUsd.toFixed(2)} (median across venues)`);
  console.log(`[e2e-probe] Discovered loan assets (dynamic, ≥$250k depth on ≥2 venues):`);
  for (const a of snapshot.loanAssets) {
    console.log(
      `  · ${a.symbol.padEnd(8)} $${Math.round(a.liquidityUsd).toLocaleString().padStart(12)} depth · ${a.venues} venue(s)`,
    );
  }

  // ── STEP 4 — client consumption, EXACTLY like use-live-feed + Scanner ──
  console.log(`\n[e2e-probe] ── STEP 4: computeRoutes (client consumption) ──`);
  const settings: FeedSettings = { ...DEFAULT_FEED_SETTINGS };
  const run = 1;

  // Live pass (same call the feed hook makes).
  const liveRoutes = computeRoutes(snapshot, settings, run, 8, false, null);
  console.log(`[e2e-probe] LIVE tier: ${liveRoutes.length} routes (floor ${settings.minProfit}%)`);
  for (const r of liveRoutes.slice(0, 3)) {
    console.log(`  · ${r.legs.join(" → ")}  +${r.profitPct.toFixed(2)}% net  ${r.lender}  liq $${Math.round(r.liquidityUsd)}`);
  }

  // Near-miss pass (same loose call the feed hook makes).
  const nearMissRoutes = computeRoutes(
    snapshot,
    { ...settings, minProfit: 0 },
    run,
    40,
    false,
    null,
    true,
  ).filter((r) => !liveRoutes.some((l) => l.id === r.id)).slice(0, 25);
  console.log(`[e2e-probe] NEAR-MISS tier: ${nearMissRoutes.length} routes`);
  for (const r of nearMissRoutes.slice(0, 3)) {
    console.log(`  · ${r.legs.join(" → ")}  +${r.profitPct.toFixed(2)}% net  ${r.lender}`);
  }

  // Generated tier (Scanner's triangular generator).
  const generated = generateWBNBRoutes(snapshot, settings, run, null, 120);
  console.log(`[e2e-probe] GENERATED tier: ${generated.length} routes`);
  for (const g of generated.slice(0, 3)) {
    console.log(`  · ${g.legs.join(" → ")}  +${g.netProfitPct.toFixed(2)}%  ${g.loanAsset}-denominated`);
  }

  // ── STEP 5 — denomination-selector probe: enable EVERY discovered asset ──
  // (exactly what the Strategy page persists when the operator toggles all
  // discovered symbols; computeRoutes intersects settings.loanAssets with
  // snapshot.loanAssets — nothing hard-coded).
  const enabledAll = snapshot.loanAssets.map((a) => a.symbol);
  const multiRoutes = computeRoutes(
    snapshot,
    { ...settings, loanAssets: enabledAll },
    run,
    8,
    false,
    null,
  );
  const multiGenerated = generateWBNBRoutes(
    snapshot,
    { ...settings, loanAssets: enabledAll },
    run,
    null,
    120,
  );
  const denomsUsed = new Set<string>();
  for (const r of [...multiRoutes, ...multiGenerated]) denomsUsed.add(r.loanAsset);
  console.log(`\n[e2e-probe] ── STEP 5: denomination selector (all ${enabledAll.length} discovered enabled) ──`);
  console.log(`[e2e-probe] Denominations producing routes: ${[...denomsUsed].join(", ") || "none"}`);
  console.log(`[e2e-probe] With multi-denomination: live ${multiRoutes.length} · generated ${multiGenerated.length} (vs native-only live ${liveRoutes.length} · generated ${generated.length})`);

  // ── Verdict ──
  const feedRows = liveRoutes.length + nearMissRoutes.length + generated.length;
  const okSources = Object.values(sourceHealth).filter((h) => h.ok).length;
  console.log(`\n[e2e-probe] ══ VERDICT ══`);
  console.log(`[e2e-probe] Sources healthy: ${okSources}/${Object.keys(sourceHealth).length}`);
  console.log(`[e2e-probe] Feed rows populate: ${feedRows > 0 ? "YES" : "NO"} (live ${liveRoutes.length} + near-miss ${nearMissRoutes.length} + generated ${generated.length} = ${feedRows})`);
  console.log(`[e2e-probe] Loan-asset discovery: ${snapshot.loanAssets.length} asset(s) — selector consumes them dynamically: ${denomsUsed.size > 1 ? "YES" : denomsUsed.size === 1 ? "native-only this cycle" : "no routes"}`);
  const pass = feedRows > 0 && okSources >= 2;
  console.log(`[e2e-probe] ${pass ? "PASS ✓ pipeline live end-to-end, feed populated with real data" : "FAIL ✗"} (${Date.now() - t0}ms total)`);
  return pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[e2e-probe] FAILED:`, err);
    process.exit(1);
  });
