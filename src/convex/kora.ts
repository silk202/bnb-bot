// FlashBolt Trade — Kora Pay QUI-CHKOUT instant local-currency deposits.
//
// FLOW (mirrors Kora's official Checkout Redirect integration, and the
// Korapay-checkout screenshots the operator provided):
//   1. The user picks a bank-rail currency (NGN/GHS/KES/XAF) + amount in the
//      Deposit modal and taps "Pay with Kora".
//   2. A mutation inserts the intent (reference, pending) and schedules the
//      initialize action. Kora's /charges/initialize returns a hosted
//      `checkout_url`, which is patched onto the row.
//   3. The user is redirected to Kora's checkout. It generates a ONE-TIME
//      virtual bank account ("Korapay-QUI-CHKOUT" — e.g. Sterling Bank) that
//      accepts exactly ONE transfer of EXACTLY the shown amount and then
//      expires ("Do not save or reuse this account number").
//   4. When the transfer lands, Kora POSTs charge.success to
//      /api/kora/webhook. The HMAC-SHA256 signature over the raw `data`
//      object is verified against KORA_SECRET_KEY before anything else. A
//      verified success credits the user's cash ledger EXACTLY ONCE and
//      completes the pending tradeTx — no manual claim, no operator step.
//   5. On redirect back (and on demand), the client re-syncs the reference
//      against Kora's verify endpoint as a fallback if the webhook hasn't
//      landed yet.
//
// ARCHITECTURE NOTE
//   Convex actions can't write the DB and don't propagate auth into
//   runQuery/runMutation — so the user identity is resolved in the public
//   mutation and passed FORWARD as plain args to the scheduled action (the
//   same pattern the copier/terminal scheduled jobs use).
//
// SECURITY
//   • KORA_SECRET_KEY lives only in the Convex env (Keys UI) — never shipped.
//   • The webhook verifies HMAC-SHA256(rawDataJson, secret) against the
//     x-korapay-signature header before crediting anything.
//   • Ledger credit is idempotent (credited flag, checked per mutation).
//   • Amount mismatches are recorded as failed, never credited.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { isOperatorEmail } from "./operatorEmails";
import { KORA_CURRENCIES } from "./tradeAssets";

const KORA_BASE = "https://api.korapay.com/merchant/api/v1";

/** QUI-CHKOUT one-time accounts are single-transfer + short-lived; sweep pending intents after 1h. */
const EXPIRY_MS = 60 * 60 * 1000;

/** Generate a unique merchant reference (matches the existing FB- style). */
function newKoraRef(): string {
  return (
    "FB-KORA-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

/** Session resolver usable from queries AND mutations (reader-scoped). */
async function requireUser(ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] }): Promise<Id<"users">> {
  const user = await getCurrentUser(ctx as QueryCtx);
  if (!user) throw new Error("Sign in to use the Trade terminal.");
  return user._id;
}

// ── Public: start a Kora checkout (deterministic; network is scheduled) ────

export const createCheckoutIntent = mutation({
  args: { asset: v.string(), amount: v.number() },
  handler: async (ctx, { asset, amount }) => {
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
    if (amount > 100_000_000) throw new Error("Amount is too large.");
    if (!(KORA_CURRENCIES as readonly string[]).includes(asset)) {
      throw new Error(`${asset} is not a Kora-supported bank-rail currency (${KORA_CURRENCIES.join(", ")}).`);
    }
    const userId = await requireUser(ctx);
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email ?? `${userId}@flashbolt.local`;

    const reference = newKoraRef();
    await ctx.db.insert("tradeKoraDeposits", {
      userId,
      reference,
      asset,
      amount,
      status: "pending",
      checkoutUrl: "",
      credited: false,
      ts: Date.now(),
    });
    // Pending ledger row — completed by the credit path, failed on expiry.
    await ctx.db.insert("tradeTx", {
      userId,
      kind: "cash",
      direction: "deposit",
      asset,
      amount,
      status: "pending",
      ts: Date.now(),
      ref: reference,
      note: `Kora instant deposit (QUI-CHKOUT) — ${reference}`,
      meta: JSON.stringify({ kora: true, reference }),
    });

    await ctx.scheduler.runAfter(0, internal.kora.initializeCharge, {
      reference,
      asset,
      amount,
      email,
      appOrigin: process.env.CONVEX_SITE_URL ?? "",
    });
    return { reference };
  },
});

