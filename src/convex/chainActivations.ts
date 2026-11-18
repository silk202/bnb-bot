/**
 * Chain activation — authorization records, not validation results.
 *
 * The four controls stay independent:
 *   1. an armed executor proves a deployment exists,
 *   2. a validation snapshot proves what was technically checked,
 *   3. an activation record is a human approval for a bounded term,
 *   4. a payout path decides where value may move (internal only today).
 *
 * Nothing here grants a transfer: activation authorizes LIVE SIGNING for a
 * chain and an optional executor address. External withdrawals are refused by
 * `authorizeExternalWithdrawal` regardless of any row in these tables.
 *
 * Who may write: only an authenticated operator (`requireOperator`, the same
 * server-side identity check the operator console uses). A subscriber, a
 * browser, `localStorage` and the frontend build cannot create, extend,
 * suspend or revive an activation.
 *
 * Append-only history: every transition writes a `chainActivationAudit` row.
 * There is no mutation that edits or deletes an audit row, and no mutation that
 * silently rewrites a previous approval — supersede/revoke add new rows.
 *
 * Expiry is derived, not trusted: an ACTIVE row whose `expiresAt` has passed is
 * reported as EXPIRED here, so a stale approval stops authorizing signing even
 * if nobody ran a cleanup. Revocation is immediate.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  isOperatorEmail,
  operatorIdentityFrom,
  requireOperator,
  resolveOperatorIdentity,
} from "./operatorEmails";
import {
  checkExecutorPin,
  checkHashOnlyPin,
  chainKeyForPin,
  INSPECTION_TTL_MS,
  inspectionExpiresAt,
  isInspectionFresh,
} from "./pinGuard";
import { observeRuntimeCode } from "./bytecodeGuard";

const DAY_MS = 86_400_000;
/** An approval term can never exceed 180 days. */
const MAX_TERM_MS = 180 * DAY_MS;
/** How long an unreferenced observation is kept after its freshness window. */
const EVIDENCE_KEEP_MS = 7 * DAY_MS;
/** Evidence rows one prune run may inspect (bounded; backlogs drain per run). */
const MAX_EVIDENCE_PRUNE = 250;
/** Evidence rows the dry-run stats query reads in one window. */
const MAX_EVIDENCE_STATS = 2_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The RPCs the server itself will read the executor's code from: the operator's
 * validated endpoints for this chain (fastest first, bounded), then the public
 * fallback added by `verifyCodeHashOnChain`.
 */
async function chainRpcUrls(ctx: { db: QueryCtx["db"] }, chainId: number): Promise<string[]> {
  try {
    const rows = await ctx.db
      .query("rpcEndpoints")
      .withIndex("by_chain_status", (q) => q.eq("chainId", chainId).eq("status", "VALIDATED"))
      .collect();
    const now = Date.now();
    return rows
      .filter((row) => row.status === "VALIDATED" && row.expiresAt > now)
      .sort((a, b) => (a.latencyMs ?? 9_999) - (b.latencyMs ?? 9_999))
      .slice(0, 3)
      .map((row) => row.url);
  } catch {
    return [];
  }
}

/** The armed execution record in the CALLING operator's terminal, for one chain. */
async function armFor(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
  chainKey: string,
): Promise<{ armedAddress: string; armedAt?: number }> {
  const state = await ctx.db
    .query("terminalStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  const record = state?.deployments?.[chainKey];
  return { armedAddress: (record?.contractAddress ?? "").trim(), armedAt: record?.armedAt };
}

/**
 * Fresh server-side evidence for an approval: a row the `inspectExecutorCode`
 * action wrote after reading the code itself. The pin mutations never read the
 * chain (Convex forbids fetch in mutations) — they require this record, which no
 * client can create.
 */
async function freshInspection(
  ctx: { db: MutationCtx["db"] },
  args: { chainId: number; address: string; codeHash: string; actorId: string; now: number },
) {
  const address = args.address.toLowerCase();
  const rows = await ctx.db
    .query("executorCodeInspections")
    .withIndex("by_chain_address", (q) => q.eq("chainId", args.chainId).eq("address", address))
    .collect();
  const expected = args.codeHash.toLowerCase();
  return (
    rows
      .filter(
        (row) =>
          row.actorId === args.actorId &&
          row.codeHash === expected &&
          isInspectionFresh(row.inspectedAt, args.now),
      )
      .sort((a, b) => b.inspectedAt - a.inspectedAt)[0] ?? null
  );
}

/**
 * Every evidence row an approval currently rests on.
 *
 * Typed against the READER so the dry-run query can use it too; a mutation's
 * database writer is a superset of the reader, so both callers type-check.
 */
async function referencedInspectionIds(ctx: { db: QueryCtx["db"] }): Promise<Set<string>> {
  const rows = await ctx.db.query("chainActivations").collect();
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.contractCodeInspectionId) ids.add(row.contractCodeInspectionId);
  }
  return ids;
}

