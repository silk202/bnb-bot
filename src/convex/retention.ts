/**
 * FlashBolt daily data-retention sweep (`daily-retention` cron, see crons.ts).
 *
 * PRINCIPLE — only data that must outlive its usefulness is stored:
 * everything financial or identity-bearing is PERMANENT; everything else is
 * auto-deleted every 10 minutes in bounded batches (a backlog simply drains
 * over a few runs — see the daily-retention cron in crons.ts).
 *
 * KEPT FOREVER (never touched here):
 *   users, terminalStates, pnlStats (folded all-time PnL), operatorConfig,
 *   operatorEmails, gateKeys, subscribers, support messages/tickets,
 *   activationLicenses, telegramBotChats/telegramBotConfig, gitSyncConfig,
 *   whatsappConfig, terminalConfig, operatorDeviceTrust,
 *   tradeNotificationSettings, EVERY trade* ledger table (balances, txs,
 *   orders, earn plans, deposits, cash accounts, Kora deposits, favorites,
 *   claims, addresses), executions rows carrying a LIVE txHash (the real
 *   on-chain trail), auditLogs (own 7-day prune), copierSignals (6-hour TTL
 *   enforced by the poller, PLUS a 12-hour backstop sweep here so a dead
 *   poller can never let the feed accumulate).
 *
 * AUTO-DELETED EVERY 10 MINUTES (bounded batches, see crons.ts):
 *   notifications           → 30 days old   (bell history beyond a month)
 *   executions (paper only) → 30 days old   (SIM rows; pnlStats already
 *                              folds their totals, so no displayed number
 *                              ever changes; LIVE rows are never deleted)
 *   telegramSignals         →  7 days old   (sent-signal history)
 *   operatorCodes           → expired + 1 day (one-time OTP/guest codes)
 *   rateLimits              → dead windows + 1 day (fixed-window buckets)
 *   ttsCache                → 30 days old   (+ their storage blobs)
 *   copierSignals           → 12 hours old  (feed backstop — rolling market
 *                              window, no financial/identity value)
 *   telegramBotMessages     → 48 hours old  (tracking rows only: Telegram
 *                              refuses deletes past 48 h and the message
 *                              itself lives in the chat, not in this table)
 *
 * Every purge above is bookkeeping, a cache or a rolling window. Nothing that
 * carries a balance, a trade, an identity or a report is ever selected here.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { foldAllPnlRows, writePnlStats } from "./terminal";

const DAY_MS = 86_400_000;
const NOTIFICATIONS_KEEP_MS = 30 * DAY_MS;
const EXECUTIONS_KEEP_MS = 30 * DAY_MS;
const TELEGRAM_SIGNALS_KEEP_MS = 7 * DAY_MS;
const EXPIRED_CODE_GRACE_MS = DAY_MS;
const DEAD_WINDOW_GRACE_MS = DAY_MS;
const TTS_KEEP_MS = 30 * DAY_MS;
// 12 hours — double the poller's own 6h TTL, wide enough to never race a
// healthy poller run, tight enough that a dead poller costs hours, not GB.
const COPIER_SIGNALS_KEEP_MS = DAY_MS / 2;
// Telegram's own deleteMessage limit. A tracking row older than this can never
// be acted on again, so it is pure dead weight in the table.
const TRACKED_MESSAGE_ROW_KEEP_MS = 2 * DAY_MS;

// Batch caps — one bounded mutation per run; backlogs drain run by run
// (the cron fires every 10 minutes, so ~144 sweeps/day of headroom).
const MAX_NOTIFICATION_DELETES = 500;
const MAX_EXECUTION_DELETES = 400;
const MAX_EXECUTION_SCAN = 500;
const MAX_SIGNAL_DELETES = 300;
const MAX_CODE_DELETES = 300;
const MAX_BUCKET_DELETES = 200;
const MAX_TTS_DELETES = 150;
const MAX_COPIER_DELETES = 400;
const MAX_TRACKED_MESSAGE_DELETES = 400;

export const applyDailyRetention = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // ── 1) Notifications older than 30 days (indexed age range) ──────────
    const oldNotifs = await ctx.db
      .query("notifications")
      .withIndex("by_ts", (q) => q.lt("ts", now - NOTIFICATIONS_KEEP_MS))
      .take(MAX_NOTIFICATION_DELETES);
    for (const n of oldNotifs) await ctx.db.delete(n._id);

    // ── 2) Paper executions older than 30 days — LIVE rows are permanent ─
    // Newest-first within the expired window, so progress never wedges
    // behind a block of old live rows. Before a user's FIRST paper row
    // disappears, their pnlStats doc is materialized from the full history
    // (the fold includes the row — it still exists at that point), so the
    // all-time SIM/PnL totals stay exact forever even though the raw rows
    // are gone.
    const cutoff = now - EXECUTIONS_KEEP_MS;
    const expired = await ctx.db
      .query("executions")
      .withIndex("by_ts", (q) => q.lt("ts", cutoff))
      .order("desc")
      .take(MAX_EXECUTION_SCAN);
    let execsDeleted = 0;
    for (const r of expired) {
      if (execsDeleted >= MAX_EXECUTION_DELETES) break;
      const txHash = r.txHash;
      if (txHash && !txHash.startsWith("sim-")) continue; // live — keep forever
      const stats = await ctx.db
        .query("pnlStats")
        .withIndex("by_user", (q) => q.eq("userId", r.userId))
        .first();
      if (!stats) {
        const all = await ctx.db
          .query("executions")
          .withIndex("by_user", (q) => q.eq("userId", r.userId))
          .collect();
        await writePnlStats(ctx, r.userId, foldAllPnlRows(all));
      }
      await ctx.db.delete(r._id);
      execsDeleted += 1;
    }

    // ── 3) Telegram sent-signal history older than 7 days ────────────────
    const oldSignals = await ctx.db
      .query("telegramSignals")
      .withIndex("by_ts", (q) => q.lt("sentAt", now - TELEGRAM_SIGNALS_KEEP_MS))
      .take(MAX_SIGNAL_DELETES);
    for (const s of oldSignals) await ctx.db.delete(s._id);

    // ── 4) One-time operator codes past expiry (+1 day grace) ────────────
    // OTP/guest codes are worthless once expiresAt passes; the grace keeps
    // the "verifiedAt window" enforcement able to read very recent rows.
    const codes = await ctx.db.query("operatorCodes").take(500);
    let codesDeleted = 0;
    for (const c of codes) {
      if (codesDeleted >= MAX_CODE_DELETES) break;
      if (c.expiresAt < now - EXPIRED_CODE_GRACE_MS) {
        await ctx.db.delete(c._id);
        codesDeleted += 1;
      }
    }

    // ── 5) Fixed-window rate-limit buckets whose window died + 1 day ─────
    // rateLimit.ts recreates a bucket on demand, so deleting an ancient
    // window row can never weaken a live limit.
    const buckets = await ctx.db.query("rateLimits").take(500);
    let bucketsDeleted = 0;
    for (const b of buckets) {
      if (bucketsDeleted >= MAX_BUCKET_DELETES) break;
      if (b.windowStart + b.windowMs < now - DEAD_WINDOW_GRACE_MS) {
        await ctx.db.delete(b._id);
        bucketsDeleted += 1;
      }
    }

    // ── 6) TTS cache rows older than 30 days — and their storage blobs ───
    // Content-addressed (re-generated on next use), so both the row and the
    // _storage file must go or they bill storage forever.
    const ttsCutoff = now - TTS_KEEP_MS;
    const ttsAll = await ctx.db.query("ttsCache").take(1000);
    let ttsDeleted = 0;
    for (const t of ttsAll) {
      if (ttsDeleted >= MAX_TTS_DELETES) break;
      if (t.createdAt < ttsCutoff) {
        await ctx.storage.delete(t.storageId);
        await ctx.db.delete(t._id);
        ttsDeleted += 1;
      }
    }

    // ── 7) Copier signal feed — backstop sweep for anything > 12 hours ──
    // The copier poller already enforces its own 6-hour TTL on healthy runs;
    // this backstop (indexed by_capturedAt) keeps the feed flat even if the
    // poller is down for days. Same keep/delete contract the poller applies,
    // just a wider margin — the feed is a rolling market window with no
    // financial or identity value, so purging can never lose anything
    // permanent. Covers the copier/sniper subsystem (BNB copier + SOL
    // FlashBolt sniper both read this feed).
    const staleCopier = await ctx.db
      .query("copierSignals")
      .withIndex("by_capturedAt", (q) =>
        q.lt("capturedAt", now - COPIER_SIGNALS_KEEP_MS),
      )
      .take(MAX_COPIER_DELETES);
    for (const c of staleCopier) await ctx.db.delete(c._id);

    // ── 8) Telegram message-tracking rows past the 48 h delete limit ──────
    // The 10-minute sweep removes a row in the same mutation that selects it,
    // so a row only survives when no sweep could run (auto-purge off, no bot
    // token, a long outage). Telegram refuses deleteMessage after 48 h, so
    // such a row can never be acted on again — and the message itself lives in
    // the chat, not here. This is bookkeeping, not content: drop it.
    const staleTracked = await ctx.db
      .query("telegramBotMessages")
      .withIndex("by_sent", (q) => q.lt("sentAt", now - TRACKED_MESSAGE_ROW_KEEP_MS))
      .take(MAX_TRACKED_MESSAGE_DELETES);
    for (const m of staleTracked) await ctx.db.delete(m._id);

    return {
      notifications: oldNotifs.length,
      executionsPaper: execsDeleted,
      telegramSignals: oldSignals.length,
      operatorCodes: codesDeleted,
      rateLimits: bucketsDeleted,
      ttsCache: ttsDeleted,
      copierSignals: staleCopier.length,
      telegramBotMessages: staleTracked.length,
      scanned: { expiredExecutions: expired.length, codes: codes.length, buckets: buckets.length, tts: ttsAll.length },
    };
  },
});
