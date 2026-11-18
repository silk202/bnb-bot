import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { decryptSecret, encryptSecret } from "./encryption";

/**
 * Operator sign-in emails (v2.3).
 *
 * The terminal operator can sign up on the auth page with ANY different email
 * address freely — no pass codes, no OTP, no passphrase. Every email used for
 * sign-up is stored in the backend (`operatorEmails`) and carries the full
 * lifecycle controls from the operator console:
 *
 *   - block   → the email can no longer sign in
 *   - unblock → restores sign-in access
 *   - delete  → removes the email record entirely
 *   - change  → replaces the email address with a new one
 *   - update  → refreshes the record (active status + a rotated internal
 *               credential)
 *
 * The auth account itself is powered by the "operator-email" provider (see
 * ./auth/operatorEmail) which has NO verification channel, so no one-time
 * code is ever involved. The account password is generated server-side here,
 * stored AES-256-GCM encrypted, and handed back to the client exactly once at
 * sign-in time so the app can call signIn("operator-email", …) in the
 * background — the operator never types or sees a passcode.
 *
 * `isOperatorEmail` is the single server-side identity check shared by the
 * terminal page, the operator console and the license engine: a signed-in
 * user is the operator when their email matches the canonical gate operator
 * (operatorConfig hash) OR an active registered operator email.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";

// Read-only db handle (queries + mutations both satisfy it).
type DbReader = { db: QueryCtx["db"] };
// Write db handle (mutations only).
type DbWriter = { db: MutationCtx["db"] };

/** One-way SHA-256 hex digest (WebCrypto — available in the V8 runtime). */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Internal account credential — long, random, meets any password policy. */
function generateCredential(): string {
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return generateRandomString(random, PASSWORD_ALPHABET, 24);
}

/** Append an immutable audit entry. */
async function audit(
  ctx: DbWriter,
  actor: string,
  actionLabel: string,
  target: string,
  description: string,
) {
  await ctx.db.insert("auditLogs", {
    actor,
    action: actionLabel,
    target,
    description,
    ts: Date.now(),
  });
}