// ── Internal: call Kora's initialize endpoint (network) ────────────────────

export const initializeCharge = internalAction({
  args: {
    reference: v.string(),
    asset: v.string(),
    amount: v.number(),
    email: v.string(),
    appOrigin: v.string(),
  },
  handler: async (ctx, { reference, asset, amount, email, appOrigin }) => {
    const secret = process.env.KORA_SECRET_KEY;
    if (!secret) {
      await ctx.runMutation(internal.kora.applyKoraResult, {
        reference,
        koraStatus: "config-error",
        reason: "KORA_SECRET_KEY is not configured in Keys — instant deposits are unavailable.",
      });
      return;
    }
    const origin = appOrigin.replace(/\/$/, "");
    // Webhook base: the Convex HTTP origin (same base the Telegram webhook
    // registration uses). Redirect base: the APP's public URL (SITE_URL) —
    // Kora must send the user back to /trade-terminal in the app, not to an
    // API domain. Convex HTTP actions are served on the .convex.site domain.
    const deployment = process.env.CONVEX_DEPLOYMENT ?? "";
    const siteOrigin = deployment && !deployment.includes("/") ? `https://${deployment}.convex.site` : origin;
    const callbackUrl = siteOrigin.startsWith("http") ? siteOrigin : origin;
    const appBase = (process.env.SITE_URL || origin).replace(/\/$/, "");

    try {
      const res = await fetch(`${KORA_BASE}/charges/initialize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount,
          currency: asset,
          reference,
          // Kora appends its own ?reference=… to this URL on return — keep it
          // clean so the query string stays parseable.
          redirect_url: `${appBase}/trade-terminal`,
          notification_url: `${callbackUrl}/api/kora/webhook`,
          channels: ["bank_transfer"],
          default_channel: "bank_transfer",
          merchant_bears_cost: false,
          customer: { email },
        }),
      });
      const data = (await res.json()) as {
        status?: boolean;
        message?: string;
        data?: { reference?: string; checkout_url?: string };
      };
      if (!res.ok || !data.status || !data.data?.checkout_url) {
        await ctx.runMutation(internal.kora.applyKoraResult, {
          reference,
          koraStatus: "initialize-failed",
          reason: data.message ?? `Kora initialize failed (HTTP ${res.status})`,
        });
        return;
      }
      await ctx.runMutation(internal.kora.patchCheckoutUrl, {
        reference,
        checkoutUrl: data.data.checkout_url,
      });
    } catch (err) {
      await ctx.runMutation(internal.kora.applyKoraResult, {
        reference,
        koraStatus: "initialize-failed",
        reason: err instanceof Error ? err.message : "Kora initialize request failed",
      });
    }
  },
});

// ── Internal DB transitions ────────────────────────────────────────────────

export const patchCheckoutUrl = internalMutation({
  args: { reference: v.string(), checkoutUrl: v.string() },
  handler: async (ctx, { reference, checkoutUrl }) => {
    const row = await byReference(ctx, reference);
    if (row) await ctx.db.patch(row._id, { checkoutUrl });
  },
});

/**
 * The ONE settlement path for every Kora outcome (webhook + sync + errors).
 * koraStatus "success" credits the ledger exactly once; "failed"/"reversed"/
 * "initialize-failed"/"config-error" fail the pending tx; anything else is
 * recorded as the last-seen status without settling.
 */
export const applyKoraResult = internalMutation({
  args: {
    reference: v.string(),
    koraStatus: v.string(),
    amount: v.optional(v.number()),
    fee: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { reference, koraStatus, amount, fee, reason }) => {
    const row = await byReference(ctx, reference);
    if (!row) return { ok: false };

    if (koraStatus === "success") {
      if (row.credited) return { ok: true, already: true };
      // The checkout enforces the exact amount; still sanity-check the
      // confirmed figure against the intent before giving value.
      if (amount !== undefined && Math.abs(amount - row.amount) > Math.max(0.02, row.amount * 0.001)) {
        await ctx.db.patch(row._id, {
          status: "failed",
          failureReason: `amount mismatch: expected ${row.amount}, Kora confirmed ${amount}`,
          settledAt: Date.now(),
        });
        await failPendingKoraTx(ctx, row.userId, reference, "amount mismatch");
        return { ok: false };
      }
      await creditCash(ctx, row.userId, row.asset, row.amount);
      await ctx.db.patch(row._id, {
        status: "success",
        credited: true,
        koraStatus: "success",
        ...(fee !== undefined ? { koraFee: fee } : {}),
        settledAt: Date.now(),
      });
      await completePendingKoraTx(ctx, row.userId, reference);
      return { ok: true };
    }

    if (row.credited) return { ok: true };
    if (koraStatus === "failed" || koraStatus === "reversed" || koraStatus === "initialize-failed" || koraStatus === "config-error") {
      await ctx.db.patch(row._id, {
        status: "failed",
        koraStatus,
        failureReason: reason ?? `Kora reported ${koraStatus}`,
        settledAt: Date.now(),
      });
      await failPendingKoraTx(ctx, row.userId, reference, reason ?? koraStatus);
      return { ok: true };
    }

    // Non-final status (pending/processing/…) — remember it, stay pending.
    await ctx.db.patch(row._id, { koraStatus });
    return { ok: true };
  },
});

/** One-time virtual accounts expire — stamp stale pending intents. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - EXPIRY_MS;
    const stale = await ctx.db
      .query("tradeKoraDeposits")
      .withIndex("by_reference", (q) => q.gt("reference", ""))
      .collect();
    let n = 0;
    for (const row of stale) {
      if (row.status === "pending" && row.ts < cutoff) {
        await ctx.db.patch(row._id, { status: "expired", settledAt: Date.now() });
        await failPendingKoraTx(ctx, row.userId, row.reference, "checkout expired");
        n += 1;
      }
    }
    return { expired: n };
  },
});

// ── Webhook signature verification ─────────────────────────────────────────

/**
 * HMAC-SHA256 over the RAW `data` JSON (exactly as Kora serialized it),
 * compared against the x-korapay-signature header. Runs as a query so the
 * httpAction can await the verdict before trusting anything.
 */
export const verifyWebhookSignature = internalQuery({
  args: { raw: v.string(), signature: v.string() },
  handler: async (_ctx, { raw, signature }) => {
    const secret = process.env.KORA_SECRET_KEY;
    if (!secret || !signature) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
    const expected = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  },
});

// ── Sync fallback: verify a reference against Kora on demand ───────────────

/** Re-check one reference with Kora (used on redirect-back and by the UI button). */
export const syncReference = action({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    const secret = process.env.KORA_SECRET_KEY;
    if (!secret) throw new Error("KORA_SECRET_KEY is not configured in Keys.");
    const row = await ctx.runQuery(internal.kora.getByReference, { reference });
    if (!row) throw new Error("Unknown deposit reference.");

    const res = await fetch(`${KORA_BASE}/charges/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: { status?: string; amount?: number; fee?: number };
    };
    if (!res.ok || !data.status || !data.data) {
      throw new Error(data.message ?? `Kora verify failed (HTTP ${res.status})`);
    }
    const st = data.data.status ?? "pending";
    await ctx.runMutation(internal.kora.applyKoraResult, {
      reference,
      koraStatus: st,
      amount: data.data.amount,
      fee: data.data.fee,
      reason: st === "failed" ? "Kora reported the charge failed" : undefined,
    });
    return { status: st };
  },
});

export const getByReference = internalQuery({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    const row = await byReference(ctx, reference);
    if (!row) return null;
    return { asset: row.asset, amount: row.amount, status: row.status, credited: row.credited };
  },
});

