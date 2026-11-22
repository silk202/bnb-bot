# Follow-ups

Brainstormed after the Sites publish and the wallet incident. Nothing here is
started; each item lists why it matters and the smallest useful version.

---

## A. From the earlier thread (Sites publish / Convex migration)

1. **Find out why the Publish button aborts at "installing Wrangler".**
   The log shows `bun add wrangler` succeeding and the pipeline dying immediately
   after, so the fault is in the pipeline's post-install verification, not the
   dependency. Smallest version: keep deploying via `sites_deploy` and report the
   log tail upstream; the button is unusable until that step is fixed.
2. **Automate the publish instead of clicking it.** A `bun run sites:publish` that
   rebuilds, stages `sites-assets` (dist minus `_redirects`), and calls the deploy
   manifest would remove the manual `cp -a` + `rm _redirects` step entirely.
3. **Guard the overlay stamp in CI.** Task 3 regressed because a *preview* build
   ran the overlay step with the dev origin. A one-line check in the existing
   `verify-release` flow (`grep` the prod origin in `public/overlay`) would have
   caught it before commit.
4. **Fix `.env.local` at the source.** `VITE_CONVEX_URL` has come back quoted and
   space-prefixed four times, and `JWT_PRIVATE_KEY` has been overwritten with the
   unarmored variant once (which silently breaks operator decryption). Both are
   project-secret values; storing them cleanly ends the whole repair loop.
5. **Redeploy the preview with prod-stamped artifacts.** The published preview's
   `/downloads` zips were built while dev-stamped; they point at the dev gate.
6. **Decide about production.** The production environment has never been
   published (it returns 404 by design). Publishing it is a separate decision with
   its own origin and secrets.
7. **Sites storage/auth are unused.** The site is static and its data lives in
   Convex, so D1/R2 and Sign in with Freebuff are not wired. Worth revisiting only
   if server-side state or accounts are ever needed.

## B. From the wallet incident

1. **Run the new audit on every other wallet.** `bun run audit:wallet 0x…` for each
   address from the vault, the sniper hot wallet, the extensions and any external
   wallet — the app stores no addresses, so enumeration is manual.
2. **Make the app refuse to sign with an exposed wallet.** Before a live trade, call
   the audit's approval check and block execution on a drainable unlimited
   allowance; a warning banner is the cheap version.
3. **Default `autoPayout` to off.** It currently defaults to on with a blank
   address, so the first person who fills the field starts sweeping profits to
   whatever they typed — and a typo sends funds to a stranger.
4. **Add a "payout address confirmed" step.** Require the address to be re-typed or
   confirmed from a checksum display before it can be saved.
5. **Ship a post-trade balance monitor.** A cron (or the existing retention sweep)
   that compares the connected wallet's native balance between sessions and raises
   a notification on an unexplained drop would have surfaced the Oct 2025 sweeps a
   year before the report.
6. **Log wallet-risk findings into the operator console.** The audit output is
   already JSON (`--json`); writing a row per run gives the operator a history of
   what was audited and when.
7. **Honeypot pre-check before any live buy.** The COAI finding came from
   simulating `transferFrom`; the same simulation on a candidate token before
   buying would stop the app buying a token nobody can sell.
8. **Document the recovery reality once.** A short page stating that a confirmed
   transfer to an EOA is irreversible, that CEX support is the only soft path, and
   that every "recovery service" asking for a seed is a scam.

## Brainstorm — candidates, not scheduled

Ordered by what would have caught the failures we actually hit. None of these
are committed work; they are recorded so the reasoning survives the session.

1. **Make the guard's own baseline file generic.** `.task-baseline` today holds
   the protected deployment's build stamp. Recording the published preview's
   HTML hash and the overlay zip hash the same way would turn "someone rebuilt
   the artifacts" and "someone redeployed the preview" into an explicit,
   reviewable event instead of an unexplained diff.
2. **Fix the secret at its source.** The `VITE_CONVEX_URL` regression is now
   harmless (the client sanitizes it, the guard normalizes it), but the clean
   value still belongs in Settings → Secrets without quotes. Until then every
   fresh workspace starts one repair behind.
3. **Ship a non-mutating `gate:operatorConfigured` query** reporting whether the
   operator row has an email source and a passphrase ciphertext. Login coverage
   would then be a pure read — no rate-limit slots, no credentials in env.
4. **Run the guard on a schedule.** Twice now the drift was caught only because
   a human asked. A daily CI job on `bun run check:tasks` would surface it with
   the timestamp of the change rather than the discovery.
5. **Extend parity past users.** Subscribers, licences and gate config are the
   rows an operator notices; comparing their counts across dev/prod would catch
   a restore-from-backup that the user counts miss.
6. **Assert the deploy-key identity, not just acceptance.** `convex export`
   exiting 0 proves a key works; printing the deployment name the key resolves
   to would prove it is the *intended* one, which is the failure DEPLOYMENT.md
   warns about.
7. **Alert on new allowances with executable spenders.** The JERRY allowance was
   found by hand. Watching `Approval` events for allowances above a threshold,
   then simulating `transferFrom` in the same run, turns the audit into a
   monitor.
8. **Refuse to trade a token that fails its own sell simulation.** The COAI
   honey-pot was only visible by simulating the outbound direction; the same
   check before a live buy is a cheap guard rail.
9. **Add a recovery-reality page to the app.** One screen stating that a
   confirmed transfer is irreversible and that any "recovery service" asking for
   a seed phrase is a scam — the highest-value thing that can be shipped after
   the fact.
10. **Pin the audit to each incident report.** Attach the `--json` output of
    `bun run audit:wallet` alongside the report so a reader can re-run and diff
    the exact state the conclusions came from.

## Brainstorm — round 2 (after the guard work)

1. **Move the operator sign-in probe behind a stored last-verified stamp.**
   It spends one of the deployment's five login slots per run. Recording
   "verified at <time> against config revision <hash>" and skipping inside the
   window would keep the guarantee without eating the budget.
2. **Fingerprint the operatorConfig row, not only its count.** A passphrase or
   email change would show up as a hash change the same way the protected
   deployment's build stamp does — no plaintext needed.
3. **Give `check:tasks` a `--json` mode.** The verdicts are already discrete;
   structured output would let CI annotate rather than grep a log.
4. **Assert the guard's own coverage.** A run that silently skips three checks
   (no curl, SKIP_LOGIN, SKIP_PREVIEW) currently looks green. Emit a count of
   checks skipped and fail above a threshold.
5. **Feed the login probe's result into the audit log.** The app already writes
   an audit row per operator sign-in; tagging probe sign-ins makes them
   distinguishable from a human's on the console.
6. **Decide what GATE_ENC_KEY should be.** The probe derives its key from the
   armored JWT because no `GATE_ENC_KEY` is set. Setting one is stronger but
   rotates unreadable ciphertext — worth a written decision rather than default.
7. **Test one failure path for real.** 7b has never been seen to fail. A
   throwaway deployment (or a temporary collection during a drill) would prove
   the detection works before it is trusted.
8. **Retire the `check-4-tasks.sh` name.** It now runs seven checks plus a live
   sign-in; the filename is the last piece of stale documentation.

## Round 3 — the wallet guard's remaining surface

1. **Port the payout rule into the overlay generators.** `src/lib/overlay-script.ts`
   and `sol-overlay-script.ts` still accept a free-text `payoutAddress`, and the
   committed bundles ship it. They must pay the live connected account and drop
   the field, then `bun run overlay` must regenerate the artifacts (stamped with
   the production `.convex.site` origin) or the fix exists only in source.
2. **Wire the detectors that produce the findings.** `wallet-guard.ts` decides
   correctly, but today only the payout-target rule feeds it. Approval
   enumeration (bounded history scan), per-session outflow baselines and
   post-trade sell simulation belong behind `RiskFinding[]` so the override
   policy actually bites on drains.
3. **Persist blocks and overrides server-side.** A blocked payout is currently a
   toast plus a local log line. Writing it to `executions`/`auditLogs` makes the
   override reason reviewable later instead of trusted at the moment.
4. **Show live findings on the Wallets page.** One banner per wallet: approvals
   it has outstanding, tokens it cannot sell, outflows it does not explain.
5. **Refuse injected-deployed contracts at arming time.** The flasher refuses
   them at execution; the Contract page should refuse to arm them in the first
   place so the failure is not discovered mid-trade.

## Round 4 — what the fail-closed policy still lacks

1. **Approval monitoring is still not a loop.** `wallet-guard.ts` grades a
   `drainable-approval` correctly, but nothing enumerates allowances on a
   schedule, so that finding is only produced by `bun run audit:wallet`. A
   bounded watcher (recent `Approval` logs + known spenders) that writes findings
   the guard consumes is the missing half.
2. **No way to resume after a trip.** `resetBreaker()` exists; nothing in the UI
   calls it. A tripped breaker currently needs a developer. It should be an
   operator action that itself writes an audit row.
3. **Chain validation covers payouts only.** `chainConfigVerdict` is wired into
   the payout path; the flasher should assert it too, independently of
   `BNB_NETWORKS`, so a mainnet/testnet mix-up cannot reach `execute()`.
4. **Simulation validity has no explicit window.** Transfers simulate immediately
   before broadcast, which is the right order, but nothing records how stale that
   simulation is. Stamping simulated-at and refusing to sign when the RPC head
   moved would make the guarantee testable.
5. **Removing the injected signer needs a UI answer.** With external wallets
   receive-only, a user whose only wallet is MetaMask now has no signer at all.
   That is the intended policy, but the terminal should say so up front instead
   of failing at the first trade.
6. **The overlay bundles are still outside this policy** (see round 3, item 1).

## Round 5 — after wiring the detectors

1. **The approval scan is a window, not a history.** Public BSC nodes cap
   `eth_getLogs` at 25–50 blocks, so 16 chunks covers ~800 blocks (~40 min).
   An approval granted last week is invisible to it. The durable fix is an index
   (a Convex table fed by a cron, or a paid archive RPC), not a wider loop.
2. **The outflow baseline ignores trade spending.** It is seeded per day and
   compared only against recorded payouts, so buys look like outflow. Today a
   small shortfall is graded medium and a large one high; the honest fix is to
   record every spend that leaves the operational wallet, not just payouts.
