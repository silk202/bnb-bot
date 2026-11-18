import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { v } from "convex/values";
import { action, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret, encryptSecret } from "./encryption";
import { generateNumericCode } from "./auth/otpMail";
import {
  isOperatorEmail,
  markGuestOperatorSession,
  requireOperator,
} from "./operatorEmails";
import {
  DEFAULT_ALT_OPERATOR_EMAIL,
  DEFAULT_OPERATOR_EMAIL,
  scheduleOperatorMail,
  type DeliveryPref,
} from "./operatorDefaults";
import { enforceRateLimit } from "./rateLimit";
import { scheduleWhatsAppMirror } from "./whatsapp";

/** UTC-day key (YYYY-MM-DD) — same format the execution-target counter uses. */
function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Gate (v2.1) — terminal operator + subscriber access management.
 *
 * Real end-to-end behavior, nothing simulated:
 * - Operator default credentials live only in the backend. The passphrase is
 *   AES-256-GCM encrypted and the operator email is encrypted too (with a
 *   one-way SHA-256 hash for server-side identity checks) — the email is
 *   hidden from everyone. Reveal ("visible") is gated by a one-time code
 *   emailed to the stored operator address and stays visible for only a
 *   short window; "change" unlocks a short editable window and "update"
 *   makes the change effective.
 * - Subscriber passcodes are generated server-side, stored AES-256-GCM
 *   encrypted, and NEVER emailed to the subscriber at request time — only to
 *   the operator. The passcode is delivered to the subscriber only when the
 *   operator clicks the "send" trigger after confirming payment (for "Send a
 *   passcode" submissions) or at their discretion (for "Request a passcode").
 *   A passcode that has not expired can be sent; an expired one must be
 *   rotated first. An email cannot generate a second passcode while its
 *   current one is unexpired, and once a passcode is used to open the landing
 *   page (activated) that email can never generate another one.
 * - Subject lines: "Request a passcode" (passcode generated, stored
 *   encrypted, operator notified), "Send a passcode" (requires a registered
 *   email + payment-receipt file; only the file is stored for
 *   confirm/reject/delete; the passcode is sent after confirmation),
 *   "Other issues" (information forwarded to the operator only, nothing
 *   stored, both registered and unregistered emails welcome).
 * - Every action is written to the immutable audit log; the operator email
 *   never appears in any query response or audit entry.
 */

const DEFAULT_EXPIRY_HOURS = 72; // default subscriber passcode window
const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 24 * 30; // 30 days
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Subscription plan durations in milliseconds. */
const SUBSCRIPTION_PLAN_MS: Record<string, number> = {
  free: 0,
  "1month": 30 * DAY_MS,
  "2month": 60 * DAY_MS,
  "3month": 90 * DAY_MS,
  "4month": 120 * DAY_MS,
  "5month": 150 * DAY_MS,
  "6month": 180 * DAY_MS,
  "9month": 270 * DAY_MS,
  "1year": 365 * DAY_MS,
};
const OPERATOR_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
/** How long after code verification the session-activation stamp stays usable. */
const GUEST_STAMP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const REVEAL_WINDOW_MS = 60 * 1000; // "visible but unchangeable" window
const CHANGE_WINDOW_MS = 5 * 60 * 1000; // editable window after a verified change code
const DEFAULT_OPERATOR_PASSPHRASE = "Overcast-Relation-Luncheon-Tannery-Engine";
const DEFAULT_GUEST_PASSPHRASE = "Sakeem-Haksak-Consultancy-Services";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECEIPT_RE = /^data:(image\/(png|jpe?g)|application\/pdf);base64,/;

/** Constant-time string comparison (no length side channel beyond length). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

/** Unique random subscriber passcode: FB-XXXX-XXXX (no confusing chars). */
function generatePasscode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return `FB-${generateRandomString(random, alphabet, 4)}-${generateRandomString(random, alphabet, 4)}`;
}

/** Unique random subscriber permit code: FP-XXXX-XXXX (no confusing chars). */
function generatePermitCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return `FP-${generateRandomString(random, alphabet, 4)}-${generateRandomString(random, alphabet, 4)}`;
}

/** Default daily flash loan trade limit per subscriber. */
const DEFAULT_DAILY_TRADE_LIMIT = 3;

/** Today's date string in YYYY-MM-DD format (UTC). */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolve the per-subscriber expiry window in hours (falls back to 72). */
function expiryHoursOf(row: { expiryHours?: number }): number {
  const h = row.expiryHours;
  if (typeof h === "number" && Number.isFinite(h) && h >= MIN_EXPIRY_HOURS && h <= MAX_EXPIRY_HOURS) {
    return Math.floor(h);
  }
  return DEFAULT_EXPIRY_HOURS;
}

/** Fresh expiry timestamp for a subscriber's configured window. */
function freshExpiryAt(row: { expiryHours?: number }): number {
  return Date.now() + expiryHoursOf(row) * HOUR_MS;
}

/** Append an immutable audit entry. */
async function audit(
  ctx: MutationCtx,
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

// ---------------------------------------------------------------------------
// Operator profile
// ---------------------------------------------------------------------------

/** Decrypt the stored operator email (encrypted rows, then legacy plaintext). */
async function getOperatorEmail(
  ctx: MutationCtx,
  op: { email?: string; emailCipher?: string },
): Promise<string> {
  if (op.emailCipher) return decryptSecret(ctx, op.emailCipher);
  if (op.email) return op.email;
  return DEFAULT_OPERATOR_EMAIL;
}

/**
 * Idempotent seed of the operator profile. Both the default email and
 * passphrase are stored encrypted (AES-256-GCM); the email is additionally
 * hashed (one-way) so the signed-in user can be verified without exposing it.
 */
export const seedOperator = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("operatorConfig").first();
    if (existing) {
      // Self-heal: keep the backend operator identity in sync with the
      // canonical default (spec-issued shcstechy@gmail.com) and make sure the
      // email hash exists so isOperatorUser can verify the signed-in user.
      let needsSync = false;
      let current = "";
      if (existing.emailCipher) {
        current = await decryptSecret(ctx, existing.emailCipher).catch(() => "");
      } else if (existing.email) {
        current = existing.email;
      }
      if (current && current.toLowerCase() !== DEFAULT_OPERATOR_EMAIL.toLowerCase()) {
        needsSync = true;
      }
      if (!existing.emailHash) {
        needsSync = true;
      }
      if (needsSync) {
        await ctx.db.patch(existing._id, {
          email: "",
          emailCipher: await encryptSecret(ctx, DEFAULT_OPERATOR_EMAIL),
          emailHash: await sha256Hex(DEFAULT_OPERATOR_EMAIL.toLowerCase()),
        });
        await audit(
          ctx,
          "system",
          "operator-email-sync",
          "[operator]",
          "Operator email encrypted and synchronized to the canonical default",
        );
      }
      // Self-heal: persist the ALTERNATIVE default operator inbox (encrypted
      // + identity hash) when this row predates it OR the stored default
      // address changed — the new address must keep working as an operator
      // identity (sign-in, console, no-password downloads) everywhere.
      let altStored = "";
      if (existing.altEmailCipher) {
        altStored = await decryptSecret(ctx, existing.altEmailCipher).catch(() => "");
      } else if (existing.altEmail) {
        altStored = existing.altEmail;
      }
      if (
        !altStored ||
        altStored.trim().toLowerCase() !== DEFAULT_ALT_OPERATOR_EMAIL.toLowerCase()
      ) {
        await ctx.db.patch(existing._id, {
          altEmail: "",
          altEmailCipher: await encryptSecret(ctx, DEFAULT_ALT_OPERATOR_EMAIL),
          altEmailHash: await sha256Hex(DEFAULT_ALT_OPERATOR_EMAIL.toLowerCase()),
        });
        await audit(
          ctx,
          "system",
          "operator-alt-email-seed",
          "[operator]",
          "Alternative operator default email encrypted and stored in the backend (receives operator notifications like the primary)",
        );
      }
      // Self-heal: ensure the dedicated guest passphrase cipher exists and
      // matches the current default.  This field was added after the initial
      // seed, so older rows won't have it yet.
      if (!existing.guestPassphraseCipher) {
        await ctx.db.patch(existing._id, {
          guestPassphraseCipher: await encryptSecret(ctx, DEFAULT_GUEST_PASSPHRASE),
        });
        await audit(
          ctx,
          "system",
          "guest-passphrase-seed",
          "[operator]",
          "Dedicated guest passphrase cipher seeded (separate from operator login passphrase)",
        );
      }
      return { seeded: true };
    }
    const passphraseCipher = await encryptSecret(ctx, DEFAULT_OPERATOR_PASSPHRASE);
    const guestPassphraseCipher = await encryptSecret(ctx, DEFAULT_GUEST_PASSPHRASE);
    const emailCipher = await encryptSecret(ctx, DEFAULT_OPERATOR_EMAIL);
    const altEmailCipher = await encryptSecret(ctx, DEFAULT_ALT_OPERATOR_EMAIL);
    await ctx.db.insert("operatorConfig", {
      emailCipher,
      emailHash: await sha256Hex(DEFAULT_OPERATOR_EMAIL.toLowerCase()),
      altEmail: "",
      altEmailCipher,
      altEmailHash: await sha256Hex(DEFAULT_ALT_OPERATOR_EMAIL.toLowerCase()),
      passphraseCipher,
      passphraseUpdatedAt: Date.now(),
      guestPassphraseCipher,
    });
    await audit(
      ctx,
      "system",
      "seed-operator",
      "[operator]",
      "Operator profile seeded; default email and passphrase stored encrypted (AES-256-GCM)",
    );
    return { seeded: true };
  },
});

/** Public status — only whether the operator profile exists. Never leaks secrets. */
export const operatorStatus = query({
  args: {},
  handler: async (ctx) => {
    const op = await ctx.db.query("operatorConfig").first();
    return { seeded: Boolean(op) };
  },
});

