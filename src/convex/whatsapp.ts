import { v } from "convex/values";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { api, internal } from "./_generated/api";
import {
  action,
  internalAction,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { decryptSecret, encryptSecret } from "./encryption";
import { isOperatorEmail, requireOperator } from "./operatorEmails";
import { scheduleOperatorMail } from "./operatorDefaults";
import { enforceRateLimit } from "./rateLimit";

/**
 * WhatsApp integration — two real, distinct capabilities:
 *
 * 1. COMMUNITY CHANNEL (broadcast, read-only for members) — the official
 *    FlashBolt WhatsApp channel links. The URLs are stored server-side in the
 *    `whatsappConfig` table (single row, key "default") and served to the
 *    WhatsApp button on every page — never hardcoded in the frontend. `url`
 *    is the primary channel link; `fallbackUrl` is the alternative link
 *    (web.whatsapp.com variant) the backend considers when the primary link
 *    fails a real reachability check (resolveWhatsAppChannel). Only the
 *    terminal operator can change either value.
 *
 * 2. OPERATOR INBOX (receiving messages from subscribers) — the operator's
 *    WhatsApp number (`supportNumber`, E.164) is stored in the same row and
 *    served to the subscriber-facing "Message the operator on WhatsApp"
 *    button, which opens a REAL wa.me click-to-chat thread with the operator.
 *    This is the second default channel (besides email) where subscribers can
 *    send pass codes, activation passwords and any other information. The
 *    button only appears once the operator sets their number in the console —
 *    nothing is ever simulated.
 *
 *    Optionally, when the operator wires the WhatsApp Business Cloud API keys
 *    in the Keys tab, `sendOperatorWhatsApp` also mirrors important operator
 *    notifications (subscriber form submissions with pass codes / receipts /
 *    activation-password requests) straight to that number over HTTPS. It is
 *    fully env-gated and reports its real status honestly — with no keys
 *    configured it returns { enabled: false } and nothing is faked.
 *
 * 3. ENCRYPTED CHAT LINK (second default inbox) — the operator's WhatsApp
 *    chat link (wa.me/message/…) is stored AES-256-GCM encrypted in the same
 *    row (chatLinkCipher) and seeded with the operator's default chat link on
 *    first run. It is the second default destination (besides email) for
 *    subscriber information: full name, location, subject line, message,
 *    payment-receipt files, generated unique pass codes and desktop
 *    activation passwords (mirrored through sendOperatorWhatsApp). The
 *    plaintext is NEVER returned by a query — the operator console reveals it
 *    for a short window after a one-time emailed code is verified
 *    (request / verify / saveWhatsAppChatLink), so it is only visible or
 *    editable for a short time with a code.
 */

export const DEFAULT_WHATSAPP_CHANNEL_URL =
  "https://whatsapp.com/channel/0029VakUeVUChq6J9golbj0p";

export const DEFAULT_WHATSAPP_FALLBACK_URL =
  "https://web.whatsapp.com/channel/0029VakUeVUChq6J9golbj0p";

/**
 * The operator's WhatsApp chat link — the second default destination (besides
 * email) for subscriber information: full name, location, subject line,
 * message, payment-receipt files, generated unique pass codes and desktop
 * activation passwords. Seeded encrypted into the backend on first run;
 * editable ONLY by the terminal operator inside a short code-verified window.
 */
export const DEFAULT_WHATSAPP_CHAT_LINK =
  "https://wa.me/message/SHFD4QSYGLOLB1be";

const CONFIG_KEY = "default";

// Only genuine WhatsApp business chat links are accepted (wa.me/message/<id>).
const CHAT_LINK_RE = /^https:\/\/wa\.me\/message\/[A-Za-z0-9_-]+$/;

// Code-gated visible / edit windows for the encrypted chat link (mirrors the
// operator-credential reveal/change pattern): the code expires after 15
// minutes, the "visible" window lasts 60 seconds and the "edit + save"
// window lasts 5 minutes after the code is verified.
const WA_CODE_TTL_MS = 15 * 60_000;
const WA_REVEAL_WINDOW_MS = 60 * 1000;
const WA_EDIT_WINDOW_MS = 5 * 60_000;

function generateNumericCode(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join("");
}

/** Constant-time string comparison (codes are compared without early exit). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read-only db handle — satisfies both query and mutation contexts. */
type DbReader = { db: QueryCtx["db"] };

/** Decrypt the stored operator email (encrypted rows, then legacy plaintext). */
async function getOperatorEmail(
  ctx: DbReader,
  op: { email?: string; emailCipher?: string },
): Promise<string> {
  if (op.emailCipher) return decryptSecret(ctx, op.emailCipher);
  if (op.email) return op.email;
  throw new Error("Operator email is not configured.");
}

/** Append an immutable audit entry. */
async function audit(
  ctx: Pick<MutationCtx, "db">,
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

/** Normalize an E.164-style WhatsApp number (digits, optional leading +). */
export function sanitizeSupportNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,15}$/.test(digits)) return "";
  return digits;
}

