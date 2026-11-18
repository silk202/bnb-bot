/**
 * Tests for the Convex fetch-resilience layer — the fix for the preview's
 * "TypeError: Failed to fetch" at the auth handshake.
 *
 * Verifies: Convex-URL targeting (only Convex requests are retried),
 * retry through transient failures, non-Convex pass-through, budget
 * exhaustion honesty, idempotent install.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  convexOriginFrom,
  installConvexFetchRetry,
  uninstallConvexFetchRetry,
} from "./convex-fetch-resilience";

const REAL_CONVEX_URL =
  "https://grand-lemur-123.convex.cloud/api/query?args=%7B%7D";
const NON_CONVEX_URL = "https://api.dexscreener.com/latest/dex/tokens/abc";

const savedFetch = globalThis.fetch;
const restorers: Array<() => void> = [];

afterEach(() => {
  uninstallConvexFetchRetry();
  for (const restore of restorers.reverse()) restore();
  restorers.length = 0;
  globalThis.fetch = savedFetch;
});

function patch(f: unknown): void {
  globalThis.fetch = f as typeof globalThis.fetch;
  restorers.push(() => {
    globalThis.fetch = savedFetch;
  });
}

describe("convexOriginFrom", () => {
  test("recognizes convex.cloud deployments", () => {
    expect(convexOriginFrom(REAL_CONVEX_URL)).toBe(
      "https://grand-lemur-123.convex.cloud",
    );
  });

  test("recognizes the Daytona proxy with a Convex API path", () => {
    const url = "https://5173-abc.daytonaproxy01.net/_convex/api/query";
    expect(convexOriginFrom(url)).toBe("https://5173-abc.daytonaproxy01.net");
  });

  test("rejects non-Convex hosts", () => {
    expect(convexOriginFrom("https://evil.example.com/api/query")).toBeNull();
    expect(convexOriginFrom(NON_CONVEX_URL)).toBeNull();
  });

  test("rejects non-http(s) protocols", () => {
    expect(convexOriginFrom("ftp://grand-lemur-123.convex.cloud/api")).toBeNull();
  });
});

describe("installConvexFetchRetry", () => {
  function makeFetch(failTimes: number) {
    let calls = 0;
    return async (): Promise<Response> => {
      calls += 1;
      if (calls <= failTimes) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200 } as unknown as Response;
    };
  }

  test("retries a Convex request through transient network failures", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      if (calls <= 2) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200 } as unknown as Response;
    });
    installConvexFetchRetry();
    const res = await fetch(REAL_CONVEX_URL);
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("does not retry non-Convex requests (pass-through)", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    installConvexFetchRetry();
    await expect(fetch(NON_CONVEX_URL)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  test("surfaces the real failure after exhausting the retry budget", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    installConvexFetchRetry();
    await expect(fetch(REAL_CONVEX_URL)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });

  test("install is idempotent — retry count stays capped", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    installConvexFetchRetry();
    installConvexFetchRetry(); // second install is a no-op
    await expect(fetch(REAL_CONVEX_URL)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });

  test("uninstall restores the original fetch (no retry afterwards)", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    installConvexFetchRetry();
    uninstallConvexFetchRetry();
    await expect(fetch(REAL_CONVEX_URL)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  test("immediate success performs exactly one call (no added latency)", async () => {
    let calls = 0;
    patch(async () => {
      calls += 1;
      return { ok: true, status: 200 } as unknown as Response;
    });
    installConvexFetchRetry();
    const res = await fetch(REAL_CONVEX_URL);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});