3. **Nothing persists guard decisions server-side yet.** The audit line is
   written to the local log. A blocked payout should also be an `executions` row
   with wallet, spender, token, allowance and reason, so the trail survives the
   browser.
4. **A tripped breaker should survive a reload.** It is in localStorage, which
   an attacker (or clearing site data) removes. Mirror it into the deployment.
5. **Known-spender list is one router.** `CHAIN_INFO[chain].router` only. V3
   routers, the flasher contract and the vault itself should be recognised, and
   the list should be operator-editable with an audit entry per addition.
6. **No review UI for findings.** The operator sees a toast. A table of live
   findings per wallet — spender, token, allowance, first seen — is what makes an
   investigation possible in under a minute.
7. **Simulation validity is still untracked** (round 4, item 4) and the overlay
   bundles are still outside the policy (round 3, item 1).

## Round 6 — after live-testing the detectors on BSC

1. **Testnet cannot scan logs at all with the configured RPCs.** publicnode
   answers `eth_getLogs` with "Please specify an address"; drpc free returns 408.
   The allowance probe covers the traded token, but unknown spenders stay
   invisible on testnet. A `BSCSCAN_API_KEY` (already an optional env var) or a
   paid node is the fix — until then, say so rather than implying parity.
2. **Mainnet log scanning is opportunistic, not reliable.** `limit exceeded`
   appeared on a 20-block window minutes after 6 windows succeeded. The probe
   now always runs alongside it; the log scan only adds unknown-spender coverage
   when the node cooperates.
3. **Approvals older than the window are invisible.** The verifiable case: the
   incident wallet's 6 approvals are days old, so the log scan sees none of them
   while the probe finds all 6. Historical approvals need an index, not a window.
4. **The five-minute cache ignores the trusted-spender set.** Switching networks
   or arming a new contract leaves the old grading in place for up to 5 minutes.
5. **A blocked payout has no dedicated fields.** It rides in `executions` with
   `status: "blocked"` and the context packed into `label`/`dexes`. A small
   `payoutBlocks` table (wallet, token, spender, allowance, reason, level) would
   make the trail queryable — that needs a schema change and a deploy.
6. **No testnet drill exercises the guard.** A testnet approval to a throwaway
   spender would prove the probe blocks for real, on 97 as well as 56.
7. **Findings are per-payout, not per-wallet.** Every profitable sell re-reports
   the same standing approval; an operator needs one line per finding with a
   first-seen time.

## Round 7 — 2026-11-16

1. **Queryable block rows are still not a table.** Blocked payouts are written to
   `executions` with `status:"blocked"`, so they are queryable through the
   existing executions trail, but there is no dedicated `payoutBlocks` table
   (wallet, destination, token, spender, allowance, level, reason). Adding one is
   a schema change and therefore a backend deploy — it was not done without a
   deploy window. No data is lost meanwhile.
