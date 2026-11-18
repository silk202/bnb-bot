/**
 * Copier bot — database layer (mutations/queries). Kept separate from the
 * poller action so the generated api types stay acyclic and HTTP handlers
 * can reach the data through runQuery/runMutation.
 */
import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { sourceIdFor } from "../lib/copier-signals";

const SIGNAL_TTL_MS = 6 * 60 * 60 * 1000; // signals stay served for 6 hours
const MAX_SIGNALS = 400; // hard cap on stored signal rows
// Engine-side freshness window (see listRecentSignalsForEngine): the
// server snipers HARD-REJECT candidates captured >30 min ago
// (evaluateSnipeCandidate) and the SOL telecopier floored a route's TTL to
// 45 s once its signal passes 30 min of age — so reading the full 6-hour
// table on every engine pass was pure DB-I/O waste (100 docs ≈ 60+ KB per
// pass × 3 engine loops × thousands of passes/day). 45 min keeps a buffer
// over both 30-min gates at a fraction of the read size.
const ENGINE_SIGNAL_WINDOW_MS = 45 * 60 * 1000;

/** Wire shape of one parsed signal handed from the poller to the storer. */
const storedSignal = v.object({
  address: v.string(),
  symbol: v.string(),
  name: v.string(),
  chain: v.string(),
  priceUsd: v.number(),
  liquidityUsd: v.number(),
  marketCapUsd: v.number(),
  postedAt: v.number(),
  excerpt: v.string(),
});

/** Dedupe + insert freshly parsed signals, then prune stale/overflow rows. */
export const storeSignals = internalMutation({
  args: {
    signals: v.array(storedSignal),
    fetchedAt: v.number(),
    // Signals may come from any watched channel; the dedupe key carries it.
    srcUrl: v.string(),
    // Real channel display name stamped from the poller's source registry.
    sourceLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let stored = 0;
    for (const sig of args.signals) {
      const id = `${sourceIdFor(args.srcUrl)} : ${sig.address.toLowerCase()}`;
      const existing = await ctx.db
        .query("copierSignals")
        .withIndex("by_key", (q) => q.eq("id", id))
        .first();
      if (existing) {
        // Same token seen again — refresh enrichments ONLY when something
        // actually differs. The poller re-parses the same recent channel
        // messages every pass, so most "refreshes" are byte-identical;
        // writing them anyway was pure write-I/O waste AND invalidated every
        // subscribed signal feed (the Scanner's mounted panels) on each
        // poll. Keep original capture time either way.
        const unchanged =
          existing.symbol === sig.symbol &&
          existing.name === sig.name &&
          existing.priceUsd === sig.priceUsd &&
          existing.liquidityUsd === sig.liquidityUsd &&
          existing.marketCapUsd === sig.marketCapUsd &&
          existing.excerpt === sig.excerpt;
        if (unchanged) continue;
        await ctx.db.patch(existing._id, {
          symbol: sig.symbol,
          priceUsd: sig.priceUsd,
          liquidityUsd: sig.liquidityUsd,
          marketCapUsd: sig.marketCapUsd,
          excerpt: sig.excerpt,
        });
        continue;
      }
      await ctx.db.insert("copierSignals", {
        id,
        source: sourceIdFor(args.srcUrl),
        sourceLabel: args.sourceLabel ?? "Copier",
        address: sig.address,
        symbol: sig.symbol,
        name: sig.name,
        chain: sig.chain,
        priceUsd: sig.priceUsd,
        liquidityUsd: sig.liquidityUsd,
        marketCapUsd: sig.marketCapUsd,
        postedAt: sig.postedAt,
        capturedAt: Date.now(),
        buyable: true,
        excerpt: sig.excerpt,
      });
      stored++;
    }

    // BUDGET (DB I/O): prune WITHOUT a full-table collect — the old path
    // read every row (up to 400 × ~670 B ≈ 270 KB) on EVERY poll, and the
    // poller runs every 2-3 minutes around the clock.
    // (1) Expired rows — an INDEX RANGE on capturedAt. Normally EMPTY, so
    //     this read costs ~nothing; a backlog drains 200 rows per poll.
    const cutoff = args.fetchedAt - SIGNAL_TTL_MS;
    const stale = await ctx.db
      .query("copierSignals")
      .withIndex("by_capturedAt", (q) => q.lt("capturedAt", cutoff))
      .take(200);
    for (const row of stale) await ctx.db.delete(row._id);
    // (2) Hard cap — the 6-hour TTL already bounds the table in normal
    //     operation, so the bounded overflow scan only runs on BURST polls
    //     (a large fresh batch could outpace expiry) and never while a
    //     stale backlog is still draining (deletes are already happening).
    if (stored > 20 && stale.length < 200) {
      const head = await ctx.db
        .query("copierSignals")
        .withIndex("by_capturedAt")
        .order("asc")
        .take(MAX_SIGNALS + 100);
      const overflow = head.length - MAX_SIGNALS;
      if (overflow > 0) {
        for (const row of head.slice(0, Math.min(overflow, 100))) {
          await ctx.db.delete(row._id);
        }
      }
    }

    return { stored };
  },
});

/**
 * ENGINE-SIDE signal board — the bounded fresh window described at
 * ENGINE_SIGNAL_WINDOW_MS. Indexed range read on by_capturedAt: only rows
 * captured inside the window are ever touched, regardless of how large the
 * 6-hour table (capped at 400 rows) has grown.
 */
export const listRecentSignalsForEngine = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await ctx.db
      .query("copierSignals")
      .withIndex("by_capturedAt", (q) =>
        q.gte("capturedAt", now - ENGINE_SIGNAL_WINDOW_MS),
      )
      .order("desc")
      .take(60);
  },
});

/**
 * Public query: recent non-stale signals — consumed by the terminal UI
 * (useQuery(api.copierStore.listSignals)) and by the HTTP feed handler via
 * ctx.runQuery(internal.copierStore.listSignals).
 */
export const listSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 400);
    const rows = await ctx.db
      .query("copierSignals")
      .withIndex("by_capturedAt")
      .order("desc")
      .take(limit + 40);
    const now = Date.now();
    return rows.filter((r) => now - r.capturedAt < SIGNAL_TTL_MS).slice(0, limit);
  },
});