/**
 * "Continue as Guest" (operator) — every time the button is clicked a fresh
 * periodic code is generated, stored server-side (operatorCodes, purpose
 * "guest") AND emailed to the operator's default email address stored in the
 * backend (operatorConfig). Real email through the same relay every other
 * code uses; rate-limited so the channel cannot be spammed. Nothing is
 * simulated — each click really dispatches a fresh code.
 */
export const sendOperatorGuestCode = mutation({
  args: {},
  handler: async (ctx) => {
    await enforceRateLimit(ctx, {
      bucket: "operator-guest-code",
      limit: 5,
      windowMs: 10 * 60_000,
      message: "Too many guest-code requests — wait a few minutes.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code = generateNumericCode(6);
    await ctx.db.insert("operatorCodes", {
      purpose: "guest",
      email: opEmail,
      code,
      expiresAt: Date.now() + OPERATOR_CODE_TTL_MS,
      used: false,
      createdAt: Date.now(),
    });
    await scheduleOperatorMail(ctx, {
      subject: "Operator guest access code",
      html: `<p>You clicked <b>“Continue as Guest”</b>. Your periodic guest access code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>It expires in 15 minutes. Enter it in the app to open the guest session. This code is sent to every selected operator inbox — keep it private.</p>`,
      code,
    });
    await scheduleWhatsAppMirror(
      ctx,
      "Operator guest access code",
      `Your periodic guest access code is: ${code}\nExpires in 15 minutes. Enter it in the app to open the guest session.`,
    );
    await audit(
      ctx,
      "terminal operator",
      "operator-guest-code",
      "[operator]",
      "Periodic guest access code generated (stored server-side) and emailed to ALL operator default inboxes + WhatsApp (Continue as Guest clicked)",
    );
    return { ok: true, channel: "queued", emailDelivered: true, expiresInMinutes: 15 };
  },
});

/**
 * Verify the fresh guest code before the guest session / desktop downloads
 * open. Checks the latest UNUSED guest code stored for the operator's default
 * email (constant-time compare, 15-minute expiry), marks it used on success
 * and audits the unlock. Nothing is simulated — only a real backend match
 * unlocks the guest path.
 */
export const verifyOperatorGuestCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await enforceRateLimit(ctx, {
      bucket: "operator-guest-verify",
      limit: 10,
      windowMs: 60_000,
      message: "Too many guest-code attempts — try again in a minute.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const row = rows
      .filter((r) => r.purpose === "guest" && !r.used)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!row) {
      throw new Error(
        "No guest code found — click “Continue as Guest” again to receive a fresh one.",
      );
    }
    if (!ctEqual(row.code, code.trim())) {
      throw new Error("Invalid guest code.");
    }
    if (row.expiresAt < Date.now()) {
      throw new Error(
        "This guest code has expired — click “Continue as Guest” to receive a fresh one.",
      );
    }
    await ctx.db.patch(row._id, { used: true, verifiedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      "operator-guest-verify",
      "[operator]",
      "Operator verified the guest access code — guest session unlocked",
    );
    return { ok: true };
  },
});

/** Verify operator email + passphrase against the backend record. */
export const operatorLogin = action({
  args: { email: v.string(), passphrase: v.string() },
  // Explicit return type: without it TS cannot infer through the
  // `internal.gate.verifyOperatorCredentials` round-trip (circular module ref).
  handler: async (ctx, { email, passphrase }): Promise<{ ok: boolean }> => {
    // Count the attempt in its OWN transaction before verifying. A mutation
    // that both counts and throws rolls its own write back — which is why this
    // throttle used to count nothing: every rejected attempt discarded its own
    // counter. `consume` commits independently of the rejection below, so
    // brute-force attempts now really do burn slots.
    await ctx.runMutation(internal.rateLimit.consume, {
      // Shared (email-free) bucket — the hidden operator email must never be
      // written anywhere, including the rate-limiter rows.
      bucket: "operator-login",
      limit: 5,
      windowMs: 60_000,
      message: "Too many operator sign-in attempts — try again in a minute.",
    });
    // Credential check runs as a separate internal mutation so its decrypt +
    // audit stay transactional, while the increment above survives a rejection.
    return await ctx.runMutation(internal.gate.verifyOperatorCredentials, {
      email,
      passphrase,
    });
  },
});

/** Internal credential check for {@link operatorLogin} — never call directly from a client. */
export const verifyOperatorCredentials = internalMutation({
  args: { email: v.string(), passphrase: v.string() },
  handler: async (ctx, { email, passphrase }) => {
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const altEmail = op.altEmailCipher
      ? await decryptSecret(ctx, op.altEmailCipher)
      : (op.altEmail ?? "");
    const normalized = email.trim().toLowerCase();
    if (
      normalized !== opEmail.toLowerCase() &&
      normalized !== altEmail.toLowerCase()
    ) {
      throw new Error("Unknown operator email address.");
    }
    const plain = await decryptSecret(ctx, op.passphraseCipher);
    if (!ctEqual(passphrase, plain)) {
      throw new Error("Invalid passphrase.");
    }
    await audit(
      ctx,
      "terminal operator",
      "operator-login",
      "[operator]",
      "Terminal operator signed in to the gate",
    );
    return { ok: true };
  },
});

/**
 * Verify the hidden gate passphrase entered above the "Continue as Guest"
 * button. The passphrase is stored AES-256-GCM encrypted in operatorConfig;
 * this mutation decrypts it and does a constant-time comparison. The
 * plaintext is never returned to the client.
 */
export const verifyGuestPassphrase = mutation({
  args: { passphrase: v.string() },
  handler: async (ctx, { passphrase }) => {
    await enforceRateLimit(ctx, {
      bucket: "guest-passphrase-verify",
      limit: 10,
      windowMs: 60_000,
      message: "Too many passphrase attempts — try again in a minute.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    // Use the dedicated guest passphrase cipher (separate from the operator
    // login passphrase) so both can live independently in the backend.
    const guestCipher = op.guestPassphraseCipher ?? op.passphraseCipher;
    const plain = await decryptSecret(ctx, guestCipher);
    if (!ctEqual(passphrase.trim(), plain)) {
      throw new Error("Invalid passphrase.");
    }
    return { ok: true };
  },
});

/** Require a change code verified within the short editable window. */
async function requireRecentChangeCode(ctx: MutationCtx, op: { email?: string; emailCipher?: string }) {
  const opEmail = await getOperatorEmail(ctx, op);
  const rows = await ctx.db
    .query("operatorCodes")
    .withIndex("by_email", (q) => q.eq("email", opEmail))
    .collect();
  const recent = rows
    .filter((r) => r.purpose === "change" && r.used && typeof r.verifiedAt === "number")
    .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0))[0];
  if (!recent || (recent.verifiedAt ?? 0) < Date.now() - CHANGE_WINDOW_MS) {
    throw new Error(
      "The change session has expired — request a new one-time code and verify it again.",
    );
  }
}

/**
 * "visible" / "change" buttons — email a one-time code to the stored operator
 * address. The hidden operator email can only be revealed (short visible
 * window) or replaced (short editable window) after the emailed code is
 * verified. The passphrase follows the same rules.
 */
export const requestOperatorCode = mutation({
  args: { purpose: v.union(v.literal("reveal"), v.literal("change")) },
  handler: async (ctx, { purpose }) => {
    await enforceRateLimit(ctx, {
      bucket: `operator-code-${purpose}`,
      limit: 3,
      windowMs: 15 * 60_000,
      message: "Too many code requests — wait 15 minutes before requesting another.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code = generateNumericCode(6);
    await ctx.db.insert("operatorCodes", {
      purpose,
      email: opEmail,
      code,
      expiresAt: Date.now() + OPERATOR_CODE_TTL_MS,
      used: false,
      createdAt: Date.now(),
    });
    const actionLabel =
      purpose === "reveal"
        ? "viewing the terminal operator email / passphrase"
        : "changing the terminal operator email / passphrase";
    await scheduleOperatorMail(ctx, {
      subject: `One-time code — ${actionLabel}`,
      html: `<p>You asked to ${purpose === "reveal" ? "view" : "change"} the terminal operator credentials.</p><p>Your one-time code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>It expires in 15 minutes.</p>`,
      code,
    });
    await scheduleWhatsAppMirror(
      ctx,
      `One-time code — ${actionLabel}`,
      `Your one-time code is: ${code}\nExpires in 15 minutes.`,
    );
    await audit(
      ctx,
      "terminal operator",
      `request-${purpose}-code`,
      "[operator]",
      `One-time code dispatched to ALL operator default inboxes + WhatsApp for credential ${purpose}`,
    );
    return { ok: true, expiresInMinutes: 15, channel: "queued", emailDelivered: true };
  },
});

/**
 * Verify the emailed one-time code.
 * - reveal: returns the decrypted email + passphrase with a short
 *   "visible but unchangeable" window (revealExpiresAt); after it lapses the
 *   credentials become hidden again.
 * - change: unlocks a short editable window (changeExpiresAt) and returns the
 *   current email so it can be edited; updates are applied by
 *   updateOperatorEmail / updateOperatorPassphrase.
 */
export const verifyOperatorCode = mutation({
  args: { purpose: v.union(v.literal("reveal"), v.literal("change")), code: v.string() },
  handler: async (ctx, { purpose, code }) => {
    await enforceRateLimit(ctx, {
      bucket: `operator-verify-${purpose}`,
      limit: 10,
      windowMs: 60_000,
      message: "Too many verification attempts — try again in a minute.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const row = rows
      .filter((r) => r.purpose === purpose && !r.used)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!row || !ctEqual(row.code, code.trim())) {
      throw new Error("Invalid code.");
    }
    if (row.expiresAt < Date.now()) {
      throw new Error("This code has expired — request a new one.");
    }
    await ctx.db.patch(row._id, { used: true, verifiedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      `verify-${purpose}-code`,
      "[operator]",
      `Operator verified the one-time code for credential ${purpose}`,
    );
    if (purpose === "reveal") {
      const email = await getOperatorEmail(ctx, op);
      const plain = await decryptSecret(ctx, op.passphraseCipher);
      const altEmail = op.altEmailCipher
        ? await decryptSecret(ctx, op.altEmailCipher)
        : (op.altEmail ?? "");
      return {
        ok: true,
        reveal: { email, passphrase: plain, altEmail },
        revealExpiresAt: Date.now() + REVEAL_WINDOW_MS,
      };
    }
    const current = await getOperatorEmail(ctx, op);
    return { ok: true, current, changeExpiresAt: Date.now() + CHANGE_WINDOW_MS };
  },
});

/** Apply a new operator email (after a verified "change" code, within the window). */
export const updateOperatorEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const next = email.trim().toLowerCase();
    if (!EMAIL_RE.test(next)) throw new Error("A valid email address is required.");
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    await requireRecentChangeCode(ctx, op);
    const emailCipher = await encryptSecret(ctx, next);
    await ctx.db.patch(op._id, {
      email: "",
      emailCipher,
      emailHash: await sha256Hex(next),
    });
    await audit(
      ctx,
      "terminal operator",
      "operator-email-update",
      "[operator]",
      "Terminal operator email updated and re-encrypted",
    );
    return { ok: true };
  },
});

/** Apply a new passphrase (after a verified "change" code). Re-encrypted server-side. */
export const updateOperatorPassphrase = mutation({
  args: { passphrase: v.string() },
  handler: async (ctx, { passphrase }) => {
    if (passphrase.trim().length < 8) {
      throw new Error("The new passphrase must be at least 8 characters long.");
    }
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    await requireRecentChangeCode(ctx, op);
    const passphraseCipher = await encryptSecret(ctx, passphrase.trim());
    await ctx.db.patch(op._id, {
      passphraseCipher,
      passphraseUpdatedAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "operator-passphrase-update",
      "[operator]",
      "Terminal operator passphrase updated and re-encrypted",
    );
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Subscriber passcodes
// ---------------------------------------------------------------------------

/** Decrypt a stored subscriber passcode (encrypted rows, then legacy plaintext). */
async function getSubscriberPasscode(
  ctx: MutationCtx,
  row: { passcode?: string; passcodeCipher?: string },
): Promise<string> {
  if (row.passcodeCipher) return decryptSecret(ctx, row.passcodeCipher);
  if (row.passcode) return row.passcode;
  throw new Error("No passcode stored for this subscriber.");
}

/** Encrypt a passcode for storage (plaintext never touches the frontend). */
async function storePasscode(ctx: MutationCtx, code: string): Promise<{ passcode: string; passcodeCipher: string }> {
  return { passcode: "", passcodeCipher: await encryptSecret(ctx, code) };
}

/** Encrypt a permit code for storage (plaintext never touches the frontend). */
async function storePermitCode(ctx: MutationCtx, code: string): Promise<{ permitCodeCipher: string }> {
  return { permitCodeCipher: await encryptSecret(ctx, code) };
}

/** Decrypt a subscriber permit code from the backend record. */
async function getSubscriberPermitCode(
  ctx: MutationCtx,
  row: { permitCode?: string; permitCodeCipher?: string },
): Promise<string> {
  if (row.permitCodeCipher) return decryptSecret(ctx, row.permitCodeCipher);
  if (row.permitCode) return row.permitCode;
  throw new Error("No permit code stored for this subscriber.");
}


/**
 * Subscription submit from the popup. Behavior depends on the subject line:
 * - "request" ("Request a passcode"): a unique random passcode is generated
 *   and stored encrypted; it is emailed ONLY to the operator — never to the
 *   subscriber at this stage. An email with an unexpired passcode cannot
 *   generate another one; an email whose passcode was already used to open
 *   the landing page can never generate another one.
 * - "send" ("Send a passcode"): requires a registered email (an existing
 *   subscriber record) and a payment-receipt file (.png/.jpg/.jpeg/.pdf).
 *   All details + the receipt go to the operator; only the receipt file is
 *   stored (awaiting → confirmed / rejected) for the operator to confirm,
 *   reject or delete. The passcode is emailed to the subscriber only when
 *   the operator triggers "send" after confirming.
 * - "other" ("Other issues"): information is forwarded to the operator only —
 *   no passcode is generated and nothing is stored. Both registered and
 *   unregistered email addresses are welcome.
 */
export const subscriberSubmit = mutation({
  args: {
    fullName: v.string(),
    email: v.string(),
    location: v.string(),
    subject: v.union(v.literal("request"), v.literal("send"), v.literal("other")),
    message: v.string(),
    file: v.optional(v.string()),
    fileName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("A valid email address is required.");
    if (args.fullName.trim().length < 2) throw new Error("Your full name is required.");
    if (args.message.trim().length < 3) throw new Error("A short message is required.");
    await enforceRateLimit(ctx, {
      bucket: `subscriber-submit:${email}`,
      limit: 5,
      windowMs: 10 * 60_000,
      message: "Too many subscription submissions from this email — wait a few minutes.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);

    const existing = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (existing?.status === "blocked") {
      throw new Error("This email address is blocked by the terminal operator.");
    }

    // ----- "Request a passcode" -----
    if (args.subject === "request") {
      if (existing?.activatedAt) {
        throw new Error(
          "This email address already activated its passcode — a new one can never be generated for it again.",
        );
      }
      const stillValid = Boolean(existing && existing.expiresAt > Date.now());
      let passcode: string;
      let permitCode: string;
      if (stillValid && existing) {
        // Keep the same unexpired passcode — an email cannot generate another
        // one until its current passcode expires.
        passcode = await getSubscriberPasscode(ctx, existing);
        // Also generate a fresh permit code if one doesn't exist yet
        if (existing.permitCodeCipher) {
          permitCode = await getSubscriberPermitCode(ctx, existing);
        } else {
          permitCode = generatePermitCode();
          const permitStored = await storePermitCode(ctx, permitCode);
          await ctx.db.patch(existing._id, { ...permitStored });
        }
      } else {
        passcode = generatePasscode();
        permitCode = generatePermitCode();
        const stored = await storePasscode(ctx, passcode);
        const permitStored = await storePermitCode(ctx, permitCode);
        if (existing) {
          await ctx.db.patch(existing._id, {
            fullName: args.fullName.trim(),
            location: args.location.trim(),
            message: args.message.trim(),
            ...stored,
            ...permitStored,
            permitCodeExpiry: Date.now() + DEFAULT_EXPIRY_HOURS * HOUR_MS,
            status: "active",
            expiresAt: freshExpiryAt(existing),
            lastSentAt: undefined,
            notifyNote: undefined,
          });
        } else {
          await ctx.db.insert("subscribers", {
            email,
            fullName: args.fullName.trim(),
            location: args.location.trim(),
            subject: args.subject,
            message: args.message.trim(),
            passcodeCipher: stored.passcodeCipher,
            permitCodeCipher: permitStored.permitCodeCipher,
            permitCodeExpiry: Date.now() + DEFAULT_EXPIRY_HOURS * HOUR_MS,
            status: "active",
            subscriptionPlan: "free",
            expiresAt: Date.now() + DEFAULT_EXPIRY_HOURS * HOUR_MS,
            expiryHours: DEFAULT_EXPIRY_HOURS,
            createdAt: Date.now(),
          });
        }
      }
      await scheduleOperatorMail(ctx, {
        subject: `New subscription request + unique passcode — ${email}`,
        html: `<p><b>New subscription request</b></p><p>From: ${escapeHtml(args.fullName)} (${escapeHtml(email)})<br/>Location: ${escapeHtml(args.location)}</p><p>Message: ${escapeHtml(args.message)}</p><p>Unique passcode for this subscriber: <b>${passcode}</b></p><p>Unique permit code (subscriber auth gate): <b>${permitCode}</b></p><p>Both expire in 72 hours. The passcode and permit code have NOT been sent to the subscriber yet. Use the Send trigger in the operator console to deliver them after confirming payment.</p>`,
        code: passcode,
        redactRecipient: true,
        fromName: args.fullName.trim(),
        fromEmail: email,
      });
      await scheduleWhatsAppMirror(
        ctx,
        `New subscription request — ${email}`,
        `Name: ${args.fullName}\nEmail: ${email}\nLocation: ${args.location}\nMessage: ${args.message}\nUnique passcode: ${passcode}\nUnique permit code: ${permitCode}${stillValid ? " (existing — unchanged)" : " (both expire in 72 hours)"}\nNot sent to the subscriber yet — use the Send trigger after confirming payment.`,
      );
      await audit(
        ctx,
        email,
        "subscriber-request",
        email,
        stillValid
          ? "Subscription request received; existing valid passcode retained (not regenerated) and reported to the operator"
          : "Subscription request received; unique passcode generated (encrypted) and dispatched to the operator only",
      );
      return {
        ok: true,
        subject: args.subject,
        channel: "queued",
        emailDelivered: true,
      };
    }

    // ----- "Send a passcode" (payment receipt) -----
    if (args.subject === "send") {
      if (!existing) {
        throw new Error(
          'This email address is not registered yet — choose "Request a passcode" first so a passcode can be issued to it.',
        );
      }
      const isReceipt = RECEIPT_RE.test(args.file ?? "");
      if (!isReceipt) {
        throw new Error(
          'A payment receipt file (.png, .jpg, .jpeg, .pdf) is required when "Send a passcode" is selected.',
        );
      }
      if ((args.file?.length ?? 0) > 2_600_000) {
        throw new Error("Payment receipt file is too large (max ~1.5 MB).");
      }
      await ctx.db.patch(existing._id, {
        fullName: args.fullName.trim(),
        location: args.location.trim(),
        subject: args.subject,
        message: args.message.trim(),
        file: args.file,
        fileName: args.fileName ?? "receipt",
        paymentStatus: "awaiting",
        notifyNote: "Awaiting operator confirmation — payment receipt stored",
      });
      const isImage = /^data:image\/(png|jpe?g);base64,/.test(args.file ?? "");
      const attachment = args.file
        ? {
            filename: args.fileName ?? "payment-receipt",
            content: args.file.replace(/^data:[^,]+,/, ""),
            contentType: isImage
              ? args.file?.startsWith("data:image/png")
                ? "image/png"
                : "image/jpeg"
              : "application/pdf",
          }
        : undefined;
      await scheduleOperatorMail(ctx, {
        subject: `Confirm payment receipt + send the unique passcode — ${email}`,
        html: `<p><b>Confirm payment receipt and send the unique passcode.</b></p><p>Subscriber: ${escapeHtml(args.fullName)} (${escapeHtml(email)})<br/>Location: ${escapeHtml(args.location)}</p><p>Message: ${escapeHtml(args.message)}</p>${isImage ? `<p>Receipt preview:</p><img src="${args.file}" style="max-width:480px;border:1px solid #ddd;border-radius:8px"/>` : `<p>Payment receipt file: ${escapeHtml(args.fileName ?? "attached")} — see attachment.</p>`}`,
        redactRecipient: true,
        attachment,
        fromName: args.fullName.trim(),
        fromEmail: email,
      });
      await scheduleWhatsAppMirror(
        ctx,
        `Confirm payment receipt — ${email}`,
        `Subscriber: ${args.fullName} (${email})\nLocation: ${args.location}\nMessage: ${args.message}\nA payment receipt file was attached — confirm it in the operator console to send the unique passcode.`,
      );
      await audit(
        ctx,
        email,
        "subscriber-send",
        email,
        "Payment receipt submitted; operator notified to confirm and send the unique passcode (stored for confirm/reject/delete)",
      );
      return {
        ok: true,
        subject: args.subject,
        channel: "queued",
        emailDelivered: true,
        note: "Confirm payment receipt and send the unique passcode.",
      };
    }

    // ----- "Other issues" — forwarded to the operator only, nothing stored -----
    await scheduleOperatorMail(ctx, {
      subject: `Other issue — ${email}`,
      html: `<p><b>Other issue</b></p><p>From: ${escapeHtml(args.fullName)} (${escapeHtml(email)})<br/>Location: ${escapeHtml(args.location)}</p><p>Message: ${escapeHtml(args.message)}</p>${args.file ? `<p>A file was attached (${escapeHtml(args.fileName ?? "attachment")}).</p>` : ""}`,
      redactRecipient: true,
      fromName: args.fullName.trim(),
      fromEmail: email,
      attachment: args.file
        ? {
            filename: args.fileName ?? "attachment",
            content: args.file.replace(/^data:[^,]+,/, ""),
            contentType: /^data:image\/png/.test(args.file)
              ? "image/png"
              : /^data:image\/jpe?g/.test(args.file)
                ? "image/jpeg"
                : /^data:application\/pdf/.test(args.file)
                  ? "application/pdf"
                  : "application/octet-stream",
          }
        : undefined,
    });
    await scheduleWhatsAppMirror(
      ctx,
      `Other issue — ${email}`,
      `Name: ${args.fullName}\nEmail: ${email}\nLocation: ${args.location}\nMessage: ${args.message}${args.file ? "\nA file was attached." : ""}`,
    );
    await audit(
      ctx,
      email,
      "subscriber-other",
      email,
      "Other-issue message forwarded to the terminal operator (nothing stored)",
    );
    return { ok: true, subject: args.subject, channel: "queued", emailDelivered: true };
  },
});

/** Live helper for the popup — is this email a registered subscriber? */
export const subscriberRegistered = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    if (!EMAIL_RE.test(norm)) return { registered: false };
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", norm))
      .first();
    return { registered: Boolean(row && row.status !== "blocked") };
  },
});

/**
 * Subscriber dashboard — email + passcode must match an active, unexpired
 * record. The first successful login permanently marks the passcode as
 * activated (that email can never generate another passcode).
 */
export const subscriberLogin = mutation({
  args: { email: v.string(), passcode: v.string() },
  handler: async (ctx, { email, passcode }) => {
    const norm = email.trim().toLowerCase();
    await enforceRateLimit(ctx, {
      bucket: `subscriber-login:${norm}`,
      limit: 8,
      windowMs: 60_000,
      message: "Too many sign-in attempts — try again in a minute.",
    });
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", norm))
      .first();
    if (!row) {
      throw new Error("No passcode has been issued for this email address. Please subscribe first.");
    }
    if (row.status === "blocked") {
      throw new Error("This subscription is blocked by the terminal operator.");
    }
    if (row.expiresAt < Date.now()) {
      throw new Error("This passcode has expired. Request a new one through the subscription popup.");
    }
    // Subscription plan hard wall: if the operator set a plan with a finite
    // duration and it has lapsed, block access until the subscriber re-subscribes.
    if (row.subscriptionExpiry && row.subscriptionExpiry < Date.now()) {
      throw new Error("Your subscription plan has expired. Please re-subscribe to continue using the terminal.");
    }
    const stored = await getSubscriberPasscode(ctx, row);
    if (!ctEqual(stored.trim(), passcode.trim())) {
      throw new Error("Invalid passcode.");
    }
    if (row.activatedAt === undefined) {
      await ctx.db.patch(row._id, { activatedAt: Date.now() });
    }
    await audit(
      ctx,
      norm,
      "subscriber-login",
      norm,
      "Subscriber gained access with a valid passcode (passcode marked active)",
    );
    return { ok: true, email: norm };
  },
});

/**
 * Subscriber self-service — the signed-in user's own access state. Returns
 * their real backend record (subscriber row + per-OS desktop licenses) or
 * null when the signed-in email is not a registered subscriber. No secrets:
 * passcodes stay encrypted server-side; only statuses, timestamps and
 * windows are returned. Powers the "My access" panel on the terminal
 * (subscriber view) — operators simply get null here (their console already
 * covers the same rows).
 */
export const myAccess = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) return null;
    const sub = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!sub) return null;
    const licenses = await ctx.db
      .query("activationLicenses")
      .withIndex("by_email_os", (q) => q.eq("email", email))
      .collect();
    return {
      email,
      subscriber: {
        status: sub.status,
        expiresAt: sub.expiresAt,
        expiryHours: sub.expiryHours ?? DEFAULT_EXPIRY_HOURS,
        activatedAt: sub.activatedAt ?? undefined,
        createdAt: sub.createdAt,
        lastSentAt: sub.lastSentAt ?? undefined,
        paymentStatus: sub.paymentStatus ?? undefined,
        notifyNote: sub.notifyNote ?? undefined,
        alertPrefs: {
          marketNews: sub.alertPrefs?.marketNews ?? true,
          sessionAlerts: sub.alertPrefs?.sessionAlerts ?? true,
          honeyPot: sub.alertPrefs?.honeyPot ?? true,
          earnings: sub.alertPrefs?.earnings ?? true,
        },
      },
      licenses: licenses
        .sort((a, b) => a.os.localeCompare(b.os))
        .map((l) => ({
          os: l.os,
          status: l.status,
          activationCount: l.activationCount,
          lastActivatedAt: l.lastActivatedAt ?? undefined,
          rotatedAt: l.rotatedAt,
          expiresAt: l.expiresAt,
        })),
    };
  },
});