// ── User-facing queries ────────────────────────────────────────────────────

/** My Kora instant-deposit history (newest first, for the deposit modal). */
export const listMyKoraDeposits = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("tradeKoraDeposits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20)
      .map((r) => ({
        _id: r._id,
        reference: r.reference,
        asset: r.asset,
        amount: r.amount,
        status: r.status,
        checkoutUrl: r.checkoutUrl,
        failureReason: r.failureReason,
        ts: r.ts,
      }));
  },
});

/** Whether the instant rail is configured + which currencies it covers. */
export const koraAvailable = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return { currencies: KORA_CURRENCIES, configured: Boolean(process.env.KORA_SECRET_KEY) };
  },
});

// ── Operator console ───────────────────────────────────────────────────────

/** Recent Kora auto-deposits for the Operator Console (newest first). */
export const listKoraDepositsAdmin = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase() ?? "";
    if (!email || !(await isOperatorEmail(ctx, email))) return [];
    const rows = await ctx.db.query("tradeKoraDeposits").collect();
    return rows
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 60)
      .map((r) => ({
        _id: r._id,
        reference: r.reference,
        asset: r.asset,
        amount: r.amount,
        status: r.status,
        credited: r.credited,
        koraFee: r.koraFee,
        failureReason: r.failureReason,
        ts: r.ts,
        settledAt: r.settledAt,
      }));
  },
});

