# FlashBolt Solana program — security model

Scope: the Anchor program in `solana/programs/flashbolt_solana`. It currently
contains the configuration registry and authority controls only. No execution
instruction, no CPI, no token movement and no `invoke_signed` exist in this
build. The sections marked *planned* describe the execution milestone that this
document is meant to govern before its code lands.

Nothing in this program has been audited and nothing has been deployed. Mainnet
is off.

## Assets at risk

| Asset | Where it lives | Loss scenario |
| --- | --- | --- |
| The `Config` PDA | one account, `[b"flashbolt_config"]`, rent-funded by the initial admin | anyone who can write it can re-point the executor or lift the pause |
| The executor hot key | operator infrastructure (not on chain) | a stolen key trades the program's capital until the pause lands |
| Borrowed principal during a flash loan | the borrower's token accounts, one transaction | a bad route or a bad repayment leaves the loan unrepayable, so the whole transaction reverts — the lender cannot lose, but the executor pays fees and slippage |
| The program's upgrade authority | deploy keypair, held outside the repository | a compromised upgrade key can replace the program entirely; this is the largest single key in the system |
| Off-chain route/quote data | client and Jupiter services | a malicious quote aims the trade at the wrong pool or mint |

## Trust boundaries

1. **Admin key → everything.** The admin rotates the executor and pause
   authority, nominates its successor and lifts the pause. It cannot move funds
   because no instruction moves funds.
2. **Executor key → execution.** It is the only key that may authorize a trade
   and it must remain a hot key with a minimal balance. It holds no
   configuration power.
3. **Pause authority → stop only.** It can pause and cannot unpause, so a
   stolen pause key cannot restart trading.
4. **Client input → untrusted.** Amounts, routes, pool lists, minimum out and
   deadlines arrive from outside the program. None of them may be trusted:
   principal is confirmed by balance delta, the venue is a constant, and the
   minimum out is derived or bounded on chain.
5. **Lender and DEX programs → semi-trusted.** Program ids are constants in the
   program, checked on every CPI account. A pool's mints, vaults, token
   programs and authorities are validated per call; a pool that fails
   validation is refused, not repaired.
6. **Aggregator (phase two) → untrusted.** A Jupiter `/build` response is an
   off-chain quote wrapped in instructions. Every account it references is
   checked against an allowlist and the route must start and end with the
   expected mints.

## Threat model

| # | Threat | Impact | Mitigation |
| --- | --- | --- | --- |
| 1 | Stranger writes `Config` | total takeover | every mutating instruction requires a `Signer` that matches the live role; the PDA is derived from a fixed seed with the stored bump |
| 2 | One key holds admin, executor and pause | single point of failure | distinctness enforced at `initialize_config`, `update_authorities` and again at `accept_admin` (an authority can rotate during a handshake) |
| 3 | One-call admin transfer to a typo or burn address | bricked registry | two-step `propose_admin` / `accept_admin`; the nominee must sign, and a new proposal overwrites the pending one |
| 4 | Stolen pause key restarts trading | unauthorized execution | `unpause_program` is admin-only and checks the role before the state |
| 5 | Stolen executor key | trading until paused | `Config::execution_allowed` requires `!paused`, the expected `version` and the executor signature; the pause authority or admin can stop it in one instruction; the executor holds only the fees it needs |
| 6 | Version confusion after a schema change | an old build reads a new layout | `version` is written at init, `execution_allowed` refuses any other value, and the reserve field must stay last so a v2 layout reinterprets the tail in place |
| 7 | Account substitution (look-alike config, fake pool) | wrong authority read, or a trade against an attacker pool | `seeds` + stored bump on every `Config` reference; fixed program ids; mint/vault/authority checks in the venue adapter (planned) |
| 8 | Client supplies the borrow amount or the profit | the program "earns" nothing while debt is unpaid | principal confirmed from the pre/post balance delta, profit measured as `post − pre − owed`, `min_profit` compared against the measurement (planned) |
| 9 | Fee-on-transfer, permanent delegate, transfer hook or freeze authority on a traded mint | repayment arithmetic breaks, funds frozen | such mints are refused unless explicitly allowlisted; the check runs before the swap (planned) |
| 10 | Borrow/repay called through CPI | lender rejects the transaction | the loan is top-level and brackets our instruction: `[borrow, flash_arb, repay]`; `flash_arb` never assumes it can call the lender |
| 11 | Stale quote or expired route | trade at a bad price | a `deadline` argument plus on-chain slippage bounds; a stale quote is refused before any CPI (planned) |
| 12 | Compute exhaustion / account-count overflow | transaction fails or a route is silently truncated | the aggregator path is capped by `maxAccounts`/`maxBytes`; the direct venue path has a fixed account set (planned) |
| 13 | Reentrancy through a CPI callee | state written twice | no instruction writes `Config` from inside a CPI path; execution instructions do not mutate configuration (planned) |
| 14 | Program upgrade authority compromised | arbitrary code at the program address | multisig or offline custody of the upgrade key; devnet-only until the audit; upgrade authority transfer is a runbook step, not an instruction |
| 15 | Event/accounting drift | an indexer reports profit that was not realized | events never carry client-supplied numbers; profit events carry measured deltas (planned) |

## Out of scope

- The BNB Chain contract (`FlashBoltArbitrage.sol`) and the app's Convex backend.
- Wallet and vault handling in the client (AES-256-GCM import vault, extensions).
- The lender's and DEX's own programs: this document assumes they are correct and
  only covers what FlashBolt validates before calling them.
- Off-chain MEV, RPC censorship and Jito bundle behaviour.

## Known accepted risks (this build)

- **The executor is a hot key.** Accepted for devnet. Before mainnet it must be
  a dedicated key with a minimal balance, rotated on a schedule documented in
  the runbook.
- **A nomination can be stranded.** `pending_admin` stays set if the nominee
  loses its key; it grants no powers, needs that key's signature, and is
  overwritten by a new proposal.
- **`pause` and `unpause` do not check `version`.** Deliberate: an emergency
  stop must work on a schema this build does not recognise, and
  `execution_allowed` already refuses unknown versions.
- **The reserve is unvalidated on read.** Version `1` writes zeros and never
  reads the field.

## Audit focus

An auditor should start with the execution milestone, not this build:

1. Balance-delta accounting: can `flash_arb` be made to report profit while the
   repayment obligation is unmet?
2. Venue adapter account validation: can a crafted pool or mint set make the
   program CPI into an unintended program or account?
3. Aggregator path: does every account of a `/build` response get checked, and
   is slippage enforced on chain rather than accepted from the quote?
4. Token-extension handling on both mints.
5. Upgrade authority and deployment procedure.
6. The two-step admin handshake and the distinctness invariants across every
   instruction sequence.

## Reporting

Report a vulnerability privately to the project owner before any public
disclosure. Do not open a public issue with a working exploit, and do not test
against mainnet: there is no mainnet deployment, and devnet testing must use
keys you control.

## Deployment gates

- Devnet only, with a funded deployer and explicit go-ahead.
- No mainnet entry in `Anchor.toml` and no mainnet deploy until an independent
  audit is complete and the owner approves in writing.
- No unverified program ids or pool addresses in code; a program id is a
  constant with a recorded source and verification date.
- No unrestricted wallet or withdrawal authority anywhere in the program.
