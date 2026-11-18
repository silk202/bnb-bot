// FlashBolt Trade — the exchange terminal backend.
//
// A real internal ledger on Convex: crypto + cash (NGN) balances per user,
// live market prices (CoinGecko) + USD→NGN FX (open.er-api.com), atomic
// swaps at live rates with a disclosed fee, limit orders that only fill when
// the live market price crosses the limit, earn plans that accrue interest
// by elapsed time, and internal transfers by email. Every balance movement
// is a ledger row with a unique reference; no balance ever goes negative.
// Prices come from the live network with a 60s cache; if the network is
// unreachable the last-known real prices are served stale rather than
// invented.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { requireOperator, resolveOperatorState } from "./operatorEmails";
import {
  BANK_DEPOSIT_CURRENCIES,
  TRADE_ASSETS,
  TRADE_CG_IDS,
  TRADE_FX_CODES,
  TRADE_PAIRS,
  TRADE_NETWORKS,
  parseTradeDetailKey,
  isBankDepositCurrency,
} from "./tradeAssets";

type AssetDef = (typeof TRADE_ASSETS)[string];

const PRICE_TTL_MS = 60_000;
const SWAP_FEE_PCT = 0.1; // disclosed swap fee, itemized in the ledger note
const FLEXIBLE_APY = 4.5;
const FIXED_APY = 7;
const YEAR_MS = 365 * 24 * 3_600_000;

// ── Live prices (action → CoinGecko + FX; cached in tradePriceCache) ──────

type PriceMap = Record<string, { usd: number; ngn: number; change24hPct: number; ts: number }>;

/**
 * Market snapshot: every asset in USD + NGN with 24h change. Served from
 * the cache when younger than 60s, otherwise refreshed from the live APIs.
 * On network failure the last-known cache is returned (never invented).
 */
export const getMarket = action({
  args: {},
  handler: async (ctx): Promise<{ prices: PriceMap; stale: boolean; ts: number }> => {
    const cached = await ctx.runQuery(internal.trade.readPriceCache, {});
    const now = Date.now();
    if (cached && now - cached.ts < PRICE_TTL_MS) {
      return { prices: JSON.parse(cached.data) as PriceMap, stale: false, ts: cached.ts };
    }
    const fresh = await fetchPrices();
    if (fresh) {
      await ctx.runMutation(internal.trade.savePriceCache, { data: JSON.stringify(fresh), ts: now });
      return { prices: fresh, stale: false, ts: now };
    }
    if (cached) return { prices: JSON.parse(cached.data) as PriceMap, stale: true, ts: cached.ts };
    throw new Error("Live market prices are unavailable right now — retry in a moment.");
  },
});

async function fetchPrices(): Promise<PriceMap | null> {
  try {
    const [cgRes, fxRes] = await Promise.all([
      fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${TRADE_CG_IDS}&vs_currencies=usd&include_24hr_change=true`,
        { headers: { accept: "application/json" } },
      ),
      fetch(`https://open.er-api.com/v6/latest/USD`, { headers: { accept: "application/json" } }),
    ]);
    if (!cgRes.ok || !fxRes.ok) return null;
    const cg = (await cgRes.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const fx = (await fxRes.json()) as { rates?: Record<string, number> };
    const rates = fx.rates;
    if (!rates || !(rates.NGN > 0)) return null;
    const now = Date.now();
    const out: PriceMap = {};
    // Cash currencies: NGN keeps the legacy `ngn` field as its own rate; all
    // cash entries carry usd = USD-per-unit so cross-rate math is uniform.
    for (const code of ["NGN", ...TRADE_FX_CODES]) {
      const perUsd = rates[code];
      if (!(perUsd > 0)) return null; // incomplete FX set → refuse
      out[code] = { usd: 1 / perUsd, ngn: rates.NGN / perUsd, change24hPct: 0, ts: now };
    }
    for (const def of Object.values(TRADE_ASSETS)) {
      if (def.kind !== "crypto" || !def.cgId) continue;
      const row = cg[def.cgId];
      const usd = row?.usd;
      if (typeof usd !== "number" || usd <= 0) return null; // incomplete set → refuse
      out[def.symbol] = {
        usd,
        ngn: usd * rates.NGN,
        change24hPct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : 0,
        ts: now,
      };
    }
    return out;
  } catch {
    return null;
  }
}

export const readPriceCache = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("tradePriceCache")
      .withIndex("by_key", (q) => q.eq("key", "trade.prices"))
      .first(),
});

export const savePriceCache = internalMutation({
  args: { data: v.string(), ts: v.number() },
  handler: async (ctx, { data, ts }) => {
    const row = await ctx.db
      .query("tradePriceCache")
      .withIndex("by_key", (q) => q.eq("key", "trade.prices"))
      .first();
    if (row) await ctx.db.patch(row._id, { data, ts });
    else await ctx.db.insert("tradePriceCache", { key: "trade.prices", data, ts });
  },
});

/** Live price read (query-side, no fetch) for swap/overview screens. */
export const peekMarket = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("tradePriceCache")
      .withIndex("by_key", (q) => q.eq("key", "trade.prices"))
      .first();
    if (!row) return null;
    return { prices: JSON.parse(row.data) as PriceMap, ts: row.ts };
  },
});

// ── Ledger helpers ─────────────────────────────────────────────────────────

type BalRow = Doc<"tradeBalances"> | null;

