# Solana V3 review and `FlashboltSolana.so` deployment readiness — 2026-11-19

Scope: the Solana execution path in this repository (`src/lib/solana-*.ts`,
`src/pages/terminal/Sol*.tsx`, `scripts/devnet-drill.ts`) against the FlashBolt
V3 Solana specification, plus the request to compile and deploy
`FlashboltSolana.so`.

Method: static review of the current tree. No Solana transaction was signed or
broadcast, no program was deployed, and no code was changed by this pass.

## Verdict first: there is no `FlashboltSolana.so` to compile or deploy

Searched the whole workspace (excluding `node_modules`):

- no `FlashboltSolana.so` and no `.so` of any kind;
- no `Anchor.toml`, no `Cargo.toml`, no `rust-toolchain`, no `programs/` tree;
- no match anywhere for `FlashboltSolana`, `flashbolt_solana`, or
  `flashbolt-solana`;
- `solana`, `cargo`, `rustc`, `anchor`, `avm` are all **not installed** in this
  environment.

The app's Solana engine is TypeScript that quotes and submits ordinary Jupiter
swaps from a user wallet. It is not an Anchor program, and the SOL Contract page
states that explicitly: "Solana has no V2-router-style contract to deploy"
(`src/pages/terminal/SolContract.tsx:4`, `:68-82`).

So the requested build step has no input. Producing a `.so` from nothing would
mean authoring the entire audited Rust/Anchor program first (the V3 document's
16 deliverables), then installing the Solana toolchain, building, and deploying
with a funded authority key — none of which exists here. Nothing was mocked or
stubbed to imitate that; the blocker is reported instead.

### What deployment would actually require

| Requirement | Status here |
| --- | --- |
| Anchor program source (or a prebuilt `.so`) | **Missing** — not in the repo |
| Solana CLI + platform-tools (`cargo-build-sbf`) | **Missing** |
| Program keypair / program ID per cluster | **Missing** |
| Funded deploy authority (program rent ≈ 2–4 SOL, plus buffer) | **Missing** — no keypair, no funds |
| Cluster/genesis verification before signing | Not implemented anywhere |
| Independent security audit | **Not done** (the V3 document requires it before mainnet) |
| Explicit mainnet activation approval | Not granted; V3 says mainnet stays disabled |

A mainnet `solana program deploy` is an irreversible external action that spends
real SOL; it will not be attempted without the binary, a funded authority, and
explicit approval. Devnet would still need built source and a funded keypair.

## Findings

### P0 — the arb path spends the wallet's own SOL; there is no flash loan

`SOL_FLASH_LENDERS` (`src/lib/solana.ts:105-112`) lists Solend / MarginFi /
Kamino and `SolContract.tsx:36` presents them as a live "Flash-loan stack", but
nothing in the execution path calls any lender. `executeLiveArb`
(`src/lib/solana-live-execution.ts:832`) does:

1. `preflightSolBuyBalance` against the wallet,
2. `buildAndSignLiveArb` → two Jupiter swap transactions,
3. submit buy, confirm, submit sell, confirm.

The wallet *fronts the clip* — the code says so itself at
`solana-live-execution.ts:497` ("the wallet FRONTS the whole clip (no borrowed
principal)"). There is no borrow instruction, no repayment instruction, no
provider fee, and no atomic borrow→trade→repay transaction. This contradicts the
V3 requirement (atomic flash-loan execution with on-chain repayment and minimum
profit) and the UI's lender labels.

### P0 — the two-leg arb cannot land on a fresh position

Before the buy is broadcast, `buildAndSignLiveArb` simulates the *sell* leg
(`solana-live-execution.ts:288-310`). The sell quote is built for
`buyQuote.outAmount`, tokens the wallet does not hold yet. A real
`simulateTransaction` of a token→SOL swap against an empty balance fails with
insufficient funds, so:

- the buy leg is signed (wallet prompt already spent),
- the sell simulation fails,
- the function throws "sell leg would fail on-chain … buy leg signed but NOT
  broadcast, nothing spent",
- `executeLiveArb` returns failure and nothing is broadcast.

This means every fresh signal route is refused, and only a wallet that already
holds ≥ the buy output can pass. The check is in the wrong order: a sell
simulation is only meaningful after the buy confirms (or must be skipped and
replaced by a post-buy simulation). This is a functional defect, not a policy.

### P1 — Jito submissions carry no tip, and the UI says they do

`buildJitoBundlePayload` computes a tip and then discards it:

```ts
const tip = Math.max(JITO_MIN_TIP_LAMPORTS, opts.tipLamports ?? JITO_MIN_TIP_LAMPORTS);
void tip;                                            // solana-jito.ts:203-207
```

