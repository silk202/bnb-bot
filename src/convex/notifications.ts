import { v } from "convex/values";
import { getCurrentUser } from "./users";
import { isOperatorEmail } from "./operatorEmails";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { buildTelegramPayload } from "../lib/telegram";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

/**
 * FlashBolt notification center. Only real events are ever stored — bot
 * executions (recorded by the terminal), honey-pot detections (from the
 * live scanner) and high-signal market-news alerts (real RSS headlines that
 * match the flash-loan / arbitrage / DeFi watchlist, pushed to subscriber
 * bells by the news action). Nothing here is simulated.
 *
 * External channel policy: the Telegram channel carries ONLY flash-loan
 * trades and earnings (operator and subscribers). All other alerts stay
 * in-app (the bell) and/or go to the terminal operator's email — never to
 * Telegram.
 */

/**
 * Shared real Telegram Bot API send. Honest status, never faked — the
 * channel is contacted over HTTPS and the actual Bot API response (ok /
 * description) is returned to the caller for logging.
 */
export async function sendTelegramMessage(
  title: string,
  body: string,
): Promise<{
  enabled: boolean;
  ok: boolean;
  description: string;
  /** Telegram's real message id — the purge sweep needs it to delete later. */
  messageId: number | null;
}> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return {
      enabled: false,
      ok: false,
      description: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured in Keys",
      messageId: null,
    };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildTelegramPayload(chatId, title, body)),
      },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    const messageId =
      typeof data.result?.message_id === "number" ? data.result.message_id : null;
    return {
      enabled: true,
      ok: data.ok === true,
      description: data.description ?? (data.ok === true ? "sent" : "send failed"),
      messageId: data.ok === true ? messageId : null,
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      description: error instanceof Error ? error.message : "send failed",
      messageId: null,
    };
  }
}

/**
 * Record a delivered channel post so the every-10-minutes purge can delete it.
 * Best-effort: the post already happened, and bookkeeping must never turn a
 * successful send into a reported failure.
 */
async function trackChannelMessage(
  ctx: ActionCtx,
  sent: { ok: boolean; messageId: number | null },
): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!sent.ok || sent.messageId === null || !chatId) return;
  try {
    await ctx.runMutation(internal.telegramBot.recordBotMessage, {
      chatId,
      messageId: sent.messageId,
      source: "channel",
    });
  } catch {
    // Tracking only — the channel post is live.
  }
}

/**
 * Flash-loan trade + earnings alert — the ONLY event that goes to the
 * Telegram channel. Scheduled by the terminal after a real execution
 * (operator and subscriber accounts alike); never used for anything else.
 */
export const telegramTradeAlert = internalAction({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, { title, body }) => {
    // Channel send (existing behavior — TELEGRAM_CHAT_ID when configured),
    // tracked so the 10-minute purge deletes it like every other bot post.
    // Bot fanout is scheduled separately by recordExecution with the
    // structured trade fields (see fanoutTradeAlert in telegramBot.ts).
    const sent = await sendTelegramMessage(title, body);
    await trackChannelMessage(ctx, sent);
    return sent;
  },
});

/**
 * Session dashboard + market-score signals — the real-time session updates
 * scheduled by the Signals engine (cron + operator-triggered). Same honest
 * channel send as trades; the channel carries ONLY trades/earnings and these
 * explicit session dashboards.
 */
export const telegramSignal = internalAction({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, { title, body }) => {
    const sent = await sendTelegramMessage(title, body);
    await trackChannelMessage(ctx, sent);
    return sent;
  },
});

/** Manual channel ping (kept for compatibility; not used for email alerts). */
export const pingChannels = action({
  args: { title: v.string(), body: v.string() },
  handler: async (_ctx, { title, body }) => {
    return sendTelegramMessage(title, body);
  },
});

/** Newest-first notification feed for the current user. */
export const listNotifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 30 }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    // BUDGET (DB I/O): indexed newest-first take — the bell feed re-runs on
    // every notification write, so never collect the whole history.
    return await ctx.db
      .query("notifications")
      .withIndex("by_user_ts", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);
  },
});

/** Unread count for the bell badge. */
export const unreadNotificationCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return 0;
    // BUDGET (DB I/O): read ONLY the unread rows instead of collecting the
    // full history and filtering in memory.
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) =>
        q.eq("userId", user._id).eq("read", false),
      )
      .collect();
    return rows.length;
  },
});

/** Mark every unread notification as read. */
export const markAllNotificationsRead = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of rows) {
      if (!row.read) await ctx.db.patch(row._id, { read: true });
    }
    return true;
  },
});