/**
 * Delete aged observations, but never one an approval points at.
 *
 * `contractCodeInspectionId` is a live trace from an approval to the exact
 * observation it rests on. Deleting that row would leave the pointer dangling
 * — an audit reader would find an id that resolves to nothing while the audit
 * text still claims evidence. The approval's copied fields (`inspectedAt`,
 * `rpcHost`, hash) would survive, but "the row is gone" is not something a
 * safety check should have to interpret, so referenced rows are retained.
 *
 * Rows are taken oldest-first, so a window made entirely of retained rows waits
 * for the next run instead of forcing a deletion; retained rows are bounded by
 * the number of approvals, which is small by construction.
 */
async function pruneExpiredInspections(
  ctx: MutationCtx,
  args: { now: number; keepMs: number; limit: number; actorId?: string },
): Promise<{ deleted: number; retained: number; scanned: number }> {
  const cutoff = args.now - args.keepMs;
  const rows = args.actorId
    ? await ctx.db
        .query("executorCodeInspections")
        .withIndex("by_actor", (q) => q.eq("actorId", args.actorId!).lt("inspectedAt", cutoff))
        .take(args.limit)
    : await ctx.db
        .query("executorCodeInspections")
        .withIndex("by_inspected_at", (q) => q.lt("inspectedAt", cutoff))
        .take(args.limit);
  if (rows.length === 0) return { deleted: 0, retained: 0, scanned: 0 };
  const referenced = await referencedInspectionIds(ctx);
  let deleted = 0;
  let retained = 0;
  for (const row of rows) {
    if (referenced.has(row._id)) {
      retained++;
      continue;
    }
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { deleted, retained, scanned: rows.length };
}

function missingInspectionMessage(address: string): string {
  return `No fresh server-side inspection of ${address}. Use Inspect code — the backend reads the runtime code from this chain and records what it saw — then confirm within ${INSPECTION_TTL_MS / 60_000} minutes.`;
}

const CODE_HASH = /^0x[0-9a-fA-F]{64}$/;

export const STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"] as const;
export type ActivationStatus = (typeof STATUSES)[number];

const environmentValidator = v.union(v.literal("mainnet"), v.literal("testnet"));

/**
 * The status the rest of the system acts on: an ACTIVE row past its expiry is
 * EXPIRED. Everything else is stored as written.
 */
export function effectiveStatus(
  row: { status: string; expiresAt?: number },
  now: number,
): ActivationStatus {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as ActivationStatus)
    : "REVOKED";
  if (status === "ACTIVE" && (!row.expiresAt || row.expiresAt <= now)) return "EXPIRED";
  return status;
}

/** A row is live only while it is ACTIVE and unexpired. */
export function isLiveActivation(
  row: { status: string; expiresAt?: number },
  now: number,
): boolean {
  return effectiveStatus(row, now) === "ACTIVE";
}

async function appendAudit(
  ctx: MutationCtx,
  args: {
    activationId: Id<"chainActivations">;
    chainId: number;
    actorId: string;
    action: string;
    previousStatus?: string;
    newStatus: string;
    reason?: string;
  },
): Promise<void> {
  await ctx.db.insert("chainActivationAudit", {
    activationId: args.activationId,
    chainId: args.chainId,
    actorId: args.actorId,
    action: args.action,
    previousStatus: args.previousStatus,
    newStatus: args.newStatus,
    reason: args.reason,
    createdAt: Date.now(),
  });
}

function requireString(value: string | undefined, field: string, max = 500): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed.slice(0, max);
}

function requireReason(reason: string | undefined, action: string): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 4) {
    throw new Error(`A reason of at least 4 characters is required to ${action}.`);
  }
  return trimmed.slice(0, 500);
}

function requireAddress(address: string, field: string): string {
  if (!ADDRESS.test(address)) throw new Error(`${field} must be a 0x-prefixed 20-byte address.`);
  return address;
}

function requireTerm(expiresAt: number, now: number): number {
  if (!Number.isFinite(expiresAt)) throw new Error("expiresAt must be a timestamp.");
  if (expiresAt <= now) throw new Error("expiresAt must be in the future.");
  if (expiresAt > now + MAX_TERM_MS) {
    throw new Error("An activation term may not exceed 180 days — revalidate and renew.");
  }
  return expiresAt;
}

/**
 * Operator check for query handlers.
 *
 * Statically imported on purpose: a dynamic `import()` inside a Convex
 * function breaks the function's module graph (the analyzer resolves imports at
 * push time), so the query would fail at runtime with "Cannot find module".
 */
