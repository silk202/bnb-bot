// FlashBolt Trade — auto-detection backend with cryptographic security.
//
// Flows:
//   1. DERIVED (watch-only): operator stores an account XPUB per network
//      family (BTC/LTC). Users get unique child addresses (m/0/k). The
//      server holds NO spend keys — a compromise can watch but never move
//      funds. Watchers scan public APIs and credit per (txHash, vout).
//   2. PERSONAL (binding): user signs a server challenge with their own
//      wallet (EVM EIP-191 recovery / Solana ed25519). The signature is
//      verified BEFORE storage — nobody binds an address they don't
//      control. Watchers then detect deposits to that address.
//   3. TXID VERIFY (TRON/XMR + universal fallback): the user submits the
//      tx hash; the server independently queries the public chain API and
//      only credits when the tx really paid the bound/published address.
//
// NOTE: the watch pass is an internal ACTION (it performs network fetches
// — mutations are deterministic and cannot). All DB access goes through
// runQuery/runMutation into the internal helpers below.

import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseAbi } from "viem";
import { getCurrentUser } from "./users";
import { requireOperator } from "./operatorEmails";
import {
  TRADE_NETWORKS,
  tradeDetailKey,
} from "./tradeAssets";
import {
  bindingChallenge,
  deriveUtxoAddress,
  verifyBindingSignature,
  validateAddressForNet,
  evmClientFor,
  EVM_TOKENS,
  base58Decode,
} from "./tradeCustody";

const CONFIRMATIONS_REQUIRED = 3;
const XPUB_MAX_PER_NET = 5000; // derivation index watermark

async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Sign in to use the Trade terminal.");
  return user._id;
}

function netFor(asset: string, netId: string) {
  const nets = TRADE_NETWORKS[asset] ?? [];
  const net = nets.find((n) => n.id === netId);
  if (!net) throw new Error(`Network ${netId} is not valid for ${asset}.`);
  return net;
}

// ── Operator: watch-only xpub per UTXO network ────────────────────────────

/** Operator stores a WATCH-ONLY account xpub for BTC/LTC derivation. */
export const setWatchOnlyXpub = mutation({
  args: { asset: v.string(), xpub: v.string() },
  handler: async (ctx, { asset, xpub }) => {
    await requireOperator(ctx);
    if (asset !== "BTC" && asset !== "LTC") {
      throw new Error("Watch-only derivation supports BTC and LTC.");
    }
    const key = xpub.trim();
    if (!/^(xpub|zpub|ypub|Ltub)[1-9A-HJ-NP-Za-km-z]{50,}$/.test(key)) {
      throw new Error("That doesn't look like a valid extended public key.");
    }
    const cfg = await ctx.db.query("operatorConfig").first();
    if (!cfg) throw new Error("Operator config not initialized yet.");
    await ctx.db.patch(cfg._id, {
      tradeDepositDetails: {
        ...(cfg.tradeDepositDetails ?? {}),
        [tradeDetailKey(asset, "XPUB")]: key,
      },
    });
    return { ok: true };
  },
});

async function xpubFor(
  ctx: MutationCtx | QueryCtx,
  asset: string,
): Promise<string | null> {
  const cfg = await ctx.db.query("operatorConfig").first();
  return (cfg?.tradeDepositDetails ?? {})[tradeDetailKey(asset, "XPUB")] ?? null;
}

// ── User: get / create my deposit address ─────────────────────────────────

/** My active deposit binding for an asset+network (offers derivation). */
export const getMyDepositAddress = query({
  args: { asset: v.string(), netId: v.string() },
  handler: async (ctx, { asset, netId }): Promise<{ address: string | null; mode: string | null; canDerive?: boolean; net: { id: string; label: string; explorer: string | null } }> => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      return { address: null, mode: null, net: { id: netId, label: netId, explorer: null } };
    }
    const net = netFor(asset, netId);
    const existing = await ctx.db
      .query("tradeDepositAddresses")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const mine = existing.find(
      (r) => r.active && r.asset === asset && r.netId === netId,
    );
    if (mine) {
      return {
        address: mine.address,
        mode: mine.mode,
        net: { id: net.id, label: net.label, explorer: net.explorer ?? null },
      };
    }
    // For UTXO networks with a watch-only xpub, surface the derivation offer.
    const xpub = asset === "BTC" || asset === "LTC" ? await xpubFor(ctx, asset) : null;
    return { address: null, mode: null, canDerive: Boolean(xpub), net: { id: net.id, label: net.label, explorer: net.explorer ?? null } };
  },
});

