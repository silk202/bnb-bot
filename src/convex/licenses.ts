import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { v } from "convex/values";
import {
  httpAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { decryptSecret, encryptSecret } from "./encryption";
import { isOperatorEmail } from "./operatorEmails";
import { scheduleOperatorMail } from "./operatorDefaults";
import { enforceRateLimit } from "./rateLimit";
import { scheduleWhatsAppMirror } from "./whatsapp";

/**
 * Desktop app activation licenses (v2.3) — one encrypted activation password
 * per (subscriber email, operating system), generated server-side and emailed
 * ONLY to the terminal operator's default email address. The same email used
 * for subscribing on the first page (stored in the backend) is the ONLY email
 * the backend recognizes here — licenses can never be issued to an arbitrary
 * address. The plaintext is never returned by any query; it is only ever
 * decrypted server-side at the exact moment it is needed:
 *
 * - "send"    → emails the current password to the operator.
 * - "update"  → generates a brand-new encrypted password and emails it to the
 *               operator instantly.
 * - "change"  → emails a one-time code; after the operator verifies it the
 *               password is revealed for a short 10-second window. If the
 *               operator edits it inside the window, the edited password is
 *               re-encrypted and the changed password is emailed to the
 *               operator automatically. If nothing is changed, the window
 *               just lapses (no email).
 * - "block" / "unblock" / "delete" → lifecycle control per (email, OS).
 *
 * Expiry rule: any new password (generated / changed / updated) that is NOT
 * used to activate the desktop app within 72 hours is automatically tagged
 * "expired" by a daily cron. The moment a password is used even once to
 * activate the app within the window, it becomes permanently active for
 * re-use / re-run of the app.
 *
 * Activation is intentionally public (email + password gated): the desktop
 * CLI and the public download page both activate against the same server-side
 * check — a browser mutation for the web form and an HTTP action for the CLI.
 *
 * All lifecycle events email the operator and land in the immutable audit
 * log. Nothing here is simulated — every outcome is the real server verdict.
 */

export const OS_LIST = ["linux", "macos", "windows"] as const;
export type OsKey = (typeof OS_LIST)[number];

const OS_LABEL: Record<OsKey, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

const LIC_EXPIRY_HOURS = 72; // any unused new password expires after 72h
const HOUR_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000; // one-time change code validity
const REVEAL_WINDOW_MS = 10_000; // 10-second visible/editable window
const REVEAL_GRACE_MS = 5_000; // network-latency grace for applyLicenseChange

/** Constant-time string comparison (no length side channel beyond length). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Unique activation password: FB-XXXX-XXXX-XXXX (no confusing chars). */
function generateActivationPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return `FB-${generateRandomString(random, alphabet, 4)}-${generateRandomString(random, alphabet, 4)}-${generateRandomString(random, alphabet, 4)}`;
}

