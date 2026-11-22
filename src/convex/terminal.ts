import { v } from "convex/values";
import { httpAction } from "./_generated/server";
import { classifyExecutionMethod } from "../lib/execution-method";
import { mergeSolRailSettings, solRailVerdict } from "../lib/sol-rail-gate";
import { type Doc, type Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { mutation, query, internalMutation, internalQuery, internalAction, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { fetchMarketSnapshot } from "../lib/flashbolt";
import { isOperatorEmail, resolveOperatorIdentity, resolveOperatorState } from "./operatorEmails";
import { nextArmStamps } from "./pinGuard";
import { decryptSecret, encryptSecret } from "./encryption";

/**
 * Subscriber daily execution target (server-enforced).
 *
 * Subscribers get a combined daily cap across flash-loan arbitrage AND
 * sniping on BOTH terminals (BNB + SOL FlashBolt). Default 3/day; only the
 * operator can raise, lower or block (0) it from the console. The operator
 * themselves is never limited, and "Continue as Guest" sessions (anonymous
 * sign-in) are never limited either — the daily target exists for
 * SUBSCRIBERS only. The counter resets at UTC midnight and every consumed
 * slot is tied to a real recorded execution.
 */
export const DEFAULT_SUBSCRIBER_DAILY_TARGET = 3;

function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

async function loadSubscriberRow(ctx: QueryCtx | MutationCtx, email: string) {
  return await ctx.db
    .query("subscribers")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

/**
 * Consume one daily execution slot for the signed-in user. Returns the
 * post-consumption status; a `blocked` result means the target is exhausted
 * (or the operator set it to 0) and the caller must NOT broadcast.
 * Only real executions consume slots — simulations and rejected txs don't.
 */
export const consumeExecutionSlot = mutation({
  args: {
    kind: v.union(v.literal("flash"), v.literal("snipe")),
    chain: v.union(v.literal("bnb"), v.literal("sol")),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) {
      // "Continue as Guest" (anonymous sign-in) — the daily target limits
      // SUBSCRIBERS only, exactly like the operator. Guests execute freely.
      return { blocked: false, guest: true, unlimited: true, used: 0, limit: null, reason: undefined };
    }
    // The operator is NEVER limited.
    if (await isOperatorEmail(ctx, email)) {
      return { blocked: false, operator: true, used: 0, limit: null, unlimited: true, reason: undefined };
    }
    const row = await loadSubscriberRow(ctx, email);
    if (!row) {
      // Non-subscriber accounts (e.g. operator sign-up emails) are not gated.
      return { blocked: false, operator: false, subscriber: false, used: 0, limit: null, unlimited: true, reason: undefined };
    }
    if (row.status === "blocked") {
      return { blocked: true, reason: "Your access is blocked by the operator.", used: 0, limit: 0 };
    }
    const limit = typeof row.dailyTradeLimit === "number" && row.dailyTradeLimit >= 0 ? row.dailyTradeLimit : DEFAULT_SUBSCRIBER_DAILY_TARGET;
    const today = todayKey();
    const used = row.dailyTradeDate === today ? (row.dailyTradeCount ?? 0) : 0;
    if (limit === 0) {
      return { blocked: true, reason: "The operator has blocked executions for your account (daily target = 0).", used: 0, limit: 0 };
    }
    if (used >= limit) {
      return { blocked: true, reason: `Daily target reached (${used}/${limit} across arbitrage + snipes on both terminals). It resets at UTC midnight.`, used, limit };
    }
    await ctx.db.patch(row._id, {
      dailyTradeCount: used + 1,
      dailyTradeDate: today,
    });
    return { blocked: false, used: used + 1, limit, kind: args.kind, chain: args.chain, label: args.label ?? undefined };
  },
});

/** The signed-in user's live daily-target view (subscribers only). */
export const myExecutionLimit = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) {
      // Guest session (anonymous) — never limited, same as the operator.
      return { operator: false, subscriber: false, guest: true, unlimited: true, limit: null, used: 0 };
    }
    if (await isOperatorEmail(ctx, email)) {
      return { operator: true, subscriber: false, guest: false, unlimited: true, limit: null, used: 0 };
    }
    const row = await loadSubscriberRow(ctx, email);
    if (!row) return { operator: false, subscriber: false, guest: false, unlimited: true, limit: null, used: 0 };
    const limit = typeof row.dailyTradeLimit === "number" && row.dailyTradeLimit >= 0 ? row.dailyTradeLimit : DEFAULT_SUBSCRIBER_DAILY_TARGET;
    const today = todayKey();
    const used = row.dailyTradeDate === today ? (row.dailyTradeCount ?? 0) : 0;
    return { operator: false, subscriber: true, guest: false, status: row.status, limit, used };
  },
});

/** Operator: set a subscriber's daily execution target (0 = blocked). */
export const setSubscriberDailyTarget = mutation({
  args: { email: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || !(await isOperatorEmail(ctx, email))) {
      throw new Error("Only the terminal operator can change subscriber daily targets.");
    }
    const limit = Math.max(0, Math.min(1000, Math.round(args.limit)));
    const row = await loadSubscriberRow(ctx, args.email.trim().toLowerCase());
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.patch(row._id, { dailyTradeLimit: limit });
    return true;
  },
});

/** Operator: reset a subscriber's daily counter (grant immediate headroom). */
export const resetSubscriberDailyCounter = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || !(await isOperatorEmail(ctx, email))) {
      throw new Error("Only the terminal operator can reset subscriber counters.");
    }
    const row = await loadSubscriberRow(ctx, args.email.trim().toLowerCase());
    if (!row) throw new Error("Subscriber not found.");
    await ctx.db.patch(row._id, { dailyTradeCount: 0, dailyTradeDate: todayKey() });
    return true;
  },
});

/* ──────────────────────────────────────────────────────────────────────────
 * Overlay (userscript / browser extension) daily-target enforcement.
 *
 * The BNB + SOL sniper overlays run on third-party DEX sites where there is
 * no app session — so each exported overlay carries a per-subscriber token
 * (stored server-side only as a one-way SHA-256 hash). Before EVERY snipe
 * the overlay calls /api/overlay/execution, which resolves the subscriber
 * from the token and enforces the SAME operator-controlled daily target
 * (default 3, combined arb + snipe on both terminals) as the in-app paths.
 * Subscribers only; the operator has no overlay and is never gated.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Issue (or rotate) the calling subscriber's overlay access token. The raw
 * token is returned ONCE — it gets stamped into the exported overlay
 * artifacts — and only its SHA-256 hash is persisted. Subscribers only:
 * the operator's accounts must never receive a gated token.
 */
export const issueOverlayToken = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) throw new Error("Sign in first.");
    if (await isOperatorEmail(ctx, email)) {
      throw new Error("Overlay execution tokens are for subscribers only.");
    }
    const row = await loadSubscriberRow(ctx, email);
    if (!row) throw new Error("Overlay exports require an active subscriber account.");
    if (row.status === "blocked") throw new Error("Your access is blocked by the operator.");
    if (row.expiresAt < Date.now()) throw new Error("Your passcode has expired — re-subscribe to continue.");

    // Get-or-create: an existing token stays valid so re-exports never
    // break already-installed overlays. The raw value is returned only to
    // its owner at stamp time and never stored in plaintext.
    if (row.overlayTokenCipher) {
      const existing = await decryptSecret(ctx, row.overlayTokenCipher).catch(() => null);
      if (existing && /^[0-9a-f]{64}$/.test(existing)) {
        return { token: existing };
      }
    }
    // 256 bits of CSPRNG entropy, hex-encoded.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const raw = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const hash = await sha256Hex(raw);
    await ctx.db.patch(row._id, {
      overlayTokenCipher: await encryptSecret(ctx, raw),
      overlayTokenHash: hash,
    });
    return { token: raw };
  },
});

/** Serializable snapshot the HTTP gate works with (httpActions have no ctx.db). */
interface OverlaySubscriberSnapshot {
  status: "active" | "blocked" | "expired";
  expiresAt: number;
  dailyTradeLimit: number | null;
  dailyTradeCount: number | null;
  dailyTradeDate: string | null;
}

/**
 * Internal: resolve a raw overlay token to the subscriber snapshot via the
 * by_overlay_token index. Returns null for unknown/never-issued tokens.
 */
export const resolveOverlayTokenInternal = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<OverlaySubscriberSnapshot | null> => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_overlay_token", (q) => q.eq("overlayTokenHash", args.tokenHash))
      .first();
    if (!row) return null;
    return {
      status: row.status,
      expiresAt: row.expiresAt,
      dailyTradeLimit:
        typeof row.dailyTradeLimit === "number" && row.dailyTradeLimit >= 0 ? row.dailyTradeLimit : null,
      dailyTradeCount: row.dailyTradeCount ?? null,
      dailyTradeDate: row.dailyTradeDate ?? null,
    };
  },
});

/**
 * Internal: atomically consume one overlay slot for the token's subscriber.
 * Re-validates blocked/expired/target server-side so the HTTP layer can never
 * be talked past the operator's settings.
 */
export const consumeOverlaySlotInternal = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args): Promise<OverlayGateResult> => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_overlay_token", (q) => q.eq("overlayTokenHash", args.tokenHash))
      .first();
    if (!row) {
      return { ok: false, blocked: true, used: 0, limit: null, unlimited: false, reason: "Unknown overlay token — re-export the overlay from the terminal to refresh it." };
    }
    if (row.status === "blocked") {
      return { ok: false, blocked: true, used: 0, limit: 0, unlimited: false, reason: "Your access is blocked by the operator." };
    }
    if (row.expiresAt < Date.now()) {
      return { ok: false, blocked: true, used: 0, limit: 0, unlimited: false, reason: "Your passcode has expired — re-subscribe to continue." };
    }
    const limit =
      typeof row.dailyTradeLimit === "number" && row.dailyTradeLimit >= 0
        ? row.dailyTradeLimit
        : DEFAULT_SUBSCRIBER_DAILY_TARGET;
    const today = todayKey();
    const used = row.dailyTradeDate === today ? (row.dailyTradeCount ?? 0) : 0;
    if (limit === 0) {
      return { ok: false, blocked: true, used: 0, limit: 0, unlimited: false, reason: "The operator has blocked executions for your account (daily target = 0)." };
    }
    if (used >= limit) {
      return {
        ok: false,
        blocked: true,
        used,
        limit,
        unlimited: false,
        reason: `Daily target reached (${used}/${limit} across arbitrage + snipes on both terminals). Resets ${utcMidnightIso()}.`,
      };
    }
    const nextUsed = used + 1;
    await ctx.db.patch(row._id, { dailyTradeCount: nextUsed, dailyTradeDate: today });
    return { ok: true, blocked: false, used: nextUsed, limit, unlimited: false, resetAtUtc: utcMidnightIso() };
  },
});

/** Overlay verdict — serializable, CORS-safe JSON. */
interface OverlayGateResult {
  ok: boolean;
  blocked: boolean;
  used: number;
  limit: number | null;
  unlimited: boolean;
  reason?: string;
  resetAtUtc?: string;
}

function utcMidnightIso(): string {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return new Date(next).toISOString();
}

function overlayCors(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Content-Type, X-Flashbolt-Token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
    ...extra,
  };
}

function overlayPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Content-Type, X-Flashbolt-Token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

/** Extract + validate the raw overlay token (header first, then JSON body). */
async function extractOverlayToken(request: Request): Promise<string | null> {
  const header = request.headers.get("x-flashbolt-token");
  if (header) {
    const t = header.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  }
  try {
    const body = (await request.json()) as { token?: string };
    if (typeof body.token === "string") {
      const t = body.token.trim().toLowerCase();
      return /^[0-9a-f]{64}$/.test(t) ? t : null;
    }
  } catch {
    /* no JSON body */
  }
  return null;
}

/** GET — live daily-target status for the overlay panel badge. */
export const overlayGateStatusHttp = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return overlayPreflight();
  const raw = await extractOverlayToken(request);
  if (!raw) {
    return new Response(
      JSON.stringify({
        ok: false,
        blocked: true,
        used: 0,
        limit: null,
        unlimited: false,
        reason: "Missing or malformed overlay token — re-export the overlay from the terminal while signed in.",
      }),
      { status: 401, headers: overlayCors() },
    );
  }
  const hash = await sha256Hex(raw);
  const snap = await ctx.runQuery(internal.terminal.resolveOverlayTokenInternal, { tokenHash: hash });
  if (!snap) {
    return new Response(
      JSON.stringify({
        ok: false,
        blocked: true,
        used: 0,
        limit: null,
        unlimited: false,
        reason: "Unknown overlay token — re-export the overlay from the terminal to refresh it.",
      }),
      { status: 401, headers: overlayCors() },
    );
  }
  const limit = snap.dailyTradeLimit ?? DEFAULT_SUBSCRIBER_DAILY_TARGET;
  const today = todayKey();
  const used = snap.dailyTradeDate === today ? (snap.dailyTradeCount ?? 0) : 0;
  if (snap.status === "blocked" || snap.expiresAt < Date.now()) {
    return new Response(
      JSON.stringify({
        ok: false,
        blocked: true,
        used,
        limit: 0,
        unlimited: false,
        reason:
          snap.status === "blocked"
            ? "Your access is blocked by the operator."
            : "Your passcode has expired — re-subscribe to continue.",
      }),
      { status: 403, headers: overlayCors() },
    );
  }
  return new Response(
    JSON.stringify({
      ok: true,
      blocked: limit === 0,
      used,
      limit,
      unlimited: false,
      reason: limit === 0 ? "The operator has blocked executions for your account." : undefined,
      resetAtUtc: utcMidnightIso(),
    }),
    { status: 200, headers: overlayCors() },
  );
});

