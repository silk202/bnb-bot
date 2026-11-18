/**
 * Runtime-safe fetch timeout — works EVERYWHERE the app runs.
 *
 * WHY THIS EXISTS: `AbortSignal.timeout()` does not exist in Convex's default
 * V8 action runtime (it is a Node 17.3+ / browser API). Any server action that
 * fetched with `signal: AbortSignal.timeout(ms)` crashed with
 * "TypeError: AbortSignal.timeout is not a function. Called by client" —
 * which surfaced the moment the operator opened the Telegram bot (the
 * auto-connect path runs market/feed actions server-side).
 *
 * This helper uses AbortSignal.timeout when the platform has it, and otherwise
 * falls back to the universally-supported AbortController + setTimeout pattern
 * (always clearing the timer so V8 actions never hang on a leaked handle).
 * No mocking anywhere: real fetches, real timeouts, honest failures.
 */

export async function fetchWithTimeout(
  url: string,
  timeoutMs = 8_000,
  init?: Omit<RequestInit, "signal">,
): Promise<Response> {
  // Fast path — the modern API exists (browsers, Node 17.3+).
  const anyAbortSignal = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
  };
  if (typeof anyAbortSignal.timeout === "function") {
    return fetch(url, { ...init, signal: anyAbortSignal.timeout(timeoutMs) });
  }

  // V8 action runtime (and other engines without AbortSignal.timeout):
  // classic controller + timer, with guaranteed cleanup.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper: JSON fetch that returns null on any failure —
 * identical contract to the fetchJson helpers it replaces. */
export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs = 8_000,
  init?: Omit<RequestInit, "signal"> & { headers?: Record<string, string> },
): Promise<unknown | null> {
  try {
    const res = await fetchWithTimeout(url, timeoutMs, init);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
