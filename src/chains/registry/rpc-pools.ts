/**
 * Endpoint discovery from configured pools.
 *
 * Operators commonly put several chains' endpoints in one variable (this
 * project's BSC mainnet/testnet entries contain the Base and Optimism URLs).
 * Variable names therefore cannot identify a chain — only `eth_chainId` can.
 *
 * So: gather every configured URL, probe it once, and file it under the chain it
 * actually reports. Nothing is guessed from the hostname, and an endpoint that
 * fails the probe is dropped rather than "assigned" to a chain by name.
 */
import { rpcCall } from "../../lib/json-rpc";

export interface PooledEndpoint {
  url: string;
  /** Variable/section the URL came from — for diagnostics, never for assignment. */
  source: string;
}

export interface ChainDiscovery {
  /** chainId → endpoints that proved it. */
  byChain: Map<number, string[]>;
  /** Endpoints that answered with an unexpected or no chain id. */
  rejected: { url: string; reason: string }[];
  probedAt: number;
}

const HTTP = /^https?:\/\/[^\s]+$/i;

/** Every configured URL, from runtime injection and `VITE_` env, deduplicated. */
export function endpointPool(): PooledEndpoint[] {
  const holder = globalThis as {
    __FLASHBOLT_RPC__?: Record<string, unknown> & { env?: Record<string, unknown> };
  };
  const runtime = holder.__FLASHBOLT_RPC__ ?? {};
  const seen = new Set<string>();
  const out: PooledEndpoint[] = [];

  const push = (raw: unknown, source: string) => {
    if (typeof raw !== "string") return;
    for (const value of raw.split(/[,\s]+/)) {
      const url = value.trim();
      if (!HTTP.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, source });
    }
  };

  // Runtime blocks injected by the site Worker: per-network entries first…
  for (const [key, value] of Object.entries(runtime)) {
    if (key === "env") continue;
    if (typeof value === "string") push(value, key);
    else if (value && typeof value === "object") {
      const entry = value as { http?: unknown; websocket?: unknown };
      for (const item of toArray(entry.http)) push(item, key);
      for (const item of toArray(entry.websocket)) push(item, `${key}.ws`);
    }
  }
  // …then the raw configured values (this is where chained lists live).
  const env = runtime.env;
  if (env && typeof env === "object") {
    for (const [name, value] of Object.entries(env)) {
      if (!/(RPC_URL|RPC_URLS|WEBSOCKET|_WS_URL)$/i.test(name)) continue;
      push(value, `env:${name}`);
    }
  }
  return out;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

let cache: ChainDiscovery | undefined;
const CACHE_MS = 5 * 60_000;
const STORAGE_KEY = "flashbolt.rpc.discovery.v1";
/**
 * Browser storage is a CACHE ONLY. It may speed up endpoint selection, but it
 * never establishes trust: a chain id stored here is re-proved against the
 * endpoint before any persisted entry is used. Contracts, activations and
 * approvals never come from this cache.
 *
 * Persisted mappings go stale immediately if a provider is rerouted.
 */
const STORAGE_TTL_MS = 10 * 60_000;

function loadPersisted(now: () => number): ChainDiscovery | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { probedAt?: number; byChain?: [number, string[]][] };
    if (!parsed.probedAt || now() - parsed.probedAt > STORAGE_TTL_MS) return undefined;
    const byChain = new Map<number, string[]>();
    for (const [chainId, urls] of parsed.byChain ?? []) {
      if (!Number.isFinite(chainId) || !Array.isArray(urls)) continue;
      const valid = urls.filter((url) => typeof url === "string" && HTTP.test(url));
      if (valid.length > 0) byChain.set(chainId, valid);
    }
    if (byChain.size === 0) return undefined;
    return { byChain, rejected: [], probedAt: parsed.probedAt };
  } catch {
    return undefined;
  }
}

function persist(discovery: ChainDiscovery): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ probedAt: discovery.probedAt, byChain: [...discovery.byChain] }),
    );
  } catch {
    // Storage full/denied: discovery still works for this session.
  }
}