/** POST — consume one daily-target slot before an overlay snipe. */
export const overlayGateExecutionHttp = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return overlayPreflight();
  const raw = await extractOverlayToken(request);
  if (!raw) {
    return new Response(
      JSON.stringify({
        ok: false,
        blocked: true,
        used: 0,
        limit: null,
        unlimited: false,
        reason: "Missing or malformed overlay token — re-export the overlay from the terminal while signed in.",
      }),
      { status: 401, headers: overlayCors() },
    );
  }
  const hash = await sha256Hex(raw);
  const result = await ctx.runMutation(internal.terminal.consumeOverlaySlotInternal, { tokenHash: hash });
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : result.reason?.includes("Unknown") ? 401 : 403,
    headers: overlayCors(),
  });
});
import { buildTradeAlert } from "../lib/telegram";
import { BNB_MAX_LOAN_CAP, CHAIN_INFO } from "../lib/flashbolt";

type ExecutionStatus = "success" | "blocked" | "below_floor" | "failed";
type TerminalMode = "paper" | "live";
type TerminalNetwork = "mainnet" | "testnet";
type TerminalChainKey = "bsc" | "ethereum" | "arbitrum" | "polygon";
type GasPriority = "standard" | "fast" | "turbo";

/**
 * BSC venue keys straight from the live chain registry — the default
 * whitelist always matches what the scanner can actually price. Never a
 * hard-coded list: registry additions (PCS_V3, OPENOCEAN, KYBERSWAP, …)
 * flow into new accounts automatically.
 */
const BSC_DEX_KEYS: string[] = CHAIN_INFO.bsc.dexes.map((d) => d.key);

/**
 * The legacy persisted default that predates PCS_V3 / OPENOCEAN /
 * KYBERSWAP. Accounts still carrying EXACTLY this list were never
 * customized by the operator, so they are migrated once to the current
 * registry — the old default starves the feed of the deepest and
 * lowest-fee venue (PancakeSwap V3, verified: $12M+ USDT / $2M+ USDC depth
 * at 0.10% fees) and thins every route computation.
 */
const LEGACY_BSC_WHITELIST = ["PCS", "BISWAP", "MDEX", "APESWAP", "BABYSWAP"];

/** Exact-list equality (order-insensitive) for whitelist comparisons. */
function sameWhitelist(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((k) => typeof k === "string" && setB.has(k));
}

const NATIVE_SYMBOL: Record<string, string> = {
  bsc: "BNB",
  ethereum: "ETH",
  arbitrum: "ETH",
  polygon: "POL",
};

/** One-way SHA-256 hex digest (Web Crypto, available in Convex V8). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Which account ran the trade — "operator" or "subscriber". Compared
 * server-side against the one-way hash of the hidden operator email; the
 * email itself is never exposed.
 */
async function accountRole(
  ctx: MutationCtx,
  email: string | null | undefined,
): Promise<"operator" | "subscriber" | "guest"> {
  if (!email) return "guest";
  try {
    const op = await ctx.db.query("operatorConfig").first();
    if (op?.emailHash && (await sha256Hex(email.trim().toLowerCase())) === op.emailHash) {
      return "operator";
    }
  } catch {
    // fall through to subscriber on any lookup failure
  }
  return "subscriber";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export const DEFAULT_TERMINAL_STATE = {
  balance: 10,
  lifetimePnl: 0,
  executionsToday: 0,
  successesToday: 0,
  successRate: 0,
  scansToday: 0,
  openOpportunities: 0,
  botRunning: true,
  // SOL bot starts ON by default too — bots are independent: stopping one
  // never stops the other.
  solBotRunning: true,
  mode: "paper" as TerminalMode,
  minProfit: 0.2,
  mevGuard: true,
  cadence: 15,
  connectedWallets: [] as string[],
  // strategy — min BNB loan 0.1, max BNB loan up to the 5/10 cap
  maxLoan: 10,
  maxHops: 3,
  slippage: 0.5,
  gasPriority: "standard" as GasPriority,
  autoPayout: true,
  dexWhitelist: [...BSC_DEX_KEYS],
  // Balancer v — automatic low-fee-first lender selection (ON by default:
  // the rotation starts from the lowest documented fee every cycle)
  lenderBalancer: true,
  // Private-RPC submission (Flashbots Protect / bloXroute) — signed txs for
  // hot-wallet paths go to a private relay, hidden from the public mempool.
  privateSubmit: true,
  // network
  network: "mainnet" as TerminalNetwork,
  // daily arbitrage target (max routes per day; 0 = unlimited)
  dailyArbTarget: 0,
  // ── SOL FlashBolt sniper settings (stamped into the overlay dashboard) ──
  solNetwork: "mainnet" as "mainnet" | "testnet",
  solBuyAmountSol: 0.5,
  solSellAmountPct: 100,
  solSlippagePct: 1,
  solProfitTargetPct: 12,
  solTrailingStopPct: 5,
  solMinLiquidityUsd: 5000,
  // Per-cluster RPC override for the SOL flasher ("" = official endpoints).
  solRpcOverrides: {} as Record<string, string>,
  // SOL execution rail — Jupiter swaps until FlashboltSolana is deployed and
  // authorized; the contract rail refuses without a program ID + audit.
  solExecutionRail: "jupiter" as "jupiter" | "solcontract",
  solContractProgramId: "",
  solContractAuthorized: false,
  solAuditApproved: false,
  solPinnedGenesis: "",
  // multi-chain scanner
  chainKey: "bsc" as TerminalChainKey,
  // per-chain deployments / whitelists / private RPC overrides
  deployments: {},
  dexWhitelists: {},
  rpcOverrides: {},
  // payout accounting
  payoutsTotal: 0,
  payoutsCount: 0,
};

const NEW_FIELD_BACKFILL = {
  solBotRunning: true,
  maxLoan: 10,
  maxHops: 3,
  slippage: 0.5,
  gasPriority: "standard" as GasPriority,
  autoPayout: true,
  dexWhitelist: [...BSC_DEX_KEYS],
  lenderBalancer: true,
  privateSubmit: true,
  dailyArbTarget: 0,
  loanAssets: [] as string[],
  solNetwork: "mainnet" as "mainnet" | "testnet",
  solBuyAmountSol: 0.5,
  solSellAmountPct: 100,
  solSlippagePct: 1,
  solProfitTargetPct: 12,
  solTrailingStopPct: 5,
  solMinLiquidityUsd: 5000,
  solRpcOverrides: {} as Record<string, string>,
  solExecutionRail: "jupiter" as "jupiter" | "solcontract",
  solContractProgramId: "",
  solContractAuthorized: false,
  solAuditApproved: false,
  solPinnedGenesis: "",
  network: "mainnet" as TerminalNetwork,
  chainKey: "bsc" as TerminalChainKey,
  deployments: {},
  dexWhitelists: {},
  rpcOverrides: {},
  payoutsTotal: 0,
  payoutsCount: 0,
};

async function getState(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("terminalStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

// ---------------------------------------------------------------------------
// Internal bot variants — the Telegram bot operates on the operator's state
// WITHOUT a web session. Same documents, same invariants; identity comes from
// the verified chat link (which only pairs through the authenticated app).
// ---------------------------------------------------------------------------

/** The operator's terminal state row, or null when they never opened the app. */
/**
 * Resolve the operator's terminal-state row: the user whose email matches
 * the canonical gate operator OR an active registered operator email.
 * Deterministic fallback: the first state row (single-operator deployment).
 * Plain db helper — usable from both query and mutation contexts.
 */
async function operatorStateDoc(
  ctx: { db: QueryCtx["db"] },
): Promise<Doc<"terminalStates"> | null> {
  // BUDGET (DB I/O): indexed resolution (a handful of point reads) instead
  // of the old path that collected the ENTIRE terminalStates table (100+
  // big rows) + the entire users table + re-read the operator config once
  // PER candidate — this runs on every engine pass (botGetState), every
  // Telegram bot call, and every botBumpScan.
  const hit = await resolveOperatorState(ctx);
  if (hit) return hit.state;
  // COLD FALLBACK — no signed-up account matches the operator emails (the
  // original single-operator behavior): the first state row. Reads ONE doc
  // instead of collecting the whole table; only reached when resolution
  // fails, which is never in a healthy deployment.
  return await ctx.db.query("terminalStates").first();
}

/**
 * The operator's USER doc (scheduler/CLI identity has no session — the
 * autonomous engine resolves the operator account directly through the same
 * resolution operatorStateDoc uses: the operator-email user, else fallback).
 */
async function operatorUserDoc(
  ctx: { db: QueryCtx["db"] },
): Promise<Doc<"users"> | null> {
  const state = await operatorStateDoc(ctx);
  if (!state) return null;
  return ctx.db.get(state.userId);
}

export const botGetState = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"terminalStates"> | null> => operatorStateDoc(ctx),
});

/**
 * Bot-side running switches — INDEPENDENT PER BOT. `chain: "bnb"` flips the
 * classic botRunning, `chain: "sol"` flips solBotRunning, so stopping the
 * SOL bot never stops the BNB engine (and vice versa).
 */
export const botSetBotRunning = internalMutation({
  args: { running: v.boolean(), chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))) },
  handler: async (ctx, { running, chain }) => {
    const state = await operatorStateDoc(ctx);
    if (!state) return false;
    if (chain === "sol") {
      await ctx.db.patch(state._id, { solBotRunning: running });
    } else {
      await ctx.db.patch(state._id, { botRunning: running });
    }
    return true;
  },
});

/** Per-bot running read (bot dashboard messages). */
export const botGetRunning = internalQuery({
  args: { chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))) },
  handler: async (ctx, { chain }): Promise<boolean> => {
    const state = await operatorStateDoc(ctx);
    if (!state) return false;
    return chain === "sol" ? state.solBotRunning !== false : state.botRunning;
  },
});

/**
 * Public START for the app dialog — the same console boot the Telegram
 * /start and 🚀 START button perform. Operator-gated (sign-in or guest),
 * flips the persistent terminal state ON so the app and bot agree, and
 * kicks the server-side scan engine immediately.
 */
export const botStartFromDialog = mutation({
  args: {
    deviceToken: v.optional(v.string()),
    // Which bot to start — defaults to the BNB engine (the dialog's classic
    // START). Independent: starting SOL never flips BNB and vice versa.
    chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))),
  },
  handler: async (ctx, { deviceToken, chain }) => {
    // Operator gate — local (no cross-module import: telegramBot.ts already
    // consumes internal.terminal.* and a back-import would create a type
    // cycle). Same three-identity verdict as the bot's web-side gate.
    const { isOperatorEmail, isTrustedDeviceToken } = await import("./operatorEmails");
    const token = deviceToken?.trim() ?? "";
    const deviceOk = token.length >= 32 && (await isTrustedDeviceToken(ctx, token));
    if (!deviceOk) {
      const identity = await ctx.auth.getUserIdentity();
      const email = identity?.email?.trim().toLowerCase() ?? "";
      const rawUserId = identity ? (identity.subject.split("|")[0] ?? null) : null;
      const userId = rawUserId as Id<"users"> | null;
      const emailOk = email ? await isOperatorEmail(ctx, email) : false;
      const guestOk = userId ? Boolean((await ctx.db.get(userId))?.guestOperatorVerifiedAt) : false;
      if (!emailOk && !guestOk) throw new Error("Operator access required.");
    }
    const state = await operatorStateDoc(ctx);
    if (!state) throw new Error("No terminal state — open the terminal once to initialize.");
    const runningNow = chain === "sol" ? state.solBotRunning !== false : state.botRunning;
    if (!runningNow) {
      await ctx.db.patch(
        state._id,
        chain === "sol" ? { solBotRunning: true } : { botRunning: true },
      );
    }
    // Engine kicks: fire-and-forget — the mutation returns immediately and
    // the engines run on their own heartbeat (cron + loop continuation).
    // BOTH subsystems kick: the scanner feed AND the sniper loop (each gated
    // by the same per-chain switch, each with its own lease/stamps).
    await ctx.scheduler.runAfter(0, internal.terminal.scanPass, { chain });
    await ctx.scheduler.runAfter(0, internal.terminal.snipePass, { chain });
    return { ok: true, alreadyRunning: runningNow };
  },
});

/** Bot-side paper/live mode switch. */
export const botSetMode = internalMutation({
  args: { mode: v.union(v.literal("paper"), v.literal("live")) },
  handler: async (ctx, { mode }) => {
    const state = await operatorStateDoc(ctx);
    if (!state) return false;
    await ctx.db.patch(state._id, { mode });
    return true;
  },
});

/**
 * Bot-side scan bump (mirrors bumpScan without a session) — PER CHAIN. Each
 * engine stamps only its own freshness/lease fields, so the BNB and SOL
 * loops never overwrite each other's single-driver state and stopping one
 * engine leaves the other's stamps (and lease) untouched.
 */
