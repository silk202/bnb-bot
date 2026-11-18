/**
 * Wallet risk detectors — the half that produces findings for wallet-guard.ts.
 *
 * The guard decides; these observe. Each detector returns the same
 * {@link RiskFinding} shape the policy grades, and says how much it actually
 * covered: a partial scan reported as complete is worse than no scan.
 *
 * Detectors here:
 *   - drainable approvals: `Approval(owner, spender, value)` logs over a bounded
 *     window, then the CURRENT `allowance(owner, spender)` per pair, so a
 *     revoked approval never blocks and an unlimited one always does.
 *   - suspicious spenders: an approval nobody recognises is its own finding,
 *     even when the allowance is finite.
 *   - unexplained outflows: balance dropped further than what this session
 *     recorded spending.
 *   - honey-pot / unsellable tokens: a round-trip loss above the threshold.
 *
 * No key material is ever read, signed, or logged here.
 */
import type { RiskFinding } from "./wallet-guard";
import { LOGS_TIMEOUT_MS, padAddress, rpcCall } from "./json-rpc";

/** Shared client: identical timeouts and error shapes across detectors. */
const rpc = rpcCall;

const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const ALLOWANCE_SELECTOR = "0xdd62ed3e";
/** 2^255 — anything at or above this is "unlimited" in practice. */
export const UNLIMITED_THRESHOLD = 1n << 255n;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ── pure classification ─────────────────────────────────────────────────────

export interface ApprovalInput {
  token: string;
  spender: string;
  allowance: bigint;
  /** Routers/contracts the operator has accepted as normal for this chain. */
  knownSpenders?: ReadonlySet<string>;
}

/**
 * Grade one live allowance.
 *
 * Unlimited → high (blocks a payout) unless the spender is a recognised router,
 * in which case it is medium: unlimited approval to PancakeSwap is ordinary
 * DeFi, unlimited approval to a contract nobody knows is the drain signature.
 */
export function classifyApproval(input: ApprovalInput): RiskFinding | null {
  const spender = input.spender.toLowerCase();
  if (input.allowance === 0n) return null;
  const known = input.knownSpenders?.has(spender) ?? false;
  const unlimited = input.allowance >= UNLIMITED_THRESHOLD;

  if (unlimited && !known) {
    return {
      kind: "drainable-approval",
      severity: "high",
      detail: `Unlimited allowance on ${short(input.token)} to unrecognised spender ${short(spender)} — it can move the whole balance.`,
      token: input.token,
      spender,
    };
  }
  if (unlimited && known) {
    return {
      kind: "drainable-approval",
      severity: "medium",
      detail: `Unlimited allowance on ${short(input.token)} to a recognised router ${short(spender)} — ordinary, still worth minimising.`,
      token: input.token,
      spender,
    };
  }
  if (!known) {
    return {
      kind: "unexpected-contract-interaction",
      severity: "medium",
      detail: `Finite allowance on ${short(input.token)} to unrecognised spender ${short(spender)}.`,
      token: input.token,
      spender,
    };
  }
  return null;
}

/** Wallet dropped further than this session's recorded spending explains. */
export function classifyOutflow(input: {
  baselineNative: number;
  currentNative: number;
  expectedSpentNative: number;
  tolerancePct?: number;
  dustNative?: number;
}): RiskFinding | null {
  const { baselineNative, currentNative, expectedSpentNative } = input;
  const tolerance = input.tolerancePct ?? 2;
  const dust = input.dustNative ?? 0.001;
  if (!Number.isFinite(baselineNative) || !Number.isFinite(currentNative)) return null;
  const dropped = baselineNative - currentNative;
  const allowed = Math.max(0, expectedSpentNative) * (1 + tolerance / 100) + dust;
  if (dropped <= allowed) return null;

  const unexplained = dropped - expectedSpentNative;
  // Proportional grading, because the baseline cannot see every legitimate
  // spend (trades, gas) — a small shortfall warns so ordinary trading does not
  // block every payout, while a large unexplained drop blocks. A guard that
  // cries wolf is one an operator learns to override.
  const shareOfBaseline = baselineNative > 0 ? unexplained / baselineNative : 1;
  const severity = shareOfBaseline >= 0.2 ? "high" : "medium";
  return {
    kind: "unexplained-outflow",
    severity,
    detail: `Balance fell ${dropped.toFixed(4)} BNB but only ${expectedSpentNative.toFixed(4)} was expected (tolerance ${tolerance}%) — ${unexplained.toFixed(4)} unexplained (${(shareOfBaseline * 100).toFixed(1)}% of baseline).`,
  };
}

/** A token whose round trip loses more than the threshold is a honey-pot trap. */
export function classifyTokenSellability(input: {
  roundTripLossPct: number;
  maxLossPct?: number;
  token?: string;
}): RiskFinding | null {
  const max = input.maxLossPct ?? 25;
  if (!Number.isFinite(input.roundTripLossPct) || input.roundTripLossPct <= max) return null;
  return {
    kind: "honeypot-token",
    severity: "high",
    detail: `${input.token ? short(input.token) : "Token"} loses ${input.roundTripLossPct.toFixed(0)}% on a round trip (limit ${max}%) — buyable but effectively unsellable.`,
  };
}

