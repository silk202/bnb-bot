# FlashBolt Telegram bot — command reference

The bot (`@…` — the username is stamped by `getMe`; see `/status`) runs the
24/7 console independently of the app being open. This page records what every
menu command displays and what each inline button returns.

Implementation split, so a change lands in the right place:

- `src/lib/telegramBot.ts` — pure builders and parsers: every message text,
  inline keyboard, `BOT_COMMAND_SPECS` (the menu data the parity test reads),
  `parseBotCommand`, `resolveCallbackData`, `HANDLED_COMMAND_KINDS`.
- `src/convex/telegramBot.ts` — the webhook, the `setMyCommands` push and its
  version gate, pairing, purge, and the exhaustive dispatch switch.

## Access and pairing

A chat must be linked before it sees operator data. While unlinked (or blocked)
only these answer:

- `/start` — with auto-pair ON (default) it links the chat and boots the
  console; with it OFF it shows the pairing card.
- `/start <CODE>` — deep-link pairing with the code from the app's Account
  menu → Telegram Bot.
- a bare 6–8 character alphanumeric pairing code;
- `/pair` (the "Pair this chat" button);
- `/help`.

Anything else in an unlinked chat replies with the unlinked card
("🔒 Not paired yet"), never with terminal data.

`/unpair` unlinks the chat and returns the pairing card. Chat identity comes
only from the verified Telegram update, never from message text.

## Command menu

Telegram's native slash menu is pushed with `setMyCommands` from
`BOT_COMMAND_SPECS` (40 entries). `BOT_COMMAND_VERSION` is bumped whenever that
list changes; the every-10-minute self-heal compares the stored version and
re-pushes, so a new command appears without waiting for the weekly refresh.

The menu includes both scan commands:

- `/bnb_scan` — run a live BNB feed scan now
- `/sol_scan` — refresh the SOL feed with one live pass

`/start_payload`, bare pairing codes and `/pair` are not menu entries; they are
handled but not advertised.

## Commands — what they display

### Navigation and state

| Command | Reply |
| --- | --- |
| `/start` | Linked: engages the BNB engine server-side and shows the boot card (mode + chain, START/STOP/menu/help buttons). Unlinked: pairing card or auto-pair. |
| `/menu` | Main menu board with inline buttons for every control (start/stop per chain, dashboard, status, engines, settings, deploy, balances, amounts, withdraw, panic, BNB/SOL boards, Trade, routes, executions, PnL, prices, orders, earn, alerts, sound, help). |
| `/dashboard` | Session window, AI score/rating, route count, average edge, liquidity, volume, gas, fleet metrics. An unreachable feed answers with an explicit warning — numbers are never fabricated. |
| `/status` | BNB/SOL engine state, mode, network/chain, contract address, wallet count, scans today + last scan source, opportunities, executions/wins/success rate, lifetime PnL, webhook health, bot username, linked chats, digest/sound/auto-pair prefs. |
| `/engines`, `/engine` | The 24/7 board for all four engines (BNB scan, BNB sniper, SOL scan, SOL sniper) with per-engine freshness stamps and start/stop controls. |
| `/help` | The full command board. Every `/command` it names is parsed by `parseBotCommand`; a parity test fails if it advertises something unknown. |

### BNB FlashBolt

