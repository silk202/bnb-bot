// FlashBolt Telegram Bot — the operator-only mirror of the app.
//
// ARCHITECTURE
//   Telegram → POST /api/telegram/webhook (http.ts) → handleUpdate (this file)
//   handleUpdate parses the update (src/lib/telegramBot.ts), resolves the
//   chat's link state, then either serves a command (reading the SAME backend
//   queries/mutations the terminals use) or refuses.
//
// SECURITY
//   • Every webhook request must carry the X-Telegram-Bot-Api-Secret-Token
//     header exactly equal to the stored webhookSecret (Telegram stamps it on
//     every delivery) — unauthenticated posts are rejected with 401.
//   • Chat identity is authoritative: chatId comes from the verified update,
//     never from user input. Only chats linked through a pairing code issued
//     inside the authenticated operator session get past the gate.
//   • Pairing codes are single-code-at-a-time, short-window, and rotate.
//   • Subscriber chats can never pair: the app only reveals the code on the
//     operator side (sign-in or Continue-as-guest), and the bot re-verifies.
//
// REAL DATA
//   Every dashboard, route list, ledger row and setting lives in the same
//   Convex tables the web terminals use — nothing simulated, nothing mocked.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { decryptSecret, encryptSecret } from "./encryption";
import {
  parseTgUpdate,
  parseBotCommand,
  resolveCallbackData,
  purgeCutoff,
  purgeSkipNote,
  purgeAlertPlan,
  purgeFailureAlert,
  purgeFailureSummary,
  classifyPurgeFailure,
  CHANNEL_MESSAGE_TTL_MS,
  selectPurgeable,
  type BotMessageSource,
  startMessage,
  helpMessage,
  unlinkedMessage,
  pairPrompt,
  pairedMessage,
  bootMessage,
  enginesMessage,
  mainMenu,
  type EngineStamp,
  dashboardMessage,
  bnbMessage,
  solMessage,
  routesMessage,
  executionsMessage,
  pnlMessage,
  tradeMessage,
  pricesMessage,
  marketsMessage,
  ordersMessage,
  earnMessage,
  txsMessage,
  alertsMessage,
  digestMessage,
  tradeAlertMessage,
  fmtNum,
  fmtAgo,
  settingsApplied,
  disableNotification,
  deployMessage,
  settingsMessage,
  amountMessage,
  balanceMessage,
  withdrawMessage,
  stoppedMessage,
  type TgUpdate,
  type TgKeyboard,
  type BotChat,
  type BotConfig,
  type BotCommand,
  type PurgeAlertInfo,
  type PurgeTelemetry,
  type SessionLite,
  type MetricsLite,
  type AiScoreLite,
  type TerminalStateLite,
  type RouteLite,
  type ExecutionLite,
  type PnlLite,
  type BalanceLite,
  type EarnPlanLite,
  type OrderLite,
  type TxLite,
} from "../lib/telegramBot";
import { sessionStateAtWith, mergeSessionOverrides, SESSION_DEFS } from "../lib/telegram";
import {
  fetchMarketSnapshot,
  computeRoutes,
  DEFAULT_FEED_SETTINGS,
  type FeedSettings,
} from "../lib/flashbolt";
import { generateWBNBRoutes } from "../lib/route-generator";
import { fetchGasGwei, computeAiScore } from "./signals";
import { CHAIN_INFO } from "../lib/flashbolt";
import type { Doc, Id } from "./_generated/dataModel";

const CONFIG_KEY = "default";
const PAIRING_TTL_MS = 15 * 60 * 1000; // 15 minutes
/** localStorage key — raw server-issued device-trust token (hash-only server-side). */
const DEVICE_TOKEN_KEY = "flashbolt.deviceTrustToken";

/**
 * 64-hex-char cryptographically-random token from crypto.getRandomValues
 * (the codebase convention — gate.ts, terminal.ts, operatorEmails.ts).
 * V8-safe and deterministic-hash-friendly, unlike Math.random()/crypto.randomUUID.
 */
function randomToken(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read the device-trust token from Convex Auth client storage (client-set). */
function deviceTokenFromClient(token: string | undefined): string | null {
  const raw = token?.trim() ?? "";
  return raw.length >= 32 ? raw : null;
}

/**
 * The operator's app-supplied bot token, decrypted server-side. An INTERNAL
 * query — the plaintext never reaches any client. Encrypted at rest with the
 * project AES-GCM secret key (encryption.ts); a failed decrypt falls through
 * to the deployment env fallback in resolveBotToken.
 */
export const readStoredToken = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row?.botTokenEnc) return null;
    try {
      return await decryptSecret(ctx, row.botTokenEnc);
    } catch {
      return null;
    }
  },
});

/**
 * The last purge sweep's tally as the UI consumes it: absent fields become an
 * honest zero only when the sweep itself did report (at is present), and no
 * row at all yields `undefined` = "not reported yet".
 */
function purgeTelemetryFrom(row: Doc<"telegramBotConfig"> | null): PurgeTelemetry | undefined {
  if (!row || row.purgeLastAt === undefined) return undefined;
  return {
    at: row.purgeLastAt,
    deleted: row.purgeLastDeleted ?? 0,
    failed: row.purgeLastFailed ?? 0,
    retrying: row.purgeLastRetrying ?? 0,
    skipped: row.purgeLastSkipped ?? null,
  };
}

/** Best-effort env-token presence (queries may not expose env in every runtime). */
function envTokenPresent(): boolean {
  try {
    return typeof process !== "undefined" && Boolean(process.env?.TELEGRAM_BOT_TOKEN?.trim());
  } catch {
    return false;
  }
}

/**
 * The bot's Telegram command menu — pushed via setMyCommands so every slash
 * command shows up in Telegram's built-in menu WITH its description. Pairs
 * with the /help board in the presentation layer (same commands, same scope).
 */
const BOT_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Pair this chat and boot the console" },
  { command: "menu", description: "Main menu with every control" },
  { command: "dashboard", description: "Live dashboard: sessions, AI score, fleet" },
  { command: "status", description: "Engines, mode, PnL, webhook status" },
  { command: "engine", description: "Engine board — BNB + SOL start/stop" },
  { command: "engines", description: "Engine board (alias of /engine)" },
  { command: "bnb", description: "BNB FlashBolt dashboard" },
  { command: "bnb_on", description: "Start the BNB scanner engine" },
  { command: "bnb_off", description: "Stop the BNB scanner engine" },
  { command: "bnb_paper", description: "Switch BNB to paper mode" },
  { command: "bnb_live", description: "Switch BNB to live mode" },
  { command: "sol", description: "SOL FlashBolt dashboard" },
  { command: "sol_on", description: "Start the SOL scanner + sniper" },
  { command: "sol_off", description: "Stop the SOL scanner + sniper" },
  { command: "routes", description: "Top live arbitrage routes" },
  { command: "execs", description: "Recent executions (all | live | sim)" },
  { command: "pnl", description: "PnL summary (all | live | sim)" },
  { command: "trade", description: "Trade dashboard overview" },
  { command: "balance", description: "Asset balances with live prices" },
  { command: "amount", description: "Position sizing parameters" },
  { command: "settings", description: "Strategy & engine parameters" },
  { command: "deploy", description: "Contract deployment status" },
  { command: "prices", description: "Live market prices" },
  { command: "markets", description: "Top market pairs" },
  { command: "orders", description: "Open limit orders" },
  { command: "earn", description: "Earn plans" },
  { command: "claim", description: "Claim flexible-earn interest" },
  { command: "withdraw", description: "Cash balances + withdrawals" },
  { command: "txs", description: "Recent transactions" },
  { command: "alerts", description: "Alert, sound & auto-purge settings" },
  { command: "digest", description: "Scheduled dashboard digest on/off" },
  { command: "sound", description: "Notification sound on/off" },
  { command: "silence", description: "Mute this chat" },
  { command: "purge", description: "Delete the bot's messages in this chat" },
  { command: "unpair", description: "Unlink this chat" },
  { command: "stop", description: "Stop BOTH engines" },
  { command: "panic", description: "Emergency stop + force paper mode" },
  { command: "help", description: "Full command list" },
];

/**
 * Bumped whenever BOT_COMMAND_SPECS changes. The self-heal sweep re-pushes the
 * menu when the stored version is older, so a new command shows up in
 * Telegram's native menu within one ten-minute self-heal pass instead of
 * waiting for the weekly refresh — the menu the operator sees always matches
 * the commands that answer.
 */
const BOT_COMMAND_VERSION = 2;

/** Push the command menu to Telegram (idempotent; best-effort). */
async function pushCommandMenu(token: string): Promise<boolean> {
  return (await tgCall(token, "setMyCommands", { commands: BOT_COMMAND_SPECS })).ok;
}

/**
 * getMe against an EXPLICIT token — used to probe a candidate token the
 * operator just pasted, before anything is stored. Null = Telegram refused.
 */
async function fetchMe(token: string): Promise<{ username: string } | null> {
  const res = await tgCall(token, "getMe", {});
  if (!res.ok) return null;
  const r = res.result as { username?: string } | undefined;
  return r?.username ? { username: r.username } : null;
}

/**
 * The token every Telegram call uses: an app-saved ENCRYPTED token first
 * (the operator's explicit newest action), then the deployment env fallback.
 */
async function resolveBotToken(ctx: ActionCtx): Promise<string | null> {
  try {
    const stored = await ctx.runQuery(internal.telegramBot.readStoredToken, {});
    if (stored) return stored;
  } catch {
    // Key/decrypt hiccup — fall through to the env fallback.
  }
  try {
    const env = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (env) return env;
  } catch {
    // No env access in this runtime.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config + chat registry (internal queries/mutations)
// ---------------------------------------------------------------------------

/** Raw config row read for actions (they have no db access). */
export const readConfigRow = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"telegramBotConfig"> | null> => {
    return await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
  },
});

export const getConfig = internalQuery({
  args: {},
  handler: async (ctx): Promise<BotConfig | null> => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row) return null;
    return {
      pairingCode: row.pairingCode,
      pairingExpiresAt: row.pairingExpiresAt,
      webhookSecret: row.webhookSecret,
      digestEnabled: row.digestEnabled,
      alertFanout: row.alertFanout,
      soundAlerts: row.soundAlerts,
      autoPairOnStart: row.autoPairOnStart !== false,
      autoPurge: row.autoPurge !== false,
      channelPurge: row.channelPurge !== false,
      purgeLast: purgeTelemetryFrom(row),
      purgeAlertedAt: row.purgeAlertedAt,
      purgeAlertsSent: row.purgeAlertsSent,
      purgeFaultSince: row.purgeFaultSince,
      updatedAt: row.updatedAt,
    };
  },
});

/** Create the config row with a random webhook secret (idempotent). */
export const ensureConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) return { secret: row.webhookSecret };
    const secret = randomToken(32);
    await ctx.db.insert("telegramBotConfig", {
      key: CONFIG_KEY,
      webhookSecret: secret,
      digestEnabled: true,
      alertFanout: true,
      soundAlerts: true,
      autoPurge: true,
      channelPurge: true,
      updatedAt: Date.now(),
    });
    return { secret };
  },
});

export const getChat = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }): Promise<BotChat | null> => {
    const row = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (!row) return null;
    return {
      chatId: row.chatId,
      title: row.title,
      username: row.username,
      linkedAt: row.linkedAt,
      lastSeenAt: row.lastSeenAt,
      lastCommand: row.lastCommand,
      silent: row.silent,
      blocked: row.blocked,
    };
  },
});

/** Record last-seen + last command on every authenticated interaction. */
export const touchChat = internalMutation({
  args: { chatId: v.string(), command: v.optional(v.string()) },
  handler: async (ctx, { chatId, command }) => {
    const row = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      lastSeenAt: Date.now(),
      ...(command !== undefined ? { lastCommand: command } : {}),
    });
  },
});