export const botBumpScan = internalMutation({
  args: {
    opportunities: v.optional(v.number()),
    /** Engine lease continuation — fresh server stamp owned by THIS loop. */
    loopToken: v.optional(v.string()),
    chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))),
    /** Which engine family stamps this pass: "scan" (route feeds) or
     * "snipe" (sniper engines). Each subsystem owns its own stamps/lease so
     * the four loops stay fully independent (never stand each other down). */
    subsystem: v.optional(v.union(v.literal("scan"), v.literal("snipe"))),
  },
  handler: async (ctx, { opportunities, loopToken, chain, subsystem }) => {
    const state = await operatorStateDoc(ctx);
    if (!state) return false;
    const date = new Date().toISOString().slice(0, 10);
    const isNewDay = state.scanDate !== date;
    const now = Date.now();
    if (chain === "sol") {
      // SOL engine: its own stamps/lease; shared daily counters still count
      // the pass (they feed the same dashboard). The SOL SNIPER owns the
      // sSn* stamps/lease — the scan loop's freshness never stands it down.
      if (subsystem === "snipe") {
        await ctx.db.patch(state._id, {
          scansToday: isNewDay ? 1 : state.scansToday + 1,
          sSnLastScanAt: now,
          sSnLastScanSource: "server" as const,
          ...(loopToken !== undefined ? { sSnLoopToken: loopToken } : {}),
          scanDate: date,
          ...(opportunities !== undefined
            ? {
                openOpportunities: Math.max(0, opportunities),
                solOpenOpportunities: Math.max(0, opportunities),
              }
            : {}),
        });
        return true;
      }
      await ctx.db.patch(state._id, {
        scansToday: isNewDay ? 1 : state.scansToday + 1,
        solLastScanAt: now,
        solLastScanSource: "server" as const,
        ...(loopToken !== undefined ? { solEngineLoopToken: loopToken } : {}),
        scanDate: date,
        ...(opportunities !== undefined
          ? {
              openOpportunities: Math.max(0, opportunities),
              solOpenOpportunities: Math.max(0, opportunities),
            }
          : {}),
      });
      return true;
    }
    if (subsystem === "snipe") {
      // BNB SNIPER: own stamps/lease (bSn*) — independent of the BNB scan
      // loop, the SOL scan loop and the SOL sniper alike.
      await ctx.db.patch(state._id, {
        scansToday: isNewDay ? 1 : state.scansToday + 1,
        bSnLastScanAt: now,
        bSnLastScanSource: "server" as const,
        ...(loopToken !== undefined ? { bSnLoopToken: loopToken } : {}),
        scanDate: date,
        ...(opportunities !== undefined
          ? {
              openOpportunities: Math.max(0, opportunities),
              bnbOpenOpportunities: Math.max(0, opportunities),
            }
          : {}),
      });
      return true;
    }
    await ctx.db.patch(state._id, {
      scansToday: isNewDay ? 1 : state.scansToday + 1,
      lastScanAt: now,
      // The server engine is the driver whenever it scans.
      lastScanSource: "server" as const,
      ...(loopToken !== undefined ? { engineLoopToken: loopToken } : {}),
      scanDate: date,
      ...(opportunities !== undefined
        ? {
            openOpportunities: Math.max(0, opportunities),
            bnbOpenOpportunities: Math.max(0, opportunities),
          }
        : {}),
    });
    return true;
  },
});

/** Bot-side execution trail read (latest N, newest first). */
export const botListExecutions = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 12 }) => {
    const state = await operatorStateDoc(ctx);
    if (!state) {
      return {
        rows: [] as Array<{
          label: string; status: string; amountBnb: number; profitPct: number;
          ts: number; chain: string | null; txHash: string | null;
        }>,
        liveTotal: 0,
        simTotal: 0,
      };
    }
    // BUDGET (DB I/O): totals from the materialized pnlStats doc (the
    // old liveTotal/simTotal split IS exactly the fold rule) and the trail
    // is a bounded newest-N index read — never a full-history collect +
    // sort (16k+ rows ≈ 6 MB) per /history command.
    const stats = await readPnlStats(ctx, state.userId);
    if (stats) {
      const recentRows = await ctx.db
        .query("executions")
        .withIndex("by_user_ts", (q) => q.eq("userId", state.userId))
        .order("desc")
        .take(limit);
      return {
        rows: recentRows.map((r) => ({
          label: r.label,
          status: r.status as string,
          amountBnb: r.amountBnb,
          profitPct: r.profitPct,
          ts: r.ts,
          chain: r.chain ?? null,
          txHash: r.txHash ?? null,
        })),
        liveTotal: stats.liveCount,
        simTotal: stats.simCount,
      };
    }
    // Cold fallback — stats not materialized yet (first run after deploy):
    // same honest kind split over the full history, one time.
    const all = await ctx.db
      .query("executions")
      .withIndex("by_user", (q) => q.eq("userId", state.userId))
      .collect();
    // Global kind split (same honest rule as pnlSummary: a `sim-` pseudo-hash
    // is a paper trail marker, never a broadcast).
    let liveTotal = 0;
    let simTotal = 0;
    for (const r of all) {
      if (r.txHash && !r.txHash.startsWith("sim-")) liveTotal += 1;
      else simTotal += 1;
    }
    const rows = all
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((r) => ({
        label: r.label,
        status: r.status as string,
        amountBnb: r.amountBnb,
        profitPct: r.profitPct,
        ts: r.ts,
        chain: r.chain ?? null,
        txHash: r.txHash ?? null,
      }));
    return { rows, liveTotal, simTotal };
  },
});

/** Bot-side PnL summary — the same net-of-gas math as pnlSummary. */
export const botPnlSummary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await operatorStateDoc(ctx);
    const empty = {
      liveCount: 0, wins: 0, grossProfit: 0, gasBurned: 0, netPnl: 0,
      live24h: 0, wins24h: 0, net24h: 0,
      solLiveCount: 0, solWins: 0, solGrossProfit: 0, solGasBurned: 0, solNetPnl: 0,
      solLive24h: 0, solWins24h: 0, solNet24h: 0,
      simCount: 0, simWins: 0, simGross: 0, simCredited: 0, simNet: 0,
    };
    if (!state) return empty;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    // BUDGET (DB I/O) — all-time totals from the materialized pnlStats doc
    // (one point read); the cold fallback does one full scan only until the
    // first app session materializes the row. The honest sim- rule now
    // matches pnlSummary exactly (a `sim-` pseudo-hash is paper — the old
    // branch here counted it as LIVE).
    const stats: PnlTotals =
      (await readPnlStats(ctx, state.userId)) ??
      foldAllPnlRows(
        await ctx.db
          .query("executions")
          .withIndex("by_user", (q) => q.eq("userId", state.userId))
          .collect(),
      );
    // 24-hour window — bounded by_user_ts range over the last day only.
    const recent = await ctx.db
      .query("executions")
      .withIndex("by_user_ts", (q) =>
        q.eq("userId", state.userId).gte("ts", dayAgo),
      )
      .collect();
    let live24h = 0;
    let wins24h = 0;
    let gross24h = 0;
    let gas24h = 0;
    let solLive24h = 0;
    let solWins24h = 0;
    let solGross24h = 0;
    let solGas24h = 0;
    for (const r of recent) {
      if (!r.txHash || r.txHash.startsWith("sim-")) continue; // nothing on-chain
      const gas = r.gasUsedBnb ?? 0;
      const profit = r.status === "success" ? r.amountBnb : 0;
      live24h += 1;
      if (r.status === "success") wins24h += 1;
      gross24h += profit;
      gas24h += gas;
      if ((r.chain ?? "bsc") === "solana") {
        solLive24h += 1;
        if (r.status === "success") solWins24h += 1;
        solGross24h += profit;
        solGas24h += gas;
      }
    }
    return {
      liveCount: stats.liveCount,
      wins: stats.wins,
      grossProfit: round6(stats.grossProfit),
      gasBurned: round6(stats.gasBurned),
      netPnl: round6(stats.grossProfit - stats.gasBurned),
      live24h,
      wins24h,
      net24h: round6(gross24h - gas24h),
      solLiveCount: stats.solLiveCount,
      solWins: stats.solWins,
      solGrossProfit: round6(stats.solGrossProfit),
      solGasBurned: round6(stats.solGasBurned),
      solNetPnl: round6(stats.solGrossProfit - stats.solGasBurned),
      solLive24h,
      solWins24h,
      solNet24h: round6(solGross24h - solGas24h),
      simCount: stats.simCount,
      simWins: stats.simWins,
      simGross: round6(stats.simNet),
      simCredited: round6(stats.simNet),
      simNet: round6(stats.simNet),
    };
  },
});

// ---------------------------------------------------------------------------
// Materialized PnL aggregates (pnlStats) — shared math core
// ---------------------------------------------------------------------------

/** All-time PnL totals — the persisted pnlStats row shape. */
type PnlTotals = {
  liveCount: number;
  wins: number;
  grossProfit: number;
  gasBurned: number;
  solLiveCount: number;
  solWins: number;
  solGrossProfit: number;
  solGasBurned: number;
  simCount: number;
  simWins: number;
  simNet: number;
};

/** The subset of an executions row the totals math needs. */
type PnlRowLike = {
  txHash?: string;
  status: string;
  amountBnb: number;
  gasUsedBnb?: number;
  chain?: string;
};

function emptyPnlTotals(): PnlTotals {
  return {
    liveCount: 0,
    wins: 0,
    grossProfit: 0,
    gasBurned: 0,
    solLiveCount: 0,
    solWins: 0,
    solGrossProfit: 0,
    solGasBurned: 0,
    simCount: 0,
    simWins: 0,
    simNet: 0,
  };
}

/**
 * Fold ONE execution row into all-time totals. THE single honest rule,
 * shared by pnlSummary, botPnlSummary, botListExecutions and the stats
 * writers: a `sim-` pseudo-hash is a paper trail marker (never broadcast),
 * so it rolls into SIM; a real txHash is LIVE (gas deducted), with the
 * chain split recorded for the SOL cards.
 */
function foldPnlRow(t: PnlTotals, r: PnlRowLike): void {
  if (!r.txHash || r.txHash.startsWith("sim-")) {
    t.simCount += 1;
    if (r.status === "success") {
      t.simWins += 1;
      t.simNet += r.amountBnb;
    }
    return; // nothing on-chain
  }
  const gas = r.gasUsedBnb ?? 0;
  const profit = r.status === "success" ? r.amountBnb : 0;
  t.liveCount += 1;
  if (r.status === "success") t.wins += 1;
  t.grossProfit += profit;
  t.gasBurned += gas;
  if ((r.chain ?? "bsc") === "solana") {
    t.solLiveCount += 1;
    if (r.status === "success") t.solWins += 1;
    t.solGrossProfit += profit;
    t.solGasBurned += gas;
  }
}

function foldAllPnlRows(rows: PnlRowLike[]): PnlTotals {
  const t = emptyPnlTotals();
  for (const r of rows) foldPnlRow(t, r);
  return t;
}

// Exported for the daily retention sweep (retention.ts): it must materialize
// a user's stats doc from the full history BEFORE deleting old paper rows.
export { foldAllPnlRows, writePnlStats };

/** Point read of a user's stats doc (cheap — the pnlSummary hot path). */
async function readPnlStats(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
): Promise<Doc<"pnlStats"> | null> {
  return await ctx.db
    .query("pnlStats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/** Overwrite a user's stats doc with freshly computed totals. */
async function writePnlStats(
  ctx: MutationCtx,
  userId: Id<"users">,
  totals: PnlTotals,
): Promise<void> {
  const rows = await ctx.db
    .query("pnlStats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(5);
  // Self-heal duplicates from an (essentially impossible) cold-start race:
  // readers use .first(), so exactly one row must exist.
  for (const extra of rows.slice(1)) await ctx.db.delete(extra._id);
  const existing = rows[0];
  if (existing) {
    await ctx.db.patch(existing._id, { ...totals, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("pnlStats", { userId, ...totals, updatedAt: Date.now() });
  }
}

/**
 * Fold ONE freshly recorded execution into the stats doc. Missing doc =
 * cold start (first record after deploy): one full recompute materializes
 * it, including this row (the row is inserted BEFORE this runs). All write
 * sites of this helper also patch the terminal state, so overlapping cold
 * starts serialize through OCC instead of double-inserting.
 */
async function bumpPnlStats(
  ctx: MutationCtx,
  userId: Id<"users">,
  row: PnlRowLike,
): Promise<void> {
  const existing = await readPnlStats(ctx, userId);
  if (!existing) {
    const all = await ctx.db
      .query("executions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    await writePnlStats(ctx, userId, foldAllPnlRows(all));
    return;
  }
  const delta = emptyPnlTotals();
  foldPnlRow(delta, row);
  await ctx.db.patch(existing._id, {
    liveCount: existing.liveCount + delta.liveCount,
    wins: existing.wins + delta.wins,
    grossProfit: existing.grossProfit + delta.grossProfit,
    gasBurned: existing.gasBurned + delta.gasBurned,
    solLiveCount: existing.solLiveCount + delta.solLiveCount,
    solWins: existing.solWins + delta.solWins,
    solGrossProfit: existing.solGrossProfit + delta.solGrossProfit,
    solGasBurned: existing.solGasBurned + delta.solGasBurned,
    simCount: existing.simCount + delta.simCount,
    simWins: existing.simWins + delta.simWins,
    simNet: existing.simNet + delta.simNet,
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Current user's persisted terminal state (null until first ensure). */
export const getTerminalState = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return (await getState(ctx, user._id)) ?? null;
  },
});

/** Recent executions for the current user, newest first. */
export const listExecutions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 40 }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    // EnginePulse subscribes with limit 0 in shells that don't narrate
    // fills — answer it with an empty list without touching the database
    // (and never let an out-of-range limit widen the read).
    const take = Math.max(0, Math.min(limit, 500));
    if (take === 0) return [];
    // BUDGET (DB I/O): indexed newest-first take — never collect the whole
    // history and sort it in memory (this query is subscribed by the
    // terminal hook AND EnginePulse, so it re-runs on every new execution).
    return await ctx.db
      .query("executions")
      .withIndex("by_user_ts", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(take);
  },
});

/**
 * EnginePulse's data — the ALWAYS-MOUNTED narration subscription, slimmed
 * to exactly the fields that component reads (its full getTerminalState
 * subscription used to re-deliver the entire terminal doc — whitelists,
 * deployments, RPC overrides and all — on every scan stamp). Same auth
 * scoping, same semantics; see EnginePulse.tsx.
 */
export const getEnginePulseState = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const s = (await getState(ctx, user._id)) ?? null;
    if (!s) return null;
    return {
      botRunning: s.botRunning,
      solBotRunning: s.solBotRunning,
      lastScanAt: s.lastScanAt,
      lastScanSource: s.lastScanSource ?? null,
      solLastScanAt: s.solLastScanAt,
      solLastScanSource: s.solLastScanSource ?? null,
      bnbOpenOpportunities: s.bnbOpenOpportunities,
      solOpenOpportunities: s.solOpenOpportunities,
    };
  },
});

/**
 * True net performance across LIVE on-chain executions: gross flash-loan
 * profit minus real gas burned. Reverted txs still pay gas, so "failed"
 * rows burn it too; blocked/below-floor rows never broadcast and cost
 * nothing; paper trades have no on-chain footprint and are excluded.
 */