/** Unique 6-digit one-time code emailed to the operator for "change". */
function generateChangeCode(): string {
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return generateRandomString(random, "0123456789", 6);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function freshExpiryAt(): number {
  return Date.now() + LIC_EXPIRY_HOURS * HOUR_MS;
}

/** Read-only db handle — satisfies both query and mutation contexts. */
type DbReader = { db: QueryCtx["db"] };

/** Write db handle (mutations only). */
type DbWriter = { db: MutationCtx["db"] };

/** Structural context shared by mutations, internal mutations and the HTTP
 *  action — everything the license engine touches is just db + scheduler. */
type LicenseDbCtx = {
  db: MutationCtx["db"];
  scheduler: MutationCtx["scheduler"];
};

/** Scheduler handle (mail queueing). */
type MailCtx = { scheduler: MutationCtx["scheduler"] };

/** Decrypt the stored operator email (encrypted rows, then legacy plaintext). */
async function getOperatorEmail(
  ctx: DbReader,
  op: { email?: string; emailCipher?: string },
): Promise<string> {
  if (op.emailCipher) return decryptSecret(ctx, op.emailCipher);
  if (op.email) return op.email;
  throw new Error("Operator email is not configured.");
}

/**
 * Require the signed-in identity to BE the terminal operator (canonical gate
 * operator or any active registered operator email — verified server-side).
 * Returns the canonical operator email (the destination for all license
 * emails) so sends always reach the operator's default address.
 */
async function requireOperator(ctx: MutationCtx): Promise<string> {
  const op = await ctx.db.query("operatorConfig").first();
  if (!op?.emailHash) throw new Error("Operator profile is not seeded.");
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email?.trim().toLowerCase();
  if (!email || !(await isOperatorEmail(ctx, email))) {
    throw new Error("Operator access required.");
  }
  return getOperatorEmail(ctx, op);
}

/**
 * Only backend-recognized subscriber emails can hold desktop licenses — the
 * same email used for subscribing on the first page. Returns the normalized
 * email or throws.
 */
async function requireSubscriberEmail(
  ctx: DbReader,
  email: string,
): Promise<string> {
  const norm = email.trim().toLowerCase();
  const sub = await ctx.db
    .query("subscribers")
    .withIndex("by_email", (q) => q.eq("email", norm))
    .first();
  if (!sub) {
    throw new Error(
      "This email is not a registered subscriber — only subscriber emails can receive desktop activation passwords.",
    );
  }
  if (sub.status === "blocked") {
    throw new Error("This subscriber email is blocked by the terminal operator.");
  }
  return norm;
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

/**
 * Schedule a real email to EVERY terminal operator default inbox at once
 * (primary + alternative — relay / Resend / Brevo per recipient). The `to`
 * argument is accepted for call-site compatibility but ignored: every
 * operator default address receives the identical message simultaneously,
 * so a broken primary inbox can never silence an activation password.
 */
function queueOperatorMail(
  ctx: LicenseDbCtx,
  _to: string,
  subject: string,
  html: string,
  code?: string,
) {
  return scheduleOperatorMail(ctx, { subject, html, code, redactRecipient: true });
}

/** The license row for one (subscriber email, OS). */
function licenseRow(ctx: DbReader, email: string, os: string) {
  return ctx.db
    .query("activationLicenses")
    .withIndex("by_email_os", (q) => q.eq("email", email).eq("os", os as OsKey))
    .first();
}

/** Validate + normalize the OS key. */
function parseOs(os: string): OsKey {
  const key = os.trim().toLowerCase();
  if (!OS_LIST.includes(key as OsKey)) {
    throw new Error("Unsupported operating system — use linux, macos or windows.");
  }
  return key as OsKey;
}

// ---------------------------------------------------------------------------
// Seeding + listing
// ---------------------------------------------------------------------------

/**
 * Operator-gated seed — creates the per-OS license rows for a subscriber
 * email if missing and emails each freshly generated password to the operator
 * (passwords are encrypted in storage and never shown in any UI). Called by
 * the console when the operator picks a subscriber email.
 */
export const ensureLicenses = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const opEmail = await requireOperator(ctx);
    const norm = await requireSubscriberEmail(ctx, email);
    const created: string[] = [];
    for (const os of OS_LIST) {
      const existing = await licenseRow(ctx, norm, os);
      if (existing) continue;
      const password = generateActivationPassword();
      const now = Date.now();
      await ctx.db.insert("activationLicenses", {
        email: norm,
        os,
        passwordCipher: await encryptSecret(ctx, password),
        status: "active",
        activationCount: 0,
        rotatedAt: now,
        expiresAt: freshExpiryAt(),
        createdAt: now,
        updatedAt: now,
      });
      await queueOperatorMail(
        ctx,
        opEmail,
        `${OS_LABEL[os]} desktop activation password — ${norm}`,
        `<p>A new <b>${OS_LABEL[os]}</b> desktop activation password was generated for subscriber <b>${escapeHtml(norm)}</b>:</p><h2 style="letter-spacing:2px">${password}</h2><p>It expires in <b>72 hours</b> if the desktop app is never activated with it. Once the app is activated even once, the password stays active for re-use / re-run. The password is stored encrypted in the backend and is never shown in any interface.</p>`,
        password,
      );
      await scheduleWhatsAppMirror(
        ctx,
        `${OS_LABEL[os]} activation password generated — ${norm}`,
        `Subscriber: ${norm}\nOS: ${OS_LABEL[os]}\nActivation password: ${password}\nExpires in 72h if the desktop app is never activated with it.`,
      );
      created.push(os);
      await audit(
        ctx,
        "terminal operator",
        `license-seed-${os}`,
        norm,
        `${OS_LABEL[os]} activation password generated (encrypted) and emailed to the operator for subscriber ${norm}`,
      );
    }
    return { ok: true, email: norm, created };
  },
});