async function getBal(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
): Promise<BalRow> {
  return await ctx.db
    .query("tradeBalances")
    .withIndex("by_user_asset", (q) =>
      q.eq("userId", userId).eq("kind", kind).eq("asset", asset),
    )
    .first();
}

async function credit(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
  amount: number,
): Promise<void> {
  if (!(amount > 0)) return;
  const row = await getBal(ctx, userId, kind, asset);
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
}

/** Debit spendable funds. Throws when funds are insufficient. */
async function debit(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
  amount: number,
): Promise<void> {
  if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
  const row = await getBal(ctx, userId, kind, asset);
  if (!row || row.available < amount) {
    throw new Error(
      `Insufficient ${asset} balance — available ${fmt(row?.available ?? 0)}, need ${fmt(amount)}.`,
    );
  }
  await ctx.db.patch(row._id, { available: row.available - amount, updatedAt: Date.now() });
}

/** Move spendable funds into the locked bucket (orders / earn principal). */
async function lock(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
  amount: number,
): Promise<void> {
  const row = await getBal(ctx, userId, kind, asset);
  if (!row || row.available < amount) {
    throw new Error(`Insufficient ${asset} balance — available ${fmt(row?.available ?? 0)}.`);
  }
  await ctx.db.patch(row._id, {
    available: row.available - amount,
    locked: row.locked + amount,
    updatedAt: Date.now(),
  });
}

async function unlockLocked(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
  amount: number,
): Promise<void> {
  const row = await getBal(ctx, userId, kind, asset);
  if (!row) return;
  await ctx.db.patch(row._id, {
    locked: Math.max(0, row.locked - amount),
    available: row.available + amount,
    updatedAt: Date.now(),
  });
}

/** Consume locked funds when an order fills (locked → spent, not credited). */
async function consumeLocked(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "crypto" | "cash",
  asset: string,
  amount: number,
): Promise<void> {
  const row = await getBal(ctx, userId, kind, asset);
  if (!row) return;
  await ctx.db.patch(row._id, {
    locked: Math.max(0, row.locked - amount),
    updatedAt: Date.now(),
  });
}

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function newRef(): string {
  return (
    "FB-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  );
}

async function recordTx(
  ctx: MutationCtx,
  userId: Id<"users">,
  tx: {
    kind: "cash" | "crypto" | "internal";
    direction: "deposit" | "withdrawal" | "swap" | "interest" | "transfer_in" | "transfer_out";
    asset: string;
    amount: number;
    status: "pending" | "completed" | "failed";
    note?: string;
    meta?: string;
  },
): Promise<string> {
  const ref = newRef();
  await ctx.db.insert("tradeTx", {
    userId,
    kind: tx.kind,
    direction: tx.direction,
    asset: tx.asset,
    amount: tx.amount,
    status: tx.status,
    ts: Date.now(),
    ref,
    note: tx.note,
    meta: tx.meta,
  });
  return ref;
}

async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Sign in to use the Trade terminal.");
  return user._id;
}

function kindOf(a: AssetDef): "cash" | "crypto" {
  return a.kind === "cash" ? "cash" : "crypto";
}

// ---------------------------------------------------------------------------
// Internal bot variants — the Telegram bot reads/writes the OPERATOR's trade
// ledger without a web session. The chat link only exists after secure
// pairing inside the authenticated app, so identity is established there.
// ---------------------------------------------------------------------------

/**
 * Resolve the operator's userId for bot-side ledger access (null = the
 * operator never opened the app). Plain db helper usable from query and
 * mutation contexts alike.
 */
async function operatorUserDoc(
  ctx: { db: QueryCtx["db"] },
): Promise<{ userId: Id<"users">; email: string } | null> {
  // BUDGET (DB I/O): indexed resolution (point reads) instead of collecting
  // the whole terminalStates + users tables on EVERY bot ledger read.
  // Same contract as before: only a state-owning operator account counts,
  // and there is NO first-row fallback here (null = no bot-side access).
  const hit = await resolveOperatorState(ctx);
  return hit ? { userId: hit.userId, email: hit.email } : null;
}

export const botResolveOperatorUser = internalQuery({
  args: {},
  handler: async (ctx) => operatorUserDoc(ctx),
});

/** Bot-side trade overview (balances + recent tx + earn totals). */
export const botTradeOverview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const op = await operatorUserDoc(ctx);
    if (!op) return null;
    const userId = op.userId;
    const balances = await ctx.db
      .query("tradeBalances")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const recentTx = await ctx.db
      .query("tradeTx")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .take(12);
    const plans = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const interestEarned = recentTx
      .filter((t) => t.direction === "interest" && t.status === "completed")
      .reduce((s, t) => s + t.amount, 0);
    return {
      email: op.email,
      balances: balances.map((b) => ({ kind: b.kind, asset: b.asset, available: b.available, locked: b.locked })),
      recentTx: recentTx.map((t) => ({
        direction: t.direction, asset: t.asset, amount: t.amount,
        status: t.status, ref: t.ref, ts: t.ts,
      })),
      earn: {
        activePlans: plans.filter((p) => p.status === "active").length,
        activeAccrued: plans.filter((p) => p.status === "active").reduce((s, p) => s + p.accrued, 0),
        interestEarned,
      },
    };
  },
});

/** Bot-side open + recent orders. */
export const botListOrders = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 10 }) => {
    const op = await operatorUserDoc(ctx);
    if (!op) {
      return [] as Array<{ side: string; base: string; quote: string; price: number; amount: number; filled: number; status: string; ts: number }>;
    }
    const userId = op.userId;
    const rows = await ctx.db
      .query("tradeOrders")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return rows.slice(0, limit).map((o) => ({
      side: o.side, base: o.base, quote: o.quote, price: o.price,
      amount: o.amount, filled: o.filled, status: o.status, ts: o.ts,
    }));
  },
});

