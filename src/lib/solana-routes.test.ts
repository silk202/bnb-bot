/**
 * SOL route engine tests — real fixtures, no network mocks beyond fetch.
 * Verifies: two-venue conversion math, label disambiguation (raydium AMM v4
 * vs CLMM), liquidity floor, chain filtering, honest nulls on fetch failure,
 * batch dedupe and the maxRoutes cap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSolTelecopierRoute,
  buildSolTelecopierRoutes,
  type SolTelecopierSignal,
} from "./solana-routes";
import { SOL_DEFAULT_WHITELIST, SOL_DEXES, solLenderForRun } from "./solana";

const originalFetch = globalThis.fetch;

function mockFetchOnce(body: unknown) {
  const fn = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  globalThis.fetch = fn;
}

function signal(overrides: Partial<SolTelecopierSignal> = {}): SolTelecopierSignal {
  return {
    id: "test : mint1",
    source: "t.me/test",
    sourceLabel: "Test channel",
    address: "So11111111111111111111111111111111111111112",
    symbol: "TEST",
    name: "TEST",
    chain: "solana",
    priceUsd: 0.001,
    liquidityUsd: 20_000,
    postedAt: Date.now(),
    capturedAt: Date.now(),
    buyable: true,
    excerpt: "test signal",
    ...overrides,
  };
}

function pair(dexId: string, price: string, liq: number, labels?: string[]) {
  return {
    chainId: "solana",
    dexId,
    labels,
    priceUsd: price,
    liquidity: { usd: liq },
    baseToken: { address: "mint1", symbol: "TEST" },
    quoteToken: { symbol: "WSOL" },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("solLenderForRun", () => {
  test("rotates lenders per run", () => {
    const a = solLenderForRun(0, false);
    const b = solLenderForRun(1, false);
    expect(a).not.toBe(b);
  });

  test("balancer rotates in fee order (0% lenders first)", () => {
    // Jupiter Lend is the approved primary lender (0%); MarginFi is the other
    // free lender, Solend the only fee-charging fallback. Kamino is deferred.
    expect(solLenderForRun(0, true)).toBe("Jupiter Lend");
    expect(solLenderForRun(1, true)).toBe("MarginFi");
    expect(solLenderForRun(2, true)).toBe("Solend"); // 0.3% last
    expect(solLenderForRun(3, true)).toBe("Jupiter Lend"); // wraps
  });
});

describe("SOL_DEXES registry", () => {
  test("has at least two whitelisted venues", () => {
    expect(SOL_DEXES.length).toBeGreaterThanOrEqual(2);
    expect(SOL_DEFAULT_WHITELIST.length).toBe(SOL_DEXES.length);
  });

  test("dexIds are verified DexScreener Solana ids", () => {
    const ids = new Set(SOL_DEXES.map((d) => d.dexId));
    for (const expected of ["raydium", "orca", "meteora", "pumpswap"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe("buildSolTelecopierRoute", () => {
  test("builds a two-venue round trip from a real spread", async () => {
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
    });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).not.toBeNull();
    const legs = route!.legs;
    expect(legs[0]).toBe("WSOL");
    expect(legs[legs.length - 1]).toBe("WSOL");
    // spread 10% − fees (0.25% raydium AMM + 0.3% orca) × 100 = 9.45%
    expect(route!.profitPct).toBeCloseTo(9.45, 2);
    expect(route!.loanSizeSol).toBe(1);
    expect(route!.signalSource).toBe("Test channel");
  });

  test("loan size clamps into [SOL_MIN_LOAN, SOL_MAX_LOAN_CAP]", async () => {
    // Default size passes through untouched.
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
    });
    const normal = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 5,
      run: 1,
    });
    expect(normal!.loanSizeSol).toBe(5);

    // Oversized requests clamp at the 50 SOL cap.
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
    });
    const huge = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 500,
      run: 2,
    });
    expect(huge!.loanSizeSol).toBe(50);

    // Sub-floor requests (and 0) clamp up to the 0.05 SOL minimum — the
    // wallet-fit floor, so a 0.055 SOL wallet can still land a route.
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
    });
    const tiny = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 0,
      run: 3,
    });
    expect(tiny!.loanSizeSol).toBe(0.05);
  });

  test("disambiguates raydium AMM v4 vs CLMM via labels", async () => {
    mockFetchOnce({
      pairs: [
        pair("raydium", "0.001", 50_000), // unlabeled → AMM v4 (0.25%)
        pair("raydium", "0.0012", 30_000, ["CLMM"]), // labeled → CLMM
      ],
    });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).not.toBeNull();
    // 20% spread − (0.25% + 0.25%) = 19.5%
    expect(route!.profitPct).toBeCloseTo(19.5, 2);
    expect(route!.dexes).toContain("RAY");
    expect(route!.dexes).toContain("RAY_CLMM");
  });

  test("returns null on a single venue (no cross-venue arb)", async () => {
    mockFetchOnce({ pairs: [pair("raydium", "0.001", 50_000)] });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).toBeNull();
  });

  test("returns null when identical prices leave no spread", async () => {
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.001", 40_000)],
    });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).toBeNull();
  });

  test("applies the $5k liquidity floor", async () => {
    mockFetchOnce({
      pairs: [pair("raydium", "0.001", 4_999), pair("orca", "0.0011", 40_000)],
    });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).toBeNull();
  });

  test("ignores pairs on other chains", async () => {
    mockFetchOnce({
      pairs: [
        { ...pair("raydium", "0.001", 50_000), chainId: "bsc" },
        pair("orca", "0.0011", 40_000),
      ],
    });
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).toBeNull();
  });

  test("never fabricates on fetch failure", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const route = await buildSolTelecopierRoute(signal(), {
      dexWhitelist: SOL_DEFAULT_WHITELIST,
      lender: "MarginFi",
      loanSizeSol: 1,
      run: 1,
    });
    expect(route).toBeNull();
  });
});

describe("buildSolTelecopierRoutes", () => {
  test("filters non-solana and non-buyable signals, dedupes addresses", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(
        JSON.stringify({
          pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const routes = await buildSolTelecopierRoutes(
      [
        signal({ id: "a", address: "Mint11111111111111111111111111111111111111" }),
        signal({ id: "b", address: "Mint11111111111111111111111111111111111111" }), // dup
        signal({ id: "c", chain: "bsc", address: "Mint2222222222222222222222222222222222222" }),
        signal({ id: "d", buyable: false }),
      ],
      { dexWhitelist: SOL_DEFAULT_WHITELIST, lender: "MarginFi", loanSizeSol: 1, run: 3 },
    );
    expect(fetches).toBe(1); // one usable signal → one fetch
    expect(routes.length).toBe(1);
    expect(routes[0]!.id.startsWith("stc-a-")).toBe(true);
  });

  test("drops a STALE venue price (zero 24h volume + zero 1h move) from arb", async () => {
    // raydium side is fresh; orca side reports no 24h volume and no 1h move —
    // its $10 price is a stale mark that once produced a 10,000,000% phantom
    // spread. The route builder must refuse instead of fabricating.
    const stale = { ...pair("orca", "10", 40_000), volume24hUsd: 0, priceChange1h: 0 };
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          pairs: [pair("raydium", "0.001", 50_000), stale],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const route = await buildSolTelecopierRoute(
      signal({ id: "sigStale", address: "MintStale11111111111111111111111111111111" }),
      { dexWhitelist: SOL_DEFAULT_WHITELIST, lender: "MarginFi", loanSizeSol: 1, run: 9 },
    );
    expect(route).toBeNull();
  });

  test("keeps the venue when freshness fields are absent (unknown ≠ stale)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const route = await buildSolTelecopierRoute(
      signal({ id: "sigFresh", address: "MintFresh1111111111111111111111111111111" }),
      { dexWhitelist: SOL_DEFAULT_WHITELIST, lender: "MarginFi", loanSizeSol: 1, run: 10 },
    );
    expect(route).not.toBeNull();
    expect(route!.profitPct).toBeGreaterThan(0);
  });

  test("refuses an absurd cross-venue spread (>200%) as a quoting artifact", async () => {
    // Both venues nominally fresh, but the marks differ by ~10,000,000% —
    // the exact ledger-poisoning shape from the field. Never executable.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          pairs: [pair("raydium", "0.0000001", 50_000), pair("orca", "10", 60_000)],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const route = await buildSolTelecopierRoute(
      signal({ id: "sigAbsurd", address: "MintAbsurd1111111111111111111111111111111" }),
      { dexWhitelist: SOL_DEFAULT_WHITELIST, lender: "MarginFi", loanSizeSol: 1, run: 11 },
    );
    expect(route).toBeNull();
  });

  test("caps routes at maxRoutes", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          pairs: [pair("raydium", "0.001", 50_000), pair("orca", "0.0011", 40_000)],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const many = Array.from({ length: 10 }, (_, i) =>
      signal({ id: `sig${i}`, address: `Mint${i}111111111111111111111111111111111111` }),
    );
    const routes = await buildSolTelecopierRoutes(
      many,
      { dexWhitelist: SOL_DEFAULT_WHITELIST, lender: "MarginFi", loanSizeSol: 1, run: 4 },
      3,
    );
    expect(routes.length).toBe(3);
  });
});