async function isOperatorQuery(ctx: QueryCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.email) return false;
  return await isOperatorEmail(ctx, identity.email);
}

/** Rows that currently hold (or block) live signing for a chain. */
async function liveRowsFor(
  ctx: { db: QueryCtx["db"] },
  chainId: number,
  environment: string,
) {
  const rows = await ctx.db
    .query("chainActivations")
    .withIndex("by_chain", (q) => q.eq("chainId", chainId).eq("environment", environment))
    .collect();
  return rows.filter((row) => ["PENDING", "ACTIVE", "SUSPENDED"].includes(effectiveStatus(row, Date.now())));
}

/** Record a validation snapshot (technical evidence only). Operator-only. */
export const recordValidationSnapshot = mutation({
  args: {
    chainId: v.number(),
    environment: environmentValidator,
    softwareVersion: v.string(),
    checks: v.array(v.object({ id: v.string(), ok: v.boolean(), detail: v.string() })),
    unverified: v.array(v.string()),
    contractAddress: v.optional(v.string()),
    contractCodeHash: v.optional(v.string()),
    rpcEndpoints: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    if (args.checks.length === 0 && args.unverified.length === 0) {
      throw new Error("A snapshot must record at least one check or one unverified item.");
    }
    return await ctx.db.insert("chainValidationSnapshots", {
      chainId: args.chainId,
      environment: args.environment,
      createdAt: Date.now(),
      createdBy: actor,
      softwareVersion: requireString(args.softwareVersion, "softwareVersion", 120),
      checks: args.checks.slice(0, 100).map((c) => ({
        id: c.id.slice(0, 120),
        ok: Boolean(c.ok),
        detail: c.detail.slice(0, 500),
      })),
      unverified: args.unverified.slice(0, 100).map((u) => u.slice(0, 300)),
      contractAddress: args.contractAddress
        ? requireAddress(args.contractAddress, "contractAddress")
        : undefined,
      contractCodeHash: args.contractCodeHash
        ? CODE_HASH.test(args.contractCodeHash)
          ? args.contractCodeHash
          : (() => {
              throw new Error("contractCodeHash must be a 32-byte 0x hash.");
            })()
        : undefined,
      rpcEndpoints: args.rpcEndpoints.slice(0, 20),
    });
  },
});

/** Open a PENDING activation request for a chain. Operator-only. */
export const createActivation = mutation({
  args: {
    chainId: v.number(),
    environment: environmentValidator,
    evidenceRefs: v.array(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    const evidenceRefs = args.evidenceRefs
      .map((ref) => ref.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (evidenceRefs.length === 0) {
      throw new Error("At least one evidence reference (report/issue/change record) is required.");
    }
    const existing = await liveRowsFor(ctx, args.chainId, args.environment);
    if (existing.length > 0) {
      throw new Error(
        `Chain ${args.chainId} already has a ${effectiveStatus(existing[0], Date.now())} activation — suspend or revoke it first.`,
      );
    }
    const id = await ctx.db.insert("chainActivations", {
      chainId: args.chainId,
      environment: args.environment,
      scope: "live-signing",
      status: "PENDING",
      operatorId: actor,
      evidenceRefs,
      revocationReason: args.reason?.slice(0, 500),
    });
    await appendAudit(ctx, {
      activationId: id,
      chainId: args.chainId,
      actorId: actor,
      action: "created",
      newStatus: "PENDING",
      reason: args.reason?.slice(0, 500),
    });
    return id;
  },
});

/**
 * Approve an activation for a bounded term.
 *
 * Requires a validation snapshot for the same chain, a positive term of at most
 * 180 days, and an executor address. Any other live row for the chain is
 * superseded (revoked with a pointer to this one) — exactly one approval can be
 * live per chain/environment.
 */
export const approveActivation = mutation({
  args: {
    activationId: v.id("chainActivations"),
    validationSnapshotId: v.id("chainValidationSnapshots"),
    contractAddress: v.string(),
    contractCodeHash: v.optional(v.string()),
    expiresAt: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const current = effectiveStatus(row, now);
    if (current !== "PENDING" && current !== "EXPIRED") {
      throw new Error(`Only a PENDING or EXPIRED activation can be approved (this one is ${current}).`);
    }
    const snapshot = await ctx.db.get(args.validationSnapshotId);
    if (!snapshot) throw new Error("Validation snapshot not found.");
    if (snapshot.chainId !== row.chainId || snapshot.environment !== row.environment) {
      throw new Error("The validation snapshot belongs to a different chain/environment.");
    }
    const contractAddress = requireAddress(args.contractAddress, "contractAddress");
    if (args.contractCodeHash && !CODE_HASH.test(args.contractCodeHash)) {
      throw new Error("contractCodeHash must be a 32-byte 0x hash.");
    }
    const expiresAt = requireTerm(args.expiresAt, now);
    const reason = requireReason(args.reason, "approve an activation");

    // Supersede any other live approval for this chain before this one lands.
    for (const other of await liveRowsFor(ctx, row.chainId, row.environment)) {
      if (other._id === row._id) continue;
      const previous = effectiveStatus(other, now);
      await ctx.db.patch(other._id, {
        status: "REVOKED",
        revokedAt: now,
        revocationReason: `Superseded by activation ${args.activationId}`,
        supersededBy: args.activationId,
      });
      await appendAudit(ctx, {
        activationId: other._id,
        chainId: other.chainId,
        actorId: actor,
        action: "superseded",
        previousStatus: previous,
        newStatus: "REVOKED",
        reason: `Superseded by activation ${args.activationId}`,
      });
    }

    await ctx.db.patch(args.activationId, {
      status: "ACTIVE",
      approvedBy: actor,
      validationSnapshotId: args.validationSnapshotId,
      contractAddress,
      contractCodeHash: args.contractCodeHash,
      activatedAt: now,
      expiresAt,
    });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId: actor,
      action: "approved",
      previousStatus: current,
      newStatus: "ACTIVE",
      reason,
    });
    return { activationId: args.activationId, expiresAt };
  },
});