/**
 * Subscriber alert preferences — the signed-in user tunes which real in-app
 * bell alerts they receive (market news, session changes, honey pots,
 * earnings/executions). Each toggle merges onto the stored prefs; anything
 * omitted keeps its current value. Only the signed-in subscriber's own row
 * can be edited, and only for the signed-in email. The Telegram channel is
 * operator-managed and is NEVER gated by these — they control the in-app
 * bell only.
 */
export const updateAlertPrefs = mutation({
  args: {
    marketNews: v.optional(v.boolean()),
    sessionAlerts: v.optional(v.boolean()),
    honeyPot: v.optional(v.boolean()),
    earnings: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) throw new Error("Sign in to change alert preferences.");
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!row) throw new Error("Only subscribers can set alert preferences.");
    const next = {
      marketNews: args.marketNews ?? row.alertPrefs?.marketNews ?? true,
      sessionAlerts: args.sessionAlerts ?? row.alertPrefs?.sessionAlerts ?? true,
      honeyPot: args.honeyPot ?? row.alertPrefs?.honeyPot ?? true,
      earnings: args.earnings ?? row.alertPrefs?.earnings ?? true,
    };
    await ctx.db.patch(row._id, { alertPrefs: next });
    await audit(
      ctx,
      email,
      "alert-prefs-update",
      email,
      "Subscriber updated their in-app alert preferences",
    );
    return next;
  },
});

