# Changelog

All notable changes to FlashBolt.

## [Unreleased] — Production stays on zany-butterfly-308; the trustworthy-ermine-368 cutover deferred (2026-11-01)

### The cutover was rolled back before it served any traffic

- **Production remains `zany-butterfly-308`** — the deployment that actually serves the app. Client URL `https://zany-butterfly-308.convex.cloud`; HTTP-actions origin (Telegram webhook, overlay daily-target gate, Kora webhook) `https://zany-butterfly-308.convex.site`. Verified live during the rollback: `users:currentUser` → `{"status":"success","value":null}`, `GET /api/copier/signals` → 200 with signals JSON, `GET /api/overlay/execution` → 401 (route exists, token required).
- The named replacement **`trustworthy-ermine-368` was never deployed to**: every `POST /api/query` (`gate:operatorStatus`, `users:currentUser`, even a bogus path) returns a server error, and every `.convex.site` route answers `404 This Convex deployment does not have HTTP actions enabled` — same trio at 404 where zany answers 200/401. It stays out of the lineage until its functions, backend env vars and its own deploy key exist.
- Overlay artifacts re-stamped back to the serving origin (`bun run overlay` with `VITE_CONVEX_URL=https://zany-butterfly-308.convex.cloud`): the userscript and both extension bundles (Chrome MV3 / Firefox MV2) plus their zips now gate against `zany-butterfly-308.convex.site`, so a stamped daily-target gate is reachable again instead of 404ing.
- `DEPLOYMENT.md` reverted to the zany lineage — production, the per-deployment deploy-key warning (verify the target with `bunx convex logs --history 1` before trusting a key), the `VITE_CONVEX_URL` build variable and the usage-gauge re-arm note all name the serving deployment again, and the deferred cutover is called out where it used to command a switch.
- Standing note kept from the original cutover entry: backend env vars (`JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL`, bot tokens, `VLY_*`, …) and the deploy key live **on the serving deployment itself** — they never migrate with a code push, which is exactly why an empty replacement deployment could not have served traffic.

## [2.9.0] — Free-plan budget hardening + daily data retention (2026-10-07)

### Call & DB-I/O budget: 30,000 calls/day and ~30 MB/day, forever

- **Engine loops 45 s → 180 s** with the online window 90 s → 300 s (heartbeat `*/5` still resurrects any dead loop; single-driver rules untouched) — ~23k → ~6–8k function calls/day. Client scan bumps now coalesce through ONE shared 60-second gate (`src/lib/bump-throttle.ts`) instead of stacking writes from the cadence timer, both Scanner pages and the SOL feed hook.
- **Indexed operator resolution** (`resolveOperatorState`) replaces the full `terminalStates` + `users` table collects that ran on every engine pass, bump and Telegram command (~94 KB → ~2 KB per resolution).
- **Materialized `pnlStats`** — the subscribed PnL summary no longer rescans the 16k-row / 6 MB executions table on every trade; `applyExecution` folds each row incrementally, the per-session ledger purge applies exact deltas, and the retention sweep materializes stats before deleting anything. 24-hour figures come from a bounded `by_user_ts` range.
- **Cached fleet metrics** — the 94 KB terminalStates aggregate is computed by a `fleet-metrics-refresh` cron every 20 min and served from a snapshot; the 15-minute session signal and Telegram digest read one small doc instead of ~18 MB/day of scans.
- Bounded reads everywhere: newest-N indexed `listExecutions`/`listNotifications`, unread-only bell count, kind-scoped honey-pot/market-news reads, engine-side 45-minute signal window, 60-second execution-label range, day-range metric scans, `by_status` accrual, stale-range copier pruning, no-op patch suppression on signal re-polls, and a slim `getEnginePulseState` projection for the always-mounted EnginePulse.
- Crons trimmed (order-scan 5 min, chain-watch/copier 3 min, earn accrual 3-hourly) and **hard guardrails enabled**: 30,000 calls/day and 1,000,000 calls/month function-call limits, 1 GB/day DB-I/O, and per-metric egress/compute/search gauges (full table in DEPLOYMENT.md) that disable the deployment when crossed and re-enable automatically at the next window rollover.

### Daily data retention — only essential data is stored (`daily-retention`, every 4 hours)

