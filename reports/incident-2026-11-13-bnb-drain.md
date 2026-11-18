# Incident Report — Unauthorized BNB Transfer (2026-11-13)

| | |
|---|---|
| **Incident ID** | INC-2026-11-13-BSC-01 |
| **Severity** | High — confirmed unauthorized value transfer + 4 live unlimited token approvals |
| **Chain** | BNB Smart Chain (chain id 56) |
| **Status** | Loss unrecovered; **containment not confirmed** (COAI still at risk) |
| **Reported** | 2026-11-15 |
| **Scope** | 1 confirmed affected wallet; 5 wallet classes in the app assessed |

---

## 1. Executive summary

- **0.02997376 BNB (~$18.79)** left `0x944c4c7b…11fa37` without authorization at
  **2026-11-13 15:23:01 UTC** and was forwarded twice, ending in a commingling
  wallet holding **131.56 BNB**.
- The transfer was a **plain 21,000-gas native transfer** to an externally-owned
  wallet: no contract call, no DEX, no flash loan, no token movement.
- The app is **not** the mover of the whole balance: it holds **no server-side
  keys**, its auto-payout path sends only a computed profit slice
  (`buyAmount × pnl% × 0.95` ≈ 0.00095 BNB on defaults), and the **shipped
  overlay/extension bundles stamp `const STAMPED = {}`** — no payout address or
  auto-payout setting is baked into any distributed artifact.
- The wallet carries **6 approvals, 4 still live, 2 of them UNLIMITED on COAI**,
  but the COAI token **cannot be moved by anyone** (see §5 and §11): every
  outbound `transfer` and every spender `transferFrom` reverts, and its only pair
  holds **0 WBNB**. The 7,975.69 COAI is locked and effectively worthless — it is
  not the exposure it first appeared to be.
- This is a **recurring pattern**, not a single event: three near-identical
  sweeps (~0.0087–0.0089 BNB) in Oct 2025 went to three rotating fresh wallets.

---

## 2. Timeline (UTC)

| Time | Event |
|---|---|
| 2025-05-27 14:34 | Wallet first active (block 50,408,600); nonce 0 → `0x9b9efa5e…` |
| 2025-05-30 → 2025-10-01 | 4 approve txs + dApp interactions (`0xbf23342b`, `0x9330e42c`, `0x91975b5f`) |
| 2025-10-26 10:21 | 0.0089 BNB → `0x6c96cb2c…` (now dust) |
| 2025-10-27 05:44 | 0.0087 BNB → `0xdb2f34ec…` (now dust) |
| 2025-10-27 05:50 | 0.0087 BNB → `0x2c3d1b2c…` (**still holds 0.0087 BNB**) |
| **2026-11-13 15:23:01** | **0.02997376 BNB → `0xfa6f1b1d…` (the incident)** |
| 2026-11-13 16:05:44 | `0xfa6f1b1d…` forwards 0.02997166 BNB → `0x9d7d8b56…` (+71 min) |
| 2026-11-15 | 17/17 tx history and 6 approvals reconstructed; funds unrecovered |

---

## 3. Primary loss

| Field | Value |
|---|---|
| Tx | `0xeca28bda8cb6891c1684c963933997680724b93565df8035cea62ae2314c0f91` |
| Block | 133,375,045 |
| From | `0x944c4c7b16c38e17f32291fbcb354de27111fa37` (nonce 16) |
| To | `0xfa6f1b1d280dd0919aa918f7d095d62b27338bc4` |
| Value | 0.02997376 BNB (~$18.79 @ $626.78) |
| Gas | 21,000 · status SUCCESS · 0 logs · 0-byte input |
| Residual | **0.00276923 BNB left** in source; **no tx after nonce 16** (nonce 17 = count) |

## 4. Onward fund flow

| Hop | Block / time | Amount | Destination | Type |
|---|---|---|---|---|
| 1 | 133,375,045 · 11-13 15:23:01 | 0.02997376 BNB | `0xfa6f1b1d…38bc4` | EOA |
| 2 | 133,380,739 · 11-13 16:05:44 | 0.02997166 BNB | `0x9d7d8b56…175d72` | EOA |
| — | trail ends | — | `0x9d7d8b56…` — 1,545 txs, **131.56 BNB**, commingled | unknown |