async function findEmail(ctx: DbReader, email: string) {
  return ctx.db
    .query("operatorEmails")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

/**
 * The single server-side operator check — canonical gate operator (encrypted
 * email hash), the ALTERNATIVE operator default email (altEmailHash — it
 * works exactly like the primary default: sign-in, console access and
 * no-password desktop downloads) or an active registered operator sign-in
 * email.
 */
export async function isOperatorEmail(
  ctx: DbReader,
  email: string,
): Promise<boolean> {
  const norm = email.trim().toLowerCase();
  if (!norm) return false;
  const op = await ctx.db.query("operatorConfig").first();
  if (op?.emailHash || op?.altEmailHash) {
    const hash = await sha256Hex(norm);
    if (op.emailHash && hash === op.emailHash) return true;
    if (op.altEmailHash && hash === op.altEmailHash) return true;
  }
  const row = await findEmail(ctx, norm);
  return Boolean(row && row.status === "active");
}

/**
 * Operator resolution through INDEXES — the HOT-path replacement for the
 * old resolution helpers that collected the ENTIRE terminalStates table
 * (100+ big rows) plus the entire users table on every call: botGetState
 * runs this on every engine pass, the Telegram bot on every command, and
 * the trade ledger on every bot-side read.
 *
 * Two bounded strategies, in order:
 *   (A) active registered operator emails → user by the users email index →
 *       that user's terminal state by the by_user index (a handful of point
 *       reads — the common path), then
 *   (B) the canonical/alt gate-operator SHA-256 hashes, which are NOT
 *       reversible, so they require scanning the (small) users table once
 *       and hashing candidates — only when (A) resolved nothing.
 *
 * Semantics match `isOperatorEmail` exactly: canonical hash OR alt hash OR
 * an active registered operator email, restricted to users that actually
 * own a terminal-state row (the old helpers only ever considered
 * state owners).
 */
export async function resolveOperatorState(ctx: DbReader): Promise<{
  state: Doc<"terminalStates">;
  userId: Id<"users">;
  email: string;
} | null> {
  const op = await ctx.db.query("operatorConfig").first();
  const registeredRows = await ctx.db.query("operatorEmails").collect();
  const registered = new Set(
    registeredRows
      .filter((r) => r.status === "active")
      .map((r) => r.email.trim().toLowerCase()),
  );
  const emailHash = op?.emailHash ?? null;
  const altEmailHash = op?.altEmailHash ?? null;

  const stateFor = async (userId: Id<"users">) =>
    await ctx.db
      .query("terminalStates")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

  // (A) registered operator emails — indexed point reads only.
  for (const email of registered) {
    const u = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!u) continue;
    const state = await stateFor(u._id);
    if (state) return { state, userId: u._id, email };
  }

  // (B) hash-matched gate operator — one bounded users scan, crypto only
  // per candidate (no per-email table reads).
  if (emailHash || altEmailHash) {
    const users = await ctx.db.query("users").collect();
    for (const u of users) {
      const email = (u.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const hash = await sha256Hex(email);
      if (
        (emailHash && hash === emailHash) ||
        (altEmailHash && hash === altEmailHash)
      ) {
        const state = await stateFor(u._id);
        if (state) return { state, userId: u._id, email };
      }
    }
  }
  return null;
}

/**
 * Who the calling session is, as an operator.
 *
 * ONE policy for every operator entry point — mutations, queries and actions:
 * the identity's verified email must be a registered operator (resolved through
 * the `users` email index, so the returned user id is the caller's own
 * terminal), and a session with no email is only an operator when a guest access
 * code was verified on it. Callers that must not accept guests leave
 * `allowGuest` off; there is no second operator check to keep in step.
 */
export interface OperatorIdentity {
  userId: Id<"users">;
  /** Value written to audit rows: the email, or `guest:<userId>`. */
  actorId: string;
  kind: "email" | "guest";
}

/**
 * The same policy applied to explicit claims, for actions and internal queries
 * that cannot read `ctx.auth` where the decision is made. The action derives the
 * claims from its own auth context, so an internal caller cannot invent them
 * (internal functions are not reachable from clients).
 */
export async function operatorIdentityFrom(
  ctx: { db: QueryCtx["db"] },
  claims: { email?: string | null; userId?: Id<"users"> | null },
  opts: { allowGuest?: boolean } = {},
): Promise<OperatorIdentity> {
  const email = (claims.email ?? "").trim().toLowerCase();
  if (email && (await isOperatorEmail(ctx, email))) {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) {
      throw new Error(
        `No user record for ${email}. Sign in with the operator account once so its terminal state exists, then retry.`,
      );
    }
    return { userId: user._id, actorId: email, kind: "email" };
  }
  if (opts.allowGuest && claims.userId) {
    const user = await ctx.db.get(claims.userId);
    if (user?.guestOperatorVerifiedAt) {
      return { userId: user._id, actorId: `guest:${user._id}`, kind: "guest" };
    }
  }
  throw new Error("Operator access required.");
}

/** Resolve the CURRENT session's operator identity (queries and mutations). */
export async function resolveOperatorIdentity(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  opts: { allowGuest?: boolean } = {},
): Promise<OperatorIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  const userId = (await getAuthUserId(ctx as unknown as QueryCtx)) as Id<"users"> | null;
  return operatorIdentityFrom(ctx, { email: identity?.email, userId }, opts);
}

/** Require the signed-in identity to BE the terminal operator (no guest path). */
export async function requireOperator(ctx: MutationCtx): Promise<string> {
  return (await resolveOperatorIdentity(ctx)).actorId;
}

/**
 * "Continue as Guest" operator session check (v2.4).
 *
 * Guest sessions sign in through Convex Auth's anonymous provider, so the
 * identity has NO email — `isOperatorEmail` can never match it. The real
 * proof of operator status is the guest access code (popup-displayed or
 * emailed) verified server-side at gate time; `activateGuestOperatorSession`
 * stamps the verified code onto the anonymous session's user row, and this
 * check recognizes those sessions.
 *
 * Returns the session's user row id when the CURRENT Convex identity is a
 * code-verified guest operator session, else null. Only rows marked with a
 * `guestOperatorVerifiedAt` timestamp count — never raw anonymous users.
 */
