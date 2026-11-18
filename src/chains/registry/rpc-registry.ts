/**
 * RPC configuration per network.
 *
 * Sources, in precedence order:
 *   1. runtime injection — `globalThis.__FLASHBOLT_RPC__[KEY]` (a JSON map the
 *      host page/Worker can set; this is how non-`VITE_` secrets reach a static
 *      bundle without being compiled in),
 *   2. build-time `VITE_` variables:
 *        VITE_RPC_<KEY>            comma-separated HTTP endpoints
 *        VITE_RPC_WS_<KEY>         comma-separated WebSocket endpoints
 *      plus the documented aliases below (BASE_MAINNET_RPC_URL …), which are
 *      honoured when the host exposes them with a VITE_ prefix — a plain
 *      server-side secret is not visible to the browser bundle.
 *   3. the public endpoints this repository already uses, until an operator
 *      supplies a private one.
 *
 * Every value is validated as an http(s)/ws(s) URL before use; a malformed
 * value is ignored rather than passed to the chain.
 */
import type { NetworkEnvironment } from "./chain-types";
import { discoveryCache } from "./rpc-pools";
import { validatedRpcUrls } from "./discovery-store";

export interface RpcConfig {
  http: string[];
  websocket: string[];
  /** Where the list came from — surfaced so the dashboard never overstates it. */
  source: "validated" | "runtime" | "env" | "public-verified" | "none";
  /** Names that were looked for, so an operator can see what to set. */
  expectedNames: string[];
}

const PUBLIC_HTTP: Readonly<Record<string, string[]>> = {
  bsc: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc.drpc.org",
    "https://1rpc.io/bnb",
  ],
  "bsc-testnet": [
    "https://data-seed-prebsc-1-s1.binance.org:8545",
    "https://bsc-testnet-rpc.publicnode.com",
    "https://bsc-testnet.drpc.org",
  ],
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth"],
  "ethereum-sepolia": ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  "arbitrum-sepolia": ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia.drpc.org"],
  polygon: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  "polygon-amoy": ["https://rpc-amoy.polygon.technology", "https://polygon-amoy.drpc.org"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  "base-sepolia": ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  "optimism-sepolia": ["https://sepolia.optimism.io", "https://optimism-sepolia-rpc.publicnode.com"],
};

/**
 * Alias names an operator may have used in project settings, per network.
 * The BSC/WS names are the ones this project already documents; the Base names
 * match the "mainnet + testnet RPC URL" pair operators typically create.
 */
const ALIASES: Readonly<Record<string, string[]>> = {
  bsc: ["BSC_MAINNET_RPC_URL", "BNB_MAINNET_RPC_URL"],
  "bsc-testnet": ["BSC_TESTNET_RPC_URL", "BNB_TESTNET_RPC_URL"],
  ethereum: ["ETH_MAINNET_RPC_URL", "ETHEREUM_MAINNET_RPC_URL"],
  "ethereum-sepolia": ["ETH_SEPOLIA_RPC_URL", "SEPOLIA_RPC_URL", "ETHEREUM_SEPOLIA_RPC_URL"],
  arbitrum: ["ARBITRUM_MAINNET_RPC_URL"],
  "arbitrum-sepolia": ["ARBITRUM_SEPOLIA_RPC_URL"],
  polygon: ["POLYGON_MAINNET_RPC_URL"],
  "polygon-amoy": ["POLYGON_AMOY_RPC_URL"],
  base: ["BASE_MAINNET_RPC_URL", "BASE_RPC_URL"],
  "base-sepolia": ["BASE_TESTNET_RPC_URL", "BASE_SEPOLIA_RPC_URL"],
  optimism: ["OPTIMISM_MAINNET_RPC_URL", "OP_MAINNET_RPC_URL"],
  "optimism-sepolia": ["OPTIMISM_SEPOLIA_RPC_URL", "OP_SEPOLIA_RPC_URL"],
};