Hop-2 tx: `0x2415407fd285447feed75777a7ef9dd0d62c717e1f1d238434817599d2c1bc38`.
**Not traceable past this point** with public RPC: funds are pooled with a high-volume
wallet and the onward movement is internal. Needs an explorer/trace provider
(BscScan returns HTTP 403 to automated reads; Etherscan v2 requires a paid plan for BSC).

---

## 5. Approval inventory — the actionable risk

Complete: all 17 of the wallet's transactions were enumerated (binary search over
nonce history, 721 days). An approval can only be created by the owner, so this
list is exhaustive.

| # | Token | Spender | Current allowance | Token held by wallet | Live? |
|---|---|---|---|---|---|
| 1 | **COAI** `0x91975b5f…5634` | `0x1de460f3…f4bc` | **UNLIMITED** | **7,975.69 COAI** | **YES** |
| 2 | **COAI** `0x91975b5f…5634` | `0x013bb8a2…9060` | **UNLIMITED** | **7,975.69 COAI** | **YES** |
| 3 | **COAI** `0x91975b5f…5634` | `0x2c34a2fb…cdd6` | 7,975.69 (= full balance) | 7,975.69 COAI | **YES** |
| 4 | **PSC** `0xbf23342b…0360` | `0x1de460f3…f4bc` | **UNLIMITED** | 0 | YES (inert) |
| 5 | PSC `0xbf23342b…0360` | `0x2c34a2fb…cdd6` | 1,193.055 | 0 | YES (inert) |
| 6 | JERRY `0x9330e42c…80e8` | `0x013bb8a2…9060` | ≈1.158×10⁶⁹ JERRY (effectively unlimited — see note ⁶) | 0.00000003 JERRY (raw 3) | **YES — and executable**: the spender's `transferFrom` simulates successfully; only 3 raw units are at stake |

⁶ **JERRY (8 decimals) corrected figure:** allowance raw
`115792089237316195423570985008687907853269984665640564039457492823361195158896`, which is
**1,157,920,892,373,161,954,235,709,850,086,879,078,532,699,846,656,405,640,394,574,928,233,611.95158896 JERRY** —
exactly `2²⁵⁶−1` minus `91,184,551,934,481,039`, i.e. 99.9999999999999999% of the uint256
maximum, not the approximate "2^255-scale" stated earlier. The wallet's JERRY balance is
raw `3` = 0.00000003 JERRY, so the allowance is inert regardless.

All three spenders are **small custom contracts (1,129 / 2,133 / 2,227 bytes)** — not
PancakeSwap, 1inch, 0x or Permit2. Independently confirmed: **zero** allowance to
PancakeSwap V2/V3 routers, 1inch v5/v6, Permit2 and 0x Settler, and **zero** balance
in USDT, USDC, BUSD, WBNB, CAKE, BTCB, ETH, FDUSD.

**Assessment (superseded by §11):** rows 1–3 look like an open door, but the token
contract refuses every value-moving call from this wallet. The allowances exist on
paper and grant nothing. Verified by read-only `eth_call` simulation:

| Attempted call | Result |
|---|---|
| `transfer` → PancakeSwap pair | reverts `Unauthorized trader` |
| `transfer` → fresh EOA / burn / zero / token itself | reverts `Invalid transfer direction` |
| `transferFrom` by `0x1de460f3…` → itself | reverts `Invalid transfer direction` |
| `transferFrom` by `0x1de460f3…` → pair (sell) | reverts `Unauthorized trader` |

So the COAI is **not lootable and not movable** — a locked token, not a live risk.

This token-by-token check matters: **JERRY behaves the opposite way.** Its allowance is
**executable** (`transferFrom` by `0x013bb8a2…` simulates successfully), so that approval
is real — it simply protects only `3` raw units (0.00000003 JERRY). The lesson is that an
allowance's danger comes from two independent facts, *is it executable* and *what is
behind it*; neither can be read off the allowance number alone.

---

## 6. Wallet classes in the application — audit status

The backend stores **no wallet addresses**: `tradeDepositAddresses`,
`tradeCashAccounts`, `tradeBalances` and `tradeKoraDeposits` are **empty on both
deployments** (dev `pastel-pelican-634`, prod `flexible-frog-776`), and
`terminalConfig` holds only a document id. Confirmed in code: **zero references to
private keys anywhere in `src/convex`** — the server cannot sign or move funds.
Consequence: every wallet below is only enumerable **from the browser**.

