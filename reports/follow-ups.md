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

## Round 21 — 2026-11-22 · viewing the card found the balance bug, exit gate simplified, copies unified

**1. The devnet card was viewed against a real signer, and it showed `unknown`.**
A temporary harness (deleted before commit) generated a real ed25519 keypair,
imported it through the real vault, and rendered the real card on testnet. The
address appeared with its copy control, the prose correctly switched to "the
balance above is a live getBalance" — and the balance read `unknown` with no
error. That is the signature of a shape mismatch, not a slow RPC.

**2. `getBalance` returns `{ context, value }`, and four callers read it as a
number.** `postRpc` returns the JSON-RPC `result` verbatim, so:

- `preflightSolBuyBalance` compared an object against `typeof === "number"`,
  fell back to `0`, and every live snipe buy would refuse as unaffordable on a
  funded wallet;
- `executeLiveArb`'s baseline assigned the object to `initialSol`, tripped its
  own `typeof` guard and **aborted every live route** at `preflight-read`
  ("getBalance returned no numeric balance");
- the arb closing balance took the same path, so realized PnL was always
  unmeasured;
- `SolScanner`'s wallet strip and the devnet card both showed `unknown`.

The fix is one unwrapper, `fetchSolBalanceLamports(rpcUrl, owner)`, used by all
five sites (including a distinct "balance unreadable" refusal in the preflight,
so an RPC failure is no longer reported as poverty). After the fix the harness
read **0.0000 SOL** from `api.devnet.solana.com` for the armed key, and the copy
button wrote the exact CLI command (toast + `Copied` label) as intended.

**3. The exit gate is gone, because it could only ever pass.** Once an exit
ignored every non-Jupiter rail, `solSigningVerdict` had one reachable outcome
there. `executeLiveSnipeSell` now takes no `railSettings` at all, consults no
gate, and `SOL_POSITION_RAIL` is deleted — the invariant is stated where the
sell is built, and there is no parameter an older client could send to withhold
a close. Open paths keep the full gate.

**4. The arb gate now runs before the signer lookup, and is tested there.** The
old block sat after `resolveLiveSigner`, so its own comment ("before … the first
wallet prompt") was not true and a wallet-less caller got `no-wallet` instead of
the refusal. It moved to the top of `executeLiveArb`, and two entry-point tests
prove it: no settings → `rail-gate` + "nothing was signed", an armed
`solcontract` rail → "the active rail is solcontract".

**5. One copy control.** `useCopy()` + `CopyButton` (`src/components/CopyButton.tsx`)
replace eighteen hand-rolled copies in the devnet card, the Contract page (eight
sites), and both scanner-overlay panels — including their auto-copy, which now
shares the same denial toast. Success swaps the icon to a check for 2 s; a
blocked clipboard always says so.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling) — serving, not
   deploying, is what fails.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### New follow-ups — round 21

1. **Nothing had ever crossed the RPC boundary in a test.** Every live path is
   unit-tested up to the network and no further, which is exactly how an object
   read as a number survived. A single devnet smoke test (funded key, real RPC,
   assert balance > 0 and a quote) would have caught it; a recorded JSON-RPC
   fixture for `fetchSolBalanceLamports` is the cheap half.
2. **Trust the PnL numbers only after a funded round trip.** The arb baseline has
   never actually run with a numeric balance, so `realizedNetLamports` and the
   reported `netPct` have no live evidence behind them yet.
3. **Audit the other RPC result shapes.** `getBalance` was wrong in five places;
   `getTokenAccountsByOwner`, `getGenesisHash` and `getSignatureStatuses` were
   read correctly, but nothing enforces the shape at the transport.
4. **Finish the copy unification.** TradeHome, Wallets, SolWallets, Auth and the
   two passcode dialogs still hand-roll `writeText` + `toast`; SupportChat and
   History keep per-row state a shared button cannot express without a keyed
   variant.
5. **`SOL_POSITION_RAIL`'s rationale now lives only in the sell comment** — if a
   second exit engine ever appears, that paragraph is the requirement it must
   meet, not an optional nicety.
6. Round 19's DRILLS.md line and the `cargo-build-sbf --version` assertion are
   still open, as is the SBF v1 pin.

## Round 22 — 2026-11-23 · the balance boundary got a test, the copy control got a browser check

**1. `getBalance` is now exercised across a real HTTP boundary.** `src/lib/__tests__/sol-balance-read.test.ts` starts a `Bun.serve` JSON-RPC endpoint (no fetch stub, no mocking) and pins what the helper had only been asserted to do in prose: the `{ context, value }` envelope → `123456789`; the exact request (`getBalance`, `[owner, {commitment:"confirmed"}]`); a stringified value and a missing `value` both refused as "no numeric balance"; a node error surfaced verbatim ("node is behind"); an endpoint that is not JSON and a dead port both reject. Seven tests.

**2. The preflight verdicts are pinned too.** A funded 0.2 SOL wallet buys 0.1 SOL — the regression guard for the bug this helper fixed; a 0.104 SOL wallet is short by exactly 0.001 SOL; an RPC error says "could not be read" and never "short by"/"top up"/"Insufficient"; a malformed value takes the same branch; a real 0 balance stays a poverty verdict. Five more tests.

**3. The copy control was clicked in a browser.** On a standalone Vite page (deleted after) mounting the real `CopyButton`: the labelled button wrote `solana airdrop 2 abc --url devnet` to the clipboard, showed `Copied`, the `lucide-check … text-emerald-400` icon and a `Copied` toast; the icon-only button wrote its address and kept `aria-label="Copy devnet wallet address"`; with `writeText` rejecting `NotAllowedError` the toast read `Copy failed — Your browser blocked clipboard access — select the text and copy it manually.` and the button stayed on `Copy` with the copy icon, so a refusal never looks like a success. The app's own routes could not be used: `BackendPausedBoundary` wraps the router, so every route — public ones included — renders standby while Convex is paused (follow-up 5).

**4. The rendered contract is unit-tested** (`src/components/CopyButton.test.tsx`): one accessible name, `type`, visible label, icon-only default, `ariaLabel`/`title` overrides, `disabled`/`type=submit`, and that the copied value never enters the markup.

### Code review — fixed

1. `preflightSolBuyBalance`'s doc block had been left stacked above `fetchSolBalanceLamports`, so the new helper looked double-documented and the preflight itself undocumented; the doc also still claimed "throws only on RPC transport failure" after the function was changed to return a verdict. Both corrected.
2. The success check lost its green wherever a caller passed `iconClassName` (`iconClassName ?? "size-3.5 text-emerald-400"`): the devnet card (`size-3`) and Contract's "Copy source" (`size-4`) flashed a plain check. Now `cn(iconClassName ?? "size-3.5", "text-emerald-400")`.
3. The write path was untestable and treated "no clipboard API" as an exception. Extraction to `writeClipboard(text, clipboard?)` (`src/lib/clipboard.ts`) makes a denial and an absent API the same honest `false`, and keeps the component file's exports to the control.

### Code review — open findings

1. **`preflightSolBuyBalance` prints the full RPC URL into a user-visible refusal.** Private endpoints routinely carry a key in the path (`private-rpc.ts`), so this can put a credential into the UI, a screenshot or a support paste. Redact to a host/path shape before it is shown.
2. **The unreadable verdict asserts numbers it never measured:** `balanceLamports: 0` and `shortfallLamports: requiredLamports`. The message is honest, but a future consumer formatting those fields would say "short by 0.105 SOL" about an RPC failure. Prefer a `kind: "affordable" | "insufficient" | "unreadable"` discriminant.
3. **`use-sol-positions.ts` still reads `solRpcCall<{value:number}>` in four places** with no validation. `{ value }` is right today, but `undefined` would feed `NaN` into realized PnL. Route those reads through `fetchSolBalanceLamports`.
4. **The fit path trusts `balanceLamports: 0`.** With `fitToWallet`, an unreadable balance enters `fitRouteLoanToWallet`; the 0.05 SOL floor refuses it today, so behaviour is correct but incidental. Refuse explicitly before fitting.
5. **`BackendPausedBoundary` covers public routes.** `/download` and `/auth` show standby while Convex is paused — why this round verified the button on a standalone page. Decide whether public routes belong outside the boundary.
6. **`aria-label` stays "Copy" after the visible label says "Copied"**, so a screen reader hears the action and not the result. Minor.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling): serving, not deploying, is what fails.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### New follow-ups — round 22

1. **Only the balance read now has a wire-format test.** `fetchTokenBalanceRaw` and `getSignatureStatuses` are read correctly by inspection alone; the fixture server this round added makes pinning each shape cheap.
2. **The clicked state is browser-verified, not unit-tested.** If a DOM test environment ever lands, the three cases worth pinning are the 2 s reset, a rapid second click restarting the timer, and unmount cleanup.
3. **Finish the copy unification** (round 21, #4): TradeHome, Wallets, SolWallets, Auth and both passcode dialogs still hand-roll `writeText` + `toast`.
4. Round 19's DRILLS.md airdrop line and the `cargo-build-sbf --version` assertion remain open, as does the SBF v1 pin.
5. **The funded round trip still has no evidence** (round 21, #2): `realizedNetLamports`/`netPct` remain unmeasured against a real balance.

## Round 23 — 2026-11-23 · the round-22 follow-ups, and a second envelope bug

**1. RPC URLs are redacted before they reach a message.** `src/lib/redact.ts`
(`redactRpcUrl`) keeps the scheme and host, drops userinfo (`parsed.host`
excludes it), drops the query string entirely and masks any path segment long
enough to be a key (`/v2/<key>`). `preflightSolBuyBalance`'s unreadable verdict
now prints `https://mainnet.helius-rpc.com/?***` instead of the keyed URL.
`src/lib/__tests__/redact.test.ts` pins five cases, and the balance suite adds
one end-to-end: an endpoint carrying `?api-key=SUPERSECRETVALUE` produces a
refusal whose message does not contain the key.

**2. The verdict says which verdict it is.** `BuyAffordability` gained
`kind: "affordable" | "insufficient" | "unreadable"`. `ok: false` no longer
means "short" by implication, and the unreadable branch stops fabricating a
shortfall (`shortfallLamports: 0`) because nothing was measured. Both callers
(snipe buy and arb) now refuse an unreadable balance **before** the fit path, so
a zero that was never read can no longer clip a signal to nothing or tell a
funded operator to top up.

**3. Every balance read goes through one helper.** `use-sol-positions.ts` (four
reads: the realized-PnL baseline and delta on both the manual and automatic
exit) and `SolWallets.tsx` were the last `{ value: number }` callers; both use
`fetchSolBalanceLamports` now. An unreadable reply throws instead of feeding
`undefined`/`NaN` into realized PnL.

**4. Copy unification is finished in app source.** `copyText` moved to
`src/components/copy-text.ts` — same `writeClipboard` path as `CopyButton`,
same failure message — and the remaining fourteen
`navigator.clipboard.writeText` sites use it: Wallets (address, sheet),
SolWallets (address, sheet), TradeHome (address, deposit address, two account
detail blocks, email ×2), History (the tx-hash rows keep their check animation,
but only for a copy that actually happened), Auth and DesktopAppsDialog
(passcode), TelegramBotDialog (pairing code), Scanner (hot-wallet mnemonic) and
SupportChat (message bubble — silent success, reported denial).
`overlay-script.ts` and the extension `background.js` keep their own
`writeText`: an injected IIFE and an extension worker cannot import app modules.

**5. The other RPC shapes are pinned — and one was wrong.**
`src/lib/__tests__/sol-rpc-shapes.test.ts` (8 tests, real `Bun.serve`
JSON-RPC): `getTokenAccountsByOwner` sums accounts (700 + 300 → "1000") with the
exact `[owner, {mint}, {encoding:"jsonParsed", commitment:"confirmed"}]`
request, answers "0" for no accounts and skips an account with no parsed
amount; `getGenesisHash` is a bare string with `[]` params.
`getSignatureStatuses` answers `{ context, value }` — an RpcResponse — and
`waitForSigConfirm` read the result as a bare array, so `statuses[0]` was
`undefined` on every reply and **every landed transaction would have been
reported as "confirmation timeout" after the full 60 s wait**. Fixed to read
`value[0]`; a reverted tx now reports the node's own error object
(`{"InstructionError":[0,{"Custom":6001}]}`) instead of `String(err)`'s
`[object Object]`.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 758 pass / 0 fail across 65 files (744 → 758: +5 redact, +8 RPC
  shapes, +1 redaction end-to-end).
- `eslint` on the 18 touched files: 55 problems (45 errors, 10 warnings) —
  the pre-change baseline exactly, measured by stashing this round's diff. The
  extra fast-refresh warning `copyText` would have added was removed by moving
  it out of `CopyButton.tsx` instead of suppressing it.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling): serving, not
   deploying, is what fails.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### New follow-ups — round 23

1. **`getSignatureStatuses` has never been exercised against a funded tx.** The
   fix is pinned at the wire; the first funded devnet round trip is what proves
   it end to end.
2. `waitForSigConfirm` still polls every 1.5 s for a flat 60 s with no backoff.
   Fine for one tx, noisy for a burst.
3. `redactRpcUrl` masks a path segment by length (≥12 chars), so a real route
   like `/solana-mainnet` is over-redacted. Safe direction, imprecise.
4. Round 19's DRILLS.md airdrop line, the `cargo-build-sbf --version`
   assertion and the SBF v1 pin remain open.

## Round 24 — 2026-11-23 · the confirmation poll backs off, round 19 is closed

**1. The confirmation fix, restated.** Round 23 changed
`waitForSigConfirm` to read `getSignatureStatuses`' RpcResponse envelope
(`{ context, value }`) instead of a bare array. Before that, `statuses[0]` was
`undefined` on every reply — a landed transaction was reported as
**"confirmation timeout" after the full 60 s wait**, on every send path:
`executeLiveArb`, `executeLiveSnipeBuy` and `executeLiveSnipeSell`. A reverted
transaction now says what the node said (`{"InstructionError":[0,{"Custom":6001}]}`)
instead of `[object Object]`. That fix is pinned at the wire in
`sol-rpc-shapes.test.ts`; it still has **no funded-transaction evidence** — a
test server proves the parse, the first real devnet send proves the behaviour
(follow-up 1 below).

**2. The poll backs off instead of hammering.** The loop used a flat 1.5 s gap
for the whole 60 s, i.e. 40 requests per minute for every signature that had not
landed — a burst of exits paid that per transaction. It now probes immediately
and then waits `1.5 s → 3 s → 6 s → 12 s` (ceiling, exported as
`SIG_POLL_START_MS` / `SIG_POLL_MAX_MS`). A confirmation that lands in the first
slot is still seen in ~1 s: the first probe is not delayed. The schedule is
deterministic (no jitter) so it is pinnable, and the **final sleep is clamped to
the remaining timeout** — the old loop overshot a 20 ms wait by 1.5 s, which
also meant a sell whose signature was never seen could block 1.5 s past its own
deadline.

Two tests in `src/lib/__tests__/sol-rpc-shapes.test.ts` pin it against the real
`Bun.serve` JSON-RPC endpoint (no fetch stub): a 5 s wait sends exactly **three**
requests at gaps ≥ 1.3 s and ≥ 2.7 s and returns within 6 s (a flat loop sends
four), and a 50 ms wait sends one request and returns in under 700 ms.

**3. Round 19's DRILLS.md airdrop line is closed.** The drill still offered
`solana airdrop 2 … --url devnet` as an alternative; the CLI sends
`requestAirdrop` to the same public RPC faucet that answers HTTP 410, so the
line documented a path that cannot work. It now says the CLI is not an
alternative and names `solana-test-validator --url localhost` as the only
keyless path.

**4. Round 19's toolchain assertion is closed.** The program job printed the
versions and then built; a channel swap could therefore move the SBF compiler
and only fail 20 minutes later inside the build on an `edition2024` manifest.
The step is now `Assert the pinned toolchain`: it fails unless the
`cargo-build-sbf` on `PATH` is the crates.io build in `~/.cargo/bin` and its
version output names `platform-tools v1.57`. The workflow comment also records
why `--arch v1` is not a temporary typo.

**5. The SBF v1 pin stays — decided, not deferred.** Dropping it is a
dependency migration, not a flag change: SBPFv3 support starts at litesvm 0.18
(solana-* 4.x, MSRV 1.97.1), while the test harness is `anchor-lang 0.31.1` /
`solana-sdk 2.2` / `litesvm 0.7`. Moving LiteSVM means moving Anchor and the
program's SDK cohort, which touches the program and its IDL — a separate round
with its own evidence, and no bearing on the devnet or mainnet gate. The pin is
now documented in the workflow as exactly that.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 760 pass / 0 fail across 65 files (758 → 760: the two poll
  schedule tests).
- `eslint` on `src/lib/solana-live-execution.ts` and
  `src/lib/__tests__/sol-rpc-shapes.test.ts`: 0 problems.
- The workflow change was not executed: this sandbox has no GitHub runner, no
  Rust toolchain and no Solana CLI, so the assertion is syntax/YAML-checked only
  and its first real run is the next `solana-program` CI job.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling): serving, not
   deploying, is what fails.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 24, brainstormed (none started)