2. **History discovery needs an archive RPC.** `eth_getTransactionCount` at a
   historical block is an archive query. publicnode rejects it ("Archive
   requests require a personal token") and pruned nodes silently answer with
   *current* state. The scan now verifies block-0 state first and reports
   "unverified" instead of "no approvals"; wire `VITE_ARCHIVE_RPC_URL` (BSC:
   `https://bsc-mainnet.public.blastapi.io`, confirmed archive) to get real
   coverage. Measured on the incident wallet: 17 txs, 6 approvals, 4 HIGH, ~9s
   cold, cached 10 min.
3. **Network registry is defined, but execution is off everywhere except BSC
   mainnet.** Ethereum, Arbitrum and Polygon (and every testnet) need validated
   executors, routers, factories and token registries before `executionReady`
   flips. The registry deliberately has no venue data for them — inventing
   router addresses would be mocking.
4. **The registry and RPC manager are not yet wired into the terminal UI.** The
   mainnet/testnet switch and provider health panel still read `chains.ts`.
   Wiring is UI work with no new risk, and is the next step.
5. **`eth_getLogs` remains disabled on BSC public endpoints**, so mainnet log
   scanning depends on a provider that supports it; the manager probes and marks
   `supportsLogs` per endpoint rather than assuming it.
6. **Testnet guard drill still not executed** — it needs funded tBNB and a
   testnet venue, neither of which exists yet (see 3).
7. **Pre-existing test failure:** `utc-clock > readStoredOffset falls back to 0
   with no stored value` fails in this environment (no localStorage). Unrelated
   to the wallet work; noted rather than fixed.

## Round 8 — 2026-11-16

1. **`payoutBlocks` is deployed to both deployments.** Dev
   (`pastel-pelican-634`) then prod (`flexible-frog-776`); each push reported
   "No indexes are deleted" and added `by_user_ts` / `by_wallet_ts`. Rows are
   written from the Sniper payout path alongside the execution record, with
   wallet, destination, level, finding kinds, reason, amount, chain and network
   as separate fields. Token/spender are populated when the finding carries
   them (approval findings now do).
2. **Backend allowlist is enforced at the single URL read path.** `shiny-bulldog-311`
   is rejected inside `resolveConvexUrl`, so the Convex client, the HTTP-actions
   origin and every metrics endpoint behave as "not configured" rather than
   pointing there. Settings shows the real target (`dev`/`prod`) from the same
   read.
3. **Network switch is now verified, not assumed.** `handleNetworkSwitch` runs a
   registry-backed `RpcManager.healthCheck()` and refuses the switch unless at
   least one endpoint reports the expected chain id; the toast reports how many
   endpoints verified. The BSC-only switch is unchanged otherwise.
4. **The switch is still BSC-first.** Registry entries exist for all four
   chains on both networks, but only BSC has validated testnet venues; the other
   networks stay execution-disabled (`executionReady:false`) rather than trading
   on invented addresses.
5. **Provider health is not surfaced as a panel yet.** Health checks run on
   switch; a latency/probe table in the terminal would be the next step.
6. **The published preview bundle still needs a rebuild** to pick up this
   commit — until then an old tab keeps showing the login skew message.

## Round 9 — 2026-11-16

1. **Readiness framework landed** under `src/chains/`: registry, RPC registry,
   deployment provenance, activation policy, four validators, readiness engine,
   execution gate, simulator, circuit breaker and execution manager. 23 tests
   cover the ladder, the gate and the activation rules; the full suite is 527
   passing.
2. **Live report tool**: `bun run check:readiness [network…]` runs the real
   validators. Measured: BNB 3/4 endpoints verified (head spread 5), BSC Testnet
   2/3, Ethereum 3/3, Base 2/2 — all at `RPC_VERIFIED`, execution OFF. No
   fixture data is involved.
3. **Nothing can execute.** The gate refuses for a reason that cannot be
   configured away: `NetworkConfig.execution.enabled` is the literal `false`, so
   even a valid production activation record leaves the decision denied. Wiring
   an activation path is deliberately undone work.
4. **Flash-loan lenders are names, not addresses.** `CHAIN_INFO.lenders` holds
   "Aave V3", "Venus", … — recording those as addresses would have been
   fabrication, so manifests carry no lender until a real pool address is
   verified. The terminology check caught this during test authoring.
5. **No executor manifests exist.** Executors are deployed per operator through
   the Contract page; there is no runtime code hash, deployment tx or block
   recorded anywhere, so the executor check stays `pending` everywhere. That is
   why no network can pass CONTRACTS_VERIFIED yet.
6. **Base and Optimism are registered only.** Chain ids, currencies, explorers
   and public RPCs are real; there is no validated DEX deployment, so their
   manifests are `unavailable` and they can never be activated.
7. **Solidity parity is not addressed here.** This repository contains no
   `.sol` sources (checked), so "same production Solidity on testnet" cannot be
   satisfied from this tree — it needs the contract sources, deployment scripts
   and manifests that the executor lives in.
8. **Fork tests and native testnet integration tests are not written.** They
   require funded testnet keys and a deployed executor, neither of which exists
   in this environment.

## Round 10 — 2026-11-16

1. **Base RPC secrets are not present in this workspace or on the site.**
   `env` and `.env.local` expose only `BSC_MAINNET_RPC_URL`,
   `BSC_TESTNET_RPC_URL`, `WEBSOCKET_MAINNET_URL`, `WEBSOCKET_TESTNET_URL`, and
   the deployed site has zero variables/bindings. So no Base endpoint value was
   available to wire — the app keeps its two verified public Base endpoints
   rather than inventing one.
2. **The plumbing is now in place for those secrets.** `rpc-registry.ts` reads
   `window.__FLASHBOLT_RPC__`, build-time `VITE_RPC_<KEY>` / `VITE_<ALIAS>`, then
   public endpoints. `sites/worker.js` forwards plain project-settings names
   (`BASE_MAINNET_RPC_URL`, `BASE_TESTNET_RPC_URL`, `BSC_*`, `WEBSOCKET_*`, …)
   to the page as a JSON data block, so adding a secret and reloading is enough
   — no rebuild. Values are validated as http(s)/ws(s) and ignored if malformed.
3. **Execution gate is now enforced** in the Sniper payout, the Sniper
   withdrawal and the Scanner live-arbitrage path. Consequence, stated plainly:
   live execution is refused on every network (readiness `REGISTERED`,
   `executionEnabled: false`, registry flag literal `false`). Paper mode is
   unaffected because it signs nothing. Refusals are recorded as
   `payoutBlocks` rows with kind `execution-gate`.
4. **Switch is bounded**: at most 3 endpoints, 3.5s per call, 4s hard ceiling,
   log probing skipped. A slow provider now yields a retryable refusal in ~4s.
5. **Deterministic broadcast rejections are no longer retried** across
   providers (`insufficient funds`, `nonce too low`, `execution reverted`, …).
6. **Preview rebuilt and deployed** (`site-09ea…`, commit-time build): HTTP 200
   HTML, JS asset 200, bundle carries the production slug and the
   forbidden-deployment list; the only `shiny` string is that blocklist entry.
7. **Activation remains unimplemented by design.** There is no persisted
   readiness report and no backend activation record endpoint, so nothing can
   reach ACTIVE — the gate refuses by construction. Building that path is the
   next real step, not a UI toggle.

## Round 11 — 2026-11-16

1. **Base/Optimism endpoints are discoverable but still unset here.** No
   `BASE_*`/Optimism values exist in this workspace or on the site, so the
   mechanism was proven with real public endpoints instead: a simulated chained
   BSC variable yielded chains 56, 97, 8453, 84532, 10 and 11155420, and the
   report validated Base, Optimism and both testnets at `RPC_VERIFIED`, 2/2
   endpoints each. Once the secrets reach the site, the same path picks them up
   on the next page load.
2. **Live execution is unblocked only on BSC.** The gate policy clears `bsc`
   explicitly; Base/Optimism/Ethereum/Arbitrum/Polygon remain refused for live
   signing with the reason recorded. The wallet guard still governs the cleared
   path.
3. **`LIVE_CLEARED_CHAINS` is hand-maintained.** It should be replaced by
   activation records the moment a real readiness report is persisted; until
   then two places (this list and `executionReady`) encode the same fact.
4. **Discovery cost.** Each configured URL costs one `eth_chainId` probe, cached
   5 minutes and batched 6 at a time. With many endpoints that is still a burst
   on public nodes; persisting the mapping per session is the next step.
5. **The deployed site must be redeployed** for the worker's env forwarding and
   the gate fix to be live.
6. **Activation backend still absent.** Nothing in the app can produce an
   activation record, so the framework gate stays closed for every network.

## Round 12 — 2026-11-16

1. **Evidence-based clearance is not activation.** With the allowlist removed,
   `armed executor` is what clears live signing, so arming on a new chain enables
   that chain before validation/activation. The fix is to require BOTH an armed
   executor AND a valid activation record; the record has no backend endpoint yet.
2. **Payouts and withdrawals now require an armed contract** on the chain (the
   gate uses it as the clearance evidence). If the operator pays out before
   arming, the gate refuses with "No executor is armed" — that is intended, but
   it is a behaviour change worth watching on a live BSC wallet.
3. **`isBscChain()` still treats `undefined` as BSC.** Correct for display and
   for the mainnet/testnet switch, dangerous anywhere else; 49 call sites were
   not audited one by one.
4. **Provider independence is approximate** for discovered endpoints: they are
   labelled by hostname, so two hostnames from one operator count as two.
5. **Diagnostics is not in the UI.** `bun run check:rpc [--json]` covers the CLI;
   a Settings panel reading the same module is the natural next step.
6. **`bsc.drpc.org` answered 429 during diagnostics.** No retry/backoff is
   applied by the diagnostics tool itself (by design, it reports rather than
   fixes); the RPC manager handles production backoff.
7. **Discovery results are still per-session.** Nothing persists the
   chain-id→endpoint mapping, so each page load re-probes.

## Round 13 — 2026-11-16

1. **Payouts to connected wallets are now refused.** Under the requested policy
   those are external withdrawals. The payout card still offers connected
   wallets as destinations; it will refuse them with "External withdrawals are
   disabled" until a separate, explicitly approved withdrawal mechanism exists.
   The UI should eventually stop offering them at all.
2. **Internal payouts cannot be initiated from this app.** An internal payout is
   executor → designated vault, executed by the contract during arbitrage. The
   terminal cannot call it, so the only destination that passes
   `authorizeInternalPayout` is the vault address itself (a self-transfer).
3. **The BSC activation record is a hand-written policy record**, referencing the
   incident report as evidence. It is not derived from validation results; the
   readiness engine still reports `RPC_VERIFIED` at best. Move activations into a
   backend table with operator identity and audit entries.
4. **Activation has no expiry or review enforcement.** `reviewAfter` exists but
   nothing suspends a chain when it passes; the readiness engine's SUSPENDED
   state is not wired to activation.
5. **Discovery persistence is per-browser**, so a fresh profile re-probes; and it
   trusts `localStorage` for endpoints (URLs are re-validated, but a tampered
   entry could point at a hostile node — chain-id + head checks catch a wrong
   chain, not a lying fork).
6. **Diagnostics panel is unverified visually** — it typechecks and reuses the
   CLI module that was run live, but the panel itself was never rendered.

---

## G. Implemented 2026-11-17 — activation moved to the backend

Done in this pass (see `src/convex/chainActivations.ts`, `src/chains/registry/activations.ts`):

1. **Activation records live in Convex**, not in the frontend bundle. Three tables:
   `chainActivations` (the approval), `chainValidationSnapshots` (technical
   evidence) and `chainActivationAudit` (append-only history). The embedded BSC
   constant is gone; a build cannot report a chain as activated by itself.
2. **Only an operator can write them.** Every mutation calls `requireOperator`
   (the same server-side identity check the operator console uses). A
   subscriber, a browser, `localStorage` or a frontend build cannot create,
   extend or revive an activation.
3. **Expiry and revocation are enforced at read time.** An ACTIVE row past
   `expiresAt` is reported as EXPIRED; SUSPENDED and REVOKED refuse immediately.
   Terms are capped at 180 days, and approval supersedes any other live row for
   the chain.
4. **The gate fails closed.** The store hydrates from the backend query; until
   it answers, every chain is "not loaded" and live signing is refused. A
   refused or offline query can only withhold permission, never grant it.
5. **Approvals can be pinned to a contract.** When a record carries
   `contractAddress`, arming a different executor is refused — arming alone no
   longer covers a different deployment.
6. **Browser discovery is a cache only.** Persisted endpoint→chain mappings are
   re-proved with `eth_chainId` before use; unproven entries are dropped and the
   app falls back to a full probe. Nothing about contracts or approvals is read
   from browser storage.
7. **The payout card labels destinations**: internal payout (vault, needs armed
   executor + activation) vs external withdrawal (disabled), instead of
   implying the connected wallet is a payout destination.

Seeded record: chain 56 / mainnet, ACTIVE until 2027-02-15, created by
`bootstrapBscActivation` (internal-only, one-shot). Its validation snapshot
records what could NOT be verified: executor bytecode hash, router/factory
addresses, flash-loan callback review, live simulation. The record is therefore
address-unpinned and explicitly provisional.

### Still open after this pass

- **No operator UI for the lifecycle.** Create/approve/renew/suspend/revoke
  exist as mutations; the dashboard or a Settings page must call them. Until
  then an operator needs `convex run` or the dashboard.
- **BSC renewal is manual.** The 90-day term expires 2027-02-15 and nothing
  renews it; on expiry live signing on BSC stops (by design).
- **Executor bytecode is still unpinned.** Without Solidity sources or the
  deployment tx, `contractCodeHash` cannot be filled; the approval therefore
  covers "whatever is armed on BSC 56". Filling this is the highest-value
  remaining hardening step.
- **No external withdrawal mechanism** (unchanged, intentional).
- **No operator-initiated payout workflow** (unchanged, intentional).

---

## H. Implemented 2026-11-17 — discovery registry, operator console, bytecode pin

1. **Dynamic import fixed.** Two operator-only queries in `chainActivations.ts`
   used `await import("./operatorEmails")`. Convex resolves imports when the
   function is pushed, so that call would fail at runtime with "Cannot find
   module" even though the module existed. Both now use one statically imported
   `isOperatorQuery()` helper.
2. **Operator UI.** `ActivationConsole` (Settings) lists activations with
   effective status/expiry/pin state and exposes request → approve →
   suspend/revoke → pin bytecode, plus RPC validation and address registration/
   validation/revocation. All actions are operator-gated backend mutations; the
   panel cannot activate anything locally.
3. **Bytecode pinning.** `bytecode-pin.ts` reads `eth_getCode(executor)`,
   keccak256s it and compares with the hash stored on the activation. Payouts
   refuse on mismatch, on empty code, or when the code cannot be read. An
   approval with no hash proceeds but logs UNPINNED — the honest gap, not a
   silent pass.
4. **Validated RPC registry.** `rpcEndpoints` + `validationRuns`: the server
   probes `eth_chainId`/`eth_blockNumber`, stores VALIDATED/REJECTED with a
   1-hour TTL, and `rpcFor()` now prefers validated `stored` rows, then
   validated `discovered` rows. Unvalidated discovery no longer reaches the
   execution list.
5. **Validated address registry.** `discoveryRecords` for router, factory,
   token, pool and executor with chain+kind, checks, code hash, expiry and
   revocation. The store refuses every target until the backend answers.
6. **Server-side withdrawal rejection.** `payouts.requestExternalWithdrawal`
   classifies and rejects every request (`allowed: false`) and records the
   attempt; the UI no longer has the only refusal.

### Gaps this pass did not close

- **Router/factory/token/pool checks are wired only for the executor in the
  payout path.** `executionTargetReasons()` is ready and tested, but the swap
  builder does not call it yet — swapping through an unvalidated router is still
  possible if that router is compiled into `CHAIN_INFO`.
- **No discovery records are seeded.** BSC router/factory/executor approval must
  be registered and validated in Settings; until then internal payouts refuse at
  the executor check. This is deliberate (backend authority), not an outage.
- **Internal destination policy is still client-derived.** Sniper treats
  "destination === payout signer" as internal. A backend
  `approvedInternalDestinations` registry (chainId + vault address, enabled) is
  the missing piece for requirement 1.3.
- **No vault contract.** The Solidity boundary in the request (`receiveProfit`
  restricted to the executor, `withdrawExternal` reverting) has no source in
  this repository; nothing here can enforce it on chain.
- **RPC validation does not gate the fallback.** When a chain has no validated
  row the configured/public endpoints are still used (chain-id checked by
  `RpcManager`), because failing closed there would take the terminal offline.
- **`validationRuns` has no retention policy** — the existing retention job does
  not cover it.
- **The probe action accepts any public URL** (private hosts are blocked). It
  requires a signed-in caller but has no per-user rate limit.

---

## I. Implemented 2026-11-17 — swap gate, destination registry, BSC seed, checks console

1. **Swap targets are gated.** `buyToken`/`sellToken` in `swap-executor.ts` call
   `executionTargetReasons()` before quoting, simulating or signing. A router the
   backend has not validated returns `simulationPassed: false` with
   "Swap target blocked — …", so no transaction is built against it. This covers
   the Sniper buy/sell paths and the auto-sell hook, since they all go through
   those two functions.
2. **Internal destination registry.** New `internalDestinations` table
   (`src/convex/destinations.ts`): operator-approved chain + vault address rows,
   disable = immediate. Sniper no longer infers "internal" from the destination
   equalling the signer — it asks the registry, and everything else classifies as
   an external withdrawal (refused).
3. **BSC targets seeded from the server.** `discovery.seedBscTargets` fetched
   `eth_getCode` for the PancakeSwap V2 router, its factory and WBNB on chain 56
   and stored them VALIDATED (90-day term) with the byte counts and source
   endpoint as evidence. Results: router 21 936 bytes, factory 19 084 bytes,
   WBNB 3 124 bytes, all read from `bsc-dataseed.binance.org`. Seeded on both
   prod and dev. The seed is idempotent.
4. **Checks console.** `SecurityChecksPanel` (Settings) renders ten checks —
   activation hydrated/active, executor pinned, internal destination approved,
   router/factory/WBNB validated, validated RPC count, withdrawals disabled,
   registry hydrated — each with the reason it fails and a pointer to the
   operator console.

### Still open

- **No internal destination is seeded.** The vault address is deployment-specific
  and is not in this repository, so approving one on the operator's behalf would
  be fabrication. Until one is approved in Settings, every payout target is
  classified external and refused — including the previously internal path.
- **Executors are not seeded either** for the same reason; register and validate
  the deployed executor in Settings, then pin its bytecode.
- **Factory is not on the swap path.** `ChainExecutionEnv` carries the router but
  not the factory, so the factory check currently protects pair discovery only
  (it is validated and visible in checks, not consulted by `buyToken`).
- **Token validation covers known tokens only** (WBNB). Arbitrary sniper targets
  cannot be pre-validated; treat the token row as "known-good addresses", not a
  whitelist for every trade.
- **Fail-closed means fail-closed.** If the discovery query has not answered,
  `buyToken` refuses. A slow backend now blocks trading rather than allowing an
  unvalidated router — intended, but it is a behaviour change worth knowing
  during an outage.
- **Seed relies on public BSC RPC.** If all three public endpoints fail, the seed
  records a rejection run and inserts nothing; rerun later.

---

## J. Implemented 2026-11-17 — refusal reporting, payout unblock, executor flow

1. **Refusals are reported as refusals.** `buyToken`/`sellToken` now return
   `blocked: { code: "unvalidated-target", reason }` alongside
   `simulationPassed: false`. Sniper, the quick-buy simulation and the auto-sell
   hook branch on it: *"Execution refused — no transaction was created"* with a
   pointer to the console, instead of *"simulation failed"*, which sent operators
   looking for a contract bug. Policy refusals no longer increment the loss
   tracker or fire a Telegram "snipe failed".
2. **Internal payouts unblocked through the operator path.** The payout card
   shows the backend-approved internal destination for the chain and, when none
   is approved, an **Approve this vault as internal (operator)** button that
   approves the session's vault/hot wallet via `destinations.approveInternalDestination`.
   One click replaces "internal payouts can never pass classification", while the
   decision itself still lives in the backend.
3. **Executor registration flow.** Settings → Authorization console gains
   **Register executor**: it reads `eth_getCode` for the address, hashes the
   runtime code, registers an `executor` discovery record, validates it with the
   observed byte count and hash, and pins the same hash on the active activation
   — the four steps that previously had to be done separately.
4. **Code review + follow-ups** recorded in reports/code-review-2026-11-16.md (seventh pass) and above.

### Still open

- **Two operator actions are still required before a payout can succeed**: approve
  the vault as an internal destination (button on the payout card) and register
  the executor (console). Neither is automatic by design.
- **Executor registration proves code exists and hashes it — not that it is the
  right code.** There is no source or build reproducibility check; an operator
  can register any deployed address and approve it.
- **The approve button approves the session signer.** If the vault signer changes
  (new hot wallet, new import), the previous approval stays enabled for that
  chain and the new address is unapproved until an operator acts.
- **`blocked` is only set by the swap gate.** Withdrawal, payout and bytecode
  refusals still surface as strings in `payoutBlocks`/toasts, not as a typed
  refusal object.
- **Refusals are not persisted.** A policy-blocked swap is logged only; it does
  not create a `payoutBlocks` row or an execution record, so the dashboard
  undercounts blocked attempts.

---

## K. Implemented 2026-11-17 — executor flow, operator UI, block audit

1. **Executor flow fixed.** Two steps: *Inspect code* reads `eth_getCode`, hashes it
   and shows the address, byte count and hash; *Confirm & pin executor* then
   registers (idempotent), validates with that evidence, and calls the new
   `pinExecutorContract`, which sets the approved address and hash **together**.
   It now fails loudly when no ACTIVE activation exists instead of silently
   skipping the pin.
2. **Approve button hidden.** The payout-card control renders only when
   `gate.isOperatorUser` says the signed-in user is the operator; the mutation's
   server-side check is unchanged.
3. **Blocked swaps are audited.** New `executionBlocks` table + module
   (`recordBlockedExecution`, `listBlockedExecutions`). Sniper records both the
   snipe path and the quick-buy simulation path with chain, code, reason, router,
   token and amount. These rows do not count as losses.
4. **Code review + follow-ups** updated (eighth pass above).

### Still open

- **Auto-sell refusals are still log-only** — the hook has no Convex client; it
  needs a callback passed from Sniper to reuse `recordBlockedExecution`.
- **Block auditing is client-initiated**, so an offline refusal is lost; a
  server-side gate would be the only way to guarantee it.
- **Executor flow is BSC-only** in the console; other chains need their own
  `executionEnvFor` branch before they can be registered.
- **No aggregate view of blocked executions** — the table has an index for
  per-code queries but the UI does not surface counts yet.
- **`pinContractCodeHash` is superseded** by `pinExecutorContract` for the
  executor flow and is still used by the "Pin current bytecode" button.

---

## L. Implemented 2026-11-17 — executor cross-check, auto-sell audit, block counts

1. **Executor cross-check.** The console reads the executor armed in this terminal
   (`state.deployments.bsc.contractAddress`, falling back to
   `deployedContractAddress`), shows it, offers **Use armed executor**, and
   refuses to inspect/register a different address while an armed one exists.
   Approving a contract that never signs is no longer a silent mistake.
2. **Auto-sell refusals audited.** `useAutoSell` gained `onBlocked(position,
   {code, reason, chainId, router})`; Sniper records those rows through
   `executionBlocks.recordBlockedExecution` with reason prefix `auto-sell:`.
   They still do not count as losses.
3. **Blocked counts shown.** New `blockedExecutionSummary` query (total, 24h, 7d,
   by code, recent five, capped at 500) and `BlockedExecutionsPanel` in Settings.
4. **Code review + follow-ups** updated (ninth pass below).

### Still open

- **The cross-check only covers BSC** and only the executor: routers/factories
  armed elsewhere are not compared against the registry before a swap.
- **No armed executor means no cross-check.** With an empty
  `deployedContractAddress` the flow still allows any address, because there is
  nothing to compare against.
- **Summary is capped at 500 rows** and computed client-triggered; a busy account
  sees a floor, not a total, and there is no retention policy on the table.
- **Auto-sell reason is prefixed rather than typed**, so filtering auto-sell
  blocks by `code` works but by origin needs a string match.
- **Blocked rows are still written by the client**, so a refusal while the backend
  is unreachable is lost.

---

## M. Closed 2026-11-17 — backend enforcement, per-chain arm, dedupe, exact counts

1. **Enforced in the backend.** `pinExecutorContract` now resolves the chain key
   from the activation's `chainId`, loads the caller's `terminalStates` row, and
   refuses unless the state has an armed `deployments[chainKey].contractAddress`
   **and** it equals the address being pinned. There is no flag to bypass it, so
   the console guard is now a preview of a rule the server owns. Unsupported
   chain ids are refused outright.
2. **Chain fallback fixed.** The console resolves the armed executor with
   `chainForChainId(chainId)` and reads only that chain's deployment record. The
   global `deployedContractAddress` fallback is gone — it compared a BSC address
   against whichever chain was in the field.
3. **Sell blocks deduped.** `recordBlockedExecution` folds repeats of the same
   `code|chainId|token|reason` within one minute into a single row, incrementing
   `hits` and `lastTs`. Auto-sell's per-pass retries no longer write a row each.
4. **Counts are exact.** `blockedExecutionSummary` paginates through every row of
   the user (5 000-row budget) instead of sampling the newest 500; totals, per-code
   counts and the 24h/7d windows sum `hits` and are complete. `capped` is true only
   if the budget was exhausted, and the panel then labels the figures a floor.

### Still open

- **Sub-minute boundary.** A block that starts at 10:00:59 and repeats at 10:01:01
  is two records (different minute buckets), and the 24h window cuts on whole
  buckets, so a window count can differ from wall-clock truth by under a minute.
- **Formatting difference is not deduped.** The auto-sell path prefixes the reason
  with `auto-sell:`, so the same underlying refusal from two callers is two rows.
- **Pinning is BSC-first.** Enforcement covers the ids in `CHAIN_KEY_BY_ID`; a new
  chain needs that map extended or pinning is refused as unsupported.
- **A pin now requires an armed deployment first.** Operators who used to pin
  before arming must arm first; the error message says so.
- **Rows still originate client-side**, so a refusal while offline is not recorded.

---

## N. Closed 2026-11-17 — legacy pin guard, operator identity

1. **Legacy hash-only pin guarded.** `pinContractCodeHash` ("Pin current
   bytecode") used to write a hash with no address check. It now refuses when the
   chain id is unsupported, when the activation has no pinned address, and when
   the activation's address is not the executor armed for that chain in the
   operator's terminal. Its audit line records that it was a hash-only re-pin of
   the armed contract.
2. **Operator identity fixed.** Both pin mutations now resolve the armed
   deployment from the **calling operator's own** user row
   (`users.email` index → `terminalStates.by_user`) instead of
   `getCurrentUser()`. With more than one operator — or a session signed in as a
   different account — the old path could approve against someone else's
   deployment, or fail with a misleading "not armed" error.

### Still open

- **Guest operator sessions cannot pin.** They have no email, so
  `requireOperator` refuses before the armed-executor check runs. Pinning needs an
  email-authenticated operator account with a terminal state.
- **Email is the identity key.** If the operator signs in with a different
  address than the one that armed the deployment, the pin is refused (by design),
  but the account has no way to declare "these two are the same operator" beyond
  the `operatorEmails` registry.
- **A stale arm is accepted.** The check compares addresses; it does not require
  the deployment record to be recent or to have a `signerAddress`, so an arm from
  months ago still satisfies the guard.
- **The console's legacy button is still shown** for activations with no pinned
  address; it now returns an explanatory refusal instead of being hidden.

---

## O. Closed 2026-11-17 — pin guards tested, legacy button hidden, stale arms rejected, guest pins

1. **Guards are testable and tested.** The rules moved to `src/convex/pin-guard.ts`
   (pure, no Convex imports) and `src/chains/__tests__/pin-guard.test.ts` covers
   chain support, no arm, malformed arm, missing timestamp, stale arm, the exact
   limit boundary, address mismatch, guard ordering, and every legacy hash-only
   refusal. 15 new tests; suite is 584 across 48 files.
2. **Legacy button hidden.** An activation without a pinned address now shows
   "No pinned executor — use Inspect code → Confirm & pin executor above" instead
   of a button the backend always refuses.
3. **Stale arms rejected.** `saveDeployment` stamps `armedAt` whenever it is given
   an address, and both pins refuse an arm older than `ARM_MAX_AGE_MS` (30 days)
   or one saved before timestamps existed (`unverified-arm`).
4. **Guest operators can pin.** `requirePinOperator` accepts a code-verified guest
   operator session (`isGuestOperatorSession`) and resolves its own terminal state;
   audit rows record `guest:<userId>` as the actor.

### Still open

- **Existing arms have no `armedAt`, so they now refuse with `unverified-arm`.**
  The operator must re-save the deployment on the Contract page once. This is the
  intended cost of expiry, but it is a one-time action for every chain.
- **30 days is a guess.** The limit is a constant, not per-chain configuration, and
  an operator who arms and then pins later than 30 days must re-arm.
- **Arming refreshes on any save that supplies an address**, even if the address is
  unchanged, so repeatedly saving the Contract page keeps an old deployment
  pinnable — the timestamp proves recency of the *save*, not of the deployment.
- **Guest audit identities are opaque.** `guest:<id>` cannot be resolved to a
  person after the anonymous session ends.
- **Guest sessions still cannot reach the console's other operator mutations**
  (activate, suspend, revoke, discovery) — only the two pin paths accept guests.

---

## P. Closed 2026-11-17 — one operator policy, honest arm timestamps, server-read bytecode

1. **One operator policy.** `operatorEmails.resolveOperatorIdentity` is now the only
   definition: verified email → registered operator → `users` row, or a
   code-verified guest session when `allowGuest` is set. `requireOperator` is a
   thin wrapper on it, and actions pass explicit claims through
   `operatorIdentityFrom` so the action, its internal query and its mutations all
   reach the same verdict. The duplicate `requirePinOperator` is gone.
2. **Arm timestamps are honest.** `saveDeployment` stamps `armedAt` only when the
   address actually changes. Re-saving the same address (router tweak, signer note)
   preserves the original stamp, so an old deployment cannot be laundered into a
   fresh arm by clicking Save.
3. **The backend reads the bytecode.** Convex refuses `fetch` inside mutations
   (verified with a temporary probe on dev: `Can't use fetch() in queries and
   mutations`), so `inspectExecutorCode` is an **action** that runs the same pin
   guard, reads `eth_getCode` from the operator's validated RPCs then the chain's
   public fallback, and records the observation in `executorCodeInspections`. Both
   pin mutations now require a fresh row (10-minute TTL) for the same actor,
   address, chain and hash. A hash the browser invented cannot be pinned.
4. **The console no longer computes the hash.** Legacy "Pin current bytecode" and
   the Inspect step both call the action and display what the server read
   (`bytes · keccak256 … via <rpc host>`), and the preview says the confirmation is
   refused unless that exact hash was seen in the last 10 minutes.
5. **Tested.** 4 new freshness tests (window boundary, non-finite stamps) alongside
   the existing 15 guard tests; suite 598 pass / 0 fail.

### Still open

- **Pinning needs a reachable RPC.** If neither the validated endpoints nor the
  public fallback answer, inspection fails closed and nothing is pinned. That is
  deliberate, but it means pinning is not possible air-gapped.
- **The inspection TTL is 10 minutes** and is not configurable; a slow operator
  workflow has to re-inspect.
- **Evidence rows are pruned only for the same actor** (rows older than the TTL are
  deleted on write), so a long-idle deployment keeps a handful of dead rows until
  the next inspection.
- **`inspectExecutorCode` is a public action.** It is operator-gated and writes only
  evidence, but it is another entry point that must keep its guard in step with the
  pin mutation.
- **Guest sessions can now inspect and pin** their own terminal's executor; their
  evidence is as disposable as the session.
- **No `convex-test` harness**, so the action → internal mutation → pin wiring is
  typecheck- and review-verified, not unit-tested end to end.

---

## Q. Closed 2026-11-18 — arm stamps backfilled, inspection age shown, follow-ups

1. **Arm stamps can be backfilled — honestly.** `saveDeployment` now stamps a
   record that predates `armedAt` on its first save (a stamp that already exists
   is still never refreshed, so a stale arm cannot be laundered). On top of that,
   `terminal.backfillArmStamps` (operator-only, own terminal state, reason
   required, written to `auditLogs`) stamps every armed deployment that has no
   timestamp in one action. The stamp says "affirmed now", never "armed then":
   the mutation's audit text records that the original arm time was unknown, and
   pinning still requires a fresh server-side inspection.
2. **The console shows the evidence age.** `pinGuard.inspectionAgeLabel` (shared
   by the console) renders `inspected 42s ago · fresh for 9m 18s`, switches to
   red `expired (10-minute window)` past the TTL, and the Confirm button is
   disabled from that point — the backend still makes the decision. The preview
   ticks once per second only while it is on screen.
3. **Tested.** New tests cover `formatAge`, the fresh/expired labels, an
   unreadable stamp, and the three `nextArmedAt` rules (new address, same
   address preserving a stale stamp, first stamp for a pre-timestamp record).

### Still open

- **`armedAt` now means "last affirmed", not "deployed when".** A per-deployment
  `firstArmedAt` alongside `affirmedAt` would keep both facts instead of
  overloading one field.
- **The backfill acts on the whole terminal at once.** Every unstamped chain gets
  the same `now` and one shared reason; a per-chain reason and a dry-run list of
  the affected chains (a query, shown before stamping) would make the audit
  trail sharper. Guest sessions cannot run it at all — they must re-save each
  chain.
- **The countdown uses the browser clock.** A skewed client shows a wrong age;
  the server verdict is unaffected. Returning an `expiresAt` from the action and
  counting against it would remove the clock dependency.
- **An approval does not point at its evidence row.** The audit records bytes and
  RPC host, but not the `executorCodeInspections` id, so a later audit cannot
  prove which observation an approval rested on. Storing `inspectionId` (and
  `inspectedAt`) on the activation would close that gap.
- **Evidence pruning is per-actor and write-triggered.** A cron prune (like
  `audit-log-prune`) would bound `executorCodeInspections` globally instead of
  waiting for the next inspection by the same actor.
- **The backfill audit lands in the general `auditLogs` table**, which is pruned
  on a retention schedule; authorization-relevant events may deserve their own
  append-only table so the record outlives the log window.
- **Still no `convex-test` harness**, so `backfillArmStamps` is typecheck- and
  review-verified; its rules (missing-only, operator-only, reason required) are
  not executed in a test runtime.

---

## R. Closed 2026-11-18 — one expiry boundary, evidence-safe pruning, one deploy output

1. **The inspection window has a single boundary now.** `isInspectionFresh` used
   `now - inspectedAt <= ttl`, i.e. evidence was still accepted at the exact
   instant the console's countdown reached `expiresAt` and disabled Confirm — the
   same second the backend said yes and the UI said no. The window is now
   half-open, `[inspectedAt, inspectedAt + ttl)`, matching
   `inspectionExpired(remaining <= 0)` and activation expiry
   (`expiresAt <= now`). Future stamps are refused as well; the old check
   accepted any stamp ahead of the server clock, which is a clock disagreement,
   not evidence.
2. **A sub-second window no longer reads as expired.** `formatAge` floors, so
   `remaining = 900ms` rendered "fresh for 0s more". It now says "expires now"
   while the hash is still pinnable.
3. **Pruning can no longer orphan an approval's evidence.** `recordCodeInspection`
   used to delete every expired row for the actor, including the row an
   activation's `contractCodeInspectionId` points at. Pruning now skips
   referenced rows, so the id in the audit text always resolves.
4. **The evidence table is bounded globally.** `inspection-evidence-prune` (every
   6 h, bounded, oldest-first) deletes unreferenced observations older than a
   week; per-actor write-time pruning still trims on the next inspection.
   Schema gains `by_inspected_at` for that sweep.
5. **One deploy output.** The staged `sites-assets/` copy was a second artifact
   tree that silently went stale (it lagged `dist/` by a build). `sites.deploy.json`
   and `wrangler.sites.local.jsonc` now point at `dist/`, the directory
   `wrangler.toml` already declared, and the ignored copy is gone.

### Still open

- **Referenced evidence is kept forever.** A chain approval points at one row;
  the table therefore never shrinks below the number of approvals. That is the
  intended trade (a dangling id is worse than a few rows), but the retention
  rule is "forever" for referenced rows, not a written term.
- **Retained rows can block the sweep's window.** The cron takes the 250 oldest
  rows; if a whole window is referenced, deletion waits for the next run. The
  bound is the approval count, so this is head-of-line patience rather than a
  leak.
- **The boundary rules are still only unit-tested through pure functions.** There
  is no `convex-test` harness, so `recordCodeInspection` → prune → pin is
  typecheck- and review-verified, not executed.
- **`_redirects` is still produced in `dist/`.** The Workers SPA path uses
  `not_found_handling`, so the file is served as inert text; decide whether to
  drop the root file or keep it for the Pages/Netlify configs that still read it.
- **The Publish button's pipeline is still unverified end to end.** The Wrangler
  config (`main` + `[assets]`) is now valid and `wrangler deploy --dry-run`
  passes, but the button itself was not exercised from the dashboard.

### Brainstorm — next round

1. **Make the expiry boundary a named constant, not a habit.** `effectiveStatus`,
   `isInspectionFresh` and `inspectionExpired` now agree; a tiny
   `isBeforeExpiry(deadline, now)` helper would keep a fourth caller from
   re-deriving `<=` vs `<`.
2. **Store a `firstArmedAt` next to `affirmedAt`.** `armedAt` still means "last
   affirmed"; the original deployment time is lost on every backfill.
3. **Give the prune a dry-run query.** `inspectionEvidenceStats` (counts by age,
   referenced vs not) would make the sweep's effect observable without reading
   the dashboard.
4. **Tag audit rows with the evidence id they already mention.** The audit text
   embeds `evidence <id>`; a real field would let an operator query "what rests
   on this observation" instead of matching strings.
5. **Pin the deploy output in the release verification.** `verify-release.sh`
   could assert `dist/index.html` exists and `wrangler deploy --dry-run` passes
   before a publish, so a config regression is caught by `bun run verify`.
6. **Record the published artifact stamp.** Storing the `dist/index.html` hash in
   `.task-baseline` (as the guard already does for the protected deployment)
   would turn "which build is live" into a reviewable fact.

---

## S. Closed 2026-11-18 — one deploy config, checked headers, split arm stamps, evidence stats

1. **One deploy config.** `wrangler.toml` is the only hand-edited description of
   the deploy (Worker entry, compatibility date, asset directory, SPA fallback).
   The redundant `wrangler.sites.local.jsonc` — a third copy of the same four
   values — is deleted; `wrangler dev` reads `wrangler.toml`. `sites.deploy.json`
   still has to repeat the values because the deploy call reads them from the
   manifest, so `scripts/check-deploy-config.mjs` (`bun run check:deploy-config`,
   step 3 of `bun run verify`) now fails when the two disagree, when a declared
   module is missing, when `spa` and `not_found_handling` disagree, or when the
   asset directory is not git-ignored.
2. **Security headers were checked against the live origins, not assumed.** The
   Sites preview (`site-09ea…freebuff.page`) and the Vercel deployment
   (`taengine.freebuff.app`) both returned the full set from `public/_headers`:
   `x-robots-tag`, `x-content-type-options`, `x-frame-options: DENY`,
   `referrer-policy`, `permissions-policy` — including on hashed assets with a
   one-year immutable cache. That settles the open question from round R:
   Workers static assets *does* apply `_headers` (only `_redirects` is rejected,
   code `100324`). The one gap was transport security: Vercel sent
   `strict-transport-security`, the Sites preview did not, so
   `Strict-Transport-Security: max-age=31536000` is now in the shared header
   block.
3. **CSP and COOP stay off, for a stated reason.** The page carries an inline
   `application/json` config block injected by `sites/worker.js` and opens wallet
   popups; both need a nonce/allowlist design before a policy can be added
   without breaking connect/deploy. That reasoning now lives in `_headers`
   instead of in someone's head.
4. **Arm stamps are split.** `armedAt` (when this address was armed) no longer
   shares a field with "when was this saved". `nextArmStamps` writes `armedAt`,
   `firstArmedAt` and `affirmedAt` together: a new address stamps all three, a
   re-save of the same address moves only `affirmedAt` (a stale arm still cannot
   be laundered by clicking Save), and a pre-timestamp record is affirmed without
   being back-dated — its `firstArmedAt` stays absent rather than invented. The
   pin guard still reads `armedAt` alone, via `armStampForGuard`.
5. **The evidence sweep has a dry run.** `chainActivations.inspectionEvidenceStats`
   (operator-only query) reads the oldest 2 000 evidence rows — the same order
   the prune uses — and reports fresh / expired-referenced / expired-unreferenced
   counts, how many rows the next sweep may delete, the oldest prunable stamp,
   the referenced-id count and a per-chain breakdown, all without deleting or
   writing an audit row. `capped` marks the numbers a floor when the window fills.

### Still open

- **`sites.deploy.json` must keep duplicating four values.** The deploy call reads
  them from the manifest, so parity can be checked but not eliminated. Generating
  the manifest from `wrangler.toml` at deploy time would remove the last copy —
  at the cost of the manifest no longer being reviewable in a diff.
- **`firstArmedAt` is absent on every record that predates timestamps.** That is
  deliberate (the fact is unknown), but it means "how long has this been armed?"
  stays unanswerable for those chains until the address changes.
- ~~**`affirmedAt` is not shown anywhere yet.**~~ **Done (sixteenth pass):** the
  Contract page's "Live deployment" card renders `current arm`, `first armed`
  and `last saved` ages, says "not recorded" where the fact is unknown instead of
  inventing one, and warns when the current arm is past the 30-day pin limit.
- **The stats query is a window, not a census.** It reads the oldest 2 000 rows;
  a table larger than that reports a floor rather than a total. A per-run prune
  counter written by the cron itself would give exact history instead.
- **`X-Frame-Options: DENY` means the app cannot be embedded.** That is the right
  default for a signing terminal, but it also blocks an in-panel iframe preview,
  so the published site has to be opened in its own tab
  (`https://taengine.freebuff.app/`).
- ~~**The Worker's HTML rewrite may never run on Sites.**~~ **Resolved (sixteenth
  pass):** it does run. The earlier probe sent no `Accept: text/html`, so the
  assets binding answered as it would for any asset request — no rewrite, no
  `no-store`. With a browser `Accept` header `/` returns `cache-control: no-store`,
  the injected JSON block, the per-response nonce and the matching CSP. Injection
  is also proven against the operator's real `BSC_MAINNET_RPC_URL` in
  `sites/worker.test.ts` (every configured endpoint, unchanged; nothing leaks into
  non-HTML responses).
- **The parity check reads TOML with a regex.** It covers the flat string keys
  this file uses; a nested table or a multi-line string added later would be
  silently skipped. It exits non-zero on the keys it does read.
- **No test covers `nextArmStamps`'s interaction with the mutation.** The pure
  rules are tested (four new cases); `saveDeployment` and `backfillArmStamps` are
  still typecheck- and review-verified.

---

## Round 14 — 2026-11-21, Solana program foundation

1. **The provider decision now blocks the execution milestone.** One lender, one
   DEX and one aggregator, devnet-only first, is recorded in
   `reports/flashbolt-provider-brief-2026-11-21.md`. The brief's hard finding:
   none of marginfi, Kamino, Jupiter Lend or Solend allows the flash borrow/repay
   to be called through CPI, so `flash_arb` is a middle instruction between two
   top-level lender instructions. That fixes what it may assume — it must verify
   the borrow, measure profit from balances and leave principal plus fee to the
   repay — and it is why the copy in the terminal still says `flash_arb` is
   pending rather than sketching a CPI wrapper.
2. **`Config` now reserves 256 bytes** (`reserved: [u8; 256]`, account 395 bytes)
   instead of an exact-fit 139. The reserve is the execution milestone's field
   space (lender and venue program ids, fee/slippage ceilings, minimum profit),
   so a future field does not need a realloc; it must stay last, and the new IDL
   test pins the field order and type. Rent on the difference is a few thousand
   lamports.
3. **The tracked IDL is now tested.** Six conformance tests re-derive every
   instruction, account and event discriminator, plus argument names/types, the
   signer set and the `flashbolt_config` PDA seed, the error codes in declaration
   order and the `Config` layout. A stale `idl/flashbolt_solana.json` now fails
   `cargo test` instead of shipping.
4. **Nothing was deployed.** Devnet arming still needs a funded deployer (~3 SOL
   with the deploy buffer) and explicit go-ahead; the cluster is still
   mainnet-configured and the preflight stays BLOCKED on exactly those two gates.
   Mainnet remains off until the audit.
5. **Devnet availability is now a selection criterion, not an afterthought.**
   Jupiter's Router quote service is mainnet-oriented, so the devnet-first cut
   cannot lean on the aggregator: the first `flash_arb` targets a direct venue
   CPI and the aggregator arrives after that path is proven.
6. **The reserve makes the instruction-builder drift more likely, not less.**
   `SolContract.tsx` still hand-copies instruction names; wiring it to the IDL
   moved up the list because `Config` now carries a field the page does not know
   about.

## Round 15 — 2026-11-21, review pass plus CI and the provider decision

1. **The provider decision is recorded, and one of its gates is the real task.**
   Jupiter Lend (no lender fee), Orca Whirlpool first, Raydium as a second
   adapter, Kamino Lend deferred, aggregator deferred, devnet only. Jupiter
   Lend's own repository says its devnet deployments are from May 2025 and do not
   match the mainnet IDLs, so resolving the real devnet program id, instruction
   set, account layouts and fees is the first piece of work — not the adapter.
2. **The lender swap does not change the instruction shape.** Jupiter Lend's
   borrow/payback is a top-level pair, like Kamino's and marginfi's, so
   `flash_arb` stays a middle instruction in `[borrow, flash_arb, payback]` and
   still has to verify the borrow, measure profit from balances and leave the
   principal in the account the payback debits. Zero lender fee removes a term
   from the arithmetic; it does not remove the accounting.
3. **`solana/SECURITY.md` now exists.** Assets, six trust boundaries, fifteen
   threats each with the mitigation and whether it is implemented or planned,
   accepted risks, what is out of scope, and the audit focus. It states plainly
   that nothing is deployed and nothing is audited.
4. **The program has a CI job of its own.** `solana-program` on `ubuntu-24.04`
   (Anchor 0.31.1's prebuilt binary needs GLIBC ≥ 2.38), Solana CLI 4.4.1 pinned
   so `cargo-build-sbf --arch v1` keeps producing an artifact LiteSVM 0.7 can
   load, SBF build → `anchor idl build` diff → clippy `-D warnings` → both test
   suites → preflight. It never deploys and has no key material.
5. **The preflight gained a CI mode rather than a second script.**
   `FLASHBOLT_PREFLIGHT_CI=1` downgrades exactly two lines — the program keypair
   and the devnet deployer — to notes, because a runner can never have either.
   Source, address, IDL and toolchain gates still fail the run. Without this the
   job would have been red on arrival, and a gate nobody can satisfy gets
   deleted.
6. **The review found the IDL test documenting a check it did not perform.** The
   `EVENTS` array claimed to be in `state.rs` order while the test sorted both
   sides, so the order was neither asserted nor correct. Fixed: the array is in
   declaration order and the comment now says the comparison is a set. No
   behaviour change.

## Round 16 — 2026-11-21, Jupiter Lend verified, the IDL wired into the app

**What the verification produced.** The mandatory devnet gate was executed
read-only (see `reports/flashbolt-provider-brief-2026-11-21.md` → Verification
log). Mainnet is real: flashloan `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`,
liquidity `jupeiUmn8…`, admin `ALXWtv2…` with a **zero fee word**. Devnet is
empty: flashloan, liquidity and AMM all return `null`. So the gate is **failed,
not pending**, and that changes the next milestone from "write the adapter" to
"choose how the lender is exercised at all".

**Decision now needed (recorded, not taken).**

1. **How does the lender get exercised?** Three honest options:
   (a) ask Jupiter for / stand up a devnet deployment of the Lend stack — most
   faithful, slowest, and outside this repo; (b) use marginfi's devnet
   deployment for the devnet path while Jupiter Lend stays mainnet-only behind
   the audit gate — fastest to a real devnet run, but two lenders to maintain;
   (c) make the arbitrage rail mainnet-only after the audit — simplest, and it
   means no devnet rehearsal of `flash_arb` at all. Nothing in the adapter
   should be written before this is chosen: each option changes what the
   builder and the tests target.

**Closed by this pass.**

2. **The contract page no longer hand-copies the program.** Round 14 #6 is
   closed: `src/lib/solana-execution-plan.ts` imports the tracked IDL, so the
   program address, all six instruction names, their flattened argument types,
   signers and the ten error codes come from the same file CI diffs. The
   settings panel lists them and offers "use the IDL address" instead of asking
   the operator to paste it. `solana-execution-plan.test.ts` fails on drift.
3. **Jupiter Swap is provably not in the arbitrage blast radius.** The panel
   states the separation and the code enforces it: switching the active engine
   writes only `solExecutionRail`; the arbitrage authorization
   (`solContractAuthorized`) is its own persisted flag, so it can be pre-armed
   while Jupiter Swap stays active — and turning it off cannot touch swaps.
4. **The break-even strip stopped lying.** It hardcoded "+ 0.05% Kamino" while
   the lender registry said otherwise. It now derives the cheapest lender's fee
   from `SOL_FLASH_LENDERS`, so the number above the scanner is the number the
   balancer sorts by.

**New follow-ups, in priority order.**

5. **Per-engine execution attribution.** History rows carry no engine tag, so
   a `solcontract` run and a Jupiter Swap run are indistinguishable after the
   fact. Add `engine: "jupiter-swap" | "flash-arb"` on the execution row (needs
   a Convex schema field and a deploy) and split the P&L summaries by it.
6. **A real enable/disable flag per engine.** Today "off" means "not the active
   rail". Swap keeps executing when the operator only wanted to stop
   arbitrage — acceptable for two rails, wrong once the arbitrage rail is
   live. Add `solArbEnabled` and `solSwapEnabled` and have the scanner gate on
   both, so disabling one engine never silently moves traffic to the other.
7. **CI should probe the lender, not remember it.** A read-only
   `getAccountInfo` check for the Jupiter Lend programs (mainnet present, devnet
   state reported) turns "the address moved" into a red build instead of a
   runtime surprise. Same shape as the existing devnet preflight, no key needed.
8. **Re-read the fee instead of trusting the constant.** The zero fee is a
   constant in `JUPITER_LEND` with its provenance. Once the adapter exists, read
   `flashloan_admin` at quote time and refuse (or reprice) when the fee word is
   no longer 0 — a silent fee change would otherwise corrupt every P&L number.
9. **Orca Whirlpool devnet pools are the next unknown.** The provider decision
   puts Orca first, but the venue adapter needs a pool registry per cluster and
   fixtures for the Whirlpool account layout before it can be priced honestly.
   Verify devnet pools exist before designing the adapter around them.
10. **Generate the client from the IDL.** The app reads the IDL; the builder
    will still be hand-written. A generated TS client (program address,
    discriminators, account decoders) removes the last place where an
    instruction name can be typed wrongly.
11. **Alert on a configured/IDL address mismatch.** The panel shows "differs
    from IDL" as a badge. That should also surface on the Contract page and in
    the preflight, because a stale program ID in strategy settings is exactly
    how a blocked rail gets "fixed" by pointing at the wrong program.

## Round 17 — 2026-11-21, the rail gate shared with the server, lender paths compared

**Done by this pass.**

1. **One gate, two runtimes.** `src/lib/sol-rail-gate.ts` now holds
   `solRailVerdict`, the types and the patch merge, with no imports at all;
   `solana-policy.ts` re-exports it so every existing consumer is unchanged.
   A copy for the server would have drifted from the UI on the first change,
   and importing the policy module would drag web3.js into the Convex runtime.
2. **The rail is validated where it is written.** `terminal.setSettings`
   refuses to persist `solExecutionRail: "solcontract"` when the merged state
   (stored row + patch) fails the gate, and returns the exact blocker list.
   Jupiter is untouched: the check runs only when the patch activates the
   contract rail.
3. **Unchanged rails are no longer re-sent.** SOL Strategy omits
   `solExecutionRail` when the selection equals the stored value, so a legacy
   blocked rail cannot fail saves that have nothing to do with it.
4. **Lender paths compared on the same probe.** marginfi and Solend are also
   absent on devnet; Kamino Lend is the only lender in the decision table with
   a devnet program. Recorded in the provider brief — the decision still
   belongs to the operator.

**Needs a deploy.**

5. The mutation gate is committed but inert until the Convex functions are
   deployed. This workspace has `CONVEX_DEPLOY_KEY_1` / `_2`, not the expected
   `CONVEX_DEPLOY_KEY`, and the target deployment is not unambiguous — so
   nothing was deployed and the old mutation is still live.

**New follow-ups, in priority order.**

6. **Convex function tests for the gate.** The gate is unit-tested through its
   pure module, but nothing exercises the mutation handler itself; the repo
   has no `convex-test` harness. Add one, with a case for "activate rail and
   arm it in the same patch".
7. **Server-side program-ID allowlist.** The gate accepts any base58 address,
   including one that is not in the IDL. Once the program is deployed, pin the
   accepted address server-side so a wrong-but-valid ID cannot arm the rail.
8. **Rail transitions belong in the audit trail.** Arming or switching a rail
   is an execution-control change; it currently leaves no server record beyond
   the settings row. Append an audit entry with actor, from/to rails and the
   verdict, the way arm stamps are recorded.
9. **Lender registry should carry deployment state per cluster.** The
   comparison is a report right now. A per-lender `devnet: boolean` with the
   probe date would let the UI say why the arbitrage rail is blocked instead of
   leaving it to the brief, and a CI probe (Round 16 #7) could keep it true.
10. **Decide the devnet rehearsal path.** The comparison narrows it to three
    honest options: reverse the Kamino deferral for devnet only, clone Jupiter
    Lend's mainnet accounts into a local validator, or rehearse only on mainnet
    after the audit. Each picks a different target for the adapter and its
    tests, so the choice still precedes the code.

## Round 18 — 2026-11-22 · gate activation, program-ID pin, faucet reality

**Shipped in this round.**

1. **The server gate no longer depends on activation.** Round 17 gated only
   `args.solExecutionRail === "solcontract"`, so an already-armed rail could be
   re-pointed at a bad program ID by any other save. It now runs whenever a
   rail field is in the patch and the MERGED rail is `solcontract`; the merge
   also passes the real patch instead of forcing `rail: "solcontract"` into it
   (a latent bug that only behaved because activation was the sole entry).
2. **Program ID pinned (Round 17 #7 done).** `SOL_PROGRAM_ID_PIN` lives in the
   dependency-free gate module. The gate refuses any other base58 address —
   the browser and the Convex mutation share the one pin — and a drift test
   holds `declare_id!`, both `Anchor.toml` entries, the tracked IDL and
   `solana-program-preflight.sh` to it.
3. **Devnet funding corrected to what the faucet actually does.** Verified
   live on 2026-11-22: `requestAirdrop` on `api.devnet.solana.com` answers
   HTTP 410 ("The RPC faucet is closed on this cluster"), and
   `https://faucet.solana.com/api/request-airdrop` returns an HTML page — there
   is no public programmatic endpoint. The drill's fabricated JSON call was
   removed; it now reports the RPC refusal verbatim, probes the pre-funded
   balance, and names the official faucet (2 requests / 8 h anonymous, GitHub
   sign-in raises it), the CLI airdrop and the local validator. DRILLS.md and
   the release-gate remediation say the same.
4. **Full-suite test isolation fixed.** `utc-clock` reassigned
   `globalThis.localStorage`, which is readonly once another test installs DOM
   globals, so `bun test` was red with a TypeError instead of an assertion.
   The test now exercises the real fallback without touching the global.

**Still blocked (unchanged).**

5. Convex functions are still not deployed — `CONVEX_DEPLOY_KEY` is absent and
   the two suffixed variables are short `dev:` / `prod:` labels, not deploy
   keys (a real key carries a `|`-separated JWT). The gate stays inert until a
   real key is added.
6. FlashboltSolana is not deployed to devnet (no SBF toolchain, no funded
   deployer, no go-ahead), and mainnet still needs the audit.
7. The lender path still needs the operator's decision (Round 17 #10).

**New follow-ups.**

8. **Faucet integration needs a human once.** Because the web faucet is
   browser-only, a per-wallet "Fund devnet" affordance should copy the address
   and open the faucet, then verify the balance on-chain — never claim the drip
   happened from the app side.
9. **Gate the other way too.** A `solcontract` row that predates the pin can
   still be READ by the engine; the client shows it blocked, but the engine
   path should re-run `solRailVerdict` before it signs (same function, no new
   rule).

## Round 19 — 2026-11-22 · Rust CI toolchain, signing gate, devnet funding card

**1. The Rust job was failing on its toolchain, not on the program.** The job
installed the `v4.4.1` CLI, whose SBF v1 toolchain bundles Cargo 1.79. Cargo
1.79 cannot parse an `edition2024` manifest, and the current dependency tree
contains several (`cpufeatures 0.3.1` via `blake3`/`chacha20`), so the build died
before compiling a single line with:

```
error: failed to parse manifest at .../cpufeatures-0.3.1/Cargo.toml
  feature `edition2024` is required ... Cargo (1.79.0)
```

The fix is in the workflow, not the lockfile: install the CLI from the `stable`
channel (whose `cargo-build-sbf` is 4.5.0), pin the SBF compiler separately with
`--tools-version v1.57` (Rust 1.95, edition2024-capable) and build with the arch
spelling this toolchain accepts (`v1`; the older build spells it `sbfv1`, which
is what made the previous "arch name" attempt look fixed while the compiler was
still 1.79). Nothing in `solana/Cargo.lock` was downgraded.

**2. Engine signing is gated, not just engine activation.** `solSigningVerdict`
joins `solRailVerdict` in the dependency-free gate module and answers a
different question: *may this engine sign right now?* Every live path
(`executeLiveArb`, `executeLiveSnipeBuy`, `executeLiveSnipeSell`) now checks it
before it resolves a signer, so

- a Jupiter signing path refuses while the operator has armed flash arbitrage,
  and
- the flash arbitrage engine refuses on any rail the settings mutation would
  have refused (unpinned ID, no authorization, mainnet without the audit).

That closes Round 18 follow-up #9 with the same rule set — no second policy
implementation to drift.

**3. Devnet funding is a card, and it tells the truth.** SOL Strategy (testnet
only) shows the armed wallet, its live devnet `getBalance`, the official faucet
link with its documented limit (`up to 2 requests every 8 hours`), the verbatim
HTTP 410 from `requestAirdrop`, and the `solana airdrop` caveat — the CLI talks
to the same closed RPC faucet. It states plainly that FlashBolt cannot claim for
the operator. Round 18 follow-up #8 is done except for a copy-to-clipboard
button (the address and the exact CLI command are shown instead).

**4. The write gate is tested where it runs.** The decision moved into
`convex/rail-gate.ts` (`gateSolRailWrite`), which `terminal.setSettings` calls
and which `src/lib/__tests__/rail-gate-server.test.ts` exercises directly:
one-save activation, the pin, authorization, the mainnet audit, re-pointing an
armed rail, clearing/de-authorizing an armed rail, switching an armed rail to
mainnet, returning to Jupiter, and the guarantee that a slippage/venue save is
never gated.

**Still blocked (unchanged).**

5. FlashboltSolana is not deployed to devnet: no funded deployer and no
   go-ahead (the SBF build itself now works in CI and locally).
6. Mainnet needs the independent audit plus explicit approval.
7. The borrow/payback adapter still waits on the operator's lender path
   (Jupiter Lend has no devnet deployment; only Kamino does).

**New follow-ups.**

8. **Align DRILLS.md's CLI-airdrop line with the card.** The drill still lists
   `solana airdrop 2 … --url devnet` as an option; against the public devnet RPC
   it fails with the same 410. Either name a faucet-serving RPC or drop the line.
9. **Fail loudly on toolchain drift.** The workflow prints the versions but does
   not assert them; add a `cargo-build-sbf --version` check for platform-tools
   `v1.57` so a silent channel swap fails at the top of the job.
10. **Copy-to-clipboard on the devnet card** (address and CLI command), with the
    balance re-read after the operator returns from the faucet page.
11. **Drop the SBF v1 pin once LiteSVM accepts the Agave default (v3)** — that
    is the only reason this job pins `--arch v1`.

## Round 20 — 2026-11-22 · fail-closed default, the serving ceiling, exit fallback, copy buttons

**1. The reported `gate:operatorLogin` Server Error was the deployment being
disabled, not the action.** `convex logs --prod` streamed while the action was
called returns exactly one line:

```
[CONVEX A(gate:operatorLogin)] You have exceeded the free plan limits, so your
deployments have been disabled. Please upgrade to a Pro plan or reach out to us
at support@convex.dev for help.
```

`convex deployment usage-limits list --prod` reports "No usage limits
configured", so nothing self-imposed is being hit. `scripts/operator-login.mjs`
reproduced it end to end with the real stored credentials — decryption succeeds,
the action is registered, and the HTTP response is
`{"status":"error","errorMessage":"[Request ID: …] Server Error"}` because Convex
hides the plan message from clients. No code change can restore serving.

**2. CI was green but not deploying because the key was an environment secret.**
The deploy key was added as a GitHub *environment* named `CONVEX_DEPLOY_KEY`; a
job only receives environment secrets when it declares `environment:`. The
`deploy-convex` job now declares it, and run `45044058396` at `fb20551` shows
`✔ Deployed Convex functions to https://flexible-frog-776.convex.cloud` — a real
deploy from a plain push, with all three jobs green.

**3. The gate's default now fails closed on OPEN paths and stays open on exits.**
`SOL_POSITION_RAIL` (Jupiter, unpinned, unauthorized) is the exit rail;
`SOL_RAIL_UNVERIFIED_MESSAGE` is the refusal an open path gets when the
persisted settings did not arrive. `executeLiveSnipeBuy` and `executeLiveArb`
refuse with `engine: "rail-gate"` before a signer, quote or simulation is
touched; `executeLiveSnipeSell` uses the position rail when no settings arrive
and ignores supplied settings that name another rail, so a real position can
always be closed. Review fixes in the same pass: the doubled
"Jupiter rail armed / Jupiter signing armed" prefix (`clusterLabel`), the
`programId || null` simplification, and the three callers now spread
`railSettings` only when it exists instead of sending `undefined`.

**4. The exit fallback is tested at the entry point, not just at the gate.** The
new cases call `executeLiveSnipeSell` with a provider that exists but holds no
key (`publicKey: null`, and a `signTransaction` that throws), so a passing test
proves the gate let the exit through and nothing reached the wallet: no settings,
an armed `solcontract` rail (the rail-switch case that would otherwise strand
tokens), and explicit Jupiter settings all return `engine: "none"` /
`error: "no-wallet"` rather than `engine: "rail-gate"`.

That second case failed on the first run, and it found a real bug: the sniper's
immediate exit passes the armed rail (`state.solExecutionRail`), so an operator
who armed flash arbitrage while holding a Jupiter position had every exit
refused with "the active rail is solcontract". The fix is in
`executeLiveSnipeSell`: supplied settings are used only when they name Jupiter,
otherwise the position rail applies. `engine: "jupiter"` is structurally true
for this path — it builds a Jupiter sell — so the rail check adds nothing there
and could only withhold a close.

**5. The devnet funding card can copy.** The armed address has a copy control,
and the exact `solana airdrop 2 <address> --url devnet` command has its own copy
button that copies the command without the trailing comment. Copy failures are
reported ("browser blocked clipboard access") instead of silently doing nothing,
and the balance re-reads when the tab becomes visible again — the moment the
operator returns from the faucet page.

### Still blocked (unchanged)

1. **Convex serving** is refused for every query, mutation and action until the
   team owner upgrades the plan or reaches support@convex.dev. `taengine.freebuff.app`
   therefore stays on its standby screen even though deploys now succeed.
2. **FlashboltSolana is not deployed to devnet**: no funded deployer (~3 SOL) and
   no go-ahead. The SBF build works in CI and locally.
3. **Mainnet** still needs the independent audit plus explicit approval. The
   protected deployment `shiny-bulldog-311` was never touched.
4. **`bun run verify`** still needs a fresh 2/2 drill; the devnet faucet needs one
   human claim (the RPC faucet answers HTTP 410).

### New follow-ups — round 20

1. **Probe serving after every deploy, not just the upload.** The CI job now
   proves the push reaches Convex; it cannot prove Convex answers. One
   post-deploy request to a safe, non-spending query that fails the job on
   `Server Error` would have caught this outage in the same run instead of from
   an operator's browser. This is the highest-value gap the last two days found.
2. **Keep the login probe out of that CI check.** `gate:operatorLogin` spends one
   of the deployment's five login slots and needs the operator's real
   credentials, so the serving probe must be anonymous (or a read-only action);
   run `scripts/operator-login.mjs` by hand once the plan is restored.
3. **Test the arb path's no-settings refusal too.** `executeLiveArb` refuses
   without rail settings, but only the buy path has an entry-point test; the same
   null-key provider pattern would cover it in three lines.
4. **Prove the exit fallback on a real position.** The tests stop at the signer
   boundary by design. The next evidence is a devnet buy on Jupiter, a rail
   switch to `solcontract`, and a close that still lands — it needs a funded
   devnet wallet first.
5. **Extract one `CopyButton`.** There are now ten hand-rolled copy handlers
   (Wallets, SolWallets, Contract, Scanner overlays, SupportChat, this card) with
   three different failure behaviours. One component with a copied state, a
   timeout and a toast would make the next one a one-liner.
6. **Retire the stale airdrop line in DRILLS.md** (round 19, #8) — it still offers
   `solana airdrop … --url devnet` against the public RPC that answers 410.
7. **Assert the SBF toolchain versions** (round 19, #9). The workflow prints
   `cargo-build-sbf --version` but never checks it, so a silent channel swap
   would surface as a confusing compile error again.
8. **Give `backend-outage.ts` something to detect.** Convex returns only
   "Server Error" to clients when a deployment is disabled, so the in-app outage
   copy cannot fire. Until the serving probe exists, treat an operator-login
   failure with HTTP 200 + `status: "error"` as an outage signal and say
   "deployment unavailable" rather than "wrong credentials".
9. **Decide the faucet line's fate.** The copy button copies the command without
   its trailing comment; if the CLI line is dropped (follow-up 6), the copy
   payload has to change with it, or it will keep copying a command that cannot
   work against the default RPC.
