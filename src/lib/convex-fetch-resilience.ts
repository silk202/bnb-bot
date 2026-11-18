/**
 * Convex HTTP resilience — fixes the preview's "TypeError: Failed to fetch"
 * build error at the transport layer.
 *
 * Root cause (from the stack trace):
 *   `ConvexHttpClient.action` → `unauthenticatedCall` → `fetch` →
 *   `TypeError: Failed to fetch`
 *
 * Two independent fetch layers reach the Convex backend in this app:
 *   1. `ConvexReactClient` (queries/mutations/subscriptions + auth token refresh)
 *   2. `ConvexHttpClient` inside @convex-dev/auth's `unauthenticatedCall`
 *      (the anonymous/refresh-token action handshake)
 *
 * The Daytona preview proxy is the weak hop in both paths: under load or at
 * cold start it can drop a request at the network layer, which surfaces to the
 * caller as a bare `TypeError: Failed to fetch`. `ConvexReactClient` has its
 * own backoff-reconnect for subscriptions, but the one-shot calls
 * (auth handshake, queries, mutations, actions) do NOT retry — the first
 * dropped request kills the boot and the error boundary renders the failure.
 *
 * The fix: patch the global fetch once at boot, before the Convex clients are
 * constructed, wrapping ONLY requests aimed at the Convex backend with a
 * capped exponential-backoff retry. Requests already aborted via AbortSignal
 * are never retried (that would defeat deliberate cancellation), and
 * non-Convex requests (market data, RPCs, the overlay downloads) pass through
 * untouched — zero behavioral change for them.
 *
 * Retry budget (mirrors the retryableLazy chunk loader already in main.tsx):
 *   attempts 1..3 → backoff 500ms, 1s, 2s → total worst-case ~3.5s, which
 *   rides out every transient proxy drop observed in this environment.
 */

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 2000;

/** True when this exact request already failed with a network-level error. */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Capped exponential backoff for the retry sequence. */
function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

/** Extract the Convex deployment origin (or null) from a URL string. */
export function convexOriginFrom(url: string): string | null {
  try {
    const parsed = new URL(url, globalThis.location?.href ?? "https://localhost");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    // Client-facing Convex deployments live on *.convex.cloud.
    if (parsed.hostname.endsWith(".convex.cloud")) return parsed.origin;
    // The auth handshake can also target the preview proxy with a Convex path.
    if (
      (parsed.pathname.includes("/_convex") ||
        parsed.pathname.includes("/api/")) &&
      (parsed.hostname.endsWith("daytonaproxy01.net") ||
        parsed.hostname.includes("daytona") ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1")
    ) {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Install the retrying fetch. Idempotent: safe to call more than once
 * (subsequent calls are no-ops). Returns a restore function for teardown.
 */
let originalFetch: typeof globalThis.fetch | null = null;

const retryingFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (!originalFetch) return globalThis.fetch(input, init);

  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const isConvex = convexOriginFrom(url) !== null;

  if (!isConvex) {
    return originalFetch(input, init);
  }

  // Respect caller cancellation: if an AbortSignal is provided, surface it
  // untouched — the Convex clients use it for subscription teardown.
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) {
    return originalFetch(input, init);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, backoffDelay(attempt - 1)),
      );
      if (signal?.aborted) {
        // Caller cancelled mid-retry — stop immediately.
        return originalFetch(input, init);
      }
    }
    try {
      return await originalFetch(input, init);
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}) as unknown as typeof globalThis.fetch;

export function installConvexFetchRetry(): () => void {
  if (originalFetch) return uninstallConvexFetchRetry;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = retryingFetch;
  return uninstallConvexFetchRetry;
}

/** Restore the pre-install fetch (used by tests and hot reboots). */
export function uninstallConvexFetchRetry(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
