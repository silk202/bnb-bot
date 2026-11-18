# Code review — readiness framework, gate enforcement and RPC plumbing

Reviewed: `src/chains/**`, `src/lib/rpc-manager.ts`, `src/lib/json-rpc.ts`,
`src/pages/terminal/{Sniper,Scanner,Contract,Settings}.tsx`,
`src/components/NetworkReadinessTable.tsx`, `sites/worker.js`.

## Fixed during review

1. **Broadcast retried deterministic rejections.** `RpcManager.broadcast` treated
   every send error as provider trouble, so `insufficient funds` or
   `nonce too low` was retried on other providers — burning rate limit and
   obscuring the cause. Deterministic rejections now throw immediately; only
   genuinely uncertain failures fall through to the hash check.
2. **Switch could stall for seconds.** `handleNetworkSwitch` awaited an
   unbounded `healthCheck()` (5 endpoints × up to 12s each, plus a log probe).
   It now checks at most 3 endpoints with a 3.5s per-call timeout behind a 4s
   hard ceiling, and skips the log probe.
3. **Gate was dead code.** `preflightExecution` is now called before signing in
   the Sniper payout, the Sniper withdrawal and the Scanner live-arbitrage path;
   a refusal stops the operation and is recorded (`payoutBlocks`, kinds
   `execution-gate`).
4. **Simulator plumbing was indirect.** The execution manager derived
   `requireLogs` from a timeout argument; it now derives it from the method.

## Open findings (not fixed here)

5. **Two RPC registries still coexist.** `src/lib/network-registry.ts` (earlier)
   and `src/chains/registry/*` (framework) both list endpoints. The framework is
   authoritative for readiness; `chains.ts` remains the venue/address source.
   Merging them is the next cleanup, and doing it blind risks the live BSC path.
6. **Readiness is recomputed per call with no results.** `preflightExecution`
   calls `evaluateReadiness` with `outcomes: []`, so it always reports
   `REGISTERED`. That is deliberate (no validation has run) but it means the
   gate's refusal reason is the same for every network; persisting reports
   server-side is required before activation can mean anything.
7. **Injected RPC URLs are visible to the page.** The Worker injects endpoints
   into HTML so a settings change needs no rebuild. Fine for endpoints; a URL
   with an embedded API key would be readable by anyone using the app.
8. **Runtime config is read once and cached** on `globalThis`; changing a value
   takes effect on the next page load, not live.
9. **`assertUniqueChainIds` and `assertRegistryAddressesWellFormed` are only
   called by tests.** They should also run at module init in development.
10. **No Solidity in this repository.** Executor bytecode hashes, deployment
    transactions and blocks cannot be recorded, so no network can pass
    CONTRACTS_VERIFIED and the executor requirement stays `pending` everywhere.
11. **`utc-clock` test** previously failed in this environment and now passes;
    it depends on a test-local storage shim, so it is environment-sensitive.

## Second pass — chained RPC variables, gate policy, registry unification

12. **A chain cannot be identified by the variable it is configured in.** The BSC
    mainnet/testnet entries contain the Base and Optimism URLs, so name-based
    assignment would have put Base endpoints on BSC. `rpc-pools.ts` now probes
    every configured URL once and files it under the chain id it proves; the
    proof run mapped 56, 97, 8453, 84532, 10 and 11155420 correctly from two
    BSC-named variables, with 0 rejects.
13. **The gate conflated two questions.** "May this network ever broadcast?"
    (framework gate, closed) and "may this operation sign right now?" (policy:
    live vs paper, cleared chains). Treating them as one blocked BSC payouts.
    `gate-policy.ts` separates them: paper is not gated, live is allowed only on
    production-cleared chains (BSC today), everything else keeps the refusal.
14. **Two RPC registries became one.** `src/lib/network-registry.ts` is now a
    view over `src/chains/registry/*`; endpoint lists exist once. `executionReady`
    there mirrors `LIVE_CLEARED_CHAINS` — a documented mirror, flagged as a
    drift risk until activation records replace both.
15. **Discovery is on demand, not on load.** `discoverEndpointsByChain` runs only
    when called (readiness report, explicit refresh) and caches for 5 minutes;
    probing public endpoints on every page load would be its own rate-limit bug.
16. **Residual risk:** `NETWORKS` is built at module init, so `service discovery`
    results observed after import are visible to `rpcFor()` only, not to the
    already-built registry objects. The report and `rpcManagerFor` read through
    `rpcFor()`, so they see fresh endpoints; a UI table rendered from `NETWORKS`
    would show the snapshot.

## Third pass — no BSC bypass, union of endpoints, diagnostics

17. **The hardcoded bypass is gone.** `LIVE_CLEARED_CHAINS` was a chain allowlist
    in the signing path. Live clearance now requires the executor the operator
    ACTUALLY armed on that chain, passed by the caller and compared against the
    executor being called. BSC qualifies for the same reason any chain would.