- New `src/convex/retention.ts`: notifications > 30 days, **paper** executions > 30 days (all-time totals stay exact in `pnlStats`; LIVE on-chain rows are never deleted), Telegram sent-signal history > 7 days, expired one-time operator codes, dead rate-limit windows, and the TTS cache rows **plus their storage blobs** > 30 days — all in bounded batches every 4 hours that drain backlogs over runs. The copier signal feed also carries a 12-hour backstop sweep (double the poller's own 6-hour TTL) so a dead poller can never let the feed accumulate, and `audit-log-prune` runs every 6 hours under the operator console's live subscription.
- Kept forever: trade ledgers (balances, txs, orders, earn plans, deposits, cash accounts), `pnlStats`, users/terminal states, subscribers & support tickets, licenses, Telegram pairing/bot config, gate/operator config, device trust and the live execution trail. `pruneAuditLogs` (7 days) and the copier's 6-hour signal TTL continue as before.
- The per-session ledger self-heal now applies **deltas** instead of rebuilding from raw rows, so retention can never erase folded history. Manual drain: `bun run retention:once`.

### Release surfaces updated in lockstep (v2.9.0)

- Version bumped across `package.json`, both overlay generators + tests, both extension manifests, all overlay READMEs and regenerated overlay artifacts (`bun run overlay`); `DEPLOYMENT.md` documents the retention contract, the usage-limit guardrails and the new script; the Telegram `/help` board now states the data-retention policy; `.gitignore` additionally blocks database export dumps (`*.jsonl`, `export/`) so a data export can never be committed.

## [Unreleased] — 24/7 background runners for all five subsystems

### Account menu "Telegram Bot" opens TAEngine with the pairing payload intact (2026-10-01)

- The account menu's "Telegram Bot" row (backed by the `TELEGRAM_BOT_TOKEN` in the Keys/API keys table) still opens the TAEngine bot directly on click — same-tab native navigation, no popups, no interstitials — but the **desktop deep link was rebuilt against Telegram Web K's actual shipped router** instead of an assumed one: with a pairing code it now navigates to `https://web.telegram.org/k/#?tgaddr=<encoded https://t.me/<bot>?start=<code>>`, Web K's `tgaddr` branch, which routes through its internal `im` link handler and keeps `?start=` as the chat's start param (START button carries `/start <code>`; it auto-fires when the bot needs no start button). Without a code it stays on the verified `#@<bot>` form.
- The previous desktop form `#@<bot>?start=<code>` opened the chat but **silently dropped the pairing payload** — verified in Web K's `onHashChangeUnsafe`: the hash is split at `?`, the `@`-branch passes only `{userName, lastMsgId, threadId}` to `openUsername`, so pairing depended entirely on the server's auto-pair policy. Mobile is unchanged (`https://t.me/<bot>?start=<code>` — the official universal link that hands off to the Telegram app).
- New pure `buildTelegramBotLink` in `src/lib/telegram-deep-link.ts` (shared by the native-anchor href and the first-connect redirect path so they can never diverge), with 5 tests pinning all four URL contracts plus an explicit never-emit assertion for the payload-dropping form. 418 tests / 0 fail, tsc 0.

### Vault dashboard surfaced on BOTH Overview pages (2026-10-01)

- The vault-removal surface ("clear an unrelated or unwanted wallet address wrongly generated in the app") was only reachable on the Wallets pages — BNB `Wallets` and SOL `SolWallets`, both under "Vault dashboard — in-memory live signers". It is now **also rendered on both Overview pages**: `/terminal` (BNB) and `/sol-terminal` (SOL) each carry a "Vault dashboard — clear unwanted signers" card directly under the launch checklist.
- New shared `VaultSignerCard` reads the REAL in-memory vault through a per-terminal adapter (BNB → `evm-vault`, SOL → `solana-vault` — each Overview wires only its own vault, no cross-bundle import) and removal runs through the same `describeVaultRemoval` flow the Wallets pages use: key out of memory AND the encrypted blob, last removal = clean slate (blob destroyed), honest toasts identical to the Wallets pages.
- Guardrails: a two-step Remove (arm → "Confirm remove", and "Confirm — clears vault" when it is the last signer) so a mis-click on the Overview can never wipe the vault; an honest empty state ("No live signers in this tab — the vault is empty or locked") linking to the right Wallets page for import/unlock; a "Manage vault" link in the card header. No behavior on the Wallets pages changed; 413 tests / 0 fail, tsc 0.

### Information sync: README, deployment guide, drills, app metadata (2026-10-01)

- **README** rewritten for the dual-chain reality: subsystem map for both terminals (scanner / sniper / telecopier / flasher / vaults per chain + Trade, TAEngine, gate, desktop licensing, support assistant, overlay), full CLI table, deployment-platform summary (Vercel · Netlify · Cloudflare Pages · Render with their in-repo configs), Downloads & desktop-apps section, TAEngine bot section (per-chain `/start` + `/engines`, TASignal channel separation, webhook self-heal), responsiveness/mobile statement, current env-var inventory (backend + client), a Solana-live-mode section (wallet-fit, 0.05 SOL floor, pre-sign sims, Jito), and the version history brought up to 2.1 → 2.8.
- **DEPLOYMENT.md** gains the production-lineage section (default prod = the serving deployment; verify with `--prod`; push `src/convex/` **and imported `src/lib/` files** with `bunx convex dev --once`), the complete backend env-var list (`BREVO`, `CARTESIA`, `VLY_*`, circuit breakers, webhook self-heal), three missing scripts (`check:mirror`, `drill`, `drill:evm`, `clean`), and an architecture section that finally names Solana, the Telegram console and desktop licensing. **DRILLS.md** marks the migration runbook as resolved/retired (Oct 1 reset + default-prod cutover). App metadata (index.html title/description, PWA manifest) updated to the dual-chain identity; integrations.md corrected to the real gateway URL. Verified 413 tests / 0 fail, tsc 0.

### SOL min loan lowered to 0.05 — the strategy floor is the wallet-fit floor (2026-10-01)

- `SOL_MIN_LOAN` is now **0.05 SOL** (was 0.5) across every consumer — Strategy input + slider bounds/save clamp, scanner + telecopier feed clamps, and the server-side heartbeat feed. The floor now matches the wallet-fit minimum clip exactly, so a **0.055 SOL wallet** (0.05 clip + 0.005 fees/rent) can land a real route end to end: set the max loan to 0.05 in Strategy and the feed builds, previews and executes at the fitted size. On Solana the wallet fronts the clip (no borrowed principal), so the old 0.5 floor made small wallets unlandable by definition. Feed-row fit preview (`loan 2.5 → fit 0.0560 SOL` / `wallet below 0.0550 SOL`) and the sniper's fitted buy clip were already live and now agree with the floor.
- SOL Wallets: the connected extension card now carries a click-to-copy for the **full pubkey** — read live from the injected provider (persisted rows only keep 8 chars), so the copy button appears only when the extension actually exposes the address; a locked wallet never fakes one. Matches the BNB page's copy affordances. Clamp test updated to the 0.05 floor; 413 total.

### Vault Remove = the documented clean-slate flow, on both Wallets pages (2026-10-01)

- The BNB and SOL Wallets pages share one removal flow (`describeVaultRemoval`): Remove deletes the signing key from memory AND the encrypted blob — and when it was the last import, the tab's encrypted blob itself is destroyed, reported as **"Vault cleared — clean slate — the signing key left memory and the tab's encrypted blob was destroyed. Import the replacement secret fresh"** (no Lock needed). Non-final removals report the remaining signer count and prompt a fresh recovery sheet.
- Hygiene hardened on both pages: a stale recovery sheet is dropped on any removal (the BNB page previously kept one), the sheet passphrase is cleared on clean slate, and the Remove action is styled as destructive red. Unknown addresses stay an honest no-op. 4 new unit tests pin the described outcomes; 413 total.

### Default prod cutover: zany-butterfly-308 is the project's production deployment (2026-10-01)

- The operator switched the project's **default production deployment** to `zany-butterfly-308` in the dashboard — the deployment that actually serves the app now owns the whole lineage: `bunx convex deploy` / the CI pipeline targets it, `--prod` resolves to it, and its `SITE_URL` (`https://zany-butterfly-308.convex.site`) matches the app's real URL. Verified: `--prod` usage/limits resolve to zany's own counters (800K calls/mo at 9%, 100 GB DB I/O at 3%).
- Supersedes the earlier pipeline note below (which targeted the serving-disabled `exciting-camel-977`); the migrate-to-a-fresh-deployment plan is retired — the Oct 1 free-tier reset restored serving and this cutover made it permanent.
- Same-hour fallout fixed: `exciting-camel-977`'s 10-minute webhook self-heal cron re-pointed the Telegram webhook back to itself; re-registered to zany and verified via `getWebhookInfo` (`https://zany-butterfly-308.convex.site/api/telegram/webhook`, 0 pending). Standing reminder: pause or delete the stale camel deployment to stop its duplicate crons from burning the shared free budget — and to end the webhook tug-of-war for good.

### Wallets page: funding made one-glance (2026-10-01)

- The Wallets page header now shows the connected account's **full 0x address** with a click-to-copy button and its **live BNB balance** (real `eth_getBalance`) — the exact string to give an exchange or sender, no more reconstructing it from a shortened form. Connected wallet cards and vault-dashboard signers each carry a copy button too.
- New support-assistant **funding topic**: fund your own wallet (the app never takes a deposit), copy the address from the header, match the network (BNB Smart Chain / Solana; tBNB test-only via the faucet), and pick the same network on exchange withdrawals or funds can strand. Quick chip "Fund my wallet" added; 4 new matcher tests including collision checks (payout → auto-payout, connection → wallets). 409 total.

### Wallet-fit execution: oversized SOL signals land as smaller REAL trades (2026-10-01)

- "Live route did not land" on a big signal is fixed at the root: on Solana the wallet fronts the whole clip (no borrowed principal), so a 2.5–9 SOL signal on a 0.061 SOL wallet could only ever die in Phantom ("You don't have enough SOL" / "Failed to simulate") or bounce off the pre-flight. The two-leg live arb now **fits the clip to the wallet**: an oversized signal shrinks to `balance − 0.005 SOL fee/rent reserve` (floor 0.05 SOL, so fees can never swamp the trade) and executes as a real, smaller route — the wallet popup opens with a signable, landable transaction instead of a doomed one.
- Reports are decent either way: a fitted landing reads "Live arb landed +0.42% · fitted 9.0000 → 0.0560 SOL to the wallet · Meteora + Raydium · net 0.0002 SOL · sell AbC…", and a wallet that cannot front even the 0.05 SOL floor (below 0.055 SOL total) is refused **before the wallet** with the exact top-up math ("Route refused before the wallet"). Pre-flight refusals now record as plain failures in the live ledger (not "below_floor" profits), and the SOL Telecopier's status line states the fit behaviour outright.
- The same fit now covers the sniper's buy clip (the position's entry cost registers the fitted clip the wallet actually spent, and the fit is named in the success toasts) and the LIVE ROUTE FEED previews it before you click Execute: each row shows `loan 2.5 → fit 0.0560 SOL` from a real `getBalance` (live mode only), or `wallet below 0.0550 SOL` when even the floor cannot fit.
- New pure `fitRouteLoanToWallet` math (6 unit tests, including the 0.061-vs-9-SOL screenshot case and the floor boundary); 405 total. Support-assistant balance topic updated to the fit rule (small-wallet answers now say the route lands fitted, e.g. 0.061 SOL → 0.056 SOL clip).

### Support assistant now covers the SOL terminal (2026-10-01)

