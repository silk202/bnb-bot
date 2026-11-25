#!/usr/bin/env bun
/**
 * Telegram docs drift gate.
 *
 * TELEGRAM.md and the `/help` board are prose, and prose drifts silently: the
 * round-45 bug shipped two commands that answered but appeared in neither. This
 * compares both with the single source of truth (`BOT_COMMAND_SPECS`) and the
 * real parser, and exits 1 on any mismatch, so CI fails instead of the operator
 * discovering a stale page while holding the phone:
 *
 *   1. the "`BOT_COMMAND_SPECS` (N entries)" claim equals the real length;
 *   2. every menu command is documented as `/command` in TELEGRAM.md;
 *   3. every backticked `/command` in TELEGRAM.md is answered by the parser
 *      (no page advertising a command the bot cannot run);
 *   4. every menu command except a short, stated exemption is on `/help`;
 *   5. every `/command` on `/help` is answered by the parser.
 *
 * Deliberately not checked: wording. The page is allowed to explain more than
 * the menu description says; it is not allowed to name a command that does not
 * work or to omit one that does.
 */
import { BOT_COMMAND_SPECS, helpMessage, parseBotCommand } from "../src/lib/telegramBot";

const DOC = "TELEGRAM.md";

/** Commands the page may name without advertising them in the native menu. */
const MENU_EXEMPT = new Set(["start_payload", "pair"]);

/** Menu commands allowed to stay off the /help board, and why. */
const HELP_EXEMPT = new Map([
  ["start", "the pairing card and /start reply advertise it, /help is for linked chats"],
]);

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
};

const text = await Bun.file(DOC).text();
const specNames = BOT_COMMAND_SPECS.map((spec) => spec.command);
const specSet = new Set(specNames);

// 1. The count claim next to the specs must match the specs.
const claim = text.match(/`BOT_COMMAND_SPECS` \((\d+) entries\)/);
if (!claim) {
  fail(`${DOC}: the "BOT_COMMAND_SPECS (N entries)" claim is missing — the page no longer states the menu size`);
} else if (Number(claim[1]) !== specNames.length) {
  fail(
    `${DOC}: claims ${claim[1]} menu entries, BOT_COMMAND_SPECS has ${specNames.length}`,
  );
}

// 2 + 3. Documented commands: every spec present, nothing unknown advertised.
// Only backticked, slash-prefixed tokens count; `cmd:/<command>` and prose are
// not tokens. A `@filter` suffix (`/execs@live`) belongs to the same command.
const documented = new Set<string>();
for (const match of text.matchAll(/`(\/[a-z0-9_]+)(?:@[a-z0-9_]+)?`/g)) {
  documented.add(match[1].slice(1));
}
for (const name of specNames) {
  if (!documented.has(name)) {
    fail(`${DOC}: /${name} is in BOT_COMMAND_SPECS but the page never documents it`);
  }
}
for (const name of documented) {
  if (specSet.has(name) || MENU_EXEMPT.has(name)) continue;
  if (parseBotCommand(`/${name}`).kind === "unknown") {
    fail(`${DOC}: /${name} is documented but parseBotCommand does not answer it`);
  }
}

// 4 + 5. The /help board must agree with the menu in both directions.
// Only a slash at the start of a word is a command token: "24/7",
// "paper/live" and "on/off" are prose, not commands.
const help = helpMessage().text;
const helpNames = new Set(
  [...help.matchAll(/(?:^|[\s(])\/([a-z][a-z0-9_]*)/gm)].map((match) => match[1]),
);
for (const name of specNames) {
  if (!helpNames.has(name) && !HELP_EXEMPT.has(name)) {
    fail(
      `/help does not list /${name} (add it, or add a stated HELP_EXEMPT reason in ${"scripts/check-telegram-docs.ts"})`,
    );
  }
}
for (const name of helpNames) {
  if (parseBotCommand(`/${name}`).kind === "unknown") {
    fail(`/help lists /${name}, which parseBotCommand does not answer`);
  }
}

if (failures.length > 0) {
  console.error(`telegram docs drift — ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    `\nFix ${DOC} / helpMessage() / BOT_COMMAND_SPECS so all three agree, then re-run.`,
  );
  process.exit(1);
}

console.log(
  `telegram docs ok — ${specNames.length} menu commands, all documented; ` +
    `${helpNames.size} commands on /help, all parse.`,
);