18. **Unknown chains no longer become BSC.** `networkKeyFor` returns `undefined`
    and the gate refuses with "Unknown chain … refusing rather than defaulting".
    `isBscChain()` still returns true for `undefined`, but it is now only a
    display/network-mode helper — the signing path does not use it.
    Residual risk: 49 call sites use it, so it must not be reused in a signing
    decision later.
19. **Discovered endpoints are additive, not a replacement.** `rpcFor` returns
    discovered → configured → verified public, deduplicated. Dropping the public
    endpoints whenever discovery succeeded turned one rate-limited provider into
    a dead network.
20. **Diagnostics found a real fault on first run**: `bsc.drpc.org` returned
    HTTP 429 for `eth_chainId` while three other BSC endpoints answered at
    ~300-570ms with a 3-block spread. That is exactly the public-endpoint
    rate-limit behaviour documented earlier, and now it is visible per endpoint.
21. **New gap introduced by evidence-based clearance:** arming a contract on
    Polygon would enable live execution there without a formal activation. The
    framework gate still blocks it (`execution.enabled` literal false) but the
    terminal policy does not consult it. Closing that needs the activation
    record wired into this policy — recorded as follow-up 1 below.
22. **Diagnostics is CLI-only** (`bun run check:rpc`). It is not surfaced in the
    Settings panel yet.

## Fourth pass — four independent controls

23. **Activation is now a real gate, not a comment.** `activations.ts` holds the
    only live-signing record in the app (BSC mainnet, with its evidence
    reference). Polygon, Base, Optimism, Ethereum, Arbitrum and every testnet
    have none, so an armed contract there cannot sign. Tests assert exactly that.
24. **The tautological check is gone.** It compared the requested executor with
    the armed executor supplied by the same caller. `canSignLive` now composes
    four clauses — registered ∧ activated ∧ armed ∧ chain-match ∧ no kill switch
    — and the activation record is what carries approval.
25. **Internal payout and external withdrawal were split.** `authorization.ts`
    exposes `authorizeInternalPayout` (armed executor + destination must be the
    designated vault + amount ≤ realised profit) and
    `authorizeExternalWithdrawal` (always refused, with the documented reason).
    A connected wallet and a typed address are both non-authoritative.
26. **Sniper wiring matches the policy.** The payout path classifies the
    destination: the vault itself is an internal payout, anything else is an
    external withdrawal and is refused with "External withdrawals are disabled".
    The withdrawal card always refuses. Refusals are recorded in `payoutBlocks`
    with distinct kinds (`execution-gate` vs `external-withdrawal-disabled`).
27. **`isBscChain(undefined)` is now false.** 49 call sites typechecked without
    change, which is evidence none of them depended on the default for a
    signing decision — but they were not reviewed one by one.
28. **Discovery results persist** to `localStorage` (`flashbolt.rpc.discovery.v1`)
    with a 10-minute TTL and URL re-validation on load; stale or malformed
    entries are dropped. Persistence is still client-local, not server-side.
29. **Diagnostics panel added** to Settings: read-only, probes on demand, shows
    per-endpoint origin/chain/latency/head and whether the chain is activated.

---

## Fifth pass — 2026-11-17 (activation backend, discovery registry, bytecode pin)

1. **Dynamic `import()` inside a Convex function** (`chainActivations.ts`,
   operator queries). The module graph is resolved at push time, so the call
   would throw at runtime; replaced by a static import. This is the kind of
   defect a typecheck cannot see.
2. **The activation seed is `address-unpinned`.** `bootstrapBscActivation`
   approves chain 56 without a `contractAddress`, so the gate accepts whatever
   is armed. The console can pin an address only by re-approving; the seed
   itself should have been re-created with the real executor.
3. **Bytecode unpinned proceeds.** `comparePinnedCode` returns
   `ok: true, unpinned: true` when no hash is stored. That is the right
   availability trade-off for a migration, but it means the check protects
   nothing until an operator pins; the log line is the only signal.
4. **`executionTargetReasons` is not on the swap path.** Only the payout path
   checks the executor. Router/factory/token/pool validation exists in the
   backend and store but nothing in the execution builder enforces it, so the
   "backend authoritative for all of them" requirement is only partly true.
5. **`internal` is still inferred from the payout signer.** `to === signer`
   is a client-side heuristic, not the server-controlled destination registry
   the policy asks for. A payout to the signer's own address is internal only
   because both values came from the same object.
6. **Endpoint selection falls back when nothing is validated.** `rpcFor` uses
   configured/public endpoints if the validated list is empty, which keeps the
   terminal online but means "validated first" is a preference, not a gate.
7. **Probe SSRF surface.** `assertPublicRpcUrl` blocks private/loopback/
   link-local names and credentials, but any public URL is still fetched by the
   server on request; there is no per-user rate limit and no allowlist.
8. **Validation TTL vs. trading session.** A 1-hour endpoint TTL means a long
   session can lose its validated pool mid-run and silently drop to public
   endpoints; the UI does not surface that transition.
