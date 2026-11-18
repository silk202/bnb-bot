/**
 * Internal payout destinations — a server-controlled registry.
 *
 * This is the only thing that may classify a transfer as an INTERNAL profit
 * payout. Being connected, appearing in a payout card, or matching the signer
 * address is NOT classification: a destination is internal only when an
 * operator approved this exact chain + address here.
 *
 * Everything else is an external withdrawal, which stays disabled.
 *
 * Reads are available to any signed-in user (the terminal must classify a
 * destination); writes are operator-gated. Disabling is immediate — there is no
 * soft "pending" state for a destination, because a half-approved destination
 * would silently become payable.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isOperatorEmail, requireOperator } from "./operatorEmails";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function normalize(address: string): string {
  const trimmed = address.trim();
  if (!ADDRESS.test(trimmed)) throw new Error("Address must be a 0x-prefixed 20-byte address.");
  return trimmed.toLowerCase();
}

/** Approve (or re-enable) an internal destination. Operator-only. */
export const approveInternalDestination = mutation({
  args: {
    chainId: v.number(),
    address: v.string(),
    label: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    if (args.reason.trim().length < 4) throw new Error("A short reason is required.");
    const address = normalize(args.address);
    const existing = (await ctx.db
      .query("internalDestinations")
      .withIndex("by_address", (q) => q.eq("chainId", args.chainId).eq("address", address))
      .collect()).find((row) => row.enabled);
    if (existing) return { id: existing._id, alreadyApproved: true as const };
    const id = await ctx.db.insert("internalDestinations", {
      chainId: args.chainId,
      address,
      label: args.label?.slice(0, 120),
      enabled: true,
      approvedBy: actor,
      approvedAt: Date.now(),
      reason: args.reason.slice(0, 500),
    });
    return { id, alreadyApproved: false as const };
  },
});

/** Disable an internal destination. Operator-only; takes effect immediately. */
export const disableInternalDestination = mutation({
  args: { destinationId: v.id("internalDestinations"), reason: v.string() },
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    const row = await ctx.db.get(args.destinationId);
    if (!row) throw new Error("Destination not found.");
    if (!row.enabled) throw new Error("Destination is already disabled.");
    if (args.reason.trim().length < 4) throw new Error("A short reason is required.");
    await ctx.db.patch(args.destinationId, {
      enabled: false,
      disabledAt: Date.now(),
      reason: args.reason.slice(0, 500),
    });
    return { id: args.destinationId };
  },
});

/** Enabled internal destinations — the classification read path. */
export const internalDestinations = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = args.chainId
      ? await ctx.db
          .query("internalDestinations")
          .withIndex("by_chain", (q) => q.eq("chainId", args.chainId!).eq("enabled", true))
          .collect()
      : await ctx.db.query("internalDestinations").collect();
    return rows
      .filter((row) => row.enabled)
      .map((row) => ({
        chainId: row.chainId,
        address: row.address,
        label: row.label,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
      }));
  },
});

/** Operator view of every destination, enabled or not. */
export const internalDestinationAudit = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.email) return [];
    if (!(await isOperatorEmail(ctx, identity.email))) return [];
    return await ctx.db.query("internalDestinations").collect();
  },
});