/** Derive a fresh watch-only address (BTC/LTC) for the caller. */
export const deriveDepositAddress = mutation({
  args: { asset: v.string() },
  handler: async (ctx, { asset }) => {
    const userId = await requireUser(ctx);
    if (asset !== "BTC" && asset !== "LTC") {
      throw new Error("Derived addresses are available for BTC and LTC.");
    }
    const xpub = await xpubFor(ctx, asset);
    if (!xpub) {
      throw new Error(`The operator has not enabled ${asset} address derivation yet.`);
    }
    // Watermark: highest index used for this asset (bounded scan).
    const all = await ctx.db.query("tradeDepositAddresses").collect();
    const maxIdx = all
      .filter((r) => r.mode === "derived" && r.asset === asset)
      .reduce((m, r) => Math.max(m, r.derivationIndex ?? -1), -1);
    if (maxIdx + 1 >= XPUB_MAX_PER_NET) {
      throw new Error("Address pool exhausted — the operator must supply a new xpub range.");
    }
    const index = maxIdx + 1;
    const address = deriveUtxoAddress(xpub, asset, index);
    await ctx.db.insert("tradeDepositAddresses", {
      userId,
      asset,
      netId: asset,
      address,
      mode: "derived",
      derivationIndex: index,
      active: true,
      ts: Date.now(),
    });
    return { address, index };
  },
});

// ── User: bind my own wallet with a signature ─────────────────────────────

/** Build the challenge the wallet must sign (also stores its nonce). */
export const prepareBinding = mutation({
  args: { asset: v.string(), netId: v.string(), address: v.string() },
  handler: async (ctx, { asset, netId, address }) => {
    const userId = await requireUser(ctx);
    const net = netFor(asset, netId);
    const addr = address.trim();
    if (!validateAddressForNet(addr, net)) {
      throw new Error("That address isn't valid for this network.");
    }
    const nonce =
      Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    await ctx.db.insert("tradeDepositAddresses", {
      userId,
      asset,
      netId,
      address: addr,
      mode: "personal",
      challengeNonce: nonce,
      active: false,
      ts: Date.now(),
    });
    return { message: bindingChallenge(addr, asset, net.id, nonce) };
  },
});

/** Verify the signature; activates the binding only when it checks out. */
export const confirmBinding = mutation({
  args: {
    asset: v.string(),
    netId: v.string(),
    address: v.string(),
    signature: v.string(),
  },
  handler: async (ctx, { asset, netId, address, signature }) => {
    const userId = await requireUser(ctx);
    const net = netFor(asset, netId);
    const addr = address.trim();
    const rows = await ctx.db
      .query("tradeDepositAddresses")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const pending = rows.find(
      (r) =>
        !r.active &&
        r.mode === "personal" &&
        r.asset === asset &&
        r.netId === netId &&
        r.address === addr &&
        r.challengeNonce !== undefined,
    );
    if (!pending || !pending.challengeNonce) {
      throw new Error("No pending binding — request the challenge first.");
    }
    const message = bindingChallenge(addr, asset, netId, pending.challengeNonce);
    const ok = await verifyBindingSignature(net.chainKind, addr, message, signature);
    if (!ok) {
      throw new Error("Signature verification failed — the wallet didn't sign this challenge.");
    }
    // Deactivate any previous active binding for the same asset+net.
    for (const r of rows) {
      if (r.active && r.asset === asset && r.netId === netId) {
        await ctx.db.patch(r._id, { active: false });
      }
    }
    await ctx.db.patch(pending._id, { active: true, signature });
    return { ok: true };
  },
});

/** My active bindings (for the UI's "your deposit addresses" list). */
export const listMyBindings = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("tradeDepositAddresses")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows.filter((r) => r.active);
  },
});

/** My detected chain deposits, newest first (auto-detection status list). */
export const listMyChainDeposits = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("tradeChainDeposits")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20)
      .map((d) => ({
        _id: d._id,
        asset: d.asset,
        netId: d.netId,
        txHash: d.txHash,
        address: d.address,
        amount: d.amount,
        confirmations: d.confirmations,
        credited: d.credited,
        ts: d.ts,
      }));
  },
});

// ── User: submit a txid (universal fallback / TRON / XMR) ─────────────────

