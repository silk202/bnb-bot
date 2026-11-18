/**
 * Value-movement policy — the single place that decides whether funds may move.
 *
 * Roles (wallet isolation):
 *   - **operational** = the vault (imported key, in-memory, local signing) or the
 *     generated hot wallet. It deploys FlashBoltArbitrage, runs BNB flash-loan
 *     arbitrage and executes automated payouts.
 *   - **external** = any injected wallet (MetaMask, Trust, …). It may only ever
 *     RECEIVE — a secondary withdrawal destination. It never signs `execute()`,
 *     a trade, or a payout, because that signer is what a site compromise or a
 *     malicious approval reaches first.
 *
 * Enforcement levels (fail closed):
 *   1 critical → automatic hard block, never overridable
 *   2 high     → block pending investigation; overridable with permission
 *   3 medium   → allow, warn, surface for investigation
 *   4 low      → allow, log only
 *
 * An override is an *authorization*, not a flag: operator identity, mandatory
 * reason, wallet scope, transaction scope and an expiry all have to match. It
 * cannot unlock a confirmed compromise or a known malicious contract.
 *
 * Everything here is pure — no chain calls, no storage — so one decision is
 * reproducible and testable. Persisting the returned audit record is the
 * caller's job, and it must be append-only to be worth anything.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";
/** Back-compat alias: the previous name for the same scale. */
export type RiskSeverity = RiskLevel;

export type RiskKind =
  | "confirmed-compromise"
  | "malicious-contract"
  | "unauthorized-outflow"
  | "malicious-approval"
  | "drainable-approval"
  | "honeypot-token"
  | "unverified-token"
  | "unexplained-outflow"
  | "unexpected-contract-interaction"
  | "unusual-gas"
  | "unverified-contract"
  | "unexpected-slippage"
  | "anomalous-transaction"
  | "unbound-payout-target"
  | "non-vault-arbitrage-signer"
  | "external-wallet-signer"
  | "breaker-open"
  | "chain-mismatch"
  | "payout-role-violation"
  | "limit-exceeded"
  | "benign-deviation";

export interface RiskFinding {
  kind: RiskKind;
  severity: RiskLevel;
  /** Safe to log — never key material, never a secret. */
  detail: string;
  /** Structured refs when the finding came from an approval check. */
  token?: string;
  spender?: string;
}

/** The level a finding kind defaults to, so callers cannot grade themselves down. */
export const DEFAULT_LEVEL: Readonly<Record<RiskKind, RiskLevel>> = {
  "confirmed-compromise": "critical",
  "malicious-contract": "critical",
  "unauthorized-outflow": "critical",
  "malicious-approval": "critical",
  "drainable-approval": "high",
  "honeypot-token": "high",
  "unverified-token": "high",
  "unexplained-outflow": "high",
  "unexpected-contract-interaction": "high",
  "unusual-gas": "medium",
  "unverified-contract": "medium",
  "unexpected-slippage": "medium",
  "anomalous-transaction": "medium",
  "unbound-payout-target": "critical",
  "non-vault-arbitrage-signer": "critical",
  "external-wallet-signer": "critical",
  "breaker-open": "critical",
  "chain-mismatch": "critical",
  "payout-role-violation": "critical",
  "limit-exceeded": "high",
  "benign-deviation": "low",
};

/**
 * Findings that are policy, not judgement, and so are never overridable even
 * though a caller might file them below "critical".
 */
const NEVER_OVERRIDABLE: ReadonlySet<RiskKind> = new Set<RiskKind>([
  "confirmed-compromise",
  "malicious-contract",
  "unauthorized-outflow",
  "malicious-approval",
  "unbound-payout-target",
  "non-vault-arbitrage-signer",
  "external-wallet-signer",
  "breaker-open",
  "chain-mismatch",
  "payout-role-violation",
]);

const MIN_REASON = 12;
const MAX_AUTH_MS = 15 * 60 * 1000;

export interface OverrideAuthorization {
  /** Who authorized it — never empty. */
  operatorId: string;
  /** Why — mandatory, meaningful length. */
  reason: string;
  /** Wallet-specific scope (lowercase 0x…). */
  wallet: string;
  /** Transaction-specific scope, e.g. `payout:<hash-of-batch>`. */
  txKey: string;
  issuedAt: number;
  /** Time-limited: at most {@link MAX_AUTH_MS} after `issuedAt`. */
  expiresAt: number;
}

export interface AuditRecord {
  at: number;
  wallet: string;
  txKey: string;
  decision: "allow" | "block";
  level: RiskLevel | "none";
  findings: { kind: RiskKind; level: RiskLevel }[];
  override?: { operatorId: string; reason: string; expiresAt: number };
}

