import { describe, expect, test } from "bun:test";
import {
  ARM_MAX_AGE_MS,
  checkExecutorPin,
  checkHashOnlyPin,
  chainKeyForPin,
  formatAge,
  INSPECTION_TTL_MS,
  inspectionExpired,
  inspectionExpiresAt,
  inspectionLabel,
  inspectionRemainingMs,
  isInspectionFresh,
  nextArmStamps,
} from "../../convex/pinGuard";

const ARMED = "0x2c34a2fb58b2f9a3ff6ad4d3b5e5fbcd0b09cdd6";
const OTHER = "0x1111111111111111111111111111111111111111";
const NOW = 1_800_000_000_000;
const FRESH = NOW - 86_400_000; // armed yesterday

describe("chain support", () => {
  test("maps every pinnable chain id to its deployment key", () => {
    expect(chainKeyForPin(56)).toBe("bsc");
    expect(chainKeyForPin(97)).toBe("bsc");
    expect(chainKeyForPin(1)).toBe("ethereum");
    expect(chainKeyForPin(42161)).toBe("arbitrum");
    expect(chainKeyForPin(137)).toBe("polygon");
  });

  test("refuses a chain it cannot pin", () => {
    const result = checkExecutorPin({
      chainId: 999,
      contractAddress: ARMED,
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unsupported-chain");
    expect(result.message).toContain("999");
  });
});

describe("executor pin", () => {
  test("accepts the armed executor, case-insensitively", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED.toUpperCase().replace("0X", "0x"),
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.armed).toBe(ARMED);
    expect(result.armedAt).toBe(FRESH);
  });

  test("refuses when nothing is armed", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED,
      armedAddress: "",
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no-arm");
    expect(result.message).toContain("bsc");
  });

  test("refuses a malformed arm instead of treating it as a match", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED,
      armedAddress: "0x1234",
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no-arm");
  });

  test("refuses an arm with no timestamp", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED,
      armedAddress: ARMED,
      armedAt: undefined,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unverified-arm");
    expect(result.message).toContain("timestamp");
  });

  test("refuses an arm older than the limit", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED,
      armedAddress: ARMED,
      armedAt: NOW - ARM_MAX_AGE_MS - 1,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("stale-arm");
    expect(result.message).toContain("Re-arm");
  });

  test("accepts an arm exactly at the limit (boundary is exclusive)", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: ARMED,
      armedAddress: ARMED,
      armedAt: NOW - ARM_MAX_AGE_MS,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  test("refuses a different address even when the arm is fresh", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: OTHER,
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("address-mismatch");
    expect(result.message).toContain(ARMED);
  });

  test("checks staleness before address agreement", () => {
    const result = checkExecutorPin({
      chainId: 56,
      contractAddress: OTHER,
      armedAddress: ARMED,
      armedAt: NOW - ARM_MAX_AGE_MS - 1,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("stale-arm");
  });
});

