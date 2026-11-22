import { describe, expect, test } from "bun:test";
import {
  UTC_OFFSETS,
  UTC_OFFSET_STORAGE_KEY,
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
    // `localStorage` is absent in the Bun runtime, so this exercises the
    // no-storage branch. Never reassign the global: when the whole suite runs
    // in one process another test installs DOM globals, which makes
    // `localStorage` readonly and turns that assignment into a TypeError.
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(UTC_OFFSET_STORAGE_KEY);
    }
    expect(readStoredOffset()).toBe(0);
  });
});