export const pnlSummary = query({
  args: {},
  handler: async (ctx) => {
    const empty = {
      liveCount: 0,
      wins: 0,
      grossProfit: 0,
      gasBurned: 0,
      netPnl: 0,
      live24h: 0,
      wins24h: 0,
      net24h: 0,
      solLiveCount: 0,
      solWins: 0,
      solGrossProfit: 0,
      solGasBurned: 0,
      solNetPnl: 0,
      solLive24h: 0,
      solWins24h: 0,
      solNet24h: 0,
      simCount: 0,
      simWins: 0,
      simNet: 0,
    };
    const user = await getCurrentUser(ctx);
    if (!user) return empty;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    // BUDGET (DB I/O) — ALL-TIME totals come from the materialized pnlStats
    // doc (one point read). The full-history fallback only runs before the
    // first purge/execution materializes the row (read-only — the very next
    // mutation creates it). This query is SUBSCRIBED: it used to rescan the
    // entire executions table (16k+ rows ≈ 6 MB) on every execution write.
    const stats: PnlTotals =
      (await readPnlStats(ctx, user._id)) ??
      foldAllPnlRows(
        await ctx.db
          .query("executions")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect(),
      );
    // 24-HOUR figures — bounded by_user_ts range over just the last day's
    // rows (never the whole history). SIM rows carry nothing on-chain and
    // are excluded here exactly as before; the Solana split keeps SOL gas
    // out of the BNB sums (or vice versa).
    const recent = await ctx.db
      .query("executions")
      .withIndex("by_user_ts", (q) => q.eq("userId", user._id).gte("ts", dayAgo))
      .collect();
    let live24h = 0;
    let wins24h = 0;
    let gross24h = 0;
    let gas24h = 0;
    let solLive24h = 0;
    let solWins24h = 0;
    let solGross24h = 0;
    let solGas24h = 0;
    for (const r of recent) {
      if (!r.txHash || r.txHash.startsWith("sim-")) continue; // nothing on-chain
      const gas = r.gasUsedBnb ?? 0;
      const profit = r.status === "success" ? r.amountBnb : 0;
      live24h += 1;
      if (r.status === "success") wins24h += 1;
      gross24h += profit;
      gas24h += gas;
      if ((r.chain ?? "bsc") === "solana") {
        solLive24h += 1;
        if (r.status === "success") solWins24h += 1;
        solGross24h += profit;
        solGas24h += gas;
      }
    }
    return {
      liveCount: stats.liveCount,
      wins: stats.wins,
      grossProfit: round6(stats.grossProfit),
      gasBurned: round6(stats.gasBurned),
      netPnl: round6(stats.grossProfit - stats.gasBurned),
      live24h,
      wins24h,
      net24h: round6(gross24h - gas24h),
      solLiveCount: stats.solLiveCount,
      solWins: stats.solWins,
      solGrossProfit: round6(stats.solGrossProfit),
      solGasBurned: round6(stats.solGasBurned),
      solNetPnl: round6(stats.solGrossProfit - stats.solGasBurned),
      solLive24h,
      solWins24h,
      solNet24h: round6(solGross24h - solGas24h),
      simCount: stats.simCount,
      simWins: stats.simWins,
      simNet: round6(stats.simNet),
    };
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create the user's terminal state document on first use (idempotent) and
 * backfill any strategy/network/payout fields that older documents predate.
 */
export const ensureTerminalState = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const existing = await getState(ctx, user._id);
    if (!existing) {
      return await ctx.db.insert("terminalStates", {
        userId: user._id,
        ...DEFAULT_TERMINAL_STATE,
        lastScanAt: now,
        scanDate: todayStr(),
      });
    }
    // Backfill ONLY fields this document predates — never clobber values the
    // operator already saved (e.g. a tuned maxLoan).
    const doc = existing as unknown as Record<string, unknown>;
    const backfill: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(NEW_FIELD_BACKFILL)) {
      if (doc[key] === undefined) backfill[key] = value;
    }
    // One-time balancer migration: accounts created before the balancer
    // became the default get the low-fee-first rotation flipped ON exactly
    // once — explicit operator choices afterwards are never overridden.
    if (doc.lenderBalancerAutoOn === undefined) {
      backfill.lenderBalancer = true;
      backfill.lenderBalancerAutoOn = true;
    }
    // One-time stale-whitelist migration: accounts whose BSC whitelist still
    // EXACTLY equals the legacy default were never customized — refresh them
    // to the current registry so the deepest/lowest-fee venues (PCS_V3,
    // OPENOCEAN, KYBERSWAP) are scanned. Explicit operator selections are
    // never touched. Idempotent via the one-time flag.
    if (doc.bscWhitelistAutoSync === undefined) {
      if (sameWhitelist(doc.dexWhitelist, LEGACY_BSC_WHITELIST)) {
        backfill.dexWhitelist = [...BSC_DEX_KEYS];
      }
      const perChain = (doc.dexWhitelists ?? {}) as Record<string, unknown>;
      const bscList = perChain.bsc;
      if (bscList === undefined || sameWhitelist(bscList, LEGACY_BSC_WHITELIST)) {
        backfill.dexWhitelists = { ...perChain, bsc: [...BSC_DEX_KEYS] };
      }
      backfill.bscWhitelistAutoSync = true;
    }
    await ctx.db.patch(existing._id, {
      ...backfill,
      lastScanAt: now,
    });
    return await getState(ctx, user._id);
  },
});

/**
 * Advance the scan loop: bump the daily scan counter. When the real feed
 * passes a route count, openOpportunities is synced to it — otherwise the
 * value is left untouched (never fabricated with random numbers).
 *
 * PER CHAIN: `chain: "sol"` stamps the SOL engine's own freshness fields
 * (solLastScanAt / solLastScanSource) and releases the SOL lease; the BNB
 * fields are left untouched, so a browser tab sitting on the SOL terminal
 * can never stand down (or fork) the BNB loop — and vice versa. Default
 * "bnb" preserves the classic single-engine behavior.
 */
export const bumpScan = mutation({
  args: { count: v.optional(v.number()), chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))) },
  handler: async (ctx, { count, chain }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    const now = Date.now();
    const date = todayStr();
    const scansToday = state.scanDate === date ? state.scansToday + 1 : 1;
    const patch: Record<string, unknown> = {
      scansToday,
      scanDate: date,
    };
    if (chain === "sol") {
      // The browser SOL loop is the driver whenever it scans; its freshness
      // also stands the server SOL engine down, so its lease is released.
      patch.solLastScanAt = now;
      patch.solLastScanSource = "client" as const;
      patch.solEngineLoopToken = undefined;
    } else {
      patch.lastScanAt = now;
      // The browser loop is the driver whenever it scans; its freshness also
      // stands the server engine down, so its lease is released.
      patch.lastScanSource = "client" as const;
      patch.engineLoopToken = undefined;
    }
    if (typeof count === "number") {
      patch.openOpportunities = Math.max(0, Math.round(count));
    }
    await ctx.db.patch(state._id, patch);
    return true;
  },
});

/**
 * Record an execution (or a blocked/below-floor attempt). On success with
 * auto-payout enabled the profit is immediately paid out: to the paper
 * account balance in paper mode, or swept to the wallet in live mode.
 */
/**
 * Shared execution core — used by BOTH execution surfaces:
 *   • the web Scanner (recordExecution below — user session identity), and
 *   • the server-side autonomous engine (serverAutoExecution — CLI/scheduler
 *     identity, resolves the operator account directly).
 * Same ledger math, same notifications, same Telegram fanout — one source of
 * truth, so a route recorded offline is indistinguishable from one recorded
 * with the app open.
 */
async function applyExecution(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    label: string;
    profitPct: number;
    amountBnb: number;
    status: "success" | "blocked" | "below_floor" | "failed";
    lender?: string;
    dexes?: string;
    payoutBnb?: number;
    network?: string;
    txHash?: string;
    chainId?: number;
    gasUsedBnb?: number;
    /** REAL measured signing latency (ms) from the production executor. */
    signingLatencyMs?: number;
    relay?: string;
    chain?: string;
    nativeSymbol?: string;
    method?: string;
  },
): Promise<boolean> {
  const state = await getState(ctx, user._id);
  if (!state) return false;

  const now = Date.now();
  const date = todayStr();
  const isNewDay = state.scanDate !== date;
  const executionsToday = isNewDay ? 0 : state.executionsToday;
  const successesToday = isNewDay ? 0 : state.successesToday;

  const isSuccess = args.status === "success";
  const nextExecutionsToday = executionsToday + 1;
  const nextSuccessesToday = successesToday + (isSuccess ? 1 : 0);
  const successRate = Math.round(
    (nextSuccessesToday / nextExecutionsToday) * 100,
  );

  const isPaper = state.mode === "paper";
  const payout = isSuccess && state.autoPayout ? Math.max(0, args.payoutBnb ?? args.amountBnb) : 0;
  const credited = isSuccess && isPaper ? args.amountBnb : 0;

  await ctx.db.patch(state._id, {
    balance: Math.round((state.balance + credited) * 1e6) / 1e6,
    lifetimePnl:
      Math.round((state.lifetimePnl + (isSuccess ? args.amountBnb : 0)) * 1e6) / 1e6,
    executionsToday: nextExecutionsToday,
    successesToday: nextSuccessesToday,
    successRate,
    openOpportunities: Math.max(0, state.openOpportunities - 1),
    payoutsTotal:
      payout > 0
        ? Math.round((state.payoutsTotal + payout) * 1e6) / 1e6
        : state.payoutsTotal,
    payoutsCount: payout > 0 ? state.payoutsCount + 1 : state.payoutsCount,
    lastPayoutAt: payout > 0 ? now : state.lastPayoutAt,
    scanDate: date,
  });

  await ctx.db.insert("executions", {
    userId: user._id,
    label: args.label,
    profitPct: args.profitPct,
    amountBnb: args.amountBnb,
    status: args.status as ExecutionStatus,
    ts: now,
    lender: args.lender,
    dexes: args.dexes,
    payoutBnb: payout > 0 ? payout : undefined,
    network: args.network ?? state.network,
    txHash: args.txHash,
    chainId: args.chainId,
    relay: args.relay,
    gasUsedBnb: args.gasUsedBnb,
    signingLatencyMs: args.signingLatencyMs,
    chain: args.chain ?? state.chainKey,
    method: args.method,
  });

  // MATERIALIZED PnL — fold this row into the pnlStats doc IMMEDIATELY, so
  // the subscribed pnlSummary reads one small doc instead of rescanning the
  // entire executions table (16k+ rows ≈ 6 MB) on this write.
  await bumpPnlStats(ctx, user._id, {
    txHash: args.txHash,
    status: args.status,
    amountBnb: args.amountBnb,
    gasUsedBnb: args.gasUsedBnb,
    chain: args.chain ?? state.chainKey,
  });

  // Ping the notification center with the real execution event. The title
  // uses the row's real native unit (SOL FlashBolt passes "SOL"), so a
  // SOL snipe never shows up as "BNB" in the bell.
  const notifSymbol = args.nativeSymbol ?? NATIVE_SYMBOL[args.chain ?? state.chainKey] ?? "BNB";
  const statusTitle: Record<ExecutionStatus, string> = {
    success: `Executed +${args.amountBnb.toFixed(4)} ${notifSymbol}`,
    blocked: "MEV guard blocked a route",
    below_floor: "Route below the profit floor",
    failed: "On-chain transaction reverted",
  };
  await ctx.db.insert("notifications", {
    userId: user._id,
    kind: "execution",
    title: statusTitle[args.status as ExecutionStatus],
    body: [args.label, args.lender ? `lender ${args.lender}` : null, args.txHash ? `tx ${args.txHash.slice(0, 10)}…` : null]
      .filter(Boolean)
      .join(" · "),
    ts: now,
    read: false,
    // Chain attribution for the bell: the originating terminal chain
    // ("solana" rows land in the same feed, visibly tagged).
    chainKey: args.chain ?? state.chainKey,
  });

  // Telegram carries ONLY flash-loan trades + earnings (operator and
  // subscriber accounts alike). The alert is scheduled after commit so a
  // channel hiccup can never fail the trade record itself.
  if (isSuccess) {
    try {
      const role = await accountRole(ctx, user.email);
      // An execution can override the native unit (SOL FlashBolt passes
      // "SOL") — otherwise it is derived from the terminal's chain.
      const symbol = args.nativeSymbol ?? NATIVE_SYMBOL[state.chainKey] ?? "BNB";
      const earnings = payout > 0 ? payout : args.amountBnb;
      const { title, body } = buildTradeAlert({
        role,
        amountBnb: args.amountBnb,
        symbol,
        label: args.label,
        lender: args.lender,
        profitPct: args.profitPct,
        network: args.network ?? state.network,
        earnings,
        txHash: args.txHash,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.telegramTradeAlert,
        { title, body },
      );
      // Telegram Operator Bot — mirror the same successful trade to every
      // paired operator chat (fanout no-ops when disabled or none linked).
      await ctx.scheduler.runAfter(
        0,
        internal.telegramBot.fanoutTradeAlert,
        {
          role,
          amountBnb: args.amountBnb,
          symbol,
          label: args.label,
          lender: args.lender,
          profitPct: args.profitPct,
          network: args.network ?? state.network,
          earnings,
          txHash: args.txHash,
          // Live ledger taxonomy applied uniformly: ⛓ LIVE = real on-chain
          // txHash; 🧪 SIM = no txHash (paper) — SIM alerts fan out silent.
          sim: !args.txHash,
        },
      );
    } catch {
      // Never block the trade on an external channel.
    }
  }
  return true;
}

export const recordExecution = mutation({
  args: {
    label: v.string(),
    profitPct: v.number(),
    amountBnb: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("blocked"),
      v.literal("below_floor"),
      v.literal("failed"),
    ),
    lender: v.optional(v.string()),
    dexes: v.optional(v.string()),
    payoutBnb: v.optional(v.number()),
    network: v.optional(v.string()),
    txHash: v.optional(v.string()),
    chainId: v.optional(v.number()),
    gasUsedBnb: v.optional(v.number()),
    /** REAL measured signing latency (ms) — undefined when the extension signed. */
    signingLatencyMs: v.optional(v.number()),
    /** Private relay that carried the broadcast (undefined = public RPC path). */
    relay: v.optional(v.string()),
    /** Originating terminal chain — lets each terminal read its own trail. */
    chain: v.optional(v.string()),
    /** Native unit label for honest cross-terminal alerts ("BNB" / "SOL"). */
    nativeSymbol: v.optional(v.string()),
    /** How the edge was found ("triangular" | "cross-chain" | "statistical"). */
    method: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return applyExecution(ctx, user, args);
  },
});