| Command | Reply |
| --- | --- |
| `/bnb` | BNB dashboard from terminal state: engine, mode, contract, balances, PnL, scan/execution counters, with start/stop, paper/live and "Scan now" buttons. |
| `/bnb_on` | Engages the BNB engine; confirms "BNB scanner ENGAGED" with the main menu. |
| `/bnb_off` | Stops BNB only; the SOL engine keeps its own switch. |
| `/bnb_paper` | Sets the global mode to paper; reports that executions are simulated. |
| `/bnb_live` | Sets the global mode to live; reports that real execution arms only with a deployed contract and a connected wallet. |
| `/bnb_scan` | Runs one live feed scan immediately, stamps the BNB scan bookkeeping (freshness + opportunity count, the same bump the app's Scan performs) and replies with the live routes board. An unreachable feed returns the explicit warning instead of an empty board. |
| `/routes` | Top live arbitrage routes from the current feed (no scan stamp). |
| `/execs` | The recent executions trail. Filters: `/execs@live`, `/execs@sim`; the keyboard cycles all → live → sim. A row counts as LIVE when it carries a `txHash`. |
| `/pnl` | On-chain PnL summary for BNB and SOL plus simulated totals. Same filters as `/execs`. |

### SOL FlashBolt

| Command | Reply |
| --- | --- |
| `/sol` | SOL dashboard: engine, network, mode, buy/sell/target/trailing settings, wallets, PnL, with start/stop and "Scan now" buttons. |
| `/sol_on` | Engages the SOL scan + sniper loops server-side. |
| `/sol_off` | Stops the SOL engines only; BNB keeps running. |
| `/sol_scan` | Runs exactly one real pass through the SOL engine body (never a second, divergent scan path) and reports the pass's live/generated route counts. If the pass does not run it names the reason: scanner stopped, app currently driving the scan, no SOL state, a pass already in flight, or the lease just renewed. |

### FlashBolt Trade

| Command | Reply |
| --- | --- |
| `/trade` | Trade overview: balances, active earn plans and accrual, open orders, with navigation buttons. |
| `/balance` | Asset balances (crypto + cash) with live prices. |
| `/withdraw` | Cash balances and recent withdrawals. |
| `/prices` | Live market prices. |
| `/markets` | Top market pairs. |
| `/txs` | Recent transactions. |
| `/orders` | Open limit orders (up to 10). |
| `/earn` | Earn plans with accrual. |
| `/claim` | Claims every claimable flexible-earn plan, then reports the count and per-asset totals; "nothing to claim" and partial-failure replies are explicit. |

### Control, parameters, safety

| Command | Reply |
| --- | --- |
| `/settings` | Strategy and engine parameters from live state: cadence, profit floor, loan cap, hops, slippage, gas priority, auto-payout, MEV guard, private submit, lender rotation, daily target, DEX whitelist, loan assets, SOL buy/sell/target/trailing/liquidity/RPC/wallet counts. |
| `/amount` | Position sizing: loan cap, profit floor, daily target, executions today, SOL buy/sell/target/trailing. |
| `/deploy` | Deployment and live-readiness status per chain: mode, network, contract, router, signer/relay deployments, connected and imported wallet counts. |
| `/stop` | Stops BOTH engines (BNB and SOL), keeping the current mode. |
| `/panic` | Emergency stop: both engines off and mode forced to paper. |

### Alerts, digests and housekeeping

| Command | Reply |
| --- | --- |
| `/alerts` | The alerts board: fanout, digest, sound, chat mute, chat auto-purge (10 min) and channel purge (15 min), plus the last sweep's honest tally and any abandoned rows. Toggle buttons re-render this same board. |
| `/digest` | Toggles the scheduled dashboard digest and re-renders the alerts board. |
| `/sound` | Toggles notification sound and re-renders the alerts board. |
| `/silence` | Mutes/unmutes this chat and re-renders the alerts board. |
| `/purge` | Deletes the bot's tracked messages in this chat now (channel posts are out of scope) and reports the result. |
| `/unpair` | Unlinks the chat and shows the pairing card. |

## Inline buttons

Every button carries `callback_data` that `resolveCallbackData` maps to a
command the dispatcher answers:

- `cmd:/<command>` — the same reply as typing the command;
- `menu:main` — the main menu;
- `help:main` — the help board;
- `pair:start` — the pairing prompt;
- `set:<toggle>` — writes the pref and re-renders `/alerts`
  (`alerts_on|off`, `digest_on|off`, `sound_on|off`, `mute|unmute`,
  `purge_on|off`, `channel_on|off`).

An unknown payload resolves to the help board, so a click always produces a
reply. The webhook acknowledges the callback spinner before any live-feed work
runs.

## Message lifetime

Chat posts are tracked and deleted once older than 10 minutes; channel posts
after 15 minutes (one session-board cycle). Both are controlled by `/alerts`
toggles (`purge_*` for chats, `channel_*` for the channel). The sweep is a
10-minute cron; a transient delete refusal keeps the row for a retry, and
row-level abandonment is surfaced on the board instead of being hidden.

## Verification

- `bun test src/lib/__tests__/telegram-menu.test.ts` — every emitted callback
  resolves to a handled kind, every `/help` command parses, unknown payloads
  still answer, and the `setMyCommands` menu cannot drift from the dispatcher:
  every entry is a valid, parseable Telegram command, no name repeats, and every
  handled kind except the documented unlisted ones is advertised.
- `bun run typecheck` — the dispatch switch is exhaustive over `BotCommand`, so a
  new kind without a case fails the build.

These prove the contract and the builders. They do not exercise live Telegram
delivery or rendering; that still needs a real bot token and a paired chat.