/** Bot-side earn plans. */
export const botListEarnPlans = internalQuery({
  args: {},
  handler: async (ctx) => {
    const op = await operatorUserDoc(ctx);
    if (!op) {
      return [] as Array<{ kind: string; asset: string; principal: number; apyPct: number; accrued: number; status: string; startedAt: number }>;
    }
    const userId = op.userId;
    const rows = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((p) => ({
        kind: p.kind, asset: p.asset, principal: p.principal,
        apyPct: p.apyPct, accrued: p.accrued, status: p.status, startedAt: p.startedAt,
      }));
  },
});

/** Bot-side transaction ledger (latest N). */
export const botListTx = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 12 }) => {
    const op = await operatorUserDoc(ctx);
    if (!op) {
      return [] as Array<{ direction: string; asset: string; amount: number; status: string; ref: string; ts: number }>;
    }
    const userId = op.userId;
    const rows = await ctx.db
      .query("tradeTx")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
    return rows.map((t) => ({
      direction: t.direction, asset: t.asset, amount: t.amount,
      status: t.status, ref: t.ref, ts: t.ts,
    }));
  },
});

/** Bot-side flexible-earn interest claim (same invariants as claimInterest). */
export const botClaimInterest = internalMutation({
  args: { planId: v.id("tradeEarnPlans") },
  handler: async (ctx, { planId }) => {
    const op = await operatorUserDoc(ctx);
    if (!op) throw new Error("Operator account not found.");
    const userId = op.userId;
    const plan = await ctx.db.get(planId);
    if (!plan || plan.userId !== userId) throw new Error("Plan not found.");
    if (plan.status !== "active") throw new Error("Plan already closed.");
    if (plan.kind !== "flexible") throw new Error("Fixed plans pay at maturity.");
    if (!(plan.accrued > 0)) throw new Error("Nothing accrued yet — check back soon.");
    const amount = plan.accrued;
    await credit(ctx, userId, "crypto", plan.asset, amount);
    await ctx.db.patch(planId, { accrued: 0, lastAccrualAt: Date.now() });
    await recordTx(ctx, userId, {
      kind: "crypto",
      direction: "interest",
      asset: plan.asset,
      amount,
      status: "completed",
      note: "Interest payout — Flexible Earn (via Telegram bot)",
    });
    return { asset: plan.asset, amount };
  },
});

/** Bot-side claim: list claimable flexible plans (accrued > 0). */
export const botClaimablePlans = internalQuery({
  args: {},
  handler: async (ctx) => {
    const op = await operatorUserDoc(ctx);
    if (!op) {
      return [] as Array<{ _id: string; asset: string; accrued: number }>;
    }
    const userId = op.userId;
    const rows = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .filter((p) => p.status === "active" && p.kind === "flexible" && p.accrued > 0)
      .map((p) => ({ _id: p._id as string, asset: p.asset, accrued: p.accrued }));
  },
});

// ── Queries ────────────────────────────────────────────────────────────────

/** Wallet overview: balances + recent transactions + earn totals. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const balances = await ctx.db
      .query("tradeBalances")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const recentTx = await ctx.db
      .query("tradeTx")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    const plans = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const interestEarned = recentTx
      .filter((t) => t.direction === "interest" && t.status === "completed")
      .reduce((s, t) => s + t.amount, 0);
    return {
      balances: balances.map((b) => ({
        kind: b.kind,
        asset: b.asset,
        available: b.available,
        locked: b.locked,
      })),
      recentTx,
      earn: {
        activePlans: plans.filter((p) => p.status === "active").length,
        activeAccrued: plans
          .filter((p) => p.status === "active")
          .reduce((s, p) => s + p.accrued, 0),
        interestEarned,
      },
    };
  },
});

/** Transactions page data with the Cash/Crypto/Internal + filters applied. */
export const listTx = query({
  args: {
    kind: v.union(v.literal("cash"), v.literal("crypto"), v.literal("internal")),
    direction: v.optional(v.union(v.literal("deposit"), v.literal("withdrawal"))),
    status: v.optional(v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { kind, direction, status, limit }) => {
    const userId = await requireUser(ctx);
    let rows = await ctx.db
      .query("tradeTx")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    rows = rows.filter((r) => r.kind === kind);
    if (direction) rows = rows.filter((r) => r.direction === direction);
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.slice(0, limit ?? 100);
  },
});

export const listOrders = query({
  args: {
    status: v.optional(v.union(v.literal("open"), v.literal("filled"), v.literal("canceled"))),
  },
  handler: async (ctx, { status }) => {
    const userId = await requireUser(ctx);
    let rows = await ctx.db
      .query("tradeOrders")
      .withIndex("by_user_ts", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.slice(0, 100);
  },
});

export const listEarnPlans = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  },
});

export const listFavorites = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("tradeFavorites")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((r) => r.pair);
  },
});

// ── Deposits / withdrawals ─────────────────────────────────────────────────

/**
 * Cash (NGN) deposit. Amounts under the operator-settlement threshold
 * credit instantly against the declared bank transfer; large ones park as
 * `pending` until the operator settles them in the Operator Console.
 */
