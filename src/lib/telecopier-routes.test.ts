/**
 * Telecopier route-builder tests — real parsing/pricing behavior of the
 * signal → cross-venue flash-loan route engine: DexScreener pair fetch,
 * whitelisted-venue filtering, spread computation and route emission.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildTelecopierRoute,
  buildTelecopierRoutes,
  fetchTokenPairs,
} from "./telecopier-routes";

const ADDR = "0x" + "c".repeat(40);

/** Minimal copier-signal row (same shape the copierStore returns). */
function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    source: "t.me/AveSignalMonitor",
    sourceLabel: "AveSignalMonitor",
    address: ADDR,
    symbol: "PEPE",
    name: "Pepe",
    chain: "bsc",
    priceUsd: 0.00001,
    liquidityUsd: 35000,
    postedAt: 1700000000000,
    capturedAt: 1700000000000,
    buyable: true,
    excerpt: "New gem $PEPE on BSC! CA: 0x…",
    ...overrides,
  };
}

/** Minimal DexScreener pair. */
function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: "bsc",
    dexId: "pancakeswap",
    priceUsd: "0.00001",
    liquidity: { usd: 50_000 },
    baseToken: { address: ADDR, symbol: "PEPE" },
    quoteToken: { symbol: "WBNB" },
    ...overrides,
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetchJson(payload: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

const BSC_OPTS = {
  dexWhitelist: ["PCS", "PCS_V3", "BISWAP"],
  lender: "Venus",
  loanSizeBnb: 5,
  run: 3,
};

describe("fetchTokenPairs", () => {
  test("returns pairs from the DexScreener token endpoint", async () => {
    mockFetchJson({ pairs: [pair()] });
    const pairs = await fetchTokenPairs(ADDR);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.dexId).toBe("pancakeswap");
  });

  test("returns an empty array when the response has no pairs", async () => {
    mockFetchJson({});
    expect(await fetchTokenPairs(ADDR)).toEqual([]);
  });
});

describe("buildTelecopierRoute", () => {
  test("emits a real two-venue round trip when the spread exists", async () => {
    // PCS quotes 0.00001, Biswap quotes 0.0000102 → +2% cross-venue spread.
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001", liquidity: { usd: 80_000 } }),
        pair({ dexId: "biswap", priceUsd: "0.0000102", liquidity: { usd: 60_000 } }),
      ],
    });
    const route = await buildTelecopierRoute(signal(), "bsc", BSC_OPTS);
    expect(route).not.toBeNull();
    const r = route!;
    // QUOTE → buy-venue → token → sell-venue → QUOTE
    expect(r.legs[0]).toBe("WBNB");
    expect(r.legs[1]).toBe("PCS");
    expect(r.legs[2]).toBe("PEPE");
    expect(r.legs[3]).toBe("BISWAP");
    expect(r.legs[4]).toBe("WBNB");
    expect(r.dexes).toEqual(["PCS", "BISWAP"]);
    expect(r.spreadBps).toBe(200);
    expect(r.venueSpreadPct).toBe(2);
    // profitPct = spread − both legs' fees (0.25% + 0.2%)
    expect(r.profitPct).toBeCloseTo(2 - 0.25 - 0.2, 2);
    expect(r.liquidityUsd).toBe(60_000);
    expect(r.signalId).toBe("sig-1");
    expect(r.signalSource).toBe("AveSignalMonitor");
    expect(r.tokenAddress).toBe(ADDR);
    expect(r.lender).toBe("Venus");
    expect(r.loanSizeBnb).toBe(5);
    expect(r.mevRisk).toBe(45);
  });

  test("null when the token trades on fewer than two whitelisted venues", async () => {
    mockFetchJson({ pairs: [pair({ dexId: "pancakeswap" })] });
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("null when prices are identical across venues (no real spread)", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001" }),
        pair({ dexId: "biswap", priceUsd: "0.00001" }),
      ],
    });
    // No cross-venue spread → nothing to arb → never emit.
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("null when fetch fails (never fabricates)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("null on an unsupported chain (no DexScreener mapping)", async () => {
    mockFetchJson({
      pairs: [pair(), pair({ dexId: "biswap", priceUsd: "0.0000102" })],
    });
    expect(
      await buildTelecopierRoute(signal(), "base" as never, BSC_OPTS),
    ).toBeNull();
  });

  test("ignores pairs below the $5k liquidity floor", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001", liquidity: { usd: 80_000 } }),
        pair({ dexId: "biswap", priceUsd: "0.0000102", liquidity: { usd: 2_000 } }),
      ],
    });
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("ignores pairs on other chains", async () => {
    mockFetchJson({
      pairs: [
        pair({ chainId: "ethereum", priceUsd: "0.00001" }),
        pair({ chainId: "arbitrum", priceUsd: "0.0000102" }),
      ],
    });
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("whitelist filters venues — unwhitelisted dexId never participates", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001" }),
        pair({ dexId: "apemap-finance", priceUsd: "0.00002" }),
      ],
    });
    expect(await buildTelecopierRoute(signal(), "bsc", BSC_OPTS)).toBeNull();
  });

  test("resolves unlabeled pancakeswap pairs to the conservative PCS venue", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001", liquidity: { usd: 90_000 } }),
        pair({ dexId: "biswap", priceUsd: "0.0000104", liquidity: { usd: 55_000 } }),
      ],
    });
    const route = await buildTelecopierRoute(signal(), "bsc", BSC_OPTS);
    expect(route).not.toBeNull();
    expect(route!.spreadBps).toBe(400);
    expect(route!.dexes).toEqual(["PCS", "BISWAP"]);
  });

  test("resolves v3-labeled pancakeswap pairs to PCS_V3 and prices its lower fee", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", labels: ["v3"], priceUsd: "0.00001", liquidity: { usd: 90_000 } }),
        pair({ dexId: "biswap", priceUsd: "0.0000102", liquidity: { usd: 55_000 } }),
      ],
    });
    const route = await buildTelecopierRoute(signal(), "bsc", BSC_OPTS);
    expect(route).not.toBeNull();
    expect(route!.dexes).toEqual(["PCS_V3", "BISWAP"]);
    expect(route!.spreadBps).toBe(200);
    // profit = 2% spread − PCS_V3 0.1% − BISWAP 0.2% = 1.7%
    expect(route!.profitPct).toBeCloseTo(1.7, 2);
  });
});