// ── RPC ─────────────────────────────────────────────────────────────────────

// `eth_getLogs` on a public BSC node with a topic filter is slower than a plain
// call and frequently needs more than 12s; 25s still fails the payout check
// safely (a scan that cannot complete is reported as unverified).
// `LOGS_TIMEOUT_MS` is longer than a plain call because a topic-filtered
// `eth_getLogs` is slow on public BSC nodes; a scan that cannot finish is
// reported as unverified rather than as "no approvals".

export interface ApprovalScan {
  findings: RiskFinding[];
  coverage: {
    fromBlock: number;
    toBlock: number;
    chunks: number;
    truncated: boolean;
    /** How the approvals were obtained — a probe sees far less than a log scan. */
    mode: "logs" | "allowance-probe";
    /** Why the scan could not be complete, when it could not. */
    lastError?: string;
  };
}

/**
 * Targeted allowance probe: read `allowance(owner, spender)` for known tokens and
 * spenders, with no log scanning at all.
 *
 * This exists because BSC **testnet** free RPCs cannot answer a topic-only
 * `eth_getLogs` (publicnode: "specify an address"; drpc free: 408 timeout), so
 * the log scan is mainnet-only in practice. A probe is narrower — it only sees
 * the pairs it is asked about — but it works on both chains and it catches the
 * case that matters most: an unlimited allowance to a spender we do not know.
 */
export async function probeAllowances(args: {
  rpcUrl: string;
  rpcUrls?: readonly string[];
  owner: string;
  tokens: readonly string[];
  spenders: readonly string[];
  knownSpenders?: ReadonlySet<string>;
  maxPairs?: number;
}): Promise<ApprovalScan> {
  const endpoints = [args.rpcUrl, ...(args.rpcUrls ?? [])].filter((u, i, a) => u && a.indexOf(u) === i);
  const findings: RiskFinding[] = [];
  let head = 0;
  let lastError: string | undefined;
  try {
    head = Number.parseInt(await rpc<string>(endpoints[0], "eth_blockNumber", []), 16);
  } catch (e) {
    lastError = e instanceof Error ? e.message : "block number unavailable";
  }

  const tokens = args.tokens.filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t)).slice(0, 5);
  const spenders = args.spenders.filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)).slice(0, 12);
  let probes = 0;
  const maxPairs = args.maxPairs ?? 40;

  outer: for (const token of tokens) {
    for (const spender of spenders) {
      if (probes >= maxPairs) break outer;
      probes += 1;
      const data = `${ALLOWANCE_SELECTOR}${padAddress(args.owner).slice(2)}${padAddress(spender).slice(2)}`;
      let allowance: bigint | null = null;
      for (const endpoint of endpoints) {
        try {
          const raw = await rpc<string>(endpoint, "eth_call", [{ to: token, data }, "latest"]);
          allowance = raw && raw !== "0x" ? BigInt(raw) : 0n;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : "eth_call failed";
        }
      }
      if (allowance === null) {
        findings.push({
          kind: "unverified-contract",
          severity: "medium",
          detail: `Allowance unreadable on ${short(token)} for ${short(spender)} — unverified, not cleared.`,
        });
        continue;
      }
      const finding = classifyApproval({ token, spender, allowance, knownSpenders: args.knownSpenders });
      if (finding) findings.push(finding);
    }
  }

  return {
    findings,
    coverage: {
      fromBlock: head,
      toBlock: head,
      chunks: 0,
      truncated: probes >= maxPairs,
      mode: "allowance-probe",
      ...(lastError ? { lastError } : {}),
    },
  };
}

/**
 * Bounded `Approval` scan for `owner`, then a live allowance read per pair.
 *
 * Public BSC nodes cap `eth_getLogs` windows (25–50 blocks on several), so the
 * window is walked in `chunk`-sized steps and the whole scan is capped at
 * `maxChunks`. Coverage is returned so a partial scan is reported as partial.
 */
const APPROVAL_TTL_MS = 5 * 60_000;
const approvalCache = new Map<string, { at: number; scan: ApprovalScan }>();

/** Drop cached scans (used when the operator asks for a fresh read). */
export function clearApprovalCache(): void {
  approvalCache.clear();
}

