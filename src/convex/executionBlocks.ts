/**
 * Swaps refused by the execution gate before any transaction existed.
 *
 * The gate used to leave no trace: a refusal was a log line and a toast, so
 * "policy blocked 40 buys this week" was unanswerable and a silent misconfigured
 * registry looked like a quiet market. Rows are per-user and client-immutable in
 * content: the only write path folds a repeated refusal into the same minute
 * bucket (`hits`), so a caller can never rewrite a code, reason or amount.
 *
 * These are NOT failed simulations and NOT losses: nothing was built, signed or
 * broadcast, and the loss counters must not treat them as trades.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser } from "./users";

const DEDUPE_WINDOW_MS = 60_000;
/** Full-scan budget for exact counts (10 × 500 rows). */
const SUMMARY_ROW_BUDGET = 5_000;

function dedupeKeyFor(input: {
  code: string;
  chainId: number;
  token?: string;
  reason: string;
  now: number;
}): string {
  const bucket = Math.floor(input.now / DEDUPE_WINDOW_MS);
  return [input.code, input.chainId, (input.token ?? "").toLowerCase(), input.reason, bucket].join("|");
}

export const recordBlockedExecution = mutation({
  args: {
    chainId: v.number(),
    /** Typed refusal code from the execution layer, e.g. unvalidated-target. */
    code: v.string(),
    reason: v.string(),
    router: v.optional(v.string()),
    token: v.optional(v.string()),
    amountNative: v.number(),
    network: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not signed in — a blocked execution must be attributable.");
    if (!Number.isFinite(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    const now = Date.now();
    const code = args.code.slice(0, 80);
    const reason = args.reason.slice(0, 500);
    const dedupeKey = dedupeKeyFor({ code, chainId: args.chainId, token: args.token, reason, now });

    // One row per refusal per minute. Auto-sell re-evaluates on every pass, so
    // without this the same block produced a row per tick and inflated counts.
    const existing = await ctx.db
      .query("executionBlocks")
      .withIndex("by_user_dedupe", (q) => q.eq("userId", user._id).eq("dedupeKey", dedupeKey))
      .first();
    if (existing) {
      const hits = (existing.hits ?? 1) + 1;
      await ctx.db.patch(existing._id, { hits, lastTs: now });
      return { id: existing._id, hits, deduped: true as const };
    }

    const id = await ctx.db.insert("executionBlocks", {
      userId: user._id,
      chainId: args.chainId,
      code,
      reason,
      router: args.router,
      token: args.token,
      amountNative: Number.isFinite(args.amountNative) ? args.amountNative : 0,
      network: args.network,
      ts: now,
      hits: 1,
      lastTs: now,
      dedupeKey,
    });
    return { id, hits: 1, deduped: false as const };
  },
});

/**
 * Exact refusal counts for the Settings panel.
 *
 * Reads every one of this user's rows (paginated, budget 5 000) and sums `hits`,
 * so totals and per-code figures are complete rather than a newest-500 sample.
 * `capped` is true only if the budget was exhausted — then the numbers are a
 * floor, not a total, and the panel says so.
 */
export const blockedExecutionSummary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const byCode: Record<string, number> = {};
    const recent: Array<{
      code: string;
      reason: string;
      chainId: number;
      token?: string;
      ts: number;
      hits: number;
    }> = [];
    let attempts = 0;
    let rows = 0;
    let last24h = 0;
    let last7d = 0;
    let capped = true;

    let cursor: string | null = null;
    while (rows < SUMMARY_ROW_BUDGET) {
      const page = await ctx.db
        .query("executionBlocks")
        .withIndex("by_user_ts", (q) => q.eq("userId", user._id))
        .order("desc")
        .paginate({ numItems: 500, cursor });
      for (const row of page.page) {
        const hits = row.hits ?? 1;
        const at = row.lastTs ?? row.ts;
        attempts += hits;
        rows += 1;
        byCode[row.code] = (byCode[row.code] ?? 0) + hits;
        if (now - at < 86_400_000) last24h += hits;
        if (now - at < 7 * 86_400_000) last7d += hits;
        if (recent.length < 5) {
          recent.push({
            code: row.code,
            reason: row.reason,
            chainId: row.chainId,
            token: row.token,
            ts: at,
            hits,
          });
        }
      }
      cursor = page.continueCursor;
      if (page.isDone) {
        capped = false;
        break;
      }
      if (rows >= SUMMARY_ROW_BUDGET) break;
    }

    return { attempts, rows, last24h, last7d, byCode, recent, capped };
  },
});

export const listBlockedExecutions = query({
  args: { limit: v.optional(v.number()), code: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("executionBlocks")
      .withIndex("by_user_ts", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(limit * 4, 400));
    return rows.filter((row) => (args.code ? row.code === args.code : true)).slice(0, limit);
  },
});