export const submitDepositTxid = mutation({
  args: { asset: v.string(), netId: v.string(), txHash: v.string() },
  handler: async (ctx, { asset, netId, txHash }) => {
    const userId = await requireUser(ctx);
    netFor(asset, netId);
    const hash = txHash.trim();
    if (hash.length < 10) throw new Error("Enter the full transaction hash.");
    await ctx.db.insert("tradeChainDeposits", {
      userId,
      asset,
      netId,
      txHash: hash,
      logIndex: 0,
      address: "",
      amount: 0,
      confirmations: 0,
      credited: false,
      ts: Date.now(),
    });
    // The verifyTxid watcher picks it up on the next pass.
    return { queued: true };
  },
});

// ── Watchers (cron → action) ──────────────────────────────────────────────

/** Internal: all active bindings + derived addresses, batched. */
export const activeAddressesInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("tradeDepositAddresses")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      userId: r.userId,
      asset: r.asset,
      netId: r.netId,
      address: r.address,
    }));
  },
});

type ActiveAddr = {
  _id: Id<"tradeDepositAddresses">;
  userId: Id<"users">;
  asset: string;
  netId: string;
  address: string;
};

/** Record a confirmed deposit exactly once per (txHash, logIndex). */
export const recordChainDeposit = internalMutation({
  args: {
    userId: v.id("users"),
    asset: v.string(),
    netId: v.string(),
    txHash: v.string(),
    logIndex: v.number(),
    address: v.string(),
    amount: v.number(),
    confirmations: v.number(),
  },
  handler: async (ctx, args) => {
    const dupe = await ctx.db
      .query("tradeChainDeposits")
      .withIndex("by_tx", (q) =>
        q.eq("txHash", args.txHash).eq("logIndex", args.logIndex),
      )
      .first();
    if (dupe) return { recorded: false };
    await ctx.db.insert("tradeChainDeposits", { ...args, credited: false, ts: Date.now() });
    return { recorded: true };
  },
});

function TRADE_CASH(asset: string): boolean {
  return ["USD", "EUR", "GBP", "GHS", "KES", "XAF", "NGN"].includes(asset);
}

/** Credit every confirmed, un-credited chain deposit (called by cron). */
export const creditChainDeposits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("tradeChainDeposits")
      .collect();
    let credited = 0;
    for (const d of pending) {
      if (d.credited || d.confirmations < CONFIRMATIONS_REQUIRED || !(d.amount > 0)) continue;
      await creditLedger(ctx, d.userId, d.asset, d.amount, d);
      await ctx.db.patch(d._id, { credited: true });
      credited += 1;
    }
    return { credited };
  },
});

async function creditLedger(
  ctx: MutationCtx,
  userId: Id<"users">,
  asset: string,
  amount: number,
  src: { txHash: string; netId: string },
) {
  const kind = TRADE_CASH(asset) ? "cash" : "crypto";
  const row = await ctx.db
    .query("tradeBalances")
    .withIndex("by_user_asset", (q) =>
      q.eq("userId", userId).eq("kind", kind).eq("asset", asset),
    )
    .first();
  if (row) {
    await ctx.db.patch(row._id, { available: row.available + amount, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("tradeBalances", {
      userId,
      kind,
      asset,
      available: amount,
      locked: 0,
      updatedAt: Date.now(),
    });
  }
  await ctx.db.insert("tradeTx", {
    userId,
    kind,
    direction: "deposit",
    asset,
    amount,
    status: "completed",
    ts: Date.now(),
    ref:
      "FB-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      Math.random().toString(36).slice(2, 6).toUpperCase(),
    note: `Auto-detected ${src.netId} deposit — tx ${src.txHash.slice(0, 14)}…`,
    meta: JSON.stringify({ txHash: src.txHash, netId: src.netId, source: "chain-watch" }),
  });
}

/** Un-credited chain deposits awaiting threshold (internal read). */
export const uncreditedDeposits = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("tradeChainDeposits")
      .collect(),
});

// ── The watch pass (runs on cron; observes the chain, records credits) ────

