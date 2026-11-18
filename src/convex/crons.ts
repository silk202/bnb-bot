import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Real-time Telegram session signals — every 15 minutes, around the clock,
 * so the channel always carries a fresh live dashboard scoped to the current
 * market session duration. The job itself detects session opens (first tick
 * in a new primary session sends a `session_open` alert) and otherwise posts
 * a periodic `session_update`.
 */
const crons = cronJobs();

crons.cron(
  "session-signal",
  "*/15 * * * *",
  internal.signals.runSessionSignal,
  {},
);

// Desktop activation licenses — every day at 00:30 UTC, expire any password
// that was never used to activate its desktop app within 72 hours and email
// the operator a summary.
crons.cron(
  "license-expiry",
  "30 0 * * *",
  internal.licenses.expireStaleLicenses,
  {},
);

// FlashBolt Trade — limit-order scan: fills open orders when the live cached
// market price crosses their limit. Every 5 minutes (was every minute to
// cap function calls); the scan itself no-ops whenever the price cache is
// missing or stale (>10 min) — and the cache is only refreshed while the
// Trade UI or the Telegram dashboard is actually reading prices, so a
// 1-minute cadence bought nothing but 1,152 wasted calls/day. Worst-case
// fill latency stays bounded by the cache's own 10-minute freshness rule.
crons.cron("trade-order-scan", "*/5 * * * *", internal.trade.scanOrders, {});

// FlashBolt Trade — earn accrual: interest accrues by elapsed time, so the
// math is identical no matter how rarely the pass runs — 3-hourly keeps
// payouts honest while cutting cron volume by two thirds.
crons.cron("trade-earn-accrual", "5 */3 * * *", internal.trade.accrueEarn, {});

// FlashBolt Trade — on-chain deposit auto-detection: scans recent blocks /
// public APIs for deposits to bound addresses, verifies user-submitted
// txids against public chain APIs, and credits at the confirmation
// threshold. Idempotent per (txHash, logIndex). Every 3 minutes (was 2):
// confirmation thresholds already take minutes, so detection latency is
// unchanged in practice while 240 fewer runs/day leave the call budget.
crons.cron("trade-chain-watch", "*/3 * * * *", internal.tradeAutoDetection.watchPass, {});

// FlashBolt Telegram Bot — scheduled dashboard digest every 15 min: pushes
// the real live dashboard to every paired chat when digestEnabled (plus a
// pairing/webhook health check elsewhere). No-ops when the token is
// unconfigured, the digest is off, or no chat is paired.
crons.cron("telegram-bot-digest", "*/15 * * * *", internal.telegramBot.runDigest, {});

// Copier/sniper signal poller — continuously refreshes the shared
// copierSignals feed from the watched Telegram channels so the SOL FlashBolt
// sniper and the BNB copier keep receiving real candidates in the
// background, with the app closed. Idempotent per (source, token address).
crons.cron(
  "copier-signal-poll",
  "*/3 * * * *",
  internal.copier.pollChannelsInternal,
  {},
);

// Telegram bot self-healing sweep — webhook stays registered with Telegram
// even if it is dropped upstream (deployment URL change, manual deletion).
// Idempotent: a getWebhookInfo check first, setWebhook only when needed.
// Every 10 minutes; no-ops when no token is configured.
crons.cron(
  "telegram-bot-selfheal",
  "*/10 * * * *",
  internal.telegramBot.ensureBotReadyInternal,
  {},
);

// Autonomous engine heartbeat — the recovery path for the server-side scan
// loops (terminal.scanPass) AND the sniper loops (terminal.snipePass). While
// a bot is running and the app is offline, the self-rescheduling loops drive
// scanning AND sniping; this every-FIVE-minute heartbeat resurrects any loop
// a deployment restart ever killed (the loops themselves re-schedule their
// own next pass continuously — the heartbeat only matters after an outage,
// so */5 cuts recurring function-call volume ~80% with zero behavior change
// for uptime; each of the FOUR engines — BNB scan, SOL scan, BNB sniper, SOL
// sniper — carries its own per-chain gate, freshness stamp and lease, so no
// kick can double-drive an alive loop and the subsystems never disrupt one
// another (idempotent by construction).
crons.cron(
  "engine-heartbeat",
  "*/5 * * * *",
  internal.terminal.engineHeartbeat,
  {},
);