/**
 * Operator console list — masked rows only (email + OS). Passwords are
 * encrypted server-side and never returned: the plaintext can only be
 * revealed inside the 10-second change window after a one-time emailed code
 * is verified.
 */
export const listLicenses = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("activationLicenses").collect();
    return rows
      .sort((a, b) => a.email.localeCompare(b.email) || a.os.localeCompare(b.os))
      .map((r) => ({
        email: r.email,
        os: r.os,
        status: r.status,
        activationCount: r.activationCount,
        lastActivatedAt: r.lastActivatedAt ?? undefined,
        rotatedAt: r.rotatedAt,
        expiresAt: r.expiresAt,
        updatedAt: r.updatedAt,
        maskedPassword: "••••••••-••••-••••",
        changePending: Boolean(r.changeCodeCipher),
        changeRevealActive:
          typeof r.changeRevealExpiresAt === "number" &&
          r.changeRevealExpiresAt > Date.now(),
      }));
  },
});

/** Public status for the download page — no secrets, just the OS state. */
export const licenseStatus = query({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) return { exists: false, status: "none" as const };
    return { exists: true, status: row.status };
  },
});

// ---------------------------------------------------------------------------
// Lifecycle: send / update / block / unblock / delete
// ---------------------------------------------------------------------------

/** "send" — email the current password to the operator. */
export const sendLicensePassword = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    const opEmail = await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    if (row.status === "blocked") {
      throw new Error("Blocked licenses cannot be sent — unblock first.");
    }
    if (row.status === "expired") {
      throw new Error("This password has expired — use Update to generate a new one.");
    }
    const password = await decryptSecret(ctx, row.passwordCipher);
    await queueOperatorMail(
      ctx,
      opEmail,
      `${OS_LABEL[key]} desktop activation password (send) — ${norm}`,
      `<p>Your current <b>${OS_LABEL[key]}</b> desktop activation password for subscriber <b>${escapeHtml(norm)}</b>:</p><h2 style="letter-spacing:2px">${password}</h2><p>It expires in 72 hours if never used to activate the app; after the first activation it stays active for re-use / re-run.</p>`,
      password,
    );
    await scheduleWhatsAppMirror(
      ctx,
      `${OS_LABEL[key]} activation password — ${norm}`,
      `Subscriber: ${norm}\nOS: ${OS_LABEL[key]}\nActivation password: ${password}\nExpires in 72h if never activated; after first activation it stays active.`,
    );
    await audit(
      ctx,
      "terminal operator",
      `license-send-${key}`,
      norm,
      `${OS_LABEL[key]} activation password dispatched to the operator email (send trigger) for subscriber ${norm}`,
    );
    return { ok: true, channel: "queued", emailDelivered: true };
  },
});