/**
 * Server-side execution recorder — the autonomous engine's ledger write.
 * Same applyExecution core as the web path, but resolves the OPERATOR account
 * directly (scheduler/CLI has no user session). Stamps origin="server" for
 * honest attribution in the audit trail.
 */
/**
 * Very recent operator execution labels (server-engine dedupe window). The
 * autonomous engine uses this to never re-execute a route the browser (or a
 * previous engine pass) already recorded in the last minute.
 */
export const botRecentExecutionLabels = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ label: string; ts: number }>> => {
    const state = await operatorStateDoc(ctx);
    if (!state) return [];
    // BUDGET (DB I/O): every caller only dedupes against the last 60 s
    // ("now - r.ts < 60_000") — read exactly that window through the
    // by_user_ts index (typically a handful of rows) instead of the newest
    // 24 rows of the user's ENTIRE history on every engine pass.
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_user_ts", (q) =>
        q.eq("userId", state.userId).gte("ts", Date.now() - 60_000),
      )
      .take(40);
    return rows.map((r) => ({ label: r.label, ts: r.ts }));
  },
});

// ---------------------------------------------------------------------------
// SERVER-SIDE AUTONOMOUS ENGINE — the bot stays operational with the app
// closed. The browser scan loop only runs while a terminal page is open; this
// engine mirrors it on the server so a bot started from Telegram keeps
// scanning (and paper-executing) around the clock.
//
// SINGLE-DRIVER RULE (no double scanning, no double executing):
//   • The browser loop stamps lastScanAt on every pass.
//   • Every engine pass first checks freshness: if lastScanAt is within the
//     online window, SOMEONE is already driving (the app is open — or a
//     previous engine pass just ran) and this pass exits WITHOUT
//     rescheduling. Exactly one driver at a time.
//   • The self-rescheduling loop keeps the engine alive while botRunning;
//     the heartbeat cron (engine-heartbeat, every minute) is the RECOVERY
//     path that resurrects the loop if a deployment restart ever killed it.
//   • Executions are additionally deduped against the shared 60s label
//     window, so even a transition overlap can never double-execute.
//
// FAITHFUL MIRROR of the web scanner's paper path: same computeRoutes /
// generateWBNBRoutes engines, same persisted settings (floor, MEV guard,
// DEX whitelist, hops, max loan), same guard order (profit guard → MEV
// guard), same ledger writes (applyExecution), same ⛓/🧪 taxonomy (paper
// rows have no txHash ⇒ SIM, fanout silent). LIVE mode deliberately does
// NOT auto-execute server-side: signing requires the browser wallet session
// (keys never leave the browser) — live keeps scanning and alerting.
// ---------------------------------------------------------------------------

/** Client considered online while its last scan is newer than this. */
// 300 s (was 90 s): matches the heartbeat's */5 cadence, so a browser tab
// whose timers are throttled (background tabs fire intervals at ~1/min)
// still counts as "online" and keeps the server loop stood down — fewer
// competing passes — while a closed app is reclaimed by the next heartbeat
// at worst two ticks later (~10 min), an acceptable cold-start for an
// always-on engine that the heartbeat explicitly resurrects.
const ENGINE_ONLINE_WINDOW_MS = 300_000;
/** Engine self-reschedule delay (well under the online window). */
// 180 s (was 45 s): every pass re-reads/re-writes engine state AND pulls a
// fresh signal window, and the 4 loops (BNB+SOL × scan/snipe) at 45 s meant
// ~7.7k passes/day ≈ 23k function calls/day plus hundreds of MB of DB I/O —
// by far the largest consumer of the 30k-calls/day and 30MB/day budgets.
// 180 s cuts loop volume ~75% (≈1.9k passes/day ≈ 6-8k calls/day) while
// staying comfortably inside ENGINE_ONLINE_WINDOW_MS (300 s), so the
// freshness/single-driver rule and the 5-minute heartbeat resurrection
// behave exactly as before. Sniper latency stays sane because the copier
// poller itself only refreshes candidates every 3 minutes.
const ENGINE_KICK_DELAY_MS = 180_000;
/** Max paper executions per engine pass (guard-rails a hot market). */
const ENGINE_MAX_EXEC_PER_PASS = 2;

export const scanPass = internalAction({
  // loopToken: the caller's lease. The heartbeat cron and /on commands start
  // a loop WITHOUT a token — that mints a NEW lease (proving via the
  // freshness rule that no live loop exists). A self-rescheduling pass
  // passes ITS OWN token and continues only while the stored lease still
  // matches — so a superseded loop dies after its current pass, no matter
  // how many overlapping starts ever occur. Single driver, guaranteed.
  args: {
    loopToken: v.optional(v.string()),
    chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))),
  },
  handler: async (ctx, { loopToken, chain }): Promise<{
    ran: boolean;
    reason?:
      | "app-online"
      | "not-running"
      | "no-state"
      | "loop-alive"
      | "lease-superseded";
    live?: number;
    generated?: number;
    executed?: number;
  }> => {
    const isSol = chain === "sol";
    const now = Date.now();
    const state = await ctx.runQuery(internal.terminal.botGetState, {});
    if (!state) return { ran: false, reason: "no-state" };
    // PER-BOT GATE — each engine answers to its OWN switch. Stopping the SOL
    // bot never pauses the BNB engine and stopping BNB never pauses SOL.
    const engineOn = isSol ? state.solBotRunning !== false : state.botRunning;
    if (!engineOn) return { ran: false, reason: "not-running" };

    const onlineWindow = Math.max(
      ENGINE_ONLINE_WINDOW_MS,
      (state.cadence ?? 15) * 1000 * 2,
    );
    // Per-chain freshness: each engine judges "someone is already driving"
    // on its OWN stamps — the BNB loop's activity never stands the SOL loop
    // down (and vice versa).
    const lastScanAt = isSol ? (state.solLastScanAt ?? 0) : state.lastScanAt;
    const lastScanSource = isSol
      ? (state.solLastScanSource ?? null)
      : (state.lastScanSource ?? null);
    const fresh = now - lastScanAt < onlineWindow;

    // A continuation (has a token) that no longer holds the lease dies here.
    if (loopToken !== undefined && loopToken !== null) {
      const held = isSol ? state.solEngineLoopToken : state.engineLoopToken;
      if (held !== loopToken) {
        return { ran: false, reason: "lease-superseded" };
      }
    }

    // SINGLE-DRIVER RULE — decide from WHO scanned last, not only when:
    //   • fresh + client source  → the app is open and driving: stand down.
    //   • fresh + server source  → a loop is alive: only a NEW-LEASE start
    //     is refused (a matching-lease continuation already passed above).
    //   • stale                  → nobody is driving: take over.
    const clientDriving = fresh && lastScanSource === "client";
    const loopAlive =
      fresh && lastScanSource === "server" && loopToken === undefined;
    if (clientDriving) return { ran: false, reason: "app-online" };
    if (loopAlive) return { ran: false, reason: "loop-alive" };

    // Mint THIS loop's lease (continuations reuse their existing token).
    const lease =
      loopToken ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    // BACKGROUND CONTINUITY — whatever happens below (a market API hiccup, a
    // serialization edge), the loop ALWAYS reschedules itself while
    // botRunning. A single thrown pass must never silently kill the
    // always-on engine: the next pass retries fresh and the freshness guard
    // still guarantees a single driver.
    let scan = { live: 0, generated: 0, executed: 0 };
    let passThrew: unknown = null;
    try {
      scan = await runScanBody(ctx, state, now, lease, chain);
    } catch {
      // Swallow the pass failure but keep the lease registered (so this
      // loop's continuation still matches and the freshness guard shows a
      // fresh server stamp), then ALWAYS reschedule below.
      passThrew = true;
      await ctx.runMutation(internal.terminal.botBumpScan, {
        loopToken: lease,
        chain,
      });
    }

    // Keep the loop alive — the continuation carries THIS loop's lease; any
    // overlapping heartbeat probe exits on the fresh server stamp, and a
    // newer start supersedes this lease so it dies after this pass.
    await ctx.scheduler.runAfter(
      ENGINE_KICK_DELAY_MS,
      internal.terminal.scanPass,
      { loopToken: lease, chain },
    );
    if (passThrew !== null) {
      return { ran: false, reason: "loop-alive" as const, ...scan };
    }
    return {
      ran: true,
      live: scan.live,
      generated: scan.generated,
      executed: scan.executed,
    };
  },
});

/**
 * Engine heartbeat — the cron's recovery kick for ALL FOUR engines: the BNB
 * and SOL scan loops (terminal.scanPass) and the BNB and SOL sniper loops
 * (terminal.snipePass). Each chain answers to its own bot switch, freshness
 * stamp and lease (see each pass), so a kick can never double-drive an alive
 * loop and stopping one bot never affects the others. The kicks run in
 * parallel; one engine's failure never blocks the others' rescan.
 */
export const engineHeartbeat = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    bnb: unknown;
    sol: unknown;
    snBnb: unknown;
    snSol: unknown;
  }> => {
    const [bnb, sol, snBnb, snSol] = await Promise.allSettled([
      ctx.runAction(internal.terminal.scanPass, { chain: "bnb" }),
      ctx.runAction(internal.terminal.scanPass, { chain: "sol" }),
      ctx.runAction(internal.terminal.snipePass, { chain: "bnb" }),
      ctx.runAction(internal.terminal.snipePass, { chain: "sol" }),
    ]);
    return {
      bnb: bnb.status === "fulfilled" ? bnb.value : { ran: false, reason: "error" },
      sol: sol.status === "fulfilled" ? sol.value : { ran: false, reason: "error" },
      snBnb: snBnb.status === "fulfilled" ? snBnb.value : { ran: false, reason: "error" },
      snSol: snSol.status === "fulfilled" ? snSol.value : { ran: false, reason: "error" },
    };
  },
});

/**
 * SOL engine pass — the server-side rescan of the SOL FlashBolt live route
 * feed, identical to what the browser loop does with the app open:
 *   1. pull fresh copied signals (copierSignals — refilled every 2 min by
 *      the copier poller),
 *   2. sweep the live Solana market board (lib/solana-feed.ts,
 *      fetchWithTimeout-based so it runs in actions),
 *   3. merge both boards (deduped by mint) and build real cross-venue
 *      WSOL routes via buildSolTelecopierRoutes — the exact engine the
 *      SOL Scanner consumes; no signals, no fabricated routes.
 *   4. paper mode: auto-execute profitable routes through the SAME guard
 *      stack as the browser (daily target, profit floor, MEV shield,
 *      60s label dedupe), recorded with chain:"solana"/nativeSymbol:"SOL".
 * Live mode keeps scanning/alerting only — signing needs the browser wallet
 * session. Always stamps per-chain bookkeeping (botBumpScan, chain:"sol").
 */
async function runSolScanBody(
  ctx: { runQuery: ActionCtx["runQuery"]; runMutation: ActionCtx["runMutation"] },
  state: Doc<"terminalStates">,
  now: number,
  lease: string,
): Promise<{ live: number; generated: number; executed: number }> {
  const { buildSolTelecopierRoutes } = await import("../lib/solana-routes");
  const { sweepSolMarket, mergeSolCandidates } = await import("../lib/solana-feed");
  const { SOL_DEFAULT_WHITELIST } = await import("../lib/solana");
  const { SOL_MAX_LOAN_CAP, SOL_MIN_LOAN } = await import("../lib/flashbolt");
  const { solLenderForRun } = await import("../lib/solana");

  // Live inputs: fresh copied signals + the current market sweep. A sweep
  // hiccup never kills the pass — the signals board still scans alone.
  // BUDGET (DB I/O): engine-fresh window (45 min — see
  // listRecentSignalsForEngine) instead of the 6-hour public feed: only
  // rows inside the window are read, no matter how large the table is.
  const signals = (await ctx.runQuery(
    internal.copierStore.listRecentSignalsForEngine,
    {},
  )) as unknown as Parameters<typeof buildSolTelecopierRoutes>[0];
  let swept: Awaited<ReturnType<typeof sweepSolMarket>> = [];
  try {
    swept = await sweepSolMarket();
  } catch {
    swept = [];
  }

  // Strategy mirror of the SOL terminal: per-chain venue whitelist, loan
  // size from maxLoan (same clamp the browser uses), balancer lender.
  const whitelist =
    (state.dexWhitelists?.solana?.length ?? 0) > 0
      ? (state.dexWhitelists?.solana as string[])
      : SOL_DEFAULT_WHITELIST;
  const run = Math.floor(now / 1000);
  const routes = await buildSolTelecopierRoutes(
    mergeSolCandidates(signals, swept),
    {
      dexWhitelist: whitelist,
      lender: solLenderForRun(run, state.lenderBalancer),
      loanSizeSol: Math.min(
        SOL_MAX_LOAN_CAP,
        Math.max(SOL_MIN_LOAN, (state.maxLoan ?? 5) / 2),
      ),
      run,
    },
    8,
  );

  // Shared dedupe window — routes recorded by the browser (either terminal)
  // or an overlapping engine pass in the last minute are never re-executed.
  const recentRows = await ctx.runQuery(internal.terminal.botRecentExecutionLabels, {});
  const recentSet = new Set(
    recentRows.filter((r) => now - r.ts < 60_000).map((r) => r.label),
  );

  // Paper-only autonomous execution — live mode keeps scanning/alerting
  // but signing needs the browser wallet session.
  let executed = 0;
  const floor = state.minProfit;
  if (state.mode === "paper") {
    const dailyTarget = state.dailyArbTarget ?? 0;
    const dailyReached = dailyTarget > 0 && state.executionsToday >= dailyTarget;
    if (!dailyReached) {
      for (const r of routes) {
        if (executed >= ENGINE_MAX_EXEC_PER_PASS) break;
        if (r.profitPct <= 0 || r.profitPct < floor) continue;
        const label = r.legs.join(" -> ");
        if (recentSet.has(label)) continue;
        recentSet.add(label);

        // MEV guard — same static shield as the BNB pass (copied Telegram
        // tokens rate medium; the route carries mevRisk 45, below the shield).
        const blocked = state.mevGuard && r.mevRisk >= 70;
        // Paper credit mirrors the browser: profit % of the SOL loan.
        const credit =
          Math.round(((r.loanSizeSol ?? r.loanSizeBnb) * r.profitPct) / 100 * 1e6) / 1e6;
        await ctx.runMutation(internal.terminal.serverAutoExecution, {
          label,
          profitPct: r.profitPct,
          amountBnb: blocked ? 0 : credit,
          status: blocked ? "blocked" : "success",
          lender: r.lender,
          dexes: r.dexes.join("+"),
          chain: "solana",
          nativeSymbol: "SOL",
          method: "cross-venue",
          ...(blocked ? {} : { payoutBnb: credit }),
        });
        executed += 1;
      }
    }
  }

  await ctx.runMutation(internal.terminal.botBumpScan, {
    opportunities: routes.length,
    loopToken: lease,
    chain: "sol",
  });

  return { live: routes.length, generated: 0, executed };
}

