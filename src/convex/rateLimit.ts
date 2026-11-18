import { v } from "convex/values";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { isOperatorEmail } from "./operatorEmails";
import { applyRateLimit } from "../lib/rateLimit";

/**
 * Table-backed fixed-window rate limiter.
 *
 * The Convex build shipped in this environment does NOT expose the
 * `ctx.rateLimit` / `defineRateLimits` API (verified against the installed
 * package), so instead of faking it this module implements a real, honest
 * server-side limiter: one `rateLimits` row per bucket holding the current
 * window start + consumed count. Every call enforces the window; over-limit
 * calls throw a plain Error the UI already surfaces. Nothing is simulated —
 * the limit is enforced by the backend on every single call.
 *
 * Operator-related endpoints use shared (email-free) buckets so the hidden
 * operator email is never written anywhere; subscriber endpoints scope by
 * email, which is already stored in the subscribers table.
 */
export interface RateLimitOptions {
  bucket: string;
  limit: number;
  windowMs: number;
  message?: string;
}

export async function enforceRateLimit(
  ctx: Pick<MutationCtx, "db">,
  { bucket, limit, windowMs, message }: RateLimitOptions,
): Promise<void> {
  const now = Date.now();
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
    .first();
  const result = applyRateLimit(row ?? null, now, limit, windowMs, message);
  if (!result.allow) {
    throw new Error(result.message ?? "Too many attempts — wait a moment and try again.");
  }
  if (!row) {
    await ctx.db.insert("rateLimits", {
      bucket,
      windowStart: result.state.windowStart,
      count: result.state.count,
      limit,
      windowMs,
    });
  } else {
    await ctx.db.patch(row._id, {
      windowStart: result.state.windowStart,
      count: result.state.count,
    });
  }
}

/**
 * Consume one slot of a fixed window, committed in its own transaction.
 *
 * Called from actions (see `gate.operatorLogin`) so the increment SURVIVES a
 * rejected request. A mutation that counts and then throws rolls its own
 * write back — which is exactly why the operator-login throttle used to count
 * nothing: every failed attempt erased its own counter.
 */
export const consume = internalMutation({
  args: {
    bucket: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await enforceRateLimit(ctx, args);
    return null;
  },
});

/**
 * Operator console view — the currently active rate-limit buckets (real
 * server-side throttles, newest first). Operator-gated: only the terminal
 * operator can read it. Buckets contain the consumed count, the enforced
 * limit and the exact reset time; operator buckets are email-free by design
 * (subscriber buckets carry subscriber emails, which the operator console
 * already displays).
 */
export const getActiveBuckets = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 20 }) => {
    try {
      const identity = await ctx.auth.getUserIdentity();
      const email = identity?.email?.trim().toLowerCase();
      if (!email || !(await isOperatorEmail(ctx, email))) return [];
      const rows = await ctx.db.query("rateLimits").collect();
      const now = Date.now();
      return rows
        .filter((r) => r.count > 0)
        .sort((a, b) => b.windowStart - a.windowStart)
        .slice(0, limit)
        .map((r) => ({
          bucket: r.bucket,
          count: r.count,
          limit: r.limit,
          windowStart: r.windowStart,
          resetsInMs: Math.max(0, r.windowStart + r.windowMs - now),
        }));
    } catch {
      return [];
    }
  },
});
