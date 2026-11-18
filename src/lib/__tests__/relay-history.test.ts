import { afterEach, describe, expect, test } from "bun:test";
import {
  clearProbeHistory,
  getProbeHistory,
  recordProbeSample,
  summarizeProbeHistory,
  trackedRelays,
} from "../relay-history";

// The relay-history store persists to localStorage — under Bun the global is
// undefined, so polyfill a minimal in-memory version for the suite.
const store = new Map<string, string>();
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
}

describe("relay probe history — persistent ring buffer", () => {
  afterEach(() => clearProbeHistory());

  test("records samples per relay, oldest first", () => {
    recordProbeSample("https://a", { t: 1, latencyMs: 50, ok: true });
    recordProbeSample("https://a", { t: 2, latencyMs: 70, ok: true });
    recordProbeSample("https://b", { t: 3, latencyMs: 90, ok: false, error: "timeout" });
    expect(getProbeHistory("https://a").map((s) => s.t)).toEqual([1, 2]);
    expect(getProbeHistory("https://b")[0].error).toBe("timeout");
  });

  test("ring buffer caps at 60 samples — oldest dropped", () => {
    for (let i = 0; i < 75; i++) {
      recordProbeSample("https://cap", { t: i, latencyMs: i, ok: true });
    }
    const list = getProbeHistory("https://cap");
    expect(list.length).toBe(60);
    expect(list[0].t).toBe(15); // first 15 dropped
    expect(list[59].t).toBe(74);
  });

  test("trackedRelays sorts by sample count and skips empties", () => {
    recordProbeSample("https://x", { t: 1, latencyMs: 1, ok: true });
    recordProbeSample("https://x", { t: 2, latencyMs: 2, ok: true });
    recordProbeSample("https://y", { t: 3, latencyMs: 3, ok: true });
    const tracked = trackedRelays();
    expect(tracked[0].endpoint).toBe("https://x");
    expect(tracked.map((r) => r.endpoint)).not.toContain("https://z");
  });

  test("summarizeProbeHistory computes avg/p50/p95/uptime", () => {
    for (let i = 1; i <= 60; i++) {
      recordProbeSample("https://sum", { t: i, latencyMs: i, ok: i % 4 !== 0 });
    }
    const s = summarizeProbeHistory("https://sum");
    expect(s.count).toBe(60);
    expect(s.avgLatencyMs).toBeCloseTo(30.5, 0);
    expect(s.p95).toBe(58); // lats[Math.floor(0.95 * 60)] = lats[57] = 58
    expect(s.uptimePct).toBe(75); // 15 failures (multiples of 4)
  });

  test("empty history summarizes to zeros", () => {
    const s = summarizeProbeHistory("https://none");
    expect(s).toEqual({ count: 0, avgLatencyMs: 0, p50: 0, p95: 0, uptimePct: 0 });
  });

  test("clearProbeHistory removes one relay or everything", () => {
    recordProbeSample("https://c1", { t: 1, latencyMs: 1, ok: true });
    recordProbeSample("https://c2", { t: 2, latencyMs: 2, ok: true });
    clearProbeHistory("https://c1");
    expect(getProbeHistory("https://c1").length).toBe(0);
    expect(getProbeHistory("https://c2").length).toBe(1);
    clearProbeHistory();
    expect(trackedRelays().length).toBe(0);
  });
});