| Wallet class | Where the key/approval lives | Server knows address? | Audit status |
|---|---|---|---|
| **Vault hot wallet** | `localStorage["fb.evmVault.v1"]`, AES-256-GCM encrypted; decrypted key only in page memory | No | **Not auditable remotely** — enumerate from the app's signer list, then run §7 per address |
| **Sniper/Scanner hot wallet** | Generated in-page (mnemonic + private key shown in UI), React state only; lost on reload unless re-imported | No | **Not auditable remotely** — same procedure |
| **External connected wallet** (MetaMask/OKX/etc.) | In the extension; app only reads `eth_accounts` | No | **Audit on-chain** — approvals persist on the address; run §7 |
| **Overlay / browser-extension wallet** | Injected provider; settings in extension storage (`settings_v2`, `payoutAddress`, `autoPayout`) | No | Check `payoutAddress` + `autoPayout` in the panel; the artifacts ship `STAMPED = {}` so both default to `""`/`true` |
| **Deposit addresses** (`tradeDepositAddresses`) | App-side, bound by signature | Yes (by design) | **Empty on both deployments** — nothing to audit |

### Why the app's own payout path does not explain this loss

- `src/lib/overlay-script.ts:987` pays only when `autoPayout && payoutAddress && pnl > 0`,
  amount `buyAmountNative × pnl/100 × 0.95` (0.00095 BNB on the 0.01 BNB / 10% defaults).
- `Sniper.tsx:538` does the same behind a manual "Hot-wallet payout" toggle.
- The incident moved **0.0299 BNB** — 31× that computed slice — and left dust behind,
  which matches a drainer/max-send, not the profit payout.
- Both are **native-only** (`data: "0x"`, 21,000 gas) — consistent in shape with the
  incident, but not in amount or in the "sweep everything" behaviour.

**Conclusion:** the most probable vector is **compromise of the key or a malicious
approval granted by the wallet** (the three unknown spender contracts), not the
application's payout logic. Not proven: whether the two COAI spenders are malicious
or an abandoned bot's contracts — they are unverified, unlike every canonical router.

---

## 7. Procedure — audit any other connected wallet

Run for **each** address enumerated from the wallets in §6. Read-only; nothing signs.

```bash
RPC=https://bsc-dataseed.binance.org        # archive reads: https://bsc-mainnet.public.blastapi.io
A=0xYOUR_WALLET

# 1) current state
curl -s $RPC -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$A\",\"latest\"]}"
curl -s $RPC -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$A\",\"latest\"]}"

# 2) full tx history: binary-search the nonce over [birth, head], fetch each hit block,
#    decode selectors — 0x095ea7b3 approve, 0xa22cb465 setApprovalForAll,
#    0x23b872dd transferFrom (someone already spending), 0x7ff36ab5/0x38ed1739 swap

# 3) for every approve found, read the live allowance
#    eth_call allowance(owner,spender) = 0xdd62ed3e + pad(owner) + pad(spender)
#    eth_call allowanceForAll              = 0xe985e9c5 + pad(owner) + pad(operator)
```

**Known limits:** `eth_getLogs` is capped at 25–50 blocks on most free BSC nodes
(one allows 5,000), free archive state exists only on blastapi, and no free keyless
indexer for BSC was reachable (`api.bscscan.com` 403, Etherscan v2 paywalled,
HyperSync now requires a token, `bsc.blockscout.com` 404). Native transfers emit no
logs at all, so their tracing must go through nonce/state reads, as above.

---

## 8. Containment and remediation

**Do immediately — in this order**
1. **Move what can actually move: the BNB.** The COAI cannot be moved by any call
   (§11), so there is nothing to rescue there. Send the residual 0.00276923 BNB from
   `0x944c4c7b…` to a fresh wallet whose key was never typed into a browser session,
   the app's vault, or a hot-wallet field. If the key is compromised, a revoke is
   pointless — the attacker re-approves in one transaction.
2. **Revoke all six approvals** on the old wallet (`approve(spender, 0)`):
   `0x1de460f3…f4bc`, `0x013bb8a2…9060`, `0x2c34a2fb…cdd6`. Use revoke.cash (BSC) or
   BscScan's approval tool. Do not reconnect the wallet to the dApp that created them.
3. **Enumerate and audit every other wallet** in §6 with §7. Any address with a live
   allowance to those three contracts is exposed even if it never sent funds.
4. **Rotate the vault.** Discard `localStorage["fb.evmVault.v1"]` and re-import only
   keys you intend to keep, into a clean browser profile. Do not reuse the old seed.