/** Extend an ACTIVE or EXPIRED approval after fresh validation. Operator-only. */
export const renewActivation = mutation({
  args: {
    activationId: v.id("chainActivations"),
    validationSnapshotId: v.id("chainValidationSnapshots"),
    expiresAt: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const current = effectiveStatus(row, now);
    if (current !== "ACTIVE" && current !== "EXPIRED") {
      throw new Error(`Only an ACTIVE or EXPIRED activation can be renewed (this one is ${current}).`);
    }
    const snapshot = await ctx.db.get(args.validationSnapshotId);
    if (!snapshot) throw new Error("Validation snapshot not found.");
    if (snapshot.chainId !== row.chainId || snapshot.environment !== row.environment) {
      throw new Error("The validation snapshot belongs to a different chain/environment.");
    }
    const expiresAt = requireTerm(args.expiresAt, now);
    const reason = requireReason(args.reason, "renew an activation");
    await ctx.db.patch(args.activationId, {
      status: "ACTIVE",
      validationSnapshotId: args.validationSnapshotId,
      expiresAt,
    });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId: actor,
      action: "renewed",
      previousStatus: current,
      newStatus: "ACTIVE",
      reason,
    });
    return { activationId: args.activationId, expiresAt };
  },
});

/**
 * Pin the deployed executor's runtime bytecode to this approval.
 *
 * `codeHash` is keccak256 of `eth_getCode(executor)`, computed by the operator's
 * client from the live chain. Once pinned, the signing path re-reads the code
 * and refuses when it differs — a contract swap under an existing approval no
 * longer inherits its authorization.
 */
export const pinContractCodeHash = mutation({
  args: {
    activationId: v.id("chainActivations"),
    codeHash: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId, actorId } = await resolveOperatorIdentity(ctx, { allowGuest: true });
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    if (effectiveStatus(row, now) !== "ACTIVE") {
      throw new Error("Only an ACTIVE activation can have its contract pinned.");
    }
    if (!CODE_HASH.test(args.codeHash)) {
      throw new Error("codeHash must be a 32-byte 0x hash (keccak256 of the runtime code).");
    }
    const chainKey = chainKeyForPin(row.chainId);
    const arm = chainKey ? await armFor(ctx, userId, chainKey) : { armedAddress: "" };
    const guard = checkHashOnlyPin({
      chainId: row.chainId,
      pinnedAddress: row.contractAddress,
      armedAddress: arm.armedAddress,
      armedAt: arm.armedAt,
      now,
    });
    if (!guard.ok) throw new Error(guard.message);
    // The hash must be one the BACKEND observed on this chain: a hash the browser
    // made up (or read from a different chain) can never become an approval.
    const inspection = await freshInspection(ctx, {
      chainId: row.chainId,
      address: row.contractAddress!,
      codeHash: args.codeHash,
      actorId,
      now,
    });
    if (!inspection) throw new Error(missingInspectionMessage(row.contractAddress!));
    const reason = requireReason(args.reason, "pin a contract bytecode hash");
    // The approval points at the evidence row it rests on, so it stays
    // traceable (id, read time, RPC host) after the observation is pruned.
    await ctx.db.patch(args.activationId, {
      contractCodeHash: inspection.codeHash,
      contractCodeInspectionId: inspection._id,
      contractCodeInspectedAt: inspection.inspectedAt,
      contractCodeRpcHost: inspection.rpcHost,
    });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId,
      action: "contract-pinned",
      previousStatus: "ACTIVE",
      newStatus: "ACTIVE",
      reason: `${reason} — hash-only re-pin of armed ${row.contractAddress} (${inspection.codeHash.slice(0, 12)}…, ${inspection.bytes} bytes read by the server via ${inspection.rpcHost}; evidence ${inspection._id})`,
    });
    return {
      activationId: args.activationId,
      codeHash: inspection.codeHash,
      bytes: inspection.bytes,
      inspectionId: inspection._id,
      inspectedAt: inspection.inspectedAt,
      expiresAt: inspectionExpiresAt(inspection.inspectedAt),
    };
  },
});

