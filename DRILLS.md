# FlashBolt — live-path drills

The drills drive the **exact production execution paths** — real vault crypto,
real in-memory signing, real funding, real broadcast, real swap — against
**test networks only**. Nothing is mocked, seeded or papered at any point:
every green check means the stage genuinely happened on the live cluster.

## Quick start

```bash
bun run drill          # SOL FlashBolt  — Solana devnet   (scripts/devnet-drill.ts)
bun run drill:evm      # BNB FlashBolt  — BSC testnet     (scripts/evm-drill.ts)
bun run drill:all      # both back to back, one combined verdict (scripts/drill-all.ts)
bun run drill:report   # drill:all with the verbatim output pinned as the release
                       # artifact reports/drill-latest.txt (what the gate reads)
bun run check:drill    # release gate on that artifact: fresh (24h) 2/2 verdict
```

Exit `0` = every stage proved live. Exit `1` = a stage failed and the output
names exactly which stage of which subsystem and why — **never a faked green
check**. No app secrets are needed: each drill derives its own throwaway
keypair/key in memory and broadcasts only to the test network. Mainnet is
never touched.

## Stage map

| # | SOL FlashBolt (`drill`, devnet) | BNB FlashBolt (`drill:evm`, BSC testnet) |
|---|---|---|
| 1 | Vault seal → lock → unlock (real AES-256-GCM) | EVM vault seal → lock → unlock + `getVaultHotWallet` seam check |
| 2 | In-memory ed25519 signing (sub-ms) | In-memory viem secp256k1 signing, signature recovered to the vault address |
| 3 | Real devnet funding (RPC airdrop → pre-funded probe; official faucet 2 req / 8 h) | Real testnet funding (pre-funded probe → faucet POSTs), with hijack guard |
| 4 | Real `sendTransaction` → on-chain confirmation (memo self-send) | Production `transferNative` → `eth_getTransactionReceipt` |
| 5 | Live `getTokenAccountsByOwner` query shape (the sell leg's shape) | Live PancakeSwap swap through production `buyToken` with on-chain `balanceOf` proof |

Stage 5 (BNB) discovers pairs live from `PairCreated` logs on the verified
PancakeSwap V2 testnet factory, quotes through the executor's own
`getAmountsOut`, passes the dual `eth_estimateGas` simulation gate, then buys
0.001 BNB dust with the vault signer — and only passes if the signer **really
holds** the bought token afterwards. If no live pair passes simulation, the
stage fails honestly.

## Deterministic drill addresses

The drills use **deterministic, high-entropy** keys: SHA-256 derived from a
FlashBolt-specific label, so the address is identical on every re-run (faucet
grants persist) yet unguessable. This is deliberate — low-entropy constants
(all-7s, `0x…42`) are swept by seed-sniper bots that fund and wrap those
accounts. The drills verify ownership before trusting any pre-funded balance
(SOL: the account must be SYSTEM-owned; EVM: the address must hold no code).

| Subsystem | Address | Network | Key label |
|---|---|---|---|
| SOL FlashBolt | `CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K` | Solana devnet | `flashbolt-devnet-drill-v1` |
| BNB FlashBolt | `0x329513F68b697e83a769800A45fB84C568B47901` | BSC testnet (chain 97) | `flashbolt-evm-drill-v1` |

> ⚠️ **Testnet-only keys.** Never send real funds to these addresses and never
> reuse a drill key (or label) anywhere near mainnet.

## Convex migration — free-tier disable recovery

> **Resolved 2026-10-01** — the monthly free-tier reset restored serving, the
> project's default production deployment was switched to the deployment that
> actually serves the app (verified: `--prod` resolves to it, the Telegram
> webhook self-heals to it, usage limits are armed), and the
> migrate-to-a-fresh-deployment plan below is retired. Kept as a contingency
> runbook.

If Convex serving is disabled ("You have exceeded the free plan limits"),
the token, keys and code are fine — the team hit the free-tier ceiling.
Recovery, in order:

1. **Restore serving** (the actual fix, operator-only):
   dashboard.convex.dev → the deployment's team → Billing → upgrade to Pro,
   or email support@convex.dev. Nothing else unblocks the app or the
   Telegram webhook while the disable is active.
2. **Back up before touching anything** (worked even while disabled):
   `bunx convex export --path /tmp/flashbolt-export.zip` — the same snapshot
   appears under dashboard → Settings → Snapshots.
3. **Migrate to a fresh deployment** (`bunx convex deployment create
   <name> --type prod --select` needs a real `convex login`, not the
   platform deploy key): `bunx convex import` the snapshot zip, re-push
   functions with `bunx convex dev --once`, then set the env keys
   (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CONVEX_SITE_URL` etc.) on the
   new deployment, point the app's `VITE_CONVEX_URL` / `CONVEX_SITE_URL` at
   it, and re-register the webhook (`bunx convex run
   telegramBot:registerWebhook` or the app's Telegram dialog) so Telegram
   stops posting to the old deployment.
4. **Stay under the ceiling**: the engine heartbeat now runs every 5 minutes
   (recovery path only — ~80% fewer recurring calls), and disable-type
   usage limits (400K calls/mo, 25 GB DB I/O/mo) trip a known stop instead
   of a surprise disable. Raise them or upgrade before any legitimate
   growth crosses them.

## Funding — manual, one-time

The drills try every keyless path themselves first (RPC airdrop, pre-funded
probe). Faucets that only serve browsers have to be hit once by a human — then
every later re-run uses the persisted balance automatically. Suggested drips:
**0.1 tBNB** and **0.05 devnet SOL**.

**BNB FlashBolt** (0.1+ testBNB):

1. Open the official faucet: <https://testnet.bnbchain.org/en/testnet-faucet>
2. Paste `0x329513F68b697e83a769800A45fB84C568B47901`
3. Complete the CAPTCHA and claim (0.1 / 0.01 tBNB — any amount clears the drill's threshold)
4. Verify on the explorer: <https://testnet.bscscan.com/address/0x329513F68b697e83a769800A45fB84C568B47901>

Alternative: <https://www.chainstack.com/faucets/bsc-chain-testnet/> (also CAPTCHA-gated).

**SOL FlashBolt** (0.05+ devnet SOL):

1. Open the official faucet: <https://faucet.solana.com>
2. Paste `CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K`
3. Pick 0.05 SOL and confirm
4. Verify on the explorer: <https://explorer.solana.com/address/CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K?cluster=devnet>

**Limits (verified 2026-11-22):** the faucet allows **2 requests every 8
hours** while anonymous; signing in with GitHub raises the limit, and GitHub
accounts are validated. The public RPC faucet is **closed** — `requestAirdrop`
against `api.devnet.solana.com` answers HTTP 410 ("The RPC faucet is closed on
this cluster"), which is why the drill reports that refusal verbatim instead of
retrying a path that no longer exists. The CLI alternative is rate-limited too:

```bash
solana airdrop 2 CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K --url devnet
```

For unlimited SOL with no rate limit, run a local validator
(`solana-test-validator`) and airdrop against `--url localhost`.

Once either address is funded, the corresponding drill skips the faucet
attempts (pre-funded path) and proceeds through broadcast/swap.

## Release gate

`bun run verify` (step 4/4) fails the release unless
`reports/drill-latest.txt` — the verbatim output of the latest
`bun run drill:report` — shows a **fresh (≤ 24 h) 2/2 combined verdict**.
There is deliberately **no bypass flag**: the release runner holds until a
human funds the drill addresses and the drills really pass. The gate prints
the exact addresses to fund and the re-run command when it holds; a below-2/2
or stale artifact is always an honest fail, never a faked green check.

So the full release flow is:

```bash
bun run drill:report   # fresh combined run, pinned to reports/drill-latest.txt
bun run verify         # typecheck + tests + overlay artifacts + drill gate
bun run package:mirror # mirror ships the same pinned report
```

`bun run git:sync` surfaces the same hold (warn-only, with the addresses to
fund) before committing — sync ships source and is not a release, so it never
blocks on the drill gate; `bun run verify` is the only step that holds.

## Re-run after funding

```bash
bun run drill:all
```

Successful stages print real explorer links — tx hashes, receipts, held token
balances — which are the end-to-end proof. Keep the output alongside the
release notes if you need a record.

## Honest-failure contract

- A stage is marked ✓ **only** when it really happened on the real network.
- Funding refusal ⇒ exit `1` with the exact address printed for manual
  funding. A mock is never substituted for a missing broadcast.
- Hijack guards run before any pre-funded balance is trusted: SOL requires a
  SYSTEM-owned account; EVM requires zero code at the address (hunted keys get
  wrapped or replaced by contracts whose balances no drill key can spend).
- The release gate (`bun run check:drill` in `bun run verify`) has **no
  bypass flag** — below-2/2, stale or malformed reports always hold the
  release.
- Broadcasts target test networks exclusively. Mainnet is never touched by any
  drill.