async function fetchRow(ctx: Pick<QueryCtx | MutationCtx, "db">) {
  return await ctx.db
    .query("whatsappConfig")
    .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
    .first();
}

/** Every page's WhatsApp button reads the channel links from here. Public —
 *  the channel links are public community URLs (same as the stored defaults)
 *  and the support number is the operator's public contact line. The chat
 *  link is encrypted: only a masked preview is returned here — the plaintext
 *  is revealed exclusively inside the operator console after a one-time
 *  emailed code is verified (short visible window). */
export const getWhatsAppChannel = query({
  args: {},
  handler: async (ctx) => {
    const row = await fetchRow(ctx);
    return {
      url: row?.url?.trim() ? row.url.trim() : DEFAULT_WHATSAPP_CHANNEL_URL,
      fallbackUrl: row?.fallbackUrl?.trim()
        ? row.fallbackUrl.trim()
        : DEFAULT_WHATSAPP_FALLBACK_URL,
      supportNumber: row?.supportNumber ? sanitizeSupportNumber(row.supportNumber) : "",
      // Encrypted chat link — presence + masked preview only, never plaintext.
      hasChatLink: Boolean(row?.chatLinkCipher),
      chatLinkMasked: row?.chatLinkCipher
        ? "https://wa.me/message/••••••••"
        : "",
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

/**
 * Idempotent seed — writes the canonical channel links into the backend if no
 * row exists yet, and backfills the fallback link on an existing row that
 * predates it. Harmless to call from anywhere (it only ever stores the fixed
 * defaults, never arbitrary values); the operator's set mutation is the only
 * path that can store different links.
 */
export const ensureWhatsAppChannel = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await fetchRow(ctx);
    if (!row) {
      await ctx.db.insert("whatsappConfig", {
        key: CONFIG_KEY,
        url: DEFAULT_WHATSAPP_CHANNEL_URL,
        fallbackUrl: DEFAULT_WHATSAPP_FALLBACK_URL,
        chatLinkCipher: await encryptSecret(ctx, DEFAULT_WHATSAPP_CHAT_LINK),
        updatedAt: Date.now(),
      });
    } else {
      const patch: Record<string, unknown> = {};
      if (!row.fallbackUrl?.trim()) {
        patch.fallbackUrl = DEFAULT_WHATSAPP_FALLBACK_URL;
      }
      if (!row.chatLinkCipher) {
        patch.chatLinkCipher = await encryptSecret(ctx, DEFAULT_WHATSAPP_CHAT_LINK);
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = Date.now();
        await ctx.db.patch(row._id, patch);
      }
    }
    return { ok: true };
  },
});

/**
 * Real backend reachability check — when the primary channel link fails
 * (HTTP 404/410: the channel link is dead), the backend considers the
 * alternative web.whatsapp.com link and returns it. A 200-299 response means
 * the link works; transport errors / 403 / 5xx are treated as "cannot
 * verify" and never flip the link (a bot-blocked probe must not swap a
 * working channel for a worse one). Nothing here is simulated — the check is
 * a real HTTPS request to the actual channel URLs.
 */
export const resolveWhatsAppChannel = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const { url, fallbackUrl } = await ctx.runQuery(
      api.whatsapp.getWhatsAppChannel,
    );

    const probe = async (target: string): Promise<"ok" | "gone" | "unknown"> => {
      try {
        const res = await fetchWithTimeout(target, 8000, {
          method: "GET",
          redirect: "follow",
        });
        if (res.status >= 200 && res.status < 300) return "ok";
        if (res.status === 404 || res.status === 410) return "gone";
        return "unknown";
      } catch {
        return "unknown";
      }
    };

    const primary = await probe(url);
    if (primary === "ok") return { url };
    if (fallbackUrl) {
      const fallback = await probe(fallbackUrl);
      if (primary === "gone") {
        // The primary is verifiably dead — the alternative is the better bet
        // even when it cannot itself be verified right now.
        if (fallback !== "gone") return { url: fallbackUrl };
      } else {
        // Primary cannot be verified (network/403/5xx/blocked probe) — prefer
        // the alternative when it verifiably works instead of handing users a
        // link we could not confirm.
        if (fallback === "ok") return { url: fallbackUrl };
      }
    }
    // Both are gone, or neither can be verified — keep the configured primary
    // rather than inventing anything.
    return { url };
  },
});