5. **Stop the overlay.** Set `autoPayout` off and clear `payoutAddress` in the panel,
   and disable/removed the extension build you installed; re-install only from the
   prod-stamped artifacts (`https://flexible-frog-776.convex.site`).

**Never:** use a "recovery/refund" service that asks for a seed phrase or private key.
For a confirmed transfer to an EOA there is no such service — they are scams.

**Recovery outlook:** the BNB is unrecoverable unless `0x9d7d8b56…` is an exchange
hot wallet, in which case support may act on the two hashes in §3–§4. A police
report quoting those hashes is the only other formal route; practical odds for $19
are low. The COAI is still recoverable **by moving it now**.

---

## 9. Indicators of compromise

```
Source wallet       0x944c4c7b16c38e17f32291fbcb354de27111fa37
Collector hop 1     0xfa6f1b1d280dd0919aa918f7d095d62b27338bc4
Collector hop 2     0x9d7d8b567ee10bcb4f9db438245e1d0668175d72   (1,545 txs, 131.56 BNB)
Prior sweepers      0x6c96cb2cc149869f1872face32561dcad7a55f2b
                    0xdb2f34eccf66913e00ec37643ca0a9be5308d18a
                    0x2c3d1b2c082406fb5475730e4b5df6b3fa236b12   (still holds 0.0087 BNB)
Malicious spenders  0x1de460f363af910f51726def188f9004276bf4bc   (2,227 bytes)
                    0x013bb8a204499523ddf717e0abaa14e6dc849060   (1,129 bytes)
                    0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6   (2,133 bytes)
Tx (incident)       0xeca28bda8cb6891c1684c963933997680724b93565df8035cea62ae2314c0f91
Tx (forward)        0x2415407fd285447feed75777a7ef9dd0d62c717e1f1d238434817599d2c1bc38
```

---

## 10. Unresolved / limitations

1. Whether `0x9d7d8b56…` is an exchange hot wallet (affects the only recovery route).
2. Where funds went after the commingler — requires trace/indexer access unavailable here.
3. Whether the three spender contracts are malicious or an abandoned bot's.
4. Identity and count of the user's other wallets (vault / sniper / external / overlay) —
   not recorded server-side by design; must be enumerated from the browser and audited via §7.
5. Nothing in this report was signed or broadcast; all figures come from receipts and
   signed state reads, so they are exact.

---

## 11. Correction — the COAI is locked, not lootable (2026-11-15)

An earlier version of this report (and the verbal briefing) said 7,975.69 COAI could
be taken by two contracts, and recommended moving it first. **That was wrong.**
A read-only pre-flight of the token contract shows no transfer of this token can
succeed from the affected wallet, by anyone:

- `transfer` to the PancakeSwap V2 pair → **`Unauthorized trader`**
- `transfer` to a fresh EOA, the burn address, the zero address, WBNB, or the token
  contract itself → **`Invalid transfer direction`**
- `transferFrom` executed by the approved spenders (`0x1de460f3…`, `0x013bb8a2…`)
  to themselves → **`Invalid transfer direction`**; to the pair → **`Unauthorized trader`**

Liquidity confirms it is unsellable by anyone:

| Venue | State |
|---|---|
| PancakeSwap V2 pair `0xad07d8d3…45a5` (COAI/WBNB) | 5,490,791.974 COAI · **0 WBNB** |
| PancakeSwap V3 pools (100/500/2500/10000) | **none exist** |

**Revised assessment.** The COAI is a locked/honeypot token: its transfer rules only
permit addresses on an internal authorised list, and the only pair has no BNB, so no
holder can sell. The token's book value is **$0**. The live allowance is real but
inert — it grants the spenders nothing they can execute.

**Revised actions:**

1. Nothing to move: the COAI cannot leave the wallet, and a drain attempt cannot
   succeed. Do not spend gas trying.
2. The only disposable value in the wallet is **0.00276923 BNB (~$1.74)** — move that
   to a clean wallet if you want it, and treat the old wallet as burned.
3. Revocation is now **hygiene, not urgency**: revoking the three approvals removes a
   misleading state but recovers and protects nothing.
4. The 0.0299 BNB loss in §3–§4 is unchanged and remains the actual incident.

Method note: all checks above were `eth_call` simulations with `from` set to the
wallet or the spender — no transaction was signed or broadcast.
