/**
 * Payout blocks — the queryable record of every payout the wallet guard
 * refused.
 *
 * The execution trail already marks a refused payout, but a label is not a
 * record: this table stores the wallet, destination, level, finding kinds and
 * reason as separate fields so "what blocked this wallet, and why, this week"
 * is a query instead of a string search. Rows are per-user and read back only
 * by their owner.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser } from "./users";

export const recordPayoutBlock = mutation({
  args: {
    /** Address that would have signed the payout. */
    wallet: v.string(),
    destination: v.optional(v.string()),
    token: v.optional(v.string()),
    spender: v.optional(v.string()),
    /** Allowance as a decimal string — uint256 does not fit in a number. */
    allowance: v.optional(v.string()),
    level: v.string(),
    kinds: v.array(v.string()),
    reason: v.string(),
    amountNative: v.number(),
    chain: v.optional(v.string()),
    network: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not signed in — a payout block must be attributable.");
    return await ctx.db.insert("payoutBlocks", {
      userId: user._id,
      wallet: args.wallet,
      destination: args.destination,
      token: args.token,
      spender: args.spender,
      allowance: args.allowance,
      level: args.level,
      kinds: args.kinds,
      reason: args.reason.slice(0, 500),
      amountNative: args.amountNative,
      chain: args.chain,
      network: args.network,
      ts: Date.now(),
    });
  },
});

/**
 * Server-side rejection of every external withdrawal request.
 *
 * The client already refuses these, but a refusal that only exists in the
 * browser is not an enforcement boundary: anyone can call the API. This
 * mutation exists so the backend classifies and rejects an external withdrawal
 * itself, records the attempt, and never signs or moves anything. There is no
 * approved withdrawal mechanism — this endpoint does not become one by being
 * called successfully; it returns `allowed: false` every time.
 */
export const requestExternalWithdrawal = mutation({
  args: {
    chainId: v.number(),
    destination: v.string(),
    amount: v.string(),
    network: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not signed in — a withdrawal attempt must be attributable.");
    const destination = args.destination.trim();
    const reason =
      "External withdrawals are disabled. Internal executor arming does not authorize transfers to external wallets, and no withdrawal authorization mechanism is implemented.";
    await ctx.db.insert("payoutBlocks", {
      userId: user._id,
      wallet: destination,
      destination,
      level: "critical",
      kinds: ["external-withdrawal-disabled"],
      reason,
      amountNative: Number(args.amount) || 0,
      chain: String(args.chainId),
      network: args.network,
      ts: Date.now(),
    });
    return { allowed: false as const, reason };
  },
});

export const listPayoutBlocks = query({
  args: {
    limit: v.optional(v.number()),
    wallet: v.optional(v.string()),
    level: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    // Over-read then filter, so a wallet/level filter can still fill `limit`
    // without needing an index per combination.
    const rows = await ctx.db
      .query("payoutBlocks")
      .withIndex("by_user_ts", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(limit * 4, 400));
    return rows
      .filter((row) => (args.wallet ? row.wallet === args.wallet : true))
      .filter((row) => (args.level ? row.level === args.level : true))
      .slice(0, limit);
  },
});