/**
 * Operator-gated console mutation — change the channel links and/or the
 * operator's WhatsApp support number (the inbox subscribers message). The
 * number is validated as E.164 (digits, optional leading +, 7-15 digits);
 * an empty value clears it (button disappears everywhere — honest).
 */
export const setWhatsAppChannel = mutation({
  args: {
    url: v.string(),
    fallbackUrl: v.optional(v.string()),
    supportNumber: v.optional(v.string()),
  },
  handler: async (ctx, { url, fallbackUrl, supportNumber }) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || !(await isOperatorEmail(ctx, email))) {
      throw new Error("Only the terminal operator can change the WhatsApp settings.");
    }
    const trimmedUrl = url.trim();
    const trimmedFallback = fallbackUrl?.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error("The channel link must be a valid http(s) URL.");
    }
    if (trimmedFallback && !/^https?:\/\//i.test(trimmedFallback)) {
      throw new Error("The fallback link must be a valid http(s) URL.");
    }
    const cleanNumber = sanitizeSupportNumber(supportNumber ?? "");
    if (supportNumber?.trim() && !cleanNumber) {
      throw new Error(
        "The WhatsApp number must be in E.164 format (e.g. +15551234567).",
      );
    }
    const row = await fetchRow(ctx);
    const doc = {
      url: trimmedUrl,
      fallbackUrl: trimmedFallback || DEFAULT_WHATSAPP_FALLBACK_URL,
      supportNumber: cleanNumber,
      updatedAt: Date.now(),
    };
    if (row) {
      await ctx.db.patch(row._id, doc);
    } else {
      await ctx.db.insert("whatsappConfig", { key: CONFIG_KEY, ...doc });
    }
    return { ok: true, url: trimmedUrl, fallbackUrl: doc.fallbackUrl, supportNumber: cleanNumber };
  },
});

// ---------------------------------------------------------------------------
// Encrypted WhatsApp chat link — the operator's second default inbox (besides
// email) for subscriber information + pass codes + activation passwords.
// The link is stored AES-256-GCM encrypted and can only be VIEWED for a short
// window or EDITED + SAVED inside a short window after a one-time code,
// emailed to the operator's default address, is verified server-side.
// ---------------------------------------------------------------------------

/**
 * "Visible" / "Edit" buttons — email a one-time code to the operator's
 * default address (operatorConfig) so the encrypted chat link can be revealed
 * (short visible window) or edited + saved (short editable window).
 */