const WS_ALIASES: Readonly<Record<string, string[]>> = {
  bsc: ["WEBSOCKET_MAINNET_URL", "BSC_MAINNET_WS_URL"],
  "bsc-testnet": ["WEBSOCKET_TESTNET_URL", "BSC_TESTNET_WS_URL"],
  base: ["BASE_MAINNET_WS_URL"],
  "base-sepolia": ["BASE_TESTNET_WS_URL"],
};

const envKey = (key: string): string => key.replace(/-/g, "_").toUpperCase();

/** Registry key → chain id. Static and real: these are the identities we verify against. */
const CHAIN_ID_BY_KEY: Readonly<Record<string, number>> = {
  bsc: 56,
  "bsc-testnet": 97,
  ethereum: 1,
  "ethereum-sepolia": 11155111,
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  polygon: 137,
  "polygon-amoy": 80002,
  base: 8453,
  "base-sepolia": 84532,
  optimism: 10,
  "optimism-sepolia": 11155420,
};
const HTTP_URL = /^https?:\/\/[^\s]+$/i;
const WS_URL = /^wss?:\/\/[^\s]+$/i;

function runtimeMap(): Record<string, unknown> {
  const holder = globalThis as { __FLASHBOLT_RPC__?: Record<string, unknown> };
  if (holder.__FLASHBOLT_RPC__) return holder.__FLASHBOLT_RPC__;
  // The site Worker injects project-settings endpoints as a JSON data block
  // (sites/worker.js). Reading it here means a new RPC URL takes effect on the
  // next page load without rebuilding the bundle.
  if (typeof document !== "undefined") {
    const node = document.getElementById("flashbolt-rpc-config");
    if (node?.textContent) {
      try {
        const parsed = JSON.parse(node.textContent) as unknown;
        if (parsed && typeof parsed === "object") {
          holder.__FLASHBOLT_RPC__ = parsed as Record<string, unknown>;
          return holder.__FLASHBOLT_RPC__;
        }
      } catch {
        // A malformed block is ignored; public endpoints still apply.
      }
    }
  }
  return {};
}

function fromRuntime(key: string): { http: string[]; ws: string[] } {
  const value = runtimeMap()[envKey(key)];
  if (typeof value === "string") {
    return { http: split(value).filter((u) => HTTP_URL.test(u)), ws: [] };
  }
  if (value && typeof value === "object") {
    const obj = value as { http?: unknown; websocket?: unknown; ws?: unknown };
    const http = Array.isArray(obj.http) ? obj.http.filter((u): u is string => typeof u === "string" && HTTP_URL.test(u)) : [];
    const wsRaw = Array.isArray(obj.websocket) ? obj.websocket : Array.isArray(obj.ws) ? obj.ws : [];
    const ws = wsRaw.filter((u): u is string => typeof u === "string" && WS_URL.test(u));
    return { http, ws };
  }
  return { http: [], ws: [] };
}

const split = (raw: string): string[] =>
  raw
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Vite's `import.meta.env`, read defensively.
 *
 * Vite replaces this expression at build time, so the browser path is exactly
 * as before. The Convex runtime evaluates modules in an isolate where
 * `import.meta` is unsupported and throws on access — this module is reachable
 * from the backend's import graph (convex/http.ts → … → lib/chains.ts), so an
 * unguarded read broke `convex deploy` with "import.meta unsupported". The
 * guard keeps the backend buildable; server-side code has no VITE_ env anyway.
 */
function viteEnv(): Record<string, unknown> {
  try {
    return (import.meta as { env?: Record<string, unknown> }).env ?? {};
  } catch {
    return {};
  }
}

function envValue(name: string): string | undefined {
  const env = viteEnv();
  const direct = env[`VITE_${name}`];
  if (typeof direct === "string" && direct.trim()) return direct;
  // A runtime-injected alias (window.__FLASHBOLT_RPC__.env) also works.
  const injected = runtimeMap().env;
  if (injected && typeof injected === "object") {
    const aliased = (injected as Record<string, unknown>)[name];
    if (typeof aliased === "string" && aliased.trim()) return aliased;
  }
  return undefined;
}