/** Default subscriber alert preferences (all on). */
export const DEFAULT_ALERT_PREFS: {
  marketNews: boolean;
  sessionAlerts: boolean;
  honeyPot: boolean;
  earnings: boolean;
} = {
  marketNews: true,
  sessionAlerts: true,
  honeyPot: true,
  earnings: true,
};

export type AlertPrefs = typeof DEFAULT_ALERT_PREFS;

/**
 * Push real market-news alerts to subscriber bells. Called by the news
 * action only for headlines that are NEW (not in the previous RSS cache) and
 * match the high-signal watchlist (flash loans, arbitrage, MEV, exploits).
 * Each alert is written once per subscriber per headline (title-deduped) —
 * real published headlines only, never generated content. Subscribers who
 * turned the market-news preference off in their alert preferences are
 * skipped.
 */
export const recordMarketNewsAlerts = internalMutation({
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
  },
  handler: async (ctx, { items }) => {
    const subs = await ctx.db.query("subscribers").collect();
    const subscriberEmails = new Map<string, AlertPrefs>();
    for (const s of subs) {
      if (s.status === "blocked") continue;
      subscriberEmails.set(s.email, {
        marketNews: s.alertPrefs?.marketNews ?? true,
        sessionAlerts: s.alertPrefs?.sessionAlerts ?? true,
        honeyPot: s.alertPrefs?.honeyPot ?? true,
        earnings: s.alertPrefs?.earnings ?? true,
      });
    }
    if (subscriberEmails.size === 0) return 0;
    const users = await ctx.db.query("users").collect();
    let inserted = 0;
    for (const user of users) {
      const email = user.email?.trim().toLowerCase();
      const prefs = email ? subscriberEmails.get(email) : undefined;
      if (!email || !prefs || !prefs.marketNews) continue;
      // BUDGET (DB I/O): the dedupe only ever looks at market-news rows —
      // read exactly those through the by_user_kind index instead of each
      // user's ENTIRE notification history (the operator's alone holds
      // 16k+ execution rows ≈ 5 MB).
      const existing = await ctx.db
        .query("notifications")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", user._id).eq("kind", "market_news"),
        )
        .collect();
      const alertedTitles = new Set(
        existing.map((n) => n.title.toLowerCase()),
      );
      for (const item of items) {
        if (alertedTitles.has(item.title.toLowerCase())) continue;
        await ctx.db.insert("notifications", {
          userId: user._id,
          kind: "market_news",
          title: item.title,
          body: `${item.source} — ${item.summary || "Open the article for details."} ${item.link}`,
          ts: Date.now(),
          read: false,
        });
        alertedTitles.add(item.title.toLowerCase());
        inserted += 1;
      }
    }
    return inserted;
  },
});

/**
 * Record a notification (used by the scanner for real honey-pot finds and
 * the terminal for executions). Subscribers' in-app alert preferences are
 * respected: honey-pot entries skip when the honeyPot preference is off,
 * execution/earnings entries skip when earnings is off. Operators and
 * non-subscriber users are never gated (they have no preference row).
 */
export const recordNotification = mutation({
  args: {
    kind: v.union(
      v.literal("execution"),
      v.literal("honey_pot"),
      v.literal("session_update"),
    ),
    title: v.string(),
    body: v.string(),
    chainKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const email = user.email?.trim().toLowerCase();
    if (email) {
      const sub = await ctx.db
        .query("subscribers")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (sub && sub.status !== "blocked") {
        const prefs = sub.alertPrefs ?? DEFAULT_ALERT_PREFS;
        if (args.kind === "honey_pot" && !prefs.honeyPot) return null;
        if (args.kind === "execution" && !prefs.earnings) return null;
        if (args.kind === "session_update" && !prefs.sessionAlerts) return null;
      }
    }
    return await ctx.db.insert("notifications", {
      userId: user._id,
      kind: args.kind,
      title: args.title,
      body: args.body,
      ts: Date.now(),
      read: false,
      chainKey: args.chainKey,
    });
  },
});

/**
 * In-app session-change alerts — recorded by the Signals engine whenever a
 * NEW primary market session opens (session_open). Every active subscriber
 * with the session-alerts preference on gets a bell entry with the real
 * session state. The Telegram channel delivery is unaffected — this only
 * adds the per-subscriber in-app entry.
 */
