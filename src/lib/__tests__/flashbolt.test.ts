import { describe, expect, test } from "bun:test";
import {
  BALANCER_QUEUE,
  CHAIN_INFO,
  computeRoutes,
  DEFAULT_FEED_SETTINGS,
  EXECUTE_GAS_UNITS,
  FLASH_LENDERS,
  FLASH_LENDER_INFO,
  gasCostBnb,
  HONEY_POT_MIN_LIQUIDITY_USD,
  HONEY_POT_MIN_PROFIT_PCT,
  isHoneyPot,
  lenderFeeLabel,
  lenderFeePct,
  lenderForRun,
  netProfitAfterCosts,
  netProfitAfterGas,
  riskLevel,
  routeLabel,
  routePathAddresses,
  routeProfitBnb,
  type FlashRoute,
  type MarketSnapshot,
} from "../flashbolt";

// Real BNB Smart Chain token addresses.
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

describe("lenderForRun", () => {
  test("rotates through the real lender list every run", () => {
    expect(lenderForRun(0)).toBe(FLASH_LENDERS[0]);
    expect(lenderForRun(1)).toBe(FLASH_LENDERS[1]);
    expect(lenderForRun(FLASH_LENDERS.length - 1)).toBe(
      FLASH_LENDERS[FLASH_LENDERS.length - 1],
    );
    expect(lenderForRun(FLASH_LENDERS.length)).toBe(FLASH_LENDERS[0]);
  });

  test("handles negative run numbers without crashing", () => {
    expect(lenderForRun(-1)).toBe(FLASH_LENDERS[FLASH_LENDERS.length - 1]);
  });

  test("balanced mode rotates the fee-priority queue", () => {
    // Lowest-fee lender gets the doubled priority slot.
    expect(lenderForRun(0, true)).toBe("Aave V3");
    expect(lenderForRun(1, true)).toBe("Aave V3");
    // Then the next-lowest fee lenders in order.
    expect(lenderForRun(2, true)).toBe("Venus");
    expect(lenderForRun(3, true)).toBe("Radiant");
    expect(lenderForRun(4, true)).toBe("dForce");
    // Highest-fee lender comes last.
    expect(lenderForRun(5, true)).toBe("PancakeSwap");
    // Cycle wraps.
    expect(lenderForRun(6, true)).toBe("Aave V3");
  });
});

describe("documented lender fees (real protocol rates)", () => {
  test("every rotation lender has a documented fee above zero", () => {
    for (const lender of FLASH_LENDERS) {
      expect(lenderFeePct(lender)).toBeGreaterThan(0);
      expect(lenderFeeLabel(lender)).not.toBe("—");
    }
  });

  test("lowest documented fee is Aave V3 at 0.05%, PancakeSwap highest at 0.25%", () => {
    expect(lenderFeePct("Aave V3")).toBe(0.05);
    expect(lenderFeePct("PancakeSwap")).toBe(0.25);
  });

  test("balancer queue starts with the lowest-fee lender and covers everyone", () => {
    expect(BALANCER_QUEUE[0]).toBe("Aave V3");
    expect(BALANCER_QUEUE[1]).toBe("Aave V3");
    for (const lender of FLASH_LENDERS) {
      expect(BALANCER_QUEUE).toContain(lender);
    }
    expect(FLASH_LENDER_INFO.length).toBe(FLASH_LENDERS.length);
  });
});

describe("gas cost estimator (real RPC gas price)", () => {
  test("converts gwei into BNB at the documented gas units", () => {
    // 320k gas units * 5 gwei / 1e9 = 0.0016 BNB
    expect(gasCostBnb(5, EXECUTE_GAS_UNITS)).toBeCloseTo(0.0016, 6);
    // BNB mainnet today (~0.05 gwei): 0.000016 BNB
    expect(gasCostBnb(0.05, EXECUTE_GAS_UNITS)).toBeCloseTo(0.000016, 8);
  });

  test("never returns a negative cost for bad input", () => {
    expect(gasCostBnb(-3)).toBe(0);
    expect(gasCostBnb(Number.NaN)).toBe(0);
  });

  test("subtracts the BNB gas cost (as % of the loan) from the net", () => {
    const route: FlashRoute = {
      id: "route-gas",
      legs: ["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"],
      dexes: ["PCS", "BISWAP"],
      profitPct: 0.5,
      spreadBps: 60,
      ttlSeconds: 90,
      mevRisk: 10,
      lender: "Aave V3",
      loanSizeBnb: 1,
      loanAsset: "WBNB",
      liquidityUsd: 1_000_000,
    };
    // 0.0016 BNB gas on a 1 BNB loan = 0.16% of the loan.
    expect(netProfitAfterGas(route, 0.5, 5)).toBeCloseTo(0.34, 3);
    // On a 10 BNB loan the same gas is only 0.016%.
    expect(netProfitAfterGas({ ...route, loanSizeBnb: 10 }, 0.5, 5)).toBeCloseTo(
      0.484,
      3,
    );
  });
});