/** Operator console — subscriber list. Passcodes are encrypted server-side and
 *  never returned: masked placeholders only, so the plaintext cannot be copied
 *  anywhere before the operator confirms payment and triggers "send". */
export const listSubscribers = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("subscribers").collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        email: r.email,
        fullName: r.fullName,
        location: r.location,
        subject: r.subject,
        message: r.message,
        status: r.status,
        expiresAt: r.expiresAt,
        expiryHours: r.expiryHours ?? DEFAULT_EXPIRY_HOURS,
        createdAt: r.createdAt,
        lastSentAt: r.lastSentAt ?? undefined,
        notifyNote: r.notifyNote ?? undefined,
        fileName: r.fileName ?? undefined,
        hasFile: Boolean(r.file),
        paymentStatus: r.paymentStatus ?? undefined,
        activatedAt: r.activatedAt ?? undefined,
        subscriptionPlan: r.subscriptionPlan ?? "free",
        subscriptionExpiry: r.subscriptionExpiry ?? undefined,
        passcodeEncrypted: Boolean(r.passcodeCipher),
        maskedPasscode: r.passcodeCipher ? "••••••••" : maskPasscode(r.passcode ?? ""),
        hasPermitCode: Boolean(r.permitCodeCipher),
        maskedPermitCode: r.permitCodeCipher ? "••••••••" : "",
        permitCodeExpiry: r.permitCodeExpiry ?? undefined,
        // Daily execution target (combined arb + snipe across both terminals).
        // 0 = blocked; today's usage so the operator sees live headroom.
        dailyTradeLimit: typeof r.dailyTradeLimit === "number" ? r.dailyTradeLimit : null,
        dailyTradeCount: r.dailyTradeDate === todayKey() ? (r.dailyTradeCount ?? 0) : 0,
      }));
  },
});

