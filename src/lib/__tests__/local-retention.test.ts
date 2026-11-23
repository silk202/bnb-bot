/**
 * The app's own ten-minute sweep, pinned without a browser.
 *
 * `startLocalRetention` runs `runLocalRetention` at boot and every ten minutes
 * (mounted in main.tsx). Its contract has one edge that matters: it may only
 * remove local data the app has ALREADY stopped reading — a stale day counter
 * is reset on read, a one-shot flag is consumed — and it must never touch the
 * important data, reports and settings, or a key it does not recognise.
 *
 * These tests fake the Web Storage API so they hold the real selection rule.
 */
import { describe, expect, test } from "bun:test";
import {
  DAY_TRACKER_PREFIX,
  LOCAL_RETENTION_INTERVAL_MS,
  ONE_SHOT_SESSION_KEYS,
  runLocalRetention,
  sweepDayTrackers,
  sweepSessionScratch,
  type RetentionStorage,
} from "../local-retention";

const NOW = new Date("2026-11-23T12:00:00Z").getTime();
const TODAY = "2026-11-23";

class FakeStorage implements RetentionStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  set(key: string, value: string): this {
    this.map.set(key, value);
    return this;
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** The local keys that are the app's identity, money, reports and settings. */
const IMPORTANT: Array<[string, string]> = [
  ["flashbolt.gate.grant", JSON.stringify({ tier: "operator", until: NOW + 86_400_000 })],
  ["flashbolt.deviceTrustToken", "ab".repeat(32)],
  ["fb.sol-positions.v2", JSON.stringify([{ mint: "So111", entry: 1.2 }])],
  ["flashbolt:payout-exposure:v1", JSON.stringify({ day: TODAY, total: 0.4 })],
  ["flashbolt:circuit-breaker:v1", JSON.stringify({ open: false })],
  ["flashbolt.relay-probe-history.v1", JSON.stringify({ rpc: [{ t: NOW - 60_000, latencyMs: 42, ok: true }] })],
  ["flashbolt.rpc.discovery.v1", JSON.stringify({ extra: [] })],
  ["flashbolt-utc-offset", "60"],
  ["flashbolt.terminalFlavor", "sol"],
  ["flashbolt.relayChartRange", "1h"],
  ["flashbolt.relayAutoRefresh", "on"],
  ["flashbolt.download.gate", JSON.stringify({ ok: true })],
  ["some.future.feature.key", "whatever it stores is not mine to delete"],
];

describe("sweepDayTrackers — yesterday's counters go, today's stay", () => {
  test("a stale row is removed, today's row and a malformed row are not", () => {
    const storage = new FakeStorage()
      .set("tracker_bnb", JSON.stringify({ date: "2026-11-22", wins: 9 }))
      .set("tracker_sol-sniper", JSON.stringify({ date: TODAY, wins: 2 }))
      .set("tracker_broken", "{not json");
    expect(sweepDayTrackers(storage, NOW)).toEqual(["tracker_bnb"]);
    expect(storage.keys()).toEqual(["tracker_sol-sniper", "tracker_broken"]);
  });

  test("a tracker whose date is not a string is left alone", () => {
    const storage = new FakeStorage().set("tracker_odd", JSON.stringify({ date: 20261122 }));
    expect(sweepDayTrackers(storage, NOW)).toEqual([]);
    expect(storage.keys()).toContain("tracker_odd");
  });

  test("today is the UTC day, so the sweep agrees with loadDailyTracker", () => {
    const storage = new FakeStorage().set("tracker_key", JSON.stringify({ date: TODAY }));
    expect(sweepDayTrackers(storage, NOW)).toEqual([]);
  });

  test("nothing outside the tracker prefix is ever selected", () => {
    const storage = new FakeStorage()
      .set("flashbolt.notATracker", JSON.stringify({ date: "2020-01-01" }))
      .set("my-tracker", JSON.stringify({ date: "2020-01-01" }));
    expect(sweepDayTrackers(storage, NOW)).toEqual([]);
    expect(storage.length).toBe(2);
  });
});

describe("sweepSessionScratch — consumed flags only", () => {
  test("removes the one-shot dialog flag and reports it", () => {
    const session = new FakeStorage().set("flashbolt.botDialogReopen", "1");
    expect(sweepSessionScratch(session)).toEqual([...ONE_SHOT_SESSION_KEYS]);
    expect(session.length).toBe(0);
  });

  test("an absent flag is not reported as removed", () => {
    expect(sweepSessionScratch(new FakeStorage())).toEqual([]);
  });
});

describe("the sweep never touches important data, reports or settings", () => {
  test("every important key survives a full sweep", () => {
    const storage = new FakeStorage();
    for (const [key, value] of IMPORTANT) storage.set(key, value);
    storage.set("tracker_bnb", JSON.stringify({ date: "2026-11-01" }));

    expect(sweepDayTrackers(storage, NOW)).toEqual(["tracker_bnb"]);
    for (const [key, value] of IMPORTANT) expect(storage.getItem(key)).toBe(value);
  });

  test("the tracker prefix is the only namespace the sweep owns", () => {
    expect(DAY_TRACKER_PREFIX).toBe("tracker_");
  });
});

describe("runLocalRetention / startLocalRetention", () => {
  test("outside a browser it is a no-op, not a crash", () => {
    const report = runLocalRetention(NOW);
    expect(report).toEqual({ at: NOW, removed: [], remaining: 0 });
  });

  test("the window is ten minutes, the same as the backend sweeps", () => {
    expect(LOCAL_RETENTION_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
