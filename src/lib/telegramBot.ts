/**
 * FlashBolt Telegram Bot — pure presentation + protocol layer.
 *
 * Deterministic formatting and parsing ONLY: every message the bot sends is
 * built here from real backend data (terminal state, executions, trade
 * ledger, live market feed) and every incoming update is parsed here. The
 * only side effects (HTTPS calls to the Telegram Bot API) live in
 * src/convex/telegramBot.ts. No network access, no secrets, no mocking.
 *
 * Access policy: the bot mirrors the app for the OPERATOR only — a chat must
 * complete secure pairing before anything beyond /start /pair /help works.
 */

// ---------------------------------------------------------------------------
// Types shared with the backend
// ---------------------------------------------------------------------------

export interface BotChat {
  chatId: string;
  title?: string;
  username?: string;
  linkedAt: number;
  lastSeenAt: number;
  lastCommand?: string;
  silent: boolean;
  blocked: boolean;
}

/**
 * The last purge sweep's honest tally, stamped by the `telegram-bot-purge`
 * cron and shown on `/alerts` and in the app panel. Present only after a sweep
 * has run: a missing value means "not reported yet", never "0 deleted".
 */
export interface PurgeTelemetry {
  /** When the sweep ran (epoch ms). */
  at: number;
  /** Messages Telegram accepted a deleteMessage for. */
  deleted: number;
  /**
   * Deletes Telegram refused this sweep (missing rights, rate limit, a 5xx, or
   * a message past its 48 h delete limit). A transient refusal keeps the row
   * tracked, so the next sweep retries it.
   */
  failed: number;
  /**
   * The part of `failed` whose row SURVIVED the sweep: a transient refusal
   * (rights, kicked bot, 429, 5xx, network) keeps the message tracked, so the
   * next sweep attempts it again. `failed - retrying` were settled for good
   * (already gone, past Telegram's 48 h limit). Optional because a tally
   * stamped before round 31 has no such field — absent reads as 0, never as
   * "everything is retrying".
   */
  retrying?: number;
  /** Why the sweep did nothing, when it did nothing on purpose. */
  skipped: string | null;
}

export interface BotConfig {
  pairingCode?: string;
  pairingExpiresAt?: number;
  webhookSecret: string;
  digestEnabled: boolean;
  alertFanout: boolean;
  soundAlerts: boolean;
  /** /start auto-pair policy — ON (default) = a plain /start links + boots. */
  autoPairOnStart: boolean;
  /**
   * Auto-purge — ON (default): every message the bot posts to a paired chat is
   * tracked and deleted once it is older than `BOT_MESSAGE_TTL_MS` (10
   * minutes), so the board always shows the last ten minutes instead of an
   * unbounded scrollback. Off is the master switch and stops both scopes.
   */
  autoPurge: boolean;
  /**
   * Channel purge — its own scope, ON by default because the channel is a
   * feed, not a record: channel posts older than `CHANNEL_MESSAGE_TTL_MS`
   * (15 min, one session-board cycle) are deleted by the same
   * every-10-minutes sweep. Off leaves the channel alone
   * while chat boards keep purging; `/purge` in a chat never touches channel
   * posts in either position.
   */
  channelPurge: boolean;
  /**
   * Last purge sweep's tally (see `PurgeTelemetry`). Read-only here — the cron
   * stamps it, and `/alerts` plus the app panel only display it.
   */
  purgeLast?: PurgeTelemetry;
  /**
   * When a sweep-fault alert was last SENT, or absent when none is outstanding.
   * The sweep reads it to throttle repeats to `PURGE_ALERT_REPEAT_MS`, and a
   * clean sweep clears it. Never displayed.
   */
  purgeAlertedAt?: number;
  /**
   * How many alerts this fault has sent (1..`PURGE_ALERT_CAP`). The cap is what
   * finally silences a fault that never heals. Absent on a row stamped before
   * round 32, where a set `purgeAlertedAt` still counts as one sent.
   */
  purgeAlertsSent?: number;
  /** When the current fault began — the first failing sweep — for the wording. */
  purgeFaultSince?: number;
  updatedAt: number;
}

/**
 * How long a bot post (chat board, digest, trade alert) lives before the purge
 * sweep deletes it. Ten minutes on purpose: the digest cron runs on the same
 * window, so the sweep deletes a number only AFTER its replacement has been
 * posted — a purge never leaves a chat with nothing.
 */
export const BOT_MESSAGE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a CHANNEL post lives. Deliberately longer than
 * `BOT_MESSAGE_TTL_MS`, because the channel's own producer runs on a different
 * clock: `session-signal` posts the live session board every 15 minutes
 * (crons.ts), so the 10-minute window deleted each board about five minutes
 * before its replacement and left the channel empty for ~5 minutes of every
 * cycle. One full producer cycle (15 min) keeps a board in the channel until a
 * newer one has landed — the 10-minute sweep quantisation means a board is
 * actually removed 11–21 minutes after it posted, never while it is the only
 * board. Chat boards keep the 10-minute window: a chat is a scrollback, the
 * channel is a feed with a slower tick.
 */
export const CHANNEL_MESSAGE_TTL_MS = 15 * 60 * 1000;

/** Which surface a tracked message came from. */
export type BotMessageSource = "bot" | "channel";

/** The row shape a purge sweep needs — the Convex table, minus its `_id`. */
export interface TrackedMessageLite {
  chatId: string;
  messageId: number;
  source: BotMessageSource;
  sentAt: number;
}

/** Cutoff for a sweep at `now`: rows at or before it are due for deletion. */
export function purgeCutoff(now: number, ttlMs: number = BOT_MESSAGE_TTL_MS): number {
  return now - ttlMs;
}

/** One sweep's scope: a chat (or all of them) and one surface (or both). */
export interface PurgeScope {
  cutoff: number;
  chatId?: string;
  source?: BotMessageSource;
}

/**
 * The rows a sweep may delete.
 *
 * Pure on purpose: the window (exactly ten minutes, never a millisecond early),
 * the chat scope (`/purge` clears the chat in front of the operator) and the
 * surface scope (a chat purge must never erase the channel's posts) are pinned
 * by tests without a Convex runtime, and every sweep — cron, `/purge`, panel —
 * shares this one rule.
 */
export function selectPurgeable<T extends TrackedMessageLite>(
  rows: readonly T[],
  scope: PurgeScope,
): T[] {
  return rows.filter(
    (row) =>
      Number.isFinite(row.sentAt) &&
      row.sentAt <= scope.cutoff &&
      (scope.chatId === undefined || row.chatId === scope.chatId) &&
      (scope.source === undefined || row.source === scope.source),
  );
}

/**
 * One line describing the last purge sweep, for `/alerts` and the app panel.
 *
 * Explicit about not knowing: an absent tally reads "not reported yet", and a
 * sweep that did nothing on purpose says why. Neither is ever rendered as
 * "0 deleted", which would read like a healthy sweep that found nothing.
 */
export function purgeTelemetryLine(
  telemetry: PurgeTelemetry | null | undefined,
  now: number,
): string {
  if (!telemetry || !Number.isFinite(telemetry.at)) {
    return "not reported yet — the sweep runs every 10 min";
  }
  const when = fmtAgo(telemetry.at, now);
  const failed = telemetry.failed > 0 ? ` · ${telemetry.failed} failed` : "";
  // Only the part of `failed` that is coming back is called out: a refusal
  // Telegram will never accept again is settled, not a retry backlog.
  const retrying =
    (telemetry.retrying ?? 0) > 0 ? ` · ${telemetry.retrying} retrying` : "";
  // A skipped note is a stand-down, not a replacement for a tally: if a sweep
  // did delete anything, the counts stay in front and the note is appended. A
  // partial sweep must never render as though nothing ran (round 28's
  // "channel purge off" hid real deleted/failed counts this way).
  if (telemetry.skipped) {
    if (telemetry.deleted === 0 && telemetry.failed === 0) {
      return `${when} — skipped (${telemetry.skipped})`;
    }
    return `${when} · ${telemetry.deleted} deleted${failed}${retrying} · ${telemetry.skipped}`;
  }
  return `${when} · ${telemetry.deleted} deleted${failed}${retrying}`;
}

/**
 * Why a sweep stood down COMPLETELY, or null when it had work to do.
 *
 * Blind to `channelPurge` on purpose. Turning the channel scope off leaves the
 * chat sweep running with work of its own; round 28 reported that sweep as
 * "skipped (channel purge off)" and dropped its real tally. The switch state is
 * a config value the boards already show; `skipped` is reserved for sweeps that
 * attempted nothing at all. `channelPurge` is accepted so a caller can hand
 * over the whole switch set and this rule still refuses to call it a skip.
 */
export function purgeSkipNote(input: {
  autoPurge: boolean;
  tokenConfigured: boolean;
  channelPurge?: boolean;
}): string | null {
  if (!input.autoPurge) return "auto-purge off";
  if (!input.tokenConfigured) return "bot token not configured";
  return null;
}

/**
 * How often a PERSISTING sweep fault may re-alert Telegram. The sweep runs
 * every 10 minutes, and an hour-long outage would otherwise push six identical
 * alerts per hour into every linked chat. Matched to the bell's dedupe window
 * in `notifications.recordBotHealthAlert`, so the two channels stay in step.
 */
export const PURGE_ALERT_REPEAT_MS = 60 * 60 * 1000;

/**
 * How many alerts one persisting fault may send before it falls silent.
 *
 * Hourly is survivable for an afternoon; indefinite is not. A bot that lost
 * its rights in a group nobody watches would otherwise ping every linked chat
 * every hour for as long as the row exists. Six alerts covers a working day,
 * and the sixth SAYS it is the last, so silence is never mistaken for a fix.
 * Only a clean sweep resets the count.
 */
export const PURGE_ALERT_CAP = 6;

/** What the wording needs to know about this alert's place in the fault. */
export interface PurgeAlertInfo {
  /** 1-based number of this alert; 1 is the first. */
  number: number;
  /** Alerts this fault may send in total. */
  cap: number;
  /** When the fault began, when the sweep can know it. */
  since: number | null;
}