No `SystemProgram.transfer` to a Jito tip account exists anywhere in the
repository. `jitoSendProtectedTx` posts one already-signed transaction with
`?bundleOnly=true` (`solana-jito.ts:164`) and no tip instruction. Jito's
single-transaction bundle path expects the tip in that transaction; without it
the submission is rejected or not selected. `SolSniper.tsx:1351` nonetheless
advertises "≥ 1,000-lamport tip", and `SolContract.tsx:43` calls the relay
"done". Additionally, the same signed transaction is raced to nine regional
engines at once — harmless for landing (same signature) but wasteful and
confusing in logs.

### P1 — the reported profit is a stale quote pair, and never realized

`buildAndSignLiveArb` quotes twice:

- `priceSolRoundTrip` (`:262`) → `plan` used for the reported `netLamports` /
  `netPct`,
- `jupiterQuoteSolToToken` (`:267`) → the buy transaction actually built,
- `jupiterQuoteTokenToSol` (`:288`) → the sell transaction actually built.

`executeLiveArb` returns `signed.plan.expectedNetLamports` (`:958`) while the
executed legs come from the second quote pair. The two can differ, and the plan's
`sellInRaw` is not the amount the sell actually sells. The interface comment
calls this "Realized net"; no post-trade balance is ever measured. A profitable
look in the ledger can therefore be a loss on chain.

### P1 — no minimum-profit enforcement at execution

`executeLiveArb` accepts no profit floor. The scanner's floor
(`SolScanner.tsx:214`) is applied to the DexScreener-derived `r.profitPct`, not
to the Jupiter execution quotes. Nothing stops a route whose quoted net is
negative, or whose net is eaten by priority fee/ATA rent, from being built,
signed and broadcast. It is also never compared against `r.loanSizeSol` beyond
display.

### P1 — cluster integrity is not verified

- `SOL_RPC_ENDPOINTS.testnet` points at `https://api.devnet.solana.com`
  (`solana-jito.ts:49`), so the "testnet" cluster is really devnet; the UI label
  says "Solana Devnet (testnet)".
- Per-cluster RPC overrides come straight from terminal settings
  (`resolveSolRpcUrl`), and no `getGenesisHash` check runs before signing. A
  mainnet wallet can be pointed at a devnet override (or vice versa) without a
  refusal, contrary to the V3 requirement to verify the cluster before signing.

### P1 — the vault signer signs whatever it is handed

`makeKeypairSigner` (`solana-vault.ts:402-410`) signs any `VersionedTransaction`
with the in-memory keypair and never checks:

- the fee payer equals the vault address,
- the program IDs are the approved set (Jupiter, compute budget, SPL token/ATA),
- the instructions match the route that was quoted.

The transaction comes from `lite-api.jup.ag` and is signed silently (no wallet
prompt). An injected-extension user at least sees a confirmation dialog; the
vault path has no such check. Before this signs real funds it should verify fee
payer and an allowlist of program IDs.

### P2 — transport and confirmation edges

- `waitForSigConfirm` (`:340`) polls for 60s but never checks blockhash
  expiry/`lastValidBlockHeight`, and submission uses `maxRetries: 0`
  (`solana-jito.ts:124`), so an aged blockhash costs a full timeout.
- `postRpc` (`solana-live-execution.ts:520`) does not check `res.ok` or handle a
  non-JSON body; an RPC 502 surfaces as a JSON parse error.
- `priceImpactPct` is multiplied by 100 on the assumption Jupiter returns a
  fraction; worth pinning with a fixture test so a future API change cannot
  silently understate impact.

## What is genuinely solid

- Vault cryptography (`solana-vault.ts`): PBKDF2-SHA-256 310k, AES-256-GCM,
  non-extractable key, ciphertext only in `sessionStorage`, passphrase never
  persisted, lock/wipe paths clear memory.
- Pre-sign simulation with balance-delta and compute-budget checks
  (`solana-jito.ts`), including the honest "transport error is not a verdict"
  distinction.
- Wallet-fit math (`fitRouteLoanToWallet`) and refusal messages carry exact
  numbers; live mode never silently falls back to paper.

## Recommended order (no disruption to the shipping BNB/SOL terminals)

1. **Stop advertising flash loans on Solana** until a lender adapter exists, or
   implement one. Today's route is a self-funded round trip; the UI and the
   ledger should say that.
2. **Fix the sell-leg ordering** (simulate the sell only after the buy confirms,
   or skip it and rely on post-buy simulation) so the arb path is not dead.
