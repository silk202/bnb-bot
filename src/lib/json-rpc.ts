/**
 * Minimal JSON-RPC client shared by the wallet detectors.
 *
 * One implementation so timeouts, error shapes and the "an error is never
 * treated as empty data" rule are identical everywhere. No retries here — retry
 * and failover policy belongs to the caller that knows the workload (see
 * rpc-manager.ts).
 */

export const RPC_TIMEOUT_MS = 12_000;
/** `eth_getLogs` is slower than a plain call and needs a longer budget. */
export const LOGS_TIMEOUT_MS = 25_000;

export interface RpcError extends Error {
  code?: number;
  data?: unknown;
}

export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err: RpcError = new Error(`${method} HTTP ${res.status}`);
    throw err;
  }
  const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number; data?: unknown } };
  if (body.error) {
    const err: RpcError = new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    err.code = body.error.code;
    err.data = body.error.data;
    throw err;
  }
  if (body.result === undefined) throw new Error(`${method}: empty result`);
  return body.result;
}

export const hexBlock = (n: number): string => `0x${Math.max(0, Math.floor(n)).toString(16)}`;
export const toNumber = (hex: string | number): number =>
  typeof hex === "number" ? hex : Number.parseInt(hex, 16);
export const padAddress = (address: string): string =>
  `0x${"0".repeat(24)}${address.toLowerCase().replace(/^0x/, "")}`;