/** "update" — generate a brand-new encrypted password and email it instantly. */
export const updateLicensePassword = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    const opEmail = await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    if (row.status === "blocked") {
      throw new Error("Blocked licenses cannot be updated — unblock first.");
    }
    const password = generateActivationPassword();
    const now = Date.now();
    await ctx.db.patch(row._id, {
      passwordCipher: await encryptSecret(ctx, password),
      status: "active",
      activationCount: 0,
      lastActivatedAt: undefined,
      rotatedAt: now,
      expiresAt: freshExpiryAt(),
      updatedAt: now,
      changeCodeCipher: undefined,
      changeCodeExpiresAt: undefined,
      changeVerifiedAt: undefined,
      changeRevealExpiresAt: undefined,
    });
    await queueOperatorMail(
      ctx,
      opEmail,
      `${OS_LABEL[key]} desktop activation password (updated) — ${norm}`,
      `<p>Your <b>${OS_LABEL[key]}</b> desktop activation password for subscriber <b>${escapeHtml(norm)}</b> was updated. The new password is:</p><h2 style="letter-spacing:2px">${password}</h2><p>It expires in <b>72 hours</b> if the app is never activated with it; after the first activation it stays active for re-use / re-run.</p>`,
      password,
    );
    await scheduleWhatsAppMirror(
      ctx,
      `${OS_LABEL[key]} activation password updated — ${norm}`,
      `Subscriber: ${norm}\nOS: ${OS_LABEL[key]}\nNew activation password: ${password}\nExpires in 72h if never activated; after first activation it stays active.`,
    );
    await audit(
      ctx,
      "terminal operator",
      `license-update-${key}`,
      norm,
      `${OS_LABEL[key]} activation password updated (new password generated, encrypted, emailed to the operator) for subscriber ${norm}`,
    );
    return { ok: true, channel: "queued", emailDelivered: true };
  },
});

export const blockLicense = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    await ctx.db.patch(row._id, { status: "blocked", updatedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      `license-block-${key}`,
      norm,
      `${OS_LABEL[key]} activation license blocked for subscriber ${norm} — the desktop app can no longer activate`,
    );
    return { ok: true };
  },
});

export const unblockLicense = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    await ctx.db.patch(row._id, {
      status: "active",
      expiresAt: freshExpiryAt(),
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      `license-unblock-${key}`,
      norm,
      `${OS_LABEL[key]} activation license unblocked for subscriber ${norm} (fresh 72-hour window)`,
    );
    return { ok: true };
  },
});

export const deleteLicense = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    await ctx.db.delete(row._id);
    await audit(
      ctx,
      "terminal operator",
      `license-delete-${key}`,
      norm,
      `${OS_LABEL[key]} activation license deleted for subscriber ${norm} — a fresh one will be generated on next use`,
    );
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// "change" — one-time code → 10-second visible/editable window
// ---------------------------------------------------------------------------

/**
 * Step 1 — email a one-time code to the operator so the encrypted activation
 * password can be revealed and changed for a short period (10 seconds).
 */