export const recordSessionAlerts = internalMutation({
  args: {
    session: v.string(),
    sessionLabel: v.string(),
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, { session, sessionLabel, title, body }) => {
    const subs = await ctx.db.query("subscribers").collect();
    const subscriberEmails = new Map<string, AlertPrefs>();
    for (const s of subs) {
      if (s.status === "blocked") continue;
      subscriberEmails.set(s.email, {
        marketNews: s.alertPrefs?.marketNews ?? true,
        sessionAlerts: s.alertPrefs?.sessionAlerts ?? true,
        honeyPot: s.alertPrefs?.honeyPot ?? true,
        earnings: s.alertPrefs?.earnings ?? true,
      });
    }
    if (subscriberEmails.size === 0) return 0;
    const users = await ctx.db.query("users").collect();
    let inserted = 0;
    for (const user of users) {
      const email = user.email?.trim().toLowerCase();
      const prefs = email ? subscriberEmails.get(email) : undefined;
      if (!email || !prefs || !prefs.sessionAlerts) continue;
      await ctx.db.insert("notifications", {
        userId: user._id,
        kind: "session_update",
        title,
        body: `${sessionLabel} · ${body}`,
        ts: Date.now(),
        read: false,
      });
      inserted += 1;
    }
    return inserted;
  },
});

/**
 * In-app twin of the Telegram purge-fault alert — written for every operator
 * user (the bell is per-user) so the fault is still visible when Telegram
 * itself is the broken channel. Deduped to one entry per hour while the fault
 * persists: the sweep retries every 10 minutes, and a badge climbing six times
 * an hour would drown the signal.
 *
 * Own kind: `bot_health` (round 33). It is a distinct bucket so the bell's
 * icon and its dedupe key are the fault's own — an hourly bot-health entry can
 * never suppress, or be suppressed by, a session update.
 *
 * `dedupeKey` is for events that are one-off plus same-titled. When supplied,
 * it REPLACES the title + 1 h rule (it never falls back to it): two abandoned
 * batches inside an hour are two different facts, not a repeat of one. Without
 * it, the hourly title dedupe still throttles a persisting fault.
 */
export const recordBotHealthAlert = internalMutation({
  args: {
    title: v.string(),
    body: v.string(),
    /** Batch identity — dedupes on itself, not on the title or the clock. */
    dedupeKey: v.optional(v.string()),
  },
  handler: async (ctx, { title, body, dedupeKey }) => {
    const now = Date.now();
    const states = await ctx.db.query("terminalStates").collect();
    const seen = new Set<string>();
    let inserted = 0;
    for (const state of states) {
      if (seen.has(state.userId)) continue;
      seen.add(state.userId);
      const user = await ctx.db.get(state.userId);
      const email = user?.email?.trim().toLowerCase();
      if (!email) continue;
      if (!(await isOperatorEmail({ db: ctx.db }, email))) continue;
      const recent = await ctx.db
        .query("notifications")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", state.userId).eq("kind", "bot_health"),
        )
        .order("desc")
        .take(20);
      const key = dedupeKey?.trim();
      const already = key
        ? recent.some((n) => n.dedupeKey === key)
        : recent.some((n) => n.title === title && now - n.ts < 60 * 60 * 1000);
      if (already) continue;
      await ctx.db.insert("notifications", {
        userId: state.userId,
        kind: "bot_health",
        title,
        body,
        ts: now,
        read: false,
        ...(key ? { dedupeKey: key } : {}),
      });
      inserted += 1;
    }
    return inserted;
  },
});

// ---------------------------------------------------------------------
// Trade notification settings — per-user sound + push preferences
// ---------------------------------------------------------------------

/** Get the current user's trade notification settings (sound + push). */
export const getTradeNotificationSettings = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const row = await ctx.db
      .query("tradeNotificationSettings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (!row) {
      // Return defaults if no row exists yet
      return { soundEnabled: true, pushEnabled: true };
    }
    return { soundEnabled: row.soundEnabled, pushEnabled: row.pushEnabled };
  },
});

/** Update the current user's trade notification settings. */
export const updateTradeNotificationSettings = mutation({
  args: {
    soundEnabled: v.optional(v.boolean()),
    pushEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, { soundEnabled, pushEnabled }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    let row = await ctx.db
      .query("tradeNotificationSettings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    const updates: Record<string, boolean> = {};
    if (soundEnabled !== undefined) updates.soundEnabled = soundEnabled;
    if (pushEnabled !== undefined) updates.pushEnabled = pushEnabled;
    if (row) {
      await ctx.db.patch(row._id, updates);
    } else {
      await ctx.db.insert("tradeNotificationSettings", {
        userId: user._id,
        soundEnabled: soundEnabled ?? true,
        pushEnabled: pushEnabled ?? true,
      });
    }
    return true;
  },
});
