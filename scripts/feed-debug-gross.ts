/**
 * Debug: dump the raw 2-leg USDT/USDC gross round-trips across venues to
 * see why near-miss (spreadBps > 0) still starves.
 */
import { fetchMarketSnapshot, CHAIN_INFO } from "../src/lib/flashbolt.ts";

const snapshot = await fetchMarketSnapshot("bsc");
const chain = CHAIN_INFO.bsc;
const quoteSymbol = chain.quoteSymbol;

const venues = Object.keys(snapshot.quotes);
for (const symbol of ["USDT", "USDC", "CAKE", "ETH"]) {
  const rates = venues
    .map((d) => {
      const q = snapshot.quotes[d][symbol];
      if (!q || q.usdPerToken <= 0) return null;
      return { d, usd: q.usdPerToken, liq: Math.round(q.liquidityUsd) };
    })
    .filter((x): x is { d: string; usd: number; liq: number } => x !== null);
  if (rates.length < 2) {
    console.log(symbol, ": quoted on", rates.length, "venues — skip");
    continue;
  }
  console.log(`\n${symbol}:`);
  for (const r of rates) console.log(`   ${r.d.padEnd(8)} $${r.usd.toPrecision(8)}  liq $${r.liq}`);
  // Raw round-trips, no normalization (both legs same asset => ratios cancel)
  const trips: Array<{ pair: string; gross: number; minLiq: number }> = [];
  for (const a of rates) {
    for (const b of rates) {
      if (a.d === b.d) continue;
      const gross = a.usd / b.usd; // buy on a (cheap), sell on b (dear)
      trips.push({ pair: `${a.d}→${b.d}`, gross, minLiq: Math.min(a.liq, b.liq) });
    }
  }
  trips.sort((x, y) => y.gross - x.gross);
  for (const t of trips.slice(0, 4)) {
    console.log(`   ${t.pair}  gross ${(t.gross * 100).toFixed(4)}%  bps ${Math.round((t.gross - 1) * 10000)}  minLiq $${t.minLiq}`);
  }
  // Now with the engine's normalization (rate = usdPerToken / wbnbUsd) —
  // identical ratios, but let's verify against the engine's per-dex quote price.
  const wbnbUsd = snapshot.wbnbUsd;
  const engRates = rates.map((r) => ({ d: r.d, r: r.usd / wbnbUsd }));
  const engTrips = engRates.flatMap((a) =>
    engRates.filter((b) => b.d !== a.d).map((b) => ({ pair: `${a.d}→${b.d}`, gross: (1 / a.r) * b.r })),
  );
  engTrips.sort((x, y) => y.gross - x.gross);
  console.log("   engine-normalized top:", engTrips.slice(0, 2).map((t) => `${t.pair} ${(t.gross * 100).toFixed(4)}%`));
}
console.log("\nwbnbUsd:", snapshot.wbnbUsd, "wbnbUsdByDex:", snapshot.wbnbUsdByDex);