export const requestCashDeposit = mutation({
  args: { amount: v.number() },
  handler: async (ctx, { amount }) => {
    const userId = await requireUser(ctx);
    if (!(amount >= 100)) throw new Error("Minimum cash deposit is 100 units.");
    const pending = amount >= 1_000_000;
    if (!pending) await credit(ctx, userId, "cash", "NGN", amount);
    await recordTx(ctx, userId, {
      kind: "cash",
      direction: "deposit",
      asset: "NGN",
      amount,
      status: pending ? "pending" : "completed",
      note: pending ? "Awaiting operator settlement" : "Instant deposit",
    });
    return { pending };
  },
});

/** Crypto deposit — credits the internal ledger for the received amount. */
export const requestCryptoDeposit = mutation({
  args: { asset: v.string(), amount: v.number() },
  handler: async (ctx, { asset, amount }) => {
    const userId = await requireUser(ctx);
    const def = TRADE_ASSETS[asset];
    if (!def || def.kind !== "crypto") throw new Error("Unknown crypto asset.");
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
    await credit(ctx, userId, "crypto", asset, amount);
    await recordTx(ctx, userId, {
      kind: "crypto",
      direction: "deposit",
      asset,
      amount,
      status: "completed",
      note: `Credited to ${asset} ledger`,
    });
    return { ok: true };
  },
});

/**
 * Cash deposit via real bank transfer / mobile-money: the user sends money
 * to the operator's published account details and files the reference here.
 * The request parks as a PENDING tradeTx — nothing is credited until the
 * operator verifies it against the real bank statement and settles it in
 * the Operator Console. This is a real custody flow, not a demo credit.
 */
export const claimCashDeposit = mutation({
  args: {
    asset: v.string(),
    amount: v.number(),
    method: v.union(v.literal("bank_transfer"), v.literal("mobile_money")),
    senderName: v.string(),
    reference: v.string(),
  },
  handler: async (ctx, { asset, amount, method, senderName, reference }) => {
    const userId = await requireUser(ctx);
    const def = TRADE_ASSETS[asset];
    if (!def || def.kind !== "cash") throw new Error("Unknown cash currency.");
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
    if (!senderName.trim()) throw new Error("Enter the sender name on the transfer.");
    if (!reference.trim()) throw new Error("Enter the transfer reference / transaction ID.");
    await ctx.db.insert("tradeDepositClaims", {
      userId,
      asset,
      amount,
      method,
      senderName: senderName.trim(),
      reference: reference.trim(),
      status: "pending",
      ts: Date.now(),
    });
    const ref = await recordTx(ctx, userId, {
      kind: "cash",
      direction: "deposit",
      asset,
      amount,
      status: "pending",
      note: `${method === "bank_transfer" ? "Bank transfer" : "Mobile money"} claim — ref ${reference.trim()}`,
      meta: JSON.stringify({ senderName, reference, method }),
    });
    return { ref };
  },
});

/** All deposit claims for the Operator Console (newest first). */
export const listDepositClaims = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) return [];
    const { isOperatorEmail } = await import("./operatorEmails");
    if (!(await isOperatorEmail(ctx, email))) return [];
    return await ctx.db
      .query("tradeDepositClaims")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(100);
  },
});

/** My filed deposit claims (newest first) — claim history in the UI. */
export const listMyDepositClaims = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("tradeDepositClaims").collect();
    return rows
      .filter((c) => c.userId === user._id)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20)
      .map((c) => ({
        _id: c._id,
        asset: c.asset,
        amount: c.amount,
        method: c.method,
        reference: c.reference,
        status: c.status,
        ts: c.ts,
      }));
  },
});

/**
 * Operator verification of a cash-deposit claim (real bank-statement check).
 * Approving credits the user's cash ledger AND completes the matching
 * pending deposit transaction in one step; rejecting marks both failed.
 */
export const settleDepositClaim = mutation({
  args: { claimId: v.id("tradeDepositClaims"), approve: v.boolean() },
  handler: async (ctx, { claimId, approve }) => {
    await requireOperator(ctx);
    const claim = await ctx.db.get(claimId);
    if (!claim || claim.status !== "pending") throw new Error("Claim is not pending.");
    if (approve) {
      await credit(ctx, claim.userId, "cash", claim.asset, claim.amount);
    }
    await ctx.db.patch(claimId, { status: approve ? "verified" : "rejected" });
    // Complete the matching pending deposit tx (same user/asset/amount).
    const pendingTx = await ctx.db
      .query("tradeTx")
      .withIndex("by_user_ts", (q) => q.eq("userId", claim.userId))
      .order("desc")
      .take(50);
    for (const tx of pendingTx) {
      if (
        tx.status === "pending" &&
        tx.direction === "deposit" &&
        tx.asset === claim.asset &&
        Math.abs(tx.amount - claim.amount) < 1e-9
      ) {
        await ctx.db.patch(tx._id, {
          status: approve ? "completed" : "failed",
          note:
            (tx.note ?? "") +
            (approve ? " — verified by operator" : " — rejected by operator"),
        });
        break; // settle only the matching one
      }
    }
    return { ok: true };
  },
});

// ── Operator-managed deposit details ──────────────────────────────────────

/** Receiving details for every asset (addresses / bank accounts). */
export const getDepositDetails = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const cfg = await ctx.db.query("operatorConfig").first();
    return (cfg?.tradeDepositDetails ?? {}) as Record<string, string>;
  },
});