describe("buildTelecopierRoutes", () => {
  const BATCH_OPTS = {
    dexWhitelist: ["PCS", "BISWAP"],
    lender: "Radiant",
    loanSizeBnb: 2,
    run: 1,
  };

  test("converts fresh buyable signals into routes, dedupes by address", async () => {
    mockFetchJson({
      pairs: [
        pair({ dexId: "pancakeswap", priceUsd: "0.00001" }),
        pair({ dexId: "biswap", priceUsd: "0.000011" }),
      ],
    });
    const routes = await buildTelecopierRoutes(
      [signal(), signal({ id: "sig-2", address: ADDR })],
      "bsc",
      BATCH_OPTS,
    );
    expect(routes.length).toBe(1); // same address → deduped
    expect(routes[0]!.signalId).toBe("sig-1");
  });

  test("skips non-buyable and cross-chain signals before fetching", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(
        JSON.stringify({
          pairs: [pair(), pair({ dexId: "biswap", priceUsd: "0.000011" })],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const routes = await buildTelecopierRoutes(
      [
        signal({ id: "s3", buyable: false }),
        signal({ id: "s4", chain: "ethereum" }),
        signal({ id: "s5", chain: "other" }),
        signal({ id: "s6", chain: "" }),
      ],
      "bsc",
      BATCH_OPTS,
      6,
    );
    // s3/s4 filtered out BEFORE any fetch and BEFORE the address dedupe;
    // s5 (chain-agnostic) fetched and converted; s6 same address → deduped.
    expect(fetches).toBe(1);
    expect(routes.length).toBe(1);
    expect(routes[0]!.signalId).toBe("s5");
  });

  test("caps the batch at maxRoutes", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          pairs: [pair(), pair({ dexId: "biswap", priceUsd: "0.000011" })],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const many = Array.from({ length: 5 }, (_, i) =>
      signal({ id: `sig-${i}`, address: "0x" + String(i).padStart(40, "d") }),
    );
    const routes = await buildTelecopierRoutes(many, "bsc", BATCH_OPTS, 2);
    expect(routes.length).toBe(2);
  });
});