/** Probe each pooled endpoint once and group it by the chain id it reports. */
/**
 * Re-prove a persisted cache before using it.
 *
 * Every cached URL must still answer `eth_chainId` with the chain id it is
 * filed under. Anything that fails is dropped; if nothing survives, the caller
 * falls back to a full probe. This is what keeps a tampered `localStorage`
 * entry from steering execution at an endpoint the app never proved.
 */
async function revalidatePersisted(
  persisted: ChainDiscovery,
  timeoutMs: number,
): Promise<ChainDiscovery | undefined> {
  const byChain = new Map<number, string[]>();
  const rejected: { url: string; reason: string }[] = [];
  for (const [chainId, urls] of persisted.byChain) {
    const results = await Promise.all(
      urls.slice(0, 3).map(async (url) => {
        try {
          const hex = await rpcCall<string>(url, "eth_chainId", [], timeoutMs);
          const proven = Number.parseInt(hex, 16);
          if (proven === chainId) return { url, ok: true, reason: "" };
          return { url, ok: false, reason: `chain id changed (${proven} ≠ ${chainId})` };
        } catch (e) {
          return { url, ok: false, reason: e instanceof Error ? e.message : "unreachable" };
        }
      }),
    );
    for (const result of results) {
      if (result.ok) {
        const list = byChain.get(chainId) ?? [];
        list.push(result.url);
        byChain.set(chainId, list);
      } else {
        rejected.push({ url: result.url, reason: `cached entry rejected: ${result.reason}` });
      }
    }
  }
  if (byChain.size === 0) return undefined;
  return { byChain, rejected, probedAt: Date.now() };
}

export async function discoverEndpointsByChain(
  opts: { timeoutMs?: number; force?: boolean; now?: () => number } = {},
): Promise<ChainDiscovery> {
  const now = opts.now ?? Date.now;
  if (!opts.force && cache && now() - cache.probedAt < CACHE_MS) return cache;
  const timeoutMs = opts.timeoutMs ?? 6_000;
  if (!opts.force && !cache) {
    const persisted = loadPersisted(now);
    if (persisted) {
      // A cache hit still has to prove the chain ids it claims.
      const verified = await revalidatePersisted(persisted, timeoutMs);
      if (verified) {
        cache = { ...verified, probedAt: now() };
        persist(cache);
        return cache;
      }
    }
  }

  const pool = endpointPool();
  const timeout = timeoutMs;
  const byChain = new Map<number, string[]>();
  const rejected: { url: string; reason: string }[] = [];

  // Bounded concurrency: these are public endpoints and this runs on page load.
  for (let i = 0; i < pool.length; i += 6) {
    const batch = pool.slice(i, i + 6);
    const results = await Promise.all(
      batch.map(async (endpoint) => {
        try {
          const hex = await rpcCall<string>(endpoint.url, "eth_chainId", [], timeout);
          const chainId = Number.parseInt(hex, 16);
          if (!Number.isFinite(chainId) || chainId <= 0) {
            return { endpoint, chainId: 0, reason: `invalid chain id ${hex}` };
          }
          return { endpoint, chainId, reason: "" };
        } catch (e) {
          return {
            endpoint,
            chainId: 0,
            reason: e instanceof Error ? e.message : "unreachable",
          };
        }
      }),
    );
    for (const result of results) {
      if (result.chainId > 0) {
        const list = byChain.get(result.chainId) ?? [];
        list.push(result.endpoint.url);
        byChain.set(result.chainId, list);
      } else {
        rejected.push({ url: result.endpoint.url, reason: result.reason });
      }
    }
  }

  cache = { byChain, rejected, probedAt: now() };
  persist(cache);
  return cache;
}

export function clearEndpointDiscovery(): void {
  cache = undefined;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Last discovery result, if any — used by rpc-registry without a probe. */
export function discoveryCache(): ChainDiscovery | undefined {
  return cache;
}