- The account-menu Support assistant (shared by the BNB and SOL terminals) gains four knowledge-base topics written from the app's real behaviour: the Solana terminal (Jupiter two-leg routes, Jito-protected submission, sniper/scanner), the SOL arb-balance rule (the wallet fronts the loan size itself plus a 0.005 SOL fee/rent reserve — a 5 SOL arb needs 5.005 SOL, the 0.5 SOL minimum loan needs 0.505 SOL, and a short wallet is refused inline with the exact shortfall before anything is signed), SOL wallets (extension connect, seed-phrase/private-key import sealed AES-256-GCM under a user-chosen session passphrase, unlock after reload, recovery sheet, watch-only addresses) and the SOL Strategy guards (profit floor 0–5%, slippage 0.05–5%, cadence 1–300 s, max loan 0.5–50 SOL).
- Greeting and fallback copy now mention the Solana coverage, and two quick-topic chips were added ("SOL for a 5 SOL arb?", "Import a Phantom wallet"). 9 new matcher tests including collision checks (generic BNB questions still route to the BNB topics); 399 total.

### Deploy-build hardening: kill-proofing the production build (2026-10-01)

- Diagnosed the deploy pipeline's `Killed` failure: the full production build passes locally end-to-end (tsc → overlay → vite, ~19 s, all artifacts), and `tsc -b` passes even under a 1.5 GB V8 heap cap — the kill came from the deploy runner's own resource-capped container, not from a code defect. The pipeline's build command (`tsc -b && vite build`) is injected by the deploy runner (confirmed against `convex deploy`'s `--cmd` executor) and is not configurable from the repo.
- Applied the one zero-risk reduction available to both OOM and time-cap hypotheses: `build.reportCompressedSize: false` skips Vite's post-build gzip-sizing pass (re-reads + compresses every chunk for a cosmetic report column; output bytes unchanged). Build re-verified green.
- Note: the pipeline deploys to this project's default prod deployment (`exciting-camel-977`, serving-disabled) — a green build cannot make it serve. The `kn7apxn1` cutover (deploy key → push → snapshot import → webhook re-register, then default-prod switch) remains the real unblock.

### SOL Strategy: Guards & execution made flawlessly adjustable (2026-10-01)

