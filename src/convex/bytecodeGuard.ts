/**
 * Server-side bytecode verification for executor approvals.
 *
 * The console reads `eth_getCode(executor)` and sends the keccak256 it observed,
 * but an approval is a server decision: a browser (or a hand-written mutation
 * call) could send a hash for code it never read, or for a contract that was
 * never deployed. Convex cannot fetch inside a mutation, so the reading happens
 * in the `inspectExecutorCode` action, which records what it saw; the pin
 * mutations then require that fresh evidence instead of trusting the caller.
 *
 * Failure is closed. If no RPC answers, nothing is recorded and nothing is
 * pinned — an approval must rest on code the backend actually observed.
 */
import { keccak256 } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Public fallbacks per chain id, used after the operator's validated RPCs. */
export const DEFAULT_RPC_BY_CHAIN: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  56: "https://bsc-dataseed.binance.org",
  97: "https://data-seed-prebsc-1-s1.binance.org:8545",
  137: "https://polygon-bor-rpc.publicnode.com",
  42161: "https://arb1.arbitrum.io/rpc",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  80002: "https://rpc-amoy.polygon.technology",
};

/** Runtime code as returned by eth_getCode (`0x` when nothing is deployed). */
export function hasRuntimeCode(code: string): boolean {
  return typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
}

/** keccak256 of the deployed runtime code, lower-case. */
export function runtimeCodeHash(code: string): string {
  return keccak256(code as `0x${string}`).toLowerCase();
}

export type CodeObservation =
  | { ok: true; hash: string; bytes: number; url: string }
  | { ok: false; code: "invalid-address" | "no-code" | "rpc"; message: string };

/** Pure comparison of the caller's hash with what the chain reported. */
export function compareObservedCode(args: {
  expected: string;
  observedHash: string;
  address: string;
}): { ok: boolean; message: string; hash: string } {
  const expected = args.expected.toLowerCase();
  const observed = args.observedHash.toLowerCase();
  if (expected !== observed) {
    return {
      ok: false,
      hash: observed,
      message: `codeHash does not match the deployed runtime code at ${args.address} (sent ${expected.slice(0, 12)}…, chain reports ${observed.slice(0, 12)}…). Read the code from this chain and pin what it actually returns.`,
    };
  }
  return { ok: true, hash: observed, message: `Runtime code at ${args.address} matches ${observed.slice(0, 12)}….` };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function getCode(
  url: string,
  address: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message || "JSON-RPC error");
    if (typeof body.result !== "string") throw new Error("Empty JSON-RPC result");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the runtime code for `address` from the first RPC that answers, and hash
 * it. Tries each URL in order; only the first successful answer is used.
 */
export async function observeRuntimeCode(args: {
  rpcUrls: string[];
  address: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<CodeObservation> {
  const { address } = args;
  if (!ADDRESS.test(address)) {
    return { ok: false, code: "invalid-address", message: `Executor ${address} is not a valid 20-byte address.` };
  }
  const urls = [...new Set(args.rpcUrls.filter((u) => /^https?:\/\//.test(u)))];
  if (urls.length === 0) {
    return {
      ok: false,
      code: "rpc",
      message: `No RPC endpoint is configured for chain code reads, so the executor's bytecode cannot be verified. Add a validated RPC for this chain and pin again.`,
    };
  }
  const fetchImpl: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const failures: string[] = [];
  for (const url of urls) {
    let code: string;
    try {
      code = await getCode(url, address, args.timeoutMs ?? 6_000, fetchImpl);
    } catch (e) {
      failures.push(`${new URL(url).host}: ${e instanceof Error ? e.message : "request failed"}`);
      continue;
    }
    if (!hasRuntimeCode(code)) {
      return {
        ok: false,
        code: "no-code",
        message: `No contract code at ${address} on this chain (${new URL(url).host} reports an empty account) — refusing to pin an address that cannot sign.`,
      };
    }
    return {
      ok: true,
      hash: runtimeCodeHash(code),
      bytes: (code.length - 2) / 2,
      url,
    };
  }
  return {
    ok: false,
    code: "rpc",
    message: `Could not read the executor's code from any chain RPC (${failures.join("; ")}) — refusing to pin unverified bytecode.`,
  };
}