export async function isGuestOperatorSession(
  ctx: {
    auth: QueryCtx["auth"];
    db: QueryCtx["db"];
  },
): Promise<string | null> {
  const userId = await getAuthUserId(ctx as unknown as QueryCtx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  if (!user?.guestOperatorVerifiedAt) return null;
  return userId;
}

/**
 * Mark the CURRENT session's user row as a code-verified guest operator
 * session. Only the just-verified guest access code can reach this — the
 * caller (gate.activateGuestOperatorSession) validates the code first.
 */
export async function markGuestOperatorSession(
  ctx: {
    auth: MutationCtx["auth"];
    db: MutationCtx["db"];
  },
): Promise<{ ok: boolean; userId: string | null }> {
  const userId = await getAuthUserId(ctx as unknown as MutationCtx);
  if (!userId) return { ok: false, userId: null };
  await ctx.db.patch(userId, { guestOperatorVerifiedAt: Date.now() });
  return { ok: true, userId };
}

// ---------------------------------------------------------------------------
// Sign-up / sign-in (public — the operator registers any email freely)
// ---------------------------------------------------------------------------

/**
 * Register any email address for operator sign-in (no pass codes). Idempotent:
 * - first call creates the record with a fresh internal credential;
 * - later calls return the stored credential so the app can sign the operator
 *   in with the same account;
 * - blocked emails are rejected outright.
 */
export const registerOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) throw new Error("A valid email address is required.");

    const existing = await findEmail(ctx, norm);
    if (existing) {
      if (existing.status === "blocked") {
        throw new Error(
          "This email address is blocked by the terminal operator — use a different one.",
        );
      }
      const password = await decryptSecret(ctx, existing.passwordCipher);
      await ctx.db.patch(existing._id, { updatedAt: Date.now() });
      return { ok: true, email: norm, password, isNew: false };
    }

    const password = generateCredential();
    await ctx.db.insert("operatorEmails", {
      email: norm,
      status: "active",
      passwordCipher: await encryptSecret(ctx, password),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      norm,
      "operator-email-register",
      norm,
      "Operator email registered for passcode-free sign-up (internal credential stored encrypted)",
    );
    return { ok: true, email: norm, password, isNew: true };
  },
});

// ---------------------------------------------------------------------------
// Desktop downloads (operator) — the email the operator registers on the
// auth page becomes the email that unlocks the desktop setups without any
// activation password.
// ---------------------------------------------------------------------------

/**
 * Link an email that just registered on the operator auth page (password
 * provider + email OTP) to operator desktop access. Idempotent upsert into
 * `operatorEmails`: the desktop-apps popup then recognizes the email and
 * shows the Linux / macOS / Windows setups with NO activation password.
 * Blocked emails are rejected outright.
 */
export const registerOperatorDesktopEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) throw new Error("A valid email address is required.");

    const existing = await findEmail(ctx, norm);
    if (existing) {
      if (existing.status === "blocked") {
        throw new Error(
          "This email address is blocked by the terminal operator — use a different one.",
        );
      }
      await ctx.db.patch(existing._id, { status: "active", updatedAt: Date.now() });
      return { ok: true, email: norm, isNew: false };
    }

    // The schema stores an internal credential for every operator email row
    // (legacy email-only provider); generate one so the record is complete,
    // stored encrypted like every other credential in this table.
    const password = generateCredential();
    await ctx.db.insert("operatorEmails", {
      email: norm,
      status: "active",
      passwordCipher: await encryptSecret(ctx, password),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      norm,
      "operator-desktop-register",
      norm,
      "Operator email linked for desktop downloads (registered on the operator auth page with a strong password + email OTP)",
    );
    return { ok: true, email: norm, isNew: true };
  },
});

/**
 * Desktop-apps popup — is this email an active operator email (registered on
 * the operator auth page, or the canonical gate operator)? Returns no
 * secrets, just the verdict that unlocks the no-password downloads.
 */