export const requestLicenseChangeCode = mutation({
  args: { email: v.string(), os: v.string() },
  handler: async (ctx, { email, os }) => {
    const key = parseOs(os);
    const opEmail = await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    if (row.status === "blocked") {
      throw new Error("Blocked licenses cannot be changed — unblock first.");
    }
    const code = generateChangeCode();
    await ctx.db.patch(row._id, {
      changeCodeCipher: await encryptSecret(ctx, code),
      changeCodeExpiresAt: Date.now() + CODE_TTL_MS,
      changeVerifiedAt: undefined,
      changeRevealExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    await queueOperatorMail(
      ctx,
      opEmail,
      `One-time code — change ${OS_LABEL[key]} activation password (${norm})`,
      `<p>You requested to change the <b>${OS_LABEL[key]}</b> desktop activation password for subscriber <b>${escapeHtml(norm)}</b>.</p><p>Your one-time code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>Enter it in the operator console to reveal the password for <b>10 seconds</b>. If you edit it inside that window, the changed password is re-encrypted and emailed back to you automatically; if nothing is changed, no email is sent.</p>`,
      code,
    );
    await audit(
      ctx,
      "terminal operator",
      `license-change-code-${key}`,
      norm,
      `One-time code dispatched to the operator for the ${OS_LABEL[key]} activation password change (subscriber ${norm})`,
    );
    return { ok: true, expiresInMinutes: 15, channel: "queued", emailDelivered: true };
  },
});

/**
 * Step 2 — verify the emailed code. On success the password is revealed
 * (decrypted server-side) for exactly 10 seconds; edits are applied by
 * applyLicenseChange within that window.
 */
export const verifyLicenseChangeCode = mutation({
  args: { email: v.string(), os: v.string(), code: v.string() },
  handler: async (ctx, { email, os, code }) => {
    const key = parseOs(os);
    await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    if (!row.changeCodeCipher || !row.changeCodeExpiresAt) {
      throw new Error("No change code has been requested for this operating system.");
    }
    if (row.changeCodeExpiresAt < Date.now()) {
      throw new Error("This code has expired — request a new one.");
    }
    const stored = await decryptSecret(ctx, row.changeCodeCipher);
    if (!ctEqual(stored, code.trim())) {
      throw new Error("Invalid code.");
    }
    const revealExpiresAt = Date.now() + REVEAL_WINDOW_MS;
    const password = await decryptSecret(ctx, row.passwordCipher);
    await ctx.db.patch(row._id, {
      changeCodeCipher: undefined,
      changeCodeExpiresAt: undefined,
      changeVerifiedAt: Date.now(),
      changeRevealExpiresAt: revealExpiresAt,
      updatedAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      `license-change-verify-${key}`,
      norm,
      `Operator verified the one-time code — ${OS_LABEL[key]} activation password visible for 10 seconds (subscriber ${norm})`,
    );
    return { ok: true, password, changeRevealExpiresAt: revealExpiresAt };
  },
});

/**
 * Step 3 — apply an edit inside the 10-second window. If a different password
 * was provided, it is re-encrypted and the changed password is emailed to the
 * operator automatically. If nothing changed, the window simply lapses and no
 * email is sent (per spec: "unless nothing is changed").
 */
export const applyLicenseChange = mutation({
  args: { email: v.string(), os: v.string(), newPassword: v.optional(v.string()) },
  handler: async (ctx, { email, os, newPassword }) => {
    const key = parseOs(os);
    const opEmail = await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await licenseRow(ctx, norm, key);
    if (!row) {
      throw new Error("No license exists for this email + operating system yet.");
    }
    const revealExpiresAt = row.changeRevealExpiresAt ?? 0;
    if (revealExpiresAt < Date.now() - REVEAL_GRACE_MS) {
      throw new Error("The 10-second change window has elapsed — request a new one-time code.");
    }
    const current = await decryptSecret(ctx, row.passwordCipher);
    const draft = newPassword?.trim().toUpperCase() ?? "";
    const changed =
      draft.length > 0 && !ctEqual(draft, current.trim().toUpperCase());
    const now = Date.now();
    if (changed) {
      if (!/^[A-Z0-9-]{8,24}$/.test(draft)) {
        throw new Error("Password must be 8–24 characters (letters, numbers, dashes).");
      }
      await ctx.db.patch(row._id, {
        passwordCipher: await encryptSecret(ctx, draft),
        status: "active",
        activationCount: 0,
        lastActivatedAt: undefined,
        rotatedAt: now,
        expiresAt: freshExpiryAt(),
        updatedAt: now,
        changeVerifiedAt: undefined,
        changeRevealExpiresAt: undefined,
      });
      await queueOperatorMail(
        ctx,
        opEmail,
        `${OS_LABEL[key]} activation password changed — ${norm}`,
        `<p>The <b>${OS_LABEL[key]}</b> desktop activation password for subscriber <b>${escapeHtml(norm)}</b> was changed inside the 10-second window. The changed password is:</p><h2 style="letter-spacing:2px">${draft}</h2><p>It is stored encrypted and expires in <b>72 hours</b> if never used to activate the app; after the first activation it stays active for re-use / re-run.</p>`,
        draft,
      );
      await scheduleWhatsAppMirror(
        ctx,
        `${OS_LABEL[key]} activation password changed — ${norm}`,
        `Subscriber: ${norm}\nOS: ${OS_LABEL[key]}\nChanged activation password: ${draft}\nStored encrypted; expires in 72h if never activated.`,
      );
      await audit(
        ctx,
        "terminal operator",
        `license-change-apply-${key}`,
        norm,
        `${OS_LABEL[key]} activation password changed inside the 10-second window (re-encrypted and emailed to the operator) for subscriber ${norm}`,
      );
      return { ok: true, changed: true, emailDelivered: true };
    }
    await ctx.db.patch(row._id, {
      changeVerifiedAt: undefined,
      changeRevealExpiresAt: undefined,
      updatedAt: now,
    });
    await audit(
      ctx,
      "terminal operator",
      `license-change-lapsed-${key}`,
      norm,
      `${OS_LABEL[key]} change window elapsed with no edit — password unchanged, no email sent (subscriber ${norm})`,
    );
    return { ok: true, changed: false, emailDelivered: false };
  },
});

// ---------------------------------------------------------------------------
// Activation (public, email + password gated) — shared by the web form + CLI
// ---------------------------------------------------------------------------

interface ActivationState {
  ok: boolean;
  status: "none" | "blocked" | "expired" | "invalid" | "activated";
  message: string;
  activationCount?: number;
}

/**
 * The single activation verdict. Checks, in order: license exists for the
 * (email, OS) → not blocked → not expired (only pre-first-activation) →
 * password matches. A match activates the app and (for re-runs) keeps it
 * active forever. The operator is emailed on the FIRST activation only; every
 * attempt (success or failure) lands in the audit log. On success the app
 * URL is returned so the desktop app opens the same browser flow (landing →
 * auth → terminal).
 */
async function attemptActivation(
  ctx: LicenseDbCtx,
  email: string,
  os: string,
  password: string,
): Promise<ActivationState> {
  const key = parseOs(os);
  const norm = email.trim().toLowerCase();
  const row = await licenseRow(ctx, norm, key);
  if (!row) {
    return {
      ok: false,
      status: "none",
      message: "No activation license has been issued for this email + operating system.",
    };
  }
  if (row.status === "blocked") {
    await audit(
      ctx,
      norm,
      `activation-blocked-${key}`,
      norm,
      "Activation attempt rejected — license blocked by the operator",
    );
    return {
      ok: false,
      status: "blocked",
      message: "This activation password has been blocked by the operator.",
    };
  }
  if (row.activationCount === 0 && row.expiresAt < Date.now()) {
    await audit(
      ctx,
      norm,
      `activation-expired-${key}`,
      norm,
      "Activation attempt rejected — password never used within 72 hours and has expired",
    );
    return {
      ok: false,
      status: "expired",
      message: "This password expired (never used to activate within 72 hours). Ask the operator to update it.",
    };
  }
  const stored = await decryptSecret(ctx, row.passwordCipher);
  if (!ctEqual(stored.trim(), password.trim())) {
    await audit(
      ctx,
      norm,
      `activation-invalid-${key}`,
      norm,
      "Activation attempt rejected — wrong password",
    );
    return {
      ok: false,
      status: "invalid",
      message: "Invalid activation password.",
    };
  }
  const firstActivation = row.activationCount === 0;
  await ctx.db.patch(row._id, {
    status: "active",
    activationCount: row.activationCount + 1,
    lastActivatedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await audit(
    ctx,
    norm,
    `activation-success-${key}`,
    norm,
    firstActivation
      ? `${OS_LABEL[key]} desktop app activated for the first time (subscriber ${norm}) — password now active for re-use / re-run`
      : `${OS_LABEL[key]} desktop app re-run activated (password reuse) for subscriber ${norm}`,
  );
  if (firstActivation) {
    try {
      await scheduleOperatorMail(ctx, {
        subject: `${OS_LABEL[key]} desktop app activated — ${norm}`,
        html: `<p>The <b>${OS_LABEL[key]}</b> desktop app was <b>activated for the first time</b> by subscriber <b>${escapeHtml(norm)}</b>.</p><p>The activation password is now permanently active for re-use / re-run of the app.</p>`,
      });
      await scheduleWhatsAppMirror(
        ctx,
        `${OS_LABEL[key]} desktop app activated — ${norm}`,
        `Subscriber: ${norm}\nOS: ${OS_LABEL[key]}\nFirst activation — the activation password is now permanently active for re-use / re-run.`,
      );
    } catch {
      // The activation already succeeded — a failed operator email must not
      // turn a successful activation into a failure.
    }
  }
  return {
    ok: true,
    status: "activated",
    message: "Activation successful — the desktop app is now licensed to run.",
    activationCount: row.activationCount + 1,
  };
}

/** Web-form activation (public download page + landing subscriber window). */
export const activateLicense = mutation({
  args: { email: v.string(), os: v.string(), password: v.string() },
  handler: async (ctx, { email, os, password }) => {
    if (!email.trim()) throw new Error("Enter the email address you subscribed with.");
    if (!password.trim()) throw new Error("Enter the activation password you received by email.");
    await enforceRateLimit(ctx, {
      bucket: `activate:${email.trim().toLowerCase()}`,
      limit: 10,
      windowMs: 60_000,
      message: "Too many activation attempts for this email — try again in a minute.",
    });
    return attemptActivation(ctx, email, os, password);
  },
});

/**
 * CLI activation over HTTP — POST { email, os, password } to /activate.
 * Returns JSON with the exact same server-side verdict as the web form so the
 * desktop installer can call it from the command line (PowerShell on
 * Windows).
 */
export const activateLicenseHttp = httpAction(async (ctx, request) => {
  let email = "";
  let os = "";
  let password = "";
  try {
    const body = (await request.json()) as {
      email?: string;
      os?: string;
      password?: string;
    };
    email = String(body.email ?? "").trim();
    os = String(body.os ?? "").trim();
    password = String(body.password ?? "").trim();
  } catch {
    return Response.json(
      { ok: false, status: "bad_request", message: "Invalid JSON body — expected { email, os, password }." },
      { status: 400, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }
  if (!email || !os || !password) {
    return Response.json(
      { ok: false, status: "bad_request", message: "email, os and password are required." },
      { status: 400, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }
  try {
    // Actions have no direct database handle — the web-form mutation carries
    // the single, shared server-side activation verdict.
    const verdict = await ctx.runMutation(api.licenses.activateLicense, {
      email,
      os,
      password,
    });
    return Response.json(
      verdict,
      {
        status: verdict.ok ? 200 : 401,
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        status: "error",
        message: error instanceof Error ? error.message : "Activation failed.",
      },
      { status: 400, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }
});

// ---------------------------------------------------------------------------
// 72-hour expiry enforcement (daily cron)
// ---------------------------------------------------------------------------

/**
 * Mark every password that was never used to activate its desktop app within
 * 72 hours as "expired", notify the operator by email, and record each
 * expiration in the audit log. Once a password has activated the app it never
 * expires (it is active for re-use / re-run).
 */
export const expireStaleLicenses = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("activationLicenses").collect();
    const now = Date.now();
    const expired: { email: string; os: OsKey; label: string }[] = [];
    for (const row of rows) {
      if (row.activationCount === 0 && row.status !== "blocked" && row.expiresAt < now) {
        await ctx.db.patch(row._id, {
          status: "expired",
          updatedAt: now,
        });
        await audit(
          ctx,
          "system",
          `license-auto-expire-${row.os}`,
          row.email,
          `${OS_LABEL[row.os as OsKey]} activation password expired automatically — never used within 72 hours (subscriber ${row.email})`,
        );
        expired.push({ email: row.email, os: row.os as OsKey, label: OS_LABEL[row.os as OsKey] });
      }
    }
    if (expired.length > 0) {
      try {
        await scheduleOperatorMail(ctx, {
          subject: "Desktop activation passwords expired",
          html: `<p>The following desktop activation passwords were never used to activate the app within 72 hours and have <b>expired</b>:</p><ul>${expired.map((e) => `<li><b>${e.label}</b> — ${escapeHtml(e.email)}</li>`).join("")}</ul><p>Use <b>Update</b> in the operator console to generate a fresh password for each subscriber + operating system.</p>`,
        });
        await scheduleWhatsAppMirror(
          ctx,
          "Desktop activation passwords expired",
          expired
            .map((e) => `${e.label} — ${e.email}`)
            .join("\n"),
        );
      } catch {
        // The expiry already happened — a failed operator email must not
        // fail the cron.
      }
    }
    return { expired: expired.length };
  },
});