- Profit floor, scan cadence, max loan and slippage are now first-class controls: bounded number inputs + live sliders (bounds identical to the save-time clamps, adding the missing 5% profit-floor cap to the save clamp so UI and persistence agree), mono value readouts on every label, and explanatory sublabels.
- Blur normalization makes the visible number the persisted number (typed values clamp into range; garbage falls back to the control's default); slider stepping snaps to 4 decimals so float artifacts (0.05000000000000001-style) never reach the label or the database.
- Failed saves surface honestly (paused-backend-aware message) instead of vanishing as unhandled rejections; the server-sync effect keys on persisted primitives only, so it can never clobber mid-edit typing.

### No more doomed Phantom popups: buy pre-flight + pre-sign simulation gates (2026-10-01)

- The SOL live execution legs (snipe buy, snipe sell, two-leg arb) now refuse an unaffordable or would-fail trade **before the wallet ever opens**: (1) a real `getBalance` pre-flight covers buy amount + a 0.005 SOL fee/ATA-rent reserve with exact shortfall math; (2) a zero-gas pre-sign simulation of the exact unsigned tx catches route/rent/slippage failures before the signature is requested. The phantom "You don't have enough SOL" / "Failed to simulate" confirm dialog can no longer appear from this app.
- Refusals are honest and exact ("wallet holds 0.104 SOL but the buy needs 0.1 + 0.005 fees/rent = 0.105 SOL — short by 0.001 SOL. Nothing was signed or spent"). Simulation transport errors carry no verdict and fall through to the unchanged post-sign gate; the arb builder now also refuses the buy leg before any signature and only signs the sell leg after its own sim passes (a signed-but-unbroadcast buy is never spent).
- 9 new unit tests for the affordability math (390 total).

### Graceful backend-standby mode: paused-deployment degradation (2026-10-01)

- While the Convex deployment is paused (free-plan serving disable), the app now degrades **seamlessly** instead of crashing: the raw "Preview runtime error" wall is replaced by a branded standby screen ("FlashBolt is on standby") with automatic recovery probing (15 s cadence) and a manual "Try again now" button.
- New `src/lib/backend-outage.ts`: precise detection of the plan-limit failure class (genuine bugs still reach the real error boundary untouched), user-safe error mapping (`userSafeBackendError`), and a tiny external store + hook (`useBackendOutage`) so any component can observe the outage; 12 new unit tests (381 total).
- Auth-gated routes render the standby screen instead of an eternal spinner while the auth boot cannot resolve; gate and auth forms show the friendly outage copy instead of the raw 500 body.
- Self-healing by design: when the deployment serves again, queries stop throwing, the outage flag clears, and the app recovers whole — no redeploy needed.

### Migration hardening: free-tier function-call diet + usage circuit breakers (2026-09-29)

- **Engine heartbeat thinned `* * * * *` → `*/5 * * * *`**: the heartbeat is only the OUTAGE RECOVERY path (the engine loops re-schedule their own next pass continuously), so a 5-minute recovery SLA cuts recurring function-call volume ~80% with zero behavior change while bots are healthy.
- **Usage circuit breakers on the deployment** (400K function calls/mo, 25 GB database I/O/mo, `disable` type): a runaway loop can never again silently disable the deployment for exceeding the free tier — it trips a known, observable stop first.
- **Full data snapshot secured** (`convex export` → snapshot zip, also visible in dashboard → Settings → Snapshots) before any migration move.
- Migration runbook (operator actions): see `DRILLS.md` § Convex migration.

### TAEngine standalone console: /engines board + full-console /start (2026-09-29)

- **`/engines`** (new bot command + menu + help entry): the real 24/7 board of all FOUR server engines — BNB/SOL scanner and BNB/SOL sniper — each rendered with its persisted per-chain switch AND its own honest freshness stamp (which driver ran the last pass: server engine or app, and how long ago; "starting…" when a switch is ON but no pass has stamped yet).
- **`/start` boots the complete console**: previously it armed only the BNB switch; it now flips BOTH per-chain switches (BNB + SOL, each respecting its own switch) and kicks all four engine loops — the account-menu "Telegram bot" → TAEngine → /start now runs the whole fleet app-closed.
- **Main menu is per-chain**: 🚀 START BNB / ⏹ STOP BNB and ☀️ START SOL / ⏹ STOP SOL replace the single ambiguous START/STOP pair; ⚙️ Engines joins the nav row.
- Alert-channel separation is unchanged and documented: trade/session alerts go to the TASignal channel (`TELEGRAM_CHAT_ID`); TAEngine commands, fanout and digest go only to linked operator chats.
- 4 new unit tests (369 total).

### Instant TAEngine open from the account menu (2026-09-29)

- "Telegram bot" now opens with zero clicks-to-wait: a post-mount pre-warm resolves the bot identity (webhook self-heal + pairing code + real getMe) BEFORE the menu is even opened, in addition to the existing menu-open pre-warm.
- ONE shared in-flight connect per session — the click path reuses the pre-warm's promise instead of stacking a second server action (duplicate getMe/webhook calls removed).
- Same-tab native navigation only — mobile lands straight in the Telegram app via the t.me universal link; desktop becomes Web Telegram already on the bot chat. No popups, no dialogs, no intermediate pages; failures stay a quiet toast.

### History analytics: signing-latency column, filter & CSV export (2026-09-29)

- History: dedicated **Sign** column (violet, `fmtSignLatency` µs precision) plus the existing inline line under dexes.
- New **latency filter chips** — Any latency / Measured / Unmeasured — backed by a shared pure predicate (`src/lib/history-analytics.ts`) so UI and tests agree on "measured".
- **Measured sign avg** stat card joins the summary grid (unmeasured rows excluded, never zero-filled; honest `—` when nothing is measured).
- **Export CSV** on the filtered trail: ISO-8601 UTC timestamps, `sign_latency_ms` raw numeric (empty when unmeasured) and human `sign_latency`, Excel-safe quoting/CRLF. 10 new unit tests (365 total).

### Drill address hardening · funding runbook (2026-09-29)

- **EVM drill key hardened to deterministic high entropy** — `drill:evm` now
derives its testnet key from a SHA-256 label (`flashbolt-evm-drill-v1`),
matching the SOL drill; the previous human-guessable `0x…42` constant is
exactly the pattern seed-sniper bots hunt. New stable drill address:
`0x329513F68b697e83a769800A45fB84C568B47901`. A hijack guard now requires
zero code at the address before trusting a pre-funded balance.
- **DRILLS.md** — stage map for both drills, the deterministic drill
addresses, the manual funding runbook (official CAPTCHA faucets + explorer
verification links) and the honest-failure contract; linked from the README
testnet runbook.
- **Funding status (honest)** — `bun run drill:all` re-run 2026-09-29: SOL +
BNB vault and signing stages pass live; both faucets still refuse
programmatic requests from this environment (daily limits / CAPTCHA-only),
so the broadcast + swap stages remain armed and waiting on a one-time
manual drip to the documented addresses.
- **Drills are now a release gate** — `bun run drill:report` pins the
verbatim combined output to `reports/drill-latest.txt`, and `bun run verify`
gains a 4th step (`check:drill`) that fails the release unless that artifact
shows a fresh (≤ 24 h) 2/2 combined verdict. No bypass flag: a below-2/2,
stale or malformed report holds the release and prints the exact addresses
to fund. 9 unit tests cover every hold path (below-verdict, stale, empty,
malformed, missing addresses).
- **Telegram bot: real-time signing latency on live executions** — the
production executor now measures the actual local signing call
(`performance.now` around `account.signTransaction` in
`sendSignedTransaction`, opt-in on every hot-path site: sniper buys, sells,
manual + auto-arb flash loans). The measured value flows through
`BuyResult`/`SellResult`/the auto-sell `onSell` contract into the channel
alerts: sub-millisecond signs render as µs (`sign ≈741µs`) in the
notification title and body. The injected-wallet path renders nothing —
the extension signs there, so the app cannot honestly measure it. 2 new
tests pin the µs rendering and the honest absence.
- **Drill hold surfaced in the terminal UI** — a `DrillStatusCard` on both
Overview pages renders the REAL pinned `reports/drill-latest.txt` through
the same pure evaluator the release gate uses (extracted to
`src/lib/drill-report.ts`; the CLI gate re-exports it, so UI and gate can
never disagree), with the verdict, hold reason and explorer-linked funding
addresses — no CLI needed.
- **`git:sync` surfaces the drill hold before committing** — the pre-flight
prints the live-drill gate status (hold reason + addresses to fund) as a
loud warning; sync still ships source (releases are held by `bun run
verify`, not by sync), so nothing is hidden and nothing is blocked twice.

### Deterministic drills · PancakeSwap swap stage (2026-09-28)

- **Deterministic high-entropy drill keys** — both drills now derive their
  drill key from a SHA-256 label (stable address across re-runs, so faucet
  grants persist). Honest security discovery along the way: the previous
  all-7s seed address was hunted by devnet seed-sniper bots and wrapped into
  an SPL token account (11 "SOL" nobody's key controls) — drills now verify
  the drill account is SYSTEM-owned before trusting a pre-funded balance.
- **Real bug fixed in the drill broadcast** — devnet's getLatestBlockhash
  nests its payload under `.value`; the drill now reads it correctly and
  attempts the real broadcast when funded.
- **EVM drill Stage 5: real PancakeSwap swap through the production path** —
  live `PairCreated` log discovery on the verified PCS V2 testnet factory,
  then the executor's own `buyToken` (live getAmountsOut quote → full dual
  eth_estimateGas simulation → vault-signed buy) — with on-chain proof: the
  signer must actually HOLD the bought token. No fixture addresses, no fake
  fills; if no live pair passes the simulation the stage fails honestly.

### Combined drill runner · vault balances (2026-09-28)

- **`bun run drill:all`** — SOL devnet + BSC testnet drills back to back,
  output streamed untouched, one combined verdict (0/2..2/2). Faucet
  refusals print the exact drill addresses for manual funding; green checks
  are only ever printed for stages that really passed.
- **BNB vault dashboard balances** — real `eth_getBalance` per armed signer
  on the active network (mainnet/testnet), auto-refresh on signer change
  plus a manual refresh button; RPC failures show an honest "unreachable"
  placeholder, never a guess.

### BNB drill · EVM recovery sheet · HUD live-signer row (2026-09-28)

- **EVM devnet drill (`bun run drill:evm`)** — exercises the PRODUCTION EVM
  path with nothing mocked: real AES-256-GCM vault seal/lock/unlock with the
  `getVaultHotWallet` seam check, in-memory viem secp256k1 signing whose
  signature is cryptographically recovered to the vault address, and a real
  `transferNative` → `eth_getTransactionReceipt` broadcast on BSC testnet
  through the same function Scanner/Sniper use in production. Faucet
  refusals are reported honestly with the drill address for manual funding.
- **EVM recovery sheet (BNB Wallets vault dashboard)** — passphrase re-gated
  plaintext key export (PBKDF2 re-derivation, real gate) with copy/download;
  states the honest limitation that mnemonic imports vault the DERIVED key.
- **BNB Sniper HUD live-signer rows** — "Live Signer" (vault → hot →
  extension/none) and "Vault Signers" count, refreshed on window focus so
  an unlock in another tab is never faked.

### BNB FlashBolt vault import + per-card inline import (2026-09-28)

- **`evm-import.ts` / `evm-vault.ts` (12 tests)** — EVM wallet import for
  BNB FlashBolt with the same cryptographic contract as the SOL vault:
  BIP39 mnemonics derive through viem/accounts at m/44'/60'/0'/0/0
  (MetaMask/Trust compatible); 0x private keys are validated as 32-byte
  secp256k1 material; a real `eth_chainId` round-trip confirms the network
  before the signer arms. Secrets are sealed with AES-256-GCM (PBKDF2-SHA-256,
  310k iterations, non-extractable key) in sessionStorage of the current tab
  only — plaintext lives solely in module memory for signing. Only PUBLIC
  addresses persist (new `evmImportedWallets` terminal-state field).
- **BNB live execution consumes the vault** — Sniper auto-sell `getSigner`,
  `executeSnipe`, quick-snip simulation, hot-wallet payout and /withdraw all
  resolve vault signer → generated hot wallet → injected extension. Scanner
  auto-arb and manual flash paths accept the vault signer as the flasher's
  hot wallet (still gated by the real onlyOwner `owner()` eth_call). Signed
  bytes flow through the existing private-relay / public-RPC broadcast —
  no mocks anywhere; no signer → honest refusal, never a paper fill.
- **Plaintext import removed** — the old BNB direct-wallet flow (mnemonic in
  React state, rendered to the DOM) is replaced by the sealed vault; the
  secret is never stored, rendered or transmitted.
- **Inline "Import wallet" under every wallet card** — BNB Wallets page
  (MetaMask/Trust/OKX/Binance/Bybit) and SOL Wallets page both carry a
  per-card import panel: session passphrase + secret (or watch-only public
  address), Import/Unlock and Lock-vault controls, plus a vault dashboard of
  armed in-memory signers with removal.

### Devnet drill · auto-exit manager · vault dashboard (2026-09-28)

- **Live devnet drill (`bun run drill`)** — exercises the PRODUCTION path on
  real devnet, nothing mocked: vault seal/lock/unlock (real AES-256-GCM),
  in-memory ed25519 signing (measured 13ms), real funding (cluster airdrop
  with the public faucet.solana.com API as fallback), real sendTransaction →
  getSignatureStatuses confirmation via the same transport execution uses,
  and the real getTokenAccountsByOwner query shape. Verdict output names
  every stage; faucet daily limits are reported honestly with the drill
  address for manual funding + re-run.
- **Auto-exit position manager (sniper, live)** — `solana-exit-engine.ts`
  (pure, 7 tests) turns /settings' profitTargetPct / sellAmountPct /
  trailingStopPct into exit decisions from REAL inputs (entry cost basis,
  live Jupiter quote of the actual balance, observed peak). The new
  `use-sol-positions` hook executes: real balance per tick, real quote,
  real sell (sign → simulate → Jito/public → confirm), proceeds measured
  by the owner's getBalance delta across the confirmed sell (fees included,
  nothing estimated). Partial target-exits carry a proportional cost basis
  forward; the remainder rides the trailing stop. Live snipes now register
  as positions (hold mode) when automation is armed, and exit fills land in
  the ledger with the real sell signature; "Sell now" forces a manual full
  exit through the identical path. The sniper HUD gained a Live positions
  card (cost basis, peak ROI, auto-exit config, last exit).