export const listChats = internalQuery({
  args: { activeOnly: v.optional(v.boolean()) },
  handler: async (ctx, { activeOnly = true }): Promise<BotChat[]> => {
    const rows = await ctx.db.query("telegramBotChats").collect();
    return rows
      .filter((r) => (activeOnly ? !r.blocked : true))
      .map((r) => ({
        chatId: r.chatId,
        title: r.title,
        username: r.username,
        linkedAt: r.linkedAt,
        lastSeenAt: r.lastSeenAt,
        lastCommand: r.lastCommand,
        silent: r.silent,
        blocked: r.blocked,
      }));
  },
});

// ---------------------------------------------------------------------------
// Bot-side pairing completion (webhook side — verifies against the code the
// app issued; the operator types it into the chat).
// ---------------------------------------------------------------------------

export const tryPairChat = internalMutation({
  args: {
    chatId: v.string(),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
    code: v.string(),
  },
  handler: async (ctx, { chatId, title, username, code }) => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row?.pairingCode || !row.pairingExpiresAt) {
      return { ok: false as const, reason: "No pairing code is active — generate one in the app (Account menu → Telegram Bot)." };
    }
    if (Date.now() > row.pairingExpiresAt) {
      return { ok: false as const, reason: "The pairing code expired — generate a fresh one in the app." };
    }
    if (code.trim().toUpperCase() !== row.pairingCode.toUpperCase()) {
      return { ok: false as const, reason: "That code doesn't match — check the app and try again." };
    }
    const existing = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        linkedAt: now,
        lastSeenAt: now,
        blocked: false,
        title: title ?? existing.title,
        username: username ?? existing.username,
      });
    } else {
      await ctx.db.insert("telegramBotChats", {
        chatId,
        title,
        username,
        linkedAt: now,
        lastSeenAt: now,
        silent: false,
        blocked: false,
      });
    }
    // Consume the code — single use.
    await ctx.db.patch(row._id, { pairingCode: undefined, pairingExpiresAt: undefined });
    return { ok: true as const };
  },
});

export const unpairChat = internalMutation({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const row = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

export const setChatPref = internalMutation({
  args: { chatId: v.string(), silent: v.boolean() },
  handler: async (ctx, { chatId, silent }) => {
    const row = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (row) await ctx.db.patch(row._id, { silent });
    return { ok: true };
  },
});

export const setBotPref = internalMutation({
  args: {
    digestEnabled: v.optional(v.boolean()),
    alertFanout: v.optional(v.boolean()),
    soundAlerts: v.optional(v.boolean()),
    autoPairOnStart: v.optional(v.boolean()),
    autoPurge: v.optional(v.boolean()),
    channelPurge: v.optional(v.boolean()),
  },
  handler: async (ctx, { digestEnabled, alertFanout, soundAlerts, autoPairOnStart, autoPurge, channelPurge }) => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row) return false;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (digestEnabled !== undefined) patch.digestEnabled = digestEnabled;
    if (alertFanout !== undefined) patch.alertFanout = alertFanout;
    if (soundAlerts !== undefined) patch.soundAlerts = soundAlerts;
    if (autoPairOnStart !== undefined) patch.autoPairOnStart = autoPairOnStart;
    if (autoPurge !== undefined) patch.autoPurge = autoPurge;
    if (channelPurge !== undefined) patch.channelPurge = channelPurge;
    await ctx.db.patch(row._id, patch);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Telegram Bot API senders (real HTTPS, honest results)
// ---------------------------------------------------------------------------

type TgSendResult = { ok: boolean; description: string };

async function tgCall(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<TgSendResult & { result?: unknown }> {
  if (!token) return { ok: false, description: "Bot token not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: unknown;
    };
    return {
      ok: data.ok === true,
      description: data.description ?? (data.ok ? "sent" : "send failed"),
      result: data.result,
    };
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : "request failed" };
  }
}

/**
 * Send one message AND track its id, so the 10-minute purge sweep can delete
 * it later. Tracking is best-effort: a send that succeeded must never be
 * reported as failed because the bookkeeping insert did. The message id comes
 * from Telegram's own result, never from a guess.
 */
async function sendPayload(
  ctx: ActionCtx,
  token: string,
  chatId: string,
  text: string,
  keyboard: TgKeyboard | null,
  disableNotification: boolean,
): Promise<TgSendResult> {
  const res = await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    disable_notification: disableNotification,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  const messageId = (res.result as { message_id?: number } | undefined)?.message_id;
  if (res.ok && typeof messageId === "number") {
    try {
      await ctx.runMutation(internal.telegramBot.recordBotMessage, {
        chatId,
        messageId,
        source: "bot",
      });
    } catch {
      // Bookkeeping only — the message was delivered.
    }
  }
  return { ok: res.ok, description: res.description };
}

/** Answer a callback query so Telegram stops the spinner (null = no callback). */
async function answerCallback(token: string, callbackId: string | null, text?: string): Promise<void> {
  if (!callbackId) return;
  await tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text, show_alert: false } : {}),
  });
}

/**
 * Idempotent webhook self-healing. Asks TELEGRAM for the CURRENT webhook
 * state (getWebhookInfo) and only calls setWebhook when it is missing or
 * points somewhere else. Safe to call from every dialog open, every session
 * activation and a periodic cron — the happy path costs one getWebhookInfo.
 */
export const ensureWebhookReady = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; registered: boolean; url?: string; error?: string }> => {
    const token = await resolveBotToken(ctx);
    if (!token) return { ok: false, registered: false, error: "Bot token not configured — set it in the Telegram Bot panel or Keys." };
    const url = process.env.CONVEX_SITE_URL;
    if (!url) return { ok: false, registered: false, error: "CONVEX_SITE_URL not configured" };
    const base = url.replace(/\/$/, "");
    const hookUrl = `${base}/api/telegram/webhook`;

    const info = await tgCall(token, "getWebhookInfo", {});
    const currentUrl = (info as unknown as { url?: string }).url ?? "";
    let ok = false;
    let registered = false;
    let reg: { ok: boolean; url?: string; error?: string } | null = null;
    if (info.ok && currentUrl === hookUrl) {
      ok = true;
    } else {
      // Registered via a runAction reference (an internalAction value is not
      // directly callable, and this keeps the forward reference type-safe).
      reg = await ctx.runAction(internal.telegramBot.registerWebhookInner, {});
      ok = reg.ok;
      registered = reg.ok;
    }
    // Keep Telegram's slash-command menu in sync (real setMyCommands call,
    // best-effort, re-pushed at most weekly / whenever a new token is saved).
    if (ok) {
      try {
        const row = await ctx.runQuery(internal.telegramBot.readConfigRow, {});
        const staleVersion = (row?.commandsVersion ?? 0) < BOT_COMMAND_VERSION;
        if (
          !row?.commandsPushedAt ||
          Date.now() - row.commandsPushedAt > 7 * 24 * 3600 * 1000 ||
          staleVersion
        ) {
          if (await pushCommandMenu(token)) {
            await ctx.runMutation(internal.telegramBot.stampCommandsPushed, {
              version: BOT_COMMAND_VERSION,
            });
          }
        }
      } catch {
        // Advisory only — webhook health is the verdict that matters here.
      }
    }
    await ctx.runMutation(internal.telegramBot.stampWebhookHealth, { ok });
    if (ok) return { ok: true, registered, url: hookUrl };
    return { ok: false, registered, url: reg?.url, error: reg?.error ?? info.description };
  },
});

