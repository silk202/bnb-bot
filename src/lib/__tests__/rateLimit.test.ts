import { describe, expect, test } from "bun:test";
import { applyRateLimit } from "../rateLimit";

describe("applyRateLimit — fixed-window rate limiter", () => {
  test("first call in a window is allowed and starts the count at 1", () => {
    const result = applyRateLimit(null, 1_000, 3, 60_000);
    expect(result.allow).toBe(true);
    expect(result.state).toEqual({ windowStart: 1_000, count: 1 });
  });

  test("calls within the window are allowed until the limit", () => {
    let state = applyRateLimit(null, 1_000, 3, 60_000).state;
    expect(state.count).toBe(1);

    state = applyRateLimit(state, 2_000, 3, 60_000).state;
    expect(state.count).toBe(2);

    const third = applyRateLimit(state, 3_000, 3, 60_000);
    expect(third.allow).toBe(true);
    expect(third.state.count).toBe(3);
  });

  test("the limit is enforced — over-limit calls are rejected", () => {
    let state = applyRateLimit(null, 1_000, 3, 60_000).state;
    state = applyRateLimit(state, 2_000, 3, 60_000).state;
    state = applyRateLimit(state, 3_000, 3, 60_000).state;

    const blocked = applyRateLimit(state, 4_000, 3, 60_000);
    expect(blocked.allow).toBe(false);
    expect(blocked.message).toBe(
      "Too many attempts — wait a moment and try again.",
    );
    // The stored state is untouched while blocked.
    expect(blocked.state).toEqual(state);
  });

  test("a custom rejection message is surfaced", () => {
    let state = applyRateLimit(null, 1_000, 1, 60_000).state;
    const blocked = applyRateLimit(
      state,
      2_000,
      1,
      60_000,
      "Too many sign-in attempts — try again in a minute.",
    );
    expect(blocked.allow).toBe(false);
    expect(blocked.message).toBe(
      "Too many sign-in attempts — try again in a minute.",
    );
  });

  test("an elapsed window resets the count for the next call", () => {
    let state = applyRateLimit(null, 1_000, 2, 60_000).state;
    state = applyRateLimit(state, 2_000, 2, 60_000).state;
    expect(state.count).toBe(2);

    // 61 seconds later the window has fully elapsed — the call is allowed.
    const next = applyRateLimit(state, 62_000, 2, 60_000);
    expect(next.allow).toBe(true);
    expect(next.state).toEqual({ windowStart: 62_000, count: 1 });
  });

  test("the boundary — a call exactly at windowStart + windowMs is a fresh window", () => {
    const state = applyRateLimit(null, 1_000, 1, 60_000).state;
    const next = applyRateLimit(state, 61_000, 1, 60_000);
    expect(next.allow).toBe(true);
    expect(next.state.windowStart).toBe(61_000);
    expect(next.state.count).toBe(1);
  });
});
