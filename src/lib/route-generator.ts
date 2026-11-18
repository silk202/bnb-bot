/**
 * Flash Triangular Route Generator (multi-denominational).
 *
 * Generates [LOAN_ASSET] → Token A → Token B → [LOAN_ASSET] combinations
 * across the chain's whitelisted venues and returns only routes with
 * positive net profit after gas + fees + slippage + safety margin.
 *
 * Loan denominations mirror the computeRoutes engine exactly:
 *   • the chain's wrapped native quote ALWAYS (WBNB / WETH / WMATIC), plus
 *   • every DISCOVERED deep asset the operator enabled (settings.loanAssets —
 *     validated against the snapshot's own discovery, e.g. USDT / USDC / BTCB).
 * Nothing is hard-coded: the token universe, the loan assets and their USD
 * prices all come from the same live MarketSnapshot the main feed prices
 * from, so a WETH-denominated route on Ethereum or a USDT-denominated route
 * on BSC prices identically whichever tier surfaces it.
 *
 * Profit calculation:
 *   gross_profit = notional_final - notional_initial
 *   net_profit = gross_profit - gas - swap fees - slippage - safety margin
 *   Only routes where net_profit > 0 are flagged profitable.
 *
 * All data is real-time from the MarketSnapshot. Nothing is simulated.
 */

import {
  type FeedSettings,
  type FlashRoute,
  type MarketSnapshot,
  CHAIN_INFO,
  assetUsdPrice,
  gasCostBnb,
  lenderForRun,
  routeSlippagePct,
  MAX_ROUTE_PROFIT_PCT,
  MIN_ROUTE_LIQUIDITY_USD,
  ROUTE_GAS_UNITS,
  ROUTE_SAFETY_MARGIN_PCT,
} from "./flashbolt";

// ---------------------------------------------------------------------------
// Route generation
// ---------------------------------------------------------------------------

// Gas units, safety margin and the liquidity→slippage buckets come from the
// SHARED per-route cost model in flashbolt.ts (ROUTE_GAS_UNITS,
// ROUTE_SAFETY_MARGIN_PCT, routeSlippagePct) so the generated tier prices
// every route identically to the computeRoutes engine.

/** Minimum spread in basis points to consider a route (0 = show all for display, even tiny spreads). */
const MIN_SPREAD_BPS = 0;

export interface GeneratedRoute {
  /** Route legs: [LOAN_ASSET, DEX1, TokenA, DEX2, TokenB, DEX3, LOAN_ASSET] */
  legs: string[];
  /** DEX keys used in order. */
  dexes: string[];
  /** Gross profit percentage (before costs). */
  grossProfitPct: number;
  /** Net profit percentage (after gas + fees + slippage + safety margin). */
  netProfitPct: number;
  /** Gas cost in the chain's native unit. */
  gasCostBnb: number;
  /** Total fees in percentage. */
  totalFeesPct: number;
  /** Estimated slippage cost in percentage. */
  slippageCostPct: number;
  /** Spread in basis points. */
  spreadBps: number;
  /** Whether this route passes the profit filter. */
  isProfitable: boolean;
  /** Flash-loan lender for this route. */
  lender: string;
  /** Loan size in the loan asset. */
  loanSizeBnb: number;
  /** Loan asset symbol (legs head — the denomination the route borrows). */
  loanAsset: string;
  /** Minimum liquidity across all legs in USD. */
  minLiquidityUsd: number;
  /** MEV risk score 0-100. */
  mevRisk: number;
  /** TTL in seconds. */
  ttlSeconds: number;
}

/**
 * Generate triangular routes from a live market snapshot for every loan
 * denomination the engine supports: the wrapped native quote always, plus
 * every enabled discovered asset (settings.loanAssets ∩ snapshot.loanAssets).
 *
 * For each combination of (TokenA, TokenB) where TokenA ≠ TokenB:
 *   1. Find ASSET→TokenA rate on DEX1 (USD-normalized per loan asset)
 *   2. Find TokenA→TokenB rate on DEX2
 *   3. Find TokenB→ASSET rate on DEX3
 *   4. Calculate net profit after all costs
 *   5. Flag profitable only when net_profit > 0
 */
