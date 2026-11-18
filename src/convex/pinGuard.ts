/**
 * Pure rules for approving an executor contract.
 *
 * These live outside the mutations so they can be tested without a Convex
 * runtime, and so both pin paths ("Confirm & pin executor" and the legacy
 * hash-only re-pin) share one definition of an acceptable arm:
 *
 *   1. the chain id must be one this terminal can pin,
 *   2. the operator's own terminal must have an armed executor for that chain,
 *   3. the arm must carry a timestamp and be recent enough to still describe
 *      the deployment it is being used to approve,
 *   4. the address being approved must BE that armed executor.
 *
 * A refusal never guesses: it returns a typed code and the sentence the
 * mutation throws, so the console can echo exactly what the server decided.
 */

/**
 * Terminal deployment key for the chain ids we can pin. Mirrors the app's chain
 * registry (see `chainForChainId`); testnets share their mainnet key because the
 * terminal stores one deployment per chain key.
 */
export const CHAIN_KEY_BY_ID: Record<number, string> = {
  56: "bsc",
  97: "bsc",
  1: "ethereum",
  11155111: "ethereum",
  42161: "arbitrum",
  421614: "arbitrum",
  137: "polygon",
  80002: "polygon",
};

/**
 * How old an arm may be and still authorize a pin. An arm is the operator's
 * statement "this deployment exists"; if it is older than this, the deployment
 * (or the operator's memory of it) is not trustworthy enough to approve against.
 */
export const ARM_MAX_AGE_MS = 30 * 86_400_000;

/**
 * How long a server-side code inspection stays usable for an approval. The
 * operator inspects, then confirms; a confirmation minutes later is fine, an
 * approval resting on yesterday's read is not.
 */
export const INSPECTION_TTL_MS = 10 * 60_000;

/**
 * Evidence is usable only inside the half-open window
 * `[inspectedAt, inspectedAt + ttl)`.
 *
 * The boundary is open on the right on purpose: the countdown
 * (`inspectionRemainingMs` reaching 0) and activation expiry
 * (`expiresAt <= now`) both call that instant EXPIRED. With `<=` here the
 * backend would still accept an observation the console already disables, so
 * the last second would depend on which side was asked. Future stamps fail
 * too — a clock that disagrees with the server cannot manufacture a window.
 */
export function isInspectionFresh(inspectedAt: number, now: number, ttl = INSPECTION_TTL_MS): boolean {
  if (!Number.isFinite(inspectedAt) || !Number.isFinite(now)) return false;
  const age = now - inspectedAt;
  return age >= 0 && age < ttl;
}

/** Compact duration for operator-facing ages: "12s", "9m 48s", "3h 5m", "4d". */
export function formatAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The expiry the SERVER issues for one observation. Clients must count down
 * from this value, not from their own wall clock: the browser's clock can be
 * wrong, can be changed mid-session, and is not the authority on freshness.
 */
export function inspectionExpiresAt(inspectedAt: number, ttl = INSPECTION_TTL_MS): number {
  return inspectedAt + ttl;
}

/**
 * How long a server-issued observation remains usable.
 *
 * `expiresAt` and `serverNow` come from the SAME server response; the caller
 * measures `elapsedSinceResponse` locally with a monotonic clock
 * (`performance.now()`), which wall-clock adjustments and timezone/skew problems
 * cannot move. A non-finite expiry yields NaN, which every consumer treats as
 * expired (fail closed).
 */
export function inspectionRemainingMs(args: {
  expiresAt: number;
  serverNow: number;
  elapsedSinceResponse: number;
}): number {
  const { expiresAt, serverNow, elapsedSinceResponse } = args;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(serverNow)) return Number.NaN;
  const elapsed = Number.isFinite(elapsedSinceResponse) ? Math.max(0, elapsedSinceResponse) : 0;
  return expiresAt - serverNow - elapsed;
}

/** Only a finite, positive remaining window is usable. */
export function inspectionExpired(remainingMs: number): boolean {
  return !Number.isFinite(remainingMs) || remainingMs <= 0;
}