// ── Shared helpers (writer-scoped; full ctx satisfies them structurally) ───

async function byReference(ctx: { db: QueryCtx["db"] }, reference: string) {
  return ctx.db
    .query("tradeKoraDeposits")
    .withIndex("by_reference", (q) => q.eq("reference", reference))
    .first();
}

/** Cash-ledger credit (mirrors trade.ts's private credit helper). */
async function creditCash(ctx: MutationCtx, userId: Id<"users">, asset: string, amount: number) {
  if (!(amount > 0)) return;
  const row = await ctx.db
    .query("tradeBalances")
    .withIndex("by_user_asset", (q) => q.eq("userId", userId).eq("kind", "cash").eq("asset", asset))
    .first();
  if (row) {
    await ctx.db.patch(row._id, { available: row.available + amount, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("tradeBalances", {
      userId,
      kind: "cash",
      asset,
      available: amount,
      locked: 0,
      updatedAt: Date.now(),
    });
  }
}

/** Complete the matching pending kora tx when the credit lands. */
async function completePendingKoraTx(ctx: MutationCtx, userId: Id<"users">, reference: string) {
  const rows = await ctx.db
    .query("tradeTx")
    .withIndex("by_user_ts", (q) => q.eq("userId", userId))
    .order("desc")
    .take(50);
  for (const tx of rows) {
    if (tx.status === "pending" && tx.direction === "deposit" && tx.ref === reference) {
      await ctx.db.patch(tx._id, { status: "completed", note: (tx.note ?? "") + " — confirmed by Kora, credited automatically" });
      break;
    }
  }
}

async function failPendingKoraTx(ctx: MutationCtx, userId: Id<"users">, reference: string, reason: string) {
  const rows = await ctx.db
    .query("tradeTx")
    .withIndex("by_user_ts", (q) => q.eq("userId", userId))
    .order("desc")
    .take(50);
  for (const tx of rows) {
    if (tx.status === "pending" && tx.direction === "deposit" && tx.ref === reference) {
      await ctx.db.patch(tx._id, { status: "failed", note: (tx.note ?? "") + ` — ${reason}` });
      break;
    }
  }
}
