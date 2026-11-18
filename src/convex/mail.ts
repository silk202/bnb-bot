import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Live email delivery.
 *
 * The send itself runs in the Node-runtime internal action
 * `internal.mailAction.sendMailAction` (see ./mailAction). Resend and Brevo
 * are OPTIONAL backend channels: they activate only when RESEND_API_KEY /
 * BREVO_API_KEY exist in the Keys tab. With no key configured every app
 * email delivers through the Freebuff OTP relay, which needs no external
 * API key, so the channel can never break on a missing/misconfigured key.
 * V8 gate mutations schedule it with
 * `ctx.scheduler.runAfter(0, internal.mailAction.sendMailAction, ...)`
 * right after their transaction commits.
 *
 * `recordMailResult` is the internal mutation the action calls after each
 * send to append the REAL delivery outcome — channel (relay/resend/brevo),
 * the provider message id, or the exact error — to the immutable audit log,
 * so the operator console shows exactly how every email went out. Nothing
 * is ever simulated.
 */
export const recordMailResult = internalMutation({
  args: {
    to: v.string(),
    subject: v.string(),
    ok: v.boolean(),
    channel: v.string(),
    id: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    // when true, the recipient address (e.g. the hidden operator email) is
    // never written into the audit log
    redactRecipient: v.optional(v.boolean()),
  },
  handler: async (ctx, { to, subject, ok, channel, id, description, redactRecipient }) => {
    const target = redactRecipient ? "[operator email hidden]" : to;
    const base = ok
      ? channel === "relay"
        ? `Email "${subject}" delivered to ${target} via the Freebuff OTP relay${id ? ` (message id ${id})` : ""}`
        : `Email "${subject}" to ${target} recorded (${channel})`
      : `Email "${subject}" to ${target} failed via ${channel} — ${description ?? "unknown error"}`;
    await ctx.db.insert("auditLogs", {
      actor: "mail",
      action: ok ? "email-sent" : "email-failed",
      target,
      description: base,
      ts: Date.now(),
    });
  },
});