function maskPasscode(code: string): string {
  if (code.length <= 4) return "••••";
  return `${code.slice(0, 3)}••••${code.slice(-5)}`;
}

/** Subscription plan list for the frontend. */
export const SUBSCRIPTION_PLANS = [
  { value: "free" as const, label: "Free (no plan expiry)", months: 0 },
  { value: "1month" as const, label: "1 Month", months: 1 },
  { value: "2month" as const, label: "2 Months", months: 2 },
  { value: "3month" as const, label: "3 Months", months: 3 },
  { value: "4month" as const, label: "4 Months", months: 4 },
  { value: "5month" as const, label: "5 Months", months: 5 },
  { value: "6month" as const, label: "6 Months", months: 6 },
  { value: "9month" as const, label: "9 Months", months: 9 },
  { value: "1year" as const, label: "1 Year", months: 12 },
] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number]["value"];

/** Operator sets / changes a subscriber's subscription plan from the console. */
export const setSubscriptionPlan = mutation({
  args: {
    email: v.string(),
    plan: v.union(
      v.literal("free"),
      v.literal("1month"),
      v.literal("2month"),
      v.literal("3month"),
      v.literal("4month"),
      v.literal("5month"),
      v.literal("6month"),
      v.literal("9month"),
      v.literal("1year"),
    ),
  },
  handler: async (ctx, { email, plan }) => {
    await requireOperator(ctx);
    const norm = email.trim().toLowerCase();
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", norm))
      .first();
    if (!row) throw new Error("Subscriber not found.");

    const durationMs = SUBSCRIPTION_PLAN_MS[plan] ?? 0;
    const subscriptionExpiry = durationMs > 0 ? Date.now() + durationMs : undefined;

    await ctx.db.patch(row._id, {
      subscriptionPlan: plan,
      subscriptionExpiry,
      // If switching to a new plan, reset passcode expiry to now + 72h so
      // the subscriber can log in immediately (the plan controls long-term
      // access; the passcode window is the short-lived entry credential).
      expiresAt: Date.now() + DEFAULT_EXPIRY_HOURS * HOUR_MS,
    });

    await audit(
      ctx,
      norm,
      "subscription-plan-change",
      norm,
      `Subscription plan changed to "${plan}"${subscriptionExpiry ? ` (expires ${new Date(subscriptionExpiry).toISOString()})` : " (no plan expiry)"}`,
    );

    return {
      ok: true,
      plan,
      subscriptionExpiry,
    };
  },
});

export const blockSubscriber = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.patch(row._id, { status: "blocked" });
    await audit(ctx, "terminal operator", "subscriber-block", row.email, "Subscriber passcode blocked by the operator");
    return { ok: true };
  },
});

export const unblockSubscriber = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.patch(row._id, { status: "active", expiresAt: freshExpiryAt(row) });
    await audit(ctx, "terminal operator", "subscriber-unblock", row.email, "Subscriber passcode unblocked by the operator");
    return { ok: true };
  },
});

/** Set a custom expiry window (hours) for one subscriber — per-subscriber control. */
export const setSubscriberExpiry = mutation({
  args: { email: v.string(), hours: v.number() },
  handler: async (ctx, { email, hours }) => {
    const h = Math.floor(hours);
    if (!Number.isFinite(h) || h < MIN_EXPIRY_HOURS || h > MAX_EXPIRY_HOURS) {
      throw new Error(
        `Expiry window must be between ${MIN_EXPIRY_HOURS} and ${MAX_EXPIRY_HOURS} hours (1h – 30 days).`,
      );
    }
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const expiresAt = Date.now() + h * HOUR_MS;
    await ctx.db.patch(row._id, {
      expiryHours: h,
      expiresAt,
      lastSentAt: undefined,
    });
    await audit(
      ctx,
      "terminal operator",
      "subscriber-expiry-update",
      row.email,
      `Subscriber passcode expiry window set to ${h} hours by the operator`,
    );
    return { ok: true, hours: h, expiresAt };
  },
});

/** Rotate to a fresh unique passcode (new window). Stored encrypted. */
export const changeSubscriberCode = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const passcode = generatePasscode();
    const stored = await storePasscode(ctx, passcode);
    await ctx.db.patch(row._id, {
      ...stored,
      expiresAt: freshExpiryAt(row),
      lastSentAt: undefined,
    });
    await audit(ctx, "terminal operator", "subscriber-code-change", row.email, "Subscriber passcode rotated by the operator (stored encrypted)");
    return { ok: true };
  },
});

/** Set an explicit passcode (operator-chosen). Stored encrypted. */
export const updateSubscriberCode = mutation({
  args: { email: v.string(), passcode: v.string() },
  handler: async (ctx, { email, passcode }) => {
    const code = passcode.trim().toUpperCase();
    if (!/^[A-Z0-9-]{8,24}$/.test(code)) {
      throw new Error("Passcode must be 8–24 characters (letters, numbers, dashes).");
    }
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const stored = await storePasscode(ctx, code);
    await ctx.db.patch(row._id, {
      ...stored,
      expiresAt: freshExpiryAt(row),
      lastSentAt: undefined,
    });
    await audit(ctx, "terminal operator", "subscriber-code-update", row.email, "Subscriber passcode updated by the operator (stored encrypted)");
    return { ok: true };
  },
});

/** Confirm a payment receipt — unlocks the "send" trigger for that subscriber. */
export const confirmPaymentReceipt = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    if (row.subject !== "send" || !row.file) {
      throw new Error("There is no payment receipt to confirm for this subscriber.");
    }
    await ctx.db.patch(row._id, {
      paymentStatus: "confirmed",
      notifyNote: "Payment confirmed — passcode ready to send",
    });
    await audit(ctx, "terminal operator", "payment-confirmed", row.email, "Payment receipt confirmed by the operator");
    return { ok: true };
  },
});

/** Reject a payment receipt — keeps the file for review, disables sending. */
export const rejectPaymentReceipt = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    if (row.subject !== "send" || !row.file) {
      throw new Error("There is no payment receipt to reject for this subscriber.");
    }
    await ctx.db.patch(row._id, {
      paymentStatus: "rejected",
      notifyNote: "Payment receipt rejected by the operator",
    });
    await audit(ctx, "terminal operator", "payment-rejected", row.email, "Payment receipt rejected by the operator");
    return { ok: true };
  },
});

/** Delete a subscriber record entirely (passcode + stored receipt). */
export const deleteSubscriber = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.delete(row._id);
    await audit(ctx, "terminal operator", "subscriber-delete", row.email, "Subscriber record deleted by the operator");
    return { ok: true };
  },
});

/**
 * Trigger arrow ("send") — email the unique passcode to that one subscriber.
 * Only a passcode that has NOT expired can be sent; for "Send a passcode"
 * subscriptions the payment receipt must be confirmed first. The passcode is
 * decrypted server-side at send time and never exposed to the frontend.
 */
export const sendSubscriberCode = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await enforceRateLimit(ctx, {
      bucket: `subscriber-send:${email.trim().toLowerCase()}`,
      limit: 10,
      windowMs: 10 * 60_000,
      message: "Too many send requests for this subscriber — wait a few minutes.",
    });
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    if (row.status === "blocked") throw new Error("Blocked subscribers cannot receive passcodes.");
    if (row.expiresAt < Date.now()) {
      throw new Error("This passcode has expired — rotate a new one from the console first.");
    }
    if (row.subject === "send" && row.paymentStatus !== "confirmed") {
      throw new Error("Confirm the payment receipt before sending the passcode.");
    }
    const passcode = await getSubscriberPasscode(ctx, row);
    await ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, {
      to: row.email,
      subject: "FlashBolt — your unique access passcode",
      html: `<p>Hi ${escapeHtml(row.fullName)},</p><p>Your unique FlashBolt access passcode is:</p><h2 style="letter-spacing:2px">${passcode}</h2><p>It expires in ${expiryHoursOf(row)} hours from issue. Use it on the subscriber dashboard to open the terminal.</p>`,
      code: passcode,
    });
    await ctx.db.patch(row._id, { lastSentAt: Date.now() });
    await audit(ctx, "terminal operator", "subscriber-code-sent", row.email, "Passcode dispatched to the subscriber (send trigger)");
    return { ok: true, channel: "queued", emailDelivered: true, email: row.email };
  },
});


// ---------------------------------------------------------------------------
// Permit code management — mirrors passcode lifecycle for the landing page gate
// ---------------------------------------------------------------------------

/** Rotate to a fresh unique permit code (new window). Stored encrypted. */
export const changeSubscriberPermitCode = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const permitCode = generatePermitCode();
    const stored = await storePermitCode(ctx, permitCode);
    await ctx.db.patch(row._id, {
      ...stored,
      permitCodeExpiry: Date.now() + (row.expiryHours ?? DEFAULT_EXPIRY_HOURS) * HOUR_MS,
    });
    await audit(ctx, "terminal operator", "subscriber-permit-change", row.email, "Subscriber permit code rotated by the operator");
    return { ok: true };
  },
});

/** Set an explicit permit code (operator-chosen). Stored encrypted. */
export const updateSubscriberPermitCode = mutation({
  args: { email: v.string(), permitCode: v.string() },
  handler: async (ctx, { email, permitCode }) => {
    await requireOperator(ctx);
    const code = permitCode.trim().toUpperCase();
    if (code.length < 4) {
      throw new Error("Permit code must be at least 4 characters.");
    }
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const stored = await storePermitCode(ctx, code);
    await ctx.db.patch(row._id, {
      ...stored,
      permitCodeExpiry: Date.now() + (row.expiryHours ?? DEFAULT_EXPIRY_HOURS) * HOUR_MS,
    });
    await audit(ctx, "terminal operator", "subscriber-permit-update", row.email, "Subscriber permit code updated by the operator");
    return { ok: true };
  },
});

