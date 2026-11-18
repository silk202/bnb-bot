import { describe, expect, test } from "bun:test";
import {
  UTC_OFFSETS,
  offsetLabel,
  readStoredOffset,
  utcShifted,
} from "@/lib/utc-clock";

describe("utc-clock", () => {
  test("UTC offset list spans -12..+14 with 27 entries", () => {
    expect(UTC_OFFSETS).toHaveLength(27);
    expect(UTC_OFFSETS[0]).toBe(-12);
    expect(UTC_OFFSETS[26]).toBe(14);
    expect(UTC_OFFSETS).toContain(0);
  });

  test("offset 0 renders 00:00:00 UTC at midnight", () => {
    const parts = utcShifted(new Date("2026-08-09T00:00:00Z"), 0);
    expect(parts.time).toBe("00:00:00");
    expect(parts.date).toBe("AUG:09:2026");
  });

  test("+1 shifts midnight to 01:00:00 on the same date", () => {
    const parts = utcShifted(new Date("2026-08-09T00:00:00Z"), 1);
    expect(parts.time).toBe("01:00:00");
    expect(parts.date).toBe("AUG:09:2026");
  });

  test("-12 shifts to the previous day", () => {
    const parts = utcShifted(new Date("2026-08-09T00:00:00Z"), -12);
    expect(parts.time).toBe("12:00:00");
    expect(parts.date).toBe("AUG:08:2026");
  });

  test("+8 rolls over to the next day", () => {
    const parts = utcShifted(new Date("2026-08-09T20:00:00Z"), 8);
    expect(parts.time).toBe("04:00:00");
    expect(parts.date).toBe("AUG:10:2026");
  });

  test("every offset is a true 24h wall-clock shift", () => {
    const base = new Date("2026-08-09T12:00:00Z");
    for (const offset of UTC_OFFSETS) {
      const { time } = utcShifted(base, offset);
      const hours = parseInt(time.slice(0, 2), 10);
      expect(hours).toBeGreaterThanOrEqual(0);
      expect(hours).toBeLessThan(24);
    }
  });

  test("offset labels read UTC, UTC+1, UTC-5", () => {
    expect(offsetLabel(0)).toBe("UTC");
    expect(offsetLabel(1)).toBe("UTC+1");
    expect(offsetLabel(-5)).toBe("UTC-5");
    expect(offsetLabel(14)).toBe("UTC+14");
  });

  test("readStoredOffset falls back to 0 with no stored value", () => {
    const before = globalThis.localStorage;
    // @ts-expect-error localStorage is undefined in the test runtime
    globalThis.localStorage = undefined;
    expect(readStoredOffset()).toBe(0);
    globalThis.localStorage = before;
  });
});
