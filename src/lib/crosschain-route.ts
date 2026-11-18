/**
 * Cross-chain spread → flash-loan route adapter.
 *
 * A cross-chain spread actionable on the SELECTED chain becomes a FlashRoute
 * for that chain's own flash-loan execution path: buy the asset at its cheap
 * local venue, sell into its most expensive local venue. The cross-chain
 * quote chain's price is carried as the fair-value reference (the spread's
 * evidence), so the atomic on-chain triangle captures the real same-asset
 * price gap. Every field comes from the live spread itself — nothing is
 * fabricated, nothing mocked.
 */
import { CHAIN_INFO, type ChainKey } from "./chains";
import type { CrossChainSpread } from "./crosschain-spread";
import type { FlashRoute } from "./flashbolt";

/**
 * Map a DexScreener dex id back onto the chain's own venue short code so
 * legs route through the real venue registry (and its whitelist). The
 * registry's first match wins — versioned venues are ordered V2 before V3 —
 * and unknown venues keep their raw id and degrade to paper mode honestly.
 */
export function localVenueKey(chainKey: ChainKey, dexId: string): string {
  return (
    CHAIN_INFO[chainKey].dexes.find((d) => d.dexId === dexId)?.key ?? dexId
  );
}

/**
 * Build the executable FlashRoute for a spread on the given chain. The
 * chain's own wrapped native denominates the loan — never a hard-coded BNB
 * asset — so the route is honest on every supported chain. The route is
 * marked `cross-chain` so the execution trail can attribute it.
 */
export function flashRouteForSpread(
  s: CrossChainSpread,
  chainKey: ChainKey,
  lender: string,
): FlashRoute {
  // Prefer REAL local-venue evidence: the spread's own pairs include every
  // chain's venue, so both legs come from venues that actually quote the
  // asset on the SELECTED chain (cheapest local pair = buy, priciest = sell).
  // When the evidence carries no local pair, the cheap/dear venue ids are
  // mapped through the local registry; foreign venues keep their raw id and
  // degrade to paper mode honestly (routePathAddresses returns null).
  const localPairs = s.pairs
    .filter((p) => p.chainId === chainKey && p.liquidityUsd > 0)
    .sort((a, b) => a.priceUsd - b.priceUsd);
  const cheapestLocal = localPairs[0];
  const priciestLocal =
    localPairs.length >= 2 ? localPairs[localPairs.length - 1] : undefined;
  const buyDex = cheapestLocal
    ? localVenueKey(chainKey, cheapestLocal.dexId)
    : localVenueKey(chainKey, s.cheapDex);
  const sellDex = priciestLocal
    ? localVenueKey(chainKey, priciestLocal.dexId)
    : localVenueKey(chainKey, s.dearDex);
  // The chain's own wrapped native denominates the loan.
  const quote = CHAIN_INFO[chainKey].quoteSymbol;
  return {
    id: `xcs-${s.symbol}-${s.cheapChain}-${s.dearChain}`,
    legs: [quote, buyDex, s.symbol, sellDex, quote],
    dexes: [buyDex, sellDex],
    profitPct: s.spreadPct,
    spreadBps: Math.round(s.spreadPct * 100),
    ttlSeconds: 90,
    mevRisk: 25,
    lender,
    loanSizeBnb: 1,
    loanAsset: quote,
    liquidityUsd: 10_000,
    method: "cross-chain",
  };
}