9. **`validationRuns` grows without bound** and is not covered by the retention
   cron — the audit trail needs the same retention policy as `auditLogs`.
10. **Operator approval is an attestation.** The console records
    `operator-review` + `chain-id` checks supplied by the operator. That is
    evidence of review, not proof of correctness, and the snapshot text says so;
    it should not be read as a technical validation result.

---

## Sixth pass — 2026-11-17 (swap gate, destinations, seed, checks)

1. **Swap gate returns `simulationPassed: false`.** Callers treat that as a
   simulation failure, not an authorization failure; the message is the only
   signal. A caller that logs "simulation failed" will mislabel a policy refusal.
2. **Gate is on `buyToken`/`sellToken`, not on route construction.** Any code
   that builds and sends a swap transaction directly (flash-loan executor path,
   overlay script) bypasses it — the overlay is a separate userscript surface and
   was not changed.
3. **The registry classification is fail-closed but silent on the card.** The
   payout card still lists connected wallets; they now classify external and are
   refused, which is correct but the reason text only appears after the attempt.
4. **`internalDestinations` has no chain-level uniqueness.** Two enabled rows for
   the same chain are accepted; `internalDestinationFor` returns the first, so a
   second approval is silently shadowed. The console shows both.
5. **Seed evidence is code presence, not identity.** A router address with code
   proves deployment, not that it is PancakeSwap V2 or unmodified; no hash is
   pinned by the seed. Bytecode pinning remains an explicit operator step.
6. **Seed writes `source: "bootstrap"`** and skips any live VALIDATED row, but it
   will re-seed an address whose record was revoked (revoked rows are not
   "live"), which could quietly undo a revocation if someone reruns the seed.
7. **Checks panel is derived from caches.** If a query fails after a successful
   hydration the rows stay and the panel keeps showing green; it reflects the
   last successful backend answer, not liveness.

---

## Seventh pass — 2026-11-17 (refusal typing, payout unblock, executor flow)

1. **`simulationPassed: false` now has two meanings, distinguished by `blocked`.**
   Callers that ignore `blocked` still treat a policy refusal as a failed
   simulation; only the three call sites changed here branch on it.
2. **The approve button is operator-gated but discoverable by everyone.** A
   subscriber sees it and gets "Operator access required." — correct enforcement,
   poor affordance; hide it unless the operator console is visible.
3. **Approval targets the current session signer.** Approving from the card
   records whatever key is unlocked at that moment; there is no confirmation step
   showing the address that will become payable.
4. **Executor registration is self-attesting.** The only checks are "code exists"
   and "operator says this is the executor"; the hash is computed from the same
   code it later compares against, so it detects swaps after approval, not a
   wrong address at approval time.
5. **`pinContractCodeHash` requires an ACTIVE activation.** If the only record is
   PENDING, step 4 of the executor flow silently does nothing (`if (active)`) and
   the UI still reports success.
6. **`internalDestinations` uniqueness is still per-address, not per-chain.**
   Approving two vaults for chain 56 leaves `internalDestinationFor` returning the
   first; the second is unreachable without disabling the first.
7. **Blocked swaps are not audited.** Unlike payout blocks, a refused swap leaves
   no backend row, so "how often did policy refuse trading?" is unanswerable.

---

## Eighth pass — 2026-11-17 (executor flow, operator visibility, block audit)

1. **Executor confirmation is still operator attestation.** Two-step inspect/confirm
   makes the approved address and hash visible before pinning, and the hash is
   read from the chain at inspect time — but nothing proves the contract is the
   intended build. It detects change after approval, not a wrong address at it.
2. **`pinExecutorContract` now sets address + hash together**, so an approval can
   no longer pin a hash while leaving the address open. The old
   `pinContractCodeHash` still exists for hash-only pinning and should be removed
   once nothing calls it.
3. **The executor flow hardcodes chain 56** (`executionEnvFor("bsc","mainnet")`)
   and rejects other chains in the UI. Registering an executor for a newly
   activated chain requires extending that branch.
4. **Idempotent registration returns an existing row without re-reading its
   state.** A revoked executor record is not "duplicate" (status REVOKED), so it
   inserts a new row — correct — but a PENDING row returns its id and validation
   then overwrites the earlier checks.
5. **Auditing is client-initiated and best-effort.** A blocked swap is recorded by
   the Sniper after the refusal; if the mutation fails (offline, paused backend)
   the block disappears from the ledger. The gate itself cannot write.
6. **Auto-sell refusals are not audited.** `use-auto-sell` has no Convex handle,
   so its blocked sells remain log-only, unlike Sniper's.
7. **`executionBlocks` has no retention policy** and no aggregate query, so
   "blocked this week" still needs a manual scan of up to 400 rows.
8. **The approve button is hidden by `gate.isOperatorUser`**, which is a client
   read of a server verdict: hiding it is cosmetic; enforcement is unchanged.
