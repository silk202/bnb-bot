/**
 * Pure fixed-window rate-limit state machine — dependency-free so the window
 * math can be unit-tested. The Convex table-backed limiter
 * (src/convex/rateLimit.ts) persists the returned window state per bucket;
 * every call goes through `applyRateLimit`, so the limit is enforced by the
 * backend on every single request — never simulated.
 */

export interface RateWindowState {
  windowStart: number;
  count: number;
}

export interface RateLimitResult {
  /** May the call proceed? */
  allow: boolean;
  /** The window state to persist (fresh window or incremented count). */
  state: RateWindowState;
  /** Set when `allow` is false — why the call was rejected. */
  message?: string;
}

export function applyRateLimit(
  state: RateWindowState | null,
  now: number,
  limit: number,
  windowMs: number,
  message?: string,
): RateLimitResult {
  if (!state) {
    // No row yet — first call in the window.
    return { allow: true, state: { windowStart: now, count: 1 } };
  }
  if (now - state.windowStart >= windowMs) {
    // The window elapsed — start a fresh one with this call as the first.
    return { allow: true, state: { windowStart: now, count: 1 } };
  }
  if (state.count >= limit) {
    return {
      allow: false,
      state,
      message: message ?? "Too many attempts — wait a moment and try again.",
    };
  }
  return { allow: true, state: { windowStart: state.windowStart, count: state.count + 1 } };
}
