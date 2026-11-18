"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Node-runtime internal email action — optional external providers,
 * keyless relay fallback.
 *
 * The external "wire live email" task was removed from the app UI: no
 * frontend screen depends on Resend or Brevo anymore, and every email
 * function keeps working with NO external key. Both providers are kept here
 * OPTIONAL in the backend for later use — they activate automatically the
 * moment their keys exist in the Keys tab:
 *
 *   1. RESEND_API_KEY set  → Resend API (api.resend.com)
 *   2. BREVO_API_KEY set   → Brevo / Sendinblue API (api.brevo.com)
 *   3. otherwise           → Freebuff OTP relay (keyless, always works)
 *
 * Channel selection happens per send. A provider with no key configured is
 * simply skipped; a configured provider that fails reports its exact error
 * and the send is NOT silently re-routed (nothing is ever faked).
 *
 * Gate mutations cannot read secrets in this Convex version, so they schedule
 * this action with `ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, ...)`
 * right after their transaction commits, and the email is sent for real.
 *
 * Every actual outcome (channel, provider message id, or exact error) is
 * appended to the audit log via `internal.mail.recordMailResult` — nothing is
 * ever simulated.
 */

export interface MailResult {
  ok: boolean;
  channel: string;
  id?: string | null;
  needsKey?: boolean;
  description?: string;
}

/** Freebuff OTP relay — the app's keyless default email channel. */
const RELAY_URL = "https://auth.freebuff.app/send_otp";
const RELAY_API_KEY = "fb_email_2crN1hqIArZP2bEfvjp5Qik4";

/** Resend API (activated only when RESEND_API_KEY is set). The sender label
 *  is neutral — never the product brand (email-policy safe). */
const RESEND_URL = "https://api.resend.com/emails";
const RESEND_FALLBACK_FROM = "Terminal Alert <onboarding@resend.dev>";

/** Brevo / Sendinblue SMTP API (activated only when BREVO_API_KEY is set). */
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_FALLBACK_FROM = "noreply@example.com";

/** Neutral relay sender label — the brand name never appears as a label. */
const NEUTRAL_SENDER_LABEL = "Terminal Alert";

/** Only safe, plain sender labels are used on the relay (no line breaks etc.). */
const SAFE_LABEL_RE = /^[A-Za-z0-9 ._'-]{1,64}$/;

/**
 * The relay's sender label — for subscriber-originated messages this is the
 * subscriber's email address itself (validated, plain charset), so the
 * operator's inbox reflects the subscriber as the sender. Falls back to the
 * neutral label for everything else.
 */
function relaySenderLabel(fromName: string | undefined, fromEmail: string | undefined): string {
  if (fromEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) return fromEmail;
  if (fromName && SAFE_LABEL_RE.test(fromName)) return fromName;
  return NEUTRAL_SENDER_LABEL;
}

async function tryRelay(
  to: string,
  code: string | undefined,
  subject: string,
  html: string,
  senderLabel: string,
): Promise<{ ok: boolean; id?: string | null; error?: string }> {
  try {
    const res = await fetch(RELAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": RELAY_API_KEY,
      },
      body: JSON.stringify({
        to,
        otp: code ?? "",
        appName: senderLabel,
        subject,
        html,
      }),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
      return { ok: true, id: data.data?.id ?? null };
    }
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `Relay HTTP ${res.status}: ${detail || res.statusText}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Relay request failed" };
  }
}

/** Resend — used only when RESEND_API_KEY is configured. Attachments supported.
 *  The subscriber's identity becomes the visible sender name + reply-to. */
async function tryResend(
  to: string,
  subject: string,
  html: string,
  attachment: { filename: string; content: string; contentType: string } | undefined,
  fromName: string | undefined,
  fromEmail: string | undefined,
): Promise<{ ok: boolean; id?: string | null; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const fallback = process.env.RESEND_FROM?.trim() || RESEND_FALLBACK_FROM;
    const body: Record<string, unknown> = {
      from:
        fromName && SAFE_LABEL_RE.test(fromName)
          ? `${fromName} <${fallback.replace(/^.*<([^>]+)>.*$/, "$1")}>`
          : fallback,
      to: [to],
      subject,
      html,
    };
    if (fromEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      body.reply_to = [fromEmail];
    }
    if (attachment) {
      body.attachments = [{ filename: attachment.filename, content: attachment.content }];
    }
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, id: data.id ?? null };
    }
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `Resend HTTP ${res.status}: ${detail || res.statusText}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Resend request failed" };
  }
}

