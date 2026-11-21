# FlashboltSolana program — source, build and devnet deploy handoff (2026-11-19)

> **Update 2026-11-21:** the source now exists. `solana/` holds the Milestone 1
> configuration/authority program (no Counter, no trading surface) plus the
> two-step admin handshake, and its LiteSVM suite passes 20/20. The confirmed
> program address is `82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd` — the
> public key of the retained deployment keypair — and `declare_id!`,
> `Anchor.toml`, the keypair and the generated IDL all agree on it. See
> `reports/flashbolt-program-config-foundation-2026-11-21.md`. The build/deploy
> sequence below still applies; `scripts/solana-program-preflight.sh` now
> refuses READY on any address disagreement, on the Anchor template
> placeholder, and on a missing or mismatched IDL.

This is the concrete path from "no program in the repo" to "the SOL terminal's
`solcontract` rail is armed on devnet". Nothing here was executed in this
environment: there is still no Rust/Anchor source, no `.so`, no Solana
toolchain and no funded keypair here, so deploying would have nothing to
deploy. The terminal now models the two rails honestly and refuses an unarmed
one instead of pretending.

Run `bash scripts/solana-program-preflight.sh` at any point — it reports
exactly which of these steps are done and never writes to a cluster.

## 1. Produce (or obtain) the program artifact

You need **two** files. Either can only come from a real build:

| File | Meaning |
| --- | --- |
| `flashbolt_solana.so` | The compiled BPF/SBF program |
| `flashbolt_solana-keypair.json` | The program's keypair — its public key **is** the program ID |

If someone else builds it, ask them for both. If you build it, use the layout
below. Do **not** accept a bare program ID without the `.so`: deploying to an
existing ID requires the same keypair, and a different `.so` at the same ID is
a different program.

### Source layout the app expects

```
solana/                          # new top-level directory (not part of the web build)
├── Anchor.toml
├── Cargo.toml
├── programs/
│   └── flashbolt_solana/
│       ├── Cargo.toml
│       └── src/lib.rs           # the program
└── tests/                       # anchor tests, devnet
```

The V3 specification's deliverables map onto instructions this program must
expose (names are the app's contract, not decoration):

| Instruction | Purpose |
| --- | --- |
| `initialize(config)` | Set the authority, fee bps, min-profit bps and allowed venues |
| `flash_arb(params)` | Borrow → buy → sell → repay in **one** instruction |
| `set_authority` | Rotate the operator authority (guarded) |
| `set_min_profit_bps` | Change the on-chain profit floor |
| `withdraw_fees` | Move accrued fees to the authority |

The program must enforce, on chain: repayment of the borrowed amount plus the
provider fee inside the same transaction, a minimum net profit (`profit >=
amount * min_profit_bps / 10_000`), the authority signer, and an allowlist of
venue program IDs. Those are the invariants the TypeScript engine cannot
enforce by itself.

## 2. Install the toolchain (Linux/macOS)

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Solana CLI (stable) — provides cargo-build-sbf and the solana client
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install latest && avm use latest

solana --version && anchor --version && cargo-build-sbf --version
```

`cargo-build-sbf` needs the platform-tools download at first build (a few
hundred MB). If the machine cannot reach the Solana release hosts, the build
cannot complete — that is a hard blocker, not something to work around.

## 3. Build

```bash
cd solana
anchor build
# → target/deploy/flashbolt_solana.so
# → target/deploy/flashbolt_solana-keypair.json
ls -l target/deploy/
```

If you already have a `.so` and keypair from elsewhere, place them in
`solana/target/deploy/` with those exact names and skip to step 4.

## 4. Deploy to devnet (the only cluster to arm first)

```bash
solana config set --url https://api.devnet.solana.com
solana-keygen new --outfile ~/.config/solana/devnet-deployer.json   # if none
solana airdrop 5 --url devnet                                       # devnet SOL only
solana balance

# Program rent is ~2–4 SOL for a program this size; airdrop more if short.
solana program deploy \
  --program-id solana/target/deploy/flashbolt_solana-keypair.json \
  solana/target/deploy/flashbolt_solana.so

solana address -k solana/target/deploy/flashbolt_solana-keypair.json   # program ID
solana program show <PROGRAM_ID>                                       # authority + data size
```

Verify before touching the app:

```bash
solana program show <PROGRAM_ID> --url devnet     # Owner = BPFLoaderUpgradeab1e...
solana account <PROGRAM_ID> --url devnet          # executable: true
```

That last check is the real proof of deployment; a successful `deploy` receipt
alone can be stale.

## 5. Arm the solcontract rail in the app (no code change needed)

1. **SOL Strategy → Cluster pin**: select Testnet (devnet), press **Use
   current** so the pin is the devnet genesis hash the app just read.
2. **SOL Strategy → Execution rail**: choose **Vault · solcontract**, paste the
   program ID, turn **Authorize contract rail for the vault** on. On devnet the
   audit switch is not required; on mainnet it is, and mainnet stays blocked
   without it.
3. Save. The Strategy card and **SOL Contract** page now report the rail as
   ARMED; the Scanner passes the gate before any wallet prompt and records a
   `rail:solcontract` refusal if the config is later incomplete.
4. The cluster pin is enforced at execution: `getGenesisHash` must equal the
   pin or `executeLiveArb` returns `cluster-pin` and nothing is signed.

## 6. What is still missing in the engine (the honest gap)

The rail config, the gate, the cluster pin and the authorization flags are
wired, but the app does **not** yet have an instruction builder for
`flash_arb`. Arming the rail today therefore does not produce a contract call —
the Jupiter rail remains the executable path. The next implementation step is a
`src/lib/solana-contract.ts` that:

- derives the program's PDAs (config, vault authority, position),
- builds `flash_arb` with the venue account metas from the quote,
- passes the min-profit bps from the Strategy floor,
- signs with the vault wallet (already allowlisted) and submits through Jito.

That module can only be written against a real program IDL. Once `anchor build`
exists, `target/idl/flashbolt_solana.json` supplies the exact accounts and
discriminators — guessing them would be mocking.

## 7. Mainnet gate (unchanged)

Mainnet requires all of: a completed independent audit, the audit sign-off
switch on, explicit operator approval, and a funded deploy authority. The app
keeps `solAuditApproved` off by default and the rail refuses mainnet contract
execution until it is on. No mainnet program deploy will be run from here
without that approval.

## Suggested order of work

1. Land the program source (or the `.so` + keypair) in `solana/`.
2. `bash scripts/solana-program-preflight.sh` until it reports READY.
3. Devnet deploy, then arm the rail as in step 5.
4. Add the IDL-driven instruction builder and a devnet integration test.
5. Commission the audit; only then toggle the audit sign-off and consider
   mainnet — with explicit approval, never automatically.