/** Email the unique permit code to the subscriber (send trigger for permit). */
export const sendSubscriberPermitCode = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    await enforceRateLimit(ctx, {
      bucket: `subscriber-permit-send:${email.trim().toLowerCase()}`,
      limit: 10,
      windowMs: 10 * 60_000,
      message: "Too many permit send requests — wait a few minutes.",
    });
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    if (row.status === "blocked") throw new Error("Blocked subscribers cannot receive permit codes.");
    if (!row.permitCodeCipher) throw new Error("No permit code generated for this subscriber.");
    if (row.permitCodeExpiry && row.permitCodeExpiry < Date.now()) {
      throw new Error("This permit code has expired — rotate a new one first.");
    }
    const permitCode = await getSubscriberPermitCode(ctx, row);
    await ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, {
      to: row.email,
      subject: "FlashBolt — your unique permit code (subscriber gate)",
      html: `<p>Hi ${escapeHtml(row.fullName)},</p><p>Your unique FlashBolt permit code for the subscriber access gate is:</p><h2 style="letter-spacing:2px">${permitCode}</h2><p>Use this code along with your subscribing email address on the landing page to access the subscriber terminal. It expires in ${expiryHoursOf(row)} hours.</p>`,
      code: permitCode,
    });
    await audit(ctx, "terminal operator", "subscriber-permit-sent", row.email, "Permit code dispatched to the subscriber (send trigger)");
    return { ok: true, channel: "queued", emailDelivered: true, email: row.email };
  },
});

/** Block a subscriber's permit code — prevents landing page gate access. */
export const blockSubscriberPermit = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    // Re-encrypt with a dead code so it never matches
    const stored = await storePermitCode(ctx, "BLOCKED-" + Date.now());
    await ctx.db.patch(row._id, { ...stored, permitCodeExpiry: 0 });
    await audit(ctx, "terminal operator", "subscriber-permit-block", row.email, "Subscriber permit code blocked by the operator");
    return { ok: true };
  },
});

/** Unblock a subscriber's permit code — generates a fresh one with a new window. */
export const unblockSubscriberPermit = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    const permitCode = generatePermitCode();
    const stored = await storePermitCode(ctx, permitCode);
    await ctx.db.patch(row._id, {
      ...stored,
      permitCodeExpiry: Date.now() + (row.expiryHours ?? DEFAULT_EXPIRY_HOURS) * HOUR_MS,
    });
    await audit(ctx, "terminal operator", "subscriber-permit-unblock", row.email, "Subscriber permit code unblocked by the operator (fresh code generated)");
    return { ok: true };
  },
});

/** Delete a subscriber's permit code entirely. */
export const deleteSubscriberPermit = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireOperator(ctx);
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.patch(row._id, {
      permitCodeCipher: undefined,
      permitCodeExpiry: undefined,
    });
    await audit(ctx, "terminal operator", "subscriber-permit-delete", row.email, "Subscriber permit code deleted by the operator");
    return { ok: true };
  },
});

/**
 * Verify a subscriber's permit code from the landing page popup.
 * This is a lightweight check — it validates the email + permit code pair
 * without creating a grant. The subscriber then proceeds to the gate/auth
 * page where they also enter their passcode.
 */
export const verifySubscriberPermitGate = mutation({
  args: { email: v.string(), permitCode: v.string() },
  handler: async (ctx, { email, permitCode }) => {
    await enforceRateLimit(ctx, {
      bucket: `permit-gate:${email.trim().toLowerCase()}`,
      limit: 10,
      windowMs: 60_000,
      message: "Too many permit code attempts — try again in a minute.",
    });
    const norm = email.trim().toLowerCase();
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", norm))
      .first();
    if (!row) {
      throw new Error("No subscription found for this email address. Please subscribe first.");
    }
    if (row.status === "blocked") {
      throw new Error("This subscription is blocked by the terminal operator.");
    }
    if (!row.permitCodeCipher) {
      throw new Error("No permit code has been generated for this email. Contact the operator.");
    }
    const storedPermit = await getSubscriberPermitCode(ctx, row);
    if (!ctEqual(storedPermit.trim(), permitCode.trim())) {
      throw new Error("Invalid permit code.");
    }
    if (row.permitCodeExpiry && row.permitCodeExpiry < Date.now()) {
      throw new Error("This permit code has expired. Contact the operator or re-subscribe to get a new one.");
    }
    if (row.expiresAt < Date.now()) {
      throw new Error("Your passcode has expired. Contact the operator to get a new one.");
    }
    await audit(
      ctx,
      norm,
      "permit-gate-verify",
      norm,
      "Subscriber verified permit code on landing page gate",
    );
    return { ok: true, email: norm };
  },
});


// ---------------------------------------------------------------------------
// Client diagnostics — lets the preview report render errors back to the
// backend so they can be diagnosed from the audit log.
// ---------------------------------------------------------------------------

/** Preview runtime errors reported by the browser (boundary + window handlers). */
export const reportClientError = mutation({
  args: {
    message: v.string(),
    stack: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, { message, stack, source }) => {
    await ctx.db.insert("auditLogs", {
      actor: "preview-error",
      action: "client-error",
      target: source ?? "preview",
      description: `${message.slice(0, 500)}${stack ? ` | ${stack.split("\n").slice(0, 4).join(" ").slice(0, 600)}` : ""}`,
      ts: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Operator identity (terminal page) + audit log
// ---------------------------------------------------------------------------

/**
 * Whether the signed-in user IS the terminal operator (compared server-side
 * against the one-way hash of the hidden operator email — the email itself is
 * never exposed). Drives the operator console on the terminal page; the
 * console never appears for subscribers.
 */
export const isOperatorUser = query({
  args: {},
  handler: async (ctx) => {
    // Never throw — this query runs on every terminal page render and a query
    // error would crash the page via useQuery. Return false on any failure so
    // the console simply stays hidden.
    try {
      const identity = await ctx.auth.getUserIdentity();
      const email = identity?.email?.trim().toLowerCase();
      if (!email) return { isOperator: false };
      return { isOperator: await isOperatorEmail(ctx, email) };
    } catch {
      return { isOperator: false };
    }
  },
});

// ---------------------------------------------------------------------------
// Delivery preference (which operator inboxes receive messages) + CSV export
// ---------------------------------------------------------------------------

/**
 * The operator's current delivery preference — which channels receive
 * incoming messages (subscriber submissions, pass codes, activation
 * passwords, one-time codes): all / primary / secondary / whatsapp. No
 * secrets are returned (the hidden emails stay hidden). Only the terminal
 * operator sees a real value; everyone else gets null.
 */
export const getOperatorDeliveryPref = query({
  args: {},
  handler: async (ctx) => {
    try {
      const identity = await ctx.auth.getUserIdentity();
      const email = identity?.email?.trim().toLowerCase();
      if (!email || !(await isOperatorEmail(ctx, email))) return { pref: null };
      const op = await ctx.db.query("operatorConfig").first();
      return { pref: (op?.deliveryPref ?? "secondary") as DeliveryPref };
    } catch {
      return { pref: null };
    }
  },
});

/**
 * Set the delivery preference — operator-gated. Controls which inboxes
 * receive incoming messages: all (both emails + WhatsApp), primary (primary
 * email only), secondary (alternative email only) or whatsapp (chat link
 * only). Enforced centrally by scheduleOperatorMail + scheduleWhatsAppMirror
 * on every operator- and subscriber-originated notification.
 */
export const setOperatorDeliveryPref = mutation({
  args: { pref: v.union(v.literal("all"), v.literal("primary"), v.literal("secondary"), v.literal("whatsapp")) },
  handler: async (ctx, { pref }) => {
    await requireOperator(ctx);
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    await ctx.db.patch(op._id, { deliveryPref: pref });
    await audit(
      ctx,
      "terminal operator",
      "delivery-pref-update",
      "[operator]",
      `Delivery preference set to ${pref} — incoming messages now go to the selected inboxes only`,
    );
    return { ok: true, pref };
  },
});

/**
 * Operator-gated CSV export — the full subscriber registry with decrypted
 * unique passcodes. This is the ONE path that returns plaintext passcodes,
 * and it is locked to the terminal operator (backend identity check) so the
 * registry can be downloaded / audited offline. Everything else keeps
 * passcodes masked.
 */
export const exportSubscribersCsv = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOperator(ctx);
    const rows = await ctx.db.query("subscribers").collect();
    const sorted = rows.sort((a, b) => b.createdAt - a.createdAt);
    const csvCell = (value: string): string => {
      const safe = value.replace(/"/g, '""');
      return /[,"\n\r]/.test(safe) ? `"${safe}"` : safe;
    };
    const header = [
      "email",
      "fullName",
      "location",
      "subject",
      "message",
      "passcode",
      "status",
      "expiresAt",
      "expiryHours",
      "paymentStatus",
      "activatedAt",
      "createdAt",
      "lastSentAt",
      "notifyNote",
    ];
    const lines = [header.join(",")];
    for (const r of sorted) {
      const passcode = r.passcodeCipher
        ? await decryptSecret(ctx, r.passcodeCipher).catch(() => "")
        : (r.passcode ?? "");
      lines.push(
        [
          r.email,
          r.fullName,
          r.location,
          r.subject,
          r.message,
          passcode,
          r.status,
          new Date(r.expiresAt).toISOString(),
          String(r.expiryHours ?? DEFAULT_EXPIRY_HOURS),
          r.paymentStatus ?? "",
          r.activatedAt ? new Date(r.activatedAt).toISOString() : "",
          new Date(r.createdAt).toISOString(),
          r.lastSentAt ? new Date(r.lastSentAt).toISOString() : "",
          r.notifyNote ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    await audit(
      ctx,
      "terminal operator",
      "subscribers-csv-export",
      "[operator]",
      `Subscriber registry exported as CSV (${sorted.length} rows, includes decrypted passcodes)`,
    );
    return { csv: lines.join("\n"), count: sorted.length };
  },
});

/** Operator audit log view — newest first. The operator email never appears:
 *  the new code never writes it, and this query additionally redacts any
 *  legacy entries that predate the encryption change (decrypting the stored
 *  operator email and scrubbing it from every field before returning). */
export const listAuditLogs = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 200 }) => {
    // Redact EVERY operator default inbox (primary + alternative) from the
    // log — neither address may ever appear in a query response.
    const opEmails: string[] = [];
    const op = await ctx.db.query("operatorConfig").first();
    if (op) {
      for (const [cipher, plain] of [
        [op.emailCipher, op.email],
        [op.altEmailCipher, op.altEmail],
      ] as const) {
        try {
          const resolved = cipher ? await decryptSecret(ctx, cipher) : (plain ?? null);
          if (resolved) opEmails.push(resolved);
        } catch {
          // keep the other inboxes
        }
      }
    }
    // Index-desc + take(limit): read only the newest `limit` rows. The old
    // full-table collect() re-transferred the ENTIRE audit log on every
    // subscription re-run — this query is live-subscribed by OperatorConsole
    // and every audit insert re-triggered it, making it a top DB-I/O
    // consumer against the free plan's 1 GB/month cap.
    const rows = await ctx.db
      .query("auditLogs")
      .withIndex("by_ts")
      .order("desc")
      .take(limit);
    return rows.map((r) => {
        if (opEmails.length === 0) return r;
        const scrub = (value: string) =>
          opEmails.reduce(
            (v, email) => v.split(email).join("[operator email hidden]"),
            value,
          );
        return {
          ...r,
          actor: scrub(r.actor),
          target: scrub(r.target),
          description: scrub(r.description),
        };
      });
  },
});

/**
 * Daily audit-log pruning (cron: audit-log-prune). auditLogs is unbounded
 * and live-subscribed (OperatorConsole → listAuditLogs above), so table size
 * directly multiplies that subscription's DB I/O — this keeps only the last
 * 7 days. Deletes run in capped batches (≤4,000 rows per run, well inside
 * the 16,000-docs / 16 MiB per-mutation transaction limits) so a large
 * backlog drains across successive daily runs instead of tripping a limit.
 */
export const pruneAuditLogs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let deleted = 0;
    while (deleted < 4_000) {
      const batch = await ctx.db
        .query("auditLogs")
        .withIndex("by_ts", (q) => q.lt("ts", cutoff))
        .take(400);
      if (batch.length === 0) break;
      for (const row of batch) await ctx.db.delete(row._id);
      deleted += batch.length;
      if (batch.length < 400) break;
    }
    return { deleted };
  },
});

