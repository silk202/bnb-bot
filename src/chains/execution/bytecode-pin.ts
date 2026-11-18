/**
 * Executor bytecode pinning.
 *
 * An activation can approve a chain and, optionally, the exact contract that
 * lives there. Arming alone proves only that an address was configured; it does
 * not prove what code is deployed behind it. So before an internal payout is
 * signed, the runtime code is read from the chain and its keccak256 compared
 * with the hash pinned in the activation record.
 *
 * Behaviour:
 *   - pinned hash + matching code  → proceed,
 *   - pinned hash + different code → refuse (the contractor changed under an
 *     approval that was granted for different bytecode),
 *   - no pinned hash               → proceed, but the caller is told it is
 *     unpinned so the gap is visible rather than implied safe,
 *   - no code at the address       → refuse.
 */
import { keccak256 } from "viem";
import { rpcCall } from "../../lib/json-rpc";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Runtime code as returned by eth_getCode (`0x` when nothing is deployed). */
export function hasRuntimeCode(code: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
}

/** keccak256 of the deployed runtime code (lower-case hex). */
export function runtimeCodeHash(code: string): string {
  return keccak256(code as `0x${string}`).toLowerCase();
}

export interface BytecodeVerdict {
  ok: boolean;
  hash?: string;
  /** True when the approval had no hash, so nothing was compared. */
  unpinned: boolean;
  reason: string;
}

/** Pure comparison, so the policy is testable without a chain. */
export function comparePinnedCode(args: {
  pinned?: string;
  observedCode: string;
  address: string;
}): BytecodeVerdict {
  const { pinned, observedCode, address } = args;
  if (!ADDRESS.test(address)) {
    return { ok: false, unpinned: false, reason: `Executor ${address.slice(0, 10)}… is not a valid address.` };
  }
  if (!hasRuntimeCode(observedCode)) {
    return {
      ok: false,
      unpinned: !pinned,
      reason: `No contract code at executor ${address.slice(0, 10)}… — refusing to sign against an empty address.`,
    };
  }
  const hash = runtimeCodeHash(observedCode);
  if (!pinned) {
    return {
      ok: true,
      hash,
      unpinned: true,
      reason: `Executor ${address.slice(0, 10)}… is UNPINNED (observed code ${hash.slice(0, 12)}…) — pin it in the activation record to detect a contract swap.`,
    };
  }
  if (pinned.toLowerCase() !== hash) {
    return {
      ok: false,
      hash,
      unpinned: false,
      reason: `Executor bytecode does not match the activation approval (pinned ${pinned.slice(0, 12)}…, observed ${hash.slice(0, 12)}…) — refusing to sign.`,
    };
  }
  return { ok: true, hash, unpinned: false, reason: `Executor bytecode matches the pinned hash ${hash.slice(0, 12)}….` };
}

/** Read the code and compare it with the pinned hash. */
export async function verifyExecutorPinned(args: {
  rpcUrl: string;
  address: string;
  pinned?: string;
  timeoutMs?: number;
}): Promise<BytecodeVerdict> {
  if (!ADDRESS.test(args.address)) {
    return { ok: false, unpinned: !args.pinned, reason: "Executor address is not valid." };
  }
  let code: string;
  try {
    code = await rpcCall<string>(args.rpcUrl, "eth_getCode", [args.address, "latest"], args.timeoutMs ?? 6_000);
  } catch (e) {
    return {
      ok: false,
      unpinned: !args.pinned,
      reason: `Could not read the executor's code (${e instanceof Error ? e.message : "RPC failed"}) — refusing to sign unverified.`,
    };
  }
  return comparePinnedCode({ pinned: args.pinned, observedCode: code, address: args.address });
}

/** Hash to pin for an operator action (refuses when nothing is deployed). */
export async function pinExecutorCode(args: {
  rpcUrl: string;
  address: string;
  timeoutMs?: number;
}): Promise<{ hash: string; bytes: number }> {
  if (!ADDRESS.test(args.address)) throw new Error("Executor address is not valid.");
  const code = await rpcCall<string>(args.rpcUrl, "eth_getCode", [args.address, "latest"], args.timeoutMs ?? 6_000);
  if (!hasRuntimeCode(code)) throw new Error("No contract code at that address on this chain.");
  return { hash: runtimeCodeHash(code), bytes: (code.length - 2) / 2 };
}