/**
 * One engine pass's real work — extracted so scanPass can guarantee its own
 * rescheduling even when this body throws (a market API hiccup must never
 * kill the always-on background loop). Stamps the scan bookkeeping + lease
 * on success; the caller handles the failure path. chain routes the scan
 * bookkeeping to the right engine's stamps (BNB/SOL independence).
 *
 * PER CHAIN: "bnb" rescans the BNB FlashBolt live route feed (BSC market
 * snapshot to triangular routes); "sol" rescans the SOL FlashBolt live route
 * feed (real Solana market sweep + copied signals to cross-venue routes) via
 * runSolScanBody below. Two independent engines, one always-on loop each.
 */
async function runScanBody(
  ctx: { runQuery: ActionCtx["runQuery"]; runMutation: ActionCtx["runMutation"] },
  state: Doc<"terminalStates">,
  now: number,
  lease: string,
  chain: "bnb" | "sol" | undefined,
): Promise<{ live: number; generated: number; executed: number }> {
  if (chain === "sol") return runSolScanBody(ctx, state, now, lease);
  const { computeRoutes, DEFAULT_FEED_SETTINGS, routeProfitBnb } = await import("../lib/flashbolt");
  const { generateWBNBRoutes, toFlashRoute } = await import("../lib/route-generator");

  const snapshot = await fetchMarketSnapshot("bsc");

    const settings = {
      ...DEFAULT_FEED_SETTINGS,
      dexWhitelist:
        state.dexWhitelist.length > 0
          ? state.dexWhitelist
          : DEFAULT_FEED_SETTINGS.dexWhitelist,
      minProfit: state.minProfit,
      maxHops: (state.maxHops === 2 ? 2 : 3) as 2 | 3,
      mevGuard: state.mevGuard,
      maxLoan: state.maxLoan,
    };
    const run = Math.floor(now / 1000);
    const live = computeRoutes(snapshot, settings, run, 8, false, null);
    const generated = generateWBNBRoutes(snapshot, settings, run, null, 60);
    const floor = state.minProfit;

    // Shared dedupe window — routes recorded by the browser in the last
    // minute (or by an overlapping engine pass) are never re-executed.
    const recentRows = await ctx.runQuery(internal.terminal.botRecentExecutionLabels, {});
    const recentSet = new Set(
      recentRows.filter((r) => now - r.ts < 60_000).map((r) => r.label),
    );

    // Scan bookkeeping happens on every pass (drives the same dashboard
    // counters the client loop bumps).
    const opportunities =
      live.length + generated.filter((g) => g.isProfitable).length;

    // Paper-only autonomous execution — live mode keeps scanning/alerting
    // but signing needs the browser wallet session.
    let executed = 0;
    if (state.mode === "paper" && !recentSet.size) {
      // no-op — kept for clarity
    }
    if (state.mode === "paper") {
      const dailyTarget = state.dailyArbTarget ?? 0;
      const dailyReached = dailyTarget > 0 && state.executionsToday >= dailyTarget;
      if (!dailyReached) {
        for (const g of generated) {
          if (executed >= ENGINE_MAX_EXEC_PER_PASS) break;
          if (!g.isProfitable || g.netProfitPct < floor) continue;
          const fr = toFlashRoute(g, run);
          const label = fr.legs.join(" → ");
          if (recentSet.has(label)) continue;
          recentSet.add(label);

          // MEV guard — same enforcement as the scanner: static shield at
          // mevRisk >= 70, refined by the NLP pass when available.
          let allow = true;
          if (state.mevGuard && fr.mevRisk >= 70) {
            allow = false;
            try {
              const { analyzeMevPass, nlpAwareGuardDecision } = await import("../lib/nlp-mev-analyzer");
              const analysis = analyzeMevPass(
                fr,
                { pendingSwaps: 0, congestion: 0 },
                null,
              );
              allow = nlpAwareGuardDecision(fr, true, analysis).allow;
            } catch {
              // NLP layer unavailable server-side — static shield holds.
              allow = false;
            }
          }

          if (!allow) {
            await ctx.runMutation(internal.terminal.serverAutoExecution, {
              label,
              profitPct: fr.profitPct,
              amountBnb: 0,
              status: "blocked",
              lender: fr.lender,
              dexes: fr.dexes.join(" → "),
              network: state.network,
              method: "triangular",
            });
            executed += 1;
            continue;
          }

          await ctx.runMutation(internal.terminal.serverAutoExecution, {
            label,
            profitPct: fr.profitPct,
            amountBnb: routeProfitBnb(fr),
            status: "success",
            lender: fr.lender,
            dexes: fr.dexes.join(" → "),
            payoutBnb: routeProfitBnb(fr),
            network: state.network,
            method: "triangular",
          });
          executed += 1;
        }
      }
    }

  await ctx.runMutation(internal.terminal.botBumpScan, {
    opportunities,
    loopToken: lease,
    chain,
  });

  return { live: live.length, generated: generated.length, executed };
}

/**
 * SERVER-SIDE SNIPER ENGINES — the BNB sniper and the SOL sniper keep
 * sniping 24/7 with the app closed, mirroring the scan engines above.
 * Same single-driver rule: own per-chain switch, own freshness stamps
 * (bSn* / sSn*), own lease — a sniper loop never stands its scanner down
 * (and vice versa), and BNB never touches SOL. The browsers' guard stack is
 * mirrored in the same order: liquidity floor, momentum gate, daily target,
 * 60s label dedupe, per-pass cap. Paper fills record through applyExecution
 * with honest chain attribution; LIVE mode keeps discovering and alerting
 * only (signing needs the browser wallet session).
 */
export const snipePass = internalAction({
  args: {
    loopToken: v.optional(v.string()),
    chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))),
  },
  handler: async (ctx, { loopToken, chain }): Promise<{
    ran: boolean;
    reason?: "app-online" | "not-running" | "no-state" | "loop-alive" | "lease-superseded";
    candidates?: number;
    sniped?: number;
  }> => {
    const isSol = chain === "sol";
    const now = Date.now();
    const state = await ctx.runQuery(internal.terminal.botGetState, {});
    if (!state) return { ran: false, reason: "no-state" };
    // The sniper answers to the SAME per-chain switch as its chain's bot.
    const engineOn = isSol ? state.solBotRunning !== false : state.botRunning;
    if (!engineOn) return { ran: false, reason: "not-running" };
    // Sniper stamps are independent of the scan stamps (single driver per
    // SUBSYSTEM, so the two loops on a chain never disrupt each other).
    const lastScanAt = isSol ? (state.sSnLastScanAt ?? 0) : (state.bSnLastScanAt ?? 0);
    const lastScanSource = isSol
      ? (state.sSnLastScanSource ?? null)
      : (state.bSnLastScanSource ?? null);
    const fresh = now - lastScanAt < ENGINE_ONLINE_WINDOW_MS;
    if (loopToken !== undefined && loopToken !== null) {
      const held = isSol ? state.sSnLoopToken : state.bSnLoopToken;
      if (held !== loopToken) return { ran: false, reason: "lease-superseded" };
    }
    const clientDriving = fresh && lastScanSource === "client";
    const loopAlive = fresh && lastScanSource === "server" && loopToken === undefined;
    if (clientDriving) return { ran: false, reason: "app-online" };
    if (loopAlive) return { ran: false, reason: "loop-alive" };
    const lease =
      loopToken ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    // BACKGROUND CONTINUITY — always reschedule while the bot is ON, even
    // when a pass throws (a feed hiccup must never kill the sniper).
    let result = { candidates: 0, sniped: 0 };
    let passThrew = false;
    try {
      result = isSol
        ? await runSolSnipeBody(ctx, state, now, lease)
        : await runBnbSnipeBody(ctx, state, now, lease);
    } catch {
      passThrew = true;
      await ctx.runMutation(internal.terminal.botBumpScan, {
        loopToken: lease,
        chain,
        subsystem: "snipe",
      });
    }
    await ctx.scheduler.runAfter(ENGINE_KICK_DELAY_MS, internal.terminal.snipePass, {
      loopToken: lease,
      chain,
    });
    if (passThrew) return { ran: false, reason: "loop-alive" as const, ...result };
    return { ran: true, candidates: result.candidates, sniped: result.sniped };
  },
});

/**
 * BNB sniper engine pass — mirrors the browser MultiSignalMonitor auto path:
 * the real multi-source discovery board (copier signals + DexScreener sweep),
 * the agent-ensemble gate, and the guarded paper snipe.
 */
async function runBnbSnipeBody(
  ctx: { runQuery: ActionCtx["runQuery"]; runMutation: ActionCtx["runMutation"] },
  state: Doc<"terminalStates">,
  now: number,
  lease: string,
): Promise<{ candidates: number; sniped: number }> {
  const { sweepSnipeMarket, mergeSnipeBoard, evaluateSnipeCandidate } = await import("../lib/sniper-feed");
  const { scoreLiveTokenSignal } = await import("../lib/ai-agent-determinants");

  const signals = (await ctx.runQuery(
    internal.copierStore.listRecentSignalsForEngine,
    {},
  )) as unknown as Array<{
    address: string;
    symbol: string;
    priceUsd: number;
    liquidityUsd: number;
    postedAt: number;
    capturedAt: number;
  }>;
  // The BNB board takes EVM-shaped addresses (0x…); solana mints belong to
  // the SOL sniper. Copier signals carry the same chain tags the terminals read.
  const evmSignals = (signals ?? []).filter((s) => s.address && s.address.startsWith("0x"));
  let swept: Awaited<ReturnType<typeof sweepSnipeMarket>> = [];
  try {
    swept = await sweepSnipeMarket("bnb");
  } catch {
    swept = [];
  }
  const board = mergeSnipeBoard("bnb", evmSignals, swept);

  // Shared dedupe window — a token the browser (or an overlapping pass)
  // already executed in the last minute is never re-sniped.
  const recentRows = await ctx.runQuery(internal.terminal.botRecentExecutionLabels, {});
  const recentSet = new Set(
    recentRows.filter((r) => now - r.ts < 60_000).map((r) => r.label),
  );

  let sniped = 0;
  if (state.mode === "paper") {
    const dailyTarget = state.dailyArbTarget ?? 0;
    const dailyReached = dailyTarget > 0 && state.executionsToday >= dailyTarget;
    if (!dailyReached) {
      for (const c of board) {
        if (sniped >= ENGINE_MAX_EXEC_PER_PASS) break;
        // Agent-ensemble gate — the same scorer the browser monitor uses to
        // auto-approve; the snipe floor is a consensus >= 55 on a fresh cap.
        const freshListing = now - (c.postedAt || c.capturedAt) < 10 * 60_000;
        const vote = scoreLiveTokenSignal({
          liquidityUsd: c.liquidityUsd,
          volume24h: 0,
          priceChange1h: freshListing ? 6 : 0,
          priceChange24h: freshListing ? 6 : 0,
          buyVolume: 60,
          sellVolume: 40,
          securityScore: 50,
        });
        if ((vote.consensus ?? 0) < 55) continue;
        const gate = evaluateSnipeCandidate(
          { liquidityUsd: c.liquidityUsd, priceUsd: c.priceUsd, capturedAt: c.capturedAt },
          { minLiquidityUsd: 5_000, minProfitPct: state.minProfit, now },
        );
        if (!gate.allowed) continue;
        const label = `SNIPE ${c.symbol} (${c.address.slice(0, 6)}…${c.address.slice(-4)})`;
        if (recentSet.has(label)) continue;
        recentSet.add(label);
        // Paper fill mirrors the browser snipers: +1.5% of the buy clip
        // (the BNB sniper's 0.01 BNB default), recorded in BNB.
        const credit = Math.round((0.01 * gate.fillPct) / 100 * 1e6) / 1e6;
        await ctx.runMutation(internal.terminal.serverAutoExecution, {
          label,
          profitPct: gate.fillPct,
          amountBnb: credit,
          status: "success",
          lender: "PancakeSwap routing",
          dexes: "PCS",
          chain: "bsc",
          nativeSymbol: "BNB",
          method: "snipe",
          payoutBnb: credit,
        });
        sniped += 1;
      }
    }
  }

  await ctx.runMutation(internal.terminal.botBumpScan, {
    opportunities: board.length,
    loopToken: lease,
    chain: "bnb",
    subsystem: "snipe",
  });
  return { candidates: board.length, sniped };
}