// ---------------------------------------------------------------------------
// Guest passcode — popup display mode (default) vs. email delivery mode
// ---------------------------------------------------------------------------

/** Get the current guest passcode mode for the operator console. */
export const getGuestPasscodeMode = query({
  args: {},
  handler: async (ctx) => {
    const op = await ctx.db.query("operatorConfig").first();
    return { mode: op?.guestPasscodeMode ?? "popup" };
  },
});

/** Set the guest passcode delivery mode (popup or email). */
export const setGuestPasscodeMode = mutation({
  args: { mode: v.union(v.literal("popup"), v.literal("email")) },
  handler: async (ctx, { mode }) => {
    await requireOperator(ctx);
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile not seeded.");
    await ctx.db.patch(op._id, { guestPasscodeMode: mode });
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-mode",
      "[operator]",
      `Guest passcode mode changed to "${mode}"`,
    );
    return { ok: true, mode };
  },
});

/**
 * Generate a one-time guest passcode for the popup display flow.
 * Creates a 6-digit numeric code, stores it in operatorCodes
 * with purpose "guest-passcode", and returns the plaintext code for
 * immediate display in the popup window — no email required.
 */
export const generateGuestPopupCode = mutation({
  args: {},
  handler: async (ctx) => {
    await enforceRateLimit(ctx, {
      bucket: "operator-guest-popup",
      limit: 5,
      windowMs: 10 * 60_000,
      message: "Too many guest passcode requests — wait a few minutes.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code = generateNumericCode(6);
    await ctx.db.insert("operatorCodes", {
      purpose: "guest-passcode",
      email: opEmail,
      code,
      expiresAt: Date.now() + OPERATOR_CODE_TTL_MS,
      used: false,
      createdAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-generate",
      "[operator]",
      "One-time guest passcode generated for popup display",
    );
    return { ok: true, code, expiresInMinutes: 15 };
  },
});

/**
 * Verify the one-time guest passcode entered from the popup display.
 * Checks the latest unused "guest-passcode" code for the operator,
 * validates it, and marks it used.
 */
/**
 * Activate the CURRENT session as a code-verified guest operator session.
 *
 * Called right after the guest access code was verified (popup-displayed
 * "guest-passcode" or emailed "guest"); re-verifies the SAME just-used code
 * (match + not expired) so this stamp can only be reached through a real
 * verification, then marks the current Convex Auth user row with
 * `guestOperatorVerifiedAt`. Guest sessions run under the anonymous auth
 * provider, so this is what lets operator-only backend surfaces (the
 * Telegram bot mirror) accept the "Continue as Guest" identity.
 */
export const activateGuestOperatorSession = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    // The just-verified code of EITHER guest purpose must match and be fresh.
    const now = Date.now();
    const row = rows
      .filter(
        (r) =>
          (r.purpose === "guest-passcode" || r.purpose === "guest") &&
          r.used &&
          typeof r.verifiedAt === "number" &&
          r.verifiedAt >= now - GUEST_STAMP_WINDOW_MS &&
          ctEqual(r.code, code.trim()),
      )
      .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0))[0];
    if (!row) {
      throw new Error(
        "No freshly verified guest code for this session — verify the guest passcode first.",
      );
    }
    await markGuestOperatorSession(ctx);
    await audit(
      ctx,
      "terminal operator",
      "guest-operator-session-activate",
      "[operator]",
      'Guest operator session activated — operator-only surfaces (Telegram bot mirror) now accept this "Continue as Guest" identity',
    );
    // SEAMLESS TELEGRAM AUTO-CONNECT: fire the self-healing webhook check
    // (idempotent) in the background — by the time the operator opens the bot
    // dialog or taps the deep link, the bot is guaranteed ready. Failures are
    // non-blocking (the cron sweep also self-heals every 10 minutes).
    try {
      await ctx.scheduler.runAfter(0, internal.telegramBot.ensureBotReadyInternal, {});
    } catch {
      // non-blocking by design
    }
    return { ok: true };
  },
});

export const verifyGuestPopupCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await enforceRateLimit(ctx, {
      bucket: "operator-guest-popup-verify",
      limit: 10,
      windowMs: 60_000,
      message: "Too many guest passcode attempts — try again in a minute.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const row = rows
      .filter((r) => r.purpose === "guest-passcode" && !r.used)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!row) {
      throw new Error(
        "No guest passcode found — click \"Continue as Guest\" again for a fresh one.",
      );
    }
    if (!ctEqual(row.code, code.trim())) {
      throw new Error("Invalid guest passcode.");
    }
    if (row.expiresAt < Date.now()) {
      throw new Error(
        "This guest passcode has expired — click \"Continue as Guest\" for a fresh one.",
      );
    }
    await ctx.db.patch(row._id, { used: true, verifiedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-verify",
      "[operator]",
      "Guest popup passcode verified — terminal access granted",
    );
    return { ok: true };
  },
});

/**
 * Request a guest passcode reset. Generates a unique reset token,
 * stores it in operatorCodes with purpose "guest-passcode-reset",
 * and sends a clickable reset link via the operator's default delivery.
 */
export const requestGuestPasscodeReset = mutation({
  args: {},
  handler: async (ctx) => {
    await enforceRateLimit(ctx, {
      bucket: "guest-passcode-reset",
      limit: 3,
      windowMs: 10 * 60_000,
      message: "Too many reset requests — wait a few minutes.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const token = generateNumericCode(8);
    await ctx.db.insert("operatorCodes", {
      purpose: "guest-passcode-reset",
      email: opEmail,
      code: token,
      expiresAt: Date.now() + OPERATOR_CODE_TTL_MS,
      used: false,
      createdAt: Date.now(),
    });
    const baseUrl = process.env.CONVEX_SITE_URL || "";
    const appUrl = baseUrl.replace(/\/convex(\/?)$/, "");
    const resetLink = `${appUrl}/auth?guestReset=${token}`;
    await scheduleOperatorMail(ctx, {
      subject: "Guest passcode reset link",
      html: `<p>Click the link below to reset your guest passcode:</p><p><a href="${escapeHtml(resetLink)}">${escapeHtml(resetLink)}</a></p><p>This link expires in 15 minutes. If you did not request this, ignore this message.</p>`,
      code: token,
    });
    await scheduleWhatsAppMirror(
      ctx,
      "Guest passcode reset",
      `Reset your guest passcode here: ${resetLink}\nThis link expires in 15 minutes.`,
    );
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-reset",
      "[operator]",
      "Guest passcode reset link sent to operator default delivery",
    );
    return { ok: true, channel: "queued" };
  },
});

/**
 * Validate a guest passcode reset token. Marks the token used and
 * clears all active guest passcodes for the operator.
 */
export const validateGuestPasscodeReset = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const resetRow = rows
      .filter(
        (r) =>
          r.purpose === "guest-passcode-reset" &&
          !r.used &&
          r.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!resetRow || !ctEqual(resetRow.code, token.trim())) {
      throw new Error("Invalid or expired reset link.");
    }
    await ctx.db.patch(resetRow._id, { used: true, verifiedAt: Date.now() });
    for (const row of rows) {
      if (
        (row.purpose === "guest-passcode" || row.purpose === "guest") &&
        !row.used
      ) {
        await ctx.db.patch(row._id, { used: true });
      }
    }
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-reset-valid",
      "[operator]",
      "Guest passcode reset validated — all active guest codes invalidated",
    );
    return { ok: true };
  },
});