9. **`isOperator` is computed per render from a query that may be undefined**
   while loading, so the control appears only after the check resolves — a brief
   absence, not a security gap.

---

## Ninth pass — 2026-11-17 (executor cross-check, auto-sell audit, counts)

1. **`deployedContractAddress` is a fallback, not a per-chain value.** On a
   multi-chain setup the cross-check compares against a single global address,
   which can be right for BSC and wrong for another armed chain.
2. **Comparison is string-normalized (trim + lowercase) but not validated.** A
   malformed armed value would mismatch and block registration rather than warn.
3. **The cross-check is advisory for registration only.** `pinExecutorContract`
   itself still accepts any address an operator supplies; the guard lives in the
   console path, not the backend.
4. **`onBlocked` fires on every refused auto-sell attempt.** A position that
   keeps failing policy can write a row per pass; there is no dedupe, so counts
   measure attempts, not distinct positions.
5. **Summary reads 500 rows and reports `capped`.** `byCode` and the 7-day count
   are lower bounds on a busy account, and the badge is easy to miss.
6. **`blockedExecutionSummary` returns `null` when signed out** and `undefined`
   while loading; the panel distinguishes those, but both render as absence of
   data rather than an error.
7. **Auto-sell's block callback is optional.** Any other future caller of
   `useAutoSell` that omits `onBlocked` silently returns to log-only auditing.

---

## Tenth pass — 2026-11-17 (backend executor enforcement, dedupe, exact counts)

1. **`pinExecutorContract` now depends on `terminalStates`.** If a user has no
   state row (never opened the terminal), pinning refuses even for a legitimate
   deployment. The message is actionable, but the dependency is new.
2. **Chain-key map is duplicated.** `CHAIN_KEY_BY_ID` in Convex mirrors the
   frontend registry by hand; drift would make one side refuse what the other
   offers. A shared generated constant would remove the risk.
3. **Testnet ids fold into the mainnet key**, so arming on testnet satisfies a
   mainnet pin (and vice versa) for the same key — the deployment record carries
   no network field.
4. **Dedupe key includes the reason string**, so a reason that embeds a varying
   amount (or a tx hash) defeats dedupe and writes a row per attempt.
5. **`hits` increments are not transactional with the scan.** Summary can observe
   a row mid-increment; the error is one attempt, never a negative or inflated
   total.
6. **`capped` remains possible at 5 000 rows.** Dedupe keeps that far away in
   practice, but a pathological reason string can still reach it, and the panel
   then shows a floor.
7. **Windows use `lastTs`.** A row that started 20 hours ago but repeated a minute
   ago counts in `last24h` — intended, but it means windows measure activity, not
   first occurrence.
8. **No retention.** Exact counts argue against pruning; the table now grows
   monotonically (at most 1 440 rows/chain/token/reason per day).

---

## Eleventh pass — 2026-11-17 (legacy pin, operator identity)

1. **Identity is now email→user→state.** `armedExecutorForOperator` assumes the
   operator's `users` row email matches the authenticated identity exactly
   (lowercase). Auth-created rows do, but a manually created row with mixed case
   would fail the index lookup and refuse a legitimate pin.
2. **Both pin paths share the same guard**, so there is one definition of "the
   armed executor" per chain. That is the improvement; the duplication it removes
   was the previous bug surface.
3. **Legacy pin is no longer a bypass.** It can only refresh the hash of an
   activation whose address already matches the arm, which is the only case where
   a hash-only write is meaningful.
4. **Legacy pin cannot repair an activation.** If the activation pins address A
   and the terminal arms B, the operator must re-run the executor flow; the legacy
   button will keep refusing, which is the intended dead end.
5. **Audit rows still carry the operator email as `actorId`**, not a user id — the
   trail answers "which account" but joining to `users` requires the email.
6. **The guard reads state at pin time only.** Arm the deployment, pin, then
   disarm: the activation keeps its approval and `canSignLive` refuses because the
   arming is checked separately. No new coupling was introduced.
7. **No automated coverage.** These handlers have no `convex-test` harness in the
   repo, so the refusals are verified by typecheck and by reading, not by tests.

---

## Twelfth pass — 2026-11-17 (pin-guard module, stale arms, guest pins)

1. **`armedAt` is written by `saveDeployment` only.** A deployment mirrored by any
   other path (import, migration, manual DB write) has no timestamp and is refused.
2. **Staleness is checked before address agreement**, so a stale + wrong pin
   reports `stale-arm`; the operator fixes the arm first, then the address.
3. **Arming is a save, not a proof.** Re-saving the same address refreshes
   `armedAt`; the guard cannot distinguish "this deployment is current" from "the
   operator clicked save recently".
4. **Guest pinning broadens the surface.** A verified guest session can now pin an
   executor for its own terminal. That is consistent with guest access to the
   console, but the guest's state is disposable — pinning from a guest session that
   later disappears leaves an activation pinned to an arm nobody can re-verify.