/** One sweep's alert decision — and the inputs its wording is built from. */
export interface PurgeAlertPlan extends PurgeAlertInfo {
  /** Send an alert now? False covers "not yet", "too soon" and "capped". */
  alert: boolean;
  kind: "silent" | "first" | "repeat" | "capped";
}

/**
 * Decide whether this sweep alerts, and which wording it gets.
 *
 * Two sweeps in a row that could not delete anything Telegram should have
 * accepted are a fault, not a blip: the bot was removed from the chat/channel
 * or lost its delete/admin rights. One failing sweep can be a transient 5xx;
 * the SECOND means the next one will fail the same way.
 *
 * `lastAlertedAt` throttles a fault that DOES persist: the first alert goes out
 * on the second failing sweep, then the next one only after
 * `PURGE_ALERT_REPEAT_MS` — an hour, not six alerts an hour. `alertsSent` then
 * CAPS the whole fault at `PURGE_ALERT_CAP` sends, so a fault that never heals
 * stops talking instead of pinging forever. A clean sweep clears all three
 * inputs, so a new fault is never silenced by the previous one's count.
 *
 * `kind` is part of the result because the wording differs: a first alert
 * explains the usual cause, a repeat must never claim "two sweeps in a row"
 * when the fault is hours old, and the cap's last send has to say it is final.
 */
export function purgeAlertPlan(input: {
  previous?: PurgeTelemetry | null;
  failed: number;
  lastAlertedAt?: number | null;
  alertsSent?: number;
  faultSince?: number | null;
  now?: number;
}): PurgeAlertPlan {
  const cap = PURGE_ALERT_CAP;
  const lastAlertedAt = input.lastAlertedAt ?? null;
  const alerting = lastAlertedAt !== null && Number.isFinite(lastAlertedAt);
  // A round-31 row carries `purgeAlertedAt` but no counter. An outstanding
  // stamp means at least one alert DID go out, so the next one is a repeat —
  // never a fresh "first alert" that resets the cap by migration.
  const sent = Number.isFinite(input.alertsSent)
    ? Math.max(0, Math.floor(input.alertsSent as number))
    : alerting
      ? 1
      : 0;
  const since =
    input.faultSince !== undefined &&
    input.faultSince !== null &&
    Number.isFinite(input.faultSince)
      ? input.faultSince
      : input.previous && Number.isFinite(input.previous.at)
        ? input.previous.at
        : null;
  const silent: PurgeAlertPlan = {
    alert: false,
    kind: "silent",
    number: Math.min(sent + 1, cap),
    cap,
    since,
  };
  if (!(input.failed > 0)) return silent;
  if (!((input.previous?.failed ?? 0) > 0)) return silent;
  if (sent >= cap) return { ...silent, kind: "capped", number: cap };
  const now = input.now;
  if (
    alerting &&
    now !== undefined &&
    Number.isFinite(now) &&
    now - (lastAlertedAt as number) < PURGE_ALERT_REPEAT_MS
  ) {
    return silent;
  }
  return {
    alert: true,
    kind: sent === 0 ? "first" : "repeat",
    number: sent + 1,
    cap,
    since,
  };
}

/**
 * Telegram's verdict on a refused `deleteMessage` — and therefore on whether
 * the tracking row survives.
 *
 * `permanent`: the message can never be deleted (already gone, past the 48 h
 * delete limit, or Telegram marks the id invalid) — the row is dropped so no
 * future sweep re-counts it. `transient`: the refusal is a condition that can
 * heal — missing rights, a kicked bot, a rate limit, a 5xx or a network error —
 * so the row stays tracked and the next sweep retries it. Guessing the other
 * way either loses a live message or retries a dead one forever.
 */
export function classifyPurgeFailure(description: string): "permanent" | "transient" {
  const d = description.toLowerCase();
  if (
    d.includes("message to delete not found") ||
    d.includes("message can't be deleted") ||
    d.includes("message cannot be deleted") ||
    d.includes("message is too old") ||
    d.includes("message_id_invalid") ||
    d.includes("message id is invalid")
  ) {
    return "permanent";
  }
  return "transient";
}

/**
 * The fault's plain-text body — shared by the Telegram alert and the in-app
 * bell entry, so both channels tell the same story from the same numbers.
 *
 * `alert` decides the opening. A first alert (or no info at all) explains the
 * two-sweep trigger and the usual cause; a repeat says which repeat it is and
 * how long the fault has run, because "two sweeps in a row" is simply false on
 * the fourth hourly ping. Repeats also drop the cause line — it was in the
 * first alert, and an hourly repetition is what makes the alert easy to mute.
 * The cap's last send states that no further alert will come.
 */
export function purgeFailureSummary(
  previous: PurgeTelemetry | null | undefined,
  current: PurgeTelemetry,
  now: number,
  alert?: PurgeAlertInfo,
): string {
  const retrying = current.retrying ?? 0;
  const line = (label: string, t: PurgeTelemetry) => {
    const held = (t.retrying ?? 0) > 0 ? ` · ${t.retrying} retrying` : "";
    return `${label}: ${fmtAgo(t.at, now)} · ${t.deleted} deleted · ${t.failed} failed${held}`;
  };
  const number = alert?.number ?? 1;
  const repeat = number > 1;
  const since = alert?.since ?? null;
  const opening = repeat
    ? `The sweep is still failing — repeat alert ${number} of ${alert?.cap ?? PURGE_ALERT_CAP}${since !== null && Number.isFinite(since) ? `, failing for ${fmtDuration(now - since)}` : ""}.`
    : "Two sweeps in a row could not delete messages from Telegram.";
  const last = repeat && number >= (alert?.cap ?? PURGE_ALERT_CAP);
  return [
    opening,
    ...(previous ? [`• ${line("Previous", previous)}`] : []),
    `• ${line("Latest", current)}`,
    ...(repeat
      ? []
      : ["Usual cause: the bot was removed from the chat/channel, or lost its delete/admin rights."]),
    retrying > 0
      ? `${retrying} refused message${retrying === 1 ? " is" : "s are"} still tracked and will be retried on the next sweep; only messages Telegram will never accept a delete for are dropped.`
      : "Refused messages stay tracked, so the next sweep retries them once the rights are back; only messages Telegram will never accept a delete for are dropped.",
    ...(last
      ? [
          `This is the last automatic alert for this fault. Sweeps keep retrying, and /alerts keeps showing the tally until one succeeds.`,
        ]
      : []),
  ].join("\n");
}

/** The fault alert for linked chats: a bold header over the shared summary. */
export function purgeFailureAlert(
  previous: PurgeTelemetry | null | undefined,
  current: PurgeTelemetry,
  now: number,
  alert?: PurgeAlertInfo,
): string {
  const header =
    (alert?.number ?? 1) > 1
      ? "⚠️ **Message sweep still failing**"
      : "⚠️ **Message sweep is failing**";
  return [header, "", purgeFailureSummary(previous, current, now, alert)].join("\n");
}

/** Telegram inline-keyboard button shape (url vs callback). */
export interface TgButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type TgKeyboard = TgButton[][];

/** A parsed Telegram webhook update — only the fields the bot consumes. */
export interface TgUpdate {
  updateId: number;
  chatId: string | null;
  fromId: string | null;
  fromName: string | null;
  username: string | null;
  text: string | null;
  callbackId: string | null;
  callbackData: string | null;
}

/** Parse a raw Telegram update object (as posted to the webhook). */
export function parseTgUpdate(raw: unknown): TgUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const updateId = typeof u.update_id === "number" ? u.update_id : 0;

  const msg = (u.message ?? u.edited_message) as Record<string, unknown> | undefined;
  const cb = u.callback_query as Record<string, unknown> | undefined;

  let chatId: string | null = null;
  let fromId: string | null = null;
  let fromName: string | null = null;
  let username: string | null = null;
  let text: string | null = null;
  let callbackId: string | null = null;
  let callbackData: string | null = null;

  if (msg) {
    const chat = msg.chat as Record<string, unknown> | undefined;
    chatId = chat && typeof chat.id === "number" ? String(chat.id) : null;
    const from = msg.from as Record<string, unknown> | undefined;
    fromId = from && typeof from.id === "number" ? String(from.id) : null;
    fromName =
      (typeof from?.first_name === "string" ? from.first_name : null) ??
      (typeof from?.username === "string" ? `@${from.username}` : null);
    username = typeof from?.username === "string" ? from.username : null;
    text = typeof msg.text === "string" ? msg.text : null;
  }
  if (cb) {
    callbackId = typeof cb.id === "string" ? cb.id : null;
    const msg2 = cb.message as Record<string, unknown> | undefined;
    const chat2 = msg2?.chat as Record<string, unknown> | undefined;
    chatId = chatId ?? (chat2 && typeof chat2.id === "number" ? String(chat2.id) : null);
    const from2 = cb.from as Record<string, unknown> | undefined;
    fromId = fromId ?? (from2 && typeof from2.id === "number" ? String(from2.id) : null);
    fromName =
      fromName ??
      (typeof from2?.first_name === "string" ? from2.first_name : null);
    username = username ?? (typeof from2?.username === "string" ? from2.username : null);
    callbackData = typeof cb.data === "string" ? cb.data : null;
  }

  if (!chatId) return null;
  return { updateId, chatId, fromId, fromName, username, text, callbackId, callbackData };
}

// ---------------------------------------------------------------------------
// Identity + auth responses
// ---------------------------------------------------------------------------

/** Bot username stamped at build time is unknown here — the menu links use
 * t.me deep links that resolve via the bot token at runtime (backend). */
export function startMessage(): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "⚡ **FlashBolt Operator Bot**",
      "",
      "The full FlashBolt terminal in your pocket — dashboards, live feed,",
      "flash-loan controls, sniper settings and the complete Trade exchange.",
      "",
      "🔒 This bot mirrors the app **for the operator only**.",
      "Pair this chat with the code from the app's Account menu → Telegram Bot.",
      "",
      "Type /help to see every command.",
    ].join("\n"),
    keyboard: [
      [{ text: "🚀 START", callback_data: "cmd:/bnb_on" }],
      [{ text: "🔗 Pair this chat", callback_data: "pair:start" }],
      [{ text: "🧭 Main menu", callback_data: "menu:main" }],
      [{ text: "❓ Help", callback_data: "help:main" }],
    ],
  };
}

