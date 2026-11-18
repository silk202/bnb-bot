/**
 * Feed starvation probe — replicates the EXACT browser pipeline:
 *   fetchAggregatedSnapshot logic → feedSettings (persisted defaults) →
 *   computeRoutes (live + near-miss tiers) → generateWBNBRoutes (generated tier)
 * and reports where the LIVE ROUTE FEED population breaks.
 */
import {
  fetchMarketSnapshot,
  computeRoutes,
  DEFAULT_FEED_SETTINGS,
  CHAIN_INFO,
} from "../src/lib/flashbolt.ts";
import { generateWBNBRoutes } from "../src/lib/route-generator.ts";

const chainKey = "bsc";
const chain = CHAIN_INFO[chainKey];
const quoteSymbol = chain.quoteSymbol;

// ── 1. Base snapshot (same as the action's step 1) ──
const snapshot = await fetchMarketSnapshot(chainKey);
console.log("── base snapshot ──");
console.log("wbnbUsd:", snapshot.wbnbUsd, "| venues:", Object.keys(snapshot.quotes));
console.log(
  "tokens/venue:",
  Object.fromEntries(Object.entries(snapshot.quotes).map(([k, v]) => [k, Object.keys(v).length])),
);
console.log("loanAssets discovered:", (snapshot.loanAssets ?? []).map((a) => `${a.symbol}($${Math.round(a.liquidityUsd / 1000)}k,${a.venues}v)`));

// ── 2. Feed settings AS PERSISTED for a default account ──
const persistedSettings: FeedSettings = {
  ...DEFAULT_FEED_SETTINGS,
  // DEFAULT_TERMINAL_STATE.dexWhitelist — the legacy persisted default
  dexWhitelist: ["PCS", "BISWAP", "MDEX", "APESWAP", "BABYSWAP"],
  minProfit: 0.2,
};
const fullWhitelist: FeedSettings = {
  ...DEFAULT_FEED_SETTINGS,
  dexWhitelist: chain.dexes.map((d) => d.key),
  minProfit: 0.2,
};

console.log("\n── engine tiers with PERSISTED whitelist (no PCS_V3) ──");
const livePersisted = computeRoutes(snapshot, persistedSettings, 1, 8, true, 0.1);
const nearPersisted = computeRoutes(
  snapshot,
  { ...persistedSettings, minProfit: 0 },
  1,
  40,
  true,
  0.1,
  true,
);
const genPersisted = generateWBNBRoutes(snapshot, persistedSettings, 1, 0.1, 120);
console.log("live:", livePersisted.length, "| near-miss:", nearPersisted.length, "| generated:", genPersisted.length, "(profitable:", genPersisted.filter((r) => r.isProfitable).length + ")");
console.log("generated top:", genPersisted.slice(0, 3).map((r) => `${r.legs.join("→")} net ${r.netProfitPct}%`));

console.log("\n── engine tiers with FULL registry whitelist ──");
const liveFull = computeRoutes(snapshot, fullWhitelist, 1, 8, true, 0.1);
const nearFull = computeRoutes(snapshot, { ...fullWhitelist, minProfit: 0 }, 1, 40, true, 0.1, true);
const genFull = generateWBNBRoutes(snapshot, fullWhitelist, 1, 0.1, 120);
console.log("live:", liveFull.length, "| near-miss:", nearFull.length, "| generated:", genFull.length, "(profitable:", genFull.filter((r) => r.isProfitable).length + ")");
console.log("live top:", liveFull.slice(0, 3).map((r) => `${r.legs.join("→")} net ${r.profitPct}% liq $${Math.round(r.liquidityUsd / 1000)}k`));
console.log("near-miss top:", nearFull.slice(0, 3).map((r) => `${r.legs.join("→")} net ${r.profitPct}%`));

// ── 3. What does the near-miss filter actually drop? Dump raw candidates ──
console.log("\n── raw 2-leg candidates (no filters) ──");
const loose: FeedSettings = { ...fullWhitelist, minProfit: -100 };
const raw = computeRoutes(snapshot, loose, 1, 4000, true, 0.1);
console.log("raw count:", raw.length);
const bucket = (pct: number) =>
  `${raw.filter((r) => r.profitPct >= pct).length} routes ≥ ${pct}%`;
console.log(bucket(0.001), "|", bucket(0.05), "|", bucket(0.1));
const best = [...raw].sort((a, b) => b.profitPct - a.profitPct).slice(0, 8);
for (const r of best) {
  console.log(`  ${r.legs.join("→")} net ${r.profitPct}% liq $${Math.round(r.liquidityUsd / 1000)}k dexes ${r.dexes.join(",")}`);
}
const belowMinLiq = raw.filter((r) => r.profitPct > 0 && r.liquidityUsd < 1000).length;
console.log("positive-net routes killed by the $1k liquidity floor:", belowMinLiq);