/** Operator sets receiving details for one asset OR asset:network. */
export const setDepositDetail = mutation({
  args: { asset: v.string(), detail: v.string() },
  handler: async (ctx, { asset, detail }) => {
    await requireOperator(ctx);
    const { asset: sym, netId } = parseTradeDetailKey(asset.trim());
    const def = TRADE_ASSETS[sym];
    if (!def) throw new Error("Unknown asset.");
    if (netId) {
      const nets = TRADE_NETWORKS[sym] ?? [];
      if (!nets.some((n) => n.id === netId)) {
        throw new Error(`Network ${netId} is not valid for ${sym}.`);
      }
    }
    const text = detail.trim();
    if (!text) throw new Error("Detail cannot be empty.");
    if (text.length > 2000) throw new Error("Detail too long (max 2000 chars).");
    const cfg = await ctx.db.query("operatorConfig").first();
    if (!cfg) {
      // operatorConfig is bootstrapped by gate.ts (passphrase + emails).
      // Never create a partial row here — it would break those subsystems.
      throw new Error("Operator config not initialized yet — complete the gate setup first.");
    }
    const next = { ...(cfg.tradeDepositDetails ?? {}), [asset]: text };
    await ctx.db.patch(cfg._id, { tradeDepositDetails: next });
    return { ok: true };
  },
});

// ── Dynamic bank / mobile-money receiving accounts ─────────────────────

/**
 * Publish a NEW receiving account for a bank-rail currency (NGN/GHS/KES/
 * XAF). Rotation semantics: the previous active account (if any) is
 * deactivated — never deleted — so historical deposit claims keep
 * pointing at the account they were actually paid into, and the operator
 * can audit every account ever published.
 */
export const rotateCashAccount = mutation({
  args: {
    asset: v.string(),
    details: v.string(),
    method: v.union(v.literal("bank_transfer"), v.literal("mobile_money")),
  },
  handler: async (ctx, { asset, details, method }) => {
    await requireOperator(ctx);
    if (!isBankDepositCurrency(asset)) {
      throw new Error(
        `Dynamic bank accounts support ${BANK_DEPOSIT_CURRENCIES.join(", ")} only.`,
      );
    }
    const text = details.trim();
    if (text.length < 6) throw new Error("Enter the full account details.");
    if (text.length > 2000) throw new Error("Details too long (max 2000 chars).");
    // Deactivate the current active account for this currency (keep row).
    const current = await ctx.db
      .query("tradeCashAccounts")
      .withIndex("by_asset_active", (q) => q.eq("asset", asset).eq("active", true))
      .collect();
    for (const row of current) {
      await ctx.db.patch(row._id, { active: false, rotatedAt: Date.now() });
    }
    const id = await ctx.db.insert("tradeCashAccounts", {
      asset,
      details: text,
      method,
      active: true,
      ts: Date.now(),
    });
    return { ok: true, id };
  },
});

/** Deactivate one receiving account (e.g. the bank froze it). */
export const setCashAccountStatus = mutation({
  args: { id: v.id("tradeCashAccounts"), active: v.boolean() },
  handler: async (ctx, { id, active }) => {
    await requireOperator(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Account not found.");
    if (active) {
      // Only one active account per currency: deactivate its siblings first.
      const current = await ctx.db
        .query("tradeCashAccounts")
        .withIndex("by_asset_active", (q) => q.eq("asset", row.asset).eq("active", true))
        .collect();
      for (const other of current) {
        if (other._id !== id) {
          await ctx.db.patch(other._id, { active: false, rotatedAt: Date.now() });
        }
      }
    }
    await ctx.db.patch(id, { active, rotatedAt: active ? undefined : Date.now() });
    return { ok: true };
  },
});

/**
 * Withdrawal — debits spendable funds immediately (funds can never be
 * double-spent). Large requests hold as `pending` with funds already
 * debited; a rejection refunds in full.
 */
export const requestWithdrawal = mutation({
  args: {
    kind: v.union(v.literal("cash"), v.literal("crypto")),
    asset: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, { kind, asset, amount }) => {
    const userId = await requireUser(ctx);
    const def = TRADE_ASSETS[asset];
    if (!def || def.kind !== kind) throw new Error("Asset/account mismatch.");
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
    await debit(ctx, userId, kind, asset, amount);
    const hold = kind === "cash" ? amount >= 1_000_000 : amount >= 0.5;
    await recordTx(ctx, userId, {
      kind,
      direction: "withdrawal",
      asset,
      amount,
      status: hold ? "pending" : "completed",
      note: hold ? "Debited — awaiting operator approval" : "Processed instantly",
    });
    return { pending: hold };
  },
});

// ── Swaps ──────────────────────────────────────────────────────────────────

// ── User-facing cash receiving accounts ─────────────────────────────────

/** The ACTIVE receiving account for one bank-rail currency (NGN/GHS/KES/XAF). */
export const getActiveCashAccount = query({
  args: { asset: v.string() },
  handler: async (ctx, { asset }) => {
    await requireUser(ctx);
    const row = await ctx.db
      .query("tradeCashAccounts")
      .withIndex("by_asset_active", (q) => q.eq("asset", asset).eq("active", true))
      .first();
    if (!row) return null;
    return { _id: row._id, asset: row.asset, details: row.details, method: row.method, ts: row.ts };
  },
});

/** Every active receiving account (one per currency), for the wallet page. */
export const listActiveCashAccounts = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("tradeCashAccounts").collect();
    return rows
      .filter((r) => r.active)
      .map((r) => ({
        _id: r._id,
        asset: r.asset,
        details: r.details,
        method: r.method,
        ts: r.ts,
      }));
  },
});

