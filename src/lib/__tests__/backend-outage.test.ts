import { describe, expect, test } from "bun:test";
import {
  BACKEND_PAUSED_MESSAGE,
  clearBackendOutage,
  getBackendOutage,
  isBackendPausedError,
  markBackendOutage,
  probeBackendRecovered,
  setBackendRecoveryProbe,
  subscribeBackendOutage,
  userSafeBackendError,
} from "../backend-outage";

const PAUSED_BODY =
  "You have exceeded the free plan limits, so your deployments have been disabled. Please upgrade to a Pro plan or reach out to us at support@convex.dev for help.";

describe("backend-outage detection", () => {
  test("isBackendPausedError: matches the exact plan-limit body", () => {
    expect(isBackendPausedError(new Error(PAUSED_BODY))).toBe(true);
  });

  test("isBackendPausedError: matches plain strings and wrapped prefixes", () => {
    expect(isBackendPausedError(PAUSED_BODY)).toBe(true);
    expect(isBackendPausedError(`Uncaught Error: ${PAUSED_BODY}`)).toBe(true);
    expect(
      isBackendPausedError(`Error: [Request ID: abc] Server Error\n${PAUSED_BODY}`),
    ).toBe(true);
  });

  test("isBackendPausedError: matches Convex-shaped {message} and {data}", () => {
    expect(isBackendPausedError({ message: PAUSED_BODY })).toBe(true);
    expect(isBackendPausedError({ data: PAUSED_BODY })).toBe(true);
  });

  test("isBackendPausedError: case-insensitive", () => {
    expect(isBackendPausedError(PAUSED_BODY.toUpperCase())).toBe(true);
  });

  test("isBackendPausedError: never matches unrelated failures", () => {
    expect(isBackendPausedError(new Error("Failed to fetch"))).toBe(false);
    expect(isBackendPausedError(new TypeError("network down"))).toBe(false);
    expect(isBackendPausedError("Invalid credentials.")).toBe(false);
    expect(isBackendPausedError(null)).toBe(false);
    expect(isBackendPausedError(undefined)).toBe(false);
    expect(isBackendPausedError({})).toBe(false);
  });

  test("userSafeBackendError: paused backend gets the friendly outage copy", () => {
    expect(userSafeBackendError(new Error(PAUSED_BODY), "fallback")).toBe(
      BACKEND_PAUSED_MESSAGE,
    );
  });

  test("userSafeBackendError: real app errors pass through untouched", () => {
    expect(userSafeBackendError(new Error("Wrong passcode"), "fb")).toBe(
      "Wrong passcode",
    );
    expect(userSafeBackendError("plain text error", "fb")).toBe(
      "plain text error",
    );
  });

  test("userSafeBackendError: junk falls back to the caller's message", () => {
    expect(userSafeBackendError(undefined, "Sign-in failed.")).toBe(
      "Sign-in failed.",
    );
    expect(userSafeBackendError({}, "Sign-in failed.")).toBe("Sign-in failed.");
  });
});

describe("backend-outage flag store", () => {
  test("mark/clear are idempotent and notify subscribers once", () => {
    clearBackendOutage();
    expect(getBackendOutage()).toBe(false);

    let notifications = 0;
    const unsub = subscribeBackendOutage(() => {
      notifications += 1;
    });

    markBackendOutage();
    markBackendOutage();
    expect(getBackendOutage()).toBe(true);
    expect(notifications).toBe(1);

    clearBackendOutage();
    clearBackendOutage();
    expect(getBackendOutage()).toBe(false);
    expect(notifications).toBe(2);

    unsub();
  });

  test("subscribe unsubscribe stops notifications", () => {
    clearBackendOutage();
    let notifications = 0;
    const unsub = subscribeBackendOutage(() => {
      notifications += 1;
    });
    unsub();
    markBackendOutage();
    expect(notifications).toBe(0);
    clearBackendOutage();
  });
});

describe("backend-outage recovery probe", () => {
  test("with no probe registered, probing resolves false and never throws", async () => {
    setBackendRecoveryProbe(null);
    expect(await probeBackendRecovered()).toBe(false);
  });

  test("probe success and failure paths", async () => {
    setBackendRecoveryProbe(async () => true);
    expect(await probeBackendRecovered()).toBe(true);

    setBackendRecoveryProbe(async () => {
      throw new Error(PAUSED_BODY);
    });
    expect(await probeBackendRecovered()).toBe(false);

    setBackendRecoveryProbe(null);
  });
});
