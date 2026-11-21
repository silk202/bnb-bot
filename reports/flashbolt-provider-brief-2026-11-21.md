# FlashBolt Solana execution milestone — provider decision (2026-11-21)

Status: **approved direction.** This document records the decision that governs
the execution milestone (`flash_arb`), the constraint that shapes its interface,
and the gates that must be passed before any adapter code is written. It
supersedes the earlier proposal (Kamino Lend + Raydium CPMM first), which was
not signed off.

Nothing here is deployed, signed or enabled. Mainnet stays off.

## Decision

| Slot | Decision | Why |
| --- | --- | --- |
| Flash-loan provider | **Jupiter Lend** — primary, implemented first | Its documented flash-loan flow carries **no lender fee**, so repayment arithmetic is principal-only and the profit floor is not eaten by a per-reserve fee. |
| First DEX integration | **Orca Whirlpool** | Its official repository confirms deployment on both Solana mainnet and devnet, so the devnet-first cut has a real venue to trade against. |
| Second DEX integration | **Raydium** — later adapter, after the first path works | Retained as an adapter (CPMM instruction set, documented CPI shape) so FlashBolt is not single-venue. Not enabled in the first cut. |
| Alternative lender | **Kamino Lend** — deferred, not a dependency | Keep as a future adapter. Its per-reserve `fees.flashLoanFeeSf` and `borrowIxIndex` coupling make it a second integration, not the first. |
| Scope | **Devnet only** until the execution path is proven and the program is audited | No mainnet entry in `Anchor.toml`; the preflight refuses one; `Config::paused` starts false only because no execution instruction exists yet. |
| Aggregator (Jupiter Router `/build`) | **Deferred** — out of the approved initial scope | Direct-venue CPI first. The aggregator reuses the same bounds and arrives in a later phase. |

Staged implementation is part of the decision: **one lender, one venue, one
path**, proven on devnet, before the second venue is added. Enabling three
integrations at once would make a failing repayment untraceable.

## Mandatory gate: verify Jupiter Lend on devnet first

Jupiter Lend's public integration repository publishes **mainnet** program ids
and CPI references, and notes that its listed devnet deployments were last
deployed in **May 2025** and **do not match the mainnet IDLs**. That makes the
devnet deployment a verification task, not an assumption:

1. Resolve the actual devnet program id and record where it came from.
2. Dump the program on devnet and read the real instruction set, account
   layouts and fee configuration — not the mainnet IDL.
3. Confirm the reserve/market accounts and that liquidity exists for the
   minimum trade size.
4. Record the verified addresses, the verification date and the command that
   produced them in this report before writing the adapter.

No Jupiter Lend adapter code lands until that check is written down. If devnet
turns out to be unusable, the fallback is Kamino Lend, which is why it stays as
a documented alternative rather than being deleted.

## The constraint that shapes everything: the loan brackets our instruction

Checked against the protocols' own documentation and source on 2026-11-21:

| Lender | Borrow / repay | CPI allowed? | Fee | Enforcement |
| --- | --- | --- | --- | --- |
| Jupiter Lend — chosen | `flash_borrow` … `flash_payback` | **No** — documented as a top-level borrow → custom logic → payback sequence | none per its docs | atomicity: payback must return the borrowed amount in the same transaction |
| Kamino Lend — deferred | `flash_borrow_reserve_liquidity` … `flash_repay_reserve_liquidity(borrowIxIndex)` | **No** — the instructions reject CPI | per reserve (`fees.flashLoanFeeSf`), can be disabled per reserve | repay must settle principal + fee in the same transaction |
| marginfi v2 — not chosen | `lending_account_start_flashloan` … `end_flashloan` | **No** — both ends validate against stack height and the start requires a matching end at a later instruction index | none | risk-engine health check at the end instruction |
| Solend — not chosen | `FlashBorrowReserveLiquidity` / `FlashRepayReserveLiquidity` | legacy `FlashLoan` is deprecated; not a candidate without a fresh review | per reserve | same-transaction repay |

So the transaction shape is fixed regardless of lender:

```text
ix 0        Jupiter Lend: flash_borrow      (top level)
ix 1        flashbolt:     flash_arb        (our program; CPIs into the venue)
ix 2        Jupiter Lend: flash_payback     (top level; borrowed amount)
```

"Borrow → arbitrage → repayment" is atomic because the *transaction* is atomic,
not because our program wraps the lender. `flash_arb` is a **middle
instruction**, and that has consequences the design must respect:

1. It cannot see or control the payback. It must leave the borrowed principal
   untouched in the account the payback debits, and treat only the measured
   surplus as profit.
2. It must verify the borrow it is trading on rather than trusting an argument:
   read the borrowed-token balance, compare it to the expected amount, and
   refuse if the delta is smaller.
3. It cannot rely on the lender's own check for its accounting. Profit is
   `post − pre − owed`, measured from token-account balances inside the
   instruction, never from a client-supplied number.
4. Compute budget is tight: borrow + our instruction + route + payback in one
   transaction. The aggregator path additionally cannot use address lookup
   tables through CPI.
5. Zero lender fee is not zero cost: network fees, slippage and price impact
   still decide whether a route is worth taking. `min_profit` is a floor on the
   net measurement, not a gross one.

## Venue detail

### Orca Whirlpool — first integration

- `swap` with a sqrt-price limit and an amount threshold, a fixed program id,
  and an account set (whirlpool, token vaults, tick arrays, oracle, token
  programs) that can be validated by owner, mint and authority.
- The sqrt-price limit is what bounds slippage on chain: it is computed from
  the pool's current price and the configured ceiling, never taken from the
  client.
- Devnet deployment is confirmed by the project's own repository, which is why
  it is the first venue for a devnet-first milestone.