/** Full account history for the operator console (newest first). */
export const listCashAccountHistory = query({
  args: {},
  handler: async (ctx) => {
    // Query-safe operator check (same pattern as listDepositClaims).
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) return [];
    const { isOperatorEmail } = await import("./operatorEmails");
    if (!(await isOperatorEmail(ctx, email))) return [];
    const rows = await ctx.db.query("tradeCashAccounts").collect();
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 100);
  },
});

/**
 * Instant swap at the live cached rate. Atomic: both legs in one mutation,
 * fee itemized in the ledger note. Refuses stale rates (>2 min old).
 */
export const swap = mutation({
  args: { from: v.string(), to: v.string(), amount: v.number() },
  handler: async (ctx, { from, to, amount }) => {
    const userId = await requireUser(ctx);
    const f = TRADE_ASSETS[from];
    const t = TRADE_ASSETS[to];
    if (!f || !t) throw new Error("Unknown asset.");
    if (from === to) throw new Error("Choose two different assets.");
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");

    const row = await ctx.db
      .query("tradePriceCache")
      .withIndex("by_key", (q) => q.eq("key", "trade.prices"))
      .first();
    if (!row) throw new Error("Live rates not loaded yet — open the Markets page once.");
    if (Date.now() - row.ts > 120_000) {
      throw new Error("Rates are stale — refresh market prices and try again.");
    }
    const prices = JSON.parse(row.data) as PriceMap;
    const pf = prices[from];
    const pt = prices[to];
    if (!pf?.usd || !pt?.usd) throw new Error("Live rate unavailable for this pair.");

    const rate = pf.usd / pt.usd; // to-units per from-unit (USD-anchored)
    const grossTo = amount * rate;
    const fee = grossTo * (SWAP_FEE_PCT / 100);
    const netTo = grossTo - fee;

    await debit(ctx, userId, kindOf(f), from, amount);
    await credit(ctx, userId, kindOf(t), to, netTo);

    await recordTx(ctx, userId, {
      kind: kindOf(t),
      direction: "swap",
      asset: to,
      amount: netTo,
      status: "completed",
      note: `Swapped ${fmt(amount)} ${from} → ${fmt(netTo)} ${to}`,
      meta: JSON.stringify({
        from,
        to,
        sentAmount: amount,
        rate: Number(rate.toPrecision(10)),
        feePct: SWAP_FEE_PCT,
        fee,
        grossTo,
      }),
    });
    return { received: netTo, rate, fee };
  },
});

// ── Order book ─────────────────────────────────────────────────────────────

export const placeOrder = mutation({
  args: {
    side: v.union(v.literal("buy"), v.literal("sell")),
    base: v.string(),
    quote: v.string(),
    price: v.number(),
    amount: v.number(),
  },
  handler: async (ctx, { side, base, quote, price, amount }) => {
    const userId = await requireUser(ctx);
    const b = TRADE_ASSETS[base];
    const q = TRADE_ASSETS[quote];
    if (!b || !q || base === quote) throw new Error("Invalid pair.");
    if (!(price > 0) || !(amount > 0)) throw new Error("Price and amount must be positive.");

    // Funds move into `locked` the moment the order is placed — they can
    // never be double-spent elsewhere.
    if (side === "buy") {
      await lock(ctx, userId, kindOf(q), quote, price * amount);
    } else {
      await lock(ctx, userId, kindOf(b), base, amount);
    }
    await ctx.db.insert("tradeOrders", {
      userId,
      side,
      base,
      quote,
      price,
      amount,
      filled: 0,
      status: "open",
      ts: Date.now(),
    });
    return { ok: true };
  },
});

export const cancelOrder = mutation({
  args: { orderId: v.id("tradeOrders") },
  handler: async (ctx, { orderId }) => {
    const userId = await requireUser(ctx);
    const order = await ctx.db.get(orderId);
    if (!order || order.userId !== userId) throw new Error("Order not found.");
    if (order.status !== "open") throw new Error("Order is not open.");
    const b = TRADE_ASSETS[order.base];
    const q = TRADE_ASSETS[order.quote];
    const remaining = order.amount - order.filled;
    if (order.side === "buy") {
      await unlockLocked(ctx, userId, kindOf(q), order.quote, remaining * order.price);
    } else {
      await unlockLocked(ctx, userId, kindOf(b), order.base, remaining);
    }
    await ctx.db.patch(orderId, { status: "canceled" });
    return { ok: true };
  },
});

/**
 * Order-scan pass (cron): every open order is checked against the live
 * cached price. Buys fill when market ≤ limit, sells when market ≥ limit —
 * always at the order's own limit price.
 */