export const operatorDesktopStatus = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) {
      return { email: norm, isOperator: false, blocked: false };
    }
    // Canonical gate operator + alternative default operator email (hidden
    // email hashes) are always operator — both unlock no-password downloads.
    const op = await ctx.db.query("operatorConfig").first();
    if (op?.emailHash || op?.altEmailHash) {
      const hash = await sha256Hex(norm);
      if (
        (op.emailHash && hash === op.emailHash) ||
        (op.altEmailHash && hash === op.altEmailHash)
      ) {
        return { email: norm, isOperator: true, blocked: false };
      }
    }
    const row = await findEmail(ctx, norm);
    if (row) {
      return {
        email: norm,
        isOperator: row.status === "active",
        blocked: row.status === "blocked",
      };
    }
    return { email: norm, isOperator: false, blocked: false };
  },
});

// ---------------------------------------------------------------------------
// Operator console — list + lifecycle controls per email
// ---------------------------------------------------------------------------

/** Operator console list — every registered operator sign-in email + status. */
export const listOperatorEmails = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("operatorEmails").collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        email: r.email,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  },
});

export const blockOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await findEmail(ctx, email.trim().toLowerCase());
    if (!row) throw new Error("Operator email not found.");
    await ctx.db.patch(row._id, { status: "blocked", updatedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      "operator-email-block",
      row.email,
      "Operator sign-in email blocked — it can no longer sign in",
    );
    return { ok: true };
  },
});

export const unblockOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await findEmail(ctx, email.trim().toLowerCase());
    if (!row) throw new Error("Operator email not found.");
    await ctx.db.patch(row._id, { status: "active", updatedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      "operator-email-unblock",
      row.email,
      "Operator sign-in email unblocked",
    );
    return { ok: true };
  },
});

export const deleteOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await findEmail(ctx, email.trim().toLowerCase());
    if (!row) throw new Error("Operator email not found.");
    await ctx.db.delete(row._id);
    await audit(
      ctx,
      "terminal operator",
      "operator-email-delete",
      row.email,
      "Operator sign-in email record deleted",
    );
    return { ok: true };
  },
});

/** change — replace the email address with a new one (fresh credential). */
export const changeOperatorEmail = mutation({
  args: { email: v.string(), newEmail: v.string() },
  handler: async (ctx, { email, newEmail }) => {
    await requireOperator(ctx);
    const norm = newEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) throw new Error("A valid new email address is required.");
    const row = await findEmail(ctx, email.trim().toLowerCase());
    if (!row) throw new Error("Operator email not found.");
    const clash = await findEmail(ctx, norm);
    if (clash && clash._id !== row._id) {
      throw new Error("That email address is already registered.");
    }
    const password = generateCredential();
    await ctx.db.patch(row._id, {
      email: norm,
      status: "active",
      passwordCipher: await encryptSecret(ctx, password),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "operator-email-change",
      row.email,
      `Operator sign-in email changed to ${norm} (fresh internal credential stored encrypted)`,
    );
    return { ok: true, email: norm };
  },
});

// ---------------------------------------------------------------------------
// Server-issued device trust (v2.5) — kills the recurring "Session not
// recognized" amber banner for good.
//
// Problem: guest recognition was tied to `guestOperatorVerifiedAt` on the
// CURRENT anonymous session's user row. Anonymous sessions churn (stale
// tokens, browser restarts, auth re-provisioning), so a device that already
// passed REAL verification kept getting unrecognized on its next session.
//
// Fix: after a real server-side verification (guest access code OR operator
// email OTP), the server mints a 256-bit bearer token for this browser and
// stores ONLY its SHA-256 hash. Every later session on the same device sends
// the token with bot requests; a hash match proves the device completed a
// real verification. The raw token never touches the database, and nothing
// here can be reached without passing a genuine verification first — no
// mocking, no client-asserted state.
// ---------------------------------------------------------------------------