/**
 * Operator-facing description of the server's observation, derived from the
 * server-issued remaining window (never from the browser clock).
 */
export function inspectionLabel(remainingMs: number, ttl = INSPECTION_TTL_MS): string {
  if (!Number.isFinite(remainingMs)) return "inspection expiry unknown — inspect again";
  const age = Math.max(0, ttl - remainingMs);
  if (inspectionExpired(remainingMs)) {
    return `inspected ${formatAge(age)} ago · expired (${Math.round(ttl / 60_000)}-minute window)`;
  }
  // Sub-second windows floor to "0s", which reads as expired even though the
  // guard still accepts the hash. Say what is actually happening instead.
  if (remainingMs < 1_000) return `inspected ${formatAge(age)} ago · expires now`;
  return `inspected ${formatAge(age)} ago · fresh for ${formatAge(remainingMs)} more`;
}

/**
 * The arm stamps a save should store.
 *
 * One field used to carry three different facts, so "how old is this arm?" and
 * "how old is this save?" could not be told apart. They are now separate:
 *
 *   • `armedAt` — when the CURRENT address was armed. It is what the pin guard
 *     measures, and re-saving the same address never refreshes it (a stale arm
 *     cannot be laundered into a fresh one by clicking Save).
 *   • `firstArmedAt` — when this address was first seen armed. Equal to
 *     `armedAt` for every arm recorded since the field existed; absent for a
 *     record that predates timestamps, because its real first-arm time is
 *     unknown and inventing one would be worse than omitting it.
 *   • `affirmedAt` — when the operator last saved this deployment. This is the
 *     "last affirmed" fact; it proves recency of the SAVE (a router edit, a
 *     signer note), never recency of the deployment.
 */
export type ArmStamps = {
  armedAt?: number;
  firstArmedAt?: number;
  affirmedAt?: number;
};

export function nextArmStamps(input: {
  previousAddress?: string | null;
  nextAddress: string;
  previousArmedAt?: number | null;
  previousFirstArmedAt?: number | null;
  now: number;
}): ArmStamps {
  const next = input.nextAddress.trim();
  if (!next) return {};
  const previous = (input.previousAddress ?? "").trim();
  const addressChanged = next.toLowerCase() !== previous.toLowerCase();
  if (addressChanged) {
    return { armedAt: input.now, firstArmedAt: input.now, affirmedAt: input.now };
  }
  const hasPreviousStamp =
    typeof input.previousArmedAt === "number" && Number.isFinite(input.previousArmedAt);
  if (!hasPreviousStamp) {
    // A record saved before timestamps existed: this save affirms it now, and
    // its first-arm time stays unknown rather than being back-dated to now.
    return { armedAt: input.now, affirmedAt: input.now };
  }
  const previousFirst =
    typeof input.previousFirstArmedAt === "number" && Number.isFinite(input.previousFirstArmedAt)
      ? input.previousFirstArmedAt
      : input.previousArmedAt!;
  return { armedAt: input.previousArmedAt!, firstArmedAt: previousFirst, affirmedAt: input.now };
}

/** The only stamp the guard reads. Kept as a named rule so both callers agree. */
export function armStampForGuard(record: {
  contractAddress: string;
  armedAt?: number | null;
  firstArmedAt?: number | null;
}): number | undefined {
  const armedAt = record.armedAt;
  return typeof armedAt === "number" && Number.isFinite(armedAt) ? armedAt : undefined;
}

export type PinRefusalCode =
  | "unsupported-chain"
  | "no-arm"
  | "unverified-arm"
  | "stale-arm"
  | "address-mismatch"
  | "no-pinned-address";

export type PinGuardResult =
  | { ok: true; armed: string; armedAt: number }
  | { ok: false; code: PinRefusalCode; message: string };

export function chainKeyForPin(chainId: number): string | null {
  return CHAIN_KEY_BY_ID[chainId] ?? null;
}