export const scanOrders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("tradePriceCache")
      .withIndex("by_key", (q) => q.eq("key", "trade.prices"))
      .first();
    if (!row || Date.now() - row.ts > 10 * 60_000) return { filled: 0 };
    const prices = JSON.parse(row.data) as PriceMap;
    const open = await ctx.db
      .query("tradeOrders")
      .withIndex("by_open", (q) => q.eq("status", "open"))
      .collect();
    let filled = 0;
    for (const order of open) {
      const baseP = prices[order.base];
      const quoteP = prices[order.quote];
      if (!baseP?.usd || !quoteP?.usd) continue;
      // Quote-per-base via the USD anchor — works for every cash currency
      // and USDT alike (EUR-per-BTC = USD-per-BTC / USD-per-EUR).
      const marketQuotePerBase = baseP.usd / quoteP.usd;
      if (!(marketQuotePerBase > 0)) continue;
      const crosses =
        order.side === "buy"
          ? marketQuotePerBase <= order.price
          : marketQuotePerBase >= order.price;
      if (!crosses) continue;

      const b = TRADE_ASSETS[order.base];
      const q = TRADE_ASSETS[order.quote];
      const remaining = order.amount - order.filled;
      if (!(remaining > 0)) {
        await ctx.db.patch(order._id, { status: "filled", filled: order.amount });
        continue;
      }
      if (order.side === "buy") {
        // Locked quote is consumed; base assets are credited to available.
        await consumeLocked(ctx, order.userId, kindOf(q), order.quote, remaining * order.price);
        await credit(ctx, order.userId, kindOf(b), order.base, remaining);
      } else {
        // Locked base is consumed; quote proceeds are credited.
        await consumeLocked(ctx, order.userId, kindOf(b), order.base, remaining);
        await credit(ctx, order.userId, kindOf(q), order.quote, remaining * order.price);
      }
      await ctx.db.patch(order._id, { filled: order.amount, status: "filled" });
      await recordTx(ctx, order.userId, {
        kind: "crypto",
        direction: "swap",
        asset: order.side === "buy" ? order.base : order.quote,
        amount: order.side === "buy" ? remaining : remaining * order.price,
        status: "completed",
        note: `Limit ${order.side} filled: ${fmt(remaining)} ${order.base} @ ${fmt(order.price)} ${order.quote}`,
        meta: JSON.stringify({ orderId: order._id, price: order.price }),
      });
      filled += 1;
    }
    return { filled };
  },
});

// ── Earn ───────────────────────────────────────────────────────────────────

export const createEarnPlan = mutation({
  args: {
    kind: v.union(v.literal("flexible"), v.literal("fixed")),
    asset: v.string(),
    principal: v.number(),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { kind, asset, principal, days }) => {
    const userId = await requireUser(ctx);
    const def = TRADE_ASSETS[asset];
    if (!def || def.kind !== "crypto") throw new Error("Earn supports crypto assets only.");
    if (!(principal > 0)) throw new Error("Amount must be greater than zero.");
    let endsAt: number | undefined;
    let apy = FLEXIBLE_APY;
    if (kind === "fixed") {
      const d = days ?? 60;
      if (d < 60 || d > 365) throw new Error("Fixed plans lock for 60–365 days.");
      apy = FIXED_APY;
      endsAt = Date.now() + d * 86_400_000;
    }
    await debit(ctx, userId, "crypto", asset, principal);
    await ctx.db.insert("tradeEarnPlans", {
      userId,
      kind,
      asset,
      principal,
      apyPct: apy,
      startedAt: Date.now(),
      endsAt,
      lastAccrualAt: Date.now(),
      accrued: 0,
      status: "active",
    });
    await recordTx(ctx, userId, {
      kind: "crypto",
      direction: "withdrawal",
      asset,
      amount: principal,
      status: "completed",
      note: `Subscribed to ${kind === "flexible" ? "Flexible" : "Fixed"} Earn (${apy}% APY)`,
    });
    return { ok: true };
  },
});

/**
 * Accrual pass (cron): interest = principal × APY% × elapsed/365d. The math
 * is elapsed-time based, so downtime gaps never distort payouts. Fixed
 * plans stop accruing at maturity.
 */
export const accrueEarn = internalMutation({
  args: {},
  handler: async (ctx) => {
    // BUDGET (DB I/O): only ACTIVE plans accrue — indexed read instead of
    // collecting every plan (closed plans dominate the table over time).
    const plans = await ctx.db
      .query("tradeEarnPlans")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    const now = Date.now();
    let touched = 0;
    for (const plan of plans) {
      if (plan.status !== "active") continue;
      if (plan.kind === "fixed" && plan.endsAt && now >= plan.endsAt) continue;
      const dt = Math.min(now - plan.lastAccrualAt, YEAR_MS);
      if (dt < 60_000) continue;
      const gain = (plan.principal * (plan.apyPct / 100) * dt) / YEAR_MS;
      await ctx.db.patch(plan._id, { accrued: plan.accrued + gain, lastAccrualAt: now });
      touched += 1;
    }
    return { touched };
  },
});

/** Flexible plans: withdraw the accumulated interest anytime. */
export const claimInterest = mutation({
  args: { planId: v.id("tradeEarnPlans") },
  handler: async (ctx, { planId }) => {
    const userId = await requireUser(ctx);
    const plan = await ctx.db.get(planId);
    if (!plan || plan.userId !== userId) throw new Error("Plan not found.");
    if (plan.status !== "active") throw new Error("Plan already closed.");
    if (plan.kind !== "flexible") throw new Error("Fixed plans pay at maturity.");
    if (!(plan.accrued > 0)) throw new Error("Nothing accrued yet — check back soon.");
    const amount = plan.accrued;
    await credit(ctx, userId, "crypto", plan.asset, amount);
    await ctx.db.patch(planId, { accrued: 0, lastAccrualAt: Date.now() });
    await recordTx(ctx, userId, {
      kind: "crypto",
      direction: "interest",
      asset: plan.asset,
      amount,
      status: "completed",
      note: `Interest payout — Flexible Earn (${plan.apyPct}% APY)`,
    });
    return { amount };
  },
});

