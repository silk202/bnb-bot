/**
 * History-based approval discovery.
 *
 * The allowance probe can only ask about spenders it is handed, so it can never
 * block an approval to a spender nobody listed — the exact case that matters.
 * This module closes that gap without `eth_getLogs`: approvals can only be
 * created by the wallet itself, so walking the wallet's OWN transactions finds
 * every approve/approveForAll call it ever made.
 *
 * Method (bounded, ported from scripts/wallet-audit.mjs):
 *   1. read the account nonce,
 *   2. binary-search the block at which the nonce last incremented, per nonce —
 *      `eth_getTransactionCount(owner, block)` is historical state, so it
 *      reveals where each transaction landed,
 *   3. fetch only those blocks and decode approve selectors.
 *
 * Cost is `txCount × log2(head)` state calls, so it is capped by `maxTxs` and
 * cached per wallet. It works on every EVM chain, including BSC testnet, where
 * topic-only `eth_getLogs` is unavailable.
 */
import { hexBlock, padAddress, rpcCall, toNumber } from "./json-rpc";

const APPROVE = "0x095ea7b3";
const APPROVE_FOR_ALL = "0xa22cb465";

export interface HistoryApproval {
  kind: "erc20" | "erc721/1155";
  token: string;
  spender: string;
  /** ERC-20 amount granted, when decodable. */
  granted?: bigint;
  /** approveForAll flag, for NFTs. */
  approvedAll?: boolean;
  block: number;
}

interface TxLike {
  to?: string | null;
  input?: string;
}

/** Pure: decode approve/approveForAll calldata from a set of transactions. */
export function decodeApprovals(txs: readonly TxLike[], block: number): HistoryApproval[] {
  const out: HistoryApproval[] = [];
  for (const tx of txs) {
    const data = (tx.input ?? "").toLowerCase();
    const to = (tx.to ?? "").toLowerCase();
    if (!to || data.length < 74) continue;
    const selector = data.slice(0, 10);
    const spender = `0x${data.slice(34, 74)}`;
    if (!/^0x[0-9a-f]{40}$/.test(spender)) continue;

    if (selector === APPROVE) {
      const raw = data.slice(74, 138);
      const granted = raw.length === 64 ? BigInt(`0x${raw}`) : undefined;
      out.push({ kind: "erc20", token: to, spender, granted, block });
    } else if (selector === APPROVE_FOR_ALL) {
      out.push({ kind: "erc721/1155", token: to, spender, approvedAll: data.slice(74, 138).endsWith("1"), block });
    }
  }
  return out;
}

const historyCache = new Map<string, { at: number; result: HistoryDiscovery }>();
const HISTORY_TTL_MS = 10 * 60_000;

export function clearHistoryCache(): void {
  historyCache.clear();
}

export interface HistoryDiscovery {
  approvals: HistoryApproval[];
  nonce: number;
  /** Transactions examined (capped by maxTxs). */
  scanned: number;
  /** True when the nonce exceeded the cap and older history was skipped. */
  truncated: boolean;
  lastError?: string;
}

async function stateNonce(
  rpcUrl: string,
  owner: string,
  block: number,
  timeoutMs: number,
): Promise<number | null> {
  try {
    return toNumber(await rpcCall<string>(rpcUrl, "eth_getTransactionCount", [owner, hexBlock(block)], timeoutMs));
  } catch {
    return null;
  }
}