export interface GuardVerdict {
  allow: boolean;
  /** Blocked at level 2 — an authorization would unlock it. */
  requiresOverride: boolean;
  /** Blocked at level 1 (or a never-overridable rule) — nothing unlocks it. */
  hardBlock: boolean;
  level: RiskLevel | "none";
  blocking: RiskFinding[];
  notices: RiskFinding[];
  logged: RiskFinding[];
  reason: string;
  /** Append-only record for the caller to persist. */
  audit: AuditRecord;
  /** True when a critical finding requires suspending execution entirely. */
  tripBreaker: boolean;
}

const atLeast = (a: RiskLevel, b: RiskLevel) => RANK[a] >= RANK[b];
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Normalize a finding so its level can only be raised above the default. */
export function normalizeFinding(f: RiskFinding): RiskFinding {
  const floor = DEFAULT_LEVEL[f.kind];
  const severity = atLeast(f.severity, floor) ? f.severity : floor;
  return { ...f, severity };
}

function authorizationProblem(
  auth: OverrideAuthorization | null | undefined,
  ctx: { wallet: string; txKey: string; now: number },
): string | null {
  if (!auth) return "no operator authorization supplied";
  if (!auth.operatorId.trim()) return "authorization has no operator identity";
  if (auth.reason.trim().length < MIN_REASON) return "authorization reason is missing or too short";
  if (auth.wallet.trim().toLowerCase() !== ctx.wallet.trim().toLowerCase()) {
    return "authorization is scoped to a different wallet";
  }
  if (auth.txKey.trim() !== ctx.txKey.trim()) {
    return "authorization is scoped to a different transaction";
  }
  if (!Number.isFinite(auth.issuedAt) || auth.issuedAt > ctx.now) return "authorization is not yet valid";
  if (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= ctx.now) return "authorization has expired";
  if (auth.expiresAt - auth.issuedAt > MAX_AUTH_MS) return "authorization window exceeds the 15-minute limit";
  return null;
}

const worst = (levels: RiskLevel[]): RiskLevel | "none" => {
  if (levels.length === 0) return "none";
  return levels.reduce((acc, l) => (RANK[l] > RANK[acc] ? l : acc), "low" as RiskLevel);
};

/**
 * Decide one value movement (payout or execution) and produce its audit record.
 */
export function evaluateValueMovement(input: {
  findings: readonly RiskFinding[];
  wallet: string;
  txKey: string;
  now: number;
  authorization?: OverrideAuthorization | null;
}): GuardVerdict {
  const findings = input.findings.map(normalizeFinding);
  const level = worst(findings.map((f) => f.severity));
  const critical = findings.filter((f) => f.severity === "critical");
  const high = findings.filter((f) => f.severity === "high");
  const notices = findings.filter((f) => f.severity === "medium");
  const logged = findings.filter((f) => f.severity === "low");
  const never = findings.filter((f) => NEVER_OVERRIDABLE.has(f.kind));

  const base = {
    wallet: input.wallet.trim().toLowerCase(),
    txKey: input.txKey.trim(),
    at: input.now,
    level,
    notices,
    logged,
  };

  const auditOf = (
    decision: "allow" | "block",
    override?: AuditRecord["override"],
  ): AuditRecord => ({
    at: base.at,
    wallet: base.wallet,
    txKey: base.txKey,
    decision,
    level,
    findings: findings.map((f) => ({ kind: f.kind, level: f.severity })),
    ...(override ? { override } : {}),
  });

  // Level 1 (and every never-overridable rule): hard block, breaker trips.
  if (critical.length > 0 || never.length > 0) {
    const hard = [...new Set([...critical, ...never])];
    return {
      allow: false,
      requiresOverride: false,
      hardBlock: true,
      level,
      blocking: hard,
      notices,
      logged,
      reason: `Hard block — never overridable: ${hard.map((f) => `${f.kind} (${f.detail})`).join("; ")}`,
      audit: auditOf("block"),
      tripBreaker: true,
    };
  }

  // Level 2: blocked pending investigation; authorization unlocks it.
  if (high.length > 0) {
    const problem = authorizationProblem(input.authorization, {
      wallet: input.wallet,
      txKey: input.txKey,
      now: input.now,
    });
    if (problem) {
      return {
        allow: false,
        requiresOverride: true,
        hardBlock: false,
        level,
        blocking: high,
        notices,
        logged,
        reason: `Blocked pending investigation: ${high
          .map((f) => `${f.kind} (${f.detail})`)
          .join("; ")} — ${problem}`,
        audit: auditOf("block"),
        tripBreaker: false,
      };
    }
    const auth = input.authorization!;
    return {
      allow: true,
      requiresOverride: false,
      hardBlock: false,
      level,
      blocking: [],
      notices,
      logged,
      reason: `Authorized by ${auth.operatorId}: ${auth.reason.trim()} — outstanding: ${high
        .map((f) => f.kind)
        .join(", ")}`,
      audit: auditOf("allow", {
        operatorId: auth.operatorId,
        reason: auth.reason.trim(),
        expiresAt: auth.expiresAt,
      }),
      tripBreaker: false,
    };
  }

  // Levels 3 and 4: allowed; medium surfaces as a warning, low is logged only.
  return {
    allow: true,
    requiresOverride: false,
    hardBlock: false,
    level,
    blocking: [],
    notices,
    logged,
    reason:
      notices.length > 0
        ? `Allowed with warnings (investigate): ${notices.map((f) => f.kind).join(", ")}`
        : logged.length > 0
          ? `Allowed — logged: ${logged.map((f) => f.kind).join(", ")}`
          : "Allowed — nothing found",
    audit: auditOf("allow"),
    tripBreaker: false,
  };
}