export function helpMessage(): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "📚 **FlashBolt Bot — every command**",
      "",
      "🧭 **Navigation**",
      "/menu — main menu (everything below)",
      "/dashboard — live session + AI score + fleet",
      "/status — terminal state, bot, mode, wallets",
      "/engines — 24/7 server engine board (scan + sniper, BNB/SOL)",
      "",
      "⚡ **BNB FlashBolt (flash-loan terminal)**",
      "/bnb — BNB dashboard & controls",
      "/bnb_on · /bnb_off — start/stop the scanner bot",
      "/bnb_paper · /bnb_live — switch paper/live mode",
      "/bnb_scan — run a live feed scan now",
      "/routes — top live arbitrage routes right now",
      "/execs — recent executions trail",
      "/pnl — live on-chain PnL summary",
      "",
      "☀️ **SOL FlashBolt (sniper/flasher)**",
      "/sol — SOL dashboard & controls",
      "/sol_on · /sol_off — start/stop the SOL bot",
      "/sol_scan — refresh the SOL feed",
      "",
      "💱 **FlashBolt Trade (exchange)**",
      "/trade — trade dashboard (balances, earn, orders)",
      "/balance — asset balances (crypto + cash, live prices)",
      "/withdraw — withdrawal balances + recent withdrawals",
      "/prices — live market prices",
      "/markets — top market pairs",
      "/txs — recent transactions",
      "/orders — open limit orders",
      "/earn — earn plans",
      "/claim — claim flexible-earn interest",
      "",
      "🛡 **Control & safety**",
      "/engine — 24/7 engine board (alias of /engines)",
      "/settings — strategy & engine parameters (live values)",
      "/amount — position sizing (loan cap, buys, targets)",
      "/deploy — contract deployment & live-readiness status",
      "/stop — stop BOTH engines (BNB + SOL)",
      "/panic — emergency stop: engines off + paper mode",
      "",
      "🔔 **Alerts & settings**",
      "/alerts — trade-alert fanout settings",
      "/digest — scheduled dashboard digest on/off",
      "/sound — notification sound on/off",
      "/silence — mute this chat",
      "/purge — delete the bot's messages in this chat now",
      "/unpair — unlink this chat",
      "",
      "🗄 **Data & storage**",
      "Daily auto-retention: bell history 30d · paper trades 30d (totals kept) · signal log 7d",
      "Kept forever: trade ledger, live on-chain trades, accounts, licenses & alerts",
      "Bot + channel messages auto-purge every 10 minutes (toggle on /alerts)",
      "",
      "ℹ️ /help — this list",
    ].join("\n"),
    keyboard: [
      [
        { text: "🧭 Menu", callback_data: "menu:main" },
        { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
      ],
      [
        { text: "⚡ BNB", callback_data: "cmd:/bnb" },
        { text: "☀️ SOL", callback_data: "cmd:/sol" },
        { text: "💱 Trade", callback_data: "cmd:/trade" },
      ],
    ],
  };
}

export function unlinkedMessage(): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🔒 **Not paired yet**",
      "",
      "This bot mirrors the operator's FlashBolt app. Pair this chat first:",
      "",
      "1️⃣ Open the app → Account menu → **Telegram Bot**",
      "2️⃣ Copy the pairing code shown there",
      "3️⃣ Send it here (or tap the button below)",
    ].join("\n"),
    keyboard: [[{ text: "🔗 Pair with code", callback_data: "pair:start" }]],
  };
}

export function pairPrompt(): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🔗 **Pairing**",
      "",
      "Send the pairing code exactly as shown in the app:",
      "Account menu → **Telegram Bot** → copy code.",
      "",
      "The code is valid for a short window and rotates every time you refresh it.",
    ].join("\n"),
    keyboard: [[{ text: "↩︎ Main menu", callback_data: "menu:main" }]],
  };
}

export function pairedMessage(title: string | null): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "✅ **Paired!**",
      "",
      `This chat is now linked to the FlashBolt operator console${title ? ` (${title})` : ""}.`,
      "Everything the app does is available here — start with /menu or tap START.",
    ].join("\n"),
    keyboard: [
      [
        { text: "🚀 START", callback_data: "cmd:/bnb_on" },
        { text: "🧭 Main menu", callback_data: "menu:main" },
      ],
      [
        { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
        { text: "⚡ BNB", callback_data: "cmd:/bnb" },
        { text: "💱 Trade", callback_data: "cmd:/trade" },
      ],
    ],
  };
}

/**
 * /start boot confirmation — sent after the chat is linked AND the scanner
 * engine has been engaged server-side. The bot IS the app from here on:
 * every process below mirrors the real terminal, on the server heartbeat,
 * with the web app open or closed.
 */
