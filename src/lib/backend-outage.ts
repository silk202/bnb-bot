import { useSyncExternalStore } from "react";

/**
 * Backend-outage handling — graceful degradation while the Convex deployment
 * is paused (e.g. the team hit the free-plan ceiling and serving was disabled
 * team-wide, returning HTTP 500 "You have exceeded the free plan limits…"
 * for every query, mutation, action and HTTP route).
 *
 * Goals:
 *   1. DETECT that specific failure class anywhere it surfaces (useQuery
 *      render errors, mutation rejections, auth handshakes) — precisely, so
 *      genuine bugs never get masked by it.
 *   2. Never show the raw 500 body or a stack wall to end users — swap in a
 *      short, honest, human message.
 *   3. Let the React tree ask "is the backend currently down?" via a tiny
 *      framework store, so spinner-forever states (auth boot) can render a
 *      calm paused-notice instead.
 *
 * The flag clears automatically the moment the backend serves again: queries
 * stop throwing, the boundary resets, and the app is whole — no deploy needed.
 */

/** The exact plan-limit body Convex serves while serving is disabled. */
const PAUSED_PHRASE = "exceeded the free plan limits";

/** Short, user-facing explanation reused by every degraded surface. */
export const BACKEND_PAUSED_MESSAGE =
  "The FlashBolt backend is temporarily paused. All data is preserved and everything resumes automatically once it's back online.";

/**
 * True when this thrown/rejected value is the backend-paused failure.
 * Tolerant of shapes: Error objects, plain strings, Convex error objects
 * (message/data fields), and prefixed render wrappers like
 * "Uncaught Error: You have exceeded…". Never throws. Case-insensitive.
 */
export function isBackendPausedError(err: unknown): boolean {
  if (err == null) return false;
  const parts: string[] = [];
  if (typeof err === "string") {
    parts.push(err);
  } else {
    const candidate = err as { message?: unknown; data?: unknown };
    if (typeof candidate.message === "string") parts.push(candidate.message);
    if (typeof candidate.data === "string") parts.push(candidate.data);
  }
  // Last resort for exotic error classes whose text only shows in toString.
  try {
    const s = String(err);
    if (s && s !== "[object Object]") parts.push(s);
  } catch {
    // toString throwing is fine — the explicit fields above are enough.
  }
  return parts.some((p) => p.toLowerCase().includes(PAUSED_PHRASE));
}

/**
 * Map any caught error to a user-safe message: the paused-backend case gets
 * the friendly outage copy; app-authored Errors pass through as-is; anything
 * exotic falls back to the caller's generic line. Never throws.
 */
export function userSafeBackendError(err: unknown, fallback: string): string {
  if (isBackendPausedError(err)) return BACKEND_PAUSED_MESSAGE;
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Outage flag store — lets non-boundary components see the outage.    */
/* ------------------------------------------------------------------ */

let outageActive = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Mark the backend as currently paused (idempotent, notifies once). */
export function markBackendOutage(): void {
  if (outageActive) return;
  outageActive = true;
  emit();
}

/** Clear the outage flag — called on recovery or a manual retry. */
export function clearBackendOutage(): void {
  if (!outageActive) return;
  outageActive = false;
  emit();
}

/** Read the flag without subscribing (SSR-safe snapshot). */
export function getBackendOutage(): boolean {
  return outageActive;
}

/** Subscribe to flag changes; returns the unsubscribe function. */
export function subscribeBackendOutage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: is the backend currently known to be paused? */
export function useBackendOutage(): boolean {
  return useSyncExternalStore(subscribeBackendOutage, getBackendOutage, getBackendOutage);
}

/* ------------------------------------------------------------------ */
/* Recovery probe — used by the standby screen to self-heal.           */
/* ------------------------------------------------------------------ */

let recoveryProbe: (() => Promise<boolean>) | null = null;

/**
 * Register how to check whether the backend serves again. Called once from
 * main.tsx with the live Convex client. Passing null unregisters (tests).
 */
export function setBackendRecoveryProbe(fn: (() => Promise<boolean>) | null): void {
  recoveryProbe = fn;
}

/**
 * Run the registered probe. Resolves true only when the backend answers a
 * live query again; any failure (including the paused 500) resolves false.
 * With no probe registered this resolves false — never throws.
 */
export async function probeBackendRecovered(): Promise<boolean> {
  if (!recoveryProbe) return false;
  try {
    return await recoveryProbe();
  } catch {
    return false;
  }
}