/** Canonical, append-only line for the audit log. */
export function auditLine(record: AuditRecord): string {
  return JSON.stringify(record);
}

// ── transaction limits ───────────────────────────────────────────────────────

export interface TransactionLimits {
  /** Maximum value of one movement, in native units. */
  maxPerTxNative: number;
  /** Maximum total value per UTC day, in native units. */
  dailyCapNative: number;
}

/**
 * Conservative defaults for automated BNB payouts. A movement above these is not
 * "wrong", it is unusual — and unusual automated value movement is what a drain
 * looks like, so it stops for a human.
 */
export const DEFAULT_PAYOUT_LIMITS: TransactionLimits = {
  maxPerTxNative: 0.5,
  dailyCapNative: 5,
};

export function checkTransactionLimits(input: {
  amountNative: number;
  limits: TransactionLimits;
  spentTodayNative: number;
}): { allowed: boolean; reason: string; remainingToday: number } {
  const { amountNative, limits, spentTodayNative } = input;
  const remaining = Math.max(0, limits.dailyCapNative - spentTodayNative);
  if (!Number.isFinite(amountNative) || amountNative <= 0) {
    return { allowed: false, reason: "Amount is not a positive number.", remainingToday: remaining };
  }
  if (amountNative > limits.maxPerTxNative) {
    return {
      allowed: false,
      reason: `Per-transaction limit: ${amountNative} exceeds ${limits.maxPerTxNative}.`,
      remainingToday: remaining,
    };
  }
  if (amountNative > remaining) {
    return {
      allowed: false,
      reason: `Daily exposure limit: ${amountNative} exceeds the ${remaining} left of ${limits.dailyCapNative}.`,
      remainingToday: remaining,
    };
  }
  return {
    allowed: true,
    reason: `Within limits (${amountNative} of ${limits.maxPerTxNative} per tx; ${remaining} left today).`,
    remainingToday: remaining - amountNative,
  };
}

// ── emergency circuit breaker ────────────────────────────────────────────────

export interface BreakerState {
  trippedAt: number | null;
  reason?: string;
}

export function breakerVerdict(
  state: BreakerState | null | undefined,
  now: number,
): { open: boolean; reason: string } {
  if (state && state.trippedAt !== null) {
    return {
      open: true,
      reason: `Circuit breaker open since ${new Date(state.trippedAt).toISOString()} — ${state.reason ?? "critical finding"}. Resume deliberately after investigating.`,
    };
  }
  void now;
  return { open: false, reason: "Circuit breaker closed." };
}

/** A critical verdict trips it; nothing else does. */
export function nextBreakerState(
  state: BreakerState | null | undefined,
  verdict: { tripBreaker: boolean; reason: string },
  now: number,
): BreakerState {
  if (state && state.trippedAt !== null) return state;
  if (!verdict.tripBreaker) return state ?? { trippedAt: null };
  return { trippedAt: now, reason: verdict.reason };
}

// ── wallet isolation ────────────────────────────────────────────────────────

export type WalletRole = "operational" | "treasury" | "reserve" | "external";

/**
 * Who may pay whom. The operational hot/vault wallet never pays itself (that
 * would be a rename, not a payout), and an external wallet is receive-only.
 */
export function payoutRoleVerdict(input: {
  signerRole: WalletRole;
  destinationRole: WalletRole;
}): { allowed: boolean; reason: string } {
  if (input.signerRole !== "operational") {
    return {
      allowed: false,
      reason: "Automated payouts must be signed by the vault or hot wallet (operational role).",
    };
  }
  if (input.destinationRole === "external") {
    return { allowed: true, reason: "Paying an external wallet (secondary withdrawal destination)." };
  }
  if (input.destinationRole === "treasury" || input.destinationRole === "reserve") {
    return { allowed: true, reason: `Paying the ${input.destinationRole} wallet.` };
  }
  return {
    allowed: false,
    reason: "Destination is the operational wallet itself — a payout must leave it.",
  };
}

// ── payout destination ───────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export interface PayoutResolution {
  ok: boolean;
  address?: string;
  reason: string;
}

