import { v } from "convex/values";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  cleanXml,
  isHighSignal,
  parseRssItems,
  type NewsItem,
} from "../lib/news";

/**
 * Real market-news feed for the terminal — public RSS headlines from
 * CoinDesk, CoinTelegraph and Decrypt, fetched server-side by a Convex
 * action and cached in the `newsCache` table for a short TTL so the public
 * feeds are polled sparingly. The terminal panel filters the real headlines
 * by live categories (flash loans / arbitrage, DeFi & DEX, BTC·ETH·BNB,
 * on-chain) — everything shown is real published news, nothing generated or
 * simulated. When every feed is unreachable the action falls back to the
 * last successfully cached items (still real headlines).
 *
 * The high-signal watchlist (which brand-new headlines reach subscriber
 * bells) is operator-tunable via the terminalConfig table; the action reads
 * the effective keywords on every fresh fetch.
 */

const NEWS_SOURCES: { key: string; label: string; url: string }[] = [
  {
    key: "coindesk",
    label: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  },
  {
    key: "cointelegraph",
    label: "CoinTelegraph",
    url: "https://cointelegraph.com/rss",
  },
  {
    key: "decrypt",
    label: "Decrypt",
    url: "https://decrypt.co/feed",
  },
];

const CACHE_TTL_MS = 10 * 60 * 1000; // re-poll the feeds at most every 10 min
const MAX_ITEMS = 24;

/** Cached feed row (real previously-fetched headlines). */
export const getCachedNews = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("newsCache")
      .withIndex("by_key", (q) => q.eq("key", "market-news"))
      .first();
    if (!row) return null;
    return { fetchedAt: row.fetchedAt, items: row.items };
  },
});

export const storeNewsCache = internalMutation({
  args: {
    items: v.array(
      v.object({
        source: v.string(),
        title: v.string(),
        link: v.string(),
        pubDate: v.string(),
        summary: v.string(),
      }),
    ),
    fetchedAt: v.number(),
  },
  handler: async (ctx, { items, fetchedAt }) => {
    const doc = { key: "market-news", fetchedAt, items };
    const existing = await ctx.db
      .query("newsCache")
      .withIndex("by_key", (q) => q.eq("key", "market-news"))
      .first();
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("newsCache", doc);
  },
});

/**
 * Fetch the latest real headlines. Returns fresh RSS items (or the last
 * successful cache when the feeds are unreachable) so the terminal news
 * panel always shows genuine published news. Brand-new items matching the
 * effective high-signal watchlist are pushed to subscriber bells (gated by
 * each subscriber's market-news alert preference).
 */
export const getMarketNews = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    items: NewsItem[];
    fetchedAt: number;
    fresh: boolean;
    source: string;
  }> => {
    const now = Date.now();
    const cached = await ctx.runQuery(internal.news.getCachedNews, {});

    // Serve the cache while it is younger than the TTL — no feed hammering.
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return {
        items: cached.items,
        fetchedAt: cached.fetchedAt,
        fresh: true,
        source: "rss-cache",
      };
    }

    const all: NewsItem[] = [];
    for (const src of NEWS_SOURCES) {
      try {
        const res = await fetchWithTimeout(src.url, 8000, {
          headers: { "User-Agent": "FlashBolt-terminal/1.0" },
        });
        if (!res.ok) continue;
        const xml = await res.text();
        all.push(...parseRssItems(xml, src.label));
      } catch {
        // A dead feed must never block the panel — keep the rest.
      }
    }

    const items = all
      .sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""))
      .slice(0, MAX_ITEMS)
      .map(({ source, title, link, pubDate, summary }) => ({
        source,
        title,
        link,
        pubDate,
        summary,
      }));

    if (items.length > 0) {
      const previousLinks = new Set((cached?.items ?? []).map((i) => i.link));
      const newItems = items.filter((i) => !previousLinks.has(i.link));
      await ctx.runMutation(internal.news.storeNewsCache, {
        items,
        fetchedAt: now,
      });
      // Real headline alerts: only brand-new items matching the effective
      // high-signal watchlist reach subscriber bells (title-deduped
      // server-side, preference-gated per subscriber).
      const config = await ctx.runQuery(
        internal.terminalConfig.getEffectiveConfig,
        {},
      );
      const alerts = newItems
        .filter((i) => isHighSignal(`${i.title} ${i.summary}`, config.newsKeywords))
        .slice(0, 3);
      if (alerts.length > 0) {
        await ctx.runMutation(
          internal.notifications.recordMarketNewsAlerts,
          { items: alerts },
        );
      }
      return { items, fetchedAt: now, fresh: false, source: "rss" };
    }

    // Every feed was unreachable — fall back to the last real headlines.
    if (cached) {
      return {
        items: cached.items,
        fetchedAt: cached.fetchedAt,
        fresh: false,
        source: "rss-cache",
      };
    }
    return { items: [], fetchedAt: now, fresh: false, source: "rss" };
  },
});