- Verify the pool addresses, mints, token programs and tick arrays used in
  tests, and record them.

### Raydium — second adapter, same bounds

- `SwapBaseInput` / `SwapBaseOutput` with an explicit `max_amount_in` /
  `amount_out` and a fixed program id.
- Added only after the Orca path is proven end to end on devnet. It shares the
  venue trait, the account-validation rules and the profit accounting, so the
  second adapter is a new account set, not a new execution model.

### Kamino Lend — deferred

- `flash_borrow_reserve_liquidity` / `flash_repay_reserve_liquidity` with an
  explicit `borrowIxIndex`. Inserting an instruction **before** the borrow
  breaks the repay; our program sits at index 1, so the check holds — but that
  coupling is one more thing to get wrong, and its per-reserve fee makes the
  profit arithmetic heavier.
- Worth adding later precisely because it is a different lender with a
  different fee model.

### Jupiter Router `/build` — deferred aggregator

- Returns raw Metis-routed instructions for custom flows and supports CPI;
  CPI cannot use address lookup tables, so `/build` must be called with
  `maxAccounts`/`maxBytes` to stay inside the limit.
- The route is an **off-chain quote**. Every account is checked against
  allowlisted program ids and the route's first/last mint, and slippage is
  enforced on chain.
- Out of the approved initial scope: direct-venue CPI first.

## What the program needs from the choice

The `flash_arb` interface sketch, unchanged by the lender swap:

```rust
pub fn flash_arb(
    ctx: Context<FlashArb>,
    borrow_amount: u64,   // must match the observed balance delta
    min_profit: u64,      // floor measured in the profit mint
    deadline: i64,        // slot or unix timestamp; refuse a stale quote
) -> Result<()>
```

Accounts: the `Config` PDA (executor + pause + version gate), the borrowed-token
account and its mint, the profit mint and destination, the venue program (a
constant), the whirlpool and its vaults, both token programs, and the
instructions sysvar only if a check requires it.

Gates every choice must pass before code:

1. **Jupiter Lend devnet verified** (above), with the addresses and the command
   recorded.
2. **Program ids are constants** in the program, not arguments, and every CPI
   account is checked against the expected owner and signer.
3. **Venue addresses verified on devnet**: pool, mints, token programs, vaults,
   authorities and tick arrays, with enough liquidity for the minimum trade.
4. **Repayment arithmetic is read on chain**, not passed in, and the
   instruction leaves the borrowed principal in the account the payback debits.
5. **Profit is measured**, not claimed: balances before and after, minus the
   observed borrow, must clear `min_profit`.
6. **Token safety**: mints with a transfer fee, permanent delegate, transfer
   hook or freeze authority are refused unless explicitly allowlisted, because
   fee-on-transfer breaks repayment arithmetic.
7. **One path at a time**: Jupiter Lend + Orca lands and is tested on devnet
   before Raydium is added; the aggregator reuses the same bounds.

## Development sequence (approved)

1. Verify the Jupiter Lend devnet deployment and its CPI/instruction
   compatibility; record the addresses.
2. Verify the Orca Whirlpool devnet deployment and the pools to be used.
3. Implement the configuration registry and authority controls. *(done —
   Milestone 1)*
4. Implement the Jupiter Lend flash-loan adapter.
5. Implement the Orca Whirlpool swap adapter.
6. Implement atomic execution and the repayment validation.
7. Implement minimum-net-profit enforcement.
8. Add Raydium as a second DEX adapter.
9. Build LiteSVM and local-validator tests for each step.
10. Security review before any mainnet deployment.

## Deployment restrictions

- Devnet and local testing first. Mainnet execution is disabled by default.
- No automatic fallback from devnet to mainnet.
- No unverified program ids or pool addresses.
- No unrestricted wallet or withdrawal authority.

## Non-negotiables (unchanged)

- Nothing the instruction receives — repaid amount, route, pool list, minimum
  out — is trusted from the client; it is re-derived or bounded on chain.
- Profit comes from measured balance changes, never from a claimed number.
- `invoke_signed` is used for nothing but our own PDA; the executor is the only
  signer that authorizes a trade, and `Config::execution_allowed` is checked
  first.
- Devnet only until the path is proven; mainnet needs the audit and explicit
  approval.

## What this decision does not cover

- Mainnet timing, audit scope and the auditor.
- Whether the executor keeps the profit or forwards it, and to which account.
- The exact devnet market/pool addresses — a verification step, recorded when
  it is done.
- Any third lender or venue beyond Raydium.
- When the aggregator phase starts.

## Sources

- Jupiter Lend flash loans (no fee, top-level borrow → logic → payback):
  <https://developers.jup.ag/docs/lend/flashloan/execute>
- Jupiter Lend integration repository (mainnet program ids; devnet deployments
  from May 2025 that do not match the mainnet IDLs):
  <https://github.com/jup-ag/jupiter-lend>
- Orca Whirlpool (mainnet and devnet deployment):
  <https://github.com/orca-so/whirlpools>,
  <https://docs.orca.so/>
- Raydium CPMM instructions (`SwapBaseInput` / `SwapBaseOutput`):
  <https://docs.raydium.io/products/cpmm/instructions>
- Kamino Lend flash loans (`borrowIxIndex`, per-reserve fee):
  <https://docs.kamino.com/build/tutorials/borrow/flash-loans>
- marginfi flash loans (top-level pair, `endIndex`, no CPI):
  <https://docs.marginfi.com/typescript-sdk/flash-loans>
- Jupiter Router `/build` (raw Metis instructions, CPI, no ALTs in CPI):
  <https://developers.jup.ag/docs/swap/build>