5. **`requirePinOperator` duplicates part of `requireOperator`.** Two operator
   checks now exist with different guest behaviour; a future change to operator
   policy must update both.
6. **The guard is pure and shared**, so the console's message and the server's
   refusal come from one source; the console still does its own preview check with
   the same function shape but separate inputs (browser cache).
7. **Tests cover the rules, not the mutations.** `convex-test` is still absent, so
   the wiring (identity → state → guard → patch) is typecheck-verified only.

---

## Thirteenth pass — 2026-11-17 (unified identity, action-based verification)

1. **Identity now flows through explicit claims.** The action derives email/user id
   from its own `ctx.auth` and hands them to an internal query. Internal functions
   are not client-reachable, so the claims cannot be forged — but this is the one
   place where the rule "identity is read from `ctx.auth`" is indirect, and it must
   stay that way (never call `inspectionTarget` from anything public).
2. **The pin mutation trusts the evidence table, not the chain.** If the inspection
   row is deleted (the actor's expired rows are pruned on each write), an in-flight
   confirmation fails with "No fresh server-side inspection" rather than a stale
   approval — the pruning and the TTL interact, and both are 10 minutes.
3. **`recordCodeInspection` prunes per actor with a full index read.** Bounded by
   how often an operator inspects, but it is a collect-then-delete on every call.
4. **The action re-runs the guard** before reading code, so it cannot be used as a
   free "read any address" oracle: only the operator's own armed executor, on an
   ACTIVE activation, is read.
5. **Arm timestamp semantics changed.** `armedAt` now tracks the address, not the
   save. A deployment past the 30-day limit cannot be refreshed by re-saving the same
   address; the operator must re-arm a (possibly identical) address after a change
   that bumps it, or the pin stays refused. This is the honest reading of "reject
   stale arms", but it is a behaviour change for anyone who expected Save to refresh.
6. **RPC host is stored in audit reasons.** It is a hostname, not a URL with an API
   key — `new URL(...).host` on a keyed endpoint (`https://rpc.example/v1/SECRET`)
   drops the path, so no credential can leak into an audit row.
7. **Tests cover guards and freshness, not the action.** The `fetch` injection seam
   is what makes the reader testable; the action itself remains untested.

## Fourteenth pass — 2026-11-18 (server-issued clock, evidence-linked approvals)

Reviewed: `pinGuard.ts` inspection window, `ActivationConsole` confirm/inspect
flow, both pin mutations, `chainActivations.currentActivations`, the registry
mapper, and the payout bytecode check in `Sniper.tsx`.

### Fixed during review

1. **The countdown was gated on the browser clock.** `pinGuard.inspectionAgeLabel`
   took `Date.now()` from the page, so a skewed (or user-adjusted) clock could
   show fresh evidence as expired, or expired evidence as fresh until the server
   refused. The action now returns `expiresAt` (server-stamped from the
   observation) and `serverNow`; the console counts down with
   `inspectionRemainingMs` over `performance.now()` elapsed time. The browser's
   wall clock is no longer an input, a non-finite expiry fails closed, and the
   server remains the only decider (`freshInspection` still uses its own clock).
2. **The console could pin against the wrong chain's approval.** Confirm selected
   `activationRows.find(row => row.effectiveStatus === "ACTIVE")` — ANY chain —
   while the inspected address and the registry record were for the chain in the
   field. The mutation's own guard caught it, but only after the executor record
   had been registered, and the refusal read like a guard failure rather than a
   selection bug. Confirm now filters by `row.chainId === numericChain`, matching
   the Inspect step.
3. **Approvals did not point at their evidence.** `executorCodeInspections` rows
   were pruned after the TTL and nothing durable recorded which observation an
   approval rested on; the audit reason mentioned bytes and host but was free
   text. Both pin mutations now copy `contractCodeInspectionId`,
   `contractCodeInspectedAt` and `contractCodeRpcHost` onto the activation, the
   audit reason ends with `evidence <id>`, the read path exposes the fields, and
   the console shows when and via which host the approved code was read.

### Open findings

4. **The evidence id can dangle.** Rows older than the TTL are deleted on the next
   inspection by the same actor, so `contractCodeInspectionId` may name a row that
   no longer exists. The durable facts (hash on the activation, bytes/host in the
   audit reason) survive; a dedicated append-only evidence table, or a retention
   window longer than the activation term, would remove the dangling reference.
5. **Pinned code is re-checked on the payout path only.** `verifyExecutorPinned`
   in `Sniper.tsx` reads the runtime code before an internal payout and refuses a
   mismatch. Other live-signing entry points rely on the approval record itself,
   so a contract swapped after pinning is caught where that check runs, not
   everywhere. The claim in `pinContractCodeHash`'s comment ("the signing path
   re-reads the code") is true for that path and should not be read as universal.
6. **Two clock readings still exist server-side.** `inspectionTarget` validates
   the arm with `Date.now()` and `recordCodeInspection` stamps a later
   `Date.now()`; the difference is milliseconds, but the returned `expiresAt`
   describes the observation while the guard's freshness decision describes the
   request. Keeping them as separate values is honest; do not compare them as if
   they were one instant.
7. **The countdown is presentation only.** Disabling Confirm when the window
   closes is a courtesy: the mutation re-checks freshness with the server clock,
   which is what actually enforces the TTL. A client with a paused timer cannot
   pin late.

## Fifteenth pass — 2026-11-18 (deploy config, headers, arm stamps, evidence stats)

Reviewed: the three deploy descriptions (`wrangler.toml`, `sites.deploy.json`,
the now-deleted `wrangler.sites.local.jsonc`), `public/_headers` and what the two
live origins actually return, `pinGuard.nextArmedAt` and its two callers
(`saveDeployment`, `backfillArmStamps`), and the evidence-pruning pair
(`pruneExpiredInspections` / `pruneInspectionEvidence`).

### Fixed during review

1. **Three deploy configs described one deploy.** `wrangler.toml`,
   `sites.deploy.json` and `wrangler.sites.local.jsonc` each repeated the entry
   module, compatibility date and asset directory. The local override was pure
   duplication (nothing referenced it, `wrangler dev` reads `wrangler.toml`) and
   is deleted. The manifest has to keep the values — the deploy call reads them
   from `sites.deploy.json` — so parity is now enforced instead of hoped for:
   `scripts/check-deploy-config.mjs` compares both files key by key, checks that
   every declared module exists, that the entrypoint names a declared module,
   that `spa` matches `not_found_handling: single-page-application`, and that the
   asset directory is git-ignored (so a couple of tracked files can never become
   "the build" on one platform and a leftover on another). It runs as step 3 of
   `bun run verify`.
2. **The security-header question is answered by the wire, not by the docs.**
   `_headers` *is* applied by Workers static assets on the Sites deploy — the
   preview returned the whole block on `/` and on a hashed asset, with
   `cache-control: public, max-age=31536000, immutable` from the `/assets/*`
   rule. Only `_redirects` is rejected (upload code `100324`), which matches the
   earlier deploy failure. The gap was HSTS: Vercel (`taengine.freebuff.app`)
   sends `strict-transport-security`, the Sites origin sent none, so
   `Strict-Transport-Security: max-age=31536000` was added to the shared block
   (no `includeSubDomains`: the host is a shared `freebuff.page` subdomain).
3. **`armedAt` carried two facts.** It meant "when this address was armed" and
   also, on a pre-timestamp record, "when someone first saved it" — so an
   operator could not tell a 20-day-old arm from a 20-minute-old save. Arm
   stamps are split: `armedAt` (what the guard measures), `firstArmedAt` (equal
   to `armedAt` for every arm recorded since the field existed, deliberately
   absent for older records rather than back-dated) and `affirmedAt` (the last
   save). Re-saving the same address still moves only `affirmedAt`, so the
   anti-laundering rule is unchanged; the guard reads `armedAt` through the
   named `armStampForGuard` helper instead of re-deriving it.
4. **The evidence sweep was unobservable.** It deletes rows, keeps referenced
   ones forever and runs every six hours — with no way to see its effect short of
   opening the Convex dashboard. `inspectionEvidenceStats` is a dry run of the
   same window (oldest 2 000 rows, oldest-first, the order the prune uses) that
   reports fresh / expired-referenced / expired-unreferenced counts, what the next
   sweep may delete, the oldest prunable stamp, how many ids approvals reference
   and a per-chain breakdown. It is operator-gated, deletes nothing and writes no
   audit row.

### Open findings

5. **The Worker's HTML rewrite may be bypassed on Sites.** The live `/` response
   carries `cache-control: public, max-age=0, must-revalidate`, which is the
   asset layer's value — `sites/worker.js` sets `no-store` for every HTML
   response it handles. If the platform serves asset paths before the Worker
   (and the deploy manifest exposes no `run_worker_first`), the RPC-config
   injection never runs on the Sites deploy. It is harmless when no RPC secret is
   configured (the injected block would simply be absent) but it must not be
   relied on until a real secret proves it. Vercel does not run the Worker at
   all, so `taengine.freebuff.app` depends on build-time `VITE_RPC_*` values.
6. **`X-Frame-Options: DENY` is correct and inconvenient.** A signing terminal
   should not be embeddable, but the same header prevents an in-panel iframe
   preview: the published app must be opened in its own tab.
7. **CSP is still absent, now with a written reason.** The page uses an inline
   `application/json` block injected by the Worker and opens wallet popups. A
   policy needs a nonce in `sites/worker.js` and an explicit `frame-src` /
   `connect-src` inventory for wallet and RPC hosts — a header-line guess would
   break connect and deploy.
8. **`firstArmedAt` cannot be recovered for existing arms.** The field is absent
   where the fact is unknown, and `affirmedAt` shows only recency of the save.
   Both are honest; neither answers "how long has this been armed?" for a chain
   armed before this pass.
9. **The stats window is a floor when it fills.** 2 000 rows is a bound, not a
   census; `capped: true` says so. Exact history would need the cron to write a
   counter per run.

## Sixteenth pass — 2026-11-18

1. **CSP is on, nonce-based, and checked on the wire.** `sites/worker.js` mints a
   128-bit nonce per HTML response, stamps every `<script>`/`<style>` tag (the
   module bundle, the inline boot watchdog, the boot-loader style, the RPC JSON
   block, and whatever the preview host injects) and returns the matching
   `Content-Security-Policy`. The policy is emitted **only** on a response the
   Worker rewrote, so a host serving `dist/` without it is never sent a policy
   whose nonce its HTML lacks. Verified: `/` returns
   `script-src 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'` and every script in
   the served document carries that nonce.
2. **The first policy blocked the preview host's own helper.** With
   `script-src 'self' 'nonce-…'` the panel logged a CSP violation for
   `html2canvas-pro` (loaded by the preview overlay, not by this app) and
   `window.html2canvas` stayed undefined. `'strict-dynamic'` fixes it the right
   way — trust flows from an already-trusted (nonced) script instead of naming a
   third-party host. After redeploy the browser console is clean, the app boots
   (`#root` renders, all lazy routes 200) and `window.html2canvas` is defined.
   `style-src 'unsafe-inline'` remains because React sets `style` attributes;
   `'wasm-unsafe-eval'` is required by the real solc compiler's WebAssembly.
3. **The `onclick=` in `index.html` had to go.** A nonce policy blocks inline
   event handlers, which would have silently broken the crash watchdog's Reload
   button. It is now `id="fb-boot-reload"` with a listener bound inside the same
   inline (nonced) script. No `onclick` attribute remains in the built document.
4. **The "Worker may be bypassed on Sites" finding was a probe artefact.** The
   earlier check sent no `Accept: text/html`, so the assets binding answered the
   way it answers any asset request. With a browser `Accept`, `/` returns
   `cache-control: no-store` plus the rewrite — the Worker is in the path.
5. **RPC injection is proven with the operator's real secret.**
   `sites/worker.test.ts` reads the untracked `.env.local` at run time (skipped
   when absent), and asserts every endpoint configured in `BSC_MAINNET_RPC_URL`
   reaches `BSC.http` and `env` byte-for-byte, that `<` is escaped in the JSON
   block, that the block is non-executable `application/json` carrying the same
   nonce, and that nothing leaks into a non-HTML response. The run reported 60
   endpoints from that variable; only the protocol and host length are printed,
   never the value. Eleven tests cover the Worker in total (policy, nonces,
   HEAD, non-HTML, malformed values, injection, real secret).
6. **Arm ages are visible where the decision is made.** The Contract page's
   "Live deployment" card renders the current arm, first-arm and last-save ages
   from `armedAt` / `firstArmedAt` / `affirmedAt`, prints "not recorded" where the
   fact is genuinely unknown (pre-timestamp arms) rather than inventing one, and
   warns when the current arm is past the 30-day limit the pin guard enforces.

### Open findings (updated)

7. `besides the arm-age display, nothing else renders the split stamps` — the
   Overview/Bot pages still show only "armed / not armed", which is the fact they
   act on; no stale-arm warning is shown there before a pin is attempted.
8. `taengine.freebuff.app` does not run `sites/worker.js`, so it receives neither
   the nonce policy nor the RPC-config injection. It picks up source changes only
   when Vercel rebuilds from the pushed commit, and its endpoints still come from
   build-time `VITE_RPC_*` values.
9. The policy allows `connect-src https: wss:` for the whole web because RPC
   endpoints are operator-supplied. Narrowing this needs a per-deployment host
   inventory that the Worker does not currently have.

## Seventeenth pass — 2026-11-18 (host header parity, graded stale-arm warnings)

Reviewed: `public/_headers`, `vercel.json`, `netlify.toml`, `scripts/` (deploy and
release gates), `src/pages/terminal/Contract.tsx` arm stamps, `sites/worker.js`.

### Fixed during review

1. **`taengine.freebuff.app` was sending a different header set than the
   Worker-hosted build.** `vercel.json` still carried `Referrer-Policy:
   strict-origin-when-cross-origin` (the `_headers` value is `no-referrer`), and
   it sent neither `Strict-Transport-Security` nor `X-Robots-Tag: noindex,
   nofollow`, and had no `/robots.txt` cache rule. The same document was
   therefore framed, referrer-leaking and indexable on one host and not the
   other — invisible from inside the app. `vercel.json` now carries every value
   `_headers` carries, and `Content-Security-Policy` stays absent on both
   (only `sites/worker.js` can send a policy that matches its nonce).
2. **The drift is now a failing check, not a convention.**
   `scripts/check-headers-parity.mjs` parses `_headers` and `vercel.json`,
   resolves each the way its host does (every matching rule in file order, later
   values overriding earlier ones) for one probe path per declared rule, and
   fails on any header that is missing, different or extra. It is wired into
   `bun run verify` as step 4/6 and available as `bun run check:headers`. It
   reports 9 paths × 66 headers in parity. Proven against a real regression:
   restoring the old `strict-origin-when-cross-origin` value fails all nine
   paths with the exact expected/actual pair.
3. **Stale arms are now warned about before they are refused.** The Contract
   page graded the arm into fresh / stale / expired, with the remaining days the
   pin guard will still accept it, an amber "Stale arm" badge from day 23 and a
   rose "Arm expired" badge past the 30-day hard stop; a missing stamp stays a
   danger (pins refuse it until the deployment is saved once more). The wording
   never promises a pin that the backend guard would refuse, and it names the
   expiry rather than making the operator infer it from a refusal.

### Open findings (updated)

4. `netlify.toml` repeats the pre-fix Vercel header set (same referrer value,
   no HSTS or robots tag). Left untouched because Netlify is not a live target
   here; when it becomes one, the parity check extends to it by adding its
   `[[headers]]` tables to the resolver rather than by copying values.
5. `taengine.freebuff.app` still runs no Worker: it gets no nonce CSP and no
   RPC-config injection, and only picks up a source change when Vercel rebuilds
   from the branch it tracks. Pushing this branch does not rebuild it; the
   commit has to land on that branch.
6. Arm stamps are rendered only on the Contract page; Overview/Bot show
   "armed / not armed" and would benefit from the same badge when they show a
   pin action.

## Eighteenth pass — 2026-11-18 (Netlify parity, derived stale window)

Reviewed: `netlify.toml`, `scripts/check-headers-parity.mjs`,
`src/pages/terminal/Contract.tsx` arm helpers, `src/convex/pinGuard.ts`,
`scripts/verify-release.sh`, `DEPLOYMENT.md`, the live `taengine.freebuff.app`
response headers.

### Fixed during review

1. **Netlify had the stale header set the review flagged as an open finding.**
   `netlify.toml` still sent `Referrer-Policy: strict-origin-when-cross-origin`
   and no `Strict-Transport-Security`, `X-Robots-Tag` or `/robots.txt` rule, so
   the same document leaked referrers and was indexable on Netlify while the
   Worker and Vercel hosts sent `no-referrer`/`noindex`. It now mirrors
   `public/_headers` value for value, with `/downloads/*.tar.gz` after
   `/downloads/*` because Netlify applies later matching blocks last.
2. **The parity gate covers all three hosts, not two.**
   `scripts/check-headers-parity.mjs` parses `netlify.toml`'s `[[headers]]`
   tables too, resolves each host the way that host resolves headers, and
   compares every host against `public/_headers` as the reference over one probe
   path per declared rule (including paths only another host declares). It
   reports 9 paths × 66 headers per host and fails on netlify-only drift; proven
   by injecting the old referrer value (nine failures) and by deleting HSTS
   (nine failures), then restoring.
3. **The stale window is derived, not chosen.** The page kept its own
   `30 * 86_400_000` literal next to the pin guard's `ARM_MAX_AGE_MS`. It now
   imports the guard's constant, derives the limit in days for the copy, and
   computes the warning threshold as `ARM_MAX_AGE_MS - 7 days` (clamped at
   zero), so shortening the backend limit shortens the UI window instead of
   leaving the warning past the refusal point.

4. **CI could not pass on a fresh checkout, and the reason was a stale
   assumption.** The workflow ran `bunx convex codegen`, justified by a comment
   saying `src/convex/_generated` is gitignored. It is not: five generated files
   are tracked, so the step was both unnecessary and fatal — `convex codegen`
   needs a configured deployment and exited 1 with "No CONVEX_DEPLOYMENT set",
   failing `verify` on the first push to `main`. The step is removed; typecheck
   now reads the committed generated types.

### Open findings (updated)

5. **The live domain's headers do not match this repository's `vercel.json`.**
   `https://taengine.freebuff.app` answers with `cache-control: public,
   max-age=0, must-revalidate` (the file says `no-store, must-revalidate`),
   `strict-transport-security: max-age=63072000` (the file says `31536000`) and
   no CSP. Either that deployment predates this tree or the Vercel project
   overrides file headers at project level; the parity check proves the files
   agree with each other, not that the host has applied them. Re-check the
   response headers after the next rebuild.
6. **Parity is proven for Netlify statically, not on a live Netlify deploy.**
   There is no Netlify site in this workspace to curl, so the guarantee is that
   the config says the same thing as the reference — Netlify's own application
   of the blocks is unverified here.
7. `taengine.freebuff.app` still runs no Worker: it gets no nonce CSP and no
   RPC-config injection, and only picks up a source change when Vercel rebuilds
   from the branch it tracks. GitHub reports no deployments on this repository
   (`/deployments` is empty), so the Vercel project behind that domain is not
   wired to `silk202/bnb-bot` — a push cannot rebuild it.