export const requestWhatsAppChatLinkCode = mutation({
  args: {
    purpose: v.union(v.literal("reveal"), v.literal("edit")),
  },
  handler: async (ctx, { purpose }) => {
    await enforceRateLimit(ctx, {
      bucket: `operator-whatsapp-${purpose}`,
      limit: 3,
      windowMs: 15 * 60_000,
      message: "Too many code requests — wait 15 minutes before requesting another.",
    });
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const code = generateNumericCode(6);
    await ctx.db.insert("operatorCodes", {
      purpose: `whatsapp-${purpose}`,
      email: opEmail,
      code,
      expiresAt: Date.now() + WA_CODE_TTL_MS,
      used: false,
      createdAt: Date.now(),
    });
    await scheduleOperatorMail(ctx, {
      subject: `One-time code — WhatsApp chat link ${purpose === "reveal" ? "(view)" : "(edit + save)"}`,
      html: `<p>You asked to ${purpose === "reveal" ? "view (visible)" : "edit + save"} the encrypted WhatsApp chat link.</p><p>Your one-time code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>It expires in 15 minutes. The link stays ${purpose === "reveal" ? "visible for 60 seconds" : "editable for 5 minutes"} after you verify it.</p>`,
      code,
    });
    await scheduleWhatsAppMirror(
      ctx,
      `One-time code — WhatsApp chat link ${purpose}`,
      `Your one-time code is: ${code}\nExpires in 15 minutes.`,
    );
    await audit(
      ctx,
      "terminal operator",
      `request-whatsapp-${purpose}-code`,
      "[operator]",
      `One-time code dispatched to ALL operator default inboxes + WhatsApp for WhatsApp chat link ${purpose}`,
    );
    return { ok: true, expiresInMinutes: 15, channel: "queued", emailDelivered: true };
  },
});

/**
 * Verify the emailed one-time code for the encrypted WhatsApp chat link.
 * - reveal: returns the decrypted plaintext link with a short "visible but
 *   unchangeable" window (revealExpiresAt); after it lapses it is hidden.
 * - edit: unlocks a short editable window (editExpiresAt) so the link can be
 *   replaced via saveWhatsAppChatLink.
 */
export const verifyWhatsAppChatLinkCode = mutation({
  args: {
    purpose: v.union(v.literal("reveal"), v.literal("edit")),
    code: v.string(),
  },
  handler: async (ctx, { purpose, code }) => {
    await enforceRateLimit(ctx, {
      bucket: `operator-whatsapp-verify`,
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
      .filter((r) => r.purpose === `whatsapp-${purpose}` && !r.used)
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
      `verify-whatsapp-${purpose}-code`,
      "[operator]",
      `Operator verified the one-time code for WhatsApp chat link ${purpose}`,
    );
    const config = await fetchRow(ctx);
    const link = config?.chatLinkCipher
      ? await decryptSecret(ctx, config.chatLinkCipher)
      : "";
    if (purpose === "reveal") {
      return {
        ok: true,
        link,
        revealExpiresAt: Date.now() + WA_REVEAL_WINDOW_MS,
      };
    }
    return { ok: true, link, editExpiresAt: Date.now() + WA_EDIT_WINDOW_MS };
  },
});

/**
 * "Save" — replace the encrypted chat link. Only the terminal operator can
 * call it, and only inside the short editable window unlocked by a verified
 * one-time code (verifiedAt must be recent). An empty value clears the link.
 */
export const saveWhatsAppChatLink = mutation({
  args: { link: v.string() },
  handler: async (ctx, { link }) => {
    await requireOperator(ctx);
    const trimmed = link.trim();
    if (trimmed && !CHAT_LINK_RE.test(trimmed)) {
      throw new Error(
        "The chat link must be a wa.me/message link, e.g. https://wa.me/message/ABC123.",
      );
    }
    const op = await ctx.db.query("operatorConfig").first();
    if (!op) throw new Error("Operator profile is not seeded.");
    const opEmail = await getOperatorEmail(ctx, op);
    const rows = await ctx.db
      .query("operatorCodes")
      .withIndex("by_email", (q) => q.eq("email", opEmail))
      .collect();
    const recent = rows
      .filter((r) => r.purpose === "whatsapp-edit" && r.used)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!recent || (recent.verifiedAt ?? 0) < Date.now() - WA_EDIT_WINDOW_MS) {
      throw new Error(
        "The edit session has expired — request a new one-time code, verify it, then save.",
      );
    }
    const row = await fetchRow(ctx);
    const patch = {
      chatLinkCipher: trimmed ? await encryptSecret(ctx, trimmed) : undefined,
      updatedAt: Date.now(),
    };
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("whatsappConfig", {
        key: CONFIG_KEY,
        url: DEFAULT_WHATSAPP_CHANNEL_URL,
        fallbackUrl: DEFAULT_WHATSAPP_FALLBACK_URL,
        ...patch,
      });
    }
    await audit(
      ctx,
      "terminal operator",
      "whatsapp-chat-link-save",
      "[operator]",
      trimmed
        ? "WhatsApp chat link re-encrypted and saved inside the verified edit window"
        : "WhatsApp chat link cleared inside the verified edit window",
    );
    return { ok: true, hasChatLink: Boolean(trimmed) };
  },
});