function collect(key: string, aliases: readonly string[], pattern: RegExp): string[] {
  const names = [`RPC_${envKey(key)}`, ...aliases];
  const out: string[] = [];
  for (const name of names) {
    const raw = envValue(name);
    if (raw) out.push(...split(raw).filter((url) => pattern.test(url)));
  }
  return out;
}

export function expectedRpcNames(key: string): string[] {
  return [`VITE_RPC_${envKey(key)}`, ...(ALIASES[key] ?? []).map((n) => `VITE_${n}`)];
}

/**
 * Endpoints for a network, as a UNION rather than a replacement:
 *   discovered (proved chain id) → configured → verified public fallback.
 *
 * Using discovery *in addition* matters: a discovered endpoint may rate-limit
 * or go down, and dropping the verified public endpoints at that moment turns
 * one bad provider into a dead network.
 */
export function rpcFor(key: string, _environment: NetworkEnvironment): RpcConfig {
  const expectedNames = expectedRpcNames(key);
  const chainId = CHAIN_ID_BY_KEY[key];

  // Validated endpoints only, in the backend's order: operator `stored` rows
  // first, `discovered` rows second. Unvalidated discovery is deliberately NOT
  // used for execution — it is display/diagnostics only.
  const validated = chainId ? validatedRpcUrls(chainId) : { stored: [], discovered: [] };
  const runtime = fromRuntime(key);
  const configured = collect(key, ALIASES[key] ?? [], HTTP_URL);
  const ws = collect(key, [...(WS_ALIASES[key] ?? []), `RPC_WS_${envKey(key)}`], WS_URL);
  const fallback = PUBLIC_HTTP[key] ?? [];

  const seen = new Set<string>();
  const http: string[] = [];
  const push = (urls: string[]) => {
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      http.push(url);
    }
  };
  push(validated.stored);
  push(validated.discovered);
  push(runtime.http);
  push(configured);
  push(fallback);

  const source: RpcConfig["source"] =
    validated.stored.length + validated.discovered.length > 0
      ? "validated"
      : runtime.http.length > 0
        ? "runtime"
        : configured.length > 0
          ? "env"
          : fallback.length > 0
            ? "public-verified"
            : "none";

  return {
    http,
    websocket: [...new Set([...ws, ...runtime.ws])],
    source,
    expectedNames,
  };
}

/** Where each endpoint came from — for the diagnostics panel, never for signing. */
export function rpcProvenance(
  key: string,
): { url: string; origin: "validated" | "discovered" | "configured" | "public" }[] {
  const chainId = CHAIN_ID_BY_KEY[key];
  const validated = chainId ? validatedRpcUrls(chainId) : { stored: [], discovered: [] };
  const validatedUrls = new Set([...validated.stored, ...validated.discovered]);
  const discovered = new Set(chainId ? discoveryCache()?.byChain.get(chainId) ?? [] : []);
  const configured = new Set([
    ...fromRuntime(key).http,
    ...collect(key, ALIASES[key] ?? [], HTTP_URL),
  ]);
  return [...validatedUrls, ...(PUBLIC_HTTP[key] ?? []), ...discovered, ...configured]
    .filter((url, index, all) => all.indexOf(url) === index)
    .map((url) => ({
      url,
      origin: validatedUrls.has(url)
        ? "validated"
        : discovered.has(url)
          ? "discovered"
          : configured.has(url)
            ? "configured"
            : "public",
    }));
}

/** Every endpoint for a network, with the provider family it belongs to. */
export function rpcProviders(
  key: string,
  environment: NetworkEnvironment,
): { url: string; provider: string }[] {
  return rpcFor(key, environment).http.map((url) => ({ url, provider: safeHost(url) }));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
