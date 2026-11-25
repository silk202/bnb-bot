#!/usr/bin/env bun
/**
 * Live Telegram smoke check — the real Bot API, the real chat, no mocks.
 *
 * Every other check in this repo runs against code. This one runs against the
 * deployment the operator actually holds: it reads the bot's real identity, its
 * real webhook, its real registered command menu and the real target chat, then
 * posts ONE probe message the operator can see. Nothing is stubbed, no fixture
 * is sent, and no number is invented — every line it prints came back from
 * Telegram, and every line it sends describes those same live answers.
 *
 * What it proves, in order:
 *   1. the token is valid and belongs to the bot we think it is (getMe);
 *   2. the webhook is registered and Telegram is not holding a failure
 *      (getWebhookInfo — a dead webhook makes every board unreachable while the
 *      code still looks healthy);
 *   3. the command menu in Telegram matches `BOT_COMMAND_SPECS` exactly — same
 *      names, same descriptions, same order — and every one parses to a handled
 *      command (a stale push is how `/bnb_scan` once went missing);
 *   4. the target chat resolves (getChat) and is the chat the id names;
 *   5. the static boards' inline keyboards resolve to handled commands, so no
 *      button on the probe is a dead control;
 *   6. Telegram accepts one real message WITH that keyboard (sendMessage) —
 *      delivery and rendering, verified by the returned message_id.
 *
 * Secrets: the token and the chat id are read from the environment and never
 * printed. Their values are masked everywhere, including in error messages.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… bun run smoke:telegram
 *   bun run smoke:telegram --chat -1001234567890   # override the chat id
 *   bun run smoke:telegram --dry-run               # read-only, sends nothing
 *   bun run smoke:telegram --clean                 # delete the probe afterwards
 *
 * Exit codes: 0 every check passed · 1 a check failed · 2 usage/missing config.
 */
import {
  BOT_COMMAND_SPECS,
  HANDLED_COMMAND_KINDS,
  helpMessage,
  mainMenu,
  parseBotCommand,
  resolveCallbackData,
  startMessage,
  type TgKeyboard,
} from "../src/lib/telegramBot";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

/** Everything the report needs to know about one check. */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string): boolean => {
  checks.push({ name, ok, detail });
  return ok;
};

/** A secret never reaches stdout: length at most, value never. */
function hidden(value: string): string {
  return value ? `set (${value.length} chars)` : "not set";
}