describe("netProfitAfterCosts (profit guard)", () => {
  const route: FlashRoute = {
    id: "route-guard",
    legs: ["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"],
    dexes: ["PCS", "BISWAP"],
    profitPct: 0.4,
    spreadBps: 60,
    ttlSeconds: 90,
    mevRisk: 10,
    lender: "Aave V3",
    loanSizeBnb: 1,
    loanAsset: "WBNB",
    liquidityUsd: 1_000_000,
  };

  test("subtracts the documented lender fee and slippage from the edge", () => {
    // 0.40% - 0.05% (Aave fee) - 0.50% slippage = -0.15%
    expect(netProfitAfterCosts(route, 0.5)).toBeCloseTo(-0.15, 3);
  });

  test("a strong edge stays positive after real costs", () => {
    expect(netProfitAfterCosts({ ...route, profitPct: 1.2 }, 0.5)).toBeCloseTo(
      1.2 - 0.05 - 0.5,
      3,
    );
  });
});

describe("isHoneyPot (high profit + high liquidity)", () => {
  const base: FlashRoute = {
    id: "route-honey",
    legs: ["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"],
    dexes: ["PCS", "BISWAP"],
    profitPct: 0.6,
    spreadBps: 80,
    ttlSeconds: 90,
    mevRisk: 10,
    lender: "Aave V3",
    loanSizeBnb: 1,
    loanAsset: "WBNB",
    liquidityUsd: 300_000,
  };

  test("qualifies only genuinely profitable + liquid routes", () => {
    expect(isHoneyPot(base)).toBe(true);
    expect(
      isHoneyPot({ ...base, profitPct: HONEY_POT_MIN_PROFIT_PCT - 0.01 }),
    ).toBe(false);
    expect(
      isHoneyPot({ ...base, liquidityUsd: HONEY_POT_MIN_LIQUIDITY_USD - 1 }),
    ).toBe(false);
    expect(
      isHoneyPot({
        ...base,
        profitPct: 2.5,
        liquidityUsd: 5_000_000,
      }),
    ).toBe(true);
  });
});

describe("riskLevel", () => {
  test("high at >=70, medium >=40, low below", () => {
    expect(riskLevel(70)).toBe("high");
    expect(riskLevel(97)).toBe("high");
    expect(riskLevel(69)).toBe("medium");
    expect(riskLevel(40)).toBe("medium");
    expect(riskLevel(39)).toBe("low");
    expect(riskLevel(0)).toBe("low");
  });
});

describe("routeProfitBnb / routeLabel", () => {
  const route: FlashRoute = {
    id: "route-0-test",
    legs: ["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"],
    dexes: ["PCS", "BISWAP"],
    profitPct: 4.53,
    spreadBps: 500,
    ttlSeconds: 90,
    mevRisk: 20,
    lender: "Aave V3",
    loanSizeBnb: 10,
    loanAsset: "WBNB",
    liquidityUsd: 1_000_000,
  };

  test("computes the expected BNB profit from real numbers", () => {
    expect(routeProfitBnb(route)).toBe(0.453);
  });

  test("labels a route by its legs", () => {
    expect(routeLabel(route)).toBe("WBNB → PCS → CAKE → BISWAP → WBNB");
  });
});