/**
 * Pin the approved executor contract AND its runtime code hash together.
 *
 * The two belong together: an activation that pins a hash but no address still
 * accepts whatever is armed, and an address with no hash accepts a swapped
 * contract. This is the single action the executor-registration flow calls.
 */
export const pinExecutorContract = mutation({
  args: {
    activationId: v.id("chainActivations"),
    contractAddress: v.string(),
    codeHash: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId, actorId } = await resolveOperatorIdentity(ctx, { allowGuest: true });
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const status = effectiveStatus(row, now);
    if (status !== "ACTIVE") {
      throw new Error(
        `Only an ACTIVE activation can pin an executor (this one is ${status}). Approve the activation first.`,
      );
    }
    if (!ADDRESS.test(args.contractAddress)) {
      throw new Error("contractAddress must be a 0x-prefixed 20-byte address.");
    }
    if (!CODE_HASH.test(args.codeHash)) {
      throw new Error("codeHash must be a 32-byte 0x hash (keccak256 of the runtime code).");
    }
    // Cross-check the armed executor HERE, not only in the console: an approval
    // for an address the terminal never arms authorizes a contract that cannot
    // sign, while the armed one stays unapproved and every payout refuses. The
    // same guard rejects an arm too old to describe the deployment being approved.
    const chainKey = chainKeyForPin(row.chainId);
    const arm = chainKey ? await armFor(ctx, userId, chainKey) : { armedAddress: "" };
    const guard = checkExecutorPin({
      chainId: row.chainId,
      contractAddress: args.contractAddress,
      armedAddress: arm.armedAddress,
      armedAt: arm.armedAt,
      now,
    });
    if (!guard.ok) throw new Error(guard.message);
    // Address AND hash are approved here: the arm says which contract, and the
    // hash must match what the backend itself read from the chain minutes ago.
    const inspection = await freshInspection(ctx, {
      chainId: row.chainId,
      address: args.contractAddress,
      codeHash: args.codeHash,
      actorId,
      now,
    });
    if (!inspection) throw new Error(missingInspectionMessage(args.contractAddress));
    const reason = requireReason(args.reason, "pin an executor contract");
    await ctx.db.patch(args.activationId, {
      contractAddress: args.contractAddress,
      contractCodeHash: inspection.codeHash,
      contractCodeInspectionId: inspection._id,
      contractCodeInspectedAt: inspection.inspectedAt,
      contractCodeRpcHost: inspection.rpcHost,
    });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId,
      action: "contract-pinned",
      previousStatus: status,
      newStatus: status,
      reason: `${reason} — ${args.contractAddress} @ ${inspection.codeHash.slice(0, 12)}… (${inspection.bytes} bytes read by the server via ${inspection.rpcHost}; evidence ${inspection._id})`,
    });
    return {
      activationId: args.activationId,
      contractAddress: args.contractAddress,
      codeHash: inspection.codeHash,
      bytes: inspection.bytes,
      inspectionId: inspection._id,
      inspectedAt: inspection.inspectedAt,
      expiresAt: inspectionExpiresAt(inspection.inspectedAt),
    };
  },
});

/** Suspend (reversible stop). Operator-only. */
export const suspendActivation = mutation({
  args: { activationId: v.id("chainActivations"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const current = effectiveStatus(row, now);
    if (current === "REVOKED" || current === "SUSPENDED") {
      throw new Error(`Activation is already ${current}.`);
    }
    const reason = requireReason(args.reason, "suspend an activation");
    await ctx.db.patch(args.activationId, { status: "SUSPENDED" });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId: actor,
      action: "suspended",
      previousStatus: current,
      newStatus: "SUSPENDED",
      reason,
    });
    return { activationId: args.activationId };
  },
});