- **Vault dashboard (Wallets page)** — per-signer REAL SOL balances
  (getBalance against mainnet RPC), per-signer Remove (memory + encrypted
  blob re-write), and a passphrase re-gated **recovery sheet**: exports the
  vaulted keys in plaintext only after PBKDF2 re-verification, viewable /
  copyable / downloadable as .txt, auto-invalidated when the vault changes.
  The sheet states the honest limitation on its face: mnemonic imports are
  vaulted as their DERIVED key — the word list was never stored, so seed
  phrases must be backed up separately.

### Imported wallets (vault) + real live sniping (2026-09-28)

- **Inline "Import wallet" on every SOL Wallets card**: beneath each wallet
  dashboard (Phantom / Solflare / Backpack) an Import wallet button opens a
  session-passphrase + secret form. Accepts a 12–24 word seed phrase
  (BIP39 checksum + SLIP-0010 ed25519 at m/44'/501'/0'/0', Phantom-
  compatible), a base58/hex private key (embedded-pubkey consistency
  check), or a bare public key (watch-only — honestly reported as unable
  to sign). Cryptography is 100% local; nothing is ever transmitted.
- **Cryptographically secured vault (`src/lib/solana-vault.ts`, 6 unit
  tests)**: secrets are sealed with AES-256-GCM under a PBKDF2-SHA-256
  (310k iterations) session passphrase; only ciphertext ever touches
  sessionStorage, the derived key lives in module memory only, and the
  unsealed 64-byte secret exists solely as a signing Keypair in memory.
  Lock clears memory (passphrase re-arms); Wipe destroys memory + the
  tab's ciphertext. Wrong-passphrase unlock is refused without touching
  the blob (tested).
- **Sub-millisecond signing path**: imported wallets sign with the
  in-memory ed25519 Keypair directly (`makeKeypairSigner`) — no extension
  round-trip, no prompt. Honest scope: signer resolution + local signing
  are sub-ms; Jupiter quoting, RPC broadcast and confirmation remain
  network-bound (physics, not mockable).
- **Sniper now really fires live (auto AND manual)**: `executeSnipe` was
  paper-only — it now resolves the armed signer (vault → extension), then
  executes a REAL Jupiter buy (quote → build → sign → zero-gas simulate →
  Jito-protected or public submit → on-chain confirm) followed by a REAL
  sell that reads the wallet's ACTUAL token balance
  (`getTokenAccountsByOwner`) and exits the whole position. No signer →
  honest `no-wallet` failure row (paper fill is never silently used);
  buy landed + sell failed → honest "position opened" warning with the
  buy signature. Live rows carry real signatures into the ledger.
- **One shared signer resolver** (`resolveLiveSigner`): vault signer
  first, then the connected extension — used by the Scanner/Flasher live
  branch AND both sniper legs, so an imported wallet arms every SOL live
  surface identically (Scanner previously refused without an extension).
- **HUD honesty**: the sniper's Main HUD gained a "Live signer" row
  (vault address / extension / none), and the import panel lists the
  session vault's live signers + watch-only entries with their state.

### SOL FlashBolt live execution + ledger integrity (2026-09-28)

- **Real live mode for the SOL Flasher's Scanner** — paper fallback removed
  from live: routes with a token mint now quote both legs on Jupiter (lite
  API), the connected Phantom/Solflare/Backpack wallet signs each
  transaction inside the extension (keys never leave it), the buy leg is
  simulated for a zero-gas gate, then sent via Jito block engines when
  protected submission is ON (public RPC otherwise), confirmed, and the
  sell leg follows. Net SOL is measured from the executed quotes and the
  row is attributed with the real sell signature; a failed buy never fires
  the sell, and a failed sell reports honestly ("tokens held — sell
  manually or retry").
- **Phantom-spread root cause fixed in `solana-routes.ts`**: DexScreener
  per-venue `priceUsd` for thin memecoins goes stale, so one venue's mark
  can be hours old — the builder now drops candidates whose venues both
  carry 24h volume/1h move fields showing < $1k volume and < 1% movement,
  treats absent fields as unknown (bounded by the cap), and hard-refuses
  any computed spread above 200%. Three new regression tests (17 pass).
- **Corrupted paper ledger purge**: the +10,040,700 SOL PnL came from
  stale-mark paper credits (profitPct ~10,040,671%). New Convex mutation
  `purgeCorruptedSolPaper` deletes solana success rows with no txHash and
  profitPct > 100 and reverses balance/lifetimePnl/payouts; exposed as a
  "Purge corrupted paper rows" control on the Flasher's PnL card.
- **"Empty pink banner" fixed**: it was the Emergency stop destructive
  button washing out under dark-mode `bg-destructive/60`. Now solid
  destructive fill, bold white label, glow, and a caption line.
- Vite `optimizeDeps.include` gains `@solana/web3.js` and `buffer` so the
  dev pre-bundle covers the new execution deps from the first cold start.

- **Seamless wallet sessions + the fastest honest submission path across
  every subsystem**: new `src/lib/wallet-session.ts` layer (7 unit tests) —
  silent reconnect (`eth_accounts` EVM, `connect({ onlyIfTrusted: true })`
  Phantom/Solflare/Backpack) restores the authorized signer after a reload
  with zero popup; one idempotent guard per provider fans
  accountsChanged/chainChanged/accountChanged/disconnect into a shared
  channel every surface subscribes to. BNB Wallets gained the session strip
  (live/reconnect-needed/chain-mismatch with one-tap `wallet_switch` repair),
  SOL Wallets re-persists silently restored signers, and both live Scanner
  hot paths now (a) fire gas+gasPrice+nonce as one parallel RPC burst that
  overlaps the eth_call simulation — the broadcast awaits ready numbers
  instead of three sequential round-trips — and (b) probe the wallet session
  (`eth_accounts`) right before injected broadcasts so a locked wallet is
  refused honestly, never dead-ending mid-flight. Telegram `/bnb_live` now
  states plainly that live broadcasts fire from the app's wallet session.
  No key handling changed — everything still signs inside the extension or
  the local hot wallet; nothing simulated was added.

- **The 24/7 experience verified end-to-end and completed where it fell
  short**: `EnginePulse` is now self-sufficient (own reactive queries, no
  TerminalProvider dependency) and also mounts in the FlashBolt Trade shell
  — scan ticks + arb stings now narrate on ALL three surfaces, and on the
  Trade shell (which has no NotificationsBell) the pulse narrates execution
  fills itself with the same sounds + honest toasts (success/revert/MEV-
  blocked/below-floor). Sniper passes stay intentionally silent (tactical
  fills surface via the ledger/bell and Telegram alerts, never tick noise).
  Fill toasts read the executions row's real fields (`status`,
  `amountBnb`, `chain`).

- **TAEngine chip upgraded to the exact state model**: 🟢 "TAEngine live · N
  chats" (token configured AND webhook registered — a webhook can only
  register with a valid token), 🟡 "Bot token off" (`tokenConfigured:
  false`), 🟡 "Bot offline" (token present, webhook dropped — the */10
  self-heal re-registers it). The chip's hover tooltip is now a styled
  popover with the full detail: webhook status, **self-heal checked
  timestamp** (every 10 min), linked chats, BOTH engine switches (BNB +
  SOL), and digest. The Telegram dialog's connected card now also shows the
  "Webhook: live · self-heal checked …" line from the same reactive data.
