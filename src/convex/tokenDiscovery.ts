/**
 * Convex action: multi-source token discovery.
 *
 * Runs the full pipeline server-side (avoids CORS issues) and returns
 * the ranked results to the frontend. All data is real-time live from
 * 10+ external APIs — nothing is mocked or simulated.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  runDiscoveryPipeline,
  DEFAULT_DISCOVERY_FILTER,
  type DiscoveryFilter,
  type DiscoverySnapshot,
} from "../lib/token-discovery";

export const discoverTokens = action({
  args: {},
  handler: async (): Promise<DiscoverySnapshot> => {
    const snapshot = await runDiscoveryPipeline(DEFAULT_DISCOVERY_FILTER);
    return snapshot;
  },
});

export const discoverTokensWithFilter = action({
  args: {
    minLiquidityUsd: v.number(),
    maxAgeHours: v.number(),
    minHolders: v.number(),
    minTransactions24h: v.number(),
    maxBuyTaxPct: v.number(),
    maxSellTaxPct: v.number(),
    excludeHoneypots: v.boolean(),
    minSecurityScore: v.number(),
    minVolume24hUsd: v.number(),
    maxRiskLevel: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("critical"),
    ),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<DiscoverySnapshot> => {
    const discoveryFilter: DiscoveryFilter = {
      minLiquidityUsd: args.minLiquidityUsd,
      maxAgeHours: args.maxAgeHours,
      minHolders: args.minHolders,
      minTransactions24h: args.minTransactions24h,
      maxBuyTaxPct: args.maxBuyTaxPct,
      maxSellTaxPct: args.maxSellTaxPct,
      excludeHoneypots: args.excludeHoneypots,
      minSecurityScore: args.minSecurityScore,
      minVolume24hUsd: args.minVolume24hUsd,
      maxRiskLevel: args.maxRiskLevel,
    };
    const snapshot = await runDiscoveryPipeline(discoveryFilter);
    return snapshot;
  },
});