/**
 * The ONE payout destination: the external wallet connected right now.
 *
 * `requestedAddress` exists only so a caller still holding a saved address is
 * told it is rejected; anything but the live connected account is refused.
 */
export function resolvePayoutTarget(input: {
  connectedAddress?: string | null;
  requestedAddress?: string | null;
}): PayoutResolution {
  const connected = (input.connectedAddress ?? "").trim().toLowerCase();
  if (!connected) {
    return { ok: false, reason: "No external wallet is connected — connect one to receive payouts." };
  }
  if (!EVM_ADDRESS.test(connected)) {
    return { ok: false, reason: `Connected address is not a valid EVM address (${connected.slice(0, 10)}…).` };
  }
  const requested = (input.requestedAddress ?? "").trim().toLowerCase();
  if (requested && requested !== connected) {
    return {
      ok: false,
      reason: `Payout target ${requested.slice(0, 10)}… is not the connected wallet — payouts may only go to the connected external wallet.`,
    };
  }
  return { ok: true, address: connected, reason: `Paying the connected external wallet ${connected.slice(0, 10)}…` };
}

// ── arbitrage signer + contract address ─────────────────────────────────────

export type SignerSource = "vault" | "hot" | "injected" | "none";

/**
 * BNB flash-loan arbitrage signer policy — vault or hot wallet only, and it must
 * be the deployer because `execute()` is `onlyOwner`.
 */
export function arbitrageSignerVerdict(
  source: SignerSource,
  opts: { ownsContract: boolean },
): { allowed: boolean; reason: string } {
  if (source === "vault" || source === "hot") {
    return opts.ownsContract
      ? { allowed: true, reason: `${source} wallet is the contract deployer — signing locally.` }
      : {
          allowed: false,
          reason: `The ${source} wallet is not this contract's deployer (execute() is onlyOwner). Deploy with the vault/hot wallet active, or arm the matching contract.`,
        };
  }
  if (source === "injected") {
    return {
      allowed: false,
      reason:
        "Flash-loan arbitrage may only be signed by the vault or hot wallet — an injected browser wallet is not allowed to call execute().",
    };
  }
  return { allowed: false, reason: "No vault or hot wallet is unlocked to sign flash-loan arbitrage." };
}

/** Ordinary trades follow the same signer rule as arbitrage. */
export function tradeSignerVerdict(source: SignerSource): { allowed: boolean; reason: string } {
  if (source === "vault" || source === "hot") {
    return { allowed: true, reason: `${source} wallet signs locally; the external wallet only receives.` };
  }
  if (source === "injected") {
    return {
      allowed: false,
      reason: "Trading needs the vault or hot wallet. A connected external wallet (MetaMask, Trust, …) is a withdrawal destination only.",
    };
  }
  return { allowed: false, reason: "No vault or hot wallet is unlocked to sign trades." };
}

/**
 * Whether an armed contract record may serve the arbitrage address.
 * `injected:<addr>` means a browser wallet deployed it → refused.
 */
export function contractArmVerdict(signerAddress?: string | null): {
  allowed: boolean;
  notice?: string;
  reason: string;
} {
  const signer = (signerAddress ?? "").trim().toLowerCase();
  if (!signer) {
    return {
      allowed: true,
      notice: "Arming a contract address with no recorded signer — confirm it was deployed by the vault or hot wallet.",
      reason: "No deploy signer on record; allowed with a notice.",
    };
  }
  if (signer.startsWith("injected:")) {
    return {
      allowed: false,
      reason:
        "This contract was deployed by an injected browser wallet. Flash-loan arbitrage requires a contract deployed by the vault or hot wallet.",
    };
  }
  return { allowed: true, reason: "Contract was deployed by the hot wallet." };
}

// ── chain-specific validation ───────────────────────────────────────────────

export const BNB_CHAIN_IDS = { mainnet: 56, testnet: 97 } as const;

/**
 * Validate the chain an execution is about to touch, independently of whatever
 * the UI or a token's metadata claims. A mainnet/testnet mix-up moves real BNB.
 */
export function chainConfigVerdict(input: {
  network: "mainnet" | "testnet";
  chainId: number;
  rpcUrl: string;
}): { allowed: boolean; reason: string } {
  const expected = BNB_CHAIN_IDS[input.network];
  if (input.chainId !== expected) {
    return {
      allowed: false,
      reason: `Chain mismatch: ${input.network} expects chainId ${expected}, signer is bound to ${input.chainId}.`,
    };
  }
  if (!/^https?:\/\//i.test(input.rpcUrl)) {
    return { allowed: false, reason: `RPC URL is not http(s): ${input.rpcUrl.slice(0, 24)}…` };
  }
  return { allowed: true, reason: `chainId ${expected} (${input.network}) confirmed.` };
}