describe("legacy hash-only pin", () => {
  test("accepts a refresh of an activation pinned to the armed executor", () => {
    const result = checkHashOnlyPin({
      chainId: 56,
      pinnedAddress: ARMED,
      armedAddress: ARMED.toUpperCase().replace("0X", "0x"),
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  test("refuses an activation with no pinned address", () => {
    const result = checkHashOnlyPin({
      chainId: 56,
      pinnedAddress: undefined,
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no-pinned-address");
    expect(result.message).toContain("Confirm & pin executor");
  });

  test("refuses when the activation is pinned to a contract that is not armed", () => {
    const result = checkHashOnlyPin({
      chainId: 56,
      pinnedAddress: OTHER,
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("address-mismatch");
  });

  test("refuses a stale arm for a hash-only refresh too", () => {
    const result = checkHashOnlyPin({
      chainId: 1,
      pinnedAddress: ARMED,
      armedAddress: ARMED,
      armedAt: NOW - ARM_MAX_AGE_MS - 1,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("stale-arm");
  });

  test("refuses an unsupported chain", () => {
    const result = checkHashOnlyPin({
      chainId: 56_000,
      pinnedAddress: ARMED,
      armedAddress: ARMED,
      armedAt: FRESH,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unsupported-chain");
  });
});

describe("inspection evidence freshness", () => {
  test("accepts evidence inside the window", () => {
    expect(isInspectionFresh(NOW - 60_000, NOW)).toBe(true);
    expect(isInspectionFresh(NOW, NOW)).toBe(true);
  });

  test("treats the window boundary as expired, like the countdown does", () => {
    // One millisecond inside the window is fresh; the boundary instant is not,
    // matching `inspectionExpired(remaining <= 0)` exactly.
    expect(isInspectionFresh(NOW - INSPECTION_TTL_MS + 1, NOW)).toBe(true);
    expect(isInspectionFresh(NOW - INSPECTION_TTL_MS, NOW)).toBe(false);
    expect(isInspectionFresh(NOW - INSPECTION_TTL_MS - 1, NOW)).toBe(false);
    const boundary = inspectionRemainingMs({
      expiresAt: inspectionExpiresAt(NOW - INSPECTION_TTL_MS),
      serverNow: NOW,
      elapsedSinceResponse: 0,
    });
    expect(inspectionExpired(boundary)).toBe(true);
    expect(isInspectionFresh(NOW - INSPECTION_TTL_MS, NOW)).toBe(false);
  });

  test("rejects missing, non-finite or future stamps", () => {
    expect(isInspectionFresh(Number.NaN, NOW)).toBe(false);
    expect(isInspectionFresh(Number.POSITIVE_INFINITY, NOW)).toBe(false);
    // A stamp ahead of the server clock is not evidence of a longer window.
    expect(isInspectionFresh(NOW + 1_000, NOW)).toBe(false);
  });

  test("keeps the window short enough to mean something", () => {
    expect(INSPECTION_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("inspection countdown gated on the server clock", () => {
  test("formats ages compactly", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59_000)).toBe("59s");
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(72_000)).toBe("1m 12s");
    expect(formatAge(3_600_000)).toBe("1h");
    expect(formatAge(3_900_000)).toBe("1h 5m");
    expect(formatAge(2 * 86_400_000)).toBe("2d");
    expect(formatAge(-5_000)).toBe("0s");
  });

  test("counts down from the server-issued expiry, not from the browser clock", () => {
    const inspectedAt = NOW;
    const expiresAt = inspectionExpiresAt(inspectedAt);
    expect(expiresAt).toBe(inspectedAt + INSPECTION_TTL_MS);
    // The server answers immediately; the operator waits 60s of MONOTONIC time.
    const remaining = inspectionRemainingMs({ expiresAt, serverNow: NOW, elapsedSinceResponse: 60_000 });
    expect(remaining).toBe(INSPECTION_TTL_MS - 60_000);
    expect(inspectionExpired(remaining)).toBe(false);
    expect(inspectionLabel(remaining)).toBe("inspected 1m ago · fresh for 9m more");
  });

  test("ignores wall-clock skew: the browser clock is not an input", () => {
    const expiresAt = inspectionExpiresAt(NOW);
    // The same server response and the same monotonic elapsed time produce the
    // same window no matter what the browser's wall clock says (it is unused).
    const remaining = inspectionRemainingMs({ expiresAt, serverNow: NOW, elapsedSinceResponse: 30_000 });
    expect(remaining).toBe(INSPECTION_TTL_MS - 30_000);
    expect(inspectionLabel(remaining)).toBe("inspected 30s ago · fresh for 9m 30s more");
  });

  test("expires exactly when the server window closes", () => {
    const expiresAt = inspectionExpiresAt(NOW);
    expect(
      inspectionExpired(inspectionRemainingMs({ expiresAt, serverNow: NOW, elapsedSinceResponse: INSPECTION_TTL_MS })),
    ).toBe(true);
    expect(
      inspectionExpired(
        inspectionRemainingMs({ expiresAt, serverNow: NOW, elapsedSinceResponse: INSPECTION_TTL_MS - 1 }),
      ),
    ).toBe(false);
    const stale = inspectionLabel(
      inspectionRemainingMs({ expiresAt, serverNow: NOW, elapsedSinceResponse: INSPECTION_TTL_MS + 1 }),
    );
    expect(stale).toContain("expired");
    expect(stale).toContain("10-minute window");
  });

  test("does not call a sub-second window expired", () => {
    const label = inspectionLabel(999);
    expect(label).toContain("expires now");
    expect(label).not.toContain("expired");
    expect(inspectionLabel(1_000)).toBe("inspected 9m 59s ago · fresh for 1s more");
  });

  test("fails closed on an unreadable response", () => {
    const remaining = inspectionRemainingMs({
      expiresAt: Number.NaN,
      serverNow: NOW,
      elapsedSinceResponse: 0,
    });
    expect(Number.isNaN(remaining)).toBe(true);
    expect(inspectionExpired(remaining)).toBe(true);
    expect(inspectionLabel(remaining)).toBe("inspection expiry unknown — inspect again");
    expect(inspectionExpired(inspectionRemainingMs({ expiresAt: NOW - 1, serverNow: NOW, elapsedSinceResponse: 0 }))).toBe(true);
  });

  test("a negative elapsed measurement never extends the window", () => {
    const remaining = inspectionRemainingMs({
      expiresAt: inspectionExpiresAt(NOW),
      serverNow: NOW,
      elapsedSinceResponse: -5_000,
    });
    expect(remaining).toBe(INSPECTION_TTL_MS);
  });
});

describe("arm stamps on save", () => {
  const FIRST = FRESH - 10 * 86_400_000; // first seen armed, ten days earlier

  test("a new address is a new arm and a new first arm", () => {
    expect(nextArmStamps({ previousAddress: OTHER, nextAddress: ARMED, previousArmedAt: FRESH, now: NOW })).toEqual({
      armedAt: NOW,
      firstArmedAt: NOW,
      affirmedAt: NOW,
    });
  });

  test("re-saving the same address keeps the arm and only moves the affirmation", () => {
    expect(
      nextArmStamps({
        previousAddress: ARMED,
        nextAddress: ARMED,
        previousArmedAt: FRESH,
        previousFirstArmedAt: FIRST,
        now: NOW,
      }),
    ).toEqual({ armedAt: FRESH, firstArmedAt: FIRST, affirmedAt: NOW });
    expect(
      nextArmStamps({ previousAddress: ARMED.toUpperCase(), nextAddress: ARMED.toLowerCase(), previousArmedAt: FRESH, now: NOW }),
    ).toEqual({ armedAt: FRESH, firstArmedAt: FRESH, affirmedAt: NOW });
  });

  test("a record saved before timestamps existed is affirmed now, not back-dated", () => {
    const stamps = nextArmStamps({ previousAddress: ARMED, nextAddress: ARMED, previousArmedAt: undefined, now: NOW });
    expect(stamps).toEqual({ armedAt: NOW, affirmedAt: NOW });
    // firstArmedAt stays ABSENT: the real first-arm time is unknown, and
    // inventing one would make the record look older or newer than it is.
    expect(stamps.firstArmedAt).toBeUndefined();
    expect(
      nextArmStamps({ previousAddress: ARMED, nextAddress: ARMED, previousArmedAt: Number.NaN, now: NOW }).firstArmedAt,
    ).toBeUndefined();
  });

  test("a save without an address records no arm", () => {
    expect(nextArmStamps({ previousAddress: "", nextAddress: "  ", previousArmedAt: FRESH, now: NOW })).toEqual({});
  });
});
