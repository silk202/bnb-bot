/**
 * Chain activation records — read from the backend, never from this bundle.
 *
 * An activation says "live signing is approved for this chain, until this
 * instant, for this executor contract". It is an authorization decision, and
 * it lives in the Convex `chainActivations` table, written only by
 * operator-gated mutations. Everything in this module is the READ side:
 *
 *   - `hydrateActivations()` takes the backend query result,
 *   - `evaluateActivation()` is pure and decides ACTIVE / EXPIRED / SUSPENDED /
 *     REVOKED / PENDING / none from those rows and a clock,
 *   - `isFormallyActivated()` is what the execution gate calls.
 *
 * Nothing here trusts browser storage, an armed contract, or a value compiled
 * into the app. Until the backend rows arrive the store is "not loaded" and
 * every chain is treated as NOT activated — a failed query, an offline tab or
 * a manipulated `localStorage` cannot manufacture an approval.
 *
 * Records are data, not UI state: no component can create or edit one, and a
 * record only counts when chain id, environment and scope match exactly.
 */
import type { NetworkEnvironment } from "./chain-types";

export type ActivationStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";

/** What an activation authorizes. Signing only — never a withdrawal. */
export const ACTIVATION_SCOPE = "live-signing" as const;

export interface ChainActivation {
  chainId: number;
  environment: NetworkEnvironment;
  scope: typeof ACTIVATION_SCOPE;
  /** Status as stored in the backend (expiry may still make it expire). */
  status: ActivationStatus;
  approvedBy?: string;
  activatedAt?: number;
  expiresAt?: number;
  /** Executor approved for live signing. When set, arming another one refuses. */
  contractAddress?: string;
  contractCodeHash?: string;
  /** When the backend itself read the approved runtime code (ms). */
  contractCodeInspectedAt?: number;
  /** Host of the RPC that answered that read (no path/keys). */
  contractCodeRpcHost?: string;
  evidenceRefs: string[];
  validationSnapshotId?: string;
  revocationReason?: string;
}

export type ActivationState =
  | "active"
  | "expired"
  | "suspended"
  | "revoked"
  | "pending"
  | "none"
  | "not-loaded";

export interface ActivationView {
  state: ActivationState;
  record?: ChainActivation;
  /** Human-readable reason, suitable for a refusal message. */
  reason: string;
  /** True only for an unexpired ACTIVE record. */
  activated: boolean;
  /** When the backend rows were last hydrated (0 = never). */
  loadedAt: number;
}

const STATUSES: readonly ActivationStatus[] = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "EXPIRED",
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

let records: ChainActivation[] = [];
let loadedAt = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break the gate.
    }
  }
}

/** Subscribe to hydration changes (used by the diagnostics panel). */
export function subscribeActivations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the current rows were loaded; 0 when the store has never loaded. */
export function activationStoreLoadedAt(): number {
  return loadedAt;
}

export function activationStoreLoaded(): boolean {
  return loadedAt > 0;
}

/**
 * Replace the store with the backend's current rows.
 *
 * Rows are validated defensively: a malformed chain id, environment, scope or
 * status is dropped rather than guessed at. The source of the rows is the
 * caller's responsibility — in the app that is the `currentActivations` query.
 */
export function hydrateActivations(rows: readonly unknown[], now = Date.now()): void {
  const next: ChainActivation[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const chainId = row.chainId;
    const environment = row.environment;
    const scope = row.scope;
    const status = row.status;
    if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) continue;
    if (environment !== "mainnet" && environment !== "testnet") continue;
    if (scope !== ACTIVATION_SCOPE) continue;
    if (typeof status !== "string" || !STATUSES.includes(status as ActivationStatus)) continue;
    const evidenceRefs = Array.isArray(row.evidenceRefs)
      ? row.evidenceRefs.filter((ref): ref is string => typeof ref === "string").slice(0, 20)
      : [];
    next.push({
      chainId,
      environment,
      scope: ACTIVATION_SCOPE,
      status: status as ActivationStatus,
      approvedBy: typeof row.approvedBy === "string" ? row.approvedBy : undefined,
      activatedAt: typeof row.activatedAt === "number" ? row.activatedAt : undefined,
      expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : undefined,
      contractAddress:
        typeof row.contractAddress === "string" && ADDRESS.test(row.contractAddress)
          ? row.contractAddress
          : undefined,
      contractCodeHash:
        typeof row.contractCodeHash === "string" ? row.contractCodeHash : undefined,
      contractCodeInspectedAt:
        typeof row.contractCodeInspectedAt === "number" &&
        Number.isFinite(row.contractCodeInspectedAt)
          ? row.contractCodeInspectedAt
          : undefined,
      contractCodeRpcHost:
        typeof row.contractCodeRpcHost === "string" ? row.contractCodeRpcHost : undefined,
      evidenceRefs,
      validationSnapshotId:
        typeof row.validationSnapshotId === "string" ? row.validationSnapshotId : undefined,
      revocationReason:
        typeof row.revocationReason === "string" ? row.revocationReason : undefined,
    });
  }
  records = next;
  loadedAt = now;
  notify();
}