/**
 * SOL sniper engine pass — mirrors the browser SolSniper auto path: fresh
 * copier signals + the live market sweep, the operator's $ liquidity floor
 * and the +1.5% paper fill (solBuyAmountSol clip), recorded as "solana".
 */
async function runSolSnipeBody(
  ctx: { runQuery: ActionCtx["runQuery"]; runMutation: ActionCtx["runMutation"] },
  state: Doc<"terminalStates">,
  now: number,
  lease: string,
): Promise<{ candidates: number; sniped: number }> {
  const { sweepSnipeMarket, mergeSnipeBoard, evaluateSnipeCandidate } = await import("../lib/sniper-feed");

  const signals = (await ctx.runQuery(
    internal.copierStore.listRecentSignalsForEngine,
    {},
  )) as unknown as Array<{
    address: string;
    symbol: string;
    priceUsd: number;
    liquidityUsd: number;
    postedAt: number;
    capturedAt: number;
  }>;
  // Solana mints only (never an 0x address).
  const solSignals = (signals ?? []).filter((s) => s.address && !s.address.startsWith("0x"));
  let swept: Awaited<ReturnType<typeof sweepSnipeMarket>> = [];
  try {
    swept = await sweepSnipeMarket("sol");
  } catch {
    swept = [];
  }
  const board = mergeSnipeBoard("sol", solSignals, swept);

  const recentRows = await ctx.runQuery(internal.terminal.botRecentExecutionLabels, {});
  const recentSet = new Set(
    recentRows.filter((r) => now - r.ts < 60_000).map((r) => r.label),
  );

  const buyClip = Math.max(0.05, state.solBuyAmountSol ?? 0.5);
  let sniped = 0;
  if (state.mode === "paper") {
    const dailyTarget = state.dailyArbTarget ?? 0;
    const dailyReached = dailyTarget > 0 && state.executionsToday >= dailyTarget;
    if (!dailyReached) {
      for (const c of board) {
        if (sniped >= ENGINE_MAX_EXEC_PER_PASS) break;
        const gate = evaluateSnipeCandidate(
          { liquidityUsd: c.liquidityUsd, priceUsd: c.priceUsd, capturedAt: c.capturedAt },
          { minLiquidityUsd: state.solMinLiquidityUsd ?? 5_000, minProfitPct: state.minProfit, now },
        );
        if (!gate.allowed) continue;
        const label = `SNIPE ${c.symbol} (${c.address.slice(0, 6)}…${c.address.slice(-4)})`;
        if (recentSet.has(label)) continue;
        recentSet.add(label);
        // Paper fill mirrors the SOL sniper: +1.5% of the operator's clip.
        const credit = Math.round((buyClip * gate.fillPct) / 100 * 1e6) / 1e6;
        await ctx.runMutation(internal.terminal.serverAutoExecution, {
          label,
          profitPct: gate.fillPct,
          amountBnb: credit,
          status: "success",
          lender: "Jupiter routing",
          dexes: "RAY",
          chain: "solana",
          nativeSymbol: "SOL",
          method: "snipe",
          payoutBnb: credit,
        });
        sniped += 1;
      }
    }
  }

  await ctx.runMutation(internal.terminal.botBumpScan, {
    opportunities: board.length,
    loopToken: lease,
    chain: "sol",
    subsystem: "snipe",
  });
  return { candidates: board.length, sniped };
}

export const serverAutoExecution = internalMutation({
  args: {
    label: v.string(),
    profitPct: v.number(),
    amountBnb: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("blocked"),
      v.literal("below_floor"),
      v.literal("failed"),
    ),
    lender: v.optional(v.string()),
    dexes: v.optional(v.string()),
    network: v.optional(v.string()),
    method: v.optional(v.string()),
    payoutBnb: v.optional(v.number()),
    chain: v.optional(v.string()),
    nativeSymbol: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await operatorUserDoc(ctx);
    if (!user) return { ok: false, reason: "no-operator" };
    return { ok: await applyExecution(ctx, user, args) };
  },
});

/** Unused placeholder retained for type parity with the original handler. */
const __recordExecutionState = null;
void __recordExecutionState;
const _unusedArgs = undefined as unknown as {
  label: string;
  profitPct: number;
  amountBnb: number;
  status: "success" | "blocked" | "below_floor" | "failed";
} | undefined;
void _unusedArgs;
const _legacyBody = async (ctx: MutationCtx, args: {
  label: string;
  profitPct: number;
  amountBnb: number;
  status: "success" | "blocked" | "below_floor" | "failed";
  lender?: string;
  dexes?: string;
  payoutBnb?: number;
  network?: string;
  txHash?: string;
  chainId?: number;
  gasUsedBnb?: number;
  /** REAL measured signing latency (ms) from the production executor. */
  signingLatencyMs?: number;
  relay?: string;
  chain?: string;
  nativeSymbol?: string;
  method?: string;
}): Promise<boolean | null> => {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  const state = await getState(ctx, user._id);
  if (!state) return null;

    const now = Date.now();
    const date = todayStr();
    const isNewDay = state.scanDate !== date;
    const executionsToday = isNewDay ? 0 : state.executionsToday;
    const successesToday = isNewDay ? 0 : state.successesToday;

    const isSuccess = args.status === "success";
    const nextExecutionsToday = executionsToday + 1;
    const nextSuccessesToday = successesToday + (isSuccess ? 1 : 0);
    const successRate = Math.round(
      (nextSuccessesToday / nextExecutionsToday) * 100,
    );

    const isPaper = state.mode === "paper";
    const payout = isSuccess && state.autoPayout ? Math.max(0, args.payoutBnb ?? args.amountBnb) : 0;
    const credited = isSuccess && isPaper ? args.amountBnb : 0;

    await ctx.db.patch(state._id, {
      balance: Math.round((state.balance + credited) * 1e6) / 1e6,
      lifetimePnl:
        Math.round((state.lifetimePnl + (isSuccess ? args.amountBnb : 0)) * 1e6) / 1e6,
      executionsToday: nextExecutionsToday,
      successesToday: nextSuccessesToday,
      successRate,
      openOpportunities: Math.max(0, state.openOpportunities - 1),
      payoutsTotal:
        payout > 0
          ? Math.round((state.payoutsTotal + payout) * 1e6) / 1e6
          : state.payoutsTotal,
      payoutsCount: payout > 0 ? state.payoutsCount + 1 : state.payoutsCount,
      lastPayoutAt: payout > 0 ? now : state.lastPayoutAt,
      scanDate: date,
    });

    await ctx.db.insert("executions", {
      userId: user._id,
      label: args.label,
      profitPct: args.profitPct,
      amountBnb: args.amountBnb,
      status: args.status as ExecutionStatus,
      ts: now,
      lender: args.lender,
      dexes: args.dexes,
      payoutBnb: payout > 0 ? payout : undefined,
      network: args.network ?? state.network,
      txHash: args.txHash,
      chainId: args.chainId,
      relay: args.relay,
      gasUsedBnb: args.gasUsedBnb,
      signingLatencyMs: args.signingLatencyMs,
      chain: args.chain ?? state.chainKey,
      method: args.method,
    });

    // Ping the notification center with the real execution event. The title
    // uses the row's real native unit (SOL FlashBolt passes "SOL"), so a
    // SOL snipe never shows up as "BNB" in the bell.
    const notifSymbol = args.nativeSymbol ?? NATIVE_SYMBOL[args.chain ?? state.chainKey] ?? "BNB";
    const statusTitle: Record<ExecutionStatus, string> = {
      success: `Executed +${args.amountBnb.toFixed(4)} ${notifSymbol}`,
      blocked: "MEV guard blocked a route",
      below_floor: "Route below the profit floor",
      failed: "On-chain transaction reverted",
    };
    await ctx.db.insert("notifications", {
      userId: user._id,
      kind: "execution",
      title: statusTitle[args.status as ExecutionStatus],
      body: [args.label, args.lender ? `lender ${args.lender}` : null, args.txHash ? `tx ${args.txHash.slice(0, 10)}…` : null]
        .filter(Boolean)
        .join(" · "),
      ts: now,
      read: false,
      // Chain attribution for the bell: the originating terminal chain
      // ("solana" rows land in the same feed, visibly tagged).
      chainKey: args.chain ?? state.chainKey,
    });

    // Telegram carries ONLY flash-loan trades + earnings (operator and
    // subscriber accounts alike). The alert is scheduled after commit so a
    // channel hiccup can never fail the trade record itself.
    if (isSuccess) {
      try {
        const role = await accountRole(ctx, user.email);
        // An execution can override the native unit (SOL FlashBolt passes
        // "SOL") — otherwise it is derived from the terminal's chain.
        const symbol = args.nativeSymbol ?? NATIVE_SYMBOL[state.chainKey] ?? "BNB";
        const earnings = payout > 0 ? payout : args.amountBnb;
        const { title, body } = buildTradeAlert({
          role,
          amountBnb: args.amountBnb,
          symbol,
          label: args.label,
          lender: args.lender,
          profitPct: args.profitPct,
          network: args.network ?? state.network,
          earnings,
          txHash: args.txHash,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.notifications.telegramTradeAlert,
          { title, body },
        );
        // Telegram Operator Bot — mirror the same successful trade to every
        // paired operator chat (fanout no-ops when disabled or none linked).
        await ctx.scheduler.runAfter(
          0,
          internal.telegramBot.fanoutTradeAlert,
          {
            role,
            amountBnb: args.amountBnb,
            symbol,
            label: args.label,
            lender: args.lender,
            profitPct: args.profitPct,
            network: args.network ?? state.network,
            earnings,
            txHash: args.txHash,
          },
        );
      } catch {
        // Never block the trade on an external channel.
      }
    }
    return true;
};

/**
 * Persist execution-control settings. Every field is optional — only the
 * provided keys are patched, so partial saves never clobber other settings.
 */
export const setSettings = mutation({
  args: {
    minProfit: v.optional(v.number()),
    mevGuard: v.optional(v.boolean()),
    cadence: v.optional(v.number()),
    maxLoan: v.optional(v.number()),
    maxHops: v.optional(v.number()),
    slippage: v.optional(v.number()),
    gasPriority: v.optional(
      v.union(v.literal("standard"), v.literal("fast"), v.literal("turbo")),
    ),
    autoPayout: v.optional(v.boolean()),
    dexWhitelist: v.optional(v.array(v.string())),
    lenderBalancer: v.optional(v.boolean()),
    privateSubmit: v.optional(v.boolean()),
    network: v.optional(v.union(v.literal("mainnet"), v.literal("testnet"))),
    chainKey: v.optional(
      v.union(
        v.literal("bsc"),
        v.literal("ethereum"),
        v.literal("arbitrum"),
        v.literal("polygon"),
      ),
    ),
    deployedContractAddress: v.optional(v.string()),
    routerAddress: v.optional(v.string()),
    deployments: v.optional(
      v.record(
        v.string(),
        v.object({ contractAddress: v.string(), routerAddress: v.string() }),
      ),
    ),
    dexWhitelists: v.optional(v.record(v.string(), v.array(v.string()))),
    rpcOverrides: v.optional(v.record(v.string(), v.string())),
    dailyArbTarget: v.optional(v.number()),
    loanAssets: v.optional(v.array(v.string())),
    // SOL FlashBolt sniper/flasher settings
    solNetwork: v.optional(v.union(v.literal("mainnet"), v.literal("testnet"))),
    // GLOBAL "Live only" ledger view (server-persisted operator preference).
    liveOnly: v.optional(v.boolean()),
    solBuyAmountSol: v.optional(v.number()),
    solSellAmountPct: v.optional(v.number()),
    solSlippagePct: v.optional(v.number()),
    solProfitTargetPct: v.optional(v.number()),
    solTrailingStopPct: v.optional(v.number()),
    solMinLiquidityUsd: v.optional(v.number()),
    solRpcOverrides: v.optional(v.record(v.string(), v.string())),
    solExecutionRail: v.optional(
      v.union(v.literal("jupiter"), v.literal("solcontract")),
    ),
    solContractProgramId: v.optional(v.string()),
    solContractAuthorized: v.optional(v.boolean()),
    solAuditApproved: v.optional(v.boolean()),
    solPinnedGenesis: v.optional(v.string()),
    // Public addresses of wallets imported through the SOL sniper's /import
    // command. The private material is never transmitted — the client derives
    // the address locally via ed25519 and persists only the public identity.
    solImportedWallets: v.optional(v.array(v.string())),
    // Public addresses of wallets imported through the BNB wallets page / BNB
    // sniper import. Same contract: only PUBLIC addresses — the private key
    // never leaves the operator's browser (AES-256-GCM session vault there).
    evmImportedWallets: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) patch[key] = value;
    }
    // Hard strategy bounds: maxLoan clamped to the 5/10 BNB cap server-side.
    if (typeof patch.maxLoan === "number") {
      patch.maxLoan = Math.min(BNB_MAX_LOAN_CAP, Math.max(0.1, patch.maxLoan));
    }
    // ── Execution-rail gate, enforced where the rail is written ──
    // The UI disables a rail it cannot execute, but a UI is not an authority:
    // an older client or a direct mutation call could still persist a rail the
    // engine will never sign on. Validate the MERGED state (stored row + this
    // patch), so activating the rail and arming it in one save behaves exactly
    // like doing it in two. It runs whenever a rail field is in the patch AND
    // the merged rail is `solcontract`, so an already-armed rail cannot be
    // de-armed by writing a bad program ID, while a Jupiter save is never
    // gated.
    const railFieldsInPatch =
      args.solExecutionRail !== undefined ||
      args.solContractProgramId !== undefined ||
      args.solContractAuthorized !== undefined ||
      args.solAuditApproved !== undefined ||
      args.solNetwork !== undefined;
    if (railFieldsInPatch) {
      const merged = mergeSolRailSettings(
        {
          rail: state.solExecutionRail ?? "jupiter",
          cluster: state.solNetwork ?? "mainnet",
          programId: state.solContractProgramId,
          authorized: state.solContractAuthorized ?? false,
          auditApproved: state.solAuditApproved ?? false,
        },
        {
          rail: args.solExecutionRail,
          cluster: args.solNetwork,
          programId: args.solContractProgramId,
          authorized: args.solContractAuthorized,
          auditApproved: args.solAuditApproved,
        },
      );
      if (merged.rail === "solcontract") {
        const verdict = solRailVerdict(merged);
        if (!verdict.ok) {
          throw new Error(
            `Contract rail blocked — ${verdict.blockers.join("; ")}. Nothing was saved; the rail is unchanged.`,
          );
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(state._id, patch);
    }
    return true;
  },
});

/**
 * Save the armed deployment for ONE chain. Also mirrors into the legacy
 * active fields so older code paths keep reading an honest armed contract.
 * Passing empty strings clears the chain's deployment.
 *
 * `signerAddress` / `relay` attribute HOW the contract reached the chain:
 *   • signerAddress — the account that signed the creation tx ("0x…" for a
 *     session hot wallet, "injected:0x…" for a browser-wallet deploy)
 *   • relay — the channel that actually carried the signed bytes (a private
 *     relay endpoint URL or "public-rpc"). Undefined for pasted addresses
 *     that were never broadcast from this app — attribution stays honest.
 */
export const saveDeployment = mutation({
  args: {
    chainKey: v.string(),
    contractAddress: v.optional(v.string()),
    routerAddress: v.optional(v.string()),
    signerAddress: v.optional(v.string()),
    relay: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    const deployments = {
      ...(state.deployments ?? {}),
    } as Record<
      string,
      {
        contractAddress: string;
        routerAddress: string;
        signerAddress?: string;
        relay?: string;
        armedAt?: number;
        firstArmedAt?: number;
        affirmedAt?: number;
      }
    >;
    const addr = args.contractAddress?.trim() ?? "";
    const router = args.routerAddress?.trim() ?? "";
    const signer = args.signerAddress?.trim() ?? "";
    const relay = args.relay?.trim() ?? "";
    if (addr || router) {
      const prev = deployments[args.chainKey];
      const prevAddr = (prev?.contractAddress ?? "").trim();
      // The arm is the ADDRESS: a different address is a new arm, the same
      // address keeps its original stamp (a stale arm cannot be laundered into a
      // fresh one by clicking Save), and a record saved before timestamps existed
      // gets its first stamp here — see `nextArmStamps`, which keeps "when was
      // this armed" and "when was this last saved" as separate facts.
      const stamps = nextArmStamps({
        previousAddress: prevAddr,
        nextAddress: addr || prevAddr,
        previousArmedAt: prev?.armedAt,
        previousFirstArmedAt: prev?.firstArmedAt,
        now: Date.now(),
      });
      deployments[args.chainKey] = {
        contractAddress: addr || prevAddr,
        routerAddress: router || prev?.routerAddress || "",
        // Only overwrite attribution when this call actually supplies it —
        // a manual "arm" of a pasted address must not fake a broadcast.
        ...(signer ? { signerAddress: signer } : prev?.signerAddress ? { signerAddress: prev.signerAddress } : {}),
        ...(relay ? { relay } : prev?.relay ? { relay: prev.relay } : {}),
        ...(stamps.armedAt !== undefined ? { armedAt: stamps.armedAt } : {}),
        ...(stamps.firstArmedAt !== undefined ? { firstArmedAt: stamps.firstArmedAt } : {}),
        ...(stamps.affirmedAt !== undefined ? { affirmedAt: stamps.affirmedAt } : {}),
      };
    } else {
      delete deployments[args.chainKey];
    }
    await ctx.db.patch(state._id, {
      deployments,
      deployedContractAddress: addr || undefined,
      routerAddress: router || undefined,
    });
    return true;
  },
});

/**
 * Backfill missing arm timestamps in the CALLING operator's terminal.
 *
 * Deployments armed before `armedAt` existed have no stamp, and the pins refuse
 * them (`unverified-arm`) because their age cannot be checked. This records the
 * only honest timestamp available: NOW, at the moment the operator re-affirms
 * those arms. It never rewrites an existing stamp (an old arm cannot be made
 * fresh) and it grants nothing on its own — a pin still requires a fresh
 * server-side read of the executor's runtime code, so the operator has to
 * inspect the contract again before approving it.
 *
 * Operator-only: the actor must be a registered operator email (not a guest
 * session), and every backfill is written to the audit log.
 */
export const backfillArmStamps = mutation({
  args: { reason: v.string() },
  handler: async (ctx, args) => {
    const { userId, actorId } = await resolveOperatorIdentity(ctx);
    const reason = args.reason.trim();
    if (reason.length < 4) {
      throw new Error("A reason of at least 4 characters is required to backfill arm stamps.");
    }
    const state = await ctx.db
      .query("terminalStates")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!state) return { stamped: [] as { chainKey: string; address: string }[], alreadyStamped: [] as string[] };

    const now = Date.now();
    const deployments = { ...(state.deployments ?? {}) };
    const stamped: { chainKey: string; address: string }[] = [];
    const alreadyStamped: string[] = [];
    for (const [chainKey, record] of Object.entries(deployments)) {
      if (!record) continue;
      const address = (record.contractAddress ?? "").trim();
      if (!address) continue;
      if (typeof record.armedAt === "number" && Number.isFinite(record.armedAt)) {
        alreadyStamped.push(chainKey);
        continue;
      }
      // `armedAt` says "affirmed now" (the only honest stamp available);
      // `firstArmedAt` stays absent because the real first-arm time is unknown.
      deployments[chainKey] = { ...record, armedAt: now, affirmedAt: now };
      stamped.push({ chainKey, address });
    }
    if (stamped.length === 0) return { stamped, alreadyStamped };

    await ctx.db.patch(state._id, { deployments });
    await ctx.db.insert("auditLogs", {
      actor: actorId,
      action: "arm-stamp-backfill",
      target: stamped.map((row) => `${row.chainKey}:${row.address}`).join(", "),
      description: `Arm timestamps backfilled for ${stamped
        .map((row) => row.chainKey)
        .join(", ")} — the original arm time was never recorded, so the stamp records this affirmation (${reason}). Pinning still requires a fresh server-side inspection.`,
      ts: now,
    });
    return { stamped, alreadyStamped };
  },
});