/** Revoke (terminal stop). Operator-only; a revoked record never revives. */
export const revokeActivation = mutation({
  args: { activationId: v.id("chainActivations"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const current = effectiveStatus(row, now);
    if (current === "REVOKED") throw new Error("Activation is already REVOKED.");
    const reason = requireReason(args.reason, "revoke an activation");
    await ctx.db.patch(args.activationId, {
      status: "REVOKED",
      revokedAt: now,
      revocationReason: reason,
    });
    await appendAudit(ctx, {
      activationId: args.activationId,
      chainId: row.chainId,
      actorId: actor,
      action: "revoked",
      previousStatus: current,
      newStatus: "REVOKED",
      reason,
    });
    return { activationId: args.activationId };
  },
});

/**
 * The client gate's read path.
 *
 * Readable by any signed-in user: the gate runs in the browser and needs the
 * authoritative status. What it returns is status only — no secrets, and it
 * cannot be written by the caller. Anonymous callers get an empty list, which
 * the gate treats as "no activation" (fail closed).
 */
export const currentActivations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const rows = await ctx.db.query("chainActivations").collect();
    return rows
      .map((row) => ({
        chainId: row.chainId,
        environment: row.environment,
        scope: row.scope,
        status: effectiveStatus(row, now),
        storedStatus: row.status,
        activatedAt: row.activatedAt,
        expiresAt: row.expiresAt,
        approvedBy: row.approvedBy,
        contractAddress: row.contractAddress,
        contractCodeHash: row.contractCodeHash,
        contractCodeInspectedAt: row.contractCodeInspectedAt,
        contractCodeRpcHost: row.contractCodeRpcHost,
        evidenceRefs: row.evidenceRefs,
        validationSnapshotId: row.validationSnapshotId,
        revokedAt: row.revokedAt,
        revocationReason: row.revocationReason,
      }))
      .sort((a, b) => a.chainId - b.chainId);
  },
});

/** Full history for the operator console. Operator-only. */
export const activationHistory = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isOperatorQuery(ctx))) return [];
    const now = Date.now();
    const rows = args.chainId
      ? await ctx.db
          .query("chainActivations")
          .withIndex("by_chain", (q) =>
            q.eq("chainId", args.chainId!).eq("environment", "mainnet"),
          )
          .collect()
      : await ctx.db.query("chainActivations").collect();
    return rows
      .map((row) => ({
        ...row,
        effectiveStatus: effectiveStatus(row, now),
      }))
      .sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0));
  },
});

/** Append-only audit entries for an activation. Operator-only. */
export const auditTrail = query({
  args: { activationId: v.id("chainActivations") },
  handler: async (ctx, args) => {
    if (!(await isOperatorQuery(ctx))) return [];
    return await ctx.db
      .query("chainActivationAudit")
      .withIndex("by_activation", (q) => q.eq("activationId", args.activationId))
      .order("asc")
      .collect();
  },
});

/**
 * Bootstrap the pre-existing BSC approval into the backend.
 *
 * This exists because BSC has been signing before the activation store moved to
 * the backend; without a row there, live signing would stop the moment the
 * frontend stopped trusting its own source. It writes exactly one record for
 * chain 56 and records, in the snapshot, what could NOT be verified from this
 * repository — so the approval is honest about its own evidence.
 *
 * Internal-only: it cannot be called over the public API, and it refuses once
 * any row exists for chain 56.
 */
export const bootstrapBscActivation = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("chainActivations")
      .withIndex("by_chain", (q) => q.eq("chainId", 56).eq("environment", "mainnet"))
      .collect();
    if (existing.length > 0) {
      return { created: false, activationId: existing[0]._id, status: effectiveStatus(existing[0], now) };
    }
    const snapshotId = await ctx.db.insert("chainValidationSnapshots", {
      chainId: 56,
      environment: "mainnet",
      createdAt: now,
      createdBy: "bootstrap",
      softwareVersion: "activation-store-migration",
      checks: [
        {
          id: "chain-id",
          ok: true,
          detail: "eth_chainId 56 proven by endpoint discovery (src/chains/registry/rpc-pools.ts).",
        },
        {
          id: "rpc-health",
          ok: true,
          detail: "BSC endpoints probed; bsc.drpc.org rejected with HTTP 429, alternatives present.",
        },
        {
          id: "payout-policy",
          ok: true,
          detail: "Internal payout path requires a designated vault and realised profit; external withdrawals refused.",
        },
      ],
      unverified: [
        "executor bytecode hash — no Solidity sources or deployment transaction in this repository",
        "router/factory/token-registry addresses — not recorded in this repository",
        "flash-loan callback review — no source to review",
        "live execution simulation — requires an armed executor and funded wallet",
      ],
      rpcEndpoints: [],
    });
    const id = await ctx.db.insert("chainActivations", {
      chainId: 56,
      environment: "mainnet",
      scope: "live-signing",
      status: "ACTIVE",
      operatorId: "bootstrap",
      approvedBy: "bootstrap",
      evidenceRefs: ["reports/incident-2026-11-13-bnb-drain.md"],
      validationSnapshotId: snapshotId,
      activatedAt: now,
      // Bounded term: a 90-day approval that must be revalidated and renewed.
      expiresAt: now + 90 * DAY_MS,
      revocationReason:
        "Bootstrapped from the pre-backend BSC approval; expires unless revalidated and renewed by an operator.",
    });
    await ctx.db.insert("chainActivationAudit", {
      activationId: id,
      chainId: 56,
      actorId: "bootstrap",
      action: "created",
      newStatus: "ACTIVE",
      reason: "Migrated the pre-existing BSC live-signing approval into an expiring backend record.",
      createdAt: now,
    });
    return { created: true, activationId: id, expiresAt: now + 90 * DAY_MS };
  },
});