/**
 * Optional WhatsApp Business Cloud API send — mirrors operator notifications
 * (subscriber form submissions carrying pass codes / payment receipts /
 * activation-password requests) to the operator's WhatsApp number as a
 * second default inbox beside email.
 *
 * Keys (paste into the Keys tab — the app never touches .env):
 *   WHATSAPP_TOKEN      → Meta Graph API access token
 *   WHATSAPP_PHONE_ID   → the business phone number ID that sends the message
 *   WHATSAPP_TO         → optional override recipient (defaults to the stored
 *                         supportNumber in whatsappConfig)
 *
 * Honest status, never faked: without keys (or without a configured
 * recipient) it returns { enabled: false } and the caller simply skips the
 * channel — exactly like the Telegram sender. Meta policy note: the Cloud API
 * delivers free-form text only inside a 24-hour customer-service window; for
 * business-initiated messages an approved template is required, and the exact
 * API error is returned as `description`.
 */
export const sendOperatorWhatsApp = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, { title, body }): Promise<{
    enabled: boolean;
    ok: boolean;
    description: string;
  }> => {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      return {
        enabled: false,
        ok: false,
        description: "WHATSAPP_TOKEN / WHATSAPP_PHONE_ID not configured in Keys",
      };
    }
    let to = process.env.WHATSAPP_TO?.trim() ?? "";
    if (!to) {
      try {
        const cfg = await ctx.runQuery(api.whatsapp.getWhatsAppChannel);
        to = cfg.supportNumber ?? "";
      } catch {
        to = "";
      }
    }
    if (!to) {
      return {
        enabled: true,
        ok: false,
        description:
          "No WhatsApp recipient — set WHATSAPP_TO or the operator support number in the console",
      };
    }
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: `*${title}*\n\n${body}`.slice(0, 4096), preview_url: false },
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
        messages?: unknown[];
      };
      if (res.ok && data.messages?.length) {
        return { enabled: true, ok: true, description: "sent" };
      }
      return {
        enabled: true,
        ok: false,
        description: data.error?.message
          ? `WhatsApp API ${data.error.code ?? "error"}: ${data.error.message}`
          : `WhatsApp API HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        enabled: true,
        ok: false,
        description: error instanceof Error ? error.message : "WhatsApp send failed",
      };
    }
  },
});

/**
 * Schedule the WhatsApp mirror from a V8 mutation — best-effort by design:
 * a missing key or a failed send must never break the caller (the email
 * channel already went out). Honors the operator's delivery preference:
 * when the operator selected "primary" or "secondary" (email-only
 * channels), the WhatsApp mirror is skipped; "all" (default) and
 * "whatsapp" deliver it.
 */
export async function scheduleWhatsAppMirror(
  ctx: Pick<MutationCtx, "scheduler" | "db">,
  title: string,
  body: string,
) {
  try {
    const op = await ctx.db.query("operatorConfig").first();
    const pref = op?.deliveryPref ?? "all";
    if (pref === "primary" || pref === "secondary") return; // email-only channels selected
    await ctx.scheduler.runAfter(0, internal.whatsapp.sendOperatorWhatsApp, {
      title,
      body,
    });
  } catch {
    // Best-effort second channel — never throw into the caller.
  }
}