export function armAgeMs(armedAt: number, now: number): number {
  return Math.max(0, now - armedAt);
}

function freshness(
  chainKey: string,
  armed: string,
  armedAt: number | undefined,
  now: number,
): PinGuardResult {
  if (armedAt === undefined || !Number.isFinite(armedAt)) {
    return {
      ok: false,
      code: "unverified-arm",
      message: `The executor armed for ${chainKey} has no arm timestamp, so its age cannot be checked. Re-save the deployment on the Contract page to record it, then pin.`,
    };
  }
  const age = armAgeMs(armedAt, now);
  if (age > ARM_MAX_AGE_MS) {
    const days = Math.floor(age / 86_400_000);
    return {
      ok: false,
      code: "stale-arm",
      message: `The executor armed for ${chainKey} was armed ${days} day${days === 1 ? "" : "s"} ago (limit ${Math.floor(ARM_MAX_AGE_MS / 86_400_000)}). Re-arm the deployment on the Contract page so the approval rests on a current arm.`,
    };
  }
  return { ok: true, armed, armedAt };
}

/**
 * "Confirm & pin executor": the address AND hash are approved together, so the
 * address must be the armed executor exactly (case-insensitive).
 */
export function checkExecutorPin(input: {
  chainId: number;
  contractAddress: string;
  armedAddress?: string | null;
  armedAt?: number | null;
  now: number;
}): PinGuardResult {
  const chainKey = chainKeyForPin(input.chainId);
  if (!chainKey) {
    return {
      ok: false,
      code: "unsupported-chain",
      message: `Executor pinning is not supported for chain ${input.chainId}.`,
    };
  }
  const armed = (input.armedAddress ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(armed)) {
    return {
      ok: false,
      code: "no-arm",
      message: `No executor is armed for ${chainKey} in this operator's terminal. Arm the deployment on the Contract page first — approving an address the terminal never arms would authorize a contract that cannot sign.`,
    };
  }
  const fresh = freshness(chainKey, armed, input.armedAt ?? undefined, input.now);
  if (!fresh.ok) return fresh;
  if (armed.toLowerCase() !== input.contractAddress.toLowerCase()) {
    return {
      ok: false,
      code: "address-mismatch",
      message: `contractAddress is not the executor armed for ${chainKey} (${armed}). Pin the armed contract, or arm this one first.`,
    };
  }
  return fresh;
}

/**
 * Legacy hash-only re-pin: it can only refresh the bytecode record of an
 * activation whose address already matches the live arm. It cannot introduce an
 * address, so an activation with no pinned address must use the executor flow.
 */
export function checkHashOnlyPin(input: {
  chainId: number;
  pinnedAddress?: string | null;
  armedAddress?: string | null;
  armedAt?: number | null;
  now: number;
}): PinGuardResult {
  const chainKey = chainKeyForPin(input.chainId);
  if (!chainKey) {
    return {
      ok: false,
      code: "unsupported-chain",
      message: `Bytecode pinning is not supported for chain ${input.chainId}.`,
    };
  }
  const pinned = (input.pinnedAddress ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pinned)) {
    return {
      ok: false,
      code: "no-pinned-address",
      message:
        "This activation has no pinned executor address. Use Inspect code → Confirm & pin executor: a hash alone does not bind to a contract.",
    };
  }
  const armed = (input.armedAddress ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(armed)) {
    return {
      ok: false,
      code: "no-arm",
      message: `No executor is armed for ${chainKey} in this operator's terminal. Arm the deployment on the Contract page first.`,
    };
  }
  const fresh = freshness(chainKey, armed, input.armedAt ?? undefined, input.now);
  if (!fresh.ok) return fresh;
  if (armed.toLowerCase() !== pinned.toLowerCase()) {
    return {
      ok: false,
      code: "address-mismatch",
      message: `This activation pins ${pinned}, which is not the executor armed for ${chainKey} (${armed}). Pin the armed executor first.`,
    };
  }
  return fresh;
}
