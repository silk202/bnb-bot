import { fetchMarketSnapshot } from "../src/lib/flashbolt.ts";

const snap = await fetchMarketSnapshot("bsc");
console.log("tokens per dex:", Object.fromEntries(Object.entries(snap.quotes).map(([k, v]) => [k, Object.keys(v).length])));

// Cross-dex overlap: same token quoted on 2+ venues with real depth
const overlap = [];
const allSymbols = new Set();
for (const dex of Object.keys(snap.quotes)) for (const s of Object.keys(snap.quotes[dex])) allSymbols.add(s);
for (const s of allSymbols) {
  const venues = Object.keys(snap.quotes).filter((d) => snap.quotes[d][s] && snap.quotes[d][s].liquidityUsd >= 1000);
  if (venues.length >= 2) {
    const rates = venues.map((d) => ({ d, r: snap.quotes[d][s].usdPerToken / (snap.wbnbUsdByDex[d] || snap.wbnbUsd), liq: snap.quotes[d][s].liquidityUsd }));
    const spread = ((Math.max(...rates.map((x) => x.r)) - Math.min(...rates.map((x) => x.r))) / Math.min(...rates.map((x) => x.r))) * 100;
    overlap.push({ s, spread: spread.toFixed(3), venues: rates.map((x) => `${x.d}(${x.liq.toFixed(0)})`) });
  }
}
console.log("real cross-venue overlaps (liq≥$1k):", overlap.length);
for (const o of overlap.slice(0, 10)) console.log("  ", o.s, "spread", o.spread + "%", o.venues.join(" "));