/** Lowest block in [lo, hi] where the predicate is true, or null. */
async function firstBlockWhere(
  predicate: (block: number) => Promise<boolean | null>,
  lo: number,
  hi: number,
): Promise<number | null> {
  let answer: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const hit = await predicate(mid);
    if (hit === null) return null;
    if (hit) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

export async function discoverApprovalsFromHistory(args: {
  rpcUrl: string;
  /**
   * Archive endpoint used for historical `eth_getTransactionCount`.
   * A pruned node answers with CURRENT state for any block, which would make
   * the block search meaningless — so archive support is verified first and its
   * absence is reported as unverified rather than as "no approvals".
   */
  stateRpcUrl?: string;
  owner: string;
  maxTxs?: number;
  timeoutMs?: number;
}): Promise<HistoryDiscovery> {
  const key = `${args.rpcUrl}|${args.owner.toLowerCase()}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.result;

  const maxTxs = Math.max(1, args.maxTxs ?? 12);
  const timeout = args.timeoutMs ?? 12_000;
  const owner = args.owner;

  let head: number;
  let nonceNow: number;
  try {
    head = toNumber(await rpcCall<string>(args.rpcUrl, "eth_blockNumber", [], timeout));
    nonceNow = toNumber(
      await rpcCall<string>(args.rpcUrl, "eth_getTransactionCount", [owner, "latest"], timeout),
    );
  } catch (e) {
    const result: HistoryDiscovery = {
      approvals: [],
      nonce: 0,
      scanned: 0,
      truncated: true,
      lastError: e instanceof Error ? e.message : "history unavailable",
    };
    return result;
  }

  if (nonceNow === 0) {
    const result: HistoryDiscovery = { approvals: [], nonce: 0, scanned: 0, truncated: false };
    historyCache.set(key, { at: Date.now(), result });
    return result;
  }

  // Archive check: block 0 must report the account's ORIGINAL nonce. Pruned
  // nodes either error (publicnode: "Archive requests require a personal
  // token") or silently return current state, and both would corrupt the scan.
  const stateUrl = args.stateRpcUrl ?? args.rpcUrl;
  const genesis = await stateNonce(stateUrl, owner, 0, timeout);
  if (genesis === null || genesis === nonceNow) {
    const result: HistoryDiscovery = {
      approvals: [],
      nonce: nonceNow,
      scanned: 0,
      truncated: true,
      lastError:
        genesis === null
          ? "Historical state unavailable: endpoint rejects archive queries (configure an archive RPC)."
          : "Endpoint returns current state for historical blocks (configure an archive RPC).",
    };
    return result;
  }

  const truncated = nonceNow - genesis > maxTxs;
  const firstTarget = truncated ? nonceNow - maxTxs : 0;
  const nonceCache = new Map<number, number | null>();
  const nonceAt = async (block: number): Promise<number | null> => {
    if (nonceCache.has(block)) return nonceCache.get(block) ?? null;
    const n = await stateNonce(stateUrl, owner, block, timeout);
    nonceCache.set(block, n);
    return n;
  };

  // Searches are independent, so run them with bounded concurrency: the
  // sequential version took ~35s for 17 transactions, which is too slow to sit
  // in a payout path. Capping parallel requests keeps the endpoint happy.
  const targets = Array.from({ length: nonceNow - firstTarget }, (_, i) => firstTarget + i);
  const blocks: number[] = [];
  for (let i = 0; i < targets.length; i += 6) {
    const batch = targets.slice(i, i + 6);
    const found = await Promise.all(
      batch.map((target) =>
        firstBlockWhere(async (b) => {
          const n = await nonceAt(b);
          return n === null ? null : n > target;
        }, 0, head),
      ),
    );
    for (const block of found) if (block !== null) blocks.push(block);
  }

  const approvals: HistoryApproval[] = [];
  let scanned = 0;
  let lastError: string | undefined;
  for (const block of [...new Set(blocks)]) {
    try {
      const full = await rpcCall<{ transactions: (TxLike & { from: string })[] }>(
        args.rpcUrl,
        "eth_getBlockByNumber",
        [hexBlock(block), true],
        timeout,
      );
      const mine = (full.transactions ?? []).filter(
        (tx) => (tx.from ?? "").toLowerCase() === owner.toLowerCase(),
      );
      scanned += mine.length;
      approvals.push(...decodeApprovals(mine, block));
    } catch (e) {
      lastError = e instanceof Error ? e.message : "block read failed";
    }
  }

  const result: HistoryDiscovery = {
    approvals,
    nonce: nonceNow,
    scanned,
    truncated,
    ...(lastError ? { lastError } : {}),
  };
  // Cache only a complete read: a partial history must not look authoritative.
  if (!lastError) historyCache.set(key, { at: Date.now(), result });
  return result;
}

/** ERC-20 allowance calldata for `eth_call`. */
export const allowanceData = (owner: string, spender: string): string =>
  `0xdd62ed3e${padAddress(owner).slice(2)}${padAddress(spender).slice(2)}`;