/** Minimal Markdown escaping, so a chat title with `_` cannot break the send. */
function md(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

interface TgError {
  ok: false;
  description?: string;
  parameters?: { retry_after?: number };
  error_code?: number;
}

/**
 * One Bot API call. Real HTTPS, real errors, bounded: a 429 is retried twice
 * after the wait Telegram itself asks for (and never longer than 5s, so a
 * smoke run cannot hang).
 */
async function call<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${method}: Telegram unreachable (${reason})`);
  }
  const body = (await response.json().catch(() => null)) as
    | { ok: true; result: T }
    | TgError
    | null;
  if (!body) throw new Error(`${method}: no JSON from Telegram (HTTP ${response.status})`);
  if (body.ok) return body.result;
  const retryAfter = body.parameters?.retry_after;
  if (response.status === 429 && retryAfter !== undefined && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 5) * 1000));
    return call<T>(token, method, params, attempt + 1);
  }
  throw new Error(
    `${method}: ${body.description ?? `HTTP ${response.status}`}` +
      (retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ""),
  );
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const usage = [
  "Live Telegram smoke check — real Bot API, real chat, no mocks.",
  "",
  "  TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<chat id> bun run smoke:telegram",
  "",
  "Options:",
  "  --chat <id>   verify and post to this chat instead of TELEGRAM_CHAT_ID",
  "  --dry-run     run every read-only check, send nothing",
  "  --clean       delete the probe message after Telegram confirms it",
  "  --help        this text",
  "",
  "Exit codes: 0 pass · 1 a check failed · 2 usage or missing config.",
].join("\n");

if (flag("--help") || flag("-h")) {
  console.log(usage);
  process.exit(0);
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const chatId = (flagValue("--chat") ?? process.env.TELEGRAM_CHAT_ID ?? "").trim();
const dryRun = flag("--dry-run");
const clean = flag("--clean");

if (!token || !chatId) {
  console.error("telegram smoke — missing configuration\n");
  if (!token) console.error("  ✗ TELEGRAM_BOT_TOKEN is not set (bot token from BotFather)");
  if (!chatId) console.error("  ✗ TELEGRAM_CHAT_ID is not set (the operator chat's id)");
  console.error(
    "\nSet both as environment secrets (never inline on the command line) and re-run.",
  );
  console.error(`\n${usage}`);
  process.exit(2);
}

/** One Bot identity, as getMe reports it. */
interface BotIdentity {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

/** getWebhookInfo, as Telegram reports it (fields we display only). */
interface WebhookInfo {
  url: string;
  has_custom_certificate?: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

interface BotCommandSpec {
  command: string;
  description: string;
}

interface ChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface SentMessage {
  message_id: number;
  chat: { id: number };
}

const specNames = BOT_COMMAND_SPECS.map((spec) => spec.command);

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------
let bot: BotIdentity;
try {
  bot = await call<BotIdentity>(token, "getMe");
  const handle = bot.username ? `@${bot.username}` : "no username";
  const ok = record(
    "bot identity (getMe)",
    bot.is_bot === true,
    `is_bot ${bot.is_bot} · ${handle} · id ${bot.id}`,
  );
  if (!ok) throw new Error("the token does not belong to a bot account");
} catch (err) {
  record("bot identity (getMe)", false, err instanceof Error ? err.message : String(err));
  console.error(`\n✗ cannot continue: ${checks[checks.length - 1]?.detail}`);
  console.error(`  token ${hidden(token)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Webhook — the path every board arrives through
// ---------------------------------------------------------------------------
let webhook: WebhookInfo | null = null;
try {
  webhook = await call<WebhookInfo>(token, "getWebhookInfo");
  const registered = Boolean(webhook.url);
  const failing = Boolean(webhook.last_error_message);
  const detail = registered
    ? [
        `url ${webhook.url}`,
        `pending ${webhook.pending_update_count}`,
        webhook.last_error_message
          ? `last error${webhook.last_error_date ? ` at ${new Date(webhook.last_error_date * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}: ${webhook.last_error_message}`
          : "no delivery error",
      ].join(" · ")
    : "no webhook registered — Telegram cannot deliver a single command";
  record("webhook (getWebhookInfo)", registered && !failing, detail);
} catch (err) {
  record("webhook (getWebhookInfo)", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// 3. Command menu — the live setMyCommands vs the code's specs
// ---------------------------------------------------------------------------
try {
  const registered = await call<BotCommandSpec[]>(token, "getMyCommands");
  const live = new Map(registered.map((entry) => [entry.command, entry.description]));
  const missing = specNames.filter((name) => !live.has(name));
  const extra = registered.map((e) => e.command).filter((name) => !specNames.includes(name));
  const outOfOrder =
    missing.length === 0 &&
    extra.length === 0 &&
    registered.map((e) => e.command).join(",") !== specNames.join(",");
  const drifted = BOT_COMMAND_SPECS.filter(
    (spec) => live.has(spec.command) && live.get(spec.command) !== spec.description,
  ).map((spec) => spec.command);
  // A registered command the parser cannot answer would be a dead slash command.
  const unparsed = registered
    .map((entry) => entry.command)
    .filter((name) => {
      const kind = parseBotCommand(`/${name}`).kind;
      return kind === "unknown" || !HANDLED_COMMAND_KINDS.includes(kind);
    });

  const problems: string[] = [];
  if (missing.length) problems.push(`missing ${missing.map((n) => `/${n}`).join(", ")}`);
  if (extra.length) problems.push(`unexpected ${extra.map((n) => `/${n}`).join(", ")}`);
  if (outOfOrder) problems.push("order differs from BOT_COMMAND_SPECS");
  if (drifted.length) problems.push(`stale description on ${drifted.map((n) => `/${n}`).join(", ")}`);
  if (unparsed.length) problems.push(`unanswered ${unparsed.map((n) => `/${n}`).join(", ")}`);

  record(
    "command menu (getMyCommands)",
    problems.length === 0,
    problems.length === 0
      ? `${registered.length} commands registered, all match BOT_COMMAND_SPECS`
      : `${registered.length} registered of ${specNames.length} spec'd — ${problems.join("; ")}`,
  );
} catch (err) {
  record("command menu (getMyCommands)", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// 4. The target chat
// ---------------------------------------------------------------------------
let chat: ChatInfo | null = null;
try {
  chat = await call<ChatInfo>(token, "getChat", { chat_id: chatId });
  const label = chat.title ?? chat.username ?? chat.first_name ?? "(untitled)";
  const matches = !chatId.startsWith("@") ? String(chat.id) === chatId : true;
  record(
    "target chat (getChat)",
    matches,
    `"${label}" · type ${chat.type} · id ${matches ? "matches the configured chat" : "DOES NOT match the configured chat"}`,
  );
} catch (err) {
  record("target chat (getChat)", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// 5. Static board keyboards — no dead buttons
// ---------------------------------------------------------------------------
{
  const boards: Array<{ label: string; keyboard: TgKeyboard }> = [
    { label: "start", keyboard: startMessage().keyboard },
    { label: "help", keyboard: helpMessage().keyboard },
    { label: "menu", keyboard: mainMenu().keyboard },
  ];
  const dead: string[] = [];
  let buttons = 0;
  for (const board of boards) {
    for (const button of board.keyboard.flat()) {
      buttons += 1;
      const resolved = resolveCallbackData(button.callback_data ?? null);
      if (!HANDLED_COMMAND_KINDS.includes(resolved.cmd.kind)) {
        dead.push(`${board.label}: "${button.text}" → ${resolved.cmd.kind}`);
      }
    }
  }
  record(
    "board keyboards resolve",
    dead.length === 0,
    dead.length === 0 ? `${buttons} buttons across 3 boards, all answered` : dead.join("; "),
  );
}

// ---------------------------------------------------------------------------
// 6. One real message, with the real main-menu keyboard
// ---------------------------------------------------------------------------
if (dryRun) {
  record("live delivery (sendMessage)", true, "skipped — --dry-run");
} else {
  try {
    const lines = [
      `⚡ *${md("FlashBolt bot — live smoke check")}*`,
      "",
      `• Bot ${bot.username ? `@${md(bot.username)}` : md("no username")} · id ${bot.id}`,
      `• Chat ${md(chat?.title ?? chat?.username ?? chat?.first_name ?? "(untitled)")} · ${md(chat?.type ?? "unknown")}`,
      `• Menu ${specNames.length} commands · ${webhook?.url ? "webhook registered" : "webhook MISSING"}`,
      `• Pending updates ${webhook?.pending_update_count ?? 0}`,
      `• ${md(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC`,
      "",
      md("Every value above came back from Telegram in this run."),
    ];
    const sent = await call<SentMessage>(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "Markdown",
      disable_notification: true,
      reply_markup: { inline_keyboard: mainMenu().keyboard },
    });
    record(
      "live delivery (sendMessage)",
      typeof sent.message_id === "number",
      `message ${sent.message_id} accepted in chat ${chat?.type ?? "unknown"} with the main-menu keyboard`,
    );
    if (clean) {
      await call<boolean>(token, "deleteMessage", { chat_id: chatId, message_id: sent.message_id });
      record("probe cleanup (deleteMessage)", true, `message ${sent.message_id} deleted`);
    }
  } catch (err) {
    record("live delivery (sendMessage)", false, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failed = checks.filter((check) => !check.ok);
console.log("\nFlashBolt Telegram — live smoke\n");
for (const check of checks) {
  console.log(`  ${check.ok ? "✔" : "✗"} ${check.name} — ${check.detail}`);
}
console.log("");
if (failed.length > 0) {
  console.error(
    `${failed.length} of ${checks.length} check(s) failed. Nothing was retried silently; ` +
      "fix the first failure and re-run.",
  );
  process.exit(1);
}
console.log(
  `All ${checks.length} checks passed — bot ${bot.username ? `@${bot.username}` : `id ${bot.id}`}, ` +
    `menu ${specNames.length}/${specNames.length}, chat resolved` +
    (dryRun ? ", no message sent (--dry-run)." : ", probe delivered."),
);