- **Scanner engines stay audible everywhere — no dull moment with the app
  closed**: new `EnginePulse` (mounted in both terminal shells) mirrors the
  open-scanner experience from the engines' own reactive stamps — the scan
  tick plays on every fresh server rescan of a chain's feed, and an
  arb-detection sting + toast fires when the rescan surfaces MORE live
  routes than the pass before. Chain-matched suppression keeps the page's
  own loop as the single sound driver on an open Scanner page (the OTHER
  chain's engine still narrates), everything respects the operator's sound
  setting, and per-chain opportunity counts (`bnbOpenOpportunities` /
  `solOpenOpportunities`) make the "more routes than last pass" signal
  honest rather than heuristic.

- **Sniper engines run server-side around the clock**: new `snipePass`
  internal action (mirroring the proven `scanPass` pattern — per-chain bot
  switch, own freshness stamps + lease, self-rescheduling every 20s,
  failure-safe reschedule, heartbeat recovery). The BNB sniper consumes the
  same multi-source discovery board as the browser monitor (copier signals +
  real DexScreener sweep) with the agent-ensemble gate; the SOL sniper
  consumes the same copier signals + market sweep as the SolSniper with the
  operator's liquidity floor. Paper fills record through the same ledger
  (`applyExecution`) with honest chain attribution; LIVE mode keeps
  discovering and alerting only (signing needs the browser wallet session).
- **Single-driver per subsystem, zero disruption**: the snipers are judged
  on their OWN stamps/lease (`bSn*` / `sSn*`) — a sniper loop never stands
  its scanner down and vice versa, and BNB never touches SOL. Shared 60s
  label dedupe + per-pass execution cap + daily target guard, exactly like
  the scan engines.
- **One switch drives both subsystems per chain**: `/bnb_on` `/bnb_off`
  `/sol_on` `/sol_off` (and the app's bot switches) gate the scanner AND the
  sniper of that chain; ON kicks both loops immediately, OFF stops both.
  The engine heartbeat now kicks all FOUR engines in parallel each minute.
- **Telegram bot stays self-healed 24/7**: webhook re-registration + pairing
  sweep every 10 min (existing) confirmed as the always-on path; the bot's
  start commands now engage both server engines per chain.
- **Server-safe sniper feed core** (`lib/sniper-feed.ts`): DexScreener sweep
  for both chains (fetchWithTimeout — no `AbortSignal.timeout`), board merge
  deduped by address (signals first), and the shared guarded snipe decision
  (liquidity floor → live price → 30-min freshness window → profit floor).
  Covered by 11 new unit tests.

## [Unreleased — feeds] Always-on live route feed rescans (BNB + SOL)

- **Automatic rescanning of both live route feeds**: the server engine now
  rescans the SOL FlashBolt feed, not only BNB. A new `engineHeartbeat`
  internal action (driven by the every-minute cron) kicks BOTH engines —
  `scanPass({chain:"bnb"})` and `scanPass({chain:"sol"})` — each with its own
  bot switch, freshness guard and lease, so the two loops stay independent
  and seamless: no double-driving, no cross-disruption, with the app closed.
- **SOL engine scan branch** (`runSolScanBody`): each pass pulls fresh copied
  signals, sweeps the live Solana market board (shared server-safe
  `lib/solana-feed.ts` core — `fetchWithTimeout`, no `AbortSignal.timeout`),
  merges both boards deduped by mint, builds real cross-venue WSOL routes
  with the exact engine the SOL Scanner consumes, and paper-executes through
  the same guard stack (daily target, profit floor, MEV shield, 60s dedupe),
  recorded with `chain:"solana"` / `nativeSymbol:"SOL"`. Nothing simulated.
- **Per-chain client stamps**: `bumpScan` gained a `chain` arg — the SOL
  terminal's browser loop now stamps the SOL engine's own freshness fields
  (`solLastScanAt`/`solLastScanSource`) and releases only the SOL lease. A
  tab sitting on the SOL terminal no longer stands down (or forks) the BNB
  loop, and vice versa.
- **Server execution attribution**: `serverAutoExecution` passes
  `chain`/`nativeSymbol` through to the ledger, so SOL engine rows attribute
  to the right terminal in the trail, PnL and Telegram alerts.

## [Unreleased — prior] Independent bots, direct Telegram open, settings page

- **Independent background bots**: the BNB and SOL bots now run on separate
  switches (`botRunning` / `solBotRunning`), separate engine leases and
  separate scan-freshness stamps. Starting or stopping one bot never touches
  the other — on Telegram (`/bnb_on /bnb_off /sol_on /sol_off`), in the app
  dialog (per-engine START/STOP rows) and on the server heartbeat that keeps
  them running with the app closed.
- **Account menu → Telegram Bot**: opens the TAEngine bot directly (mobile →
  the Telegram app via the t.me universal link; desktop → Web Telegram already
  on the bot chat). No popup window, no dialog, no error toasts; first-connect
  resolves the bot identity once, then redirects the same tab. Honest toast
  fallback only when the bot token is missing.
- **Operator Settings page** (`/terminal/settings`, both terminals, hidden
  from subscribers): mirrors the Freebuff dashboard's GitHub Sync workflow and
  deep-links to it; documents the private-repo + bidirectional-sync steps.
- **`AbortSignal.timeout` fix**: Convex V8 actions lack this API, so server
  fetches crashed with "TypeError: AbortSignal.timeout is not a function".
  All server/runtime fetches now use a runtime-safe `fetchWithTimeout`
  helper (modern API when present, AbortController fallback otherwise) —
  copier poller, news, whatsapp, market snapshot, RPC calls, Jito, swap
  executor, token discovery, Solana import.
- **Git sync helper**: `bun run git:sync` — pre-flight typecheck + tests,
  commit, push to every configured remote (origin/Render/…). Docs updated
  (DEPLOYMENT.md) with the GitHub Sync panel workflow; `.gitignore` extended
  (Vly local state, mirror-check scratch).

## [2.8.0] — Release-sync maintenance pass

- **Overlay version sync**: the BNB userscript/extensions previously stamped
  v2.0.0 and the SOL overlay v1.0.0 while the app itself is at 2.7.x — all
  artifacts now carry the app version. Added the missing `SOL_OVERLAY_VERSION`
  export and fixed both SOL manifests (MV3 + MV2) to consume it; BNB keeps
  `OVERLAY_VERSION`. No behavioral changes — versions only.
- **Repo hygiene**: removed the stray `probe-overlay.mts` scratch file from
  the project root (it referenced fake origins and was never imported).
- **Artifacts rebuilt** via `bun run overlay` — the static downloads in
  `public/overlay/` (userscript + Chrome MV3 + Firefox MV2 zips + install
  README) carry the current daily-target gate stamp and version.
- **Docs & deploy surface re-verified**: vercel.json / netlify.toml /
  render.yaml / public/_headers share the same real-file-aware SPA fallback,
  caching and security headers; README / DEPLOYMENT / Downloads page checked
  for stale references.

## [2.7.0] — SOL Flasher session stats + SOL scan sync

- **SOL Flasher stats strip** (paper + live): the Flasher page now carries the
  same five live cards as the BNB Flasher — **scans today · open routes ·
  PnL SOL · trades today · payouts SOL**. All values come from the persisted
  terminal state and the SOL execution trail (rows tagged `chain ===
  "solana"`); paper rows credit the exact amount, live rows are net of the
  real gas from receipts. Nothing is simulated or hard-coded.
- **SOL scan sync**: the SOL Scanner now pushes its real merged route count
  (market sweep + telecopier signals) into the terminal state on every scan
  tick — `scansToday` advances and `openOpportunities` tracks the live feed,
  exactly like the BNB Scanner already did. The "open routes" card and the
  SOL Overview "Open opportunities" metric now reflect the actual feed.
- **Deploy surface**: vercel.json / netlify.toml / render.yaml / public/_headers
  share one header policy (real-file-aware SPA fallback, `index.html` no-store,
  immutable assets, overlay caching, security headers); `.gitignore` keeps
  generated mirrors/packages out; overlay artifacts rebuild with the Convex
  gate origin stamped from `VITE_CONVEX_URL`.

## [2.6.0] — daily target limit (subscriber-only, 3/day)

- Server-enforced **3 executions/day** (flash + snipe combined, both
  terminals, UTC-midnight reset) for subscribers only. The **operator** and
  **Continue as Guest** are unlimited server-side and keep full control of
  their own terminal targets (1–∞, 0 = unlimited) in every local guard.
- Operator console per-subscriber decrease ▼ / increase ▲ / explicit set
  (0 = block) / reset-today controls; overlay userscript + browser extensions
  (BNB + SOL) enforce the same verdict server-side via hashed per-subscriber
  tokens before any quote/sim/broadcast.

## [2.1.0] — real-time Telegram session signals

- **New Signals page** (`/terminal/signals`): a live dashboard that mirrors
  exactly what the Telegram channel receives — market session update (Sydney /
  Tokyo / London / New York from the real UTC clock against the standard
  session windows, with overlap regimes and a live countdown to the next
  change), core network (mainnet/testnet split + chains scanned), AI market
  score and current operating metrics. The operator gets a **Send signal now**
  button (server-side operator verification, email never exposed).
- **AI market score**: 0–100 computed ONLY from live data — cross-DEX price
  dispersion, real route density + average edge (same route engine as the
  scanner), liquidity depth, 24h volume and the real BSC gas price from the
  RPC. Nothing is randomized or simulated.
- **Telegram delivery**: every 15 minutes (Convex cron, `crons.ts`) the engine
  computes the live dashboard and posts it to the configured Telegram channel
  (real Bot API). The first tick in a new primary session sends a `session
  open` alert; the rest are periodic `session updates` — signals are scoped to
  the specific durations of each session window. Each signal is stored in a
  new `telegramSignals` table with its real delivery status so the dashboard
  shows exactly what the channel received.
- **No disruption**: the existing trade/earnings alerts (`telegramTradeAlert`),
  `pingChannels` and the in-app notification center are untouched; the signals
  engine only adds a new channel feed alongside them.

## [2.0.0] — access gate, password auth, live passcode engine

- **New first page — Gate** (`/`): FlashBolt logo top-center, a terminal
  operator dashboard and a subscriber dashboard, the subscribe thumbnail
  (recreated from the uploaded artwork) with an active SUBSCRIBE NOW button,
  and the © Powered by SHCS footer. The landing page moved to `/home` and only
  opens after the operator or a subscriber passes the gate.
- **Terminal operator**: default email `shcsavvy@gmail.com` + passphrase stored
  ONLY in the backend, passphrase encrypted with AES-256-GCM (key from
  `GATE_ENC_KEY`, falling back to a SHA-256 of `JWT_PRIVATE_KEY`, then a
  generated server-side key). Reveal/change is gated by a one-time 6-digit
  code emailed to the stored operator address; Update re-encrypts.
- **Subscriber passcodes**: unique random `FB-XXXX-XXXX` codes generated
  server-side, one per email, 72-hour expiry, stored in the backend. The
  subscribe popup (full name, email, auto-detected location, subject dropdown
  "Request a passcode"/"Send a passcode", message, .png/.jpg/.jpeg upload)
  routes requests to the operator — "Send a passcode" requires a payment
  confirmation image and notifies the operator to confirm before release.
- **Operator console**: subscriber list with masked passcodes,
  block/unblock/change/update, and a trigger arrow that emails a passcode to
  that single subscriber; immutable audit log view with descriptions.
- **Auth page**: email + password login, registration with a strong password
  (≥8 chars, capital, number, symbol — enforced server-side and in the UI with
  a live strength meter), email OTP verification during registration, and
  Forgot Password / Reset / Sign up. Subscriber accounts are locked to the
  email used at subscription; "Continue as Guest" appears only for the
  terminal operator.
- **Live email**: `RESEND_API_KEY` (+ optional `RESEND_FROM`) powers
  transactional mail (codes, passcode notices, operator notifications);
  without it, code emails fall back to the Freebuff OTP relay and every send
  reports its channel honestly.

## [1.9.0] — ticket escalation, polished support chat, live AI verification

- **Escalate to a human** (Support chat): asking to talk to a person / agent
  now creates a real support ticket (`support_tickets` table) storing the
  actual conversation transcript, returns a human-readable reference
  (FB-XXXX), and pings the configured Telegram channel with the summary
  (honest in-app note when Telegram is not configured).
- **Polished chat transcript**: avatars per message, HH:MM timestamps, and a
  copy button on every message (with copied feedback) — clean on mobile and
  desktop.
- **Knowledge base**: new "talk to a human / create a ticket" intent topic;
  82 tests pass (256 assertions), including ticket-intent routing.

## [1.8.0] — AI-backed support, persisted chat history, bigger knowledge base

- **AI-backed answers** (Support chat): when the local knowledge base is not
  confident, the chatbot calls a real free AI model — Llama 3.3 70B on
  SambaNova Cloud — through a server-side Convex action
  (`chatWithAi`, OpenAI-compatible API, key in `SAMBANOVA_API_KEY`). The
  model's name and mark appear beneath the chat popup; without the key the
  assistant honestly stays knowledge-base-only and says so. Replies are real
  model responses, never canned scripts.
- **Persisted chat history** (Convex): support conversations are stored per
  user in a new `support_messages` table and reloaded on every visit, with a
  Clear chat action. Each message records its source (typed / greeting /
  knowledge base / AI / fallback).
- **Bigger knowledge base** (`src/lib/support-bot.ts`): new topics from the
  README runbook — running locally / deploying your own instance, all env
  vars & Keys-tab secrets, mirror zip packaging (package:mirror + release
  guard), versions & changelog, and how the AI channel works. 80 tests pass
  (253 assertions), including 5 new knowledge-base routing cases.

## [1.7.0] — support assistant, UTC world clock, top-bar redesign

- **Support assistant (free, built-in)**: the Account menu's Support entry
  opens a chat assistant trained on how FlashBolt actually works. It answers
  from a real knowledge base (`src/lib/support-bot.ts`) — scanning,
  flash loans, lenders & rotation, gas/private RPCs, deploy & verify,
  wallets, receipts, PnL, notifications, Telegram, chain switching,
  troubleshooting — with a deterministic matcher and an honest fallback.
  No API key, no cost, nothing simulated (unit-tested, 17 cases).
- **Account menu** (terminal top right, before the clock & date): shows the
  registered email address with a mail icon, the Support assistant, and Sign
  out — replacing the sidebar-only sign-out on mobile.
- **Multi-chain switcher** (top centre of the terminal): one button switches
  BNB / Ethereum / Arbitrum / Polygon from the header on every terminal page
  (and compactly in the mobile nav), mirroring the Scanner's persisted
  `setSettings({ chainKey })`.
- **World clock — 00:00:00 UTC format + offset dropdown** (all pages): time
  now renders `HH:MM:SS UTC` from the real device clock shifted into the
  chosen UTC offset, with a dropdown arrow next to UTC covering UTC-12 …
  UTC+14. The choice persists across pages; the date stays `MMM:DD:YYYY`
  beneath it.
- **Footer wording**: "© Powered by SHCS" — rewritten and bold/colorful on
  every page.
- **Responsive polish**: terminal top bar is a 3-zone grid on desktop and
  the mobile bar gains the account menu + chain switcher; content padding
  adapts on small screens.

## [1.6.0] — per-chain deployments, private RPCs, external alerts

- **Per-chain deployments** (Contract/Bot/Overview/Sidebar): every chain arms
  its own `FlashBoltArbitrage` deployment (`deployments[chainKey]`) with its
  own router. One-click deploy and the Arm button persist per chain; the
  live-mode gate, sidebar status and PnL pages all read the active chain's
  deployment instead of one global address.
- **Private RPC alongside public RPC** (Contract): each chain shows its
  verified public endpoint plus an optional private RPC override (validated
  http(s), must allow CORS). The override wins for live gas prices, receipt
  lookups and live execution — Scanner, Bot and History all resolve through
  the same `effectiveRpc()` helper; BNB testnet keeps its public endpoint.
- **External alert channel — Telegram** (notification center): a new
  `pingChannels` Convex action posts real execution + honey-spot alerts to
  Telegram via the Bot API when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
  are set in the Keys tab; without keys it honestly reports disabled and the
  in-app bell stays the only channel.
- **Per-chain DEX whitelists** (Strategy): each chain keeps its own AMM
  whitelist (`dexWhitelists[chainKey]`) — Ethereum, Arbitrum and Polygon
  whitelists are now editable, not read-only. Legacy BNB whitelist is
  preserved as the fallback.
- Overview price card follows the active chain's real CoinGecko id
  (binancecoin / ethereum / matic-network) instead of always BNB.
- Unit tests: 54 tests / 147 assertions (chain registry, effective RPC
  override/fallback, real chain ids, quote tokens, routers).

## [1.5.0] — multi-chain scanner, notification center, verify & publish

- **Multi-chain scanner** (Scanner/Bot/Strategy/Contract): live triangular
  arbitrage now scans BNB Chain, Ethereum, Arbitrum and Polygon with the same
  real-data pipeline. Each chain uses its own verified DexScreener dex ids
  (Uniswap V2 pairs report `uniswap`, plus sushiswap/camelot/quickswap/
  apeswap), its real quote token (WBNB/WETH/WMATIC), CORS-open public RPCs
  for live gas prices, its official Router02, and a chain-scoped flash-loan
  lender set (Venus and PancakeSwap are BNB-only — never claimed elsewhere).
  Chain choice persists per account; BNB keeps its mainnet/testnet switch.
- **Notification center** (all terminal pages): a bell with an unread badge
  pings instantly when the bot executes (success / MEV-blocked / below floor
  / revert) or when a new honey-spot route appears — real events persisted
  to Convex, never fabricated. Mark-all-read included.
- **Verify & Publish** (Contract): after a one-click deploy, the flattened
  contract source (real import-inlining of the fetched OpenZeppelin/Uniswap
  files, single pragma + SPDX) is submitted to the real BscScan API
  (`BSCSCAN_API_KEY` from the Keys tab) with the encoded constructor
  argument; without a key the UI hands over the flattened source for the
  manual wizard instead of pretending. Other chains link their own explorer
  wizard.
- Execution layer generalized to any Uniswap-V2-style chain (wallet chain
  switching, deploy, receipt gas math are all chain-descriptor driven).
- Unit tests: 49 tests / 119 assertions (source flattener, deploy payload,
  gas math, chain registry, route engine).

## [1.4.0] — one-click deploy, real PnL analytics, on-chain receipts

- **One-click deploy** (Contract): after Auto compile succeeds, a Deploy button
  broadcasts the real solc creation bytecode + encoded Router02 constructor
  argument through the connected wallet (EIP-1193 `eth_sendTransaction`),
  polls `eth_getTransactionReceipt` for the deployed address, auto-arms the
  terminal for live execution and links the new contract on the explorer.
  Rejections (code 4001) and on-chain reverts are reported honestly.
- **Real PnL analytics** (Overview): profit/loss is now computed from the
  actual persisted execution trail — paper profits net of the documented
  flash-loan fee, on-chain trades also net of the **real gas paid** (read
  from each transaction's receipt via `eth_getTransactionByHash`). New
  cards: Net PnL, On-chain PnL, Paper PnL, Win rate and Best trade; the
  cumulative chart series uses the same net-of-gas values.
- **Receipts in History**: every on-chain execution now shows its real
  receipt fetched straight from the BNB RPC — Confirmed / Reverted / Pending
  status, block number, gas used in BNB, full tx hash with copy, and the
  BscScan link. Capped-concurrency fetching, one probe per hash per session.
- Unit tests: 39 tests / 102 assertions (deploy-payload concatenation, real
  gas math from receipt hex values, revert gas accounting).

## [1.3.0] — lender balancer, honey-spot scanner, auto-compile, world clock

- **Lender balancer v** (Strategy): prioritizes flash-loan lenders with the
  lowest documented fees before high-fee ones — Aave V3 0.05%, Venus 0.09%,
  Radiant 0.09%, dForce 0.05–0.09%, PancakeSwap V2 0.25% (all sourced from
  each protocol's official docs). The rotation follows a fee-priority queue
  with the cheapest lender weighted first; persists per account.
- **Honey-spot scanner** (Scanner): a live filter that surfaces only genuinely
  high-profit routes with real high liquidity (≥0.5% net edge and ≥$250k
  liquidity), with live counts on the feed header.
- **Auto compile** (Contract): a real solc 0.8.20 build runs in a Web Worker
  (downloaded from binaries.soliditylang.org) and compiles
  FlashBoltArbitrage.sol against real OpenZeppelin 5.1.0 + Uniswap v2
  sources — genuine bytecode size, ABI functions and real compiler errors.
  Contract source imports fixed to match (ReentrancyGuard path + IERC20).
- **Profit guard** (Bot/Scanner): the bot only ever executes arbitrage that
  stays profitable after the documented flash-loan fee and configured
  slippage — net ≤ 0 routes are refused in paper AND live mode.
- **World clock** (all pages): real-time 00:00:00 HH:MM:SS with the date as
  AUG:09:2026 beneath it, top-right of every page.
- Footer wording updated to **© Power by SHCS** — bold and colorfully visible
  on every page.
- **Live gas-cost estimator**: the real BNB RPC gas price (`eth_gasPrice`)
  is polled per network and subtracted from every route's net profit (BNB gas
  cost + net-after-gas shown per route); the always-on profit guard now also
  refuses routes that gas makes unprofitable.
- **Compile artifacts**: the auto-compiler now also produces the real
  keccak-256 bytecode hash and the ABI-encoded Router02 constructor args
  (copyable), so the exact deploy payload is at hand.
- **Honey-spot feed on the landing page**: a dedicated amber section surfaces
  only high-profit + high-liquidity routes with an honest empty state.
- Unit tests: 32 tests / 91 assertions (gas math, keccak/ABI vectors,
  balancer queue, documented fees, profit guard, honey-spot filter).

## [1.2.0] — release guard, deploy helper, unit tests

- New `scripts/check-mirror-sync.sh` release guard: fails the build when the
  mirror drifts from the live source (`bun run check:mirror`; `package:mirror`
  now runs it automatically after every package).
- Contract page "Deploy helper": one-click copy of the Router02 constructor
  argument and Hardhat compile / deploy / verify commands, plus a direct
  testnet faucet link (mainnet shows an honest "real BNB required" note).
- Unit tests (`bun test`, 20 tests): calldata encoding round-trips,
  amountOutMin arithmetic, address/network helpers, lender rotation, MEV risk
  tiers, profit math, route-path resolution and cross-DEX triangle detection —
  real fixtures and real assertions, no mocks.
- Honest WBNB fallback: the feed no longer substitutes a hardcoded $592 spot
  price when DexScreener reports no WBNB pairs (0 ⇒ no routes until real
  data arrives).

## [1.1.1] — anti-fabrication + testnet runbook

- Removed the simulated wallet fallback — connecting now requires a real
  EIP-1193 extension and errors honestly when one is missing.
- Zeroed fabricated account seeds (`lifetimePnl`, `scansToday`,
  `openOpportunities`); only the paper starting capital remains.
- Overview no longer fabricates a PnL curve — flat zero baseline until real
  executions exist; BNB price shows "—" until the live CoinGecko spot lands.
- Added the testnet deploy runbook to the README.
- Mirror repackaged as `mirror-v1.1.1.zip`.

## [1.1.0] — real live-mode execution

- viem calldata builder + EIP-1193 wallet transactions with receipt polling;
  success / reverted (Failed) statuses and explorer-linked tx hashes in
  History.
- Deployed-contract arming on the Contract page, mainnet/testnet Router02
  defaults, version-stamped UI.
- Simulation-free feeds: flash-loan lender rotates per run, prices come live
  from DexScreener, no fabricated counters. Theme-aware 404 page.

## [1.0.0] — baseline

- Full FlashBolt terminal: paper + live modes, auto-payout on every execution,
  mainnet/testnet switch, dark/light theme, © Powered by SHCS footer on every
  page.