/** Stamp when the setMyCommands menu was last pushed (weekly gate). */
export const stampCommandsPushed = internalMutation({
  args: { version: v.optional(v.number()) },
  handler: async (ctx, { version }): Promise<{ ok: boolean }> => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        commandsPushedAt: Date.now(),
        ...(version !== undefined ? { commandsVersion: version } : {}),
      });
    } else {
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        commandsPushedAt: Date.now(),
        ...(version !== undefined ? { commandsVersion: version } : {}),
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/** Stamp the last self-heal verdict (drives the header status chip). */
export const stampWebhookHealth = internalMutation({
  args: { ok: v.boolean() },
  handler: async (ctx, { ok }) => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      await ctx.db.patch(row._id, { webhookOk: ok, webhookCheckedAt: Date.now() });
    } else {
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        webhookOk: ok,
        webhookCheckedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/**
 * Cache the bot's @username (from a real getMe) on the config row so the
 * app's account menu can open Web Telegram directly with NO round-trip first
 * — the deep link is built from this cached value. Written by auto-connect,
 * webhook registration and the 10-minute self-heal cron.
 */
export const stampBotUsername = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, { username }): Promise<{ ok: boolean }> => {
    if (!username) return { ok: false };
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      if (row.botUsername === username) return { ok: true };
      await ctx.db.patch(row._id, { botUsername: username });
    } else {
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        botUsername: username,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/**
 * Live bot health for the header status chip. Non-throwing (a query must
 * never crash the tree); data is only meaningful for operator sessions —
 * recognized=false tells the chip to render nothing.
 */
export const getBotHealth = query({
  args: { deviceToken: v.optional(v.string()) },
  // Explicit return annotation breaks the generated-API type cycle
  // (telegramBot ⇄ terminal) — same guard as getBotStatus.
  handler: async (ctx, { deviceToken }): Promise<
    | { recognized: false }
    | {
        recognized: true;
        tokenConfigured: boolean;
        webhookOk: boolean | null;
        webhookCheckedAt: number | null;
        linkedChats: number;
        digestEnabled: boolean;
        /** Channel purge scope — its own switch; the tally covers both scopes. */
        channelPurge: boolean;
        /** Last purge sweep's tally — null until one has reported. */
        purgeLast: PurgeTelemetry | null;
        engineRunning: boolean | null;
        /** Independent SOL engine switch — its own start/stop state. */
        solEngineRunning: boolean | null;
        /** Cached @username — lets the account menu open Web Telegram directly. */
        botUsername: string | null;
        /** Live pairing code (null when expired/none) for the deep link. */
        pairing: { code: string; expiresAt: number } | null;
        /** Where the active token comes from: "app" = encrypted console-saved,
            "env" = deployment env fallback, null = none configured. */
        tokenSource: "app" | "env" | null;
        /** Last-4 hint of the app-saved token — never the plaintext. */
        tokenHint: string | null;
      }
  > => {
    let recognized = true;
    try {
      await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    } catch {
      recognized = false;
    }
    const row = recognized
      ? await ctx.db
          .query("telegramBotConfig")
          .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
          .first()
      : null;
    const chats = recognized ? await ctx.db.query("telegramBotChats").collect() : [];
    const state = recognized ? await ctx.runQuery(internal.terminal.botGetState, {}) : null;
    return {
      recognized,
      tokenConfigured: row?.webhookSecret !== undefined,
      webhookOk: row?.webhookOk ?? null,
      webhookCheckedAt: row?.webhookCheckedAt ?? null,
      linkedChats: chats.filter((c) => !c.blocked).length,
      digestEnabled: row?.digestEnabled ?? true,
      channelPurge: row?.channelPurge !== false,
      purgeLast: purgeTelemetryFrom(row) ?? null,
      engineRunning: state?.botRunning ?? null,
      solEngineRunning: state ? state.solBotRunning !== false : null,
      botUsername: row?.botUsername ?? null,
      pairing: row?.pairingCode
        ? { code: row.pairingCode, expiresAt: row.pairingExpiresAt ?? 0 }
        : null,
      tokenSource: !recognized
        ? null
        : row?.botTokenEnc
          ? "app"
          : envTokenPresent()
            ? "env"
            : null,
      tokenHint: recognized ? (row?.botTokenHint ?? null) : null,
    };
  },
});

/**
 * Current pairing state + bot prefs for the app dialog.
 * NEVER throws: a query that throws crashes the whole React tree with the
 * Convex error overlay. Sessions the server does not recognize as operator
 * (e.g. a guest session whose verified-code stamp never landed) get
 * `recognized: false` and the dialog shows an honest re-auth notice instead.
 */
export const getBotStatus = query({
  args: { deviceToken: v.optional(v.string()) },
  // Explicit return annotation breaks the generated-API type cycle
  // (telegramBot ⇄ terminal) that otherwise makes inference give up.
  handler: async (ctx, { deviceToken }): Promise<{
    recognized: boolean;
    digestEnabled: boolean;
    alertFanout: boolean;
    soundAlerts: boolean;
    autoPairOnStart: boolean;
    /** Auto-purge — tracked bot messages older than 10 min are deleted. */
    autoPurge: boolean;
    /** Channel purge — its own switch; channel posts older than 15 min go too. */
    channelPurge: boolean;
    /** Last purge sweep's tally (stamped by the every-10-minute cron) — null
        until one has reported, never a fabricated "0 deleted". */
    purgeLast: PurgeTelemetry | null;
    webhookOk: boolean | null;
    webhookCheckedAt: number | null;
    /** Cached @username — stamped by autoConnectBot and the webhook self-heal cron
        so the dialog's deep link and connected state are built from a server
        value that is always current on refetch. Present whenever the bot is
        recognized; explicit `null` only when the bot is not registered yet.
        The webhook self-heal path writes it to the config row before the
        dialog's first refetch lands, so the first-open transition never lags.
        The caller (TelegramBotDialog) reads it off the reactive getBotStatus
        query, not a local optimistic view. */
    botUsername: string | null;
    engineRunning: boolean | null;
    /** Where the active token comes from: "app" = encrypted console-saved,
        "env" = deployment env fallback, null = none configured. The
        plaintext itself is NEVER returned — only the last-4 hint. */
    tokenSource: "app" | "env" | null;
    tokenHint: string | null;
    tokenSetAt: number | null;
    linkedChats: Array<{
      _id: Id<"telegramBotChats">;
      chatId: string;
      title: string | null;
      username: string | null;
      linkedAt: number;
      lastSeenAt: number;
    }>;
  }> => {
    let recognized = true;
    try {
      await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    } catch {
      recognized = false;
    }
    // Read-only: a query cannot mutate, so the config row is created lazily
    // by issuePairingCode / the webhook instead of here.
    const row = recognized
      ? await ctx.db
          .query("telegramBotConfig")
          .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
          .first()
      : null;
    const chats = recognized ? await ctx.db.query("telegramBotChats").collect() : [];
    // Real engine state — the dialog's START/STOP reflects the SAME switch
    // the bot and the terminal use (not a local guess).
    const state = recognized ? await ctx.runQuery(internal.terminal.botGetState, {}) : null;
    return {
      recognized,
      digestEnabled: row?.digestEnabled ?? true,
      alertFanout: row?.alertFanout ?? true,
      soundAlerts: row?.soundAlerts ?? true,
      autoPairOnStart: row?.autoPairOnStart !== false,
      autoPurge: row?.autoPurge !== false,
      channelPurge: row?.channelPurge !== false,
      purgeLast: purgeTelemetryFrom(row) ?? null,
      webhookOk: row?.webhookOk ?? null,
      webhookCheckedAt: row?.webhookCheckedAt ?? null,
      botUsername: row?.botUsername ?? null,
      engineRunning: state?.botRunning ?? null,
      tokenSource: !recognized
        ? null
        : row?.botTokenEnc
          ? "app"
          : envTokenPresent()
            ? "env"
            : null,
      tokenHint: recognized ? (row?.botTokenHint ?? null) : null,
      tokenSetAt: recognized ? (row?.botTokenSetAt ?? null) : null,
      linkedChats: chats
        .filter((c) => !c.blocked)
        .map((c) => ({
          _id: c._id,
          chatId: c.chatId,
          title: c.title ?? null,
          username: c.username ?? null,
          linkedAt: c.linkedAt,
          lastSeenAt: c.lastSeenAt,
        })),
    };
  },
});

/**
 * Operator gate for the bot's web-side surface. Accepts THREE identities:
 *   1. a signed-in operator email (canonical/alt hash or an active
 *      registered operator email);
 *   2. a "Continue as Guest" session whose Convex Auth user row carries the
 *      `guestOperatorVerifiedAt` stamp set by gate.activateGuestOperatorSession
 *      after the guest access code was verified server-side; or
 *   3. a SERVER-ISSUED DEVICE TRUST token (operatorDeviceTrust) minted after
 *      a real verification on this browser — survives anonymous-session
 *      churn, so a verified device is always recognized (no amber banner).
 * Returns "guest" for guest/device sessions or the verified operator email.
 */
export async function requireOperatorEmail(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  deviceToken?: string | null,
): Promise<string> {
  const { isGuestOperatorSession, isOperatorEmail, isTrustedDeviceToken } = await import("./operatorEmails");
  const guestUserId = await isGuestOperatorSession(ctx);
  if (guestUserId) return "guest";
  if (deviceToken && (await isTrustedDeviceToken({ db: ctx.db }, deviceToken))) {
    return "device";
  }
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email?.trim().toLowerCase();
  if (!email) throw new Error("Operator access required.");
  if (!(await isOperatorEmail({ db: ctx.db }, email))) throw new Error("Operator access required.");
  return email;
}

/**
 * The same three-identity verdict reachable from ACTIONS (ActionCtx has no
 * db) — autoConnectBot runs it through this internal query so the gate logic
 * stays single-sourced with the queries/mutations above.
 */
export const verifyOperatorInternal = internalQuery({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (
    ctx,
    { deviceToken },
  ): Promise<{ ok: true; identity: string } | { ok: false; error: string }> => {
    try {
      const identity = await requireOperatorEmail(ctx, deviceToken ?? null);
      return { ok: true, identity };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Operator access required." };
    }
  },
});

/**
 * Auto-connect the Telegram bot on the first dialog open.
 *
 * What this does, in order:
 *   1. Verify the operator identity (device trust OR signed-in operator email);
 *   2. Self-heal the webhook (ensureWebhookReady — getWebhookInfo, then set if needed);
 *   3. Issue a live pairing code if none is active (autoIssuePairingCode);
 *   4. Stamp the bot's @username (getMe → readConfigRow → stampBotUsername).
 *
 * Identity-guarded: a guest session cannot auto-connect; it falls through to
 * the dialog's "Session not recognized" banner. One attempt per session — the
 * dialog's `attemptRef` guard makes re-renders and status-query refetches
 * impossible to fire it again.
 *
 * Returns { ok, webhook, pairing, botUsername, deviceToken, error } where
 *   - ok:   true when identity + webhook self-heal + pairing code all landed
 *   - webhook:  { ok, registered, url } from ensureWebhookReady
 *   - pairing:  { code, expiresAt } from autoIssuePairingCode (null if none issued)
 *   - botUsername:  the stamped @username (null when not yet stamped)
 *   - deviceToken:  the freshly minted device-trust token (null on second+ open)
 *   - error:  human-readable failure reason
 */
export const autoConnectBot = action({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<{
    ok: boolean;
    webhook: { ok: boolean; registered: boolean; url?: string; error?: string };
    pairing: { code: string; expiresAt: number } | null;
    botUsername: string | null;
    deviceToken: string | null;
    error: string | null;
  }> => {
    // 1. Identity gate — actions carry no db, so the identical verdict runs
    // through the internal query above (verifyOperatorInternal).
    let identity: string;
    try {
      const gate = await ctx.runQuery(internal.telegramBot.verifyOperatorInternal, {
        deviceToken: deviceTokenFromClient(deviceToken) ?? undefined,
      });
      if (!gate.ok) {
        return {
          ok: false,
          webhook: { ok: false, registered: false, error: "Operator access required." },
          pairing: null,
          botUsername: null,
          deviceToken: null,
          error: gate.error,
        };
      }
      identity = gate.identity;
    } catch {
      return {
        ok: false,
        webhook: { ok: false, registered: false, error: "Operator access required." },
        pairing: null,
        botUsername: null,
        deviceToken: null,
        error: "Operator access required.",
      };
    }
    if (identity === "guest") {
      return {
        ok: false,
        webhook: { ok: false, registered: false, error: "Session not recognized — re-verify in /auth." },
        pairing: null,
        botUsername: null,
        deviceToken: null,
        error: "Session not recognized — re-verify in /auth.",
      };
    }

    // 2. Webhook self-heal (real Telegram call).
    let webhook: { ok: boolean; registered: boolean; url?: string; error?: string } = {
      ok: false,
      registered: false,
      error: "Bot token not configured — set it in the Telegram Bot panel or Keys.",
    };
    try {
      webhook = await ctx.runAction(internal.telegramBot.ensureWebhookReady, {});
      if (!webhook.ok) {
        return { ok: false, webhook, pairing: null, botUsername: null, deviceToken: null, error: webhook.error ?? "Webhook self-heal failed." };
      }
    } catch (err) {
      return { ok: false, webhook, pairing: null, botUsername: null, deviceToken: null, error: "Webhook self-heal threw." };
    }

    // 3. Pair + stamp the bot username.
    const pairing = await ctx.runMutation(internal.telegramBot.autoIssuePairingCode, {});
    const me = await ctx.runAction(internal.telegramBot.getMe, {});
    const row = await ctx.runQuery(internal.telegramBot.readConfigRow, {});
    let botUsername: string | null = row?.botUsername ?? null;
    if (me?.username && !botUsername) {
      botUsername = me.username;
      await ctx.runMutation(internal.telegramBot.stampBotUsername, { username: me.username });
    }
    if (!pairing?.code) {
      return { ok: false, webhook, pairing: null, botUsername, deviceToken: null, error: "No pairing code available." };
    }

    // Mint a device-trust token for the current browser on a fresh open.
    let deviceTokenOut: string | null = null;
    if (identity === "device") {
      deviceTokenOut = randomToken(64);
    }
    return { ok: true, webhook, pairing, botUsername, deviceToken: deviceTokenOut, error: null };
  },
});

/**
 * INTERNAL: self-heal the webhook + auto-issue a pairing code + stamp the
 * bot username — called by the dialog's autoConnect and the 10-minute cron.
 * Server-side only; the dialog never calls this directly.
 */
export const ensureBotReadyInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; error: string | null }> => {
    const token = await resolveBotToken(ctx);
    if (!token) {
      return { ok: false, error: "Bot token not configured — set it in the Telegram Bot panel or Keys." };
    }

    // 1. Webhook self-heal.
    let webhookOk = false;
    try {
      const res = await ctx.runAction(internal.telegramBot.ensureWebhookReady, {});
      webhookOk = res.ok;
    } catch (err) {
      return { ok: false, error: "Webhook self-heal failed." };
    }

    // 2. Auto-issue a pairing code.
    let pairing: { code: string; expiresAt: number } | null = null;
    try {
      pairing = await ctx.runMutation(internal.telegramBot.autoIssuePairingCode, {});
    } catch {
      return { ok: webhookOk, error: webhookOk ? "Webhook self-heal OK but pairing code unavailable." : "Pairing code unavailable." };
    }

    // 3. Stamp the bot username.
    let botUsername: string | null = null;
    try {
      const me = await ctx.runAction(internal.telegramBot.getMe, {});
      const row = await ctx.runQuery(internal.telegramBot.readConfigRow, {});
      botUsername = row?.botUsername ?? (me?.username ?? null);
      if (me?.username) {
        await ctx.runMutation(internal.telegramBot.stampBotUsername, { username: me.username });
      }
    } catch {
      // Username stamp is advisory; keep the rest of the self-heal intact.
    }

    return { ok: webhookOk, error: pairing ? null : "Pairing code unavailable." };
  },
});

/** Issue a fresh pairing code (self-heal cron + auto-connect path). */
export const autoIssuePairingCode = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.telegramBot.ensureConfig, {});
    const code = randomToken(6).toUpperCase();
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    if (row) await ctx.db.patch(row._id, { pairingCode: code, pairingExpiresAt: expiresAt });
    else
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        pairingCode: code,
        pairingExpiresAt: expiresAt,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        updatedAt: Date.now(),
      });
    return { code, expiresAt };
  },
});