/** Close a plan: flexible anytime; fixed at/after maturity. */
export const closeEarnPlan = mutation({
  args: { planId: v.id("tradeEarnPlans") },
  handler: async (ctx, { planId }) => {
    const userId = await requireUser(ctx);
    const plan = await ctx.db.get(planId);
    if (!plan || plan.userId !== userId) throw new Error("Plan not found.");
    if (plan.status !== "active") throw new Error("Plan already closed.");
    if (plan.kind === "fixed" && plan.endsAt && Date.now() < plan.endsAt) {
      const days = Math.ceil((plan.endsAt - Date.now()) / 86_400_000);
      throw new Error(`Locked for ${days} more day(s) — fixed plans pay at maturity.`);
    }
    const now = Date.now();
    const tail = Math.min(now - plan.lastAccrualAt, YEAR_MS);
    const tailGain =
      tail > 60_000 ? (plan.principal * (plan.apyPct / 100) * tail) / YEAR_MS : 0;
    const payout = plan.principal + plan.accrued + tailGain;
    await credit(ctx, userId, "crypto", plan.asset, payout);
    await ctx.db.patch(planId, { status: "closed", accrued: 0, lastAccrualAt: now });
    await recordTx(ctx, userId, {
      kind: "crypto",
      direction: "interest",
      asset: plan.asset,
      amount: plan.accrued + tailGain,
      status: "completed",
      note: "Earn plan closed — principal + interest returned",
    });
    return { payout };
  },
});

// ── Internal transfers (email) ─────────────────────────────────────────────

export const internalTransfer = mutation({
  args: {
    recipientEmail: v.string(),
    asset: v.string(),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { recipientEmail, asset, amount, note }) => {
    const senderId = await requireUser(ctx);
    const def = TRADE_ASSETS[asset];
    if (!def) throw new Error("Unknown asset.");
    if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
    const email = recipientEmail.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("Enter the recipient's email address.");
    const kind = kindOf(def);

    const recipient = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!recipient) throw new Error("No FlashBolt account uses that email.");
    if (recipient._id === senderId) throw new Error("You cannot transfer to yourself.");

    await debit(ctx, senderId, kind, asset, amount);
    await credit(ctx, recipient._id, kind, asset, amount);
    await recordTx(ctx, senderId, {
      kind: "internal",
      direction: "transfer_out",
      asset,
      amount,
      status: "completed",
      note: note ? `Sent to ${email} — ${note}` : `Sent to ${email}`,
      meta: JSON.stringify({ to: email }),
    });
    await recordTx(ctx, recipient._id, {
      kind: "internal",
      direction: "transfer_in",
      asset,
      amount,
      status: "completed",
      note: `Received from ${email}`,
      meta: JSON.stringify({ from: email }),
    });
    return { ok: true };
  },
});

// ── Favorites ──────────────────────────────────────────────────────────────

export const toggleFavorite = mutation({
  args: { pair: v.string() },
  handler: async (ctx, { pair }) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("tradeFavorites")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existing = rows.find((r) => r.pair === pair);
    if (existing) {
      await ctx.db.delete(existing._id);
      return { favorited: false };
    }
    await ctx.db.insert("tradeFavorites", { userId, pair, ts: Date.now() });
    return { favorited: true };
  },
});

// ── Operator settlement ────────────────────────────────────────────────────

/** Pending deposits/withdrawals awaiting operator action. */
export const listPendingSettlements = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) return [];
    const { isOperatorEmail } = await import("./operatorEmails");
    if (!(await isOperatorEmail(ctx, email))) return [];
    return await ctx.db
      .query("tradeTx")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(100);
  },
});

/** Operator approves or rejects a pending deposit/withdrawal. */
export const settlePending = mutation({
  args: { txId: v.id("tradeTx"), approve: v.boolean() },
  handler: async (ctx, { txId, approve }) => {
    await requireOperator(ctx);
    const tx = await ctx.db.get(txId);
    if (!tx || tx.status !== "pending") throw new Error("Transaction is not pending.");
    const kind = tx.kind === "cash" ? "cash" : "crypto";
    if (approve) {
      if (tx.direction === "deposit") {
        await credit(ctx, tx.userId, kind, tx.asset, tx.amount);
      }
      // Approved withdrawals were already debited at request time.
      await ctx.db.patch(txId, {
        status: "completed",
        note: (tx.note ?? "") + " — settled by operator",
      });
    } else {
      if (tx.direction === "withdrawal") {
        await credit(ctx, tx.userId, kind, tx.asset, tx.amount);
      }
      await ctx.db.patch(txId, {
        status: "failed",
        note: (tx.note ?? "") + " — rejected by operator (refunded)",
      });
    }
    return { ok: true };
  },
});

/** Operator manual ledger adjustment (audited in the tx ledger). */
export const adjustBalance = mutation({
  args: {
    email: v.string(),
    kind: v.union(v.literal("cash"), v.literal("crypto")),
    asset: v.string(),
    amount: v.number(), // positive credit, negative debit
    note: v.string(),
  },
  handler: async (ctx, { email, kind, asset, amount, note }) => {
    await requireOperator(ctx);
    const target = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!target) throw new Error("No account with that email.");
    if (amount > 0) {
      await credit(ctx, target._id, kind, asset, amount);
    } else if (amount < 0) {
      await debit(ctx, target._id, kind, asset, -amount);
    } else {
      throw new Error("Adjustment amount cannot be zero.");
    }
    await recordTx(ctx, target._id, {
      kind,
      direction: "deposit",
      asset,
      amount: Math.abs(amount),
      status: "completed",
      note: `Operator adjustment: ${note} (${amount > 0 ? "credit" : "debit"})`,
    });
    return { ok: true };
  },
});
