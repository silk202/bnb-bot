/**
 * Copier bot — Telegram signal channel poller + public signals endpoint.
 *
 * Pulls the public web previews of the watched channels (t.me/s/AveSignalMonitor
 * and t.me/s/BSCnewtokenspairs), parses token signals out of the raw HTML (shared
 * parser in src/lib/copier-signals.ts), stores them via copierStore (actions
 * cannot touch ctx.db) and serves them to the Sniper terminal and the
 * DEXView/GMGN/Ave overlay's LIVE CANDIDATES via public GET /api/copier/signals.
 *
 * Every stored signal is a real message from the real channel — nothing is
 * simulated.
 */
import { action, httpAction, internalAction, mutation } from "./_generated/server";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import {
  COPIER_SOURCES,
  extractMessagesFromPreview,
  parseChannelMessages,
  parseTelegramUpdates,
  sourceIdFor,
} from "../lib/copier-signals";

/**
 * Pull every watched Telegram channel's public preview and store any newly
 * parsed token signals. Returns a run summary for the Copier UI status row.
 */
export const pollChannels = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ fetched: number; parsed: number; stored: number; notes: string[] }> => {
    const fetchedAt = Date.now();
    let fetched = 0;
    let parsed = 0;
    let stored = 0;
    const notes: string[] = [];
    const seen = new Set<string>();
    const signals: Array<{
      address: string;
      symbol: string;
      name: string;
      chain: string;
      priceUsd: number;
      liquidityUsd: number;
      marketCapUsd: number;
      postedAt: number;
      excerpt: string;
    }> = [];

    // Channels without a public web preview fall back to
    // the Telegram Bot API: the operator adds the copier bot to the channel
    // and getUpdates carries the same posts. Optional — skipped when the
    // token is not configured in Keys.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    for (const src of COPIER_SOURCES) {
      try {
        // COMPUTE (worst case): this is an ACTION — every second spent
        // waiting here counts against the Free plan's 20 GB-h/month action
        // compute when the runtime bills wall time. t.me previews answer in
        // well under 2 s when healthy, so a 6 s cap (was 12 s) changes
        // nothing real and halves the worst-case run length during an
        // upstream outage (2 channels × preview+fallback).
        const res = await fetchWithTimeout(src.url, 6000, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 126.0 Safari/537.36",
            "accept-language": "en-US,en;q=0.9",
          },
        });
        let messages = res.ok ? extractMessagesFromPreview(await res.text()) : [];
        if (!res.ok) {
          notes.push(src.label + ": preview HTTP " + res.status);
        }

        // Preview disabled or empty → try the Bot API for this channel.
        if (messages.length === 0 && botToken) {
          const handle = src.url.split("/s/")[1];
          try {
            const apiRes = await fetchWithTimeout(
              "https://api.telegram.org/bot" + botToken + "/getUpdates",
              6000,
            );
            if (apiRes.ok) {
              const all = parseTelegramUpdates(await apiRes.json());
              messages = all.filter((m) => m.link.endsWith("/" + handle));
            }
          } catch {
            // Bot API unreachable — the preview note above already stands.
          }
        }

        fetched += messages.length;
        const fresh: typeof signals = [];
        for (const sig of parseChannelMessages(messages)) {
          const key = sig.address.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          signals.push(sig);
          fresh.push(sig);
        }
        parsed += fresh.length;
        if (fresh.length > 0) {
          // Actions cannot touch ctx.db — the storer mutation dedupes,
          // inserts and prunes in one transaction per channel.
          const result = await ctx.runMutation(internal.copierStore.storeSignals, {
            signals: fresh,
            fetchedAt,
            srcUrl: src.url,
            sourceLabel: src.label,
          });
          stored += result.stored;
        }
      } catch (e) {
        notes.push(src.label + ": " + (e instanceof Error ? e.message : String(e)));
      }
    }

    return { fetched, parsed, stored, notes };
  },
});

/**
 * Scheduled internal twin of pollChannels — crons can only invoke internal
 * functions, and this poller is what keeps the bots alive in the background:
 * it fills the shared copierSignals feed the SOL FlashBolt sniper and the BNB
 * copier read from, so both keep working around the clock with the app
 * closed. Same logic, no operator gate (internal, server-side by definition).
 */
export const pollChannelsInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<{ stored: number }> => {
    const res = await ctx.runAction(api.copier.pollChannels, {});
    return { stored: res.stored };
  },
});

/**
 * Manual paste — ingest one or more signals from a pasted t.me post URL or
 * raw message text. Works for preview-disabled channels: the operator copies
 * a post link/text from the Telegram app and the copier parses it through
 * the same shared parser and gates.
 */
export const ingestManualSignals = mutation({
  args: { raw: v.string(), srcUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const srcUrl = args.srcUrl ?? COPIER_SOURCES[1]!.url;
    const sourceId = sourceIdFor(srcUrl);
    // Support a URL with text, or plain pasted message text.
    const text = args.raw.includes("t.me/") && !args.raw.includes("\n")
      ? "t.me post " + args.raw
      : args.raw;
    const parsedSignals = parseChannelMessages([
      { id: "manual:" + Date.now(), text, postedAt: Date.now(), link: args.raw },
    ]);
    let stored = 0;
    for (const sig of parsedSignals) {
      const id = sourceId + " : " + sig.address.toLowerCase();
      const existing = await ctx.db
        .query("copierSignals")
        .withIndex("by_key", (q) => q.eq("id", id))
        .first();
      if (existing) continue;
      await ctx.db.insert("copierSignals", {
        id,
        source: sourceId,
        sourceLabel: "Manual paste",
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
    return { fetched: 1, parsed: parsedSignals.length, stored, notes: [] as string[] };
  },
});

/**
 * GET /api/copier/signals — public feed for the overlay userscript.
 * Optional params: chain=<bsc|ethereum|arbitrum|polygon>, limit=<n>.
 */
export const signalsHttp = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const chainFilter = url.searchParams.get("chain");
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 120) || 120, 1),
    400,
  );

  const rows = (await ctx.runQuery(api.copierStore.listSignals, { limit: 200 })) as Array<{
    id: string;
    source: string;
    sourceLabel: string;
    address: string;
    symbol: string;
    name: string;
    chain: string;
    priceUsd: number;
    liquidityUsd: number;
    marketCapUsd: number;
    postedAt: number;
    capturedAt: number;
    buyable: boolean;
    excerpt: string;
  }>;

  const signals = rows
    .filter((r) => !chainFilter || r.chain === chainFilter)
    .slice(0, limit);

  return new Response(JSON.stringify({ ok: true, signals }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
});