/** Brevo — used only when BREVO_API_KEY is configured. Attachments supported.
 *  The subscriber's identity becomes the visible sender name + reply-to. */
async function tryBrevo(
  to: string,
  subject: string,
  html: string,
  attachment: { filename: string; content: string; contentType: string } | undefined,
  fromName: string | undefined,
  fromEmail: string | undefined,
): Promise<{ ok: boolean; id?: string | null; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: "BREVO_API_KEY not configured" };
  try {
    const body: Record<string, unknown> = {
      sender: {
        name: fromName && SAFE_LABEL_RE.test(fromName) ? fromName : NEUTRAL_SENDER_LABEL,
        email: process.env.BREVO_FROM?.trim() || BREVO_FALLBACK_FROM,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };
    if (fromEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      body.replyTo = { email: fromEmail };
    }
    if (attachment) {
      body.attachment = [{ name: attachment.filename, content: attachment.content }];
    }
    const res = await fetch(BREVO_URL, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { ok: true, id: data.messageId ?? null };
    }
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `Brevo HTTP ${res.status}: ${detail || res.statusText}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Brevo request failed" };
  }
}

export const sendMailAction = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    html: v.string(),
    code: v.optional(v.string()),
    // optional file attachment (payment receipts etc.) — base64 content.
    // Carried through Resend/Brevo when one of them is active; the relay
    // channel delivers the alert without the file and the receipt stays
    // stored in the backend for confirm/reject.
    attachment: v.optional(
      v.object({ filename: v.string(), content: v.string(), contentType: v.string() }),
    ),
    // hide the recipient in the audit log (operator emails are confidential)
    redactRecipient: v.optional(v.boolean()),
    // the subscriber's identity for subscriber-originated messages — becomes
    // the visible sender label + reply-to (email-policy safe)
    fromName: v.optional(v.string()),
    fromEmail: v.optional(v.string()),
  },
  handler: async (ctx, { to, subject, html, code, attachment, redactRecipient, fromName, fromEmail }): Promise<MailResult> => {
    // Channel selection — first provider with a key wins, relay as the
    // always-available keyless default.
    const resendKey = process.env.RESEND_API_KEY;
    const brevoKey = process.env.BREVO_API_KEY;
    const senderLabel = relaySenderLabel(fromName, fromEmail);

    const result: MailResult = resendKey
      ? await (async () => {
          const sent = await tryResend(to, subject, html, attachment, fromName, fromEmail);
          return sent.ok
            ? { ok: true, channel: "resend", id: sent.id ?? null }
            : { ok: false, needsKey: false, channel: "resend", description: sent.error ?? "Resend send failed" };
        })()
      : brevoKey
        ? await (async () => {
            const sent = await tryBrevo(to, subject, html, attachment, fromName, fromEmail);
            return sent.ok
              ? { ok: true, channel: "brevo", id: sent.id ?? null }
              : { ok: false, needsKey: false, channel: "brevo", description: sent.error ?? "Brevo send failed" };
          })()
        : await (async () => {
            const relay = await tryRelay(to, code, subject, html, senderLabel);
            return relay.ok
              ? { ok: true, channel: "relay", id: relay.id ?? null }
              : { ok: false, needsKey: false, channel: "relay", description: relay.error ?? "Relay send failed" };
          })();

    // Record the REAL delivery outcome into the immutable audit log.
    await ctx
      .runMutation(internal.mail.recordMailResult, {
        to,
        subject,
        ok: result.ok,
        channel: result.channel,
        id: result.id ?? null,
        description: result.description ?? null,
        redactRecipient: redactRecipient ?? false,
      })
      .catch(() => {
        // The send already happened; a failed audit write must not fail the flow.
      });

    return result;
  },
});