/**
 * Operator-gated manual rotation — the dialog's "Refresh" button. Same
 * single-code-at-a-time rotation as the self-heal path, gated by the
 * three-identity operator verdict first.
 */
export const issuePairingCode = mutation({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<{ code: string; expiresAt: number }> => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    return await ctx.runMutation(internal.telegramBot.autoIssuePairingCode, {});
  },
});

/**
 * Persist the operator's bot token — encrypted at rest (AES-GCM via
 * encryption.ts) inside an INTERNAL mutation so the plaintext only ever
 * exists inside this backend function. Also stamps the probed @username and
 * clears the command-menu stamp so the NEXT webhook pass pushes setMyCommands
 * for this exact bot.
 */
export const storeBotToken = internalMutation({
  args: { token: v.string(), username: v.string() },
  handler: async (ctx, { token, username }): Promise<{ ok: boolean }> => {
    const enc = await encryptSecret(ctx, token);
    const now = Date.now();
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    const common = {
      botTokenEnc: enc,
      botTokenHint: token.slice(-4),
      botTokenSetAt: now,
      botUsername: username,
      updatedAt: now,
    };
    if (row) {
      await ctx.db.patch(row._id, { ...common, commandsPushedAt: undefined });
    } else {
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        ...common,
      });
    }
    return { ok: true };
  },
});

/**
 * Save + VERIFY the operator's bot token from the console's mini-dashboard.
 * Nothing is stored until Telegram's own getMe accepts the token:
 *   1. operator gate (device trust / signed-in operator email);
 *   2. format check (BotFather "id:secret" shape);
 *   3. live getMe probe against the CANDIDATE token;
 *   4. encrypt + persist, then webhook + command-menu self-heal.
 * The plaintext never reaches any client — only the @username and the last-4
 * hint come back.
 */
export const setBotToken = action({
  args: { deviceToken: v.optional(v.string()), token: v.string() },
  handler: async (
    ctx,
    { deviceToken, token },
  ): Promise<{ ok: boolean; username: string | null; webhookOk: boolean; error: string | null }> => {
    const gate = await ctx.runQuery(internal.telegramBot.verifyOperatorInternal, {
      deviceToken: deviceTokenFromClient(deviceToken) ?? undefined,
    });
    if (!gate.ok) return { ok: false, username: null, webhookOk: false, error: gate.error };
    const t = token.trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(t)) {
      return {
        ok: false,
        username: null,
        webhookOk: false,
        error: "Invalid token format — copy the full token from @BotFather (it looks like 123456789:AA...).",
      };
    }
    const me = await fetchMe(t);
    if (!me) {
      return {
        ok: false,
        username: null,
        webhookOk: false,
        error: "Telegram rejected this token (getMe failed) — regenerate it with @BotFather and try again.",
      };
    }
    await ctx.runMutation(internal.telegramBot.storeBotToken, { token: t, username: me.username });
    // Register the webhook + push the command menu for THIS bot (best-effort;
    // the 10-minute self-heal cron retries anything that did not land).
    let webhookOk = false;
    try {
      const res = await ctx.runAction(internal.telegramBot.ensureWebhookReady, {});
      webhookOk = res.ok;
    } catch {
      // Advisory — the token itself is saved and verified.
    }
    return { ok: true, username: me.username, webhookOk, error: null };
  },
});

/**
 * Remove the app-stored token (falls back to the deployment env token on the
 * next resolve). Operator-gated; only the ciphertext is cleared.
 */
export const clearBotToken = mutation({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<{ ok: boolean }> => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        botTokenEnc: undefined,
        botTokenHint: undefined,
        botTokenSetAt: undefined,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/** Fetch the bot's own @username via getMe (stored token first, env fallback). */
export const getMe = internalAction({
  args: {},
  handler: async (ctx): Promise<{ username: string } | null> => {
    const token = await resolveBotToken(ctx);
    if (!token) return null;
    return await fetchMe(token);
  },
});

export const unlinkChat = mutation({
  args: { chatId: v.string(), deviceToken: v.optional(v.string()) },
  handler: async (ctx, { chatId, deviceToken }) => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    const row = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

export const setAutoPair = mutation({
  args: { enabled: v.boolean(), deviceToken: v.optional(v.string()) },
  handler: async (ctx, { enabled, deviceToken }) => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    await ctx.runMutation(internal.telegramBot.ensureConfig, {});
    await ctx.runMutation(internal.telegramBot.setBotPref, { autoPairOnStart: enabled });
    return { ok: true, enabled };
  },
});

/**
 * Auto-purge switch from the app's Telegram Bot panel — the same setting the
 * bot's /alerts board flips. Operator-gated like every other dialog mutation.
 */
export const setAutoPurge = mutation({
  args: { enabled: v.boolean(), deviceToken: v.optional(v.string()) },
  handler: async (ctx, { enabled, deviceToken }) => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    await ctx.runMutation(internal.telegramBot.ensureConfig, {});
    await ctx.runMutation(internal.telegramBot.setBotPref, { autoPurge: enabled });
    return { ok: true, enabled };
  },
});

/**
 * Channel-purge switch from the app's Telegram Bot panel — the same scope the
 * bot's /alerts board flips. Separate from auto-purge on purpose: the channel
 * is a feed, and clearing chat boards must never be the thing that decides
 * whether the channel's posts survive.
 */
export const setChannelPurge = mutation({
  args: { enabled: v.boolean(), deviceToken: v.optional(v.string()) },
  handler: async (ctx, { enabled, deviceToken }) => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    await ctx.runMutation(internal.telegramBot.ensureConfig, {});
    await ctx.runMutation(internal.telegramBot.setBotPref, { channelPurge: enabled });
    return { ok: true, enabled };
  },
});

export const sendSimTradeAlert = mutation({
  args: { deviceToken: v.optional(v.string()) },
  // Explicit return type breaks the generated-API inference cycle
  // (telegramBot ⇄ terminal) — same guard as getBotStatus/getBotHealth.
  // Shape is the dialog's "Send test alert" button contract: { ok, recipients, error }.
  handler: async (
    ctx,
    { deviceToken },
  ): Promise<{ ok: boolean; recipients: number; error: string | null }> => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row?.alertFanout) {
      return {
        ok: false,
        recipients: 0,
        error: "Trade-alert mirror is OFF — turn it on from the bot's /alerts board first.",
      };
    }
    const alerts: Array<{ chatId: string }> = await ctx.runQuery(internal.telegramBot.listChats, {
      activeOnly: true,
    });
    if (!alerts.length) {
      return { ok: false, recipients: 0, error: "No paired chats yet — pair one from this dialog first." };
    }
    // The actual sends are SCHEDULED as actions — Convex mutations can never fetch.
    for (const chat of alerts) {
      await ctx.scheduler.runAfter(0, internal.telegramBot.sendSimAlert, { chatId: chat.chatId });
    }
    return { ok: true, recipients: alerts.length, error: null };
  },
});

// NOTE: an ACTION, never a mutation — Telegram sends are network I/O, which
// Convex mutations cannot perform. Scheduled by sendSimTradeAlert.
export const sendSimAlert = internalAction({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const token = await resolveBotToken(ctx);
    if (!token) {
      return { ok: false, error: "Bot token not configured — set it in the Telegram Bot panel or Keys." };
    }
    const res = await sendPayload(
      ctx,
      token,
      chatId,
      "⚡ Simulated trade alert — check the Trade terminal for this position.",
      null,
      false,
    );
    return { ok: res.ok, error: res.ok ? null : res.description };
  },
});

export const registerWebhookInner = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const token = await resolveBotToken(ctx);
    if (!token) {
      return { ok: false, error: "Bot token not configured — set it in the Telegram Bot panel or Keys." };
    }
    const url = process.env.CONVEX_SITE_URL;
    if (!url) return { ok: false, error: "CONVEX_SITE_URL not configured" };
    const base = url.replace(/\/$/, "");
    const hookUrl = `${base}/api/telegram/webhook`;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: hookUrl, allowed_updates: ["message", "callback_query"] }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (data.ok) return { ok: true, url: hookUrl };
    return { ok: false, error: data.description ?? "setWebhook rejected" };
  },
});

// ---------------------------------------------------------------------------
// /start auto-pair linking (no code — schema policy autoPairOnStart, default ON)
// ---------------------------------------------------------------------------

/**
 * Link a chat with NO pairing code — the server-side /start auto-pair
 * policy. Only the verified webhook path reaches this (the secret gate in
 * handleUpdate runs first), and the dialog's "/start auto-pair" toggle turns
 * the policy off to force app-issued codes again.
 */
export const linkChat = internalMutation({
  args: {
    chatId: v.string(),
    title: v.optional(v.string()),
    username: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, title, username }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("telegramBotChats")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        linkedAt: now,
        lastSeenAt: now,
        blocked: false,
        ...(title ? { title } : {}),
        ...(username ? { username } : {}),
      });
    } else {
      await ctx.db.insert("telegramBotChats", {
        chatId,
        title,
        username,
        linkedAt: now,
        lastSeenAt: now,
        silent: false,
        blocked: false,
      });
    }
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Message tracking + the 10-minute purge
//
// Every message the bot posts (chat boards, digests, trade alerts) and every
// post to the configured CHANNEL is recorded with its real Telegram message id,
// then deleted by `purgeBotMessages` once it is older than its window: 10 min
// for chat posts (`BOT_MESSAGE_TTL_MS`), 15 min for channel posts
// (`CHANNEL_MESSAGE_TTL_MS`) — the channel's session board posts every 15, so a
// 10-minute window blanked it for five minutes each cycle. That keeps a chat
// that gets a board every few minutes readable: it shows the last ten minutes,
// not an unbounded scrollback.
// Chat boards and channel posts are separate SCOPES: `autoPurge` clears chats,
// `channelPurge` clears the channel, and `/purge` in a chat only ever selects
// `source: "bot"`. The sweep is bounded, batched and idempotent.
// ---------------------------------------------------------------------------

