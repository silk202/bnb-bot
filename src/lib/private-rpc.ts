/**
 * Private-RPC submission — the anti-front-running broadcast layer.
 *
 * When enabled, a transaction's SIGNED bytes are broadcast to a private
 * relay endpoint instead of the public mempool:
 *
 *   • Flashbots Protect (Ethereum) — private orderflow auction; a tx that
 *     reverts is NEVER landed on chain, so failed txs cost zero gas.
 *   • bloXroute Protect (BSC + Ethereum) — bypasses the public P2P network
 *     and is delivered directly to block proposers/builders, hiding the tx
 *     from sandwich bots until inclusion.
 *
 * Every endpoint below is a real, publicly documented service URL. Nothing
 * is mocked: when no private endpoint exists for a chain/network the
 * resolver returns null and callers fall back to the standard public RPC —
 * honestly reported, never faked.
 *
 * NOTE: these endpoints accept a standard `eth_sendRawTransaction` with the
 * fully signed tx bytes — no API key required for the base tier.
 */

// ---------------------------------------------------------------------------
// Registry (documented endpoints — see docs.flashbots.net / docs.bloxroute.com)
// ---------------------------------------------------------------------------

/** Network scope used throughout the private-submission layer. */
export type PrivateSubmitNetwork = "mainnet" | "testnet";

const PRIVATE_RPC_SETS: Record<number, Record<PrivateSubmitNetwork, string[]>> = {
  // Ethereum mainnet — Flashbots Protect (fast mode) + bloXroute Protect
  1: {
    mainnet: ["https://rpc.flashbots.net/fast", "https://eth-protect.rpc.blxrbdn.com"],
    testnet: [],
  },
  // Ethereum Sepolia — Flashbots Protect testnet
  11155111: {
    mainnet: [],
    testnet: ["https://rpc-sepolia.flashbots.net"],
  },
  // BNB Smart Chain — bloXroute Protect (private to BSC block builders)
  56: {
    mainnet: ["https://bsc.rpc.blxrbdn.com"],
    testnet: [],
  },
};

/**
 * The first private RPC for a chainId/network, or null when the chain has no
 * public no-key private relay (Arbitrum, Polygon, BSC testnet → honest null).
 */
export function resolvePrivateRpc(chainId: number, network: PrivateSubmitNetwork): string | null {
  const nets = PRIVATE_RPC_SETS[chainId];
  if (!nets) return null;
  const set = network === "testnet" ? nets.testnet : nets.mainnet;
  return set[0] ?? null;
}

/** All private RPCs registered for a chainId/network (for racing/probing). */
export function privateRpcSet(chainId: number, network: "mainnet" | "testnet"): string[] {
  const nets = PRIVATE_RPC_SETS[chainId];
  if (!nets) return [];
  return network === "testnet" ? [...nets.testnet] : [...nets.mainnet];
}

/** True when a real private relay exists for this chain/network. */
export function isPrivateRpcAvailable(chainId: number, network: "mainnet" | "testnet"): boolean {
  return resolvePrivateRpc(chainId, network) !== null;
}

// ---------------------------------------------------------------------------
// Live probe (verification / UI status — NOT on the execution hot path)
// ---------------------------------------------------------------------------

/**
 * Probe a private relay exactly like any RPC: ask for its eth_chainId.
 * Returns the latency in ms when the endpoint answers with the expected
 * chain, or null when unreachable/wrong chain. Read-only — broadcasts nothing.
 */