3. **Add a Jito tip instruction** to the transaction that is submitted with
   `bundleOnly=true`, or stop claiming a tip is paid.
4. **Report realized profit** from post-sell balances, and enforce a
   minimum-net-profit floor at execution using the same quotes that built the
   transactions.
5. **Verify the cluster** (genesis hash) and correct the testnet/devnet
   endpoint mapping.
6. **Harden the vault signer**: fee-payer check and program-ID allowlist before
   signing.
7. Only then start the separate Rust/Anchor program (V3 phases 1–2), build it
   with the Solana toolchain, deploy to devnet, and commission the audit before
   any mainnet activation.

Items 1–6 are small, testable changes in the existing TypeScript engine and do
not touch the deployed EVM contract or require a program deployment. Item 7 is
the multi-week program build the V3 document describes, and it is blocked on
source, toolchain, a funded authority, and audit.

## Remediation — 2026-11-19 (sell order, tip, realized PnL, vault gate)

Four of the findings above are fixed in the TypeScript engine. No EVM code, no
contract, and no deployment was touched.

### Sell leg runs after the buy, against tokens actually held

`buildAndSignLiveArb` is gone. `executeLiveArb` now quotes the buy, submits and
confirms it, reads the token balance delta over the pre-buy balance, and only
then quotes/simulates/signs/submits the sell for exactly the tokens this route
bought (`src/lib/solana-live-execution.ts`). Pre-existing holdings are no longer
sold by an arb signal, and a fresh route no longer dies at a sell simulation
that ran while the wallet still held zero tokens.

### The Jito tip is attached before signing

`addJitoTipToUnsignedTx` (`src/lib/solana-jito.ts`) fetches the tip accounts
from the block engine itself (`getTipAccounts`, cached per engine — no
hard-coded list to rot), decompiles the unsigned transaction (resolving address
lookup tables through the RPC), appends a `SystemProgram.transfer` tip, checks
the 1232-byte packet limit, and re-serializes with placeholder signature slots.
If the tip accounts, a lookup table or the size limit cannot be satisfied, it
refuses instead of submitting an untipped "protected" transaction.

Both legs of the arb and both sniper legs go through one `submitJupiterLeg`
helper, so the tip is applied on every Jito path (`executeLiveSnipeBuy`,
`executeLiveSnipeSell`, `executeLiveArb`), before the wallet signs.

### Profit is realized, not re-quoted

`executeLiveArb` records the wallet's SOL balance before the buy and after the
sell confirms (commitment `confirmed`, matching the confirmation it waits for)
and reports `netLamports` / `netPct` from that delta. Priority fee, Jito tip,
ATA rent and network fees are inside the number. The quote-time expectation is
kept separately as `quotedNetLamports` / `quotedNetPct`. `realizedNetLamports`
returns zero rather than inventing profit from an unreadable balance, and token
balances are now read at `confirmed` commitment so a just-landed buy is not
mistaken for zero.

### The vault signer refuses foreign transactions

`vaultSignerVerdict` (`src/lib/solana-vault.ts`) gates the in-memory key before
it signs: the fee payer must be the vaulted address, every program must be on
`VAULT_ALLOWED_PROGRAMS` (Jupiter v6, SPL Token, Token-2022, ATA, Compute
Budget, Memo, System), and System instructions are limited to `transfer` (the
tip). Unknown programs and authority-changing System instructions are refused
with the offending program/instruction named.

### Verification

- `bun test`: 662 pass / 0 fail (54 files).
- `tsc -b --noEmit` clean; eslint clean on every touched file.
- New tests: `src/lib/solana-vault-signer.test.ts` (fee payer, unknown program,
  System non-transfer, malformed data, allowlist), `src/lib/solana-live-execution.test.ts`
  (realized gain/loss, rounding, unreadable balances, zero clip), and a tip test
  in `src/lib/solana-jito.test.ts` that deserializes the result and asserts a
  real System transfer was appended with the right payer and signature slots.

### Still open

- **No flash-loan adapter.** The route is still a self-funded round trip; the
  lender labels remain display-only until a provider adapter borrows and repays
  inside one transaction.
- **No execution-time profit floor.** The scanner's floor still applies to the
  DexScreener spread; `executeLiveArb` does not yet receive a minimum realized
  profit.
- **Cluster integrity.** `testnet` still maps to devnet and no genesis-hash
  check runs before signing.
- **Tip insertion with address lookup tables has not been exercised against a
  live RPC here** — the unit test covers a message without lookups; the ALT
  fetch path is typechecked and reviewed, not run.