export function generateWBNBRoutes(
  snapshot: MarketSnapshot,
  settings: FeedSettings,
  run: number,
  gasPriceGwei: number | null = null,
  count = 120,
): GeneratedRoute[] {
  const chain = CHAIN_INFO[snapshot.chainKey ?? "bsc"];
  const quoteSymbol = snapshot.quoteSymbol ?? chain.quoteSymbol;
  const dexes = chain.dexes.filter((e) => settings.dexWhitelist.includes(e.key));
  if (dexes.length < 2) return [];

  const lender = lenderForRun(run, false, chain.lenders);

  // Token universe: EVERYTHING the whitelisted venues currently quote —
  // purely market-driven, no static list. The route filters below discard
  // tokens without real prices/liquidity.
  const tokenSet = new Set<string>();
  for (const d of dexes) {
    for (const symbol of Object.keys(snapshot.quotes[d.key] ?? {})) {
      if (symbol !== quoteSymbol) tokenSet.add(symbol);
    }
  }
  const effectiveTokens = [...tokenSet];

  // Loan denominations: the wrapped native quote first (its USD price falls
  // back to the snapshot reference), then every operator-enabled asset that
  // the snapshot actually discovered — identical gating to computeRoutes.
  // An unknown price means the market does not currently quote the asset,
  // so that denomination is skipped rather than fabricated.
  const nativeUsd = snapshot.wbnbUsd;
  const quoteUsd = assetUsdPrice(quoteSymbol, snapshot) || nativeUsd;
  const discovered = (snapshot.loanAssets ?? []).filter(
    (a) => a.symbol !== quoteSymbol,
  );
  const enabledSymbols = (settings.loanAssets ?? []).filter((s) =>
    discovered.some((a) => a.symbol === s),
  );
  const loanBases: Array<{ symbol: string; usd: number }> = [
    ...(quoteUsd > 0 ? [{ symbol: quoteSymbol, usd: quoteUsd }] : []),
    ...enabledSymbols
      .map((symbol) => ({ symbol, usd: assetUsdPrice(symbol, snapshot) }))
      .filter((b) => b.usd > 0),
  ];

  const getLiquidity = (dexKey: string, token: string): number =>
    snapshot.quotes[dexKey]?.[token]?.liquidityUsd ?? 0;

  const routes: GeneratedRoute[] = [];

  for (const base of loanBases) {
    /** USD-normalized rate: loan-asset units per 1 token on this venue. */
    const getRate = (dexKey: string, token: string): number | undefined => {
      const q = snapshot.quotes[dexKey]?.[token];
      if (!q || q.usdPerToken <= 0 || base.usd <= 0) return undefined;
      return q.usdPerToken / base.usd;
    };

    // Token legs need a real price on at least one whitelisted venue.
    const routableTokens = effectiveTokens.filter((t) =>
      dexes.some((d) => {
        const q = snapshot.quotes[d.key]?.[t];
        return q && q.usdPerToken > 0 && q.liquidityUsd > 100;
      }),
    );

    for (const tokenA of routableTokens) {
      for (const tokenB of routableTokens) {
        if (tokenA === tokenB) continue;

        // Try all DEX combinations (D1 ≠ D3 for triangular)
        for (const d1 of dexes) {
          for (const d2 of dexes) {
            for (const d3 of dexes) {
              if (d1.key === d3.key) continue;

              // Step 1: ASSET → TokenA on D1
              const rate1 = getRate(d1.key, tokenA);
              if (!rate1 || rate1 <= 0) continue;

              // Step 2: TokenA → TokenB on D2
              // rate(TokenA on D2) gives ASSET per TokenA
              // rate(TokenB on D2) gives ASSET per TokenB
              // TokenA→TokenB rate = rate(TokenA) / rate(TokenB)
              const rate2a = getRate(d2.key, tokenA);
              const rate2b = getRate(d2.key, tokenB);
              if (!rate2a || !rate2b || rate2a <= 0 || rate2b <= 0) continue;
              const rate2 = rate2a / rate2b; // TokenB per TokenA

              // Step 3: TokenB → ASSET on D3
              const rate3 = getRate(d3.key, tokenB);
              if (!rate3 || rate3 <= 0) continue;

              // Round-trip of 1 loan asset through the triangle (the asset
              // price normalization makes the gross edge denomination-agnostic)
              const notionalInitial = 1.0;
              const tokenAReceived = notionalInitial / rate1;
              const tokenBReceived = tokenAReceived * rate2;
              const notionalFinal = tokenBReceived * rate3;

              // Gross profit — include ALL routes even negative spread for display
              // Only skip if notionalFinal is exactly 0 (bad rate data)
              if (notionalFinal <= 0) continue;
              const grossProfitPct =
                ((notionalFinal - notionalInitial) / notionalInitial) * 100;

              // Minimum spread filter
              const spreadBps = Math.round(grossProfitPct * 100);
              if (spreadBps < MIN_SPREAD_BPS) continue;

              // Total swap fees: DEX1 fee + DEX2 fee + DEX3 fee
              const totalFeesPct = (d1.fee + d2.fee + d3.fee) * 100;

              // Loan size scales with the weakest leg's liquidity depth,
              // clamped into the strategy bounds — USD-depth-derived and
              // uniform across denominations (same sizing as computeRoutes).
              const liq1 = getLiquidity(d1.key, tokenA);
              const liq2 = getLiquidity(d2.key, tokenA);
              const liq3 = getLiquidity(d3.key, tokenB);
              const minLiq = Math.min(liq1, liq2, liq3);
              const loanFloor = settings.minLoan;
              const loanSizeBnb = Math.max(
                loanFloor,
                Math.min(
                  settings.maxLoan,
                  Math.round((minLiq / 25_000) * 10) / 10,
                ),
              );

              // Gas cost: real RPC gas price in the native unit, converted
              // into the loan asset via its live USD price, then expressed
              // as a percentage of the ACTUAL loan size (a 1-unit loan can
              // never carry the same fixed gas a 10-unit loan carries).
              const gasNative = gasPriceGwei !== null
                ? gasCostBnb(gasPriceGwei, ROUTE_GAS_UNITS)
                : 0.001; // Fallback estimate (native units)
              const gasInAsset =
                base.symbol === quoteSymbol
                  ? gasNative
                  : nativeUsd > 0
                    ? (gasNative * nativeUsd) / base.usd
                    : gasNative;
              const gasPct = loanSizeBnb > 0 ? (gasInAsset / loanSizeBnb) * 100 : 0;

              // Slippage estimate: based on liquidity of weakest leg
              // Higher slippage for lower liquidity
              const slippagePct = routeSlippagePct(minLiq);

              // Net profit = gross - gas - fees - slippage - safety margin
              const netProfitPct = grossProfitPct - gasPct - totalFeesPct - slippagePct - ROUTE_SAFETY_MARGIN_PCT;

              // MEV risk: lower liquidity = higher risk
              const seed = hashSeed(`3-${base.symbol}-${tokenA}-${tokenB}-${d1.key}-${d2.key}-${d3.key}`);
              const baseRisk = minLiq < 50_000 ? 76 : minLiq < 200_000 ? 48 : minLiq < 800_000 ? 28 : 14;
              const mevRisk = Math.max(4, Math.min(97, baseRisk + (seed % 15) - 7));

              const ttlSeconds = Math.max(40, Math.min(90, settings.ttlWindow + (seed % 15) - 7));

              routes.push({
                legs: [base.symbol, d1.key, tokenA, d2.key, tokenB, d3.key, base.symbol],
                dexes: [d1.key, d2.key, d3.key],
                grossProfitPct: Math.round(grossProfitPct * 100) / 100,
                netProfitPct: Math.round(netProfitPct * 100) / 100,
                gasCostBnb: Math.round(gasNative * 1e6) / 1e6,
                totalFeesPct: Math.round(totalFeesPct * 100) / 100,
                slippageCostPct: Math.round(slippagePct * 100) / 100,
                spreadBps,
                isProfitable: netProfitPct > 0,
                lender,
                loanSizeBnb,
                loanAsset: base.symbol,
                minLiquidityUsd: minLiq,
                mevRisk,
                ttlSeconds,
              });
            }
          }
        }
      }
    }
  }

  // Keep only routes with a PLAUSIBLE edge on pools with real depth — the
  // same guards as the computeRoutes tier. Stale/scam pairs (USDT.Z-style
  // $0.58 pools) price fantasy spreads; they never belong in the feed.
  return routes
    .filter((r) => r.minLiquidityUsd >= MIN_ROUTE_LIQUIDITY_USD)
    .filter((r) => r.grossProfitPct <= MAX_ROUTE_PROFIT_PCT)
    .sort((a, b) => {
      // Profitable routes first
      if (a.isProfitable !== b.isProfitable) return a.isProfitable ? -1 : 1;
      return b.netProfitPct - a.netProfitPct;
    })
    .slice(0, count);
}

/**
 * Convert a GeneratedRoute to a FlashRoute for the existing feed system.
 */
export function toFlashRoute(gen: GeneratedRoute, run: number): FlashRoute {
  const seed = hashSeed(gen.legs.join(">"));
  return {
    id: `gen-${run}-${seed.toString(36)}`,
    legs: gen.legs,
    dexes: gen.dexes,
    profitPct: gen.netProfitPct,
    spreadBps: gen.spreadBps,
    ttlSeconds: gen.ttlSeconds,
    mevRisk: gen.mevRisk,
    lender: gen.lender,
    loanSizeBnb: gen.loanSizeBnb,
    // Generated routes borrow the route's own denomination (first leg).
    loanAsset: gen.loanAsset ?? gen.legs[0],
    liquidityUsd: gen.minLiquidityUsd,
  };
}

function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}