/** Record a delivered message so a later sweep can delete it. */
export const recordBotMessage = internalMutation({
  args: {
    chatId: v.string(),
    messageId: v.number(),
    source: v.union(v.literal("bot"), v.literal("channel")),
  },
  handler: async (ctx, { chatId, messageId, source }) => {
    await ctx.db.insert("telegramBotMessages", {
      chatId,
      messageId,
      source,
      sentAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * List the oldest tracked messages at or before `cutoff` WITHOUT removing
 * them. Rows now leave the table only after the delete attempt has a verdict
 * (`dropTrackedMessages`), so a transient refusal can be retried instead of
 * silently untracking a message that is still in the chat.
 *
 * One selection rule (`selectPurgeable`) still decides the window and both
 * scopes for the cron sweep, `/purge` and the panel.
 */
export const listStaleMessages = internalQuery({
  args: {
    cutoff: v.number(),
    limit: v.number(),
    chatId: v.optional(v.string()),
    /** One surface only — `/purge` in a chat must never select channel rows. */
    source: v.optional(v.union(v.literal("bot"), v.literal("channel"))),
  },
  handler: async (ctx, { cutoff, limit, chatId, source }) => {
    const rows = chatId
      ? await ctx.db
          .query("telegramBotMessages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .take(limit)
      : await ctx.db
          .query("telegramBotMessages")
          .withIndex("by_sent", (q) => q.lte("sentAt", cutoff))
          .take(limit);
    return selectPurgeable(rows, {
      cutoff,
      ...(chatId ? { chatId } : {}),
      ...(source ? { source } : {}),
    });
  },
});

/**
 * Forget tracking rows whose delete has a final verdict: Telegram accepted it,
 * or refused it permanently (`classifyPurgeFailure`). Idempotent — a row that a
 * concurrent sweep already removed is skipped, not an error.
 */
export const dropTrackedMessages = internalMutation({
  args: { ids: v.array(v.id("telegramBotMessages")) },
  handler: async (ctx, { ids }) => {
    let dropped = 0;
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.db.delete(id);
      dropped += 1;
    }
    return { dropped };
  },
});

/** One source-scoped sweep result; `retrying` rows stayed tracked. */
type PurgeResult = { deleted: number; failed: number; retrying: number };

/**
 * Delete tracked messages in bounded batches. The attempt comes FIRST: a row is
 * dropped only once Telegram has a verdict — accepted, or refused permanently
 * (message gone / past its 48 h delete limit). A transient refusal (missing
 * rights, kicked bot, rate limit, 5xx, network) keeps the row tracked so the
 * next sweep retries it. Rows attempted in this run are skipped by id, so a
 * retry backlog cannot make the batch loop spin on the same rows.
 */
async function deleteTrackedMessages(
  ctx: ActionCtx,
  token: string,
  cutoff: number,
  scope: { chatId?: string; source?: BotMessageSource } = {},
): Promise<PurgeResult> {
  let deleted = 0;
  let failed = 0;
  let retrying = 0;
  const attempted = new Set<string>();
  const limit = 100;
  for (let pass = 0; pass < 5; pass += 1) {
    const batch = await ctx.runQuery(internal.telegramBot.listStaleMessages, {
      cutoff,
      limit,
      ...(scope.chatId ? { chatId: scope.chatId } : {}),
      ...(scope.source ? { source: scope.source } : {}),
    });
    const rows = batch.filter((row) => !attempted.has(row._id));
    if (!rows.length) break;
    const settled: Array<Id<"telegramBotMessages">> = [];
    for (const msg of rows) {
      attempted.add(msg._id);
      const res = await tgCall(token, "deleteMessage", {
        chat_id: msg.chatId,
        message_id: msg.messageId,
      });
      if (res.ok) {
        deleted += 1;
        settled.push(msg._id);
        continue;
      }
      failed += 1;
      if (classifyPurgeFailure(res.description) === "permanent") settled.push(msg._id);
      else retrying += 1;
    }
    if (settled.length) {
      try {
        await ctx.runMutation(internal.telegramBot.dropTrackedMessages, { ids: settled });
      } catch {
        // The rows stay tracked; a later sweep re-drops them (a second delete
        // of an already-gone message classifies as permanent, so it settles).
      }
    }
    if (batch.length < limit) break;
  }
  return { deleted, failed, retrying };
}

/**
 * Stamp the last sweep's tally on the config row. Telemetry ONLY: it never
 * decides what gets deleted, and the sweep treats a failed stamp as a non-event
 * (a delivered delete must not be reported as a failed one because bookkeeping
 * hiccuped). An existing row is patched; a row is created only when the
 * deployment runs the sweep without one (env token, no config row yet).
 */
export const stampPurgeRun = internalMutation({
  args: {
    at: v.number(),
    deleted: v.number(),
    failed: v.number(),
    retrying: v.number(),
    skipped: v.optional(v.string()),
  },
  handler: async (ctx, { at, deleted, failed, retrying, skipped }) => {
    const patch = {
      purgeLastAt: at,
      purgeLastDeleted: deleted,
      purgeLastFailed: failed,
      purgeLastRetrying: retrying,
      purgeLastSkipped: skipped,
      // A clean sweep ends the fault, so the alert throttle AND the cap start
      // fresh: the NEXT fault must alert on its second failing sweep, and get
      // its own six alerts, not inherit the previous fault's stamps.
      // `undefined` deletes the fields.
      ...(failed === 0
        ? { purgeAlertedAt: undefined, purgeAlertsSent: undefined, purgeFaultSince: undefined }
        : {}),
    };
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("telegramBotConfig", {
        key: CONFIG_KEY,
        webhookSecret: randomToken(32),
        digestEnabled: true,
        alertFanout: true,
        soundAlerts: true,
        ...patch,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/**
 * Record that a fault alert went out, so the next sweeps can be throttled and
 * the cap can count. Written BEFORE the sends on purpose: if the alert path
 * crashes halfway, the chats that were spared a repeat should not be re-spammed
 * ten minutes later, and a crash must not hand the fault a fresh sixth alert.
 * A clean sweep clears all three stamps via `stampPurgeRun`.
 */
export const markPurgeAlert = internalMutation({
  args: { at: v.number(), alertsSent: v.number(), faultSince: v.number() },
  handler: async (ctx, { at, alertsSent, faultSince }) => {
    const row = await ctx.db
      .query("telegramBotConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        purgeAlertedAt: at,
        purgeAlertsSent: alertsSent,
        purgeFaultSince: faultSince,
      });
    }
    return { ok: true };
  },
});

/**
 * Ping every linked chat when two sweeps in a row could not delete. Best-effort
 * by construction: an undeliverable alert must never turn a sweep into a
 * failure. `plan` already decided repetition (hourly) and the cap, and it is
 * the single source of the wording — the bell entry and the chat message can
 * never disagree about which repeat this is.
 */
async function alertPurgeFailures(
  ctx: ActionCtx,
  token: string,
  cfg: BotConfig,
  previous: PurgeTelemetry | null,
  current: PurgeTelemetry,
  now: number,
  plan: PurgeAlertInfo,
): Promise<number> {
  // The bell entry is the channel that still works when Telegram itself is the
  // broken one, so it is written FIRST and independently of any chat existing.
  try {
    await ctx.runMutation(internal.notifications.recordBotHealthAlert, {
      title: "Message sweep failing",
      body: purgeFailureSummary(previous, current, now, plan),
    });
  } catch {
    // Advisory only — the stamped tally stays the record of the fault.
  }
  const chats = await ctx.runQuery(internal.telegramBot.listChats, { activeOnly: true });
  if (!chats.length) return 0;
  const text = purgeFailureAlert(previous, current, now, plan);
  let sent = 0;
  for (const chat of chats) {
    try {
      const res = await sendPayload(ctx, token, chat.chatId, text, null, disableNotification(chat, cfg));
      if (res.ok) sent += 1;
    } catch {
      // Advisory only — the stamped tally stays the record of the fault.
    }
  }
  return sent;
}

/**
 * The every-10-minutes sweep (cron `telegram-bot-purge`): deletes tracked bot
 * posts older than `BOT_MESSAGE_TTL_MS` and channel posts older than
 * `CHANNEL_MESSAGE_TTL_MS`. No-ops when auto-purge is off, so turning it off
 * has no side effects on content that is already posted.
 *
 * Every outcome is stamped, including the ones that delete nothing: `/alerts`
 * then shows whether the sweep is running, what it removed, and why it stood
 * down — the difference between "nothing to delete" and "never ran".
 *
 * `skipped` is reserved for a sweep that attempted NOTHING. A scope switch that
 * is off (channel purge) is not a skip: the chat scope still ran and its tally
 * must survive into the stamp.
 */
export const purgeBotMessages = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    deleted: number;
    failed: number;
    retrying: number;
    alerted: number;
    skipped?: string;
  }> => {
    const cfg = await ctx.runQuery(internal.telegramBot.getConfig, {});
    // No config row at all is not "auto-purge off" — say what is true.
    if (!cfg) {
      return { ok: true, deleted: 0, failed: 0, retrying: 0, alerted: 0, skipped: "not configured" };
    }

    const stamp = async (
      deleted: number,
      failed: number,
      retrying: number,
      skipped?: string,
    ): Promise<number> => {
      const at = Date.now();
      try {
        await ctx.runMutation(internal.telegramBot.stampPurgeRun, {
          at,
          deleted,
          failed,
          retrying,
          ...(skipped ? { skipped } : {}),
        });
      } catch {
        // Telemetry only — never fail a sweep because its tally did not land.
      }
      return at;
    };

    const now = Date.now();
    const token = cfg.autoPurge ? await resolveBotToken(ctx) : null;
    const skipped = purgeSkipNote({ autoPurge: cfg.autoPurge, tokenConfigured: token !== null });
    if (skipped) {
      await stamp(0, 0, 0, skipped);
      return {
        ok: skipped !== "bot token not configured",
        deleted: 0,
        failed: 0,
        retrying: 0,
        alerted: 0,
        skipped,
      };
    }
    if (!token) {
      // `purgeSkipNote` already covers this; the guard keeps the types honest.
      return {
        ok: false,
        deleted: 0,
        failed: 0,
        retrying: 0,
        alerted: 0,
        skipped: "bot token not configured",
      };
    }

    // Two scopes, one sweep, two windows. Chat boards clear whenever auto-purge
    // is on; channel posts follow `channelPurge` and outlive the chat window,
    // because the channel's session board only posts every 15 minutes.
    const bot = await deleteTrackedMessages(ctx, token, purgeCutoff(now), { source: "bot" });
    const channel = cfg.channelPurge
      ? await deleteTrackedMessages(ctx, token, purgeCutoff(now, CHANNEL_MESSAGE_TTL_MS), {
          source: "channel",
        })
      : { deleted: 0, failed: 0, retrying: 0 };
    const deleted = bot.deleted + channel.deleted;
    const failed = bot.failed + channel.failed;
    const retrying = bot.retrying + channel.retrying;
    const at = await stamp(deleted, failed, retrying);

    // `cfg.purgeLast` was read before this sweep ran, so it IS the previous
    // tally — a two-in-a-row fault needs no extra stored state. The count and
    // the fault's start are what a tally cannot carry, and `markPurgeAlert`
    // stores them together with the throttle stamp.
    let alerted = 0;
    const plan = purgeAlertPlan({
      previous: cfg.purgeLast,
      failed,
      lastAlertedAt: cfg.purgeAlertedAt ?? null,
      alertsSent: cfg.purgeAlertsSent,
      faultSince: cfg.purgeFaultSince ?? null,
      now: at,
    });
    if (plan.alert) {
      try {
        await ctx.runMutation(internal.telegramBot.markPurgeAlert, {
          at,
          alertsSent: plan.number,
          faultSince: plan.since ?? at,
        });
      } catch {
        // A failed stamp must not silence the alert: worst case it repeats on
        // the next sweep, which is better than never telling the operator.
      }
      alerted = await alertPurgeFailures(
        ctx,
        token,
        cfg,
        cfg.purgeLast ?? null,
        { at, deleted, failed, skipped: null },
        at,
        plan,
      );
    }

    return { ok: true, deleted, failed, retrying, alerted };
  },
});

/**
 * /purge — clear THIS chat's tracked **bot** messages immediately.
 *
 * Deliberately source-scoped: a `/purge` typed in a chat is the operator
 * clearing the board in front of them. Channel posts are the channel's record
 * and are only ever cleared by the channel sweep, never as a side effect of a
 * chat command.
 */
export const purgeChatMessages = internalAction({
  args: { chatId: v.string() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ ok: boolean; deleted: number; failed: number; retrying: number }> => {
    const token = await resolveBotToken(ctx);
    if (!token) return { ok: false, deleted: 0, failed: 0, retrying: 0 };
    const res = await deleteTrackedMessages(ctx, token, Date.now(), { chatId, source: "bot" });
    return { ok: true, ...res };
  },
});

// ---------------------------------------------------------------------------
// Trade-alert fanout (scheduled by terminal.applyExecution / serverAutoExecution)
// ---------------------------------------------------------------------------

/**
 * Mirror a REAL successful trade to every paired operator chat — scheduled
 * AFTER the trade commit so a chat hiccup can never fail the ledger write.
 * No-ops when the mirror is off or nothing is paired. An ACTION: Telegram
 * sends are network I/O, which mutations can never perform.
 */
export const fanoutTradeAlert = internalAction({
  args: {
    role: v.string(),
    amountBnb: v.number(),
    symbol: v.string(),
    label: v.string(),
    lender: v.optional(v.string()),
    profitPct: v.number(),
    network: v.string(),
    earnings: v.number(),
    txHash: v.optional(v.string()),
    sim: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; sent: number }> => {
    const cfg = await ctx.runQuery(internal.telegramBot.getConfig, {});
    if (!cfg?.alertFanout) return { ok: true, sent: 0 };
    const chats = await ctx.runQuery(internal.telegramBot.listChats, { activeOnly: true });
    if (!chats.length) return { ok: true, sent: 0 };
    const token = (await resolveBotToken(ctx)) ?? "";
    const text = tradeAlertMessage({
      role: args.role,
      amount: args.amountBnb,
      symbol: args.symbol,
      label: args.label,
      lender: args.lender,
      profitPct: args.profitPct,
      network: args.network,
      earnings: args.earnings,
      txHash: args.txHash,
      sim: args.sim,
    });
    let sent = 0;
    for (const chat of chats) {
      const res = await sendPayload(ctx, token, chat.chatId, text, null, disableNotification(chat, cfg));
      if (res.ok) sent += 1;
    }
    return { ok: true, sent };
  },
});

// ---------------------------------------------------------------------------
// Shared read-side helpers for the webhook action (actions have no ctx.db —
// everything below goes through internal queries).
// ---------------------------------------------------------------------------

/** Operator feed settings derived from the persisted terminal state. */
function feedSettingsFor(state: Doc<"terminalStates"> | null): FeedSettings {
  if (!state) return { ...DEFAULT_FEED_SETTINGS };
  const perChain = state.dexWhitelists?.[state.chainKey];
  const dexWhitelist = perChain?.length
    ? perChain
    : state.dexWhitelist.length
      ? state.dexWhitelist
      : DEFAULT_FEED_SETTINGS.dexWhitelist;
  return {
    ...DEFAULT_FEED_SETTINGS,
    dexWhitelist,
    minProfit: state.minProfit,
    maxHops: state.maxHops === 2 ? 2 : 3,
    mevGuard: state.mevGuard,
    maxLoan: state.maxLoan,
    loanAssets: state.loanAssets,
  };
}

/** Doc → the BNB/SOL dashboard DTO (derived arming flags computed here). */
function stateLite(state: Doc<"terminalStates">): TerminalStateLite {
  const evmWallets = state.evmImportedWallets ?? [];
  const contractDeployed =
    Boolean(state.deployedContractAddress) ||
    Object.values(state.deployments ?? {}).some((d) => Boolean(d?.contractAddress));
  const armedWallet = state.connectedWallets.length > 0 || evmWallets.length > 0;
  return {
    botRunning: state.botRunning,
    solBotRunning: state.solBotRunning,
    mode: state.mode,
    contractDeployed,
    liveReady: contractDeployed && armedWallet,
    balance: state.balance,
    lifetimePnl: state.lifetimePnl,
    executionsToday: state.executionsToday,
    successesToday: state.successesToday,
    successRate: state.successRate,
    scansToday: state.scansToday,
    openOpportunities: state.openOpportunities,
    minProfit: state.minProfit,
    maxLoan: state.maxLoan,
    maxHops: state.maxHops,
    slippage: state.slippage,
    gasPriority: state.gasPriority,
    autoPayout: state.autoPayout,
    mevGuard: state.mevGuard,
    privateSubmit: state.privateSubmit,
    lenderBalancer: state.lenderBalancer,
    cadence: state.cadence,
    network: state.network,
    chainKey: state.chainKey,
    dailyArbTarget: state.dailyArbTarget,
    connectedWallets: state.connectedWallets,
    solNetwork: state.solNetwork,
    solBuyAmountSol: state.solBuyAmountSol,
    solSellAmountPct: state.solSellAmountPct,
    solSlippagePct: state.solSlippagePct,
    solProfitTargetPct: state.solProfitTargetPct,
    solTrailingStopPct: state.solTrailingStopPct,
    solMinLiquidityUsd: state.solMinLiquidityUsd,
  };
}

/**
 * One honest live-feed route read for /routes and /bnb_scan: real snapshot,
 * real gas, the operator's own floor/whitelist settings. null = feed down
 * (never fabricated).
 */
async function scanRoutes(
  ctx: ActionCtx,
): Promise<{ live: RouteLite[]; generated: RouteLite[]; opportunities: number } | null> {
  const state = await ctx.runQuery(internal.terminal.botGetState, {});
  const snapshot = await fetchMarketSnapshot(state?.chainKey ?? "bsc").catch(() => null);
  if (!snapshot) return null;
  const gasGwei = await fetchGasGwei(CHAIN_INFO[snapshot.chainKey ?? "bsc"].rpc);
  const settings = feedSettingsFor(state);
  const run = state?.scansToday ?? 0;
  const live: RouteLite[] = computeRoutes(snapshot, settings, run, 8, true, gasGwei).map((r) => ({
    id: r.id,
    legs: r.legs,
    profitPct: r.profitPct,
    lender: r.lender,
    liquidityUsd: r.liquidityUsd,
    loanAsset: r.loanAsset,
  }));
  const generated: RouteLite[] = generateWBNBRoutes(snapshot, settings, run, gasGwei).map((g, i) => ({
    id: `gen-${i}`,
    legs: g.legs,
    profitPct: g.grossProfitPct,
    netProfitPct: g.netProfitPct,
    lender: g.lender,
    liquidityUsd: g.minLiquidityUsd,
    loanAsset: g.loanAsset,
  }));
  return { live, generated, opportunities: live.length + generated.length };
}

/** Cached trade price map (null when never loaded / unparseable). */
async function readPrices(
  ctx: ActionCtx,
): Promise<Record<string, { usd: number; ngn: number; change24hPct: number }> | null> {
  try {
    const row = await ctx.runQuery(internal.trade.readPriceCache, {});
    if (!row?.data) return null;
    return JSON.parse(row.data) as Record<string, { usd: number; ngn: number; change24hPct: number }>;
  } catch {
    return null;
  }
}

/**
 * The live dashboard bundle: real session clock + real AI score off a fresh
 * snapshot + fleet metrics from the persisted trail. null = feed unreachable.
 */
async function buildDashboardBundle(
  ctx: ActionCtx,
): Promise<{ session: SessionLite; score: AiScoreLite; metrics: MetricsLite } | null> {
  try {
    const now = Date.now();
    const defs = await ctx.runQuery(internal.signals.getSessionDefs, {});
    const snap = sessionStateAtWith(now, defs);
    const session: SessionLite = {
      primary: snap.primary
        ? { label: snap.primary.label, flag: snap.primary.flag, windowLabel: snap.primary.windowLabel }
        : null,
      regime: snap.regime,
      openKeys: snap.openKeys,
      nextChangeLabel: snap.nextChangeLabel,
      nextChangeKind: snap.nextChangeKind,
      nextChangeAt: snap.nextChangeAt,
      now: snap.now,
    };
    const metrics: MetricsLite = await ctx.runQuery(internal.signals.collectMetrics, {});
    const snapshot = await fetchMarketSnapshot("bsc");
    const gasGwei = await fetchGasGwei(CHAIN_INFO.bsc.rpc);
    const ai = computeAiScore(snapshot, gasGwei);
    const score: AiScoreLite = {
      score: ai.score,
      rating: ai.rating,
      dispersion: ai.dispersion,
      routeCount: ai.routeCount,
      avgEdge: ai.avgEdge,
      totalLiq: ai.totalLiq,
      totalVol: ai.totalVol,
      gasGwei: ai.gasGwei,
    };
    return { session, score, metrics };
  } catch {
    return null;
  }
}

/**
 * Engage an engine the same way the app's START does: flip the persistent
 * per-chain switch, then kick the real scan + sniper loops immediately (they
 * keep re-scheduling themselves; the heartbeat cron revives them after any
 * outage).
 */
async function engageEngine(ctx: ActionCtx, chain: "bnb" | "sol"): Promise<void> {
  await ctx.runMutation(internal.terminal.botSetBotRunning, { running: true, chain });
  await ctx.scheduler.runAfter(0, internal.terminal.scanPass, { chain });
  await ctx.scheduler.runAfter(0, internal.terminal.snipePass, { chain });
}

// ---------------------------------------------------------------------------
// Scheduled dashboard digest — the telegram-bot-digest cron.
// ---------------------------------------------------------------------------

export const runDigest = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; sent: number; error: string | null }> => {
    const token = await resolveBotToken(ctx);
    if (!token) {
      return { ok: false, sent: 0, error: "Bot token not configured — set it in the Telegram Bot panel or Keys." };
    }
    const cfg = await ctx.runQuery(internal.telegramBot.getConfig, {});
    if (!cfg?.digestEnabled) return { ok: true, sent: 0, error: null };
    const chats = await ctx.runQuery(internal.telegramBot.listChats, { activeOnly: true });
    if (!chats.length) return { ok: true, sent: 0, error: null };
    const bundle = await buildDashboardBundle(ctx);
    if (!bundle) return { ok: false, sent: 0, error: "Live feed unreachable — digest skipped." };
    const text = digestMessage(bundle.session, bundle.score, bundle.metrics).text;
    let sent = 0;
    for (const chat of chats) {
      const res = await sendPayload(ctx, token, chat.chatId, text, null, disableNotification(chat, cfg));
      if (res.ok) sent += 1;
    }
    return { ok: true, sent, error: null };
  },
});

// ---------------------------------------------------------------------------
// Webhook handler — Telegram → POST /api/telegram/webhook (http.ts) → here.
//
// Pipeline: stored-secret gate → pure parse → linked-chat gate → command /
// callback dispatch → real backend reads → one honest reply. Every number in
// every message comes from the same Convex tables and live feeds the web
// terminals use — nothing simulated, nothing mocked.
// ---------------------------------------------------------------------------

export const handleUpdate = internalAction({
  args: {
    /** X-Telegram-Bot-Api-Secret-Token header Telegram echoes back. */
    secret: v.string(),
    /** Raw update JSON exactly as Telegram posted it. */
    update: v.any(),
  },
  handler: async (ctx, { secret, update }): Promise<{
    ok: boolean;
    status: number;
    handled: boolean;
    reason?: string;
  }> => {
    // ── 1. Authenticity: only Telegram (holding the stored secret) passes. ──
    const initial = await ctx.runQuery(internal.telegramBot.getConfig, {});
    if (!initial) return { ok: false, status: 503, handled: false, reason: "config missing" };
    if (!initial.webhookSecret || secret !== initial.webhookSecret) {
      return { ok: false, status: 401, handled: false, reason: "bad secret" };
    }

    // Resolved ONCE for every outgoing call below: the app-encrypted token
    // first (operator-saved in the console), then the env fallback. Empty
    // string = no token configured — tgCall reports that honestly per send.
    const token = (await resolveBotToken(ctx)) ?? "";

    // ── 2. Parse the update (pure parser, presentation layer). ──
    const tg = parseTgUpdate(update);
    if (!tg?.chatId) return { ok: true, status: 200, handled: false, reason: "no chat" };
    const chatId = tg.chatId;

    // Stop Telegram's callback spinner before any live-feed work runs.
    await answerCallback(token, tg.callbackId);

    // ── 3. Chat identity comes ONLY from the verified update, never input. ──
    let cfg = initial;
    const chat = await ctx.runQuery(internal.telegramBot.getChat, { chatId });

    // ── 4. Command resolution: text commands + inline-keyboard callbacks.
    // `resolveCallbackData` is the ONE resolver the builders' parity test also
    // walks, so a button the presentation layer emits cannot be a dead
    // control: it always resolves to a command the switch below answers.
    let cmd: BotCommand;
    let setting: string | null = null;
    if (tg.callbackData !== null) {
      const resolved = resolveCallbackData(tg.callbackData);
      cmd = resolved.cmd;
      setting = resolved.setting;
    } else {
      cmd = parseBotCommand(tg.text);
    }

    // ── 5. Pairing gate: an unlinked chat sees only /start, the pairing
    // prompt and /help — never operator data. ──
    const alwaysAllowed =
      cmd.kind === "start" ||
      cmd.kind === "start_payload" ||
      cmd.kind === "pair_code" ||
      cmd.kind === "pair_start" ||
      cmd.kind === "help";
    if ((!chat || chat.blocked) && !alwaysAllowed) {
      const m = unlinkedMessage();
      await sendPayload(ctx, token, chatId, m.text, m.keyboard, false);
      return { ok: true, status: 200, handled: true, reason: "unlinked" };
    }

    // Reply helper honoring this chat's mute + the sound pref.
    const reply = async (text: string, keyboard: TgKeyboard | null = null): Promise<void> => {
      await sendPayload(
        ctx,
        token,
        chatId,
        text,
        keyboard,
        disableNotification({ silent: chat?.silent ?? false }, cfg),
      );
    };
    const done = (reason: string) => ({ ok: true, status: 200, handled: true, reason });

    // Record freshness + last command on every linked-chat pass.
    if (chat) {
      await ctx.runMutation(internal.telegramBot.touchChat, { chatId, command: cmd.kind });
    }

    // Boot: engage the BNB engine server-side, then confirm with the boot card.
    const bootConsole = async (): Promise<void> => {
      const st = await ctx.runQuery(internal.terminal.botGetState, {});
      await engageEngine(ctx, "bnb");
      const b = bootMessage(st?.mode ?? "paper", st?.chainKey ?? "bsc");
      await sendPayload(
        ctx,
        token,
        chatId,
        b.text,
        b.keyboard,
        disableNotification({ silent: chat?.silent ?? false }, cfg),
      );
    };

    switch (cmd.kind) {
      // ── Pairing / boot ─────────────────────────────────────────────
      case "start":
      case "start_payload":
      case "pair_code": {
        const code = cmd.kind === "start" ? null : cmd.code;
        // Already linked → plain console boot (deep-link payload or not).
        if (chat) {
          await bootConsole();
          return done("booted");
        }
        // App-issued pairing code (deep link /?start=CODE or pasted).
        if (code) {
          const res = await ctx.runMutation(internal.telegramBot.tryPairChat, {
            chatId,
            code,
            title: tg.fromName ?? undefined,
            username: tg.username ?? undefined,
          });
          if (!res.ok) {
            const p = pairPrompt();
            await sendPayload(ctx, token, chatId, res.reason, p.keyboard, false);
            return done("pair-rejected");
          }
          const fresh = await ctx.runQuery(internal.telegramBot.getChat, { chatId });
          const pm = pairedMessage(fresh?.title ?? tg.fromName ?? null);
          await sendPayload(ctx, token, chatId, pm.text, pm.keyboard, false);
          await bootConsole();
          return done("paired");
        }
        // Plain /start — server-side auto-pair policy (default ON): link and
        // boot with zero codes; OFF forces app-issued codes again.
        if (cfg.autoPairOnStart !== false) {
          await ctx.runMutation(internal.telegramBot.linkChat, {
            chatId,
            title: tg.fromName ?? undefined,
            username: tg.username ?? undefined,
          });
          const fresh = await ctx.runQuery(internal.telegramBot.getChat, { chatId });
          const pm = pairedMessage(fresh?.title ?? tg.fromName ?? null);
          await sendPayload(ctx, token, chatId, pm.text, pm.keyboard, false);
          await bootConsole();
          return done("auto-paired");
        }
        const s = startMessage();
        await sendPayload(ctx, token, chatId, s.text, s.keyboard, false);
        return done("start-unlinked");
      }

      case "pair_start": {
        const p = pairPrompt();
        await reply(p.text, p.keyboard);
        return done("pair-prompt");
      }

      case "help": {
        const h = helpMessage();
        await reply(h.text, h.keyboard);
        return done("help");
      }

      case "menu": {
        const mm = mainMenu();
        await reply(mm.text, mm.keyboard);
        return done("menu");
      }

      case "unpair": {
        await ctx.runMutation(internal.telegramBot.unpairChat, { chatId });
        await reply(
          "🗑 This chat is unlinked. Pair again from the app (Account menu → Telegram Bot) or tap Pair below.",
          pairPrompt().keyboard,
        );
        return done("unpaired");
      }

      // ── Alerts board + settings toggles ──────────────────────────
      case "alerts": {
        if (setting !== null) {
          const chatSilent =
            setting === "mute" ? true : setting === "unmute" ? false : (chat?.silent ?? false);
          if (setting === "alerts_on" || setting === "alerts_off") {
            const on = setting === "alerts_on";
            await ctx.runMutation(internal.telegramBot.setBotPref, { alertFanout: on });
            cfg = { ...cfg, alertFanout: on };
          } else if (setting === "digest_on" || setting === "digest_off") {
            const on = setting === "digest_on";
            await ctx.runMutation(internal.telegramBot.setBotPref, { digestEnabled: on });
            cfg = { ...cfg, digestEnabled: on };
          } else if (setting === "sound_on" || setting === "sound_off") {
            const on = setting === "sound_on";
            await ctx.runMutation(internal.telegramBot.setBotPref, { soundAlerts: on });
            cfg = { ...cfg, soundAlerts: on };
          } else if (setting === "mute" || setting === "unmute") {
            await ctx.runMutation(internal.telegramBot.setChatPref, {
              chatId,
              silent: setting === "mute",
            });
          } else if (setting === "purge_on" || setting === "purge_off") {
            const on = setting === "purge_on";
            await ctx.runMutation(internal.telegramBot.setBotPref, { autoPurge: on });
            cfg = { ...cfg, autoPurge: on };
          } else if (setting === "channel_on" || setting === "channel_off") {
            const on = setting === "channel_on";
            await ctx.runMutation(internal.telegramBot.setBotPref, { channelPurge: on });
            cfg = { ...cfg, channelPurge: on };
          }
          const board = alertsMessage(cfg, { silent: chatSilent });
          await reply(board.text, board.keyboard);
          return done(`set:${setting}`);
        }
        const board = alertsMessage(cfg, { silent: chat?.silent ?? false });
        await reply(board.text, board.keyboard);
        return done("alerts");
      }

      case "digest": {
        const on = !cfg.digestEnabled;
        await ctx.runMutation(internal.telegramBot.setBotPref, { digestEnabled: on });
        cfg = { ...cfg, digestEnabled: on };
        await reply(settingsApplied("Dashboard digest", on));
        return done("digest");
      }

      case "sound": {
        const on = !cfg.soundAlerts;
        await ctx.runMutation(internal.telegramBot.setBotPref, { soundAlerts: on });
        cfg = { ...cfg, soundAlerts: on };
        await reply(settingsApplied("Notification sound", on));
        return done("sound");
      }

      case "silence": {
        await ctx.runMutation(internal.telegramBot.setChatPref, { chatId, silent: true });
        await reply(settingsApplied("Chat notifications", false));
        return done("silence");
      }

      case "purge": {
        const res = await ctx.runAction(internal.telegramBot.purgeChatMessages, { chatId });
        const board = alertsMessage(cfg, { silent: chat?.silent ?? false });
        await reply(
          res.ok
            ? [
                `🧹 Purged ${res.deleted} bot message${res.deleted === 1 ? "" : "s"} from this chat.`,
                res.retrying
                  ? `${res.retrying} could not be deleted right now — still tracked, the next sweep retries them.`
                  : "",
                res.failed - res.retrying
                  ? `${res.failed - res.retrying} could not be deleted (already gone or past Telegram's 48 h limit).`
                  : "",
                "Channel posts are left alone by /purge — they follow the channel purge switch above.",
                cfg.autoPurge
                  ? "Auto-purge stays on: anything the bot posts here is deleted after 10 minutes."
                  : "Auto-purge is off — new bot messages will stay.",
              ]
                .filter(Boolean)
                .join("\n")
            : "🧹 Purge needs the bot token — set it in the Telegram Bot panel or Keys.",
          board.keyboard,
        );
        return done("purge");
      }

      // ── Engines / control ──────────────────────────────────────────
      case "engines": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("⚙️ No terminal state yet — open the terminal once to initialize the console.");
          return done("engines-no-state");
        }
        const m = enginesMessage(
          { bnb: st.botRunning, sol: st.solBotRunning !== false },
          {
            bnbScan: { at: st.lastScanAt ?? null, source: st.lastScanSource ?? null },
            solScan: { at: st.solLastScanAt ?? null, source: st.solLastScanSource ?? null },
            bnbSniper: { at: st.bSnLastScanAt ?? null, source: st.bSnLastScanSource ?? null },
            solSniper: { at: st.sSnLastScanAt ?? null, source: st.sSnLastScanSource ?? null },
          },
          Date.now(),
        );
        await reply(m.text, m.keyboard);
        return done("engines");
      }

      case "bnb_on": {
        await engageEngine(ctx, "bnb");
        await reply(
          "🟢 **BNB scanner ENGAGED** — the server-side engine is scanning now, app open or closed. /bnb for the dashboard.",
          mainMenu().keyboard,
        );
        return done("bnb_on");
      }

      case "bnb_off": {
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "bnb" });
        await reply(
          "🛑 **BNB scanner STOPPED** — the SOL engine keeps running on its own switch.",
          mainMenu().keyboard,
        );
        return done("bnb_off");
      }

      case "sol_on": {
        await engageEngine(ctx, "sol");
        await reply(
          "🟢 **SOL scanner ENGAGED** — SOL scan + sniper loops now run server-side. /sol for the dashboard.",
          mainMenu().keyboard,
        );
        return done("sol_on");
      }

      case "sol_off": {
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "sol" });
        await reply(
          "🛑 **SOL scanner STOPPED** — the BNB engine keeps running on its own switch.",
          mainMenu().keyboard,
        );
        return done("sol_off");
      }

      case "bnb_paper":
      case "bnb_live": {
        const mode: "paper" | "live" = cmd.kind === "bnb_live" ? "live" : "paper";
        await ctx.runMutation(internal.terminal.botSetMode, { mode });
        await reply(
          mode === "live"
            ? "🔴 **Mode: LIVE** — real on-chain execution arms once a contract is deployed and a wallet is connected."
            : "📄 **Mode: paper** — executions are simulated; nothing is broadcast.",
        );
        return done(`mode_${mode}`);
      }

      // ── Dashboards & live data ─────────────────────────────────────
      case "status": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        const row = await ctx.runQuery(internal.telegramBot.readConfigRow, {});
        const linked = await ctx.runQuery(internal.telegramBot.listChats, { activeOnly: true });
        if (!st) {
          await reply("📋 No terminal state yet — open the terminal once to initialize the console.");
          return done("status-no-state");
        }
        const lastScan = st.lastScanAt
          ? `${fmtAgo(st.lastScanAt, Date.now())} (${st.lastScanSource ?? "—"})`
          : "never";
        await reply(
          [
            "📋 **Terminal status**",
            "",
            `• BNB bot: ${st.botRunning ? "🟢 RUNNING" : "🔴 stopped"} · SOL bot: ${st.solBotRunning !== false ? "🟢 RUNNING" : "🔴 stopped"}`,
            `• Mode: ${st.mode === "live" ? "🔴 LIVE" : "📄 paper"} · Network: ${st.network} · Chain: ${st.chainKey}`,
            `• Contract: ${st.deployedContractAddress ? `\`${st.deployedContractAddress.slice(0, 12)}…\`` : "not armed"} · Wallets: ${st.connectedWallets.length}`,
            `• Scans today ${st.scansToday} · last scan ${lastScan} · opportunities ${st.openOpportunities}`,
            `• Executions today ${st.executionsToday} · wins ${st.successesToday} (${st.successRate}%) · lifetime PnL +${fmtNum(st.lifetimePnl)}`,
            "",
            `• Webhook: ${row?.webhookOk === true ? "✅ registered" : row?.webhookOk === false ? "❌ failing (self-heal retries)" : "unknown (self-heal pending)"}`,
            `• Bot: ${row?.botUsername ? `@${row.botUsername}` : "not stamped yet"} · linked chats ${linked.length}`,
            `• Digest ${cfg.digestEnabled ? "on" : "off"} · sound ${cfg.soundAlerts ? "on" : "off"} · /start auto-pair ${cfg.autoPairOnStart !== false ? "on" : "off"}`,
          ].join("\n"),
          mainMenu().keyboard,
        );
        return done("status");
      }

      case "dashboard": {
        const bundle = await buildDashboardBundle(ctx);
        if (!bundle) {
          await reply("⚠️ The live feed is unreachable right now — retry in a moment (numbers are never fabricated).");
          return done("dashboard-feed-down");
        }
        const m = dashboardMessage(bundle.session, bundle.score, bundle.metrics);
        await reply(m.text, m.keyboard);
        return done("dashboard");
      }

      case "bnb": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("⚡ No terminal state yet — open the BNB terminal once to initialize.");
          return done("bnb-no-state");
        }
        const m = bnbMessage(stateLite(st));
        await reply(m.text, m.keyboard);
        return done("bnb");
      }

      case "sol": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("☀️ No terminal state yet — open the SOL terminal once to initialize.");
          return done("sol-no-state");
        }
        const m = solMessage(stateLite(st));
        await reply(m.text, m.keyboard);
        return done("sol");
      }

      case "routes": {
        const view = await scanRoutes(ctx);
        if (!view) {
          await reply("⚠️ Live feed unreachable right now — retry in a moment.");
          return done("routes-feed-down");
        }
        const m = routesMessage(view.live, view.generated);
        await reply(m.text, m.keyboard);
        return done("routes");
      }

      case "bnb_scan": {
        const view = await scanRoutes(ctx);
        if (!view) {
          await reply("⚠️ Live feed unreachable right now — retry in a moment.");
          return done("scan-feed-down");
        }
        // Stamp the pass on the BNB engine's own bookkeeping — freshness +
        // opportunity count, the same bot-side bump the app's Scan performs.
        await ctx.runMutation(internal.terminal.botBumpScan, {
          opportunities: view.opportunities,
          chain: "bnb",
          subsystem: "scan",
        });
        const m = routesMessage(view.live, view.generated);
        await reply(m.text, m.keyboard);
        return done("bnb_scan");
      }

      case "sol_scan": {
        // The SOL feed has its own engine body — run ONE real pass through it
        // and report its honest verdict (never a second, divergent scan path).
        const res = await ctx.runAction(internal.terminal.scanPass, { chain: "sol" });
        if (res.ran) {
          await reply(
            `☀️ **SOL feed refreshed** — ${res.live ?? 0} live / ${res.generated ?? 0} generated routes this pass.`,
            mainMenu().keyboard,
          );
          return done("sol_scan");
        }
        const why =
          res.reason === "not-running"
            ? "the SOL scanner is stopped (/sol_on to engage)"
            : res.reason === "app-online"
              ? "the app is driving the SOL scan right now"
              : res.reason === "no-state"
                ? "no SOL terminal state yet — open the SOL terminal once"
                : res.reason === "loop-alive"
                  ? "a SOL pass is already in flight"
                  : "the engine lease just renewed — retry in a second";
        await reply(`☀️ SOL scan did not run: ${why}.`, mainMenu().keyboard);
        return done(`sol_scan:${res.reason ?? "yielded"}`);
      }

      case "execs": {
        const execs = await ctx.runQuery(internal.terminal.botListExecutions, { limit: 12 });
        const rows: ExecutionLite[] = execs.rows.map((r) => ({
          label: r.label,
          status: r.status,
          amountBnb: r.amountBnb,
          profitPct: r.profitPct,
          ts: r.ts,
          ...(r.chain ? { chain: r.chain } : {}),
          ...(r.txHash ? { txHash: r.txHash } : {}),
        }));
        const m = executionsMessage(rows, Date.now(), cmd.filter, {
          liveTotal: execs.liveTotal,
          simTotal: execs.simTotal,
        });
        await reply(m.text, m.keyboard);
        return done("execs");
      }

      case "pnl": {
        const p: PnlLite = await ctx.runQuery(internal.terminal.botPnlSummary, {});
        const m = pnlMessage(p, cmd.filter);
        await reply(m.text, m.keyboard);
        return done("pnl");
      }

      // ── FlashBolt Trade ────────────────────────────────────────────
      case "trade": {
        const overview = await ctx.runQuery(internal.trade.botTradeOverview, {});
        if (!overview) {
          await reply("💱 No Trade account yet — open the Trade terminal once to initialize.");
          return done("trade-no-account");
        }
        const prices = await readPrices(ctx);
        const m = tradeMessage(overview.balances, overview.earn, prices);
        await reply(m.text, m.keyboard);
        return done("trade");
      }

      case "prices": {
        const m = pricesMessage(await readPrices(ctx));
        await reply(m.text, m.keyboard);
        return done("prices");
      }

      case "markets": {
        const m = marketsMessage(await readPrices(ctx));
        await reply(m.text, m.keyboard);
        return done("markets");
      }

      case "orders": {
        const rows = await ctx.runQuery(internal.trade.botListOrders, { limit: 10 });
        const m = ordersMessage(rows);
        await reply(m.text, m.keyboard);
        return done("orders");
      }

      case "txs": {
        const rows = await ctx.runQuery(internal.trade.botListTx, { limit: 12 });
        const m = txsMessage(rows, Date.now());
        await reply(m.text, m.keyboard);
        return done("txs");
      }

      case "earn": {
        const plans = await ctx.runQuery(internal.trade.botListEarnPlans, {});
        const m = earnMessage(plans, Date.now());
        await reply(m.text, m.keyboard);
        return done("earn");
      }

      case "claim": {
        const plans = await ctx.runQuery(internal.trade.botClaimablePlans, {});
        const earnKeys: TgKeyboard = [
          [{ text: "🏦 Earn", callback_data: "cmd:/earn" }],
          [{ text: "🧭 Menu", callback_data: "menu:main" }],
        ];
        if (!plans.length) {
          await reply("💡 Nothing to claim yet — flexible-earn interest accrues over time.", earnKeys);
          return done("claim-none");
        }
        let claimedCount = 0;
        const totals: Record<string, number> = {};
        for (const plan of plans) {
          try {
            const res = await ctx.runMutation(internal.trade.botClaimInterest, {
              planId: plan._id as Id<"tradeEarnPlans">,
            });
            claimedCount += 1;
            totals[res.asset] = (totals[res.asset] ?? 0) + res.amount;
          } catch {
            // Honest partial failure — reported below instead of hidden.
          }
        }
        const detail = Object.entries(totals)
          .map(([asset, amount]) => `+${fmtNum(amount, 6)} ${asset}`)
          .join(" · ");
        await reply(
          claimedCount > 0
            ? `✅ Claimed ${claimedCount} earn plan${claimedCount === 1 ? "" : "s"} — ${detail}.`
            : "⚠️ The claim could not complete — retry in a moment or check /earn.",
          earnKeys,
        );
        return done("claim");
      }

      // ── Control & parameters — deploy / settings / amounts / funds ──
      case "deploy": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("📦 No terminal state yet — open the Contract page once to initialize.");
          return done("deploy-no-state");
        }
        const deployments = Object.entries(st.deployments ?? {})
          .filter(([, d]) => Boolean(d?.contractAddress))
          .map(([chain, d]) => ({
            chain,
            contract: d.contractAddress,
            signer: d.signerAddress ?? null,
            relay: d.relay ?? null,
          }));
        const m = deployMessage({
          mode: st.mode,
          network: st.network,
          chainKey: st.chainKey,
          contract: st.deployedContractAddress ?? null,
          router: st.routerAddress ?? null,
          deployments,
          connectedWallets: st.connectedWallets.length,
          importedWallets: st.evmImportedWallets?.length ?? 0,
        });
        await reply(m.text, m.keyboard);
        return done("deploy");
      }

      case "settings": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("⚙️ No terminal state yet — open a terminal once to initialize.");
          return done("settings-no-state");
        }
        const perChainWl = st.dexWhitelists?.[st.chainKey];
        const m = settingsMessage({
          botRunning: st.botRunning,
          solBotRunning: st.solBotRunning !== false,
          mode: st.mode,
          network: st.network,
          chainKey: st.chainKey,
          cadence: st.cadence,
          minProfit: st.minProfit,
          maxLoan: st.maxLoan,
          maxHops: st.maxHops,
          slippage: st.slippage,
          gasPriority: st.gasPriority,
          autoPayout: st.autoPayout,
          mevGuard: st.mevGuard,
          privateSubmit: st.privateSubmit,
          lenderBalancer: st.lenderBalancer,
          dailyArbTarget: st.dailyArbTarget,
          dexWhitelist: perChainWl?.length ? perChainWl : st.dexWhitelist,
          loanAssets: st.loanAssets ?? [],
          sol: {
            network: st.solNetwork,
            buy: st.solBuyAmountSol,
            sellPct: st.solSellAmountPct,
            slippagePct: st.solSlippagePct,
            targetPct: st.solProfitTargetPct,
            trailingPct: st.solTrailingStopPct,
            minLiq: st.solMinLiquidityUsd,
            rpcOverrides: Object.keys(st.solRpcOverrides ?? {}).length,
            wallets: st.solImportedWallets?.length ?? 0,
          },
        });
        await reply(m.text, m.keyboard);
        return done("settings");
      }

      case "amount": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        if (!st) {
          await reply("🔢 No terminal state yet — open a terminal once to initialize.");
          return done("amount-no-state");
        }
        const m = amountMessage({
          mode: st.mode,
          maxLoan: st.maxLoan,
          minProfit: st.minProfit,
          dailyArbTarget: st.dailyArbTarget,
          executionsToday: st.executionsToday,
          solBuy: st.solBuyAmountSol,
          solSellPct: st.solSellAmountPct,
          solTargetPct: st.solProfitTargetPct,
          solTrailingPct: st.solTrailingStopPct,
        });
        await reply(m.text, m.keyboard);
        return done("amount");
      }

      case "balance": {
        const overview = await ctx.runQuery(internal.trade.botTradeOverview, {});
        if (!overview) {
          await reply("💰 No Trade account yet — open the Trade terminal once to initialize.");
          return done("balance-no-account");
        }
        const m = balanceMessage(overview.balances, await readPrices(ctx));
        await reply(m.text, m.keyboard);
        return done("balance");
      }

      case "withdraw": {
        const overview = await ctx.runQuery(internal.trade.botTradeOverview, {});
        if (!overview) {
          await reply("🏧 No Trade account yet — open the Trade terminal once to initialize.");
          return done("withdraw-no-account");
        }
        const txs = await ctx.runQuery(internal.trade.botListTx, { limit: 50 });
        const withdrawals = txs.filter((t) => t.direction === "withdrawal");
        const cash = overview.balances.filter((b) => b.kind === "cash");
        const m = withdrawMessage(cash, withdrawals, Date.now());
        await reply(m.text, m.keyboard);
        return done("withdraw");
      }

      case "stop": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        const previousMode = st?.mode ?? "paper";
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "bnb" });
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "sol" });
        const m = stoppedMessage("stop", previousMode);
        await reply(m.text, m.keyboard);
        return done("stop");
      }

      case "panic": {
        const st = await ctx.runQuery(internal.terminal.botGetState, {});
        const previousMode = st?.mode ?? "paper";
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "bnb" });
        await ctx.runMutation(internal.terminal.botSetBotRunning, { running: false, chain: "sol" });
        await ctx.runMutation(internal.terminal.botSetMode, { mode: "paper" });
        const m = stoppedMessage("panic", previousMode);
        await reply(m.text, m.keyboard);
        return done("panic");
      }

      // ── Unknown input — answer with the command board ──────────────
      case "unknown": {
        const h = helpMessage();
        await reply(h.text, h.keyboard);
        return done("unknown");
      }

      default: {
        // EXHAUSTIVENESS: every BotCommand kind is handled above, so `cmd` is
        // `never` here. A new kind without a case fails `bun run typecheck`
        // instead of quietly falling into a generic reply.
        const unhandled: never = cmd;
        void unhandled;
        const h = helpMessage();
        await reply(h.text, h.keyboard);
        return done("unknown");
      }
    }
  },
});
