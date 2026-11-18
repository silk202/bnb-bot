import { describe, expect, test } from "bun:test";
import { flashRouteForSpread } from "../crosschain-route";
import { actionableForChain } from "../crosschain-spread";
import {
  DEFAULT_FEED_SETTINGS,
  gasCostBnb,
  isHoneyPot,
  netProfitAfterCosts,
  netProfitAfterGas,
  routeLabel,
} from "../flashbolt";
import type { CrossChainPair, CrossChainSpread } from "../crosschain-spread";

/**
 * Real DexScreener-shaped spread with LOCAL venue evidence: CAKE quoted on
 * BSC/PancakeSwap ($2.00), BSC/Biswap ($2.06) and Ethereum/Uniswap ($2.10) —
 * the exact shape detectCrossChainSpreads emits. No mocks: every downstream
 * guard below is the production function.
 */
function liveSpread(spreadPct: number): CrossChainSpread {
  const cheap = 2.0;
  const dear = cheap * (1 + spreadPct / 100);
  const pairs: CrossChainPair[] = [
    { chainId: "bsc", dexId: "pancakeswap", priceUsd: cheap, liquidityUsd: 1_000_000, volume24h: 5_000_000, pairCreatedAt: 0 },
    { chainId: "bsc", dexId: "biswap", priceUsd: cheap * 1.03, liquidityUsd: 900_000, volume24h: 3_000_000, pairCreatedAt: 0 },
    { chainId: "ethereum", dexId: "uniswap", priceUsd: dear, liquidityUsd: 800_000, volume24h: 4_000_000, pairCreatedAt: 0 },
  ];
  return {
    symbol: "CAKE",
    cheapChain: "bsc",
    cheapDex: "pancakeswap",
    cheapPriceUsd: cheap,
    dearChain: "ethereum",
    dearDex: "uniswap",
    dearPriceUsd: dear,
    spreadPct,
    pairs,
    liquidChains: ["bsc", "ethereum"],
    detectedAt: Date.now(),
  };
}

describe("cross-chain pipeline: spread → route → full guard stack", () => {
  test("actionableForChain selects spreads on the operator's chain only", () => {
    const spreads = [liveSpread(2.0), liveSpread(0.2)];
    const onBsc = actionableForChain(spreads, "bsc");
    expect(onBsc.length).toBe(2); // bsc is liquid on both
    const onPolygon = actionableForChain(spreads, "polygon");
    expect(onPolygon.length).toBe(0);
  });

  test("a passing spread survives EVERY guard the executor applies", () => {
    const spread = liveSpread(2.0); // 2% cross-chain edge
    const route = flashRouteForSpread(spread, "bsc", "Aave V3");

    // 1. Profitability floor (scanner gates auto-exec at the floor).
    const floor = DEFAULT_FEED_SETTINGS.minProfit;
    expect(route.profitPct >= floor).toBe(true);

    // 2. Always-on profit guard: net after the documented lender fee and
    //    slippage must stay positive.
    const netAfterCosts = netProfitAfterCosts(route, DEFAULT_FEED_SETTINGS.minProfit);
    expect(netAfterCosts).toBeGreaterThan(0);

    // 3. Net after gas at a REAL gas price (30 gwei BNB Chain) with the
    //    route's own loan size — the guard's exact computation.
    const netAfterGas = netProfitAfterGas(route, netAfterCosts, 30);
    expect(netAfterGas).toBeGreaterThan(0);

    // 4. MEV risk stays in the honest band for a registry-mapped venue pair.
    expect(route.mevRisk).toBeGreaterThanOrEqual(4);
    expect(route.mevRisk).toBeLessThanOrEqual(97);

    // 5. TTL within the engine's window.
    expect(route.ttlSeconds).toBeGreaterThanOrEqual(40);
    expect(route.ttlSeconds).toBeLessThanOrEqual(90);

    // 6. Route label renders the real executable path (both legs from the
    //    spread's own local-venue evidence).
    expect(routeLabel(route)).toBe("WBNB → PCS → CAKE → BISWAP → WBNB");
  });

  test("a sub-floor spread is auto-exec-gated OUT before execution", () => {
    const spread = liveSpread(0.05); // 0.05% — below the 0.1 default floor
    const route = flashRouteForSpread(spread, "bsc", "Aave V3");
    const floor = DEFAULT_FEED_SETTINGS.minProfit;
    expect(route.profitPct >= floor).toBe(false);
  });

  test("a thin spread is refused by the always-on profit guard (fee eats it)", () => {
    // 0.2% edge: above the floor but below the real lender fee + slippage.
    const route = flashRouteForSpread(liveSpread(0.2), "bsc", "PancakeSwap");
    const netAfterCosts = netProfitAfterCosts(route, DEFAULT_FEED_SETTINGS.minProfit);
    // PancakeSwap 0.25% fee + 0.1% slippage > 0.2% edge ⇒ refused.
    expect(netAfterCosts).toBeLessThanOrEqual(0);
  });

  test("gas reality check: high gas prices can still kill a small edge", () => {
    const route = flashRouteForSpread(liveSpread(0.5), "bsc", "Aave V3");
    const netAfterCosts = netProfitAfterCosts(route, DEFAULT_FEED_SETTINGS.minProfit);
    expect(netAfterCosts).toBeGreaterThan(0);
    // A 1 BNB loan at 500 gwei: gas pct of a 1-BNB loan is meaningful.
    const gasPctOfLoan = (gasCostBnb(500) / route.loanSizeBnb) * 100;
    const netAfterGas = netProfitAfterGas(route, netAfterCosts, 500);
    expect(netAfterGas).toBeCloseTo(netAfterCosts - gasPctOfLoan, 6);
  });

  test("a big deep-liquidity spread qualifies as a honey pot", () => {
    const spread = liveSpread(2.0);
    const route = flashRouteForSpread(spread, "bsc", "Aave V3");
    route.liquidityUsd = 150_000; // above the honey-pot liquidity floor
    expect(isHoneyPot(route, DEFAULT_FEED_SETTINGS.minProfit, 5_000)).toBe(true);
  });

  test("both execution legs stay inside the operator's DEX whitelist gate", () => {
    // The scanner only whitelists registry short codes; both adapter legs
    // must resolve to whitelisted venues for live execution to proceed.
    const route = flashRouteForSpread(liveSpread(2.0), "bsc", "Aave V3");
    const whitelist = ["PCS", "BISWAP", "MDEX", "APESWAP", "BABYSWAP"];
    for (const dex of route.dexes) {
      expect(whitelist.includes(dex)).toBe(true);
    }
  });

  test("spread evidence with a single local venue falls back to the mapped dear id", () => {
    // Only one local pair exists: sell leg falls back to the dear venue id
    // mapped through the local registry ("uniswap" stays raw on BSC).
    const s = liveSpread(1.5);
    s.pairs = s.pairs.filter((p) => p.dexId === "pancakeswap");
    const route = flashRouteForSpread(s, "bsc", "Aave V3");
    expect(route.dexes).toEqual(["PCS", "uniswap"]);
  });
});
