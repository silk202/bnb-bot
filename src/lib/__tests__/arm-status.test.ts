import { describe, expect, test } from "bun:test";
import {
  ARM_LIMIT_DAYS,
  ARM_LIMIT_MS,
  ARM_STALE_MS,
  ARM_WARN_HEADROOM_MS,
  armStampTitle,
  armStatus,
  formatArmAge,
} from "@/lib/arm-status";
import { ARM_MAX_AGE_MS } from "@/convex/pinGuard";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const at = (ageMs: number) => NOW - ageMs;

describe("arm-status constants", () => {
  test("the limit is the pin guard's own limit, not a second copy", () => {
    expect(ARM_LIMIT_MS).toBe(ARM_MAX_AGE_MS);
    expect(ARM_LIMIT_DAYS).toBe(30);
  });

  test("the stale warning starts exactly one week before the limit", () => {
    expect(ARM_WARN_HEADROOM_MS).toBe(7 * DAY);
    expect(ARM_STALE_MS).toBe(ARM_LIMIT_MS - ARM_WARN_HEADROOM_MS);
    expect(ARM_STALE_MS).toBe(23 * DAY);
  });
});

describe("armStatus thresholds", () => {
  test("an arm just saved is fresh and accepted for the full limit", () => {
    const status = armStatus(at(0), NOW);
    expect(status.tone).toBe("ok");
    expect(status.message).toContain("Fresh arm: armed today");
    expect(status.message).toContain("30 more days");
  });

  test("the boundary at ARM_STALE_MS is still fresh — the warning starts after it", () => {
    const status = armStatus(at(ARM_STALE_MS), NOW);
    expect(status.tone).toBe("ok");
    expect(status.message).toContain("23 days old");
    expect(status.message).toContain("7 more days");
  });

  test("one millisecond past ARM_STALE_MS warns with 7 days left", () => {
    const status = armStatus(at(ARM_STALE_MS + 1), NOW);
    expect(status.tone).toBe("warn");
    expect(status.message).toContain("Stale arm: 23 days old");
    expect(status.message).toContain("7 more days");
  });

  test("the last whole day before the limit is singular", () => {
    const status = armStatus(at(ARM_LIMIT_MS - 1), NOW);
    expect(status.tone).toBe("warn");
    expect(status.message).toContain("29 days old");
    expect(status.message).toContain("1 more day,");
  });

  test("exactly at the limit the guard still accepts, so the copy does not say 0 days", () => {
    const status = armStatus(at(ARM_LIMIT_MS), NOW);
    expect(status.tone).toBe("warn");
    expect(status.message).toContain("30 days old");
    expect(status.message).toContain("less than a day");
    expect(status.message).not.toContain("0 more");
  });

  test("one millisecond past the limit is refused as expired", () => {
    const status = armStatus(at(ARM_LIMIT_MS + 1), NOW);
    expect(status.tone).toBe("danger");
    expect(status.message).toContain("Stale arm: 30 days old, past the 30-day limit");
    expect(status.message).toContain("bytecode pins are refused");
  });

  test("a much older arm reports its real age", () => {
    const status = armStatus(at(40 * DAY), NOW);
    expect(status.tone).toBe("danger");
    expect(status.message).toContain("40 days old");
  });

  test("a stamp without a value is a danger, never a fresh arm", () => {
    for (const stamp of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const status = armStatus(stamp, NOW);
      expect(status.tone).toBe("danger");
      expect(status.message).toContain("No arm timestamp");
    }
  });

  test("a future stamp is clamped to today instead of a negative age", () => {
    const status = armStatus(NOW + DAY, NOW);
    expect(status.tone).toBe("ok");
    expect(status.message).toContain("armed today");
    expect(status.message).toContain("30 more days");
  });

  test("the tone advances with the clock alone, without a new stamp", () => {
    const stamp = at(0);
    expect(armStatus(stamp, stamp + 22 * DAY).tone).toBe("ok");
    expect(armStatus(stamp, stamp + 24 * DAY).tone).toBe("warn");
    expect(armStatus(stamp, stamp + 30 * DAY).tone).toBe("warn");
    expect(armStatus(stamp, stamp + 31 * DAY).tone).toBe("danger");
  });
});

describe("formatArmAge", () => {
  test("a deployment saved before arm stamps reads as not recorded", () => {
    expect(formatArmAge(undefined, NOW)).toBe("not recorded");
    expect(formatArmAge(null, NOW)).toBe("not recorded");
    expect(formatArmAge(Number.NaN, NOW)).toBe("not recorded");
  });

  test("sub-minute ages read as just now", () => {
    expect(formatArmAge(at(0), NOW)).toBe("just now");
    expect(formatArmAge(at(59_999), NOW)).toBe("just now");
  });

  test("minutes, hours and days each roll over exactly once", () => {
    expect(formatArmAge(at(60_000), NOW)).toBe("1m ago");
    expect(formatArmAge(at(59 * 60_000 + 59_000), NOW)).toBe("59m ago");
    expect(formatArmAge(at(60 * 60_000), NOW)).toBe("1h 0m ago");
    expect(formatArmAge(at(60 * 60_000 + 60_000), NOW)).toBe("1h 1m ago");
    expect(formatArmAge(at(DAY), NOW)).toBe("1d 0h ago");
    expect(formatArmAge(at(2 * DAY + 3 * 60 * 60_000), NOW)).toBe("2d 3h ago");
  });

  test("a future stamp does not render a negative age", () => {
    expect(formatArmAge(NOW + DAY, NOW)).toBe("just now");
  });
});

describe("armStampTitle", () => {
  test("a real stamp shows its exact ISO instant", () => {
    expect(armStampTitle(NOW)).toBe(new Date(NOW).toISOString());
  });

  test("a missing stamp explains why there is nothing to show", () => {
    expect(armStampTitle(undefined)).toContain("armed before arm stamps");
    expect(armStampTitle(Number.NaN)).toContain("armed before arm stamps");
  });
});