/**
 * Read the armed executor's runtime code FROM THE BACKEND and record what it saw.
 *
 * This is an action because Convex cannot fetch inside a mutation. It validates
 * the same pin guard the mutation will re-check (ACTIVE activation, fresh arm,
 * armed address), reads `eth_getCode` from the operator's validated RPCs and then
 * the chain's public fallback, and stores the observation. The confirmation
 * mutation accepts only that stored evidence, so the hash an approval rests on is
 * one the server read, not one the browser sent.
 */
export const inspectExecutorCode = action({
  args: {
    activationId: v.id("chainActivations"),
    address: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    address: string;
    hash: string;
    bytes: number;
    rpcHost: string;
    inspectedAt: number;
    /** Server-issued expiry — the client counts down from this, not its clock. */
    expiresAt: number;
    /** Server clock at response time, paired with `expiresAt`. */
    serverNow: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = (await getAuthUserId(ctx as unknown as QueryCtx)) as Id<"users"> | null;
    const target: {
      chainId: number;
      address: string;
      actorId: string;
      userId: Id<"users">;
      rpcUrls: string[];
    } = await ctx.runQuery(internal.chainActivations.inspectionTarget, {
      activationId: args.activationId,
      address: args.address,
      email: identity?.email ?? null,
      userId,
    });
    const observed = await observeRuntimeCode({ rpcUrls: target.rpcUrls, address: target.address });
    if (!observed.ok) throw new Error(observed.message);
    const rpcHost = new URL(observed.url).host;
    const recorded: { codeHash: string; bytes: number; inspectedAt: number } = await ctx.runMutation(
      internal.chainActivations.recordCodeInspection,
      {
        activationId: args.activationId,
        chainId: target.chainId,
        address: target.address,
        codeHash: observed.hash,
        bytes: observed.bytes,
        rpcHost,
        actorId: target.actorId,
        userId: target.userId,
      },
    );
    return {
      address: target.address,
      hash: recorded.codeHash,
      bytes: recorded.bytes,
      rpcHost,
      inspectedAt: recorded.inspectedAt,
      expiresAt: inspectionExpiresAt(recorded.inspectedAt),
      serverNow: Date.now(),
    };
  },
});

/**
 * Bound `executorCodeInspections` globally (cron: inspection-evidence-prune).
 *
 * Write-time pruning only touches the inspecting actor's own rows, so an
 * operator who inspects once and never returns would leave evidence behind
 * forever. This sweep ages everything out after a week, and retains any row an
 * approval points at so no audit link dangles. Bounded and idempotent.
 */
export const pruneInspectionEvidence = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await pruneExpiredInspections(ctx, {
      now: Date.now(),
      keepMs: EVIDENCE_KEEP_MS,
      limit: MAX_EVIDENCE_PRUNE,
    });
  },
});

/**
 * Dry run of the evidence sweep, for the operator console.
 *
 * Answers "what would the next prune touch, and what is retained?" without
 * deleting anything or writing an audit row. Rows are read OLDEST-first through
 * `by_inspected_at` — the same order the sweep takes them — because that window
 * is the part a prune can act on. Every count describes that window and
 * `capped` marks the figures as a floor; no table-wide total is claimed, since
 * counting one would mean reading the whole table on every open.
 */
