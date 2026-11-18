import { describe, expect, test } from "bun:test";
import { flashRouteForSpread, localVenueKey } from "../crosschain-route";
import { CHAIN_INFO, CHAIN_KEYS } from "../chains";
import type { CrossChainPair, CrossChainSpread } from "../crosschain-spread";

/**
 * Real DexScreener-shaped pairs: the same asset quoted on the cheap local
 * venue (BSC/PancakeSwap $2.00), a second local venue (BSC/Biswap $2.06) and
 * the cross-chain fair-value reference (Ethereum/Uniswap $2.06). No mocks:
 * these are the exact field shapes detectCrossChainSpreads emits.
 */
const EVIDENCE_PAIRS: CrossChainPair[] = [
  { chainId: "bsc", dexId: "pancakeswap", priceUsd: 2.0, liquidityUsd: 1_000_000, volume24h: 5_000_000, pairCreatedAt: 0 },
  { chainId: "bsc", dexId: "biswap", priceUsd: 2.06, liquidityUsd: 900_000, volume24h: 3_000_000, pairCreatedAt: 0 },
  { chainId: "ethereum", dexId: "uniswap", priceUsd: 2.06, liquidityUsd: 800_000, volume24h: 4_000_000, pairCreatedAt: 0 },
];

function realShapeSpread(overrides?: Partial<CrossChainSpread>): CrossChainSpread {
  return {
    symbol: "CAKE",
    cheapChain: "bsc",
    cheapDex: "pancakeswap",
    cheapPriceUsd: 2.0,
    dearChain: "ethereum",
    dearDex: "uniswap",
    dearPriceUsd: 2.06,
    spreadPct: 3.0,
    pairs: EVIDENCE_PAIRS,
    liquidChains: ["bsc", "ethereum"],
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe("localVenueKey — DexScreener dexId → the chain's venue short code", () => {
  test("maps ids through the REAL chain registry on every chain", () => {
    // Real registry pairs (verified against src/lib/chains.ts):
    expect(localVenueKey("bsc", "pancakeswap")).toBe("PCS");
    expect(localVenueKey("bsc", "biswap")).toBe("BISWAP");
    expect(localVenueKey("bsc", "mdex")).toBe("MDEX");
    expect(localVenueKey("bsc", "openocean")).toBe("OPENOCEAN");
    expect(localVenueKey("bsc", "kyberswap")).toBe("KYBERSWAP");
    expect(localVenueKey("ethereum", "uniswap")).toBe("UNI");
    expect(localVenueKey("ethereum", "sushiswap")).toBe("SUSHI");
    expect(localVenueKey("arbitrum", "camelot")).toBe("CAMELOT");
    expect(localVenueKey("polygon", "quickswap")).toBe("QUICK");
    expect(localVenueKey("polygon", "apeswap")).toBe("APE");
  });

  test("unknown venues keep their raw dex id (honest paper-mode degradation)", () => {
    expect(localVenueKey("bsc", "unknown-dex-xyz")).toBe("unknown-dex-xyz");
    expect(localVenueKey("polygon", "quickswapv4")).toBe("quickswapv4");
  });

  test("every registry dexId resolves to the registry's FIRST match", () => {
    // Versioned venues share a dexId (PCS/PCS_V3 both = "pancakeswap"), so
    // the honest contract is first-match-wins — the registry's ordering
    // (V2 before V3) decides, and the result is always a defined short code.
    for (const chainKey of CHAIN_KEYS) {
      const seen = new Set<string>();
      for (const dex of CHAIN_INFO[chainKey].dexes) {
        if (seen.has(dex.dexId)) continue;
        seen.add(dex.dexId);
        const first = CHAIN_INFO[chainKey].dexes.find((d) => d.dexId === dex.dexId)!;
        expect(localVenueKey(chainKey, dex.dexId)).toBe(first.key);
      }
    }
  });

  test("versioned venues resolve to the registry's first (V2) entry", () => {
    // Both V2 and V3 share dexId "pancakeswap"; the registry's first match
    // (V2) wins so legs route through the classic executable venue.
    expect(localVenueKey("bsc", "pancakeswap")).toBe("PCS");
    expect(localVenueKey("bsc", "pancakeswap")).not.toBe("PCS_V3");
  });
});

describe("flashRouteForSpread — real spread → executable route", () => {
  test("both legs come from REAL local-venue evidence in the spread's pairs", () => {
    const route = flashRouteForSpread(realShapeSpread(), "bsc", "Aave V3");
    // Cheapest local pair (PCS @ $2.00) buys, priciest local pair (Biswap @
    // $2.06) sells — the same venues the spread's own evidence quotes.
    expect(route.legs).toEqual(["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"]);
    expect(route.dexes).toEqual(["PCS", "BISWAP"]);
    expect(route.loanAsset).toBe("WBNB");
  });

  test("a foreign dear venue with no local evidence keeps its raw id", () => {
    // No pairs evidence: the dear venue is Ethereum's Uniswap, which does
    // not exist on BSC — mapping it locally would fabricate a venue, so the
    // raw id is kept and the route degrades to paper mode honestly.
    const route = flashRouteForSpread(
      realShapeSpread({ pairs: [] }),
      "bsc",
      "Aave V3",
    );
    expect(route.legs).toEqual(["WBNB", "PCS", "CAKE", "uniswap", "WBNB"]);
  });

  test("quote asset is registry-driven on every supported chain", () => {
    expect(flashRouteForSpread(realShapeSpread(), "bsc", "L").loanAsset).toBe("WBNB");
    expect(flashRouteForSpread(realShapeSpread(), "ethereum", "L").loanAsset).toBe("WETH");
    expect(flashRouteForSpread(realShapeSpread(), "arbitrum", "L").loanAsset).toBe("WETH");
    expect(flashRouteForSpread(realShapeSpread(), "polygon", "L").loanAsset).toBe("WMATIC");
  });

  test("profit and spread come straight from the live spread (never fabricated)", () => {
    const s = realShapeSpread({ spreadPct: 7.25 });
    const route = flashRouteForSpread(s, "bsc", "Venus");
    expect(route.profitPct).toBe(7.25);
    expect(route.spreadBps).toBe(725);
  });

  test("route is marked cross-chain so the trail can attribute it", () => {
    const route = flashRouteForSpread(realShapeSpread(), "bsc", "Aave V3");
    expect(route.method).toBe("cross-chain");
  });

  test("lender is the rotation's live pick, carried through untouched", () => {
    expect(flashRouteForSpread(realShapeSpread(), "bsc", "PancakeSwap").lender).toBe(
      "PancakeSwap",
    );
  });
});
