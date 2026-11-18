import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Cartesia audio cache (V8 side of ./tts).
 *
 * Every generated narration is stored in Convex file storage and referenced
 * by a content-addressed key (sha256 of voice | text), so replays never call
 * the Cartesia API again — the free plan's quota is only consumed once per
 * script. Entries older than 30 days are swept on write so the cache cannot
 * grow without bound.
 */

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Internal cache lookup by content key. */
export const lookupCache = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("ttsCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!row) return null;
    return { storageId: row.storageId };
  },
});

/** Internal cache write (after a successful Cartesia generation) + sweep. */
export const saveCache = internalMutation({
  args: { key: v.string(), storageId: v.id("_storage"), text: v.string() },
  handler: async (ctx, { key, storageId, text }) => {
    const existing = await ctx.db
      .query("ttsCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!existing) {
      await ctx.db.insert("ttsCache", { key, storageId, text, createdAt: Date.now() });
    }
    const old = await ctx.db.query("ttsCache").collect();
    for (const row of old) {
      if (row.createdAt < Date.now() - CACHE_MAX_AGE_MS) {
        try {
          await ctx.storage.delete(row.storageId);
        } catch {
          // orphaned storage file — safe to ignore
        }
        await ctx.db.delete(row._id);
      }
    }
    return true;
  },
});