export const setBotRunning = mutation({
  args: {
    running: v.boolean(),
    // Which bot's switch to flip (default bnb). INDEPENDENT: stopping the
    // SOL bot never stops the BNB engine and vice versa.
    chain: v.optional(v.union(v.literal("bnb"), v.literal("sol"))),
  },
  handler: async (ctx, { running, chain }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    if (chain === "sol") {
      await ctx.db.patch(state._id, { solBotRunning: running });
    } else {
      await ctx.db.patch(state._id, { botRunning: running });
    }
    return true;
  },
});

export const setMode = mutation({
  args: { mode: v.union(v.literal("paper"), v.literal("live")) },
  handler: async (ctx, { mode }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    await ctx.db.patch(state._id, { mode });
    return true;
  },
});

export const connectWallet = mutation({
  args: { walletKey: v.string() },
  handler: async (ctx, { walletKey }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    if (state.connectedWallets.includes(walletKey)) return true;
    await ctx.db.patch(state._id, {
      connectedWallets: [...state.connectedWallets, walletKey],
    });
    return true;
  },
});

export const disconnectWallet = mutation({
  args: { walletKey: v.string() },
  handler: async (ctx, { walletKey }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    await ctx.db.patch(state._id, {
      connectedWallets: state.connectedWallets.filter((w) => w !== walletKey),
    });
    return true;
  },
});

/** Reset the paper account: balance restored, today's counters zeroed. */
export const resetAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const state = await getState(ctx, user._id);
    if (!state) return null;
    await ctx.db.patch(state._id, {
      balance: DEFAULT_TERMINAL_STATE.balance,
      lifetimePnl: 0,
      executionsToday: 0,
      successesToday: 0,
      successRate: 0,
      openOpportunities: DEFAULT_TERMINAL_STATE.openOpportunities,
      payoutsTotal: 0,
      payoutsCount: 0,
    });
    return true;
  },
});

/**
 * Purge corrupted SOL paper rows — the honest ledger cleanup for the
 * DexScreener stale-mark incident: a thin memecoin's per-venue price can go
 * hours without ticking, which minted absurd phantom credits (profitPct far
 * beyond any physically possible Solana spread) into the practice account.
 *
 * A row qualifies ONLY when ALL of these hold:
 *   - chain is solana,
 *   - status "success" with NO txHash (paper credit - live rows always carry
 *     the real sell signature),
 *   - profitPct > 100 - no same-block SOL round trip clears fees AND doubles;
 *     the route builder now refuses anything above 200% and healthy paper
 *     spreads sit in low single digits.
 *
 * Every qualifying row is deleted and its credit (plus any paper payout) is
 * reversed from balance / lifetime PnL / payout counters, so the ledger
 * self-heals to exactly what the clean rows say. Live rows are never touched.
 */
export const purgeCorruptedSolPaper = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user)
      return { removed: 0, reversedSol: 0, reversedPayouts: 0, reversedPayoutCount: 0, removedNotifications: 0 };
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const deletedIds = new Set<string>();
    const state = await getState(ctx, user._id);
    let removed = 0;
    let reversedSol = 0;
    let reversedPayouts = 0;
    let reversedPayoutCount = 0;
    let removedNotifications = 0;
    let balance = state?.balance ?? 0;
    let lifetimePnl = state?.lifetimePnl ?? 0;
    let payoutsTotal = state?.payoutsTotal ?? 0;
    let payoutsCount = state?.payoutsCount ?? 0;
    for (const row of rows) {
      const isSol = (row.chain ?? "solana") === "solana";
      const isPaperCredit = row.status === "success" && !row.txHash;
      const isAbsurd = row.profitPct > 100;
      if (!isSol || !isPaperCredit || !isAbsurd) continue;
      await ctx.db.delete(row._id);
      deletedIds.add(row._id);
      removed += 1;
      reversedSol += row.amountBnb ?? 0;
      balance -= row.amountBnb ?? 0;
      lifetimePnl -= row.amountBnb ?? 0;
      if (row.payoutBnb) {
        reversedPayouts += row.payoutBnb;
        reversedPayoutCount += 1;
        payoutsTotal -= row.payoutBnb;
        payoutsCount = Math.max(0, payoutsCount - 1);
      }
    }
    if (removed > 0 && state) {
      await ctx.db.patch(state._id, {
        balance: Math.round(balance * 1e6) / 1e6,
        lifetimePnl: Math.round(lifetimePnl * 1e6) / 1e6,
        payoutsTotal: Math.round(payoutsTotal * 1e6) / 1e6,
        payoutsCount,
      });
      // The corrupted rows each spawned a bell entry ("Executed +10040.6714
      // SOL") — remove those too so the notification center heals with the
      // ledger. Threshold is far above anything physically reachable: the
      // loan caps plus the 200% spread cap bound a legit credit well under
      // 100 SOL native.
      const notifs = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      for (const n of notifs) {
        if (n.kind !== "execution") continue;
        const m = /^Executed \+([\d.]+) /.exec(n.title);
        if (m && Number(m[1]) > 100) {
          await ctx.db.delete(n._id);
          removedNotifications += 1;
        }
      }
    }
    // MATERIALIZED PnL — keep the pnlStats doc exact WITHOUT re-folding raw
    // history: the daily retention sweep deletes old paper rows, so a full
    // rebuild would silently drop their folded totals. When the stats doc
    // exists, apply only the DELTA of rows this purge actually removed
    // (preserving everything already pruned); when it doesn't (cold start),
    // fold the full history ONCE — at that moment the rows ARE complete.
    const statsRow = await readPnlStats(ctx, user._id);
    if (statsRow) {
      if (removed > 0) {
        const delta = foldAllPnlRows(
          rows.filter((r) => deletedIds.has(r._id)),
        );
        await ctx.db.patch(statsRow._id, {
          liveCount: statsRow.liveCount - delta.liveCount,
          wins: statsRow.wins - delta.wins,
          grossProfit: statsRow.grossProfit - delta.grossProfit,
          gasBurned: statsRow.gasBurned - delta.gasBurned,
          solLiveCount: statsRow.solLiveCount - delta.solLiveCount,
          solWins: statsRow.solWins - delta.solWins,
          solGrossProfit: statsRow.solGrossProfit - delta.solGrossProfit,
          solGasBurned: statsRow.solGasBurned - delta.solGasBurned,
          simCount: statsRow.simCount - delta.simCount,
          simWins: statsRow.simWins - delta.simWins,
          simNet: statsRow.simNet - delta.simNet,
          updatedAt: Date.now(),
        });
      }
    } else {
      await writePnlStats(
        ctx,
        user._id,
        foldAllPnlRows(rows.filter((r) => !deletedIds.has(r._id))),
      );
    }
    return {
      removed,
      reversedSol: Math.round(reversedSol * 1e6) / 1e6,
      reversedPayouts: Math.round(reversedPayouts * 1e6) / 1e6,
      reversedPayoutCount,
      removedNotifications,
    };
  },
});

/**
 * One-time method backfill for the historical execution trail: rows written
 * before the method column existed get their method classified from the SAME
 * real evidence the writers used — the persisted label prefix ("ARB …" ⇒
 * statistical). Explicit labels keep their class; never invented, never
 * guessed beyond the shared rule. Idempotent: rows already classified are
 * untouched, so re-running is always a no-op.
 */
export const backfillExecutionMethods = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return 0;
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    let patched = 0;
    for (const row of rows) {
      if (row.method !== undefined) continue;
      const method = classifyExecutionMethod(row.method, row.label);
      if (!method) continue;
      await ctx.db.patch(row._id, { method });
      patched += 1;
    }
    return patched;
  },
});