describe("routePathAddresses", () => {
  const snapshot: MarketSnapshot = {
    fetchedAt: 0,
    quotes: { PCS: {}, BISWAP: {}, MDEX: {}, APESWAP: {}, BABYSWAP: {} },
    tokenAddresses: {
      PCS: { CAKE },
      BISWAP: { USDT },
    },
    wbnbUsd: 600,
    wbnbUsdByDex: {},
  };

  test("resolves real token addresses into an executable path", () => {
    const route: FlashRoute = {
      id: "r",
      legs: ["WBNB", "PCS", "CAKE", "BISWAP", "USDT", "APESWAP", "WBNB"],
      dexes: ["PCS", "BISWAP", "APESWAP"],
      profitPct: 1,
      spreadBps: 100,
      ttlSeconds: 90,
      mevRisk: 10,
      lender: "Aave V3",
      loanSizeBnb: 1,
      loanAsset: "WBNB",
      liquidityUsd: 100_000,
    };
    expect(routePathAddresses(route, snapshot, WBNB)).toEqual([
      WBNB,
      CAKE,
      USDT,
      WBNB,
    ]);
  });

  test("returns null when a token address is missing from the live snapshot", () => {
    const route: FlashRoute = {
      id: "r2",
      legs: ["WBNB", "MDEX", "CAKE", "PCS", "WBNB"],
      dexes: ["MDEX", "PCS"],
      profitPct: 1,
      spreadBps: 100,
      ttlSeconds: 90,
      mevRisk: 10,
      lender: "Aave V3",
      loanSizeBnb: 1,
      loanAsset: "WBNB",
      liquidityUsd: 100_000,
    };
    expect(routePathAddresses(route, snapshot, WBNB)).toBeNull();
  });
});