export const inspectionEvidenceStats = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isOperatorQuery(ctx))) return null;
    const now = Date.now();
    const freshCutoff = now - INSPECTION_TTL_MS;
    const keepCutoff = now - EVIDENCE_KEEP_MS;
    const rows = await ctx.db
      .query("executorCodeInspections")
      .withIndex("by_inspected_at")
      .take(MAX_EVIDENCE_STATS + 1);
    const capped = rows.length > MAX_EVIDENCE_STATS;
    const window = rows.slice(0, MAX_EVIDENCE_STATS);
    const referenced = await referencedInspectionIds(ctx);

    let fresh = 0;
    let expiredReferenced = 0;
    let expiredUnreferenced = 0;
    let prunable = 0;
    let oldestPrunableAt: number | null = null;
    const byChain = new Map<number, number>();
    for (const row of window) {
      byChain.set(row.chainId, (byChain.get(row.chainId) ?? 0) + 1);
      const isReferenced = referenced.has(row._id);
      if (row.inspectedAt > freshCutoff) {
        fresh++;
        continue;
      }
      if (isReferenced) expiredReferenced++;
      else expiredUnreferenced++;
      if (!isReferenced && row.inspectedAt <= keepCutoff) {
        prunable++;
        if (oldestPrunableAt === null || row.inspectedAt < oldestPrunableAt) oldestPrunableAt = row.inspectedAt;
      }
    }

    return {
      now,
      ttlMs: INSPECTION_TTL_MS,
      keepMs: EVIDENCE_KEEP_MS,
      batchLimit: MAX_EVIDENCE_PRUNE,
      /** Rows examined in this window (oldest first). */
      scanned: window.length,
      /** True when the window filled — every count below is then a floor. */
      capped,
      fresh,
      expiredReferenced,
      expiredUnreferenced,
      /** Rows the next sweep may delete (aged past `keepMs`, unreferenced). */
      prunable,
      nextSweepWouldDelete: Math.min(prunable, MAX_EVIDENCE_PRUNE),
      oldestPrunableAt,
      oldestInspectedAt: window[0]?.inspectedAt ?? null,
      newestInspectedAt: window[window.length - 1]?.inspectedAt ?? null,
      /** Distinct evidence rows an approval currently points at (never pruned). */
      referencedIds: referenced.size,
      byChain: [...byChain.entries()]
        .map(([chainId, count]) => ({ chainId, rows: count }))
        .sort((a, b) => b.rows - a.rows || a.chainId - b.chainId),
    };
  },
});

/**
 * Validate an inspection request against the same rules the pin applies.
 *
 * Internal: only the action above may call it, with claims the action read from
 * its own auth context.
 */
export const inspectionTarget = internalQuery({
  args: {
    activationId: v.id("chainActivations"),
    address: v.string(),
    email: v.union(v.string(), v.null()),
    userId: v.union(v.id("users"), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    chainId: number;
    address: string;
    actorId: string;
    userId: Id<"users">;
    rpcUrls: string[];
  }> => {
    const identity = await operatorIdentityFrom(
      ctx,
      { email: args.email, userId: args.userId },
      { allowGuest: true },
    );
    const now = Date.now();
    const row = await ctx.db.get(args.activationId);
    if (!row) throw new Error("Activation not found.");
    const status = effectiveStatus(row, now);
    if (status !== "ACTIVE") {
      throw new Error(
        `Only an ACTIVE activation can have its executor inspected (this one is ${status}). Approve the activation first.`,
      );
    }
    if (!ADDRESS.test(args.address)) {
      throw new Error("address must be a 0x-prefixed 20-byte address.");
    }
    const chainKey = chainKeyForPin(row.chainId);
    const arm = chainKey ? await armFor(ctx, identity.userId, chainKey) : { armedAddress: "" };
    const guard = checkExecutorPin({
      chainId: row.chainId,
      contractAddress: args.address,
      armedAddress: arm.armedAddress,
      armedAt: arm.armedAt,
      now,
    });
    if (!guard.ok) throw new Error(guard.message);
    return {
      chainId: row.chainId,
      address: args.address.toLowerCase(),
      actorId: identity.actorId,
      userId: identity.userId,
      rpcUrls: await chainRpcUrls(ctx, row.chainId),
    };
  },
});

/**
 * Store one observation. Internal: it runs only after the action has read the
 * chain, and it keeps the evidence table bounded by dropping rows that have
 * already expired.
 */
export const recordCodeInspection = internalMutation({
  args: {
    activationId: v.id("chainActivations"),
    chainId: v.number(),
    address: v.string(),
    codeHash: v.string(),
    bytes: v.number(),
    rpcHost: v.string(),
    actorId: v.string(),
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    activationId: Id<"chainActivations">;
    chainId: number;
    address: string;
    codeHash: string;
    bytes: number;
    rpcHost: string;
    actorId: string;
    userId: Id<"users">;
    inspectedAt: number;
  }> => {
    const inspectedAt = Date.now();
    await ctx.db.insert("executorCodeInspections", { ...args, inspectedAt });
    // Keep this actor's evidence bounded, but leave rows an approval points at
    // in place (see `pruneExpiredInspections`).
    await pruneExpiredInspections(ctx, {
      now: inspectedAt,
      keepMs: INSPECTION_TTL_MS,
      limit: MAX_EVIDENCE_PRUNE,
      actorId: args.actorId,
    });
    return { ...args, inspectedAt };
  },
});