export async function probePrivateRpc(
  chainId: number,
  network: PrivateSubmitNetwork,
  timeoutMs = 4_000,
): Promise<{ ok: boolean; latencyMs: number; endpoint: string | null; error?: string }> {
  const t0 = performance.now();
  const endpoint = resolvePrivateRpc(chainId, network);
  if (!endpoint) {
    return { ok: false, latencyMs: 0, endpoint: null, error: "no private relay for this chain/network" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    const latencyMs = performance.now() - t0;
    if (json.error) return { ok: false, latencyMs, endpoint, error: json.error.message ?? "RPC error" };
    if (Number.parseInt(json.result ?? "0x0", 16) !== chainId) {
      return { ok: false, latencyMs, endpoint, error: `chainId mismatch: ${json.result}` };
    }
    return { ok: true, latencyMs, endpoint };
  } catch (err) {
    return {
      ok: false,
      latencyMs: performance.now() - t0,
      endpoint,
      error: err instanceof Error ? err.message : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Per-endpoint probe result (for status UIs). */
export interface PrivateRpcProbe {
  endpoint: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Probe EVERY registered private relay for a chain/network with eth_chainId.
 * Read-only — broadcasts nothing. Used by the relay status card.
 */
export async function probeAllPrivateRpcs(
  chainId: number,
  network: PrivateSubmitNetwork,
  timeoutMs = 4_000,
): Promise<PrivateRpcProbe[]> {
  const endpoints = privateRpcSet(chainId, network);
  if (endpoints.length === 0) return [];
  return Promise.all(
    endpoints.map(async (endpoint): Promise<PrivateRpcProbe> => {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: string; error?: { message?: string } };
        const latencyMs = performance.now() - t0;
        if (json.error) {
          recordRelayFailure(endpoint, json.error.message ?? "RPC error");
          return { endpoint, ok: false, latencyMs, error: json.error.message ?? "RPC error" };
        }
        if (Number.parseInt(json.result ?? "0x0", 16) !== chainId) {
          recordRelayFailure(endpoint, `chainId mismatch: ${json.result}`);
          return { endpoint, ok: false, latencyMs, error: `chainId mismatch: ${json.result}` };
        }
        recordRelaySuccess(endpoint);
        return { endpoint, ok: true, latencyMs };
      } catch (err) {
        const message = err instanceof Error ? err.message : "unreachable";
        recordRelayFailure(endpoint, message);
        return {
          endpoint,
          ok: false,
          latencyMs: performance.now() - t0,
          error: message,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Relay health — consecutive-failure tracking with auto-degradation
// ---------------------------------------------------------------------------

/** Relays failing this many consecutive broadcasts/probes go into cooldown. */
export const RELAY_FAIL_THRESHOLD = 3;
/** How long a degraded relay is skipped before being retried. */
export const RELAY_COOLDOWN_MS = 5 * 60_000;

export interface RelayHealth {
  consecutiveFails: number;
  degradedUntil: number | null;
  lastError?: string;
  lastFailAt?: number;
  lastSuccessAt?: number;
}

const relayHealth = new Map<string, RelayHealth>();

export function getRelayHealth(endpoint: string): RelayHealth {
  return (
    relayHealth.get(endpoint) ?? {
      consecutiveFails: 0,
      degradedUntil: null,
    }
  );
}

/** Clear tracked health for one endpoint (or all when omitted). */
export function resetRelayHealth(endpoint?: string): void {
  if (endpoint) relayHealth.delete(endpoint);
  else relayHealth.clear();
}

export function recordRelaySuccess(endpoint: string): void {
  const prev = relayHealth.get(endpoint);
  relayHealth.set(endpoint, {
    consecutiveFails: 0,
    degradedUntil: null,
    lastSuccessAt: Date.now(),
    lastError: prev?.lastError,
    lastFailAt: prev?.lastFailAt,
  });
}

/**
 * Record a relay that could not be reached. After RELAY_FAIL_THRESHOLD
 * consecutive unreachable measurements the relay is degraded for
 * RELAY_COOLDOWN_MS — broadcasts skip it so trades never wait on a dead
 * endpoint. A single success resets the counter.
 */
export function recordRelayFailure(endpoint: string, error?: string): void {
  const prev = relayHealth.get(endpoint) ?? {
    consecutiveFails: 0,
    degradedUntil: null as number | null,
  };
  const consecutiveFails = prev.consecutiveFails + 1;
  const now = Date.now();
  relayHealth.set(endpoint, {
    ...prev,
    consecutiveFails,
    lastError: error,
    lastFailAt: now,
    degradedUntil:
      consecutiveFails >= RELAY_FAIL_THRESHOLD
        ? now + RELAY_COOLDOWN_MS
        : prev.degradedUntil,
  });
}

/** True while a relay is serving its consecutive-failure cooldown. */
export function isRelayDegraded(endpoint: string): boolean {
  const h = relayHealth.get(endpoint);
  if (!h?.degradedUntil) return false;
  return Date.now() <= h.degradedUntil;
}

// ---------------------------------------------------------------------------
// Latency-ranked relay routing
// ---------------------------------------------------------------------------

/** Ranking is refreshed at most this often (probes are read-only + cheap). */
const RANK_TTL_MS = 60_000;

const rankCache = new Map<
  string,
  { order: string[]; measuredAt: number }
>();

function rankKey(chainId: number, network: PrivateSubmitNetwork): string {
  return `${chainId}:${network}`;
}

/**
 * Pure ranking: reachable relays first (fastest latency first), unreachable
 * relays last (kept so failover can still attempt them).
 */
export function orderEndpointsByLatency(probes: PrivateRpcProbe[]): string[] {
  return [...probes]
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.ok) return a.latencyMs - b.latencyMs;
      return a.endpoint.localeCompare(b.endpoint);
    })
    .map((p) => p.endpoint);
}

/** Store a fresh latency ranking (called after every probe round). */
export function cacheLatencyRanking(
  chainId: number,
  network: PrivateSubmitNetwork,
  probes: PrivateRpcProbe[],
): string[] {
  const order = orderEndpointsByLatency(probes);
  rankCache.set(rankKey(chainId, network), { order, measuredAt: Date.now() });
  return order;
}

/**
 * The best-known relay order for a chain/network — the FASTEST measured
 * relay first — or null when nothing has been probed yet or the ranking is
 * older than the TTL (broadcast then uses the registry order and a
 * background probe refreshes the ranking).
 */
export function currentPrivateRpcRanking(
  chainId: number,
  network: PrivateSubmitNetwork,
): string[] | null {
  const entry = rankCache.get(rankKey(chainId, network));
  if (!entry) return null;
  if (Date.now() - entry.measuredAt > RANK_TTL_MS) return null;
  return entry.order;
}

/**
 * AUTO-FAILOVER: true when EVERY registered relay for a chain/network is
 * currently serving its consecutive-failure cooldown (e.g. 3 failed
 * broadcasts in a row each). While degraded, hot-wallet submission for the
 * chain skips the relay path entirely and broadcasts through the public RPC
 * until a cooldown expires or a probe/broadcast succeeds again.
 */
export function isChainPrivateSubmitDegraded(
  chainId: number,
  network: PrivateSubmitNetwork,
): boolean {
  const relays = privateRpcSet(chainId, network);
  return relays.length > 0 && relays.every((endpoint) => isRelayDegraded(endpoint));
}

/**
 * Probe all relays and cache the ranking. Never called on the broadcast hot
 * path (probing there would add round-trip latency to a trade) — used by the
 * relay status card and explicit refreshes; the cache it fills is what the
 * hot path reads.
 */
export async function rankedPrivateRpcs(
  chainId: number,
  network: PrivateSubmitNetwork,
): Promise<string[]> {
  const probes = await probeAllPrivateRpcs(chainId, network);
  return cacheLatencyRanking(chainId, network, probes);
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * Broadcast a SIGNED raw transaction through the private relays, to the
 * FASTEST measured relay first with automatic failover: if a relay is
 * unreachable or rejects the tx, the next relay in the ranking is tried —
 * the last one is the honest public-fallback error only after ALL relays
 * fail. The bytes are the same standard signed tx the public path would
 * send — relays just keep them out of the public mempool until inclusion.
 *
 * The hot path performs NO probing: it reads the best-known ranking (filled
 * by the relay status card / explicit probes) and falls back to registry
 * order. A background probe bootstraps the ranking on first use without
 * delaying the send.
 *
 * Throws an honest error when no relay exists for the chain/network —
 * callers must fall back to the public RPC themselves (and say so).
 */
export async function sendRawPrivate(
  signedTx: string,
  chainId: number,
  network: PrivateSubmitNetwork,
  timeoutMs = 10_000,
): Promise<{ txHash: `0x${string}`; endpoint: string }> {
  const registry = privateRpcSet(chainId, network);
  if (registry.length === 0) {
    throw new Error(`No private relay available for chainId ${chainId} (${network}) — use the public RPC path.`);
  }
  // Bootstrap the latency ranking in the background on first use — never
  // awaited: the broadcast below must not wait on probe round-trips.
  if (!currentPrivateRpcRanking(chainId, network)) {
    void rankedPrivateRpcs(chainId, network).catch(() => undefined);
  }
  const ranking = currentPrivateRpcRanking(chainId, network);
  const ordered =
    ranking && ranking.length === registry.length
      ? ranking
      : registry;
  // Health-aware attempt order: healthy relays first (fastest ranking),
  // degraded relays last so a dying endpoint never delays a trade.
  const relays = [
    ...ordered.filter((e) => !isRelayDegraded(e)),
    ...ordered.filter((e) => isRelayDegraded(e)),
  ];

  let lastError: Error | null = null;
  for (const endpoint of relays) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTx] }),
        signal: ctrl.signal,
      });
      const json = (await res.json()) as {
        result?: string;
        error?: { message?: string; data?: string };
      };
      if (json.error) {
        // The relay ANSWERED and refused the tx — that is a deliberate
        // rejection (e.g. policy), not an outage: it proves reachability,
        // so it resets the consecutive-failure counter.
        recordRelaySuccess(endpoint);
        lastError = new Error(
          `Private relay rejected the tx: ${json.error.message ?? json.error.data ?? "error"}`,
        );
        continue; // relay said no → failover to the next relay
      }
      if (!json.result || typeof json.result !== "string" || !json.result.startsWith("0x")) {
        recordRelaySuccess(endpoint);
        lastError = new Error("Private relay returned no tx hash");
        continue;
      }
      recordRelaySuccess(endpoint);
      return { txHash: json.result as `0x${string}`, endpoint };
    } catch (err) {
      // Unreachable — counts toward the consecutive-failure threshold.
      recordRelayFailure(endpoint, err instanceof Error ? err.message : "unreachable");
      lastError = err instanceof Error ? err : new Error("relay unreachable");
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("All private relays failed");
}