export function bootMessage(
  mode: "paper" | "live",
  chainKey?: string,
): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🚀 **FlashBolt console booted**",
      "",
      "The full app is now running from this chat — no code, no extra steps:",
      `• Scanner engine ENGAGED (${(chainKey ?? "bsc").toUpperCase()} · ${mode} mode) and self-driving on the server heartbeat`,
      "• Runs with the app open or closed — the engine loop is server-side",
      "• Every dashboard, control and the full Trade exchange mirrors below",
      "",
      "Everything here is live data — nothing simulated.",
    ].join("\n"),
    keyboard: [
      [
        { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
        { text: "🔄 Scan now", callback_data: "cmd:/bnb_scan" },
      ],
      [
        { text: "🛣 Routes", callback_data: "cmd:/routes" },
        { text: "🧾 Execs", callback_data: "cmd:/execs" },
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
      ],
      [
        { text: "⚡ BNB", callback_data: "cmd:/bnb" },
        { text: "☀️ SOL", callback_data: "cmd:/sol" },
        { text: "💱 Trade", callback_data: "cmd:/trade" },
      ],
      [
        { text: "⏹ STOP", callback_data: "cmd:/bnb_off" },
        { text: "🧭 Menu", callback_data: "menu:main" },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Main menu + dashboards
// ---------------------------------------------------------------------------

export function mainMenu(): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🧭 **FlashBolt — main menu**",
      "",
      "Pick a section. Every command below mirrors the real app.",
    ].join("\n"),
    keyboard: [
      [
        { text: "🚀 START BNB", callback_data: "cmd:/bnb_on" },
        { text: "⏹ STOP BNB", callback_data: "cmd:/bnb_off" },
      ],
      [
        { text: "☀️ START SOL", callback_data: "cmd:/sol_on" },
        { text: "⏹ STOP SOL", callback_data: "cmd:/sol_off" },
      ],
      [
        { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
        { text: "📋 Status", callback_data: "cmd:/status" },
        { text: "⚙️ Engines", callback_data: "cmd:/engines" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
        { text: "📦 Deploy", callback_data: "cmd:/deploy" },
      ],
      [
        { text: "💰 Balance", callback_data: "cmd:/balance" },
        { text: "🔢 Amounts", callback_data: "cmd:/amount" },
        { text: "🏧 Withdraw", callback_data: "cmd:/withdraw" },
      ],
      [{ text: "🛑 Panic stop", callback_data: "cmd:/panic" }],
      [
        { text: "⚡ BNB FlashBolt", callback_data: "cmd:/bnb" },
        { text: "☀️ SOL FlashBolt", callback_data: "cmd:/sol" },
      ],
      [{ text: "💱 FlashBolt Trade", callback_data: "cmd:/trade" }],
      [
        { text: "🛣 Routes", callback_data: "cmd:/routes" },
        { text: "🧾 Executions", callback_data: "cmd:/execs" },
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
      ],
      [
        { text: "💱 Prices", callback_data: "cmd:/prices" },
        { text: "🧮 Orders", callback_data: "cmd:/orders" },
        { text: "🏦 Earn", callback_data: "cmd:/earn" },
      ],
      [
        { text: "🔔 Alerts", callback_data: "cmd:/alerts" },
        { text: "⚙️ Sound", callback_data: "cmd:/sound" },
      ],
      [{ text: "❓ Help", callback_data: "help:main" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

export function fmtNum(n: number, maxFrac = 4): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(2, maxFrac) });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * A span in words for "failing for …": "45m", "2h 10m", "3d 4h". No "ago"
 * suffix — the sentence already supplies the tense, and "failing for 2h ago"
 * is the kind of copy bug this helper exists to prevent.
 */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Dashboards and alerts get sound only when both chat and config allow it. */
export function disableNotification(chat: Pick<BotChat, "silent">, cfg: Pick<BotConfig, "soundAlerts">): boolean {
  return chat.silent || !cfg.soundAlerts;
}

// ---------------------------------------------------------------------------
// Dashboard builders — real backend data in, message out
// ---------------------------------------------------------------------------

export interface SessionLite {
  primary?: { label: string; flag: string; windowLabel: string } | null;
  regime: string;
  openKeys: string[];
  nextChangeLabel: string;
  nextChangeKind: "open" | "close";
  nextChangeAt: number;
  now: number;
}

export interface MetricsLite {
  activeTerminals: number;
  runningBots: number;
  executionsToday: number;
  successesToday: number;
  winRate: number;
  pnlToday: number;
  lifetimePnl: number;
  openOpportunities: number;
  scansToday: number;
  liveCount: number;
  networks: { mainnet: number; testnet: number };
  chains: string[];
}

export interface AiScoreLite {
  score: number;
  rating: string;
  dispersion: number;
  routeCount: number;
  avgEdge: number;
  totalLiq: number;
  totalVol: number;
  gasGwei: number | null;
}

export function dashboardMessage(
  session: SessionLite,
  score: AiScoreLite,
  metrics: MetricsLite,
): { text: string; keyboard: TgKeyboard } {
  const primary = session.primary;
  const primaryLine = primary
    ? `${primary.flag} ${primary.label} OPEN (${primary.windowLabel})`
    : "🌙 All market sessions closed";
  const mins = Math.max(0, Math.round((session.nextChangeAt - session.now) / 60000));
  const nextIn = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return {
    text: [
      "⚡ **FlashBolt Dashboard**",
      "",
      primaryLine,
      `Regime: ${session.regime}`,
      `⏭ ${session.nextChangeLabel} ${session.nextChangeKind === "open" ? "opens" : "closes"} in ${nextIn}`,
      "",
      `📊 AI Market Score: **${score.score}/100 — ${score.rating}**`,
      `• Dispersion ${score.dispersion.toFixed(2)}% · routes ${score.routeCount}`,
      `• Avg edge +${score.avgEdge.toFixed(2)}% · liq ${fmtUsd(score.totalLiq)} · vol ${fmtUsd(score.totalVol)}`,
      `• Gas ${score.gasGwei == null ? "—" : `${score.gasGwei.toFixed(1)} gwei`}`,
      "",
      "🕸 **Fleet**",
      `• Terminals ${metrics.activeTerminals} · bots ${metrics.runningBots} · live ${metrics.liveCount}`,
      `• Executions today ${metrics.executionsToday} · wins ${metrics.successesToday} (${metrics.winRate}%)`,
      `• PnL today +${fmtNum(metrics.pnlToday)} · lifetime +${fmtNum(metrics.lifetimePnl)}`,
      `• Opportunities ${metrics.openOpportunities} · scans ${metrics.scansToday}`,
      `• Networks ${metrics.networks.mainnet} mainnet / ${metrics.networks.testnet} testnet · chains ${metrics.chains.length}`,
    ].join("\n"),
    keyboard: [
      [
        { text: "🛣 Routes", callback_data: "cmd:/routes" },
        { text: "🧾 Execs", callback_data: "cmd:/execs" },
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
      ],
      [
        { text: "⚡ BNB", callback_data: "cmd:/bnb" },
        { text: "☀️ SOL", callback_data: "cmd:/sol" },
        { text: "💱 Trade", callback_data: "cmd:/trade" },
      ],
      [{ text: "🔄 Refresh", callback_data: "cmd:/dashboard" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// BNB / SOL terminal builders
// ---------------------------------------------------------------------------

export interface TerminalStateLite {
  botRunning: boolean;
  /** Independent SOL bot switch — stopping BNB never stops SOL (and vice versa). */
  solBotRunning?: boolean;
  mode: "paper" | "live";
  /** Armed for on-chain execution: a FlashBoltArbitrage contract is deployed. */
  contractDeployed: boolean;
  /** contractDeployed AND at least one signing wallet connected. */
  liveReady: boolean;
  balance: number;
  lifetimePnl: number;
  executionsToday: number;
  successesToday: number;
  successRate: number;
  scansToday: number;
  openOpportunities: number;
  minProfit: number;
  maxLoan: number;
  maxHops: number;
  slippage: number;
  gasPriority: string;
  autoPayout: boolean;
  mevGuard: boolean;
  privateSubmit: boolean;
  lenderBalancer: boolean;
  cadence: number;
  network: string;
  chainKey: string;
  dailyArbTarget: number;
  connectedWallets: string[];
  solNetwork?: string;
  solBuyAmountSol?: number;
  solSellAmountPct?: number;
  solSlippagePct?: number;
  solProfitTargetPct?: number;
  solTrailingStopPct?: number;
  solMinLiquidityUsd?: number;
}

export function bnbMessage(s: TerminalStateLite): { text: string; keyboard: TgKeyboard } {
  const sym = s.chainKey === "bsc" ? "BNB" : "ETH/AVAX";
  return {
    text: [
      "⚡ **BNB FlashBolt**",
      "",
      `🤖 Bot: ${s.botRunning ? "🟢 RUNNING" : "🔴 stopped"} · Mode: ${s.mode === "live" ? "🔴 LIVE" : "📄 paper"}`,
      `🌐 Network: ${s.network} · Chain: ${s.chainKey}`,
      `💵 Balance: ${fmtNum(s.balance)} ${sym} · Lifetime PnL +${fmtNum(s.lifetimePnl)}`,
      `📈 Today: ${s.executionsToday} execs · ${s.successesToday} wins (${s.successRate}%) · scans ${s.scansToday}`,
      `🎯 Opportunities: ${s.openOpportunities}`,
      "",
      "**Strategy**",
      `• Min profit ${s.minProfit}% · max loan ${fmtNum(s.maxLoan, 2)} ${sym} · ${s.maxHops} hops`,
      `• Slippage ${s.slippage}% · gas ${s.gasPriority} · cadence ${s.cadence}s`,
      `• Auto-payout ${s.autoPayout ? "✅" : "❌"} · MEV guard ${s.mevGuard ? "✅" : "❌"} · private submit ${s.privateSubmit ? "✅" : "❌"}`,
      `• Lender balancer ${s.lenderBalancer ? "✅" : "❌"} · daily target ${s.dailyArbTarget === 0 ? "∞" : s.dailyArbTarget}`,
      `• Wallets: ${s.connectedWallets.length ? s.connectedWallets.join(", ") : "none connected"}`,
      `• Live execution: ${s.liveReady ? "🟢 READY — contract + wallet armed" : s.contractDeployed ? "🟠 contract armed, no wallet connected" : "🟠 not armed — deploy contract + connect wallet in the app"}`,
    ].join("\n"),
    keyboard: [
      [
        s.botRunning
          ? { text: "⏹ Stop bot", callback_data: "cmd:/bnb_off" }
          : { text: "▶️ Start bot", callback_data: "cmd:/bnb_on" },
        { text: "🔄 Scan now", callback_data: "cmd:/bnb_scan" },
      ],
      [
        s.mode === "paper"
          ? { text: "🔴 Switch LIVE", callback_data: "cmd:/bnb_live" }
          : { text: "📄 Switch paper", callback_data: "cmd:/bnb_paper" },
      ],
      [
        { text: "🛣 Routes", callback_data: "cmd:/routes" },
        { text: "🧾 Execs", callback_data: "cmd:/execs" },
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function solMessage(s: TerminalStateLite): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "☀️ **SOL FlashBolt**",
      "",
      `🤖 Bot: ${(s.solBotRunning ?? s.botRunning) ? "🟢 RUNNING" : "🔴 stopped"} · Network: ${s.solNetwork ?? "mainnet"}`,
      `💵 Balance: ${fmtNum(s.balance)} SOL · Lifetime PnL +${fmtNum(s.lifetimePnl)}`,
      "",
      "**Sniper settings**",
      `• Buy ${fmtNum(s.solBuyAmountSol ?? 0, 3)} SOL · sell ${fmtNum(s.solSellAmountPct ?? 0, 0)}%`,
      `• Slippage ${fmtNum(s.solSlippagePct ?? 0, 1)}% · profit target ${fmtNum(s.solProfitTargetPct ?? 0, 1)}%`,
      `• Trailing stop ${fmtNum(s.solTrailingStopPct ?? 0, 1)}% · min liq ${fmtUsd(s.solMinLiquidityUsd ?? 0)}`,
      `• Wallets imported: ${s.connectedWallets.length}`,
      `• Live execution: ${s.liveReady ? "🟢 READY" : "🟠 not armed — import a wallet in the app"}`,
    ].join("\n"),
    keyboard: [
      [
        (s.solBotRunning ?? s.botRunning)
          ? { text: "⏹ Stop bot", callback_data: "cmd:/sol_off" }
          : { text: "▶️ Start bot", callback_data: "cmd:/sol_on" },
        { text: "🔄 Scan now", callback_data: "cmd:/sol_scan" },
      ],
      [
        { text: "🧾 Execs", callback_data: "cmd:/execs" },
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Engine board — the four 24/7 server engines (BNB/SOL scan + sniper),
// their own switches and their OWN freshness stamps, honestly rendered.
// ---------------------------------------------------------------------------

export interface EngineStamp {
  at: number | null;
  source: "client" | "server" | null;
}

/**
 * The 24/7 engine board. `running` is the PERSISTED per-chain bot switch —
 * the operator's intent — while `fresh`/`ago` report the engine loop's own
 * latest pass so a stale heartbeat is visible instead of hidden. An engine
 * whose switch is ON but that has never stamped shows honestly as
 * "starting…" (client drivers stamp on their first pass).
 */
export function enginesMessage(
  running: { bnb: boolean; sol: boolean },
  stamps: {
    bnbScan: EngineStamp;
    solScan: EngineStamp;
    bnbSniper: EngineStamp;
    solSniper: EngineStamp;
  },
  now: number,
): { text: string; keyboard: TgKeyboard } {
  const line = (name: string, on: boolean, st: EngineStamp): string => {
    const sw = on ? "🟢 ON" : "🔴 OFF";
    if (!st.at) return `• ${name}: ${sw} · starting…`;
    const drv = st.source === "server" ? "engine" : st.source === "client" ? "app" : "—";
    return `• ${name}: ${sw} · last pass ${fmtAgo(st.at, now)} (${drv})`;
  };
  return {
    text: [
      "⚙️ **FlashBolt engines — 24/7 server autonomy**",
      "",
      "These loops run on the Convex servers with the app closed:",
      line("BNB scanner", running.bnb, stamps.bnbScan),
      line("SOL scanner", running.sol, stamps.solScan),
      line("BNB sniper", running.bnb, stamps.bnbSniper),
      line("SOL sniper", running.sol, stamps.solSniper),
      "",
      "Per-minute heartbeat revives any stopped loop; the 10-minute",
      "self-heal keeps the webhook registered. Switches are per-chain:",
      "each engine stands down only when its own chain is stopped.",
    ].join("\n"),
    keyboard: [
      [
        { text: running.bnb ? "⏹ Stop BNB" : "▶️ Start BNB", callback_data: running.bnb ? "cmd:/bnb_off" : "cmd:/bnb_on" },
        { text: running.sol ? "⏹ Stop SOL" : "▶️ Start SOL", callback_data: running.sol ? "cmd:/sol_off" : "cmd:/sol_on" },
      ],
      [
        { text: "⚙️ Refresh", callback_data: "cmd:/engines" },
        { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Routes / executions / PnL builders
// ---------------------------------------------------------------------------

export interface RouteLite {
  id: string;
  legs: string[];
  profitPct: number;
  lender: string;
  liquidityUsd: number;
  loanAsset?: string;
  netProfitPct?: number;
}

export function routesMessage(
  live: RouteLite[],
  generated: RouteLite[],
): { text: string; keyboard: TgKeyboard } {
  const line = (r: RouteLite) =>
    `• ${r.legs.join(" → ")} — +${(r.netProfitPct ?? r.profitPct).toFixed(2)}% ${r.lender} · ${fmtUsd(r.liquidityUsd)}`;
  const liveRows = live.slice(0, 6);
  const genRows = generated.slice(0, 6);
  return {
    text: [
      "🛣 **Live arbitrage routes**",
      "",
      liveRows.length ? "**LIVE (real feed, above floor)**" : "No live routes above the floor right now.",
      ...liveRows.map(line),
      "",
      genRows.length ? "**GENERATED (triangular scan)**" : "No generated routes this pass.",
      ...genRows.map(line),
      "",
      "_Live data from the same feed the terminal scans._",
    ].join("\n"),
    keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "cmd:/routes" },
        { text: "⚡ BNB", callback_data: "cmd:/bnb" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export interface ExecutionLite {
  label: string;
  status: string;
  amountBnb: number;
  profitPct: number;
  ts: number;
  chain?: string;
  txHash?: string;
}

export type ExecFilter = "all" | "live" | "sim";

export function executionsMessage(
  rows: ExecutionLite[],
  now: number,
  filter: ExecFilter = "all",
  split?: { liveTotal: number; simTotal: number },
): { text: string; keyboard: TgKeyboard } {
  const icon = (s: string) => (s === "success" ? "✅" : s === "failed" ? "❌" : s === "blocked" ? "🛡" : "⏳");
  // Filter honestly: LIVE = has an on-chain tx hash; SIM = paper/simulated
  // (no txHash — nothing was ever broadcast on-chain).
  const visible =
    filter === "live"
      ? rows.filter((r) => Boolean(r.txHash))
      : filter === "sim"
        ? rows.filter((r) => !r.txHash)
        : rows;
  const next: ExecFilter = filter === "all" ? "live" : filter === "live" ? "sim" : "all";
  const nextLabel = next === "all" ? "All" : next === "live" ? "Live ⛓" : "SIM 🧪";
  const header =
    filter === "all"
      ? "🧾 **Recent executions**"
      : filter === "live"
        ? "⛓ **Live executions** (on-chain only)"
        : "🧪 **SIM executions** (paper · no on-chain footprint)";
  // Global live/SIM split line (same bar as /pnl) whenever totals are given.
  const splitLine = split ? execSplitBar(split.liveTotal, split.simTotal) : null;
  return {
    text: [
      header,
      ...(splitLine ? [splitLine, ""] : [""]),
      ...(visible.length
        ? visible
            .slice(0, 12)
            .map(
              (r) =>
                `${icon(r.status)} ${r.chain === "solana" ? "SOL" : "BNB"} +${r.amountBnb.toFixed(4)} · +${r.profitPct.toFixed(2)}% · ${fmtAgo(r.ts, now)}${r.txHash ? `\n   \`${r.txHash.slice(0, 18)}…\`` : ""}`,
            )
        : [filter === "sim" ? "No SIM executions yet — run the scanner in paper mode." : "No executions yet."]),
    ].join("\n"),
    keyboard: [
      [
        { text: `🔎 Filter: ${nextLabel}`, callback_data: `cmd:/${next === "all" ? "execs" : "execs@" + next}` },
        { text: "🔄 Refresh", callback_data: `cmd:/${filter === "all" ? "execs" : "execs@" + filter}` },
      ],
      [
        { text: "💰 PnL", callback_data: "cmd:/pnl" },
        { text: "🧭 Menu", callback_data: "menu:main" },
      ],
    ],
  };
}

export interface PnlLite {
  liveCount: number;
  wins: number;
  grossProfit: number;
  gasBurned: number;
  netPnl: number;
  live24h: number;
  wins24h: number;
  net24h: number;
  solLiveCount: number;
  solWins: number;
  solGrossProfit: number;
  solGasBurned: number;
  solNetPnl: number;
  solLive24h: number;
  solWins24h: number;
  solNet24h: number;
  /** SIM (paper) roll-up — executions with no on-chain txHash. */
  simCount: number;
  simWins: number;
  simGross: number;
  simCredited: number;
  simNet: number;
}

/**
 * Live-vs-SIM split bar (shared by /pnl and /execs) — a 10-slot block bar
 * (▓ = on-chain live, ░ = paper SIM) in a code span so it aligns in every
 * Telegram client. Honest zero state: with no executions the bar stays empty.
 */
export function execSplitBar(live: number, sim: number): string {
  const total = live + sim;
  if (total <= 0) return "`░░░░░░░░░░` no executions yet";
  const slots = 10;
  const liveBlocks = Math.min(slots, Math.round((live / total) * slots));
  const bar = "▓".repeat(liveBlocks) + "░".repeat(slots - liveBlocks);
  const pct = Math.round((live / total) * 100);
  return `\`${bar}\` ${pct}% ⛓ on-chain · ${live} live / ${sim} 🧪 SIM`;
}

export function pnlMessage(p: PnlLite, filter: ExecFilter = "all"): { text: string; keyboard: TgKeyboard } {
  const next: ExecFilter = filter === "all" ? "live" : filter === "live" ? "sim" : "all";
  const nextLabel = next === "all" ? "All" : next === "live" ? "Live ⛓" : "SIM 🧪";
  const header =
    filter === "all"
      ? "💰 **PnL — all executions**"
      : filter === "live"
        ? "⛓ **Live on-chain PnL**"
        : "🧪 **SIM PnL** (paper · eth\_simulation)";
  // The split is global (BNB live + SOL live vs paper) in every view.
  const splitLine = execSplitBar(p.liveCount + p.solLiveCount, p.simCount);
  const body =
    filter === "sim"
      ? [
          `• SIM executions ${p.simCount} · wins ${p.simWins}`,
          `• Simulated gross +${fmtNum(p.simGross)} · paper bankroll +${fmtNum(p.simCredited)}`,
          `• **SIM net +${fmtNum(p.simNet)}** (no on-chain footprint)`,
        ]
      : filter === "live"
        ? [
            "**BNB FlashBolt**",
            `• Live txs ${p.liveCount} · wins ${p.wins}`,
            `• Gross +${fmtNum(p.grossProfit)} · gas −${fmtNum(p.gasBurned)}`,
            `• **Net +${fmtNum(p.netPnl)}**`,
            `• 24h: ${p.live24h} txs · ${p.wins24h} wins · net +${fmtNum(p.net24h)}`,
            "",
            "**SOL FlashBolt**",
            `• Live txs ${p.solLiveCount} · wins ${p.solWins}`,
            `• Gross +${fmtNum(p.solGrossProfit)} · gas −${fmtNum(p.solGasBurned)}`,
            `• **Net +${fmtNum(p.solNetPnl)}**`,
            `• 24h: ${p.solLive24h} txs · ${p.solWins24h} wins · net +${fmtNum(p.solNet24h)}`,
          ]
        : [
            "**BNB FlashBolt**",
            `• Live txs ${p.liveCount} · wins ${p.wins}`,
            `• Gross +${fmtNum(p.grossProfit)} · gas −${fmtNum(p.gasBurned)}`,
            `• **Net +${fmtNum(p.netPnl)}**`,
            `• 24h: ${p.live24h} txs · ${p.wins24h} wins · net +${fmtNum(p.net24h)}`,
            "",
            "**SOL FlashBolt**",
            `• Live txs ${p.solLiveCount} · wins ${p.solWins}`,
            `• Gross +${fmtNum(p.solGrossProfit)} · gas −${fmtNum(p.solGasBurned)}`,
            `• **Net +${fmtNum(p.solNetPnl)}**`,
            `• 24h: ${p.solLive24h} txs · ${p.solWins24h} wins · net +${fmtNum(p.solNet24h)}`,
            "",
            `**🧪 SIM (paper)** — ${p.simCount} execs · net +${fmtNum(p.simNet)}`,
          ];
  return {
    text: [header, splitLine, "", ...body].join("\n"),
    keyboard: [
      [
        { text: `🔎 Filter: ${nextLabel}`, callback_data: `cmd:/${next === "all" ? "pnl" : "pnl@" + next}` },
        { text: "🔄 Refresh", callback_data: `cmd:/${filter === "all" ? "pnl" : "pnl@" + filter}` },
      ],
      [
        { text: "🧾 Execs", callback_data: "cmd:/execs" },
        { text: "🧭 Menu", callback_data: "menu:main" },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// FlashBolt Trade builders
// ---------------------------------------------------------------------------

export interface BalanceLite {
  kind: "crypto" | "cash";
  asset: string;
  available: number;
  locked: number;
}

export interface EarnPlanLite {
  kind: string;
  asset: string;
  principal: number;
  apyPct: number;
  accrued: number;
  status: string;
  startedAt: number;
}

export interface OrderLite {
  side: string;
  base: string;
  quote: string;
  price: number;
  amount: number;
  filled: number;
  status: string;
  ts: number;
}

export interface TxLite {
  direction: string;
  asset: string;
  amount: number;
  status: string;
  ref: string;
  ts: number;
}

const CASH_SYM: Record<string, string> = {
  NGN: "₦",
  USD: "$",
  EUR: "€",
  GBP: "£",
  GHS: "GH₵",
  KES: "KSh",
  XAF: "FCFA",
};

export function tradeSymbol(asset: string): string {
  return CASH_SYM[asset] ?? "";
}

export function tradeMessage(
  balances: BalanceLite[],
  earn: { activePlans: number; activeAccrued: number; interestEarned: number },
  prices: Record<string, { usd: number; change24hPct: number }> | null,
): { text: string; keyboard: TgKeyboard } {
  const crypto = balances.filter((b) => b.kind === "crypto");
  const cash = balances.filter((b) => b.kind === "cash");
  const row = (b: BalanceLite) => {
    const sym = tradeSymbol(b.asset);
    const price = prices?.[b.asset]?.usd;
    const usd = price ? ` (~${fmtUsd(b.available * price)})` : "";
    return `• ${b.asset}: ${fmtNum(b.available, b.kind === "cash" ? 2 : 6)}${sym}${usd}${b.locked > 0 ? ` · 🔒${fmtNum(b.locked, 2)} locked` : ""}`;
  };
  const updown = (a: string) => {
    const p = prices?.[a];
    if (!p) return "";
    return p.change24hPct >= 0 ? "🟢" : "🔴";
  };
  const topPrices = prices
    ? ["BTC", "ETH", "BNB", "SOL", "USDT"]
        .map((a) => prices[a])
        .filter(Boolean)
        .map((p, i) => `• ${["BTC", "ETH", "BNB", "SOL", "USDT"][i]}: $${fmtNum(p.usd, 2)} ${updown(["BTC", "ETH", "BNB", "SOL", "USDT"][i])} ${p.change24hPct >= 0 ? "+" : ""}${p.change24hPct.toFixed(2)}%`)
    : [];
  return {
    text: [
      "💱 **FlashBolt Trade**",
      "",
      crypto.length || cash.length ? "**Balances**" : "No balances yet — deposit to start.",
      ...crypto.map(row),
      ...cash.map(row),
      "",
      "**Earn**",
      `• Active plans ${earn.activePlans} · accrued ${fmtNum(earn.activeAccrued, 6)} · interest earned ${fmtNum(earn.interestEarned, 6)}`,
      "",
      topPrices.length ? "**Live prices**" : "_Prices loading — open the Markets page once._",
      ...topPrices,
    ].join("\n"),
    keyboard: [
      [
        { text: "💱 Prices", callback_data: "cmd:/prices" },
        { text: "🧮 Orders", callback_data: "cmd:/orders" },
      ],
      [
        { text: "🏦 Earn", callback_data: "cmd:/earn" },
        { text: "🧾 Txs", callback_data: "cmd:/txs" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function pricesMessage(
  prices: Record<string, { usd: number; ngn: number; change24hPct: number }> | null,
): { text: string; keyboard: TgKeyboard } {
  if (!prices) {
    return {
      text: "⏳ Live rates not loaded yet — open the Trade terminal once, then retry.",
      keyboard: [[{ text: "🔄 Retry", callback_data: "cmd:/prices" }]],
    };
  }
  const order = ["BTC", "ETH", "BNB", "SOL", "USDT", "USDC", "TRX", "LTC", "XMR", "XAUT", "NGN", "USD", "EUR", "GBP", "GHS", "KES", "XAF"];
  const rows = order
    .filter((a) => prices[a])
    .map((a) => {
      const p = prices[a];
      const arrow = p.change24hPct >= 0 ? "🟢" : "🔴";
      const chg = `${p.change24hPct >= 0 ? "+" : ""}${p.change24hPct.toFixed(2)}%`;
      return `• ${a}: $${fmtNum(p.usd, p.usd < 10 ? 4 : 2)} ${arrow} ${chg}${a.length === 3 && CASH_SYM[a] ? ` · ₦${fmtNum(p.ngn, 2)}` : ""}`;
    });
  return {
    text: ["💱 **Live market prices**", "", ...rows].join("\n"),
    keyboard: [
      [
        { text: "💱 Trade", callback_data: "cmd:/trade" },
        { text: "🔄 Refresh", callback_data: "cmd:/prices" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function marketsMessage(
  prices: Record<string, { usd: number; change24hPct: number }> | null,
): { text: string; keyboard: TgKeyboard } {
  if (!prices) {
    return {
      text: "⏳ Live rates not loaded yet — open the Trade terminal once, then retry.",
      keyboard: [[{ text: "🔄 Retry", callback_data: "cmd:/markets" }]],
    };
  }
  const movers = Object.entries(prices)
    .filter(([a]) => !CASH_SYM[a])
    .sort((a, b) => Math.abs(b[1].change24hPct) - Math.abs(a[1].change24hPct))
    .slice(0, 8)
    .map(([a, p]) => `• ${a}: $${fmtNum(p.usd, 2)} ${p.change24hPct >= 0 ? "🟢 +" : "🔴 "}${p.change24hPct.toFixed(2)}%`);
  return {
    text: ["📈 **Top movers (24h)**", "", ...movers].join("\n"),
    keyboard: [
      [
        { text: "💱 Prices", callback_data: "cmd:/prices" },
        { text: "🔄 Refresh", callback_data: "cmd:/markets" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function ordersMessage(rows: OrderLite[]): { text: string; keyboard: TgKeyboard } {
  const open = rows.filter((o) => o.status === "open");
  const recent = rows.filter((o) => o.status !== "open").slice(0, 6);
  const line = (o: OrderLite) =>
    `${o.status === "open" ? "🟡" : o.status === "filled" ? "✅" : "✖️"} ${o.side.toUpperCase()} ${fmtNum(o.amount, 6)} ${o.base} @ ${fmtNum(o.price, 6)} ${o.quote} (${fmtNum((o.filled / Math.max(1e-9, o.amount)) * 100, 0)}% filled)`;
  return {
    text: [
      "🧮 **Limit orders**",
      "",
      open.length ? "**Open**" : "No open orders.",
      ...open.slice(0, 8).map(line),
      "",
      recent.length ? "**Recently closed**" : "",
      ...recent.map(line),
    ]
      .filter((l) => l !== "")
      .join("\n"),
    keyboard: [
      [{ text: "💱 Trade", callback_data: "cmd:/trade" }],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function earnMessage(plans: EarnPlanLite[], now: number): { text: string; keyboard: TgKeyboard } {
  const active = plans.filter((p) => p.status === "active");
  const closed = plans.filter((p) => p.status !== "active").slice(0, 4);
  const line = (p: EarnPlanLite) =>
    `${p.kind === "flexible" ? "💧" : "🔒"} ${p.asset} ${fmtNum(p.principal, 6)} @ ${p.apyPct}% APY · accrued +${fmtNum(p.accrued, 6)} · ${fmtAgo(p.startedAt, now)}`;
  return {
    text: [
      "🏦 **Earn plans**",
      "",
      active.length ? "**Active**" : "No active plans.",
      ...active.slice(0, 8).map(line),
      "",
      closed.length ? "**Closed**" : "",
      ...closed.map(line),
      "",
      active.some((p) => p.kind === "flexible" && p.accrued > 0)
        ? "💡 A flexible plan has accrued interest — /claim to withdraw it."
        : "_Flexible plans accrue 4.5% APY · fixed 7% APY._",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    keyboard: [
      [
        { text: "💸 Claim interest", callback_data: "cmd:/claim" },
        { text: "🔄 Refresh", callback_data: "cmd:/earn" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function txsMessage(rows: TxLite[], now: number): { text: string; keyboard: TgKeyboard } {
  const icon = (d: string, s: string) =>
    (d === "deposit" || d === "transfer_in" || d === "interest" ? "⬇️" : d === "withdrawal" || d === "transfer_out" ? "⬆️" : "🔁") +
    (s === "completed" ? "" : s === "pending" ? " ⏳" : " ❌");
  return {
    text: [
      "🧾 **Recent transactions**",
      "",
      ...(rows.length
        ? rows
            .slice(0, 12)
            .map(
              (t) =>
                `${icon(t.direction, t.status)} ${tradeSymbol(t.asset)}${fmtNum(t.amount, 4)} ${t.asset} · ${fmtAgo(t.ts, now)} · \`${t.ref}\``,
            )
        : ["No transactions yet."]),
    ].join("\n"),
    keyboard: [
      [
        { text: "💱 Trade", callback_data: "cmd:/trade" },
        { text: "🔄 Refresh", callback_data: "cmd:/txs" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Alerts / settings builders
// ---------------------------------------------------------------------------

export function alertsMessage(
  cfg: Pick<BotConfig, "alertFanout" | "digestEnabled" | "soundAlerts" | "autoPurge"> & {
    /** Defaults to ON, like the stored setting (`!== false`). */
    channelPurge?: boolean;
    /** Last sweep's tally, when the cron has reported one. */
    purgeLast?: PurgeTelemetry;
  },
  chat: Pick<BotChat, "silent">,
  now: number = Date.now(),
): { text: string; keyboard: TgKeyboard } {
  const channelPurge = cfg.channelPurge !== false;
  return {
    text: [
      "🔔 **Alerts & notifications**",
      "",
      `• Trade-alert mirror: ${cfg.alertFanout ? "✅ ON — successful trades ping this chat" : "❌ OFF"}`,
      `• Dashboard digest: ${cfg.digestEnabled ? "✅ ON — dashboard push every 10 min" : "❌ OFF"}`,
      `• Sounds: ${cfg.soundAlerts ? "🔔 ON" : "🔇 OFF"}`,
      `• This chat: ${chat.silent ? "🔇 muted" : "🔔 normal"}`,
      `• Auto-purge (bot chats): ${cfg.autoPurge ? "🧹 ON — bot messages older than 10 min are deleted" : "❌ OFF — every message stays"}`,
      `• Auto-purge (channel): ${channelPurge ? "🧹 ON — channel posts older than 15 min are deleted" : "❌ OFF — channel posts stay"}`,
      `• Last sweep: ${purgeTelemetryLine(cfg.purgeLast, now)}`,
    ].join("\n"),
    keyboard: [
      [
        { text: cfg.alertFanout ? "🔕 Trade mirror OFF" : "🔔 Trade mirror ON", callback_data: cfg.alertFanout ? "set:alerts_off" : "set:alerts_on" },
      ],
      [
        { text: cfg.digestEnabled ? "📅 Digest OFF" : "📅 Digest ON", callback_data: cfg.digestEnabled ? "set:digest_off" : "set:digest_on" },
      ],
      [
        { text: cfg.soundAlerts ? "🔇 Sounds OFF" : "🔊 Sounds ON", callback_data: cfg.soundAlerts ? "set:sound_off" : "set:sound_on" },
      ],
      [
        { text: chat.silent ? "🔔 Unmute this chat" : "🔕 Mute this chat", callback_data: chat.silent ? "set:unmute" : "set:mute" },
      ],
      [
        {
          text: cfg.autoPurge ? "🧹 Bot purge OFF" : "🧹 Bot purge ON",
          callback_data: cfg.autoPurge ? "set:purge_off" : "set:purge_on",
        },
        {
          text: channelPurge ? "📣 Channel purge OFF" : "📣 Channel purge ON",
          callback_data: channelPurge ? "set:channel_off" : "set:channel_on",
        },
      ],
      [{ text: "🧹 Purge this chat now", callback_data: "cmd:/purge" }],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

export function settingsApplied(what: string, on: boolean): string {
  return `${on ? "✅" : "🔕"} ${what} ${on ? "enabled" : "disabled"}.`;
}

// ---------------------------------------------------------------------------
// Digest + trade-alert builders
// ---------------------------------------------------------------------------

export function digestMessage(
  session: SessionLite,
  score: AiScoreLite,
  metrics: MetricsLite,
): { text: string } {
  const d = dashboardMessage(session, score, metrics);
  return { text: `📅 **Scheduled digest**\n\n${d.text}` };
}

export function tradeAlertMessage(input: {
  role: string;
  amount: number;
  symbol: string;
  label: string;
  lender: string | null | undefined;
  profitPct: number;
  network: string;
  earnings: number;
  txHash: string | null | undefined;
  /** SIM alerts get a distinct watermark style — visually unmistakable. */
  sim?: boolean;
}): string {
  const tx = input.txHash ? `\n🔗 \`${input.txHash.slice(0, 24)}…\`` : "";
  if (input.sim) {
    return [
      "🧪 **SIM TRADE — PAPER ONLY (eth\_simulation)**",
      "———————————————",
      "⚡ *Simulated route executed*",
      "",
      `+${fmtNum(input.amount, 4)} ${input.symbol} · +${input.profitPct.toFixed(2)}%`,
      `Route: ${input.label}`,
      `Lender: ${input.lender ?? "—"} · ${input.network}`,
      `Earnings: +${fmtNum(input.earnings, 4)} ${input.symbol} (${input.role})${tx}`,
      "———————————————",
      "🧪 _No on-chain footprint · no ledger touched · TASignal untouched_",
    ].join("\n");
  }
  return [
    "⚡ **Trade executed**",
    "",
    `+${fmtNum(input.amount, 4)} ${input.symbol} · +${input.profitPct.toFixed(2)}%`,
    `Route: ${input.label}`,
    `Lender: ${input.lender ?? "—"} · ${input.network}`,
    `Earnings: +${fmtNum(input.earnings, 4)} ${input.symbol} (${input.role})${tx}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type BotCommand =
  | { kind: "menu" }
  | { kind: "dashboard" }
  | { kind: "status" }
  | { kind: "engines" }
  | { kind: "bnb" }
  | { kind: "bnb_on" }
  | { kind: "bnb_off" }
  | { kind: "bnb_paper" }
  | { kind: "bnb_live" }
  | { kind: "bnb_scan" }
  | { kind: "routes" }
  | { kind: "execs"; filter: ExecFilter }
  | { kind: "pnl"; filter: ExecFilter }
  | { kind: "sol" }
  | { kind: "sol_on" }
  | { kind: "sol_off" }
  | { kind: "sol_scan" }
  | { kind: "trade" }
  | { kind: "prices" }
  | { kind: "markets" }
  | { kind: "txs" }
  | { kind: "orders" }
  | { kind: "earn" }
  | { kind: "claim" }
  | { kind: "deploy" }
  | { kind: "settings" }
  | { kind: "amount" }
  | { kind: "balance" }
  | { kind: "withdraw" }
  | { kind: "stop" }
  | { kind: "panic" }
  | { kind: "alerts" }
  | { kind: "digest" }
  | { kind: "sound" }
  | { kind: "silence" }
  | { kind: "purge" }
  | { kind: "help" }
  | { kind: "start" }
  | { kind: "start_payload"; code: string }
  | { kind: "unpair" }
  | { kind: "pair_start" }
  | { kind: "pair_code"; code: string }
  | { kind: "unknown"; raw: string };

/** Map a command name (without slash) to its BotCommand. */
export function parseBotCommand(text: string | null): BotCommand {
  if (!text) return { kind: "unknown", raw: "" };
  const t = text.trim();
  if (!t) return { kind: "unknown", raw: "" };
  // Bare pairing code: 6-8 alphanumerics typed on its own.
  const bare = t.replace(/\s+/g, "");
  if (/^[A-Z0-9]{6,8}$/i.test(bare) && !t.startsWith("/")) {
    return { kind: "pair_code", code: bare.toUpperCase() };
  }
  if (!t.startsWith("/")) return { kind: "unknown", raw: t.slice(0, 40) };
  const name = t.slice(1).split(/[\s@]/)[0].toLowerCase();
  // Deep-link auto-pairing: /start <CODE> — the "Open in Telegram" button in
  // the app sends this payload, so one tap connects the chat with no typing.
  if (name === "start") {
    const payload = t.slice(6).trim().replace(/[^A-Za-z0-9]/g, "");
    if (payload) return { kind: "start_payload", code: payload.toUpperCase() };
    return { kind: "start" };
  }
  switch (name) {
    case "start": return { kind: "start" };
    case "help": return { kind: "help" };
    case "menu": return { kind: "menu" };
    case "dashboard": return { kind: "dashboard" };
    case "status": return { kind: "status" };
    case "engines":
    case "engine": return { kind: "engines" };
    case "bnb": return { kind: "bnb" };
    case "bnb_on": return { kind: "bnb_on" };
    case "bnb_off": return { kind: "bnb_off" };
    case "bnb_paper": return { kind: "bnb_paper" };
    case "bnb_live": return { kind: "bnb_live" };
    case "bnb_scan": return { kind: "bnb_scan" };
    case "routes": return { kind: "routes" };
    case "execs": {
      // Suffix after the command name (e.g. "/execs@sim" → "@sim" → "sim").
      const f = t
        .slice(1 + name.length)
        .trim()
        .toLowerCase()
        .replace(/^@/, "");
      return { kind: "execs", filter: f === "live" || f === "sim" ? (f as ExecFilter) : "all" };
    }
    case "pnl": {
      const f = t
        .slice(1 + name.length)
        .trim()
        .toLowerCase()
        .replace(/^@/, "");
      return { kind: "pnl", filter: f === "live" || f === "sim" ? (f as ExecFilter) : "all" };
    }
    case "sol": return { kind: "sol" };
    case "sol_on": return { kind: "sol_on" };
    case "sol_off": return { kind: "sol_off" };
    case "sol_scan": return { kind: "sol_scan" };
    case "trade": return { kind: "trade" };
    case "prices": return { kind: "prices" };
    case "markets": return { kind: "markets" };
    case "txs": return { kind: "txs" };
    case "orders": return { kind: "orders" };
    case "earn": return { kind: "earn" };
    case "claim": return { kind: "claim" };
    case "deploy": return { kind: "deploy" };
    case "settings": return { kind: "settings" };
    case "amount": return { kind: "amount" };
    case "balance": return { kind: "balance" };
    case "withdraw": return { kind: "withdraw" };
    case "stop": return { kind: "stop" };
    case "panic": return { kind: "panic" };
    case "alerts": return { kind: "alerts" };
    case "digest": return { kind: "digest" };
    case "sound": return { kind: "sound" };
    case "silence": return { kind: "silence" };
    case "purge": return { kind: "purge" };
    case "unpair": return { kind: "unpair" };
    case "pair": return { kind: "pair_start" };
    default: return { kind: "unknown", raw: `/${name}` };
  }
}

/**
 * Every command kind the webhook dispatcher answers with a real reply. The
 * dispatcher's switch is exhaustive over `BotCommand` at compile time (a
 * missing case is a type error), and this list is the runtime mirror the menu
 * parity test walks: any inline button that resolves to a kind outside it is a
 * dead control.
 */
export const HANDLED_COMMAND_KINDS: ReadonlyArray<BotCommand["kind"]> = [
  "menu",
  "dashboard",
  "status",
  "engines",
  "bnb",
  "bnb_on",
  "bnb_off",
  "bnb_paper",
  "bnb_live",
  "bnb_scan",
  "routes",
  "execs",
  "pnl",
  "sol",
  "sol_on",
  "sol_off",
  "sol_scan",
  "trade",
  "prices",
  "markets",
  "txs",
  "orders",
  "earn",
  "claim",
  "deploy",
  "settings",
  "amount",
  "balance",
  "withdraw",
  "stop",
  "panic",
  "alerts",
  "digest",
  "sound",
  "silence",
  "purge",
  "help",
  "start",
  "start_payload",
  "unpair",
  "pair_start",
  "pair_code",
  "unknown",
];

export interface CallbackResolution {
  cmd: BotCommand;
  /** `set:*` callbacks carry the setting they toggle; everything else null. */
  setting: string | null;
}

/**
 * Resolve an inline-keyboard `callback_data` string to the command it means.
 *
 * Every button the builders emit goes through here, so a menu cannot silently
 * become a dead control: the parity test walks every keyboard and asserts the
 * resolved kind is in `HANDLED_COMMAND_KINDS`. Unknown payloads resolve to
 * `unknown`, which the dispatcher answers with the command board — a click
 * always produces a reply.
 */
export function resolveCallbackData(callbackData: string | null): CallbackResolution {
  const data = (callbackData ?? "").trim();
  if (data.startsWith("cmd:")) return { cmd: parseBotCommand(data.slice(4)), setting: null };
  if (data === "menu:main") return { cmd: { kind: "menu" }, setting: null };
  if (data === "help:main") return { cmd: { kind: "help" }, setting: null };
  if (data === "pair:start") return { cmd: { kind: "pair_start" }, setting: null };
  if (data.startsWith("set:")) return { cmd: { kind: "alerts" }, setting: data.slice(4) };
  return { cmd: parseBotCommand(data), setting: null };
}

// ---------------------------------------------------------------------------
// Control & status boards — settings / deploy / sizing / balances / panic.
// All inputs are REAL backend state (terminal state, trade ledger); these
// builders only format, exactly like every other message in this module.
// ---------------------------------------------------------------------------

/** Contract deployment + live-readiness — mirrors the Contract page state. */
export function deployMessage(input: {
  mode: "paper" | "live";
  network: string;
  chainKey: string;
  contract: string | null;
  router: string | null;
  deployments: Array<{ chain: string; contract: string; signer?: string | null; relay?: string | null }>;
  connectedWallets: number;
  importedWallets: number;
}): { text: string; keyboard: TgKeyboard } {
  const armed = Boolean(input.contract);
  const ready = armed && (input.connectedWallets > 0 || input.importedWallets > 0);
  return {
    text: [
      "📦 **Contract deployment**",
      "",
      `• Mode: ${input.mode === "live" ? "🔴 LIVE" : "📄 paper"} · Network: ${input.network} · Chain: ${input.chainKey}`,
      `• Active contract: ${input.contract ? `\`${input.contract}\`` : "not armed"}`,
      `• Router: ${input.router ? `\`${input.router}\`` : "default"}`,
      `• Signing wallets: ${input.connectedWallets} connected · ${input.importedWallets} imported`,
      `• Live execution: ${ready ? "🟢 READY — contract + wallet armed" : armed ? "🟠 contract armed, no wallet connected" : "🟠 not armed — deploy from the app's Contract page"}`,
      "",
      "**Per-chain deployments**",
      ...(input.deployments.length
        ? input.deployments.map(
            (d) =>
              `• ${d.chain.toUpperCase()}: \`${d.contract.slice(0, 14)}…\`${d.signer ? ` · signer \`${d.signer.slice(0, 10)}…\`` : ""}${d.relay ? ` · ${d.relay}` : ""}`,
          )
        : ["• none yet"]),
      "",
      "_Deployment is signed in the app (browser wallet / session vault) — the bot only reports this state; it never signs from chat._",
    ].join("\n"),
    keyboard: [
      [
        { text: "📋 Status", callback_data: "cmd:/status" },
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

/** Live strategy + engine parameters — read-only mirror of the app settings. */
export function settingsMessage(s: {
  botRunning: boolean;
  solBotRunning: boolean;
  mode: "paper" | "live";
  network: string;
  chainKey: string;
  cadence: number;
  minProfit: number;
  maxLoan: number;
  maxHops: number;
  slippage: number;
  gasPriority: string;
  autoPayout: boolean;
  mevGuard: boolean;
  privateSubmit: boolean;
  lenderBalancer: boolean;
  dailyArbTarget: number;
  dexWhitelist: string[];
  loanAssets: string[];
  sol: {
    network: string;
    buy: number;
    sellPct: number;
    slippagePct: number;
    targetPct: number;
    trailingPct: number;
    minLiq: number;
    rpcOverrides: number;
    wallets: number;
  };
}): { text: string; keyboard: TgKeyboard } {
  const wl = s.dexWhitelist.length
    ? s.dexWhitelist.slice(0, 8).join(", ") + (s.dexWhitelist.length > 8 ? "…" : "")
    : "default";
  const loans = s.loanAssets.length ? s.loanAssets.join(", ") : "native only";
  return {
    text: [
      "⚙️ **Parameters — live values**",
      "",
      "⚡ **BNB FlashBolt**",
      `• Bot: ${s.botRunning ? "🟢 RUNNING" : "🔴 stopped"} · Mode: ${s.mode === "live" ? "🔴 LIVE" : "📄 paper"} · ${s.network} (${s.chainKey})`,
      `• Min profit ${s.minProfit}% · max loan ${fmtNum(s.maxLoan, 2)} · ${s.maxHops} hops · slippage ${s.slippage}%`,
      `• Gas priority ${s.gasPriority} · cadence ${s.cadence}s · daily target ${s.dailyArbTarget === 0 ? "∞" : s.dailyArbTarget}`,
      `• Auto-payout ${s.autoPayout ? "✅" : "❌"} · MEV guard ${s.mevGuard ? "✅" : "❌"} · private submit ${s.privateSubmit ? "✅" : "❌"} · lender balancer ${s.lenderBalancer ? "✅" : "❌"}`,
      `• DEX whitelist: ${wl}`,
      `• Loan assets: ${loans}`,
      "",
      "☀️ **SOL FlashBolt**",
      `• Bot: ${s.solBotRunning ? "🟢 RUNNING" : "🔴 stopped"} · cluster ${s.sol.network}`,
      `• Buy ${fmtNum(s.sol.buy, 3)} SOL · sell ${fmtNum(s.sol.sellPct, 0)}% · slippage ${fmtNum(s.sol.slippagePct, 1)}%`,
      `• Target ${fmtNum(s.sol.targetPct, 1)}% · trailing ${fmtNum(s.sol.trailingPct, 1)}% · min liq ${fmtUsd(s.sol.minLiq)}`,
      `• Imported wallets ${s.sol.wallets} · RPC overrides ${s.sol.rpcOverrides}`,
      "",
      "_These are the SAME values the app persists — edit them on the Settings / SOL pages._",
    ].join("\n"),
    keyboard: [
      [
        { text: "🔢 Amounts", callback_data: "cmd:/amount" },
        { text: "⚙️ Engines", callback_data: "cmd:/engines" },
      ],
      [
        { text: "📦 Deploy", callback_data: "cmd:/deploy" },
        { text: "📋 Status", callback_data: "cmd:/status" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

/** Position sizing across BNB + SOL engines (trade sizing lives in /balance). */
export function amountMessage(a: {
  mode: "paper" | "live";
  maxLoan: number;
  minProfit: number;
  dailyArbTarget: number;
  executionsToday: number;
  solBuy: number;
  solSellPct: number;
  solTargetPct: number;
  solTrailingPct: number;
}): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🔢 **Amounts & sizing**",
      "",
      "⚡ **BNB FlashBolt**",
      `• Flash-loan cap: ${fmtNum(a.maxLoan, 2)} per route · min edge ${a.minProfit}%`,
      `• Daily target: ${a.dailyArbTarget === 0 ? "∞" : a.dailyArbTarget} executions · today ${a.executionsToday}`,
      `• Mode: ${a.mode === "live" ? "🔴 LIVE — real funds" : "📄 paper — simulated only"}`,
      "",
      "☀️ **SOL FlashBolt**",
      `• Buy ${fmtNum(a.solBuy, 3)} SOL per snipe · sell ${fmtNum(a.solSellPct, 0)}% per exit`,
      `• Profit target ${fmtNum(a.solTargetPct, 1)}% · trailing stop ${fmtNum(a.solTrailingPct, 1)}%`,
      "",
      "_Sizing is enforced server-side by the same engines these numbers feed._",
    ].join("\n"),
    keyboard: [
      [
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
        { text: "💰 Balance", callback_data: "cmd:/balance" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

/** Asset balances (crypto + cash) with live USD values when the feed is up. */
export function balanceMessage(
  balances: BalanceLite[],
  prices: Record<string, { usd: number; change24hPct: number }> | null,
): { text: string; keyboard: TgKeyboard } {
  const crypto = balances.filter((b) => b.kind === "crypto");
  const cash = balances.filter((b) => b.kind === "cash");
  const line = (b: BalanceLite) => {
    const sym = tradeSymbol(b.asset);
    const price = prices?.[b.asset]?.usd;
    const usd = price ? ` (~${fmtUsd(b.available * price)})` : "";
    const locked = b.locked > 0 ? ` · 🔒${fmtNum(b.locked, 2)} locked` : "";
    return `• ${b.asset}: ${fmtNum(b.available, b.kind === "cash" ? 2 : 6)}${sym}${usd}${locked}`;
  };
  return {
    text: [
      "💰 **Balances**",
      "",
      "**Crypto**",
      ...(crypto.length ? crypto.map(line) : ["• none yet — deposit to start."]),
      "",
      "**Cash**",
      ...(cash.length ? cash.map(line) : ["• no local-currency balance."]),
      "",
      prices
        ? "_USD values from the live price feed._"
        : "_Prices not loaded yet — run /prices once the Trade terminal is open._",
    ].join("\n"),
    keyboard: [
      [
        { text: "🏧 Withdraw", callback_data: "cmd:/withdraw" },
        { text: "💱 Trade", callback_data: "cmd:/trade" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

/** Withdrawal page: cash on hand + recent withdrawal ledger, honest scope. */
export function withdrawMessage(
  cash: BalanceLite[],
  withdrawals: TxLite[],
  now: number,
): { text: string; keyboard: TgKeyboard } {
  return {
    text: [
      "🏧 **Withdrawals**",
      "",
      "**Available cash**",
      ...(cash.length
        ? cash.map((b) => `• ${b.asset}: ${fmtNum(b.available, 2)}${tradeSymbol(b.asset)}`)
        : ["• no local-currency balance yet."]),
      "",
      "**Recent withdrawals**",
      ...(withdrawals.length
        ? withdrawals
            .slice(0, 6)
            .map(
              (t) =>
                `${t.status === "completed" ? "✅" : t.status === "pending" ? "⏳" : "❌"} ${tradeSymbol(t.asset)}${fmtNum(t.amount, 2)} ${t.asset} · ${fmtAgo(t.ts, now)} · \`${t.ref}\``,
            )
        : ["• none yet."]),
      "",
      "_Withdrawals run in the app (Trade → Withdraw) against operator-verified accounts — the bot reports state and never moves funds by itself._",
    ].join("\n"),
    keyboard: [
      [
        { text: "💰 Balance", callback_data: "cmd:/balance" },
        { text: "🧾 Txs", callback_data: "cmd:/txs" },
      ],
      [{ text: "🧭 Menu", callback_data: "menu:main" }],
    ],
  };
}

/** Stop / panic confirmation — always the SAFE direction (never arms). */
export function stoppedMessage(
  kind: "stop" | "panic",
  previousMode: "paper" | "live",
): { text: string; keyboard: TgKeyboard } {
  const keyboard: TgKeyboard = [
    [
      { text: "📊 Dashboard", callback_data: "cmd:/dashboard" },
      { text: "⚙️ Engines", callback_data: "cmd:/engines" },
    ],
    [{ text: "🧭 Menu", callback_data: "menu:main" }],
  ];
  if (kind === "panic") {
    return {
      text: [
        "🚨 **PANIC — console safe**",
        "",
        "• BNB scanner: 🔴 STOPPED",
        "• SOL scanner: 🔴 STOPPED",
        `• Mode forced to 📄 paper (was ${previousMode === "live" ? "🔴 LIVE" : "📄 paper"})`,
        "",
        "No further on-chain execution happens until you re-arm from the app or /bnb_live.",
      ].join("\n"),
      keyboard,
    };
  }
  return {
    text: [
      "🛑 **Both engines STOPPED**",
      "",
      "• BNB scanner: 🔴 stopped",
      "• SOL scanner: 🔴 stopped",
      `• Mode unchanged: ${previousMode === "live" ? "🔴 LIVE" : "📄 paper"}`,
      "",
      "Start again with ▶️ START in the menu, /bnb_on or /sol_on.",
    ].join("\n"),
    keyboard,
  };
}