export const watchPass = internalAction({
  args: {},
  handler: async (ctx): Promise<{ observed: number; credited: number }> => {
    const addrs: ActiveAddr[] = await ctx.runQuery(internal.tradeAutoDetection.activeAddressesInternal, {});
    let observed = 0;

    // EVM token deposits: indexed Transfer logs filtered server-side by
    // recipient (topics[2]) — one cheap RPC per address per token.
    const TRANSFER_EVENT = parseAbi([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ])[0];
    for (const netId of ["ERC20", "BEP20"]) {
      const client = evmClientFor(netId);
      if (!client) continue;
      const targets = addrs.filter((a) => a.netId === netId);
      if (targets.length === 0) continue;
      const latest = await client.getBlockNumber().catch(() => null);
      if (latest === null) continue;
      const fromBlock = latest > 40n ? latest - 40n : 0n; // last ~2 min window (cron 2m)
      // Native-asset deposits (BNB/ETH) are intentionally not detected via
      // balance-diff probing — rate-limit safety; token deposits dominate.
      for (const a of targets) {
        const token = EVM_TOKENS[`${a.asset}:${netId}`];
        if (!token) continue;
        const logs = await client
          .getLogs({
            address: token.address,
            event: TRANSFER_EVENT,
            args: { to: a.address.toLowerCase() as `0x${string}` },
            fromBlock,
            toBlock: "latest",
          })
          .catch(() => []);
        for (const log of logs.slice(0, 10)) {
          const raw = log.args.value ?? 0n;
          const amount = Number(raw) / 10 ** token.decimals;
          if (!(amount > 0)) continue;
          const res = await ctx.runMutation(internal.tradeAutoDetection.recordChainDeposit, {
            userId: a.userId,
            asset: a.asset,
            netId,
            txHash: String(log.transactionHash ?? ""),
            logIndex: Number(log.logIndex ?? 0),
            address: a.address,
            amount,
            confirmations: CONFIRMATIONS_REQUIRED,
          });
          if (res.recorded) observed += 1;
        }
      }
    }

    // UTXO (BTC/LTC derived addresses) via public block APIs.
    for (const asset of ["BTC", "LTC"] as const) {
      const targets = addrs.filter((a) => a.asset === asset && a.netId === asset);
      if (targets.length === 0) continue;
      const api =
        asset === "BTC"
          ? "https://blockchain.info/rawaddr/"
          : "https://api.blockcypher.com/v1/ltc/main/addrs/";
      for (const a of targets.slice(0, 25)) {
        try {
          if (asset === "BTC") {
            const res = await fetch(`${api}${a.address}?cors=true`);
            if (!res.ok) continue;
            const j = (await res.json()) as {
              txs?: Array<{
                hash?: string;
                out?: Array<{ addr?: string; value?: number; n?: number }>;
                time?: number;
              }>;
            };
            for (const tx of (j.txs ?? []).slice(0, 5)) {
              const out = (tx.out ?? []).find((o) => o.addr === a.address);
              if (!out || !out.value || !tx.hash) continue;
              const res2 = await ctx.runMutation(internal.tradeAutoDetection.recordChainDeposit, {
                userId: a.userId,
                asset,
                netId: asset,
                txHash: tx.hash,
                logIndex: out.n ?? 0,
                address: a.address,
                amount: out.value / 1e8,
                confirmations: CONFIRMATIONS_REQUIRED,
              });
              if (res2.recorded) observed += 1;
            }
          } else {
            const res = await fetch(`${api}${a.address}`);
            if (!res.ok) continue;
            const j = (await res.json()) as {
              transactions?: Array<{ hash?: string; outputs?: Array<{ addresses?: string[]; value: number }> }>;
            };
            for (const tx of (j.transactions ?? []).slice(0, 5)) {
              const out = (tx.outputs ?? []).find((o) => (o.addresses ?? []).includes(a.address));
              if (!out || !tx.hash) continue;
              const res2 = await ctx.runMutation(internal.tradeAutoDetection.recordChainDeposit, {
                userId: a.userId,
                asset,
                netId: asset,
                txHash: tx.hash,
                logIndex: 0,
                address: a.address,
                amount: out.value / 1e8,
                confirmations: CONFIRMATIONS_REQUIRED,
              });
              if (res2.recorded) observed += 1;
            }
          }
        } catch {
          // Public API hiccup — the next pass retries.
        }
      }
    }

    // Verify user-submitted txids (universal fallback, incl. TRON/XMR).
    observed += await verifyTxids(ctx, addrs);

    // Credit everything that has reached the confirmation threshold.
    const creditRes: { credited: number } = await ctx.runMutation(
      internal.tradeAutoDetection.creditChainDeposits,
      {},
    );
    return { observed, credited: creditRes.credited };
  },
});