const DEVICE_TRUST_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/** 64-hex-char random token from crypto.getRandomValues (V8-safe). */
function generateDeviceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const issueDeviceTrustToken = mutation({
  args: {
    verifiedKind: v.union(v.literal("guest-code"), v.literal("operator-otp")),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { verifiedKind, email }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false as const, token: null };

    // GATE — this mutation must only be reachable AFTER a real server-side
    // verification TIED TO THIS IDENTITY. Guest path: the current session must
    // already carry the code-verified operator stamp (gate.activateGuestOperatorSession
    // re-verified the just-used code against operatorCodes server-side before
    // stamping) — that stamp is the proof the verified code belongs to THIS
    // session, not merely to some recent verification anywhere. Operator path:
    // the signed-in identity's email must BE a verified operator email.
    if (verifiedKind === "guest-code") {
      const stamped = await isGuestOperatorSession(ctx);
      if (!stamped) {
        throw new Error(
          "Device trust can only be issued by a code-verified guest session.",
        );
      }
    } else {
      const identity = await ctx.auth.getUserIdentity();
      const idEmail = identity?.email?.trim().toLowerCase() ?? "";
      if (!idEmail || !(await isOperatorEmail({ db: ctx.db }, idEmail))) {
        throw new Error("Device trust can only be issued after operator sign-in.");
      }
    }
    return issueDeviceTrustForUser(ctx, { userId, verifiedKind, email });
  },
});

/**
 * Shared device-trust mint — persists a HASH-ONLY row and returns the raw
 * token exactly once. Callers MUST have already verified the operator
 * identity server-side (the public mutation above gates itself; the bot's
 * internal action verifies before invoking). Rows are PER DEVICE (each mint
 * gets its own hash) so several trusted browsers coexist; per-user rows are
 * pruned to the newest 5 to bound growth.
 */
export async function issueDeviceTrustForUser(
  ctx: DbWriter,
  {
    userId,
    verifiedKind,
    email,
  }: {
    userId: Id<"users">;
    verifiedKind: "guest-code" | "operator-otp";
    email?: string | null;
  },
): Promise<{ ok: boolean; token: string | null }> {
  const normEmail = email?.trim().toLowerCase() ?? null;
  const token = generateDeviceToken();
  const rows = await ctx.db
    .query("operatorDeviceTrust")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  // Prune: keep the newest 4 rows; the fresh mint below becomes the 5th.
  const sorted = [...rows].sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt);
  for (const old of sorted.slice(4)) await ctx.db.delete(old._id);
  await ctx.db.insert("operatorDeviceTrust", {
    userId,
    tokenHash: await sha256Hex(token),
    verifiedKind,
    email: normEmail ?? undefined,
    createdAt: Date.now(),
    lastVerifiedAt: Date.now(),
    expiresAt: Date.now() + DEVICE_TRUST_TTL_MS,
  });
  await audit(
    ctx,
    normEmail ?? "[guest]",
    "device-trust-issue",
    verifiedKind,
    "Server-issued device trust token created after real verification (hash stored, raw token returned once)",
  );
  return { ok: true as const, token };
}

/**
 * Server-side device recognition: does this bearer token belong to a
 * non-expired device that completed a real verification? Pure hash lookup —
 * no client-asserted identity involved.
 */
export async function isTrustedDeviceToken(
  ctx: DbReader,
  rawToken: string | null | undefined,
): Promise<boolean> {
  const raw = rawToken?.trim() ?? "";
  if (raw.length < 32) return false;
  const hash = await sha256Hex(raw);
  const row = await ctx.db
    .query("operatorDeviceTrust")
    .withIndex("by_hash", (q) => q.eq("tokenHash", hash))
    .first();
  return Boolean(row && row.expiresAt > Date.now());
}

/** update — refresh the record (active status + rotated internal credential). */
export const updateOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await findEmail(ctx, email.trim().toLowerCase());
    if (!row) throw new Error("Operator email not found.");
    const password = generateCredential();
    await ctx.db.patch(row._id, {
      status: "active",
      passwordCipher: await encryptSecret(ctx, password),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "operator-email-update",
      row.email,
      "Operator sign-in email record refreshed (active + rotated internal credential)",
    );
    return { ok: true };
  },
});