/**
 * Get guest passcode info for the operator console — masked by default.
 * Shows the current mode and the last generated (possibly active) passcode.
 */
export const getGuestPasscodeInfo = query({
  args: {},
  handler: async (ctx) => {
    const op = await ctx.db.query("operatorConfig").first();
    const mode = op?.guestPasscodeMode ?? "popup";
    // Query all operatorCodes directly — there is only one operator, so we
    // can find guest passcodes without decrypting the operator email.
    const rows = await ctx.db.query("operatorCodes").collect();
    const latest = rows
      .filter(
        (r) =>
          (r.purpose === "guest-passcode" || r.purpose === "guest") &&
          !r.used &&
          r.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      mode,
      maskedCode: latest ? maskPasscode(latest.code) : null,
      active: Boolean(latest),
      expiresAt: latest?.expiresAt ?? null,
    };
  },
});

/**
 * Change the guest passcode from the operator console. Generates a new
 * one-time code, stores it, and returns the plaintext for immediate use.
 */
export const changeGuestPasscode = mutation({
  args: { newCode: v.optional(v.string()) },
  handler: async (ctx, { newCode }) => {
    await requireOperator(ctx);
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code =
      newCode && newCode.trim().length >= 4
        ? newCode.trim()
        : generateNumericCode(6);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    for (const row of rows) {
      if (
        (row.purpose === "guest-passcode" || row.purpose === "guest") &&
        !row.used
      ) {
        await ctx.db.patch(row._id, { used: true });
      }
    }
    await ctx.db.insert("operatorCodes", {
      purpose: "guest-passcode",
      email: opEmail,
      code,
      expiresAt: Date.now() + 24 * HOUR_MS,
      used: false,
      createdAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "guest-passcode-change",
      "[operator]",
      "Guest passcode changed from operator console",
    );
    return { ok: true, code };
  },
});



// ---------------------------------------------------------------------------
// Sign-in Email OTP — always required before terminal access
// ---------------------------------------------------------------------------

/**
 * Send a sign-in EmailOTP to the subscriber/operator email.
 * Called after a successful password sign-in when the Convex auth provider
 * did NOT require email verification (already-verified account). Generates
 * a 6-digit numeric code, stores it in operatorCodes with purpose
 * "sign-in-otp", and sends it to the email.
 */
export const sendSignInOtp = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    await enforceRateLimit(ctx, {
      bucket: `sign-in-otp:${norm}`,
      limit: 5,
      windowMs: 10 * 60_000,
      message: "Too many OTP requests — wait a few minutes.",
    });
    const code = generateNumericCode(6);
    const now = Date.now();
    await ctx.db.insert("operatorCodes", {
      purpose: "sign-in-otp" as any,
      email: norm,
      code,
      expiresAt: now + 10 * 60_000,
      used: false,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, {
      to: norm,
      subject: "FlashBolt — your sign-in verification code",
      html: `<p>Your one-time verification code is:</p><h2 style="letter-spacing:2px">${code}</h2><p>This code expires in 10 minutes. If you did not request this, ignore this message.</p>`,
      code,
    });
    await audit(
      ctx,
      norm,
      "sign-in-otp-sent",
      norm,
      "Sign-in EmailOTP sent to subscriber/operator",
    );
    return { ok: true };
  },
});

/**
 * Verify a sign-in EmailOTP code. Checks the latest unused "sign-in-otp"
 * code for the given email, validates it, and marks it used.
 */
export const verifySignInOtp = mutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, { email, code }) => {
    const norm = email.trim().toLowerCase();
    await enforceRateLimit(ctx, {
      bucket: `sign-in-otp-verify:${norm}`,
      limit: 10,
      windowMs: 60_000,
      message: "Too many OTP attempts — try again in a minute.",
    });
    const rows = await ctx.db.query("operatorCodes").collect();
    const row = rows
      .filter(
        (r) =>
          (r.purpose as string) === "sign-in-otp" &&
          r.email === norm &&
          !r.used &&
          r.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!row) {
      throw new Error(
        'No valid verification code found — click "Sign in" again to receive a fresh code.',
      );
    }
    if (!ctEqual(row.code, code.trim())) {
      throw new Error("Invalid verification code.");
    }
    await ctx.db.patch(row._id, { used: true, verifiedAt: Date.now() });
    await audit(
      ctx,
      norm,
      "sign-in-otp-verify",
      norm,
      "Sign-in EmailOTP verified — terminal access granted",
    );
    return { ok: true };
  },
});

/**
 * Forgot Passcode - Step 1: Generate a one-time OTP and send it to
 * the operator default delivery methods (email + WhatsApp).
 */
export const sendForgotPasscodeOtp = mutation({
  args: {},
  handler: async (ctx) => {
    await enforceRateLimit(ctx, {
      bucket: "forgot-passcode-otp",
      limit: 3,
      windowMs: 10 * 60_000,
      message: "Too many passcode-reset OTP requests - wait a few minutes.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code = generateNumericCode(6);
    await ctx.db.insert("operatorCodes", {
      purpose: "forgot-passcode-otp",
      email: opEmail,
      code,
      expiresAt: Date.now() + 5 * 60_000,
      used: false,
      createdAt: Date.now(),
    });
    await scheduleOperatorMail(ctx, {
      subject: "Passcode reset verification code",
      html: `<p>Your operator passcode-reset verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;color:#f59e0b;">${escapeHtml(code)}</p><p>This code expires in 5 minutes. If you did not request this, ignore this message.</p>`,
      code,
    });
    await scheduleWhatsAppMirror(
      ctx,
      "Passcode reset verification",
      `Your passcode-reset verification code: ${code}\nThis code expires in 5 minutes.`,
    );
    await audit(
      ctx,
      "terminal operator",
      "forgot-passcode-otp",
      "[operator]",
      "Forgot-passcode OTP sent to operator default delivery",
    );
    return { ok: true, channel: "queued" };
  },
});

/**
 * Forgot Passcode - Step 2: Verify the OTP code.
 */
export const verifyForgotPasscodeOtp = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await enforceRateLimit(ctx, {
      bucket: "forgot-passcode-otp-verify",
      limit: 10,
      windowMs: 60_000,
      message: "Too many passcode-reset OTP attempts - try again in a minute.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const row = rows
      .filter(
        (r) =>
          r.purpose === "forgot-passcode-otp" && !r.used && r.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!row) {
      throw new Error(
        'No valid verification code found. Click "Forgot Passcode" again to receive a fresh one.',
      );
    }
    if (!ctEqual(row.code, code.trim())) {
      throw new Error("Invalid verification code.");
    }
    await ctx.db.patch(row._id, { used: true, verifiedAt: Date.now() });
    const sessionToken = generateNumericCode(8);
    await ctx.db.insert("operatorCodes", {
      purpose: "forgot-passcode-session",
      email: opEmail,
      code: sessionToken,
      expiresAt: Date.now() + 10 * 60_000,
      used: false,
      createdAt: Date.now(),
    });
    await audit(
      ctx,
      "terminal operator",
      "forgot-passcode-otp-verified",
      "[operator]",
      "Forgot-passcode OTP verified - passphrase reset authorized",
    );
    return { ok: true, sessionToken };
  },
});

/**
 * Forgot Passcode - Step 3: Reset the operator passphrase.
 * Requires: valid session token + new passphrase + guest passphrase confirmation.
 */
export const resetOperatorPassphrase = mutation({
  args: {
    sessionToken: v.string(),
    newPassphrase: v.string(),
    guestPassphrase: v.string(),
  },
  handler: async (ctx, { sessionToken, newPassphrase, guestPassphrase }) => {
    await enforceRateLimit(ctx, {
      bucket: "forgot-passcode-reset",
      limit: 5,
      windowMs: 10 * 60_000,
      message: "Too many passphrase-reset attempts - wait a few minutes.",
    });
    if (newPassphrase.length < 4) {
      throw new Error("New passphrase must be at least 4 characters.");
    }
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const sessionRow = rows
      .filter(
        (r) =>
          r.purpose === "forgot-passcode-session" &&
          !r.used &&
          r.expiresAt > Date.now(),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!sessionRow || !ctEqual(sessionRow.code, sessionToken.trim())) {
      throw new Error(
        "Invalid or expired session - start the passcode reset flow again.",
      );
    }
    const guestCipher = op.guestPassphraseCipher || op.passphraseCipher;
    if (!guestCipher) {
      throw new Error("Guest passphrase not configured in backend.");
    }
    const storedGuestPp = await decryptSecret(ctx, guestCipher);
    if (!ctEqual(guestPassphrase, storedGuestPp)) {
      throw new Error(
        "Invalid guest passphrase - the second default passphrase is required to confirm this change.",
      );
    }
    const newCipher = await encryptSecret(ctx, newPassphrase);
    await ctx.db.patch(op._id, {
      passphraseCipher: newCipher,
      passphraseUpdatedAt: Date.now(),
    });
    await ctx.db.patch(sessionRow._id, { used: true, verifiedAt: Date.now() });
    await audit(
      ctx,
      "terminal operator",
      "forgot-passphrase-reset",
      "[operator]",
      "Operator passphrase successfully reset via forgot-passcode flow",
    );
    return { ok: true };
  },
});


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Live transactional email is scheduled through the Node-runtime internal
// action internal.mailAction.sendMailAction (./mailAction). Resend and Brevo
// are optional channels activated only by their Keys-tab keys; without any
// key every email delivers through the keyless Freebuff OTP relay — no
// external API key is required for any email function to work.
