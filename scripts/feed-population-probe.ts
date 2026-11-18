/**
 * Feed population probe — replicates the EXACT fetchAggregatedSnapshot
 * pipeline (step for step, same helpers, same real sources) and then runs
 * the same engine tiers the Scanner feed renders, reporting whether the
 * LIVE ROUTE FEED populates this cycle. Real APIs only — nothing mocked,
 * nothing simulated.
 *
 * Usage: bun scripts/feed-population-probe.ts [chainKey]
 */
import {
  fetchMarketSnapshot,
  computeRoutes,
  discoverLoanAssets,
  DEFAULT_FEED_SETTINGS,
  CHAIN_INFO,
  type ChainKey,
  type FeedSettings,
  type MarketSnapshot,
} from "../src/lib/flashbolt.ts";
import { generateWBNBRoutes } from "../src/lib/route-generator.ts";
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
} from "../src/lib/market-sources.ts";

const chainKey = (process.argv[2] as ChainKey) || "bsc";
const chain = CHAIN_INFO[chainKey];
const quoteSymbol = chain.quoteSymbol;

// ── Step 1: DexScreener base snapshot (timed + health-tracked) ──
const t0 = Date.now();
const snapshot: MarketSnapshot = await fetchMarketSnapshot(chainKey);
const dexScreenerPairs = Object.values(snapshot.quotes).reduce(
  (n, perToken) => n + Object.keys(perToken).length,
  0,
);
const sourceHealth: Record<string, { pairs: number; ms: number; ok: boolean }> = {
  dexscreener: { pairs: dexScreenerPairs, ms: Date.now() - t0, ok: dexScreenerPairs > 0 },
};

// ── Step 2: all external sources in parallel, isolated + timed ──
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
  sourceDefs.map(async ({ name, run }) => {
    const started = Date.now();
    try {
      const pairs = await run();
      sourceHealth[name] = { pairs: pairs.length, ms: Date.now() - started, ok: true };
      return pairs;
    } catch {
      sourceHealth[name] = { pairs: 0, ms: Date.now() - started, ok: false };
      return [] as ExternalPair[];
    }
  }),
);

console.log("── per-source health (this cycle) ──");
for (const [name, h] of Object.entries(sourceHealth)) {
  const state = !h.ok ? "ERROR" : h.pairs > 0 ? "ok   " : "empty";
  console.log(`  ${state}  ${name.padEnd(16)} pairs=${String(h.pairs).padStart(4)}  ${h.ms}ms`);
}

// ── Step 3: poison-resistant merge + outlier sweep ──
const totalPairs = results.reduce((n, pairs) => n + pairs.length, 0);
mergeExternalPairs(snapshot, results.flat(), chain.dexes);
dropPriceOutliers(snapshot);

// ── Step 4: quote-asset USD recompute ──
const candidates: number[] = [];
for (const dexKey of Object.keys(snapshot.quotes)) {
  const q = snapshot.quotes[dexKey][quoteSymbol];
  if (q && q.usdPerToken > 0) candidates.push(q.usdPerToken);
}
if (candidates.length > 0) {
  candidates.sort((a, b) => a - b);
  snapshot.wbnbUsd = candidates[Math.floor(candidates.length / 2)];
}

// ── Step 5: loan-asset discovery on the ENRICHED snapshot (denomination
//    selector list — Gecko/Paprika venues count toward the ≥2-venue bar) ──
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

console.log("\n── enriched snapshot ──");
console.log(`  merged external pairs: ${totalPairs}`);
console.log(`  venues: ${Object.keys(snapshot.quotes).length} | tokens/venue:`,
  Object.fromEntries(Object.entries(snapshot.quotes).map(([k, v]) => [k, Object.keys(v).length])));
console.log(`  ${quoteSymbol} USD reference: $${snapshot.wbnbUsd?.toFixed(2)}`);
console.log(`  loan-asset selector list:`);
for (const a of snapshot.loanAssets ?? []) {
  console.log(`    ${a.symbol.padEnd(8)} venues=${a.venues}  depth=$${Math.round(a.liquidityUsd / 1000)}k`);
}

// ── Feed tiers exactly as the Scanner renders them ──
const persistedSettings: FeedSettings = {
  ...DEFAULT_FEED_SETTINGS,
  dexWhitelist: ["PCS", "BISWAP", "MDEX", "APESWAP", "BABYSWAP"],
  minProfit: 0.2,
};
const fullSettings: FeedSettings = {
  ...DEFAULT_FEED_SETTINGS,
  dexWhitelist: chain.dexes.map((d) => d.key),
  minProfit: 0.2,
};

for (const [label, settings] of [["persisted", persistedSettings], ["full-registry", fullSettings]] as const) {
  const live = computeRoutes(snapshot, settings, 1, 8, true, 0.1);
  const nearMiss = computeRoutes(snapshot, { ...settings, minProfit: 0 }, 1, 40, true, 0.1, true)
    .filter((r) => !live.some((l) => l.id === r.id))
    .slice(0, 25);
  const generated = generateWBNBRoutes(snapshot, settings, 1, 0.1, 120);
  console.log(`\n── feed tiers (${label} whitelist) ──`);
  console.log(`  live: ${live.length} | near-miss: ${nearMiss.length} | generated: ${generated.length} (profitable: ${generated.filter((r) => r.isProfitable).length})`);
  console.log(`  feed rows this cycle: ${live.length + nearMiss.length + generated.filter((r) => r.isProfitable).length}`);
  if (live.length > 0) {
    console.log("  live top:", live.slice(0, 3).map((r) => `${r.legs.join(">")} net ${r.profitPct.toFixed(3)}%`).join(" | "));
  }
  if (nearMiss.length > 0) {
    console.log("  near-miss top:", nearMiss.slice(0, 3).map((r) => `${r.legs.join(">")} bps ${r.spreadBps}`).join(" | "));
  }
}