// Fleet metrics snapshot — the 15-minute session signal and the 15-minute
// Telegram digest BOTH serve pre-aggregated fleet numbers (terminals,
// bots, executions, wins, PnL, scans). Materializing the aggregate here
// (every 20 minutes) means those consumers read ONE small cached doc
// instead of re-scanning the entire terminalStates table on every run —
// ~18 MB/day of pure aggregate DB I/O before this cron existed. The cache
// stays valid for 25 min, so a missed tick still falls back to a live
// compute (correctness over thrift).
crons.cron(
  "fleet-metrics-refresh",
  "*/20 * * * *",
  internal.signals.refreshFleetMetrics,
  {},
);

// FlashBolt Trade — Kora QUI-CHKOUT expiry sweep: one-time virtual bank
// accounts expire after a fixed window, so stamp stale pending checkouts as
// expired (and fail their pending txs) so users see an honest status. Every
// 10 minutes; idempotent.
crons.cron("kora-expiry-sweep", "*/10 * * * *", internal.kora.sweepExpired, {});

// Audit-log pruning — auditLogs is unbounded and live-subscribed by the
// operator console, so table size multiplies subscription DB I/O (the free
// plan caps DB I/O at 1 GB/month). Keep 7 days; batched deletes capped per
// run so backlogs drain safely. Every 10 minutes (was every 6 hours, then
// daily): auditLogs is live-subscribed by the operator console, so a growing
// table taxes EVERY subscriber — a 10-minute cadence keeps the table flat all
// day instead of sawtoothing between sweeps. The sweep is a single indexed
// range probe that no-ops when nothing is past 7 days, so the extra runs cost
// one cheap query each. Idempotent.
crons.cron(
  "audit-log-prune",
  "*/10 * * * *",
  internal.gate.pruneAuditLogs,
  {},
);

// Executor code-inspection evidence — every inspection writes a row that an
// approval may later point at. Write-time pruning only covers the inspecting
// actor, so this sweep bounds the table globally after a week; rows an approval
// references are retained so `contractCodeInspectionId` never dangles. Bounded
// batches, oldest-first, idempotent — a quiet table costs one indexed probe.
crons.cron(
  "inspection-evidence-prune",
  "17 */6 * * *",
  internal.chainActivations.pruneInspectionEvidence,
  {},
);

// DAILY DATA RETENTION — only data that must be stored stays stored.
// Everything financial or identity-bearing is permanent (trade ledgers,
// pnlStats, users, subscribers, LIVE on-chain execution rows, licenses);
// everything else is auto-deleted here every night in bounded batches:
// notifications > 30 days, paper executions > 30 days (totals live on in
// pnlStats), Telegram sent-signal history > 7 days, expired one-time
// operator codes, dead rate-limit windows, and the TTS cache + its storage
// blobs > 30 days. See retention.ts for the full keep/delete contract.
// EVERY 10 MINUTES (was every 4 hours, then nightly): the sweep is
// bounded-batch and idempotent, so a 10-minute cadence drains backlogs as
// they appear instead of 6×/day, and keeps every purged table — and
// therefore every live subscription's DB I/O — flat around the clock. This
// is the auto-purge half of the usage-limit defense: the Convex
// deployment-level usage limits (set via the Deployment API, see
// DEPLOYMENT.md) trip-and-re-enable daily, and this sweep keeps the data
// that feeds DB I/O and storage from ever reaching those gauges. Each run
// costs one indexed range probe per purged table and no-ops when nothing is
// past its window, so the higher cadence is cheap in the steady state.
crons.cron(
  "daily-retention",
  "*/10 * * * *",
  internal.retention.applyDailyRetention,
  {},
);

export default crons;