describe("computeRoutes", () => {
  const snapshot: MarketSnapshot = {
    fetchedAt: 0,
    quotes: {
      PCS: {
        CAKE: { usdPerToken: 2.0, liquidityUsd: 1_000_000, volumeUsd: 5_000_000 },
      },
      BISWAP: {
        CAKE: { usdPerToken: 2.1, liquidityUsd: 1_000_000, volumeUsd: 3_000_000 },
      },
      MDEX: {},
      APESWAP: {},
      BABYSWAP: {},
    },
    tokenAddresses: { PCS: { CAKE }, BISWAP: { CAKE } },
    wbnbUsd: 600,
    wbnbUsdByDex: { PCS: 600, BISWAP: 600 },
  };

  test("detects the real cross-DEX CAKE triangle with a positive edge", () => {
    // Shipped defaults: min BNB loan 0.1, max 10 (the 5/10 strategy cap).
    const routes = computeRoutes(snapshot, DEFAULT_FEED_SETTINGS, 0);
    expect(routes.length).toBeGreaterThan(0);
    const top = routes[0];
    expect(top.legs).toEqual(["WBNB", "PCS", "CAKE", "BISWAP", "WBNB"]);
    expect(top.dexes).toEqual(["PCS", "BISWAP"]);
    // ALL-IN net: 4.53% venue-fee-net − 0.05% Aave flash fee − 0.05%
    // liquidity slippage − 0.01% gas (0.001 BNB fallback on a 10 BNB loan)
    // − 0.15% safety margin.
    expect(top.profitPct).toBeCloseTo(4.27, 2);
    expect(top.lender).toBe(lenderForRun(0));
    expect(top.loanSizeBnb).toBe(10);
    expect(top.mevRisk).toBeGreaterThanOrEqual(4);
    expect(top.mevRisk).toBeLessThanOrEqual(97);
    expect(top.liquidityUsd).toBe(1_000_000);
  });

  test("requires at least two whitelisted DEXs", () => {
    const routes = computeRoutes(
      snapshot,
      { ...DEFAULT_FEED_SETTINGS, dexWhitelist: ["PCS"] },
      0,
    );
    expect(routes).toEqual([]);
  });

  test("flat prices across DEXs produce no route", () => {
    const flat: MarketSnapshot = {
      ...snapshot,
      quotes: {
        PCS: {
          CAKE: { usdPerToken: 2.0, liquidityUsd: 1_000_000, volumeUsd: 5_000_000 },
        },
        BISWAP: {
          CAKE: { usdPerToken: 2.0, liquidityUsd: 1_000_000, volumeUsd: 3_000_000 },
        },
        MDEX: {},
        APESWAP: {},
        BABYSWAP: {},
      },
    };
    expect(computeRoutes(flat, DEFAULT_FEED_SETTINGS, 0)).toEqual([]);
  });

  test("loan size clamps into [minLoan, min(maxLoan, BNB_MAX_LOAN_CAP)]", () => {
    // Deep liquidity would size 10 BNB by depth — clamped at the 10 cap.
    const deep = computeRoutes(
      snapshot,
      { ...DEFAULT_FEED_SETTINGS, maxLoan: 10 },
      0,
    );
    expect(deep[0]!.loanSizeBnb).toBe(10);

    // Strategy max below the cap is respected.
    const capped = computeRoutes(
      snapshot,
      { ...DEFAULT_FEED_SETTINGS, maxLoan: 5 },
      0,
    );
    expect(capped[0]!.loanSizeBnb).toBe(5);

    // Shallow liquidity floors the loan at minLoan (0.1), never 0.
    const shallow: MarketSnapshot = {
      ...snapshot,
      quotes: {
        PCS: {
          CAKE: { usdPerToken: 2.0, liquidityUsd: 1_000, volumeUsd: 5_000 },
        },
        BISWAP: {
          CAKE: { usdPerToken: 2.1, liquidityUsd: 1_000, volumeUsd: 3_000 },
        },
        MDEX: {},
        APESWAP: {},
        BABYSWAP: {},
      },
    };
    const floored = computeRoutes(shallow, DEFAULT_FEED_SETTINGS, 0);
    expect(floored[0]!.loanSizeBnb).toBe(0.1);
  });

  test("enabled non-quote loan assets denominate routes (multi-asset flash loans)", () => {
    // A stable quote only on BISWAP — no WBNB-denominated spread exists
    // (prices are flat), but the USDT-denominated leg still prices.
    const withUsdt: MarketSnapshot = {
      ...snapshot,
      chainKey: "bsc",
      quoteSymbol: "WBNB",
      quotes: {
        PCS: {
          CAKE: { usdPerToken: 2.0, liquidityUsd: 1_000_000, volumeUsd: 5_000_000 },
          USDT: { usdPerToken: 1.0, liquidityUsd: 5_000_000, volumeUsd: 10_000_000 },
        },
        BISWAP: {
          CAKE: { usdPerToken: 2.1, liquidityUsd: 1_000_000, volumeUsd: 3_000_000 },
          USDT: { usdPerToken: 0.999, liquidityUsd: 5_000_000, volumeUsd: 9_000_000 },
        },
        MDEX: {},
        APESWAP: {},
        BABYSWAP: {},
      },
      loanAssets: [
        { symbol: "WBNB", address: WBNB, liquidityUsd: 1_000_000, venues: 5, venueKeys: ["PCS"] },
        { symbol: "USDT", address: USDT, liquidityUsd: 5_000_000, venues: 2, venueKeys: ["PCS", "BISWAP"] },
      ],
    };
    // loanAssets empty ⇒ native-only: every leg head is WBNB.
    const nativeOnly = computeRoutes(withUsdt, { ...DEFAULT_FEED_SETTINGS, loanAssets: [] }, 0);
    expect(nativeOnly.length).toBeGreaterThan(0);
    for (const r of nativeOnly) expect(r.legs[0]).toBe("WBNB");

    // Enabled USDT ⇒ USDT-denominated routes appear (and only symbols the
    // snapshot DISCOVERED can denominate — nothing fabricated).
    // 1 gwei (real BSC range): gas is priced per route, and the 0.001 BNB
    // fallback would put $0.60 of gas on a $10 stable loan (6% of notional)
    // — honestly starving every USDT-denominated route.
    const usdtRoutes = computeRoutes(
      withUsdt,
      { ...DEFAULT_FEED_SETTINGS, loanAssets: ["USDT"] },
      0,
      8,
      false,
      1,
    );
    expect(usdtRoutes.some((r) => r.legs[0] === "USDT" && r.legs[r.legs.length - 1] === "USDT")).toBe(true);

    // A symbol that was never discovered never denominates — silent ignore.
    const unknown = computeRoutes(
      withUsdt,
      { ...DEFAULT_FEED_SETTINGS, loanAssets: ["FAKECOIN"] },
      0,
    );
    for (const r of unknown) expect(r.legs[0]).toBe("WBNB");
  });

  test("loan sizing is uniform across denominations (no asset-price divisor)", () => {
    const deep = computeRoutes(
      snapshot,
      { ...DEFAULT_FEED_SETTINGS, maxLoan: 10, loanAssets: [] },
      0,
    );
    expect(deep[0]!.loanSizeBnb).toBe(10);
  });
});