/** Forget every row — used by tests. The app never calls this. */
export function resetActivationStore(): void {
  records = [];
  loadedAt = 0;
  notify();
}

/** Current store contents (read-only copy). */
export function activationRecords(): readonly ChainActivation[] {
  return records;
}

/**
 * Decide a chain's activation state from the given rows and clock.
 *
 * Pure, so the gate's behaviour under expiry, suspension and revocation is
 * testable without a backend.
 */
export function evaluateActivation(
  rows: readonly ChainActivation[],
  chainId: number,
  environment: NetworkEnvironment,
  now: number,
  loaded: boolean,
): ActivationView {
  if (!loaded) {
    return {
      state: "not-loaded",
      activated: false,
      loadedAt: 0,
      reason:
        "No backend chain-activation record has been loaded — live signing is refused until the backend answers. A local flag, an armed contract or browser storage cannot substitute for it.",
    };
  }
  const matching = rows.filter(
    (row) =>
      row.chainId === chainId && row.environment === environment && row.scope === ACTIVATION_SCOPE,
  );
  if (matching.length === 0) {
    return {
      state: "none",
      activated: false,
      loadedAt,
      reason: `Chain ${chainId} has no formal activation record — arming alone does not authorize live signing.`,
    };
  }
  // Most recent approval wins; a chain cannot have two live approvals.
  const record = [...matching].sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0))[0];
  if (record.status === "ACTIVE") {
    if (!record.expiresAt || record.expiresAt <= now) {
      return {
        state: "expired",
        record,
        activated: false,
        loadedAt,
        reason: `The activation for chain ${chainId} has expired${record.expiresAt ? ` (${new Date(record.expiresAt).toISOString()})` : " (no expiry recorded)"} — revalidate and renew it before signing.`,
      };
    }
    return {
      state: "active",
      record,
      activated: true,
      loadedAt,
      reason: `Chain ${chainId} is activated until ${new Date(record.expiresAt).toISOString()}${record.approvedBy ? ` by ${record.approvedBy}` : ""}.`,
    };
  }
  if (record.status === "EXPIRED") {
    return {
      state: "expired",
      record,
      activated: false,
      loadedAt,
      reason: `The activation for chain ${chainId} has expired — revalidate and renew it before signing.`,
    };
  }
  if (record.status === "SUSPENDED") {
    return {
      state: "suspended",
      record,
      activated: false,
      loadedAt,
      reason: `The activation for chain ${chainId} is suspended — live signing stays refused until an operator lifts the suspension.`,
    };
  }
  if (record.status === "REVOKED") {
    return {
      state: "revoked",
      record,
      activated: false,
      loadedAt,
      reason: `The activation for chain ${chainId} was revoked${record.revocationReason ? `: ${record.revocationReason}` : "."}`,
    };
  }
  return {
    state: "pending",
    record,
    activated: false,
    loadedAt,
    reason: `Chain ${chainId} has a PENDING activation request but no approval — live signing is not authorized.`,
  };
}

/** Activation state for a chain, from the hydrated backend rows. */
export function activationStateFor(
  chainId: number,
  environment: NetworkEnvironment,
  now = Date.now(),
): ActivationView {
  return evaluateActivation(records, chainId, environment, now, activationStoreLoaded());
}

/** The active record for a chain, if any (expiry already applied). */
export function activationFor(
  chainId: number,
  environment: NetworkEnvironment,
  now = Date.now(),
): ChainActivation | undefined {
  const view = activationStateFor(chainId, environment, now);
  return view.activated ? view.record : undefined;
}

/** True only for an unexpired, backend-recorded, ACTIVE approval. */
export function isFormallyActivated(
  chainId: number,
  environment: NetworkEnvironment,
  now = Date.now(),
): boolean {
  return activationStateFor(chainId, environment, now).activated;
}

/** One-line summary for diagnostics. */
export function activationSummary(now = Date.now()): string {
  if (!activationStoreLoaded()) return "no backend activation records loaded";
  if (records.length === 0) return "backend returned no activation records";
  return records
    .map((record) => {
      const view = evaluateActivation(records, record.chainId, record.environment, now, true);
      return `${record.chainId}/${record.environment} ${view.state}${record.expiresAt ? ` until ${new Date(record.expiresAt).toISOString()}` : ""}`;
    })
    .join("; ");
}