async function verifyTxids(ctx: ActionCtx, addrs: ActiveAddr[]): Promise<number> {
  const uncredited = await ctx.runQuery(internal.tradeAutoDetection.uncreditedDeposits, {});
  let verified = 0;
  for (const d of uncredited as Array<{
    _id: Id<"tradeChainDeposits">;
    userId: Id<"users">;
    asset: string;
    netId: string;
    txHash: string;
    logIndex: number;
    address: string;
    amount: number;
    confirmations: number;
    credited: boolean;
  }>) {
    if (d.credited) continue;
    // Only rows that are user-submitted (amount 0 / no address yet).
    if (d.amount > 0 && d.address) continue;
    const binding = addrs.find((a) => a.userId === d.userId && a.asset === d.asset && a.netId === d.netId);
    const expected = binding?.address ?? null;
    const net = TRADE_NETWORKS[d.asset]?.find((n) => n.id === d.netId);
    if (!net || !expected) continue;

    let ok = false;
    let amount = 0;
    if (d.netId === "TRC20" || d.netId === "TRON") {
      try {
        const res = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${d.txHash}`);
        if (res.ok) {
          const j = (await res.json()) as {
            confirmed?: boolean;
            to_address?: string;
            contractData?: { to_address?: string; call_value?: number };
            tokenInfo?: { decimals?: number };
          };
          const to = j.contractData?.to_address ?? j.to_address ?? "";
          // Compare in the 0x41-prefixed hex domain (base58 T- and hex
          // responses normalize to the same bytes — no substring traps).
          const expectedHex = tronHexFor(expected);
          const toHex = tronHexFor(to);
          ok = Boolean(j.confirmed) && expectedHex !== null && toHex !== null && toHex === expectedHex;
          const val = j.contractData?.call_value ?? 0;
          const dec = j.tokenInfo?.decimals ?? 6;
          amount = val / 10 ** dec;
        }
      } catch { /* retry next pass */ }
    } else if (d.netId === "SOL") {
      try {
        const res = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [d.txHash, "jsonParsed"],
          }),
        });
        if (res.ok) {
          const j = (await res.json()) as {
            result?: {
              meta?: { postBalances: number[]; preBalances: number[]; preTokenBalances?: Array<{ accountIndex: number; mint?: string; uiTokenAmount?: { uiAmount: number } }>; postTokenBalances?: Array<{ accountIndex: number; mint?: string; uiTokenAmount?: { uiAmount: number } }> } | null;
              transaction?: { message?: { accountKeys?: Array<{ pubkey: string }> } } | null;
            } | null;
          };
          const r = j.result;
          if (r?.meta && r.transaction?.message?.accountKeys) {
            const idx = r.transaction.message.accountKeys.findIndex((k) => k.pubkey === expected);
            if (idx >= 0) {
              const native = (r.meta.postBalances[idx] - r.meta.preBalances[idx]) / 1e9;
              if (native > 0) {
                ok = true;
                amount = native;
              } else {
                for (const post of r.meta.postTokenBalances ?? []) {
                  if (post.accountIndex !== idx) continue;
                  const pre = (r.meta.preTokenBalances ?? []).find(
                    (b) => b.accountIndex === idx && (b.mint ?? "") === (post.mint ?? ""),
                  );
                  const postAmt = post.uiTokenAmount?.uiAmount ?? 0;
                  const preAmt = pre?.uiTokenAmount?.uiAmount ?? 0;
                  const diff = postAmt - preAmt;
                  if (diff > 0) {
                    ok = true;
                    amount = diff;
                  }
                }
              }
            }
          }
        }
      } catch { /* retry next pass */ }
    }

    if (ok && amount > 0) {
      await ctx.runMutation(internal.tradeAutoDetection.recordChainDeposit, {
        userId: d.userId,
        asset: d.asset,
        netId: d.netId,
        txHash: d.txHash,
        logIndex: 0,
        address: expected,
        amount,
        confirmations: CONFIRMATIONS_REQUIRED,
      });
      verified += 1;
    }
  }
  return verified;
}

/** TRON address → canonical 0x41-prefixed lowercase hex (base58 or hex in). */
function tronHexFor(addr: string): string | null {
  const a = addr.trim();
  if (a.startsWith("T")) {
    try {
      return ("0x" + bytesToHex(base58Decode(a))).toLowerCase();
    } catch {
      return null;
    }
  }
  return /^0x41[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}