export async function detectApprovals(args: {
  rpcUrl: string;
  /** Extra endpoints to fall back to when one refuses or times out. */
  rpcUrls?: readonly string[];
  owner: string;
  knownSpenders?: ReadonlySet<string>;
  lookbackBlocks?: number;
  chunk?: number;
  maxChunks?: number;
  /** Tokens to probe when log scanning is unavailable (testnet free RPCs). */
  tokens?: readonly string[];
  /** Spenders to probe: the trusted set plus any contract the app itself calls. */
  probeSpenders?: readonly string[];
}): Promise<ApprovalScan> {
  // A payout runs this on every profitable sell; without a cache that is ~28
  // RPC calls each time, which public BSC nodes rate-limit into failures.
  const cacheKey = `${args.rpcUrl}|${args.owner.toLowerCase()}`;
  const hit = approvalCache.get(cacheKey);
  if (hit && Date.now() - hit.at < APPROVAL_TTL_MS) return hit.scan;

  // 20 blocks, not 50: public BSC nodes reject or stall wider windows with a
  // topic filter (verified live — 50 timed out on mainnet, refused on testnet).
  const chunk = Math.max(1, args.chunk ?? 20);
  const maxChunks = Math.max(1, args.maxChunks ?? 20);
  const endpoints = [args.rpcUrl, ...(args.rpcUrls ?? [])].filter((u, i, a) => u && a.indexOf(u) === i);
  const lookback = Math.max(chunk, args.lookbackBlocks ?? chunk * maxChunks);

  const headHex = await rpc<string>(args.rpcUrl, "eth_blockNumber", []);
  const head = Number.parseInt(headHex, 16);
  const earliest = Math.max(0, head - lookback);
  const ownerTopic = padAddress(args.owner);

  const latest = new Map<string, { token: string; spender: string }>();
  let chunks = 0;
  let lastTo = head;
  let lastError: string | undefined;
  for (let to = head; to > earliest && chunks < maxChunks; to -= chunk) {
    const from = Math.max(earliest, to - chunk + 1);
    let logs: { address: string; topics: string[] }[] | null = null;
    for (const endpoint of endpoints) {
      try {
        logs = await rpc<{ address: string; topics: string[] }[]>(
          endpoint,
          "eth_getLogs",
          [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [APPROVAL_TOPIC, ownerTopic] }],
          LOGS_TIMEOUT_MS,
        );
        break;
      } catch (e) {
        // try the next endpoint; an error is never treated as "no approvals"
        lastError = e instanceof Error ? e.message : "eth_getLogs failed";
      }
    }
    if (logs === null) {
      // Every endpoint refused this window. That is not evidence of safety.
      // With a token list we can still probe allowances directly; without one,
      // report partial coverage instead of a clean bill of health.
      if (args.tokens?.length && args.probeSpenders?.length) {
        return probeAllowances({
          rpcUrl: args.rpcUrl,
          rpcUrls: args.rpcUrls,
          owner: args.owner,
          tokens: args.tokens,
          spenders: args.probeSpenders,
          knownSpenders: args.knownSpenders,
        });
      }
      return {
        findings: [],
        coverage: { fromBlock: from, toBlock: to, chunks, truncated: true, mode: "logs", lastError },
      };
    }
    for (const log of logs) {
      const spender = log.topics?.[2] ? `0x${log.topics[2].slice(26)}`.toLowerCase() : "";
      if (!spender || !log.address) continue;
      latest.set(`${log.address.toLowerCase()}:${spender}`, { token: log.address.toLowerCase(), spender });
    }
    lastTo = from;
    chunks += 1;
  }

  const findings: RiskFinding[] = [];
  for (const { token, spender } of [...latest.values()].slice(0, 12)) {
    try {
      const data = `${ALLOWANCE_SELECTOR}${padAddress(args.owner).slice(2)}${padAddress(spender).slice(2)}`;
      const raw = await rpc<string>(args.rpcUrl, "eth_call", [{ to: token, data }, "latest"]);
      const allowance = raw && raw !== "0x" ? BigInt(raw) : 0n;
      const finding = classifyApproval({ token, spender, allowance, knownSpenders: args.knownSpenders });
      if (finding) findings.push(finding);
    } catch {
      findings.push({
        kind: "unverified-contract",
        severity: "medium",
        detail: `Could not read allowance on ${short(token)} for spender ${short(spender)} — unverified, not cleared.`,
      });
    }
  }

  // Truncated means "the cap stopped us", not "we scanned exactly the cap".
  const stoppedEarly = chunks >= maxChunks && lastTo > earliest;
  const scan: ApprovalScan = {
    findings,
    coverage: {
      fromBlock: earliest,
      toBlock: head,
      chunks,
      truncated: stoppedEarly,
      mode: "logs",
      ...(lastError ? { lastError } : {}),
    },
  };
  // Only cache a complete scan: a partial one must not be reused as if it were
  // the whole picture.
  if (!scan.coverage.truncated) approvalCache.set(cacheKey, { at: Date.now(), scan });
  return scan;
}

/** Native balance, in BNB, as a number (undefined when the RPC fails). */
export async function nativeBalance(rpcUrl: string, owner: string): Promise<number | undefined> {
  try {
    const hex = await rpc<string>(rpcUrl, "eth_getBalance", [owner, "latest"]);
    return Number(BigInt(hex)) / 1e18;
  } catch {
    return undefined;
  }
}