1. **Prove the confirmation fix on a funded devnet tx** (rounds 23–24, #1). One
   real send through `executeLiveSnipeBuy`'s path, asserting `confirmed: true`
   in ~1 s, closes the last gap between the wire pin and behaviour. Needs the
   human faucet claim the verify gate already waits on.
2. **Stop waiting once the blockhash expires.** Pass `lastValidBlockHeight`
   into `waitForSigConfirm`; when `getBlockHeight` passes it, a dropped tx is
   unrecoverable and the sell path should release the position immediately
   instead of holding it for 60 s. The backoff makes the wait cheap, not
   correct — this is the correctness half.
3. **`postRpc` ignores `res.ok`.** A 502/proxy HTML page becomes a JSON parse
   error with the body lost; the redaction helper exists, so surfacing
   `method + status + first line` (redacted) would make outages diagnosable.
   (Readiness report P2, still open.)
4. **Rebroadcast the same signed bytes after N misses.** `sendTransaction` runs
   with `maxRetries: 0`, so a dropped send currently costs a brand-new tx. The
   signed bytes are idempotent to resend; keeping the handle and re-sending
   after ~3 misses would rescue a tx the blockhash still allows.
5. **`redactRpcUrl`'s length heuristic over-redacts** `/solana-mainnet` (≥12
   chars). A key-shape test (base58-ish, length ≥32) would keep routes readable
   and keys masked; pin both directions in `redact.test.ts`.
6. **`solRpcCall` still returns `result` unvalidated.** The wire tests pin the
   three callers that exist; the next one can cast anything. A
   `readNumber`/`readArray` pair at the transport would make a missing `.value`
   a type error rather than a runtime `NaN`.
7. **`aria-label` stays "Copy" after the label says "Copied"** (round 22, #6).
   Screen readers hear the action, not the result.
8. **`BackendPausedBoundary` wraps public routes** (`/download`, `/auth`), so a
   paused backend hides the download page too (round 22, #5).
9. **The verify gate needs one human faucet claim** to produce a fresh 2/2
   drill inside 24 h; nothing in code can substitute for it.

## Round 25 — 2026-11-23 · RPC failures surface, expired txs fail, the bot purges on ten minutes

**1. Transport failures are named, not swallowed.** `postRpc` read `res.json()`
unconditionally, so a 502 proxy HTML page, a 429 with a JSON error body and a
genuinely non-JSON 200 all collapsed into the same opaque parse error — with the
body (the useful part) thrown away. It now reads the body once and reports the
four cases as themselves: non-2xx (`getBalance failed at <endpoint> — HTTP 502:
<h1>502 Bad Gateway</h1>`), a non-JSON 200, the node's JSON-RPC error (with its
code), and a reply whose body has no `result` field (previously `undefined` was
cast to `T`). Every message carries the method and the REDACTED endpoint, so an
outage is diagnosable without leaking a provider key.

**2. A dead blockhash fails at the expiry instead of after 60 s.** Jupiter's
swap build returns `lastValidBlockHeight`; all three send paths
(`executeLiveSwap`, `executeLiveSnipeBuy`, `executeLiveSnipeSell`) now pass it
into `waitForSigConfirm`, which reads `getBlockHeight` FIRST each pass and
returns `{ confirmed: false, expired: true }` the moment the network moves past
it. Before this, a dropped exit held its position for the full timeout waiting
for a transaction that could never land. Expiry is checked before the status
call, so a dead tx costs one cheap height probe even when
`getSignatureStatuses` is the call that is failing. Omitting the option keeps the
old behavior exactly (no extra requests), which is why the existing schedule
tests still pin three requests for a 5 s wait.

**3. URL redaction is shape-based, not length-based.** The old helper masked
every path segment of 12+ characters, so a real route like `/solana-mainnet` was
over-redacted while a short provider key would have survived. `looksLikeRpcKey`
now masks by SHAPE — hex ≥16, UUID, mixed-case alphanumeric blob ≥16, unbroken
≥24, or a segment that names itself a key/secret/token/auth/signature — and
leaves human routes readable. Query values are masked but their NAMES survive
(`?api-key=***` tells the operator which endpoint shape failed), and the fragment
is never printed.

**4. The bot now deletes its own messages every ten minutes.** Every message the
bot posts (boards, digests, trade alerts) and every post to the configured
channel is recorded with Telegram's real `message_id` in the new
`telegramBotMessages` table. The `*/10` cron `telegram-bot-purge` deletes them
once they are older than `BOT_MESSAGE_TTL_MS` (10 min) in bounded batches, and
removes each row as it goes so a retried sweep can never double-delete. A chat
that gets a board every few minutes now shows the last ten minutes instead of an
unbounded scrollback. It is a no-op with auto-purge off (default ON), and the
switch exists in BOTH places the operator works: the bot's `/alerts` board
(`set:purge_on` / `set:purge_off`) and the app's Telegram Bot panel.

**5. Every menu command answers when clicked.** Command resolution moved into
`resolveCallbackData` in the presentation layer, and the dispatcher's switch is
now EXHAUSTIVE over `BotCommand` (`const unhandled: never = cmd` in the final
branch) — a new command kind with no case is a typecheck failure, not a silent
fallback. A new parity test walks every keyboard every builder can emit (32
boards) and asserts each `callback_data` resolves to a kind in
`HANDLED_COMMAND_KINDS` and stays within Telegram's 64-byte limit; it also parses
every `/command` the help board advertises and fails on an unknown one. Added
`/purge` (clear this chat now) and the missing `/engines`, `/bnb_on`,
`/bnb_off`, `/bnb_paper`, `/bnb_live`, `/sol_on`, `/sol_off`, `/digest`,
`/sound`, `/silence`, `/unpair` entries to Telegram's own `setMyCommands` menu so
the native menu matches the board.

### Checks

- `bun run typecheck`: exit 0 (including the new `never` exhaustiveness check).
- `bun test`: 778 pass / 0 fail across 66 files (760 → 778: +3 redaction cases,
  +7 transport/expiry wire tests, +8 menu-parity tests).
- `eslint` on the twelve touched files: the pre-change baseline exactly (2
  notifications, 4 dialog, 12 convex bot, 2 lib bot — all pre-existing, measured
  by linting `git show HEAD:<file>`), 0 new problems. The one new-file warning
  was fixed rather than suppressed.
- NOT executed: the Convex deploy/cron (deployment still disabled by the
  free-plan ceiling), and any live Telegram call — this sandbox has no bot token
  and no outbound Telegram access, so the purge sweep and the new buttons are
  wire-tested and type-checked, not driven against the real Bot API.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling): serving, not
   deploying, is what fails.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 25, brainstormed (none started)

1. **Prove confirmation + expiry on one funded devnet send.** The wire tests pin
   both, but the first real send is what proves `confirmed: true` in ~1 s and
   `expired: true` on a dropped tx. Still waiting on the same faucet claim.
2. **Skip the extra height read.** `getBlockHeight` runs once per probe whenever
   an expiry is supplied, doubling requests for a slow tx. `getSignatureStatuses`
   already returns `context.slot`; using the slot as the height (or caching the
   height for `SIG_POLL_START_MS`) removes the extra call.
3. **Redact URLs inside error bodies.** `postRpc` redacts the endpoint but an
   RPC body can echo a URL containing a key; run `redactRpcUrl`-style masking
   over embedded `http(s)://…` tokens in the surfaced line.
4. **Stop tracking messages that can no longer be deleted.** The Bot API refuses
   `deleteMessage` after 48 h; when auto-purge is off for a long time, rows pile
   up and every sweep counts failures. Drop rows older than 48 h without a send.
5. **Add a `(chatId, sentAt)` index.** `/purge` filters by chat after a
   `by_chat.take(100)`, so a chat with >100 fresh messages can starve older ones
   in one pass; a composite index makes the window exact.
6. **Move the inline keyboards built in `handleUpdate` into lib builders.** The
   parity test covers builder keyboards, not the ones assembled inline for
   boot/pairing/claim replies; moving them makes the contract complete.
7. **Surface partial expiry reads.** A failing `getBlockHeight` is currently
   swallowed; carrying a `heightReadsFailed` count in the result would let a
   caller distinguish "still valid" from "could not check".
8. **Rebroadcast signed bytes after ~3 misses** (round 24, #4, still open) —
   `sendTransaction` uses `maxRetries: 0`, and the signed bytes are idempotent
   to resend while the blockhash is valid.
9. **Refresh the Trade price cache on a cron.** `/prices`, `/markets` and
   `/trade` read a cache that only refreshes while a UI (or the bot dashboard)
   opens it, so a quiet period makes the bot say "rates not loaded".

---

## Round 26 — the channel purge gets its own scope, and a passing confirmation stops paying for a height probe (2026-11-23)

Four items: scope the channel purge, stop the second RPC in the confirmation
loop, put the purge window under direct test, and re-rank the follow-ups.

### 1. Channel purge and chat purge are separate scopes

Round 25 tracked channel posts but deleted them under the same `autoPurge` flag
as chat boards. That couples two different things: a chat board is scrollback
that should not accumulate, while the channel is a feed the operator may want
to keep. `telegramBotConfig.channelPurge` (default ON, `!== false`) now scopes
channel posts on their own:

- `purgeBotMessages` runs two source-scoped passes — `source: "bot"` whenever
  `autoPurge` is on, `source: "channel"` only when `channelPurge` is on.
  `autoPurge` stays the master switch.
- `/purge` in a chat is `{ chatId, source: "bot" }`: it can no longer select a
  channel row even if a chat id and the channel id ever coincided, and its reply
  says so.
- `/alerts` carries both switches (`set:purge_on|off`, `set:channel_on|off`),
  and the app's Telegram Bot panel gets the matching `setChannelPurge` switch.
- `takeStaleMessages` accepts `source`, and ONE pure rule (`selectPurgeable`)
  decides what any sweep may delete — cron, `/purge` and the panel share it.

### 2. One RPC per confirmation pass

`waitForSigConfirm` used to read `getBlockHeight` first on every pass whenever
an expiry was supplied. But `getSignatureStatuses` already answers with
`context.slot`, and a block height can never exceed its slot — so a slot at or
below `lastValidBlockHeight` PROVES the tx is still inside its window. The
status probe now runs first and the height probe is only sent when the slot is
missing (status failure) or past the window:

- landed tx: 1 request (was 2) — it returns before any height read;
- waiting tx inside its window: 1 request per pass (was 2);
- tx past the window: status + height, then `expired: true` immediately, so the
  fast-fail behaviour from round 25 is preserved (it now costs two cheap reads
  on the dead pass instead of one);
- a failing status call leaves the slot null, so the height probe still runs:
  an RPC outage cannot hide a dead blockhash (pinned by a 503 wire test).

The slot is deliberately NOT used as the height, which is what round 25's
follow-up #2 suggested. Skipped slots make the slot run AHEAD of the block
height, so substituting it would kill a live transaction early; the slot is an
upper bound, and this round uses it only as one.

### 3. The purge window and its scope are unit-tested

New `src/lib/__tests__/bot-purge-window.test.ts` (11 tests) pins `purgeCutoff`
and `selectPurgeable`: exactly ten minutes old is due and 1 ms younger is not; a
message posted now survives; future timestamps (clock skew) and non-finite
`sentAt` are never guessed at; chat scope and surface scope; `/purge`'s
`{ chat, bot }` scope cannot see a channel row; and a three-day-old row is still
selected, so a Telegram-refused delete cannot pin a row in the table forever.
`telegram-menu.test.ts` also pins the channel switch (ON when the field is
omitted, OFF leaves the chat sweep untouched).

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 793 pass / 0 fail across 67 files (778 → 793: +11 purge-window
  tests, +3 confirmation wire tests, +1 channel-switch test).
- `eslint` on the eight touched files: 18 problems, exactly the pre-existing
  baseline (4 dialog, 12 convex bot, 2 lib bot). The one new unused-import
  error (`BOT_MESSAGE_TTL_MS` after the cutoff moved into `purgeCutoff`) was
  fixed rather than suppressed, and the new test file lints clean.
- NOT executed: the Convex deploy/cron (deployment still disabled by the
  free-plan ceiling), any live Telegram call (no token, no outbound Telegram in
  this sandbox), and any funded devnet send.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 26, brainstormed (none started)

1. **Prove confirmation + expiry on one funded devnet send** (round 25 #1).
   Still waiting on the faucet claim; the wire tests pin the logic, not the
   network.
2. **Redact URLs inside error bodies** (round 25 #3). `postRpc` redacts the
   endpoint, but a node's error text can echo a keyed URL.
3. **Drop tracked rows older than 48 h without a send** (round 25 #4). With
   auto-purge off for a long time, every sweep re-counts the same refused
   deletes; the Bot API will never delete them.
4. **Add a `(chatId, sentAt)` composite index** (round 25 #5). `/purge` filters
   after `by_chat.take(100)`, so >100 fresh messages in one chat can starve its
   older rows in a single pass.
5. **Cache the height once the slot passes `lastValidBlockHeight`.** Inside the
   window the height read is now free; past it, a sweep can read the height on
   every remaining pass. One read per `SIG_POLL_START_MS` is enough.
6. **Surface partial expiry reads** (round 25 #7): carry a
   `heightReadsFailed` count so a caller can tell "still valid" from "could not
   check".
7. **Rebroadcast signed bytes after ~3 misses** (round 24 #4). `maxRetries: 0`
   plus an idempotent signed tx means a resend is free while the blockhash is
   valid.
8. **Refresh the Trade price cache on a cron** (round 25 #9). A quiet period
   otherwise makes `/prices` and `/trade` say "rates not loaded".
9. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
   #6): the parity test only walks builder keyboards today.
10. **Show purge telemetry on `/alerts`** — last sweep time, deleted/failed
    counts and the tracked-row count — so an operator can tell "nothing to
    purge" from "the sweep is not running" without opening Convex.
11. **Reconcile the digest TTL with the purge TTL.** The digest cron is every
    15 min and the purge window is 10 min, so a digest can be deleted before
    the next one replaces it; either give digests a longer TTL or align the
    schedules.
12. **Track channel ids, not one channel.** `trackChannelMessage` reads
    `TELEGRAM_CHAT_ID` at send time; if alert routing ever supports more than
    one channel, the purge needs per-target ids rather than one ambient value.

---

## Round 27 — a late height read is shared, and the digest now fits inside the purge window (2026-11-23)

Two follow-ups from round 26: cache the height probe once the slot is past the
window, and reconcile the digest cadence with `BOT_MESSAGE_TTL_MS`.

### 1. `readBlockHeight` — memoized and single-flight per endpoint

Round 26 stopped paying for a height read inside the blockhash window, but a
wait past the window still read `getBlockHeight` on every remaining pass, and
every waiter in a burst read it independently. `readBlockHeight(rpcUrl)` now
serves both: a reading is reused for `HEIGHT_READ_TTL_MS` (1.5 s — one poll
gap), and concurrent callers share the in-flight request, so N positions
closing together send ONE probe to the node instead of N.

The reuse is safe in exactly one direction, and that direction is the one that
matters: a block height only grows. A cached height already past
`lastValidBlockHeight` is still past it (so a stale reading can never keep a
dead transaction alive), and a reading still inside the window can only delay
the expiry verdict by its own age — under one status pass — never invent one.
The slot is still never used AS the height. Failures are not cached; the map is
per endpoint with 8 entries, oldest evicted, and `maxAgeMs <= 0` forces a fresh
read.

Honest limit: inside a single waiter the poll gap already starts at
`SIG_POLL_START_MS` (1.5 s) and doubles, so the TTL rarely skips anything for
one caller. The win is the burst, plus short waits that probe twice in a
millisecond (the drill's 40–50 ms paths do not, but a rejection path retried
quickly does). Confirmation request counts per waiter are unchanged.

### 2. The digest runs every 10 minutes, like the purge

The digest cron was `*/15` while the purge deletes at 10 minutes, so every
digest was deleted 5 minutes before its replacement posted — a chat with the
digest on sat with no dashboard for a third of every cycle. The cadence is now
`*/10`, the same window as `BOT_MESSAGE_TTL_MS`, so the sweep always deletes an
older digest while a newer one is already in the chat. The alternative (a
second, longer TTL for digest rows) was rejected: one constant keeps the
invariant the constant documents — a purge never removes the only copy of a
number — and no source-scoped TTL plumbing is needed.

Because both crons sit on the same offsets, cron ordering is not guaranteed, so
one tick can delete a digest seconds before the next one lands, and a digest
can survive a second tick (~20 min, at most two visible) when it posted just
after the purge ran. Both are bounded; the 5-minute hole is gone. Cost: 144
digest runs/day instead of 96 (+48, ~0.2% of the 30k call budget), each reading
the cached fleet-metrics doc rather than scanning tables. The panel chip and
`/alerts` now say 10 min, not 15.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 796 pass / 0 fail across 67 files (793 → 796: +3 wire tests —
  two concurrent waiters share one `getBlockHeight`, a fresh reading is reused
  while `maxAgeMs: 0` re-reads, and a failed read is not cached).
- `eslint` on the five touched files: 2 problems, both the pre-existing
  `\_` escapes in `src/lib/telegramBot.ts` (lines 887, 1271) — the same two
  that were there before this round, and none in the new code or the test.
- NOT executed: the Convex deploy/cron (deployment still disabled by the
  free-plan ceiling), any live Telegram call, and any funded devnet send — so
  the cached-height path is pinned at the wire (two concurrent waiters, one
  `getBlockHeight`) but not on a real cluster.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 27, brainstormed (none started)

1. **Prove the cached path on a funded send** (round 26 #1). The wire test
   pins the sharing; only the cluster can prove a real expiry verdict.
2. **`heightReadsFailed` count** (round 25 #7, still open): a caller cannot
   tell "still valid" from "could not check".
3. **Redact URLs inside error bodies** (round 25 #3, still open).
4. **Drop tracked rows older than 48 h without a send** (round 25 #4).
5. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
6. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
7. **Refresh the Trade price cache on a cron** (round 25 #9).
8. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
   #6).
9. **Show purge telemetry on `/alerts`** (round 26 #10).
10. **Track channel ids, not one channel** (round 26 #12).
11. **Order the digest before the purge inside a tick.** Convex does not
    guarantee cron order, so a `*/10` digest and a `*/10` purge can land either
    way round; a distinct offset (`2-59/10`) plus a purge TTL a minute longer
    than the cadence would make "replace, then delete" deterministic.
12. **Let the operator choose the digest cadence** (5/10/15 min) in the panel,
    with the purge window following it — one number, two schedules, so they can
    never drift apart again.

## Round 28 — the tick has an order, the sweep reports itself, and the app cleans its own room (2026-11-23)

Three follow-ups from round 27: make the ordering a schedule property, surface
what the purge actually did, and apply the same "delete only what is already
useless" rule to the browser's local data.

### 1. Tick ordering is now a schedule, not a race

The digest and the purge both fired on `*/10`, and Convex does not order crons
that share an offset — a tick could delete a 10-minute-old digest seconds before
its replacement posted. The digest keeps minute 0 of every ten (`*/10`); the
purge moved to `1-59/10` (…:01, :11, :21). The sequence is deterministic: the
fresh digest lands at :00, the sweep at :01 deletes the previous one (11 minutes
old, past `BOT_MESSAGE_TTL_MS`), and the one-minute-old digest stays. "Replace,
then delete" is now a property of the schedule, so no amount of cron reordering
can empty a chat's dashboard.

`src/lib/__tests__/cron-ordering.test.ts` reads the real `crons.ts`, expands
the minute fields and holds three properties: the digest owns [0,10,…,50], the
purge owns [1,11,…,51], and every purge minute has a digest exactly one minute
earlier — with the TTL arithmetic checked against the constant itself.

Not changed, deliberately: the `session-signal` cron still runs every 15
minutes and posts a channel board that the 10-minute channel purge deletes, so
the channel can show a ~5-minute gap each cycle. Fixing that is a product
decision (post more often, keep channel posts longer, or push the board on the
digest tick), so it is the first follow-up below rather than a silent change.

### 2. Purge telemetry — the sweep says what it did, including nothing

Until now a sweep that deleted nothing was indistinguishable from a sweep that
never ran. Every outcome is now stamped on `telegramBotConfig`
(`purgeLastAt/Deleted/Failed/Skipped`) by a `stampPurgeRun` mutation — including
`auto-purge off`, `bot token not configured` and `channel purge off`. The tally
renders in one place (`purgeTelemetryLine`): `/alerts`, the bot panel's
auto-purge card, and the header chip's tooltip. An absent tally reads "not
reported yet", and a deliberate no-op says why; neither is ever drawn as
"0 deleted", which would read as a healthy sweep. Stamping is best-effort — a
failed stamp can never turn a delivered delete into a failed one.

Two honesty fixes came with it: a missing config row now reports "not
configured" instead of claiming "auto-purge off", and `getBotHealth` carries
the same tally so the chip and the dialog cannot disagree.

### 3. The app's own ten-minute sweep (local data)

`src/lib/local-retention.ts` runs at boot and every 10 minutes
(`startLocalRetention()` in `main.tsx`) against the same window as the backend
sweeps and the bot TTL. It removes only data the app has ALREADY stopped
reading:

- `tracker_<key>` rows whose `date` is not today's UTC day — `loadDailyTracker`
  resets a date-mismatched tracker on read, so the numbers are already invisible;
  removing the row only stops it occupying storage;
- `flashbolt.botDialogReopen` — a one-shot navigation flag consumed by the first
  mount.

Everything else is kept by contract, not by luck: gate grant and device-trust
token, positions and the payout ledger and circuit breaker, relay latency
history and TODAY's counters, every settings/RPC-discovery key — and any key the
module does not recognise, because a key it has never heard of may belong to
another feature. `local-retention.test.ts` seeds all of those and asserts none
of them moves.

On the backend the same rule was extended to the one unbounded ephemeral table
left: `telegramBotMessages` rows older than 48 h now go in the 10-minute
retention sweep. Telegram refuses `deleteMessage` past 48 h and the message
itself lives in the chat, so such a row is bookkeeping that can never be acted
on again — it only survives when no sweep could run at all.

### 4. What was deliberately kept

The retention contract is unchanged for everything that is money, identity or a
report: trade ledgers, `pnlStats`, LIVE executions, users, subscribers, licenses,
operator emails, audit logs (own 7-day prune), chain-activation evidence,
validation runs and code inspections. Trade price and news caches are
single-row and refreshed in place, so they are not swept — deleting them would
only force a refetch.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 815 pass / 0 fail across 69 files (796 / 67 → +19 tests in two
  new files: cron ordering and local retention, plus the telemetry cases added
  to the purge-window and alerts-board suites).
- `eslint` on the touched files: no new problems. The remaining errors are the
  pre-existing ones in `src/convex/telegramBot.ts` (unused imports),
  `src/convex/retention.ts` (`v`), `src/main.tsx` (`any`, fast-refresh warnings)
  and `src/lib/telegramBot.ts` (two `\_` escapes) — the same set as round 27,
  none in the new code. The chip's `Date.now()` in render was caught and moved
  into a lazy `useState` initializer.
- NOT executed: the Convex deploy (deployment still disabled by the free-plan
  ceiling), so the new crons, the telemetry stamp and the retention extension
  are code-only; no live Telegram call, and no funded devnet send.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling) — the tick
   offset, telemetry and retention changes take effect only after a deploy.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 28, brainstormed (none started)

1. **Close the channel session-board hole.** `session-signal` posts every 15 min
   but the channel purge deletes at 10, so the channel is empty for ~5 min each
   cycle. Pick one: move the board to `*/10`, give channel posts a longer TTL
   than chat boards, or post the board on the digest tick.
2. **Prove the telemetry on a live deployment.** The stamp is pinned at the
   unit level only until `convex deploy` runs.
3. **Alert when two sweeps in a row report failures.** The tally is visible but
   passive; a `failed > 0` twice in a row is a real signal (revoked bot admin,
   deleted chat) and should ping the operator.
4. **Keep a short sweep history, not just the last one.** Last-only cannot show
   "the sweep stopped running six hours ago"; a 12-entry ring of {at, deleted,
   failed} would.
5. **Contract test for the backend keep-list.** The client sweep has one; the
   retention sweep's KEPT list is still a comment. A test that seeds each
   permanent table and asserts the sweep's selection excludes it would make the
   contract executable.
6. **Expired `operatorDeviceTrust` sweep.** Dead identity rows accumulate; it
   needs a `by_expires` index, and index changes are blocked while codegen
   cannot run against the deployment.
7. **Prove the cached height path on a funded send** (round 27 #1, carried).
8. **`heightReadsFailed` count** (round 25 #7, carried): "still valid" and
   "could not check" still look alike to a caller.
9. **Redact URLs inside RPC error bodies** (round 25 #3, carried).
10. **Add a `(chatId, sentAt)` composite index** (round 25 #5, carried) — now
    also the shape the purge's per-chat scope would want.
11. **Rebroadcast signed bytes after ~3 misses** (round 24 #4, carried).
12. **Operator-selectable digest cadence** (round 27 #11, carried): once it is
    a stored number, the purge offset must be derived from it too, or the
    ordering guarantee quietly breaks.
13. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6, carried).
14. **Track multiple channel ids, not one env id** (round 26 #12, carried).
15. **Show the local sweep in Settings.** `runLocalRetention` already returns
    {at, removed, remaining}; a one-line data-health row would make the app-side
    purge as inspectable as the bot's.

---

## Round 29 — the tally stops lying, the channel keeps its board, and a failing sweep speaks up (2026-11-23)

Three follow-ups from round 28: fix the tally a scope switch was hiding, close
the channel's session-board hole, and alert when two sweeps in a row fail.

### 1. The tally reports the work, not a switch

Round 28 stamped `skipped: "channel purge off"` whenever the channel scope was
off — even though the chat sweep still ran and may have deleted a dozen
messages. `purgeTelemetryLine` then rendered `skipped (channel purge off)` and
dropped the real `deleted`/`failed` counts. The operator saw a stand-down where
a sweep had done work.

- `purgeSkipNote({ autoPurge, tokenConfigured, channelPurge? })` now owns the
  rule: only `auto-purge off` and `bot token not configured` are full
  stand-downs. It accepts `channelPurge` and deliberately ignores it, so the
  regression is pinned by an executable contract, not a comment.
- `purgeBotMessages` stamps counts with no skip note when the channel scope is
  off; the switch itself is already shown by `/alerts`, the dialog and the chip
  (`getBotHealth` now carries `channelPurge`).
- `purgeTelemetryLine` was also made additive: if a skip note ever arrives with
  real counts (a row written by the older code, a future partial reason), the
  counts render in front and the note is appended — a tally is never hidden by
  a label.

### 2. The channel window covers one session-board cycle

`session-signal` posts the channel board every 15 minutes (`*/15`), while the
channel sweep deleted channel posts at 10 minutes. At the :11 and :41 sweeps a
board 11 minutes old was deleted and the next board only landed at :15/:45 — a
~5-minute hole in the channel every cycle.

`CHANNEL_MESSAGE_TTL_MS` is now 15 minutes, used only for `source: "channel"`;
chat posts keep `BOT_MESSAGE_TTL_MS` (10 min). Chosen over moving the board to
`*/10` because it costs zero extra Telegram sends or cron runs on a deployment
that is already disabled by its free-plan ceiling, and over "post on the digest
tick" for the same reason. Sweep quantisation means a board is actually removed
11–21 minutes after it posted, always with a newer board already in the
channel.

`cron-ordering.test.ts` now reads the real cron specs and asserts the invariant
that matters: at every purge minute, the newest session board is younger than
the channel window. The same check fails with the old 10-minute window, so the
hole cannot come back silently.

### 3. Two failing sweeps in a row alert the operator

A single failed delete can be a transient 5xx. The same failure in the next
sweep is a fault — the bot was removed from the chat/channel or lost its delete
rights. `purgeBotMessages` now compares this sweep's `failed` with the tally it
read at the top (`cfg.purgeLast`, i.e. the previous sweep), so the streak needs
no new stored state, and sends `purgeFailureAlert` to every linked chat when
both are non-zero. Both real tallies are in the message, plus the honest
consequence: Telegram-refused messages leave the tracking table, so they stay
in the chat even after rights are restored. The alert repeats while the fault
lasts (the sweep's own 10-minute cadence) and stops on the first clean sweep; it
is best-effort, so an undeliverable alert never turns a sweep into a failure.

### 4. What this round does NOT fix

A failed `deleteMessage` still drops its tracking row, so a transient failure
loses that message from future sweeps. That is why the alert promises only that
NEW posts purge again. Retrying transient failures (attempt first, then drop the
row only on success or a permanent refusal) is follow-up #1 below, not a silent
change here.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 825 pass / 0 fail across 69 files (815 → +10: three channel-window
  cases, two skip-note cases, three alert cases, one additive-tally case, one
  cron invariant).
- `eslint` on the eight touched files: 18 problems, exactly the pre-existing
  baseline (4 dialog, 12 convex bot unused imports, 2 `\_` escapes) — none in
  the new code or tests.
- NOT executed: the Convex deploy (deployment still disabled by the free-plan
  ceiling), so both windows, the tally change and the alert are code-only; no
  live Telegram send, and no funded devnet send. The new dialog/chip copy was
  not viewed in a browser.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 29, brainstormed (none started)

1. **Retry transient delete failures.** Attempt `deleteMessage` BEFORE dropping
   the row; drop it only when Telegram accepts or refuses permanently
   ("message to delete not found", "too old"). Today one network blip
   permanently untracks a live message. This is the largest correctness gap in
   the sweep.
2. **Prove the window, tally and alert on a live deployment** (round 28 #2).
   Unit tests pin the arithmetic; only a deploy shows the stamps and a real
   failure alert.
3. **Record the alert in-app too.** The failure alert depends on Telegram being
   able to reach the operator; the same condition also belongs in the app's
   notification bell, which works even when the bot is the thing that is broken.
4. **Keep a short sweep history, not just the last one** (round 28 #4).
   Last-only cannot show "the sweep stopped running six hours ago".
5. **Contract test for the backend keep-list** (round 28 #5).
6. **Expired `operatorDeviceTrust` sweep** (round 28 #6; still needs an index).
7. **Prove the cached height path on a funded send** (round 27 #1).
8. **`heightReadsFailed` count** (round 25 #7).
9. **Redact URLs inside RPC error bodies** (round 25 #3).
10. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
11. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
12. **Operator-selectable digest cadence** (round 27 #11): the purge offset must
    be derived from it, and the channel window from `session-signal`'s cadence.
13. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
14. **Track multiple channel ids, not one env id** (round 26 #12).
15. **Show the local sweep in Settings** (round 28 #15).

---

## Round 30 — the sweep retries instead of forgetting, and the fault reaches the bell (2026-11-23)

Two follow-ups from round 29, plus the re-ranked list. This closes the largest
correctness gap in the purge: a delete that failed for a reason that can heal
used to lose its tracking row forever.

### 1. Attempt first, drop on a verdict

The sweep used to `takeStaleMessages` — remove the rows in the same mutation
that handed them to the action — and then call Telegram. Any refusal, transient
or permanent, therefore untracked the message: a 5xx, a rate limit, or the bot
briefly losing admin rights left the message in the chat with no row to retry
and no way to ever remove it. The round-29 alert had to promise only that NEW
posts would purge again.

The order is now inverted:

- `listStaleMessages` (internal query) returns the due rows WITHOUT deleting
  them;
- `deleteTrackedMessages` attempts `deleteMessage` for each, then drops the row
  (`dropTrackedMessages`) only when Telegram has a verdict:
  - accepted → counted `deleted`, row dropped;
  - refused permanently → counted `failed`, row dropped;
  - refused transiently → counted `failed`, row KEPT and counted `retrying`.
- `classifyPurgeFailure(description)` owns the verdict: `permanent` only for
  "message to delete not found", "message can't be deleted", "message is too
  old" and invalid message ids — the cases where Telegram will never accept a
  delete. Missing rights, a kicked bot, `chat not found`, 429s, 5xx and network
  errors are `transient`, because restoring rights or waiting heals them.
- Rows attempted in one run are skipped by id, so a retry backlog cannot make
  the bounded batch loop spin; the next sweep (10 minutes later) retries them.
  The 48 h retention sweep remains the backstop for a row that never settles.
- A retried delete is harmless: deleting a message that is already gone comes
  back as "message to delete not found", which settles the row.

The tally keeps `deleted`/`failed`; `failed` now means "refused this sweep" and
includes retries. `purgeChatMessages` carries `retrying` too, and `/purge`'s
reply tells the operator which failures will be retried versus which are final
(already gone or past Telegram's 48 h limit).

### 2. The fault alert reaches the in-app bell

The Telegram alert is useless exactly when Telegram is the broken channel. The
same two-in-a-row trigger now also writes a notification for every operator
user (resolved from `terminalStates` owners and gated by `isOperatorEmail`), so
the bell shows the fault with the same tallies. The body is one shared builder
(`purgeFailureSummary`) rendered plain for the bell and with a bold header for
Telegram — the numbers cannot drift between the two channels.

Deduped to one entry per hour per operator while the fault persists: the sweep
runs every 10 minutes, and a badge climbing six times an hour would bury the
signal. Writing the bell entry is independent of linked chats existing, and
best-effort like every other part of the alert.

Honest limitation: the notifications kind union has no bot-health literal, and
adding one changes the generated data model, which needs `convex codegen`
against a deployment — blocked while serving is disabled (codegen without a
deployment fails on `CONVEX_DEPLOYMENT`). The entry therefore uses the existing
`session_update` system-event bucket and says what it is in its title/body.
Follow-up #2 below adds a distinct kind once codegen can run.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 828 pass / 0 fail across 69 files (825 → +3: one shared-summary
  test and two classification tests covering every permanent and transient
  description shape the Bot API returns).
- `eslint` on the five touched files: 17 problems, the pre-existing baseline
  (12 convex bot unused imports, 2 `\_` escapes, 2 notifications, 1 bell
  warning) — none in the new code or tests.
- NOT executed: the Convex deploy (still disabled by the free-plan ceiling), so
  the retry ordering, the new internal query/mutation and the bell entry are
  code-only; no live Telegram call, no browser view of the bell, and no funded
  devnet send.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 30, brainstormed (none started)

1. **Prove the retry path on a live deployment.** The one thing unit tests
   cannot show: a revoked admin right, a restored right, and the same rows
   deleted on the next sweep. Until a deploy runs, the ordering is code-only.
2. **Add a `bot_health` notification kind.** Needs `convex codegen` against a
   deployment; then the bell gets its own icon and dedupe key instead of
   borrowing `session_update`.
3. **Stop alerting every 10 minutes on a long fault.** The alert repeats each
   sweep while failures continue (deliberate: it is an active fault), but a
   fault that lasts hours should escalate once, not 36 times. A stored
   `purgeAlertedAt`/streak length would let it alert at 2 sweeps and then only
   every hour.
4. **Bound retry attempts per row.** A transient classification that never
   heals (`chat not found` for a deleted group) keeps a row until the 48 h
   retention sweep. That is safe because retention is a hard backstop, but an
   `attempts` counter would settle it sooner and make the "stuck" state
   visible.
5. **Keep a short sweep history** (round 28 #4) — last-only still cannot show
   "the sweep stopped running six hours ago".
6. **Expose `retrying` in the stored tally.** The sweep returns it, but `/alerts`
   and the chip only see `failed`; a stored count would show whether a fault is
   draining. Needs a schema field and codegen.
7. **Contract test for the backend keep-list** (round 28 #5).
8. **Expired `operatorDeviceTrust` sweep** (round 28 #6; needs an index).
9. **Prove the cached height path on a funded send** (round 27 #1).
10. **`heightReadsFailed` count** (round 25 #7).
11. **Redact URLs inside RPC error bodies** (round 25 #3).
12. **Add a `(chatId, sentAt)` composite index** (round 25 #5) — the retry path
    still filters a chat's rows after `by_chat.take(100)`.
13. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
14. **Operator-selectable digest cadence** (round 27 #11).
15. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
16. **Track multiple channel ids** (round 26 #12).
17. **Show the local sweep in Settings** (round 28 #15).

## Round 31 — the fault alert is throttled, and the retry backlog is visible (2026-11-23)

Two round-30 follow-ups, both about telling the operator the truth without
becoming noise: a persisting purge fault no longer pings every chat six times
an hour, and a sweep now reports how many of its refusals are coming back.

### 1. A persisting fault alerts hourly, not every 10 minutes

Round 30 alerted on two consecutive failing sweeps and then repeated on every
sweep while the fault lasted — by design (it is an active fault), but an
hour-long outage pushed six identical messages into every linked chat.

- `telegramBotConfig.purgeAlertedAt` stores when an alert last went out. The
  sweep reads it with the config and passes it to `shouldAlertPurgeFailures`,
  which still requires two failing sweeps in a row and additionally requires
  `now - purgeAlertedAt >= PURGE_ALERT_REPEAT_MS` (1 hour). The first alert of a
  fault is therefore immediate (on the second failing sweep); repeats are
  hourly.
- `markPurgeAlert` stamps the time BEFORE the sends. If the alert path crashes
  halfway, the chats already spared a repeat are not re-spammed ten minutes
  later; the cost is at most one delayed repeat, never a storm.
- `stampPurgeRun` clears `purgeAlertedAt` when `failed === 0`. A clean sweep
  ends the fault, so the NEXT fault alerts on its own second failing sweep
  instead of waiting out an hour left over from the previous one. A skipped
  sweep (stand-down) also stamps zero failures and clears it — nothing is
  failing while the sweep is off.
- The window is `PURGE_ALERT_REPEAT_MS = 60 min`, matched to the bell's
  one-per-hour dedupe in `recordBotHealthAlert`, so the two channels stay in
  step.

No codegen was needed for either addition: `_generated/dataModel.d.ts` derives
`Doc<>` from `schema.ts` itself (`DataModelFromSchemaDefinition<typeof
schema>`), and `_generated/api.d.ts` derives the function API from the module
files (`ApiFromModules`), so typechecking sees `purgeLastRetrying`,
`purgeAlertedAt` and the new internal `markPurgeAlert` as soon as they are
declared. That is why the round-30 note about codegen blocking a new
notification KIND still stands — a value in a union is generated, a new field
or function is inferred.

### 2. `retrying` is stored, displayed, and in the alert

Round 30 returned `retrying` from the sweep and from `/purge`, but `/alerts`,
the header chip and the bot panel only saw the stored tally, which had
`deleted`/`failed` and no retry count. A fault now reads honestly whether it is
draining or stuck.

- `purgeLastRetrying` is stamped with the rest of the tally and read back by
  `purgeTelemetryFrom`, so `PurgeTelemetry.retrying` reaches every consumer of
  `purgeLast` (`/alerts`, the chip tooltip, the dialog) through the one shared
  `purgeTelemetryLine`.
- The line shows it only when there is a backlog: `2m ago · 0 deleted · 3
  failed · 2 retrying`. A failure Telegram will never accept again is settled,
  not a retry, so it is never counted there — that is the difference between
  "the bot lost its rights" (draining) and "those messages are gone" (final).
- `purgeFailureSummary` carries the same segment and states the consequence for
  the actual number: "2 refused messages are still tracked and will be retried
  on the next sweep", instead of the generic sentence. Both the Telegram alert
  and the bell entry get it from the same builder.
- Absent (an older stamp) reads as 0, so a deployment that upgrades with a
  stored round-30 tally does not claim a retry backlog it never measured.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 831 pass / 0 fail across 69 files (828 → +3: hourly throttle,
  retry segment in the telemetry line, retrying count in the shared summary).
- `eslint` on the six touched files: 18 problems, all on code this round did
  not touch (unused imports and `\_` escapes in the bot modules, the dialog's
  purity/`setState`-in-effect findings) — the same baseline as round 30.
- NOT executed: the Convex deploy (still disabled by the free-plan ceiling), so
  the new fields, the throttle and its clearing path are code-only; no live
  Telegram alert cadence was observed, and the chip copy was not viewed in a
  browser.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 31, brainstormed (none started)

1. **Prove the hourly cadence on a live deployment** (round 30 #1 extends to
   the throttle): break delete rights, watch the second sweep alert and the
   next five stay silent, restore rights, watch the retry drain and
   `purgeAlertedAt` clear.
2. **Add a `bot_health` notification kind** (round 30 #2) — still needs
   `convex codegen`; the bell's hourly dedupe already matches this throttle.
3. **Stop re-alerting forever on an unfixable fault.** Hourly is better than
   every sweep, but nothing eventually says "this has failed since 09:10 and I
   have stopped repeating". A long-fault cap (e.g. stop after 6 alerts, or
   escalate once) needs the streak length the tally does not store.
4. **Bound retry attempts per row** (round 30 #4) — a `chat not found` row is
   retried until the 48 h retention backstop; `retrying` now makes the stuck
   state visible, an `attempts` counter would settle it sooner.
5. **Keep a short sweep history** (round 30 #5).
6. **Show `retrying` in the chip's label**, not only its tooltip, when a
   backlog persists — needs a threshold so the chip does not flicker on one
   transient 5xx.
7. **Contract test for the backend keep-list** (round 28 #5).
8. **Expired `operatorDeviceTrust` sweep** (round 28 #6; needs an index).
9. **Prove the cached height path on a funded send** (round 27 #1).
10. **`heightReadsFailed` count** (round 25 #7).
11. **Redact URLs inside RPC error bodies** (round 25 #3).
12. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
13. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
14. **Operator-selectable digest cadence** (round 27 #11).
15. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
16. **Track multiple channel ids** (round 26 #12).
17. **Show the local sweep in Settings** (round 28 #15).

## Round 32 — the repeat alert tells the truth, and a long fault goes quiet (2026-11-23)

Two round-31 follow-ups, both about the same failure mode: an alert that keeps
talking after it has stopped being useful. The hourly ping still opened with
"Two sweeps in a row could not delete…" on its sixth send, and nothing ever
ended a fault that could not be fixed.

### 1. A repeat no longer claims it is the first alert

The body was written for the first alert and reused verbatim every hour after
it. On the fourth ping that is simply false: it was not two sweeps, it was
forty, and the "Usual cause" paragraph was a repeat of something the operator
had already read three times.

`shouldAlertPurgeFailures` (boolean) became `purgeAlertPlan`, which returns the
decision AND the wording inputs in one shape:

- `alert` — send now? False covers "not yet" (first failing sweep), "too soon"
  (inside the hourly window) and "capped";
- `kind` — `first` | `repeat` | `capped` | `silent`;
- `number` / `cap` — which repeat this is, out of how many the fault may send;
- `since` — when the fault began, from the stored stamp or the previous failing
  sweep's own timestamp.

Wording follows the plan, and both channels get it from the same builders:

- first: `Two sweeps in a row could not delete messages from Telegram.` plus
  the usual-cause paragraph, header `⚠️ Message sweep is failing`;
- repeat: `The sweep is still failing — repeat alert 3 of 6, failing for 1h
  50m.` then the Previous/Latest tallies and the retrying consequence. The
  cause paragraph is dropped — it was in the first alert, and it is what makes
  an hourly message feel like spam. Header `⚠️ Message sweep still failing`;
- the sixth (cap) send adds: `This is the last automatic alert for this fault.
  Sweeps keep retrying, and /alerts keeps showing the tally until one
  succeeds.`

`fmtDuration` renders the span ("45m", "2h 10m", "3d 4h") without the `ago`
suffix that `fmtAgo` carries, so the sentence cannot come out as "failing for
2h ago".

### 2. A fault is capped at six alerts

Hourly repetition is survivable for an afternoon and wrong for a month. A bot
removed from a group nobody watches would otherwise ping every linked chat
every hour for as long as the row exists — the exact behaviour operators mute,
which also mutes the next real fault.

- `PURGE_ALERT_CAP = 6`: an hour apart, that covers a working day.
- `purgeAlertsSent` stores how many alerts the current fault has sent;
  `purgeFaultSince` stores when it began, so the wording survives a config read
  that no longer has the original tally.
- `markPurgeAlert` writes the count, the fault start and the throttle stamp
  together, BEFORE the sends — a crash mid-alert cannot buy the fault a fresh
  sixth alert.
- At the cap, `purgeAlertPlan` returns `kind: "capped"` and the sweep alerts
  nobody. It still stamps the tally every ten minutes, so `/alerts`, the header
  chip and the dialog keep showing the live failure; only the interruption
  stops.
- A clean sweep clears `purgeAlertedAt`, `purgeAlertsSent` and
  `purgeFaultSince`, so the next fault alerts on its second failing sweep and
  gets its own six.
- Migration: a round-31 row has `purgeAlertedAt` but no counter. An outstanding
  stamp is counted as one alert already sent, so upgrading cannot reset the cap
  — the next alert is correctly a repeat, not a fresh "first". Either way the
  first clean sweep clears the field.

The bell entry keeps its stable title ("Message sweep failing") across repeats
because its one-hour dedupe is title-keyed; the repeat wording lives in the
body. Changing the title per repeat would silently defeat that dedupe.

### Checks

- `bun run typecheck`: exit 0.
- `bun test`: 836 pass / 0 fail across 69 files (831 → +5: first-alert plan,
  capped plan, round-31 migration, repeat wording, capped wording/header).
- `eslint` on the four touched files: 14 problems — 12 unused imports and 2
  `\_` escapes, all pre-existing (the round-30 baseline for these files), none
  on changed lines.
- NOT executed: the Convex deploy (free-plan ceiling), so the two new fields,
  the cap and the migration path are code-only; no live hourly cadence and no
  browser view of the bell body.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 32, brainstormed (none started)

1. **Prove the capped cadence on a live deployment** (round 31 #1 extends to
   the cap): break delete rights, watch alert 1…6 land an hour apart, watch
   sweep 7 go silent while the tally keeps changing, restore rights, watch the
   retry drain and all three stamps clear.
2. **Show the muted state, not just the failure.** After the cap, `/alerts` and
   the chip show failures with no alert coming. A `purgeAlertsSent >= cap`
   suffix ("alerts paused after 6 — one sweep must succeed") on the last-sweep
   line is the honest counterpart to the cap and needs no codegen.
3. **Add a `bot_health` notification kind** (round 30 #2) — still needs
   `convex codegen`; the bell's hourly dedupe already matches the throttle.
4. **Bound retry attempts per row** (round 30 #4) — a `chat not found` row is
   retried until the 48 h retention backstop; `retrying` makes it visible, an
   `attempts` counter would settle it sooner.
5. **Keep a short sweep history** (round 30 #5) — last-only cannot show "the
   sweep stopped running six hours ago".
6. **Escalate once instead of only stopping.** The cap ends the noise, but an
   unfixed fault is still unfixed; a single "this has failed since 09:10"
   summary on the next app open (not on a timer) would close that gap.
7. **Make the bell's dedupe explicit.** It is keyed on the title and hard-coded
   to one hour; if the title ever carries the repeat number, pass the window in
   instead of relying on the title staying stable.
8. **Show `retrying` in the chip's label** (round 31 #6) when a backlog
   persists — needs a threshold so the chip does not flicker on one 5xx.
9. **Contract test for the backend keep-list** (round 28 #5).
10. **Expired `operatorDeviceTrust` sweep** (round 28 #6; needs an index).
11. **Prove the cached height path on a funded send** (round 27 #1).
12. **`heightReadsFailed` count** (round 25 #7).
13. **Redact URLs inside RPC error bodies** (round 25 #3).
14. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
15. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
16. **Operator-selectable digest cadence** (round 27 #11).
17. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
18. **Track multiple channel ids** (round 26 #12).
19. **Show the local sweep in Settings** (round 28 #15).

## Round 33 — the pause is visible, and bot health gets its own bell kind (2026-11-23)

Round 32's top two follow-ups, both about a cap that works but is invisible and
a fault that borrows another feature's bucket.

### 1. A capped fault says it stopped alerting

Round 32 silenced a fault after six alerts and kept stamping the tally, which
left the worst possible reading on screen: "3 failed" every ten minutes with no
alerts and no explanation. The operator cannot tell a deliberate pause from a
broken notifier.

- `purgeAlertPauseNote(alertsSent)` is the one suffix, shared like
  `purgeTelemetryLine`: empty below the cap, ` · alerts paused after 6 (a clean
  sweep resumes them)` at or above it. The wording derives from
  `PURGE_ALERT_CAP`, so the copy cannot drift from the rule.
- `getBotHealth` (chip) and `getBotStatus` (dialog) now return
  `purgeAlertsSent` with the tally, and the `/alerts` board's `cfg` carries it
  too, so all three surfaces read the same number.
- It appears on the existing last-sweep line (`/alerts`, chip tooltip, dialog)
  rather than as a new banner: the pause belongs next to the failures it
  explains. A clean sweep clears `purgeAlertsSent`, so the note disappears by
  itself when alerting resumes.
- No note while alerts still flow — the line stays quiet in the normal case.

### 2. `bot_health` is its own notification kind

Round 30 wrote the bell entry into `session_update` and recorded that a
distinct kind needed `convex codegen` against a deployment. That turned out to
be wrong, and this round proves it: `_generated/dataModel.d.ts` derives `Doc<>`
from `schema.ts` itself, including union literals, so declaring
`v.literal("bot_health")` is enough for typecheck and for the deployment's
schema push. No codegen, no hand-edited `_generated`.

- `notifications.kind` gains `bot_health`; `recordBotHealthAlert` reads its
  dedupe rows with `by_user_kind` scoped to that literal and writes it.
- The bell renders it rose with a `ShieldAlert` icon instead of borrowing the
  session-update clock.
- The dedupe key is now genuinely the fault's own: an hourly bot-health entry
  can no longer suppress, or be suppressed by, a session update that happens to
  carry the same title inside the hour.
- Existing `session_update` entries stay where they are and keep rendering; the
  kind is additive, and no migration is needed.

### Checks

- `bun run typecheck`: exit 0, including the new union literal and the two
  query return types — the evidence that the schema-derived `Doc` needs no
  codegen.
- `bun test`: 838 pass / 0 fail across 69 files (836 → +2: the pause-note
  boundary and its wording).
- `eslint` on the eight touched files: 21 problems, all pre-existing (12 unused
  imports and 2 `\_` escapes in the bot modules, 2 in `notifications.ts`, 1
  `setState`-in-effect and 1 purity warning in the dialog) — none on changed
  lines.
- NOT executed: the Convex deploy (free-plan ceiling), so `purgeAlertsSent` is
  not queryable live, the `bot_health` insert has never run against a real
  table, and the rose bell entry was not viewed in a browser.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 33, brainstormed (none started)

1. **Prove the capped cadence and the paused note on a live deployment**
   (round 32 #1 + #2): break delete rights, watch alerts 1…6 an hour apart,
   sweep 7 go silent with "alerts paused" on `/alerts`, the chip and the dialog,
   restore rights, watch the retry drain and every stamp clear.
2. **Bound retry attempts per row** (round 30 #4) — a `chat not found` row is
   retried until the 48 h retention backstop; `retrying` makes it visible, an
   `attempts` counter would settle it sooner.
3. **Keep a short sweep history** (round 30 #5) — last-only cannot show "the
   sweep stopped running six hours ago".
4. **Escalate once instead of only stopping** (round 32 #6): the cap and its
   note end the noise, but an unfixed fault is still unfixed; one "failing
   since 09:10" summary on the next app open would close the loop without a
   timer.
5. **Make the bell's dedupe explicit** (round 32 #7) — it is title-keyed and
   hard-coded to one hour; pass the window in rather than relying on titles.
6. **Show `retrying` in the chip's label** (round 31 #6) when a backlog
   persists — needs a threshold so the chip does not flicker on one 5xx.
7. **Contract test for the backend keep-list** (round 28 #5).
8. **Expired `operatorDeviceTrust` sweep** (round 28 #6; needs an index).
9. **Prove the cached height path on a funded send** (round 27 #1).
10. **`heightReadsFailed` count** (round 25 #7).
11. **Redact URLs inside RPC error bodies** (round 25 #3).
12. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
13. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
14. **Operator-selectable digest cadence** (round 27 #11).
15. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
16. **Track multiple channel ids** (round 26 #12).
17. **Show the local sweep in Settings** (round 28 #15).

## Round 34 — a retry budget per row, and abandoned rows are named (2026-11-23)

Round 33's follow-up. A transient refusal kept its row so the next sweep could
try again — right for an outage that heals, wrong for one that never will. A
`chat not found` row on a deleted group was attempted every ten minutes until
the 48 h retention backstop: 288 identical failures for a message no delete
would ever reach, inflating `retrying` the whole time.

### 1. `PURGE_RETRY_CAP` bounds automatic retries

- `telegramBotMessages.attempts` counts transient refusals per row. Absent
  reads 0, so rows already in the table when the field landed simply start
  their budget from zero.
- Each sweep increments it through a new `bumpTrackedAttempts` (batched, one
  mutation per pass, like the drops). When the NEXT attempt would reach
  `PURGE_RETRY_CAP = 36`, the row is dropped instead of counted `retrying`.
- 36 attempts is six hours of ten-minute sweeps: long enough for lost delete
  rights, a kicked bot, rate limiting or maintenance to come back; short enough
  that a dead row stops costing Bot API calls and stops inflating the backlog.
- The honest consequence is stated, not hidden: those messages were never
  deleted and the sweep will not try again, so they stay in the chat. That is
  the trade the budget makes — bounded work in exchange for keeping Telegram's
  own 48 h window as the only other backstop.
- `/purge` passes `countAttempts: false`. An explicit operator retry spends the
  operator's action, not the row's automatic budget; otherwise a few impatient
  taps during a blip could abandon a message a healed sweep would have deleted.
- A failed bump is a non-event: the row simply gets its next attempt with the
  same count, which is safe (a longer budget, never a skipped delete).

### 2. `abandoned` is in the tally, not folded into `failed`

Rows dropped at the cap are neither deleted nor coming back, so leaving them
inside `failed - retrying` would have implied "permanent refusal, already gone"
— a different thing. `purgeLastAbandoned` is stamped with the rest of the tally
and reaches `/alerts`, the chip and the dialog through the shared line:

`2m ago · 0 deleted · 4 failed · 1 retrying · 3 abandoned (retry cap)`

The fault body says the consequence in words ("used up the 36-attempt retry cap
and are no longer tracked — the sweep will not try again, so they stay in the
chat"), so the number is never just a word the operator has to decode. Absent
on an older stamp reads 0.

### Checks

- `bun run typecheck`: exit 0, including `msg.attempts` read from
  `listStaleMessages` and the new mutation.
- `bun test`: 841 pass / 0 fail across 69 files (838 → +3: the budget boundary,
  the abandoned segment in the tally line, and the consequence sentence).
- `eslint` on the four touched files: 14 problems, all pre-existing (12 unused
  imports, 2 `\_` escapes), none on changed lines.
- NOT executed: the Convex deploy (free-plan ceiling), so the counter has never
  been incremented against a real table, no row has actually been abandoned,
  and the 36-attempt arithmetic is unit-tested rather than observed.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 34, brainstormed (none started)

1. **Prove the budget on a live deployment**: revoke delete rights for longer
   than six hours of sweeps, watch `retrying` climb and stop, `abandoned`
   appear, and the rows leave the table — then restore rights on a fresh row
   and watch it delete normally.
2. **Reclassify the genuinely hopeless descriptions.** `chat not found` and
   `bot was kicked` heal in some cases and never in others; spending the whole
   budget on a deleted group is the last waste left. A separate
   "hopeless" verdict (short budget or immediate abandon) would spend attempts
   only where healing is plausible.
3. **Make abandonment recoverable by hand.** Once a row is dropped, `/purge`
   cannot see it. An "abandoned" list (chat, message id, first failure) would
   let the operator delete what remains after fixing rights, instead of the
   current all-or-nothing.
4. **Keep a short sweep history** (round 30 #5) — last-only cannot show "the
   sweep stopped running six hours ago".
5. **Escalate once instead of only stopping** (round 32 #6) — the cap and its
   note end the noise, but an unfixed fault is still unfixed.
6. **Make the bell's dedupe explicit** (round 32 #7).
7. **Show `retrying` in the chip's label** (round 31 #6).
8. **Contract test for the backend keep-list** (round 28 #5).
9. **Expired `operatorDeviceTrust` sweep** (round 28 #6; needs an index).
10. **Prove the cached height path on a funded send** (round 27 #1).
11. **`heightReadsFailed` count** (round 25 #7).
12. **Redact URLs inside RPC error bodies** (round 25 #3).
13. **Add a `(chatId, sentAt)` composite index** (round 25 #5).
14. **Rebroadcast signed bytes after ~3 misses** (round 24 #4).
15. **Operator-selectable digest cadence** (round 27 #11).
16. **Move the inline keyboards in `handleUpdate` into lib builders** (round 25
    #6).
17. **Track multiple channel ids** (round 26 #12).
18. **Show the local sweep in Settings** (round 28 #15).

## Round 35 — keep abandoned rows, split hopeless refusals (2026-11-23)

Round 34 dropped a row once its retry budget was spent. That was a bookkeeping
choice with a content consequence: the message is still in the chat, and once
the row was gone `/purge` could never find it again. Round 34 even named the
gap in its own follow-up list ("make abandonment recoverable by hand"). This
round reverses the drop and splits the errors that made the budget necessary.

### 1. Abandoned rows are KEPT and marked, not dropped

`telegramBotMessages.abandoned: true` means "the automatic sweep has stopped
retrying this row". The row, and therefore the message id, stays in the table
until one of three things happens: a later `/purge` deletes the message, the
48 h tracking-row retention removes the bookkeeping, or the message is deleted
some other way.

- The automatic sweep excludes abandoned rows from its selection
  (`includeAbandoned` is false by default). They are still tracked but sit at
  the head of the `by_sent` order; leaving them selectable would let a deleted
  group's backlog starve newer messages out of the sweep's 100-row window until
  the retention sweep.
- `/purge` passes `includeAbandoned: true`. Clearing a fixed chat by hand is the
  whole reason to keep the row; a successful manual delete drops it like any
  other.
- Manual attempts still pass `countAttempts: false`, so an impatient operator
  cannot spend a row's automatic budget.
- `abandoned` is a standing count, not "marked this sweep": it is read from the
  new `by_abandoned` index (`["abandoned", "sentAt"]`), bounded at 1,000 rows,
  so a clean sweep reads no tracked messages at all and the tally keeps saying
  "3 abandoned" until they are gone. The filter that hides them from the sweep
  uses `q.neq(field, true)`; Convex's ordering places `undefined` below every
  value, so rows predating the field are included.

### 2. Hopeless refusals no longer spend six hours of calls

`classifyPurgeFailure` now returns three verdicts instead of two:

- `permanent` (unchanged): message gone, too old, invalid id → row dropped.
- `hopeless` (new): `chat not found`, `peer_id_invalid`, `chat_id_invalid` →
  the sweep abandons the row on the first refusal. Waiting cannot make a
  deleted group answer, so 36 attempts were 36 wasted calls; the row is kept, so
  `/purge` still reaches it if the chat comes back.
- `transient` (unchanged): rights, 429, 5xx, network — and a kicked bot, because
  re-adding it makes the same deletes work again. Full 36-attempt budget.

The tally segment is now `· 3 abandoned` (the "(retry cap)" note was no longer
true for the hopeless half), the fault body says abandoned rows are "no longer
retried automatically … /purge can still try them by hand", and `/purge`'s own
reply adds how many rows in that chat are past the automatic budget and that the
manual run just tried them.

### Checks

- Dependencies had to be reinstalled after the workspace restore
  (`bun install --frozen-lockfile`, lockfile untouched); the first typecheck
  failure was missing modules and a version-mismatched `tsc`, not this change.
- `./node_modules/.bin/tsc -b --noEmit`: exit 0, including the new index, the
  three-way verdict and the `includeAbandoned` arg.
- `bun test`: 842 pass / 0 fail across 69 files (841 → +1: hopeless vs
  transient verdicts; the tally and summary expectations were updated).
- `eslint` on the four touched files: same 14 pre-existing problems, none on
  changed lines.
- NOT executed: `convex deploy` (free-plan ceiling). So the `by_abandoned` index
  is not built, no row has been marked in a real table, and the `neq` filter's
  runtime behaviour rests on Convex's documented `undefined` ordering, not on an
  observed sweep. `countAbandonedMessages` has never been called.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 35, brainstormed (none started)

1. **Prove this on a live deployment**: a deleted-group row must be marked
   abandoned on its first sweep, disappear from the automatic selection, keep
   counting in the tally, and still be deletable by `/purge` after the chat is
   restored. Also confirms the `neq` filter and the new index against real data.
2. **Surface the abandoned rows themselves.** The tally counts them but nothing
   names the chat/message, so "3 abandoned" is clear only in aggregate. An
   `/alerts` line or an "abandoned" list with chat id + message id is the
   missing half of manual recovery.
3. **Announce abandonment once.** A row can become abandoned between two clean
   sweeps, when no alert fires (the automatic tally shows it, but nothing pushes
   it). One notification per newly abandoned batch, through the existing
   `bot_health` kind, would close that gap without re-alerting hourly.
4. **Keep a short sweep history** — last-only cannot show "the sweep stopped
   running six hours ago".
5. **Escalate once instead of only stopping** — the cap and its note end the
   noise, but an unfixed fault is still unfixed.
6. **Make the bell's dedupe explicit** so a title change cannot reset it.
7. **Show `retrying` in the chip's label**, not only its tooltip.
8. **Contract test for the backend keep-list** (env vars/secrets the deploy
   must preserve).
9. **Expired `operatorDeviceTrust` sweep** (needs an index).
10. **Prove the cached height path on a funded send.**
11. **`heightReadsFailed` count** for the height cache.
12. **Redact URLs inside RPC error bodies** before they reach a log.
13. **A `(chatId, sentAt)` composite index** for chat-scoped windows — the chat
    query still takes every row before applying the cutoff.
14. **Rebroadcast signed bytes after ~3 misses.**
15. **Operator-selectable digest cadence.**
16. **Move the inline keyboards in `handleUpdate` into lib builders.**
17. **Track multiple channel ids.**
18. **Show the local sweep in Settings.**
19. **Drop abandoned rows once Telegram's own 48 h delete window has passed** —
    the retention sweep already does this by age; a comment in `retention.ts`
    noting that abandoned rows are covered by it would keep the two sweeps from
    growing separate rules.

## Round 36 — name the abandoned rows, announce them once (2026-11-24)

Round 35's own follow-ups. Keeping abandoned rows made `/purge` able to reach
them, but the operator could only see a number: "3 abandoned" with no chat, no
message id and no reason. And a row could become abandoned on a sweep that
alerted nobody — abandonment needs a failing delete, while two failing sweeps in
a row are what fire the fault alert, so one failed sweep after a clean one
silently retired a message from the automatic sweep.

### 1. The abandoned rows are listed, with ids and a reason

- `telegramBotMessages.abandonedReason` stores the verdict that abandoned the
  row: `exhausted` (the 36-attempt budget is spent on a chat that still answers)
  or `hopeless` (`chat not found` / invalid peer — fix the chat first). The two
  call for different operator action, so the row keeps which one it was.
- `markTrackedAbandoned` now takes the reason and writes both fields.
- New `listAbandonedMessages` query reads `by_abandoned` in send-time order,
  bounded (5 for a board, 10 for a notice; a chat-scoped read filters after a
  1,000-row index walk because one chat's rows are not contiguous in that
  index). A missing reason is returned as `null`, never defaulted to
  `exhausted` — the listing prints "no reason recorded" instead of guessing.
- `/alerts` grows a section under the tally: the standing count, one line per
  row (chat id, message id, why, how long it has been stuck — e.g.
  `chat -100123456789 · message 77 · chat unreachable · 2h ago`), and
  `…and N more` computed from the standing count, not from how many rows the
  query happened to return. `/purge`'s reply lists the rows STILL stuck in that
  chat after its attempt — a deleted row is gone from the list, so the receipt
  never claims work that this run just finished.
- `abandonedRowLine`, `abandonedListLines` and `purgeAbandonmentNotice` live in
  `src/lib/telegramBot.ts`, so the wording is unit-tested without a Convex
  runtime and the board and the notice can never disagree about a row.

### 2. One notice per newly abandoned batch, through the bell

- `deleteTrackedMessages` returns `newlyAbandoned` (rows THIS run marked, with
  chat/message/attempts/reason) alongside the standing `abandoned` count. The
  attempt that spent the budget is the one counted, so the line reads
  `36/36 attempts`.
- `purgeBotMessages` sends one `bot_health` bell entry, titled "Messages no
  longer retried", when `newlyAbandoned` is non-empty AND the fault alert did
  not fire this sweep. That is exactly the gap: the fault alert already says
  rows stopped being retried, so announcing twice at the same moment would be
  noise; the case that needed closing is the quiet one.
- The bell, not every linked chat: the fault channel means "the sweep is
  broken", this means "these messages are now your job". The body names the
  batch, lists up to ten rows and points at `/purge` and `/alerts`.
- The notice is advisory: a failed insert leaves the rows tracked and listed,
  and the sweep's outcome is unchanged. Two batches inside an hour collapse into
  one bell entry because `recordBotHealthAlert` dedupes on title + 1 h — the
  second batch is still visible on `/alerts`, and the dedupe is named as a
  follow-up rather than papered over.

### Checks

- `./node_modules/.bin/tsc -b --noEmit`: exit 0, including the new schema field,
  the two-argument `markTrackedAbandoned`, the new query's projected return type
  and the widened `PurgeResult`.
- `bun test`: 850 pass / 0 fail across 69 files (842 → +8: line wording for
  exhausted/hopeless/missing reason, list bounding and truncation from the
  standing total, singular/plural notice copy, and the ten-row notice cap).
- `eslint` on the four touched files: the same 14 pre-existing problems, none on
  a changed line.
- NOT executed: `convex deploy` (free-plan ceiling), so `abandonedReason` is not
  in a live schema, `listAbandonedMessages` has never run against a real table,
  and no bell entry has been inserted. The `/alerts` and `/purge` copy has not
  been rendered in Telegram.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 36, brainstormed (none started)

1. **Prove this end to end on a live deployment**: a deleted-group row must be
   listed with its id and `chat unreachable`, the bell must get exactly one
   notice, `/alerts` must show it under the tally, and `/purge` must clear it
   after the chat is restored — then the row must leave the list.
2. **Show the stuck rows in the app panel**, not only in Telegram. The dialog
   and the chip tooltip render the tally today; the listing needs a query on the
   operator API plus the rows in the status DTO.
3. **Name the chat, not just its id.** `telegramBotChats` already stores
   `title`/`username`; the listing prints a raw `chatId` the operator has to
   match by eye.
4. **Make the notice dedupe explicit.** The bell dedupes on title + 1 h, so a
   second abandoned batch inside the hour is silent. A dedupe key carrying the
   batch's row ids (or the count in the title) would keep both.
5. **Retry after a fix.** Re-adding the bot or re-pairing the chat does not
   clear `abandoned`; only a manual `/purge` does. Clearing it on a successful
   pair/link would put those rows back in the automatic sweep.
6. **`/purge` for the channel.** Abandoned channel rows are listed but have no
   manual recovery path at all — `/purge` is deliberately chat-scoped.
7. **Store the last failure description** on the row, so a listing can say
   `chat not found` rather than the verdict it implies.
8. **Delete one message by id** (`/purge <messageId>`) — re-attempting the whole
   chat is the only manual lever today, and a 100-row chat costs 100 calls.
9. **Per-chat abandoned counts** on `/alerts`: which chat holds the backlog is
   the first question the summary raises.
10. **Fold `newlyAbandoned` into a short sweep history** (round 35 #4) — a
    last-only tally cannot show "abandoned six hours ago".
11. **Escalate once instead of only stopping** (round 32 #6).
12. **Show `retrying` in the chip's label**, not only its tooltip.
13. **Contract test for the backend keep-list** (env vars/secrets the deploy
    must preserve).
14. **Expired `operatorDeviceTrust` sweep** (needs an index).
15. **Prove the cached height path on a funded send.**
16. **`heightReadsFailed` count** for the height cache.
17. **Redact URLs inside RPC error bodies** before they reach a log.
18. **A `(chatId, sentAt)` composite index** for chat-scoped windows.
19. **Rebroadcast signed bytes after ~3 misses.**
20. **Operator-selectable digest cadence.**
21. **Move the inline keyboards in `handleUpdate` into lib builders.**
22. **Track multiple channel ids.**
23. **Show the local sweep in Settings.**
24. **Note in `retention.ts` that abandoned rows are covered by the 48 h sweep**
    (round 35 #19), so the two sweeps never grow separate rules.

## Round 37 — name the chats, key the notice, show it in the panel (2026-11-24)

Round 36's follow-ups #2–#4. The abandoned rows had ids but no names, the
announcement was deduped by title so a second batch inside the hour vanished,
and the only place the rows could be read was Telegram itself.

### 1. The notice is deduped per batch, not per hour

- `notifications.dedupeKey` stores an explicit identity for writers whose
events are one-off but share a title.
- `purgeAbandonmentKey(rows)` derives it from the batch itself: FNV-1a over
  sorted `source:chatId:messageId` ids, prefixed with the row count. The same
  batch always keys the same (a retry cannot duplicate the bell), a different
  batch never collides (however close in time), and row order does not matter.
- `recordBotHealthAlert` takes an optional `dedupeKey`. When present it
  REPLACES the title + 1 h rule instead of falling back to it — the hourly rule
  is right for a persisting sweep fault and wrong for two distinct batches.
  Without a key the fault alert keeps its hourly throttle unchanged.
- `purgeBotMessages` passes the batch key with the notice. A second batch ten
  minutes after the first now rings; re-announcing the first still cannot.

### 2. The chats are named, not only numbered

- `AbandonedMessageLite.chatLabel` carries the paired chat's title (else its
  `@username`) when the deployment still knows it. `chatDisplayName` is the one
  place that decides title → `@username` → null.
- `listAbandonedMessages` resolves labels once per listing from the small
  `telegramBotChats` table, so every surface (the bot's `/alerts`, `/purge`'s
  receipt, the app panel) shows `chat "Alpha Group" (42)` instead of a bare id.
- Rows this sweep JUST abandoned never travelled through a listing, so
  `deleteTrackedMessages` resolves their labels through a new bounded
  `chatLabels` query before the notice is built. Naming is best-effort: a
  failure leaves the id in place, and the rows are still listed and recoverable.
- A channel is not a paired chat and a deleted group has no pairing row left;
  both fall back to the id rather than an invented name.

### 3. The app panel shows the stuck rows

- `getBotHealth` (chip) and `getBotStatus` (dialog) now return
  `abandonedTotal` plus `abandonedRows`, read LIVE from `by_abandoned` at query
  time — not the stamped tally, which is up to ten minutes stale and only a
  number.
- `BotStatusChip`'s tooltip lists up to three rows under the purge line, with
  `…and N more` computed from the standing total.
- `TelegramBotDialog`'s Auto-purge card shows an amber block under "Last
  sweep": the standing count, up to five named rows, and how to recover them
  (`/purge` in the chat). The same `abandonedListLines` renders here and in
  Telegram, so the two can never disagree about a row.

### Checks

- `./node_modules/.bin/tsc -b --noEmit`: exit 0, including the new schema
  field, the optional `dedupeKey` argument, the label plumbing through
  `listAbandonedMessages`/`chatLabels`, and both widened status DTOs.
- `bun test`: 853 pass / 0 fail across 69 files (850 → +3: a named row, the
  id fallback for an unnamed/whitespace label, and the batch-key properties
  plus the notice's named row).
- `eslint` on the seven touched files: 20 pre-existing problems (the same 14
  plus 2 in `notifications.ts` and 1 in the dialog), none on a changed line.
- NOT executed: `convex deploy` (free-plan ceiling), so `notifications.dedupeKey`
  is not in a live schema, no batch-keyed notice has been written, and neither
  the dialog block nor the chip tooltip has rendered against a live deployment.

### Still blocked (unchanged)

1. Convex `flexible-frog-776` stays disabled (free-plan ceiling).
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval.
4. `bun run verify` still needs a fresh 2/2 drill (one human faucet claim).

### Follow-ups — round 37, brainstormed (none started)

1. **Prove this end to end on a live deployment**: two batches inside one hour
   must both reach the bell, each row must carry its chat's title, and the panel
   must list the same rows `/alerts` does.
2. **Channel names.** A channel is never in `telegramBotChats`, so its rows
   still show only the id. The configured channel id/title could be stamped on
   the config row.
3. **Show the abandoned count in the chip's label**, not only its tooltip.
4. **Refresh the chip's `now`** — it is captured once per mount, so a row's
   "2h ago" ages only when the component remounts.
5. **Label lookup for a deleted group** from Telegram (`getChat`) before giving
   up on a name — bounded to one call per hopeless batch.
6. **Clear `abandoned` when a chat re-pairs** (round 36 #5), so restored
   chats return to the automatic sweep instead of waiting for `/purge`.
7. **`/purge` for the channel** (round 36 #6).
8. **Store the last failure description** on the row (round 36 #7).
9. **Delete one message by id** (round 36 #8).
10. **Per-chat abandoned counts** on `/alerts` (round 36 #9).
11. **A cap on `bot_health` dedupe reads** — the key check walks 20 rows; a
    batch key older than 20 notices could in principle be re-inserted, though a
    row cannot be newly abandoned twice.
12. **Fold `newlyAbandoned` into a short sweep history** (round 35 #4).
13. **Escalate once instead of only stopping** (round 32 #6).
14. **Show `retrying` in the chip's label** (round 36 #12).
15. **Contract test for the backend keep-list.**
16. **Expired `operatorDeviceTrust` sweep.**
17. **Prove the cached height path on a funded send.**
18. **`heightReadsFailed` count** for the height cache.
19. **Redact URLs inside RPC error bodies.**
20. **A `(chatId, sentAt)` composite index** for chat-scoped windows.
21. **Rebroadcast signed bytes after ~3 misses.**
22. **Operator-selectable digest cadence.**
23. **Move the inline keyboards in `handleUpdate` into lib builders.**
24. **Track multiple channel ids.**
25. **Show the local sweep in Settings.**
26. **Note abandoned-row coverage in `retention.ts`** (round 35 #19).

## Round 38 — the four migration tasks, measured for real (2026-11-24)

No code change this round. The task guard and the release gate were run with
no skips and no `--fix`, and their actual verdicts are recorded here so the
next session does not have to guess.

### `bun run check:tasks` — the four migration tasks

- 1. `.env.local` VITE_CONVEX_URL: PASS (it had been re-quoted by a secret
  sync; the guard normalized it to https://pastel-pelican-634.convex.cloud).
- 2. dev + prod deploy keys: PASS (both `convex export` exit 0).
- 3. overlay files + zips stamped https://flexible-frog-776.convex.site: PASS.
- 4a. required env vars present on dev and prod: PASS.
- 4b. `JWT_PRIVATE_KEY` armored, 1703 bytes on both: PASS (decryption intact).
- 4c. `gate:operatorStatus` seeded:true — FAIL on dev and prod: the query
  endpoint is unreachable because Convex is answering function calls with
  "You have exceeded the free plan limits, so your deployments have been
  disabled."
- 4d. real operator sign-in — FAIL for the same provider-side reason, before
  the probe could reach credentials or the login action.

Data reads are NOT affected: 7a/7b/7c passed (one operatorConfig per side, all
13 dev + 12 prod users have exactly one authAccount, dev not behind prod).
The cap disables function serving, not the database.

This is not a code defect and cannot be repaired with a deploy key: the
provider decides it, and the documented remedy is a plan upgrade (Free has
hard caps; Starter/Professional keep serving under metered overage) or waiting
for the usage window to reset. `convex login`/dashboard access is unavailable
in this workspace by design, so the upgrade is the account owner's action.
The guard's `--fix` was deliberately NOT run: 4b is already correct, and
`--fix` would also re-record the protected-deployment baseline (see below).

### `bun run verify` — the release gate

- 1/6 typecheck, 2/6 tests, 3/6 deploy-config parity, 4/6 host-header parity,
  5/6 overlay artifacts: PASS (853 tests, 0 fail).
- 6/6 live-path drill: FAIL — `reports/drill-latest.txt` is 563 h old (limit
  24 h) and the recorded combined verdict is 0/2. The gate names the exact
  funding it needs:
  - BSC testnet 0x329513F68b697e83a769800A45fB84C568B47901
  - Solana devnet CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K
  Both need a human faucet claim; the public Solana RPC `requestAirdrop` path
  already returns HTTP 410 here, and no funded deployer key exists.

### Protected deployment — a real change, left visible

`shiny-bulldog-311` is healthy (build stamp + seeded operator respond), but its
build stamp is now `20261123T234400Z-ab2c2501a060` while `.task-baseline`
records `20261113T212057Z-50da370bf26a` (recorded 2026-11-15). Something
deployed to it on 2026-11-23 at 23:44 UTC. Nothing in this chat deployed there;
the baseline was NOT rewritten, because re-recording it would turn a real write
to a protected deployment into a green check. That needs a human answer: if
that deploy was intended, re-record with `bun run check:tasks --fix`; if not,
the stamp itself is the evidence of who/when to investigate.

### Still blocked (unchanged, and now measured)

1. Convex serving is off on both deployments (free-plan cap) — owner upgrades
   or waits for the window; then 4c/4d can pass and the round 36–37 backend work
   can finally be deployed and proved live.
2. FlashboltSolana is not deployed to devnet (no funded deployer, no go-ahead).
3. Mainnet awaits the independent audit plus explicit approval; not touched.
4. `bun run verify` needs the fresh 2/2 drill, which needs the two testnet
   addresses funded by a human.

### Follow-ups — round 38, brainstormed (none started)

1. **Make 4c report the provider's own error**, not `unreachable`: the body
   already names the plan ceiling, and the guard's generic word hides the one
   fact the operator needs.
2. **Fail 4c/4d as BLOCKED rather than FAIL** when the error is the plan
   ceiling, so a billing outage is not indistinguishable from broken code.
3. **Record the guard's verdicts to a report file** (it currently prints to
   stdout only), so "it passed last week" has a timestamp.
4. **Answer the protected-deployment stamp question** before the next `--fix`
   run; the baseline is the only memory of the previous state.
5. **A faucet-free drill path?** None that is honest: the drill's point is a
   real funded transaction, so it stays gated on human funding.
6. **Check dev serving too in the guard's preview step** — the preview can be
   green while the dev deployment it talks to is disabled.

## Round 39 — the stamp drift was a platform rollout; the guard stops claiming otherwise (2026-11-24)

### The protected-deployment drift, measured

Round 38 flagged `shiny-bulldog-311` as changed because `.task-baseline` recorded
`20261113T212057Z-50da370bf26a` while the deployment answered
`20261123T234400Z-ab2c2501a060`. The investigation says that stamp is not a
per-deployment fingerprint:

- On 2026-11-24 all three deployments returned the same 29-byte body,
  `20261123T234400Z-ab2c2501a060`: dev `pastel-pelican-634`, prod
  `flexible-frog-776` and protected `shiny-bulldog-311`.
- A deployment that does not exist (`zzz-does-not-exist-999`) answers 404, so the
  route is per-deployment while the value is not — it is Convex's platform build
  stamp for the backend fleet.
- dev and prod took real CI deploys (`deploy-convex` → "Deploy Convex functions"
  succeeded) at 2026-11-23T18:52Z and 2026-11-24T11:17Z, and the value never
  moved. A user deploy cannot change it.
- No GitHub Actions run exists at 2026-11-23T23:44Z: the six runs between 18:00Z
  and 10:00Z the next day are the pushes from 18:05Z to 18:50Z. Nothing in this
  repo deployed at that minute.
- The protected deployment is alive on its own (`gate:operatorStatus` →
  seeded:true) with its own data.

Conclusion: the 2026-11-23 move is a platform rollout. Check 6's old premise —
"a different stamp means the deployment was written to" — overclaimed what
`/version` can prove, so the reference was re-baselined deliberately, not out of
convenience.

### Re-baseline, with the replaced value kept

| Reference | Stamp | Recorded / superseded |
|---|---|---|
| Original baseline | 20261113T212057Z-50da370bf26a | recorded 2026-11-15T13:44:27Z |
| Replaced | 20261113T212057Z-50da370bf26a | superseded 2026-11-24T11:34:29Z |
| Current deployment | 20261123T234400Z-ab2c2501a060 | answering now |
| New reference | 20261123T234400Z-ab2c2501a060 | recorded 2026-11-24T11:34:29Z |

`.task-baseline` gained a `history=` line carrying the superseded stamp, when it
was recorded, when it was superseded and what replaced it. Check 6 advances the
reference by itself only when dev, prod and the protected deployment all report
the same build; a divergence stays a FAIL (partial rollout or a restore).

### Code follow-ups closed (round 38 items 1, 2, 3, 4, 6)

1. **The provider's own error, not "unreachable".** `error_detail()` reads
   Convex's `errorMessage` (request id kept, newlines collapsed) and 4c, 4d and
   5b print it. The plan-ceiling sentence is quoted verbatim below.
2. **BLOCKED is its own verdict.** A plan ceiling or a bare `Server Error` is
   counted as BLOCKED — never PASS, never FAIL. The summary reports failures and
   blocked checks separately and exits 2 when nothing failed, so a billing window
   cannot look like a broken migration.
3. **Verdicts are persisted.** Every run re-executes itself through `tee` into
   `reports/task-guard-latest.txt` (gitignored, timestamped in the header), and
   the exit status survives the pipe.
4. **Check 6 asserts only what `/version` supports**: healthy (200, build-stamp
   shape, seeded operator responds) and on the same platform build as dev/prod.
5. **A faucet-free drill path** (round 38 #5) does not exist honestly: the drill's
   point is a funded on-chain transaction. It stays gated on a human faucet claim.
6. **Dev serving is checked on its own (5b).** The preview answered 200 while dev
   function serving was disabled — exactly the gap between "the site loads" and
   "the app works". 5b reports it as BLOCKED with the provider's sentence.

### `bun run check:tasks` — measured after the change

- 1, 2 (dev + prod), 3, 4a (dev + prod), 4b (dev + prod): PASS.
- 4c dev: BLOCKED, provider sentence quoted; 4c prod: BLOCKED, infrastructure
  `Server Error` with its request id.
- 4d dev: BLOCKED with the plan sentence; 4d prod: BLOCKED, `Server Error`.
- 5: PASS (/, /gate, /logo.svg).
- 5b: BLOCKED — dev function serving disabled by the provider.
- 6: PASS — protected deployment healthy on the fleet build
  `20261123T234400Z-ab2c2501a060`, reference unchanged after the re-baseline.
- 7a/7b/7c: PASS (one operatorConfig per side; 13 dev and 12 prod users each have
  exactly one authAccount; dev not behind prod).
- RESULT: no failures, 5 blocked by the provider, exit 2.

### Also found

- CI is red on every push for one reason only: the `solana-program` job's
  "Assert the pinned toolchain" step fails; `verify` and `deploy-convex` succeed.
  That predates this round and is unrelated to the bot/Solana execution work.
- `deploy-convex` reports success whether or not it actually deploys, and nothing
  asserts which deployment its environment key targets. A key pointed at the
  wrong deployment would deploy this code there silently.

### Follow-ups — round 39, brainstormed (none started)

1. **Assert the CI deploy key's target.** Resolve the key's deployment slug before
   deploying and fail unless it is `pastel-pelican-634`; a mis-scoped environment
   secret is the one path that could write to `shiny-bulldog-311` silently.
2. **Make a skipped deploy loud.** `deploy-convex`'s "Check deploy key" step turns
   an absent secret into a successful job with a notice; make green mean deployed.
3. **Fix the Solana CI toolchain assertion** — it fails before the program builds,
   so a known-red job hides real SBPF/IDL regressions.
4. **Wire `check:tasks` into CI** with BLOCKED (exit 2) surfaced but not failing;
   today the guard only runs by hand and its log is local.
5. **Keep a short history of guard runs**, not only the latest, so "green last
   week" survives a later red run overwriting the file.
6. **Retry once before calling a bare `Server Error` blocked** — prod returned it
   while dev returned the full sentence for the same condition.
7. **Cap `.task-baseline` history lines** (last ~10) so the committed file stays
   readable as platform rollouts accumulate.
## Round 40 — the CI job that was always red, and a guard that now runs by itself

Started from round 39's three CI follow-ups. Everything below is measured, not
assumed: the deploy key was read from the workflow's own run log, and the Solana
failure was read from the failing step's output.

### What the deploy key actually targets

- `gh secret list` (repo) and `gh variable list` (repo) are **empty**. The only
  credential is the environment secret `CONVEX_DEPLOY_KEY`
  (environment created 2026-11-22T16:00:53Z), which `deploy-convex` declares.
- Run 45386001019's deploy step printed
  `▌ [Production] Ola:taengine:production (prod) … https://flexible-frog-776.convex.cloud`
  and `✔ Deployed Convex functions to https://flexible-frog-776.convex.cloud`.
  So the key in the environment secret is the **production** deployment's key.
- `convex deploy --dry-run` reproduces that same target line and uploads nothing,
  which is what makes the target assertable from CI.

### Why `solana-program` was red on every push

Run 45386001019, step "Assert the pinned toolchain":

```
cargo-build-sbf 4.6.0
Default platform-tools: v1.58
Default Rust: 1.95.0
::error::cargo-build-sbf is not on platform-tools v1.57, the SBF compiler this job pins
```

The job installed `cargo install cargo-build-sbf --locked` — **no version** — so it
took whatever was newest (4.6.0) while the assertion still required v1.57. Note
the banner reads `Default platform-tools: v1.58`: the old grep looked for
`platform-tools v1.57` **without the colon**, so that assertion could never match
any output — its red message did not prove the drift it claimed. The drift is
still real, but on the crate sources, not this line. The crate sources settle
which release is the right pin:

| crate | `DEFAULT_PLATFORM_TOOLS_VERSION` |
|---|---|
| `cargo-build-sbf` 4.5.0 | `"v1.57"` (`src/toolchain.rs:24`) |
| `cargo-build-sbf` 4.6.0 | `"v1.58"` |

4.5.0 is both the newest release whose default is v1.57 and the release that
accepts the flags the build step already uses (`--tools-version`, `--arch v1`),
so the pin is 4.5.0 — a version, not "latest".

### Changes

1. **Solana job pinned and asserted against what the build uses**
   (`.github/workflows/ci.yml`): `cargo install cargo-build-sbf --version 4.5.0
   --locked`; the assertion now checks (a) the installed crate is 4.5.0, (b) its
   declared default is platform-tools v1.57, and (c) the directory the build
   actually compiles with — `~/.cache/solana/v1.57/platform-tools/version.md`,
   the same one `--tools-version v1.57` names — exists and reports v1.57. A crate
   bump that moves the default now fails by name at the top of the job instead of
   inside a 20-minute compile.
2. **`deploy-convex` fails closed and asserts its target.** The old "Check deploy
   key" step turned an absent secret into a green job with a notice. Now an absent
   secret is `::error::` + exit 1, and `bunx convex deploy --dry-run` resolves the
   key to its deployment first: anything other than `flexible-frog-776` fails
   before a byte is uploaded (override via the `CONVEX_PROD_SLUG` repository
   variable if production ever moves). The deploy step writes the deployed target
   into the job summary, so green now means "deployed to that deployment".
3. **New `task-guard` job** (push to `main` + `workflow_dispatch`,
   `needs: verify`): passes `CONVEX_DEPLOY_KEY_1` / `_2` as secrets, sets
   `SKIP_BUILD_TARGET=1` (check 1 inspects the untracked `.env.local`, which a
   runner never has), runs `bun run check:tasks`, and keeps the verdicts apart —
   exit 0 green, exit 2 surfaced as an error annotation **without** failing the
   job, exit 1 red. The run log uploads as `task-guard-<sha>`. A missing secret
   fails the job with an annotation naming the two secrets and where to add them,
   because a guard that cannot run must not look like a guard that passed.
4. **The guard no longer hangs** (`scripts/check-4-tasks.sh`). Measured: with
   function serving disabled, `convex data` against prod blocked past four minutes
   with no output. Every CLI call now has a ceiling (`CLI_TIMEOUT=20`, export
   `EXPORT_TIMEOUT=120`); a data read that times out is BLOCKED when the provider
   is already known to block serving (`unreadable()`), otherwise FAIL; an export
   timeout is BLOCKED (inconclusive) rather than "key rejected", which is a
   verdict a wrong key would produce in seconds with a message.
5. **Docs corrected** (`DEPLOYMENT.md`): the deploy key is an *environment* secret,
   green means deployed (no "skipped with a notice, never red"), the target is
   asserted, and the `task-guard` job and its two secrets are listed.

### Measured after the change

- `python3 -c yaml.safe_load` on `ci.yml`: parses; jobs are `verify`,
  `solana-program`, `deploy-convex`, `task-guard`; the pin reads
  `cargo install cargo-build-sbf --version 4.5.0 --locked`.
- `bash -n scripts/check-4-tasks.sh`: clean.
- `SKIP_BUILD_TARGET=1 SKIP_LOGIN=1 bun run check:tasks`: **exit 2 in 28 s** —
  check 1 "skipped", 2 (dev+prod), 3, 4a/4b (dev+prod), 5, 6, 7a/7b/7c PASS;
  4c dev, 4c prod, 5b BLOCKED with the provider's own sentences (5 blocked last
  round, 3 now — prod's `Server Error` is unchanged, dev's plan ceiling is
  unchanged). This is the exact path CI takes.
- Not proved here: the workflow has not run yet (the fix is in this push). The
  Solana job needs a full runner to prove 4.5.0 installs and compiles, and
  `task-guard` will stay red until the two secrets exist.

### State of the wiring, honestly

- `CONVEX_DEPLOY_KEY_1` / `CONVEX_DEPLOY_KEY_2` do not exist yet — their values
  live only in the untracked `.env.local`, which this work must not read or copy.
  Until the owner adds them at Settings → Secrets and variables → Actions, every
  push to `main` is red at `task-guard` with an annotation naming exactly those
  two secrets. That is the intended failure: it cannot silently pass.
- `vars.VITE_CONVEX_URL` is also unset, so the `verify` job's production build
  has no backend URL. That is a pre-existing gap this round did not change (the
  guard's check 1 is skipped in CI for the same reason), and it is follow-up 2.

### Follow-ups — round 40, brainstormed (none started)

1. **Add `CONVEX_DEPLOY_KEY_1` / `CONVEX_DEPLOY_KEY_2`** (owner action; dev key and
   prod key from dashboard → deployment → Settings → Deploy keys). Until then the
   guard job is red by design.
2. **Set the `VITE_CONVEX_URL` repository variable** to the production deployment
   URL. Measured empty today, so the CI build publishes the *Backend not
   configured* screen and the overlay artifacts it uploads are unstamped.
3. **Keep a short history of guard runs** (round 39 #5): each run overwrites
   `reports/task-guard-latest.txt`; the CI artifact preserves 30 per push, but a
   local ring at `reports/task-guard/YYYYMMDDTHHMMSSZ.txt` would survive hand runs.
4. **Retry once before calling a bare `Server Error` BLOCKED** (round 39 #6): prod
   has returned nothing but `[Request ID: …] Server Error` for hours while dev
   returned the full plan sentence for the same condition.
5. **Cap `.task-baseline` history lines** (round 39 #7) at ~10.
6. **A CI run that advances `.task-baseline` loses the advance**: check 6 rewrites
   the file in the runner checkout on a fleet rollout and nothing commits it, so
   the next run repeats the "reference advanced" message. Either commit it from a
   bot push or keep the file developer-owned and say so in check 6.
7. **Guard `--json` mode** so a dashboard or the Telegram alert path can read the
   verdict without parsing text (`{fail, blocked, checks:[{id, verdict, detail}]}`).
8. **Schedule the guard** (nightly cron) — plan ceilings and rollout drift happen
   between pushes, and a push-only guard reports them late.
9. **Ask the provider about the dev plan ceiling** (`pastel-pelican-634`: "You
   have exceeded the free plan limits") — 3 checks stay BLOCKED until it lifts or
   the plan changes; nothing in the code can fix it.
10. **SBPF v3 migration** (unchanged from round 39): needs litesvm ≥ 0.18
    (solana-* 4.x, MSRV 1.97.1); the harness is anchor-lang 0.31.1 / solana-sdk
    2.2 / litesvm 0.7. A dependency migration, not a flag flip.
11. **Assert the deploy target for PR/preview builds too** — today only `main`
    pushes deploy, so a key that is mis-scoped for previews is untested.

### First CI run of the change (45396966798, commit `29e5006`)

Measured, not assumed — this is what the workflow actually did:

- `verify`: **success**.
- `deploy-convex`: **success**, and the log shows the new assertion working:
  `▌ [Production] Ola:taengine:production (prod) … flexible-frog-776`, then
  `CONVEX_DEPLOY_KEY targets flexible-frog-776 (production) — deploying`, then
  `✔ Deployed Convex functions to https://flexible-frog-776.convex.cloud`.
  Green now means deployed to the asserted target.
- `task-guard`: **failure, by design** —
  `##[error]task guard did not run: missing secret(s): CONVEX_DEPLOY_KEY_1
  CONVEX_DEPLOY_KEY_2. Add them at Settings → Secrets and variables → Actions`.
  Exactly the loud, named failure that replaces the old silent skip.
- `solana-program`: **failure, in the new assertion** —
  `cargo-build-sbf 4.5.0 declares a platform-tools default other than v1.57`.
  The pinned build prints

  ```
  cargo-build-sbf 4.5.0
  Default platform-tools: v1.57
  Default Rust: 1.95.0
  ```

  and the check matched `platform-tools v1.57` without the colon. **The old
  assertion had the same bug**, so its red never proved the version mismatch it
  named; the drift is real because 4.6.0's source default is v1.58, and the
  banner also advertises the newest release on GitHub (v1.58), which is not what
  `--tools-version` builds with. Corrected to match the banner verbatim
  (`Default platform-tools: v1.57`) and re-pushed; the toolchain install steps
  themselves (4.5.0 install, cached platform-tools v1.57, Anchor 0.31.1) all
  succeeded, so the pin is right and only the string was wrong.

Lesson for the follow-ups: an assertion is only as good as the exact string it
matches — print the value it compares and match the measured text, not the
remembered one.

### Second run (45398162691, commit `e49bcbd`): banner matched, manifest did not

Steps 7–9 (cargo-build-sbf 4.5.0, cached platform-tools v1.57, Anchor 0.31.1)
all succeeded; step 10 moved to its next check and failed there:
`##[error]/home/runner/.cache/solana/v1.57/platform-tools/version.md does not
report v1.57`. The `head -3` I added printed the file's real content:

```
ae660768afd467d131776918a1627e18920b230c  https://github.com/anza-xyz/rust.git
bbbd3a76017677319ff85d096a7c9bee9813c3db  https://github.com/anza-xyz/cargo.git
f0f8003daa3f71a1a3e2f067f8d5bb46e2756514  https://github.com/anza-xyz/newlib.git
```

So `version.md` is a manifest of pinned rust/cargo/newlib revisions, **not** a
version string; the version lives in the directory name (`v1.57`, which the
wrapper derives from the version) and in the banner's `Default platform-tools`.
The assertion now checks what a real install has: the directory and file exist,
the manifest lists three pinned revisions, and — the strongest bit —
`v1.57/platform-tools/rust/bin/rustc --version` matches the `Default Rust:` the
banner names for that version (that rustc is what `toolchain.rs` reads to pick the
compiler). Cheap, no new hard-coded version, and it fails on a hollow download.

Note the shape of this round: each run was red in the assertion and green in every
install step, so the pin is right and the check was wrong twice. Both failures
were reported with their measured line rather than guessed at.

### Third run (45399227553, commit `070b11a`): the Solana job is green

Every step of `solana-program` succeeded — the first green run of that job:

| Step | Result |
|---|---|
| 7 Install cargo-build-sbf 4.5.0 (default platform-tools v1.57) | success |
| 8 Install SBF platform-tools v1.57 | success |
| 9 Install Anchor CLI 0.31.1 | success |
| 10 Assert the pinned toolchain | success |
| 11 Build the program (SBF v1) | success |
| 12 Regenerate the IDL and fail on drift | success |
| 13 Clippy (program crate, warnings are errors) | success |
| 14 Tests (LiteSVM + IDL conformance) | success |
| 15 Preflight (CI mode, read-only) | success |

`verify` and `deploy-convex` succeeded too, and `deploy-convex`'s log shows the
dry run resolving `flexible-frog-776` before `✔ Deployed Convex functions to
https://flexible-frog-776.convex.cloud`. The only red job is `task-guard`, and
only because its two secrets do not exist yet (`##[error]task guard did not run:
missing secret(s): CONVEX_DEPLOY_KEY_1 CONVEX_DEPLOY_KEY_2 …`). That is follow-up
1, an owner action, not a code defect.

## Round 41 — the keys were on the environment, and every run keeps its verdict

Round 40 left one red job (`task-guard`) and two settings "for the owner". Both
were changed between rounds, but not in the shape the note assumed — and that
difference was the actual bug.

### What was really there (measured, not assumed)

- `gh api repos/silk202/bnb-bot/actions/secrets` → **no repository secrets**.
- `gh api .../environments/CONVEX_DEPLOY_KEY/secrets` → `DEV_KEY`
  (2026-11-24T13:35:22Z) and `PROD_KEY` (13:33:58Z). The environment's original
  `CONVEX_DEPLOY_KEY` secret is **gone**.
- `task-guard` declared no environment and read `secrets.CONVEX_DEPLOY_KEY_1/_2`,
  so it saw two empty strings. The guard was right to refuse to run; its message
  named the wrong place.
- The same replacement silently broke backend auto-deploy: in run 45406806725,
  `deploy-convex` failed closed with `CONVEX_DEPLOY_KEY is not set for the
  CONVEX_DEPLOY_KEY environment`. "Green means deployed" caught a real
  regression instead of reporting a deploy that never happened.

### What changed

1. **The guard reads the keys where they are.** `task-guard` now declares
   `environment: CONVEX_DEPLOY_KEY` and maps
   `secrets.CONVEX_DEPLOY_KEY_1 || secrets.DEV_KEY` (and `_2 || PROD_KEY`), so
   the documented repo-level names still win if someone adds them.
2. **Check 2 asserts the key's own target.** A Convex deploy key is
   `<type>:<deployment>|<secret>` (provider docs: `prod:qualified-jaguar-123|eyJ2…`),
   so the guard reads the deployment name before the pipe and fails when it is
   not the expected dev/prod deployment. A swapped or duplicated secret now
   fails as "swapped or mis-scoped key" instead of passing as "a valid key".
   Every branch (PASS/BLOCKED/FAIL) names the target it saw — never the key.
3. **`deploy-convex` reads `secrets.CONVEX_DEPLOY_KEY || secrets.PROD_KEY`**, and
   its fail-closed annotation names `PROD_KEY` too. The dry-run target assertion
   is unchanged: it still refuses to deploy anywhere but `flexible-frog-776`.
4. **Every guard run is kept.** The tee wrapper writes each run to
   `reports/task-guard/<UTC>.txt` as well as `reports/task-guard-latest.txt`, in a
   ring of the last `TASK_GUARD_KEEP` runs (default 20). Filenames are
   fixed-width UTC stamps, so a plain `sort` is chronological; the ring is
   trimmed before writing; the header prints both paths. The CI artifact uploads
   the whole ring, so a green run stays readable after a later red one.
5. **`.task-baseline` history is capped** at `PROTECTED_BASELINE_HISTORY` (default
   10) newest superseded stamps. A cap that deletes silently is just data loss,
   so the run prints `baseline history capped at 10 line(s); N oldest superseded
   stamp(s) dropped`.
6. **`vars.VITE_CONVEX_URL` set** to `https://flexible-frog-776.convex.cloud` —
   the deployment `deploy-convex` asserts and the guard's overlay stamp names.
7. **The build can no longer ship unconfigured.** `verify` fails *before* the
   build when the variable is empty or is not a `*.convex.cloud` URL, and *after*
   it when the rebuilt overlay files/zips are not stamped with its `.convex.site`
   origin. Those were exactly the two symptoms of the empty variable; they are
   now checked at the source, not only by the guard.
8. **`workflow_dispatch` added.** The guard job's `if:` and DEPLOYMENT.md both
   promised a manual dispatch the workflow's `on:` never accepted. `deploy-convex`
   stays push-only, so a dispatch cannot deploy a backend.

### Local checks (before pushing)

- `bash -n scripts/check-4-tasks.sh` clean; the workflow parses with its four
  jobs and the new `workflow_dispatch` trigger.
- Three real guard runs with `TASK_GUARD_KEEP=2`: exit codes 2/2/2 survived the
  two-file tee, the ring ended with exactly two files, and the newest ring file
  is byte-identical to `task-guard-latest.txt` — earlier runs survive later ones.
- Check 2 against the actual `.env.local` keys (only slugs printed):
  `dev -> pastel-pelican-634`, `prod -> flexible-frog-776`, both accepted.
- Prefix harness: `dev:pastel-pelican-634|abc` → `pastel-pelican-634`,
  `prod:flexible-frog-776|abc` → `flexible-frog-776`, `garbage` → empty,
  `preview:team:proj|abc` → `proj` (not a deployment, so it fails the dev/prod
  assertion loudly instead of passing).
- Baseline harness: 15 old + 1 new stamp → 10 kept, newest retained, 6 dropped
  with the notice.

### CI evidence

Run **45406806725** (`19ee115`, wiring + history):

| Job | Result |
|---|---|
| verify | success — `build target: https://flexible-frog-776.convex.cloud`, then `overlay artifacts stamped https://flexible-frog-776.convex.site (files + zips)` |
| solana-program | success |
| task-guard | **success, and it ran**: `guard keys: dev -> pastel-pelican-634 … prod -> flexible-frog-776`, check 2 PASS on both sides, 5 BLOCKED, `history: reports/task-guard/20261124T134726Z.txt` |
| deploy-convex | failure — empty key (the environment's `CONVEX_DEPLOY_KEY` had been replaced) |

Run **45407872141** (`5bfc22c`, deploy-key fix):

| Job | Result |
|---|---|
| verify | success (same stamp assertions) |
| deploy-convex | success — `CONVEX_DEPLOY_KEY targets flexible-frog-776 (production) — deploying`, `✔ Deployed Convex functions to https://flexible-frog-776.convex.cloud` |
| task-guard | success — check 2 PASS both sides, 5 BLOCKED, ring file `20261124T135330Z.txt`; artifact `task-guard-5bfc22c…` 2830 B (latest + ring) |
| solana-program | still running when this was written; unchanged code, green in the previous run |

The five BLOCKED checks are one provider state, not five defects: dev answers
*"You have exceeded the free plan limits, so your deployments have been
disabled"*, prod answers a bare `[Request ID: …] Server Error`. Deploys are
still accepted — only function serving is disabled.

### Follow-ups — round 41, brainstormed (none started)

1. **Lift the provider ceiling.** 5 checks stay BLOCKED until the dev/prod plan
   serves again (or support lifts the disable). Nothing in the repo can fix it.
2. **Schedule the guard nightly** (round 40 #8) — the verdict history now exists,
   so a cron run leaves a comparable trail instead of overwriting one file.
3. **Retry once before calling a bare `Server Error` BLOCKED** (round 40 #4) —
   prod has returned only that for hours while dev names the cause.
4. **Assert the frontend build target and the deploy target agree.**
   `VITE_CONVEX_URL` and `CONVEX_PROD_SLUG` are independent settings: verify
   proves the former is *a* Convex URL and deploy proves the latter is
   production, but nothing proves they name the same deployment. A mismatch
   would deploy to A while building the UI for B, silently.
5. **A CI run that advances `.task-baseline` still loses the advance** (round 40
   #6) — check 6 rewrites the file in the runner checkout and nothing commits it,
   so the next run repeats the notice. The cap added here only bounds the file.
6. **Guard `--json` mode** (round 40 #7) so dashboards/alerts stop parsing text.
7. **Put the commit SHA in each run header** (`GITHUB_SHA` when set) so a ring
   file ties to the push that produced it, not just a timestamp.
8. **Keep superseded baseline stamps in this report, not only in
   `.task-baseline`** — the cap drops the oldest with one log line, which is
   easy to miss in a CI artifact.
9. **`workflow_dispatch` re-runs the 45-minute Solana job too** — consider a
   `guard-only` input so re-proving the guard after a secret change is cheap.

> Measured after writing: run 45407872141 was cancelled by the next push's
> concurrency group while its Solana job was still running — so the green Solana
> reference stays run 45406806725 (same workflow, same program sources), not a
> job that quietly never finished.

---

## Round 42 — five follow-ups from round 41, measured against the live deployments

Round 41 ended with nine follow-ups and five BLOCKED checks. This round takes the
five that needed no owner action and no new credentials, and measures the
provider again while doing it. Nothing was mocked: every verdict below comes from
a real run against `pastel-pelican-634`, `flexible-frog-776`,
`shiny-bulldog-311` and the published preview.

### 1. Nightly guard run (round 41 #2)

`on: schedule: - cron: "17 6 * * *"` on CI. The timestamped ring added in round
41 only accumulates when the guard runs, and waiting for a push means a provider
regression can sit for days (round 41 saw exactly that: the deployment was
plan-capped and only a push revealed it).

Two details that are not decoration:

- **Off the hour.** `:00` is where every other cron in every repo fires; 06:17
  UTC is the same slot, minus the queue.
- **Its own concurrency group.** `ci-<ref>` alone would let a cron cancel a push
  that is 40 minutes into the Solana job — measured in round 41, run
  **45407872141** was cancelled exactly that way by the next push. The group is
  now `ci-<ref>-nightly` for scheduled runs and `ci-<ref>-change` otherwise, so a
  cron and a push can never cancel each other.

`deploy-convex` keeps its push-only `if:`, so a cron can never deploy a backend.

### 2. One retry before calling a bare `Server Error` BLOCKED (round 41 #3)

Prod had answered nothing but `[Request ID: …] Server Error` for hours while dev
named its plan ceiling, so a transient blip and a standing outage produced the
same verdict. `operator_status()` now retries once (2 s) **only** when the body
is a bare provider error, and the message says how many attempts answered:

```
BLOCKED 4c. prod provider returned an infrastructure error after 2 attempt(s): [Request ID: 2624edf382f9eddf] Server Error
BLOCKED 4c. dev function serving disabled by the provider: … You have exceeded the free plan limits …
```

Dev does **not** retry — a named plan ceiling is a verdict, not a blip. Used by
4c and 5b (the two direct probes); 4d keeps its own single-attempt semantics
because every attempt spends one of the deployment's 5/minute login slots.

The first version of this had a real bug that only measurement caught: it set
`STATUS_RETRIED` inside `$( )`, so the parent never saw it and the message read
**"1 attempt(s)" after two real attempts**. The count now travels back as a
`#tries:<n>` first line that `unwrap_status()` splits off — proved with
`prod: tries=2` / `dev: tries=1` against the live deployments before the full
run, and again in the full run's own output above.

### 3. The frontend target and the deploy target must name the same deployment (round 41 #4)

`verify`'s build-target step now compares the slug in `VITE_CONVEX_URL` with
`CONVEX_PROD_SLUG` (default `flexible-frog-776`, the same default `deploy-convex`
asserts). Before this, `verify` proved the variable was *a* `*.convex.cloud` URL
and `deploy-convex` proved the key named production, but nothing proved they were
the same deployment — a mismatch would deploy the backend to A while shipping a
UI wired to B, silently.

Proved by running the step's own extracted `run:` block:

| `VITE_CONVEX_URL` | Result |
|---|---|
| `https://flexible-frog-776.convex.cloud` | exit 0 — `… agrees with CONVEX_PROD_SLUG=flexible-frog-776` |
| `https://pastel-pelican-634.convex.cloud` | exit 1 — names `pastel-pelican-634`, production is `flexible-frog-776` |
| empty | exit 1 — the round-41 "not set" annotation |

### 4. The commit SHA in every run header (round 41 #7)

A ring file named only by its timestamp cannot be tied to the push that produced
it. The header now prints `commit: ${GITHUB_SHA:-local}${GITHUB_REF_NAME:+ (…)}`
— `commit: local` on a developer machine, the SHA and branch in CI. It is inside
the tee'd output, so the latest file and the ring entry both carry it.

### 5. `guard_only` dispatch input (round 41 #9)

`workflow_dispatch` gained `guard_only` (boolean, default false). With it set,
`verify` and `solana-program` are skipped and `task-guard` still runs — which
needed care: `needs: verify` skips a dependent job when its dependency is
skipped, so the guard's condition now reads verify's result explicitly
(`success` or `skipped`) wrapped in `always()`. A **red** verify still blocks the
guard (that failure is the finding); a skipped one does not. The nightly run
takes the same path, so a cron costs one 15-minute job instead of a 45-minute
Solana rebuild that proves nothing new.

### Live state, measured this round (no mocking)

Same commands as round 41, `SKIP_LOGIN=1`, `CLI_TIMEOUT=30`, `EXPORT_TIMEOUT=60`
(`/tmp` report + ring so the repo's history is not polluted by a measurement):

| Check | Round 41 | Round 42 |
|---|---|---|
| 2. dev/prod deploy key export | BLOCKED (timeout) | **PASS both** — `export exit 0`, prefixes target the right deployments |
| 4a. env vars | BLOCKED | **PASS both** |
| 4b. JWT_PRIVATE_KEY armored 1703 B | BLOCKED | **PASS both** |
| 4c. `gate:operatorStatus` | BLOCKED ×2 | still BLOCKED ×2 (dev names the free-plan cap, prod bare `Server Error` after 2 attempts) |
| 5. published preview | PASS | **PASS** (/, /gate, /logo.svg) |
| 5b. dev backend serving | BLOCKED | still BLOCKED (plan cap) |
| 6. protected deployment | PASS | **PASS, fleet build rolled** `20261123T234400Z-ab2c2501a060 → 20261124T221653Z-e69b633e242e` |
| 7a/7b/7c. dev/prod parity | BLOCKED | **PASS** — operatorConfig 1/1, 13 and 12 users each with exactly one authAccount, dev not behind prod |

So the plan ceiling now blocks **function serving only**: reads, exports, env
reads and parity all answer. `RESULT no failures; 3 check(s) blocked by the
provider`, exit 2 — unchanged semantics, narrower blast radius.

The fleet-wide platform build roll advanced `.task-baseline` through the real
`write_baseline()` path: the superseded stamp was appended as `history=` (2 lines
now, cap 10, nothing dropped). That advance is committed here — see the decision
below.

### Decision: `.task-baseline` stays developer-owned (round 41 #5)

CI cannot commit, and a workflow that pushes to `main` from a runner would be a
second writer to the one file the guard treats as its reference of record. The
rule, now explicit rather than implied: **`check 6` advancing the file is correct
wherever it runs, and the advance is committed by a human/agent on the next push
that touches the guard** — exactly what this round does. CI's copy is a runner
checkout that is discarded; the report says so, so a repeated advance in CI logs
reads as "not committed", not as "the file is broken".

### Remaining follow-ups

1. **Provider ceiling** (round 41 #1) — unchanged, owner-only: 3 checks stay
   BLOCKED until dev/prod function serving returns. Nothing in the repo can fix
   it, and no attempt is faked here.
2. **Guard `--json`** (round 41 #6) — still text-only; a dashboards/alerts
   consumer has to parse the lines.
3. **Superseded stamps in this report** (round 41 #8) — the cap drops the oldest
   with one log line; the report still relies on the artifact for the trail.
4. **`TASK_GUARD_KEEP` vs artifact size** — 20 runs × ~3 KB is fine today; a ring
   of 20 *full* logs with all BLOCKED details would be the first thing to trim if
   the artifact grows.

### Checks run before pushing

- `bash -n scripts/check-4-tasks.sh` clean.
- Workflow parses: triggers `pull_request, push, schedule, workflow_dispatch`,
  one dispatch input, `cron: 17 6 * * *`, four jobs, `deploy-convex` still
  push-only.
- The `verify` build-target step extracted from the YAML and exercised with three
  values (table above).
- `operator_status` + `unwrap_status` extracted and run against both live
  deployments: `prod: tries=2`, `dev: tries=1`.
- Two full live guard runs: exit 2 both times, 3 BLOCKED (down from 5), the
  message text above, `commit: local` in the header, ring entry written.

### CI evidence (measured after pushing 99d4a5d)

Run **45606269044** (`99d4a5d`, push) — all four jobs **success**:

```
build target: https://flexible-frog-776.convex.cloud (overlay gate origin https://flexible-frog-776.convex.site), agrees with CONVEX_PROD_SLUG=flexible-frog-776
overlay artifacts stamped https://flexible-frog-776.convex.site (files + zips)
guard keys: dev -> pastel-pelican-634 …, prod -> flexible-frog-776 …
commit: 99d4a5d3113fe2d88a2f74e6ea53c4cf778c994b (main)
history: reports/task-guard/20261125T114008Z.txt (ring: reports/task-guard, last 20 runs)
BLOCKED 4c. prod provider returned an infrastructure error after 2 attempt(s): [Request ID: 9662e86ec657e71e] Server Error
RESULT no failures; 5 check(s) blocked by the provider   (guard exit=2)
```

Five BLOCKED in CI (not the three a local `SKIP_LOGIN=1` run shows) because CI
also runs 4d, which signs in for real and is capped by the same plan ceiling on
both deployments. Round 41's cancellation is gone: this run reached its Solana
job and finished.

Run **45607597089** (`workflow_dispatch`, `guard_only=true`):

| Job | Result |
|---|---|
| verify | **skipped** |
| Solana program | **skipped** |
| deploy-convex | **skipped** (push-only) |
| Task guard | **success**, exit 2 path, ring entry written |

That is the `always()` + `needs.verify.result == 'skipped'` combination behaving
as written: the guard ran with its dependency skipped, and a red verify would
still have blocked it.

**Not yet observed:** the 06:17 UTC cron itself — its first fire is tonight, and
its effect on a concurrent push (the separate concurrency group) can only be
watched then. The configuration parses and the same code path was proved by the
`guard_only` dispatch, which skips verify and Solana in exactly the way the cron
does.

---

## Round 43 — the last three code follow-ups: JSON verdict, baseline ledger, ring budget

Round 42 listed four remaining follow-ups; three needed no owner action. All
three are below, each measured against the live deployments, plus one bug the
measurement caught that would have silently emptied the new ledger.

### 1. `--json`: a verdict a program can read (round 41 #6, round 42 #2)

`bun run check:tasks --json` now writes exactly one JSON document to stdout.
Everything human — the header, every check line, the summary — goes to stderr,
and the report and ring entries for that run are `.json` (never a `.txt`
containing JSON). The tee only merges stderr into the report in text mode, so a
JSON run's report *is* the document: no stripping, no mixed streams.

```json
{
  "schema": "flashbolt.task-guard/1",
  "timestamp": "2026-11-25T12:10:17Z",
  "commit": "local", "ref": null, "mode": "verify",
  "result": "blocked", "exit_code": 2,
  "counts": { "pass": 14, "fail": 0, "blocked": 3, "skipped": 2, "checks": 19 },
  "report": "/tmp/guard-json.json",
  "ring": { "entry": "…/20261125T121017Z.json", "dir": "…", "keep": 3, "max_bytes": 262144 },
  "checks": [ { "id": "4c", "status": "blocked", "message": "4c. …", "details": ["…"] } ]
}
```

How it is built matters more than the shape: the checks are recorded into a
tab-separated file as they run (`pass`/`fail`/`blocked`/`skipped`, plus `note`
lines attached to the check they follow), and python3 serializes that with
`json.dumps`. A document assembled with `printf` from messages that contain
`"`, `\` and `[Request ID: …]` is a document that eventually stops parsing. The
exit code is unchanged in every mode: 0 proved, 1 failed, 2 provider-blocked.

Two bugs found while proving it, both by running it rather than reading it:

- **`skip` vs `skipped`.** The printer recorded `skip` while the counter keyed
  on `skipped`, so a real skipped check counted as zero. The harness fixture
  caught it (`{'pass': 1, 'fail': 1, 'blocked': 1, 'skipped': 0}` where 1 was
  expected); the record status is now `skipped` and the text output did not
  change.
- **Skipped checks were indistinguishable from notes.** They printed with the
  same eight-space indent. They still print exactly that way (text output stays
  byte-identical), but they are now counted and labelled `skipped` instead of
  being invisible to the machine.

Text mode was not disturbed: the same live run (below) produced the same
verdicts with the same prefixes, exit 2, and only one new fact in the header
(`<= 262144 B` for the ring).

### 2. Superseded baseline stamps outlive the cap (round 41 #8, round 42 #3)

`.task-baseline` keeps the newest 10 superseded stamps and the cap used to be a
single log line: `baseline history capped at 10 line(s); 3 oldest … dropped`.
The stamps themselves were gone — data loss with a footnote.

They now live in **`reports/baseline-history.md`**: an append-only table the
guard copies every superseded stamp into *before* it rewrites the baseline, and
that it backfills from on every run (idempotent, so a deleted ledger heals
itself and a stamp is never written twice). The cap is now a display limit.

The dedupe for "have I seen this stamp?" was wrong in the first version, and
only the harness proved it. Each row has a `Replaced by` cell, so a search for
`| <stamp> |` anywhere in the file matched the row that *superseded* the stamp
being appended — every second stamp looked present:

```
| `S0` | R0 | U0 | `S1` | rollout 0 |     <- contains `| `S1` |`
```

Measured before the fix: 6 of 12 rows written, no warning, no error. The match
is now anchored to the first cell (`^| \`<stamp>\` |`). Also, a drop is no
longer reported as a count: each stamp is named with its `recorded`/`superseded`/
`replaced_by` fields, which is what makes a trimmed baseline auditable.

Harness evidence (network-free):

| Case | Result |
|---|---|
| 12 history lines + 1 new stamp | baseline keeps 10, **all 13** stamps in the ledger |
| drop reporting | each of the 3 dropped stamps named, kept stamps not named |
| second advance | exactly one new row, no duplicate stamp |
| idempotent backfill | ledger byte-identical, silent |
| ledger deleted, baseline unchanged | 10 rows rebuilt, `baseline ledger: copied 10 …` |

The two stamps already in `.task-baseline` are backfilled into the committed
ledger: `20261113T212057Z-50da370bf26a` and `20261123T234400Z-ab2c2501a060`.

### 3. A ring budget in bytes (round 42 #4)

`TASK_GUARD_KEEP` bounded the ring by count (20 runs). The artifact is uploaded
by size, so the count alone can't bound it. `TASK_GUARD_MAX_BYTES` (default
262144 = 256 KiB) is now enforced alongside it.

The trim moved from before the run to **after** it. Trimming beforehand can only
guess the size of the file about to be written; trimming afterwards counts the
file just written, which is the file the budget is about. Two invariants:

- The **newest** verdict is never the one trimmed — the ring exists to be read.
  A single run larger than the whole budget is kept, with a warning that says so.
- Both limits print what they dropped and why: `guard ring trimmed 3 oldest
  run(s) … (now 2 file(s), 102 B; limit size 120 B)`.

Measured sizes today: a real text run is **2756 B**, a real JSON run **4528 B**.
Twenty runs at that size is ~90 KiB, so the count is still the binding limit and
256 KiB is a backstop, not a behaviour change. The CI artifact path now also
picks up `*.json` ring entries, so a `--json` run in CI would not lose its log.

### Checks run before pushing

- `bash -n scripts/check-4-tasks.sh` — clean.
- Harness `/tmp/guard-harness.sh` (network-free, extracts the ring/ledger/JSON
  functions from the script itself): **all 20 assertions pass**, including the
  three failure modes above.
- **Live text run** (real deployments, `SKIP_LOGIN=1`, `/tmp` report + ring so
  the repo's history is not polluted): 41.7 s, exit **2**, **3 BLOCKED**
  (unchanged: dev names its plan ceiling, prod answers a bare provider error
  after 2 attempts), check 6 `reference unchanged`, 4a/4b/7 all PASS. The
  ledger backfill printed nothing — it had nothing to add, which is the
  idempotence proof on the real file.
- **Live JSON run** through `bun run check:tasks --json` — 27.6 s, exit **2**,
  4528 B of **valid** JSON, `counts 14 pass / 0 fail / 3 blocked / 2 skipped /
  19 checks`, human lines on stderr, ring entry `20261125T121017Z.json`.
  Bun forwarded the flag verbatim (`$ bash scripts/check-4-tasks.sh --json` in
  its own stderr echo), so the documented `bun run check:tasks --json` form is
  the real invocation.

### Remaining follow-ups

1. **Provider ceiling** (round 41 #1) — unchanged and owner-only: 3 checks stay
   BLOCKED until dev/prod function serving returns (dev: free-plan disable;
   prod: bare `[Request ID: …] Server Error`). Nothing in the repo fixes it and
   nothing here pretends otherwise.
