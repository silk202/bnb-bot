/**
 * FlashBolt real-time Telegram signals.
 *
 * Every 15 minutes (cron, see crons.ts — or on demand from the operator's
 * Signals page) this engine computes a LIVE dashboard from real data and
 * delivers it to the Telegram channel:
 *
 *   • Market session update — Sydney / Tokyo / London / New York, derived from
 *     the real UTC clock against the standard session windows. Signals are
 *     scoped to "specific durations": each session's window, with the
 *     highest-liquidity overlap regimes (London+NY, Tokyo+London, Sydney+Tokyo)
 *     called out explicitly, plus a countdown to the next session change.
 *   • Core network — mainnet/testnet distribution and chains actually scanned.
 *   • AI market score — 0–100 computed ONLY from live market data: cross-DEX
 *     price dispersion, real route density + average edge (same route engine
 *     the scanner uses), liquidity depth, 24h volume and the real BSC gas
 *     price from the RPC. Nothing is random or fabricated.
 *   • Current operating metrics — fleet aggregates straight from the persisted
 *     terminal states and execution trail (terminals, bots, executions, wins,
 *     PnL, open opportunities, scans).
 *
 * Every sent signal is stored in `telegramSignals` with its real delivery
 * status from the Telegram Bot API, so the Signals dashboard renders exactly
 * what the channel received.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { DEFAULT_TERMINAL_CONFIG } from "./terminalConfig";
import {
  CHAIN_INFO,
  DEFAULT_FEED_SETTINGS,
  computeRoutes,
  fetchMarketSnapshot,
  type MarketSnapshot,
} from "../lib/flashbolt";
import { sendTelegramMessage } from "./notifications";
import {
  SESSION_DEFS,
  type AiScore,
  type FleetMetrics,
  type SessionDef,
  type SessionSnapshot,
  buildSignalMessage,
  mergeSessionOverrides,
  sessionStateAt,
  sessionStateAtWith,
} from "../lib/telegram";

// Session definitions/clock + the signal message builder live in
// src/lib/telegram.ts (pure, unit-tested) and are re-exported here for
// compatibility with anything that imports them from the Convex module.
export {
  SESSION_DEFS,
  buildSignalMessage,
  fmtWindowLabel,
  mergeSessionOverrides,
  sessionStateAt,
  sessionStateAtWith,
} from "../lib/telegram";
export type {
  AiScore,
  FleetMetrics,
  SessionDef,
  SessionSnapshot,
} from "../lib/telegram";

// ---------------------------------------------------------------------------
// AI market score — computed exclusively from live data.
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Real `eth_gasPrice` (gwei) from the chain's RPC — honest, live. */
export async function fetchGasGwei(rpc: string): Promise<number | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_gasPrice",
        params: [],
      }),
    });
    const data = (await res.json()) as { result?: string };
    const hex = data?.result;
    if (typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex)) {
      return parseInt(hex, 16) / 1e9;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Score the live snapshot 0–100. Sub-scores are each derived from real
 * numbers with documented scaling; the gas penalty reflects that expensive
 * execution eats into every route's net edge.
 */
export function computeAiScore(
  snapshot: MarketSnapshot,
  gasGwei: number | null,
): AiScore {
  let totalLiq = 0;
  let totalVol = 0;
  const perToken: Record<string, { price: number }[]> = {};
  for (const quotes of Object.values(snapshot.quotes)) {
    for (const [symbol, q] of Object.entries(quotes)) {
      totalLiq += q.liquidityUsd;
      totalVol += q.volumeUsd;
      (perToken[symbol] ??= []).push({ price: q.usdPerToken });
    }
  }

  // Cross-DEX dispersion: average pairwise relative spread for the same token
  // priced on different DEXs — the real fuel for triangular arbitrage.
  let dispersion = 0;
  let pairs = 0;
  for (const list of Object.values(perToken)) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const lo = Math.min(list[i].price, list[j].price);
        if (lo <= 0) continue;
        dispersion += (Math.abs(list[i].price - list[j].price) / lo) * 100;
        pairs += 1;
      }
    }
  }
  dispersion = pairs > 0 ? dispersion / pairs : 0;

  // Real routes from the SAME engine the scanner uses (live DexScreener feed).
  const run = Math.floor(Date.now() / 60000);
  const routes = computeRoutes(snapshot, DEFAULT_FEED_SETTINGS, run, 20, true);
  const routeCount = routes.length;
  const avgEdge =
    routes.length > 0
      ? routes.slice(0, 8).reduce((a, r) => a + r.profitPct, 0) /
        Math.min(8, routes.length)
      : 0;

  const dispersionScore = clamp(dispersion * 40, 0, 100); // 2.5%+ spread => 100
  const depthScore = clamp((totalLiq / 30_000_000) * 100, 0, 100); // $30M+ => 100
  const volumeScore = clamp((totalVol / 8_000_000) * 100, 0, 100); // $8M+ => 100
  const routeScore = clamp(routeCount * 6, 0, 100); // 17+ routes => 100
  const edgeScore = clamp(avgEdge * 60, 0, 100); // +1.67% avg => 100
  const gasPenalty = gasGwei == null ? 0 : clamp(gasGwei * 2, 0, 25);

  const score = Math.round(
    clamp(
      0.2 * dispersionScore +
        0.15 * depthScore +
        0.15 * volumeScore +
        0.25 * routeScore +
        0.25 * edgeScore -
        gasPenalty,
      0,
      100,
    ),
  );
  const rating =
    score >= 75 ? "Hot" : score >= 50 ? "Active" : score >= 25 ? "Cool" : "Quiet";

  return {
    score,
    rating,
    dispersion,
    routeCount,
    avgEdge,
    totalLiq,
    totalVol,
    gasGwei,
    components: {
      dispersionScore,
      depthScore,
      volumeScore,
      routeScore,
      edgeScore,
      gasPenalty,
    },
  };
}

/**
 * Session definitions with the operator's window overrides applied — read
 * from the terminalConfig row (falls back to the standard UTC windows).
 */
export const getSessionDefs = internalQuery({
  args: {},
  handler: async (ctx): Promise<SessionDef[]> => {
    const row = await ctx.db
      .query("terminalConfig")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    return mergeSessionOverrides(SESSION_DEFS, row?.sessionOverrides ?? {});
  },
});

// ---------------------------------------------------------------------------
// Internal DB helpers (actions have no direct ctx.db in this Convex version)
// ---------------------------------------------------------------------------

/**
 * Fleet operating metrics straight from the persisted real trail.
 *
 * BUDGET (DB I/O): computing them scans the ENTIRE terminalStates table
 * (~94 KB of large docs), and the result was consumed by EVERY 15-minute
 * session signal AND every Telegram digest — ~18 MB/day of pure aggregate
 * scans. The snapshot is now MATERIALIZED on the terminalConfig row by the
 * fleet-metrics-refresh cron (every 20 min); collectMetrics serves the
 * cached snapshot while fresh and only computes live as a correctness
 * fallback when the cache is missing/stale.
 */
const FLEET_METRICS_TTL_MS = 25 * 60_000;

async function computeFleetMetrics(ctx: QueryCtx): Promise<FleetMetrics> {
    const states = await ctx.db.query("terminalStates").collect();
    const dayStart = Date.parse(
      new Date().toISOString().slice(0, 10) + "T00:00:00Z",
    );
    // BUDGET (DB I/O): only TODAY's executions matter here (the day-window
    // counters below skip older rows anyway) — an indexed range read instead
    // of collecting the entire all-time executions table on every 15-minute
    // session signal and every Telegram /dashboard.
    const executions = await ctx.db
      .query("executions")
      .withIndex("by_ts", (q) => q.gte("ts", dayStart))
      .collect();

    let executionsToday = 0;
    let successesToday = 0;
    let pnlToday = 0;
    let onChainToday = 0;
    for (const e of executions) {
      if (e.ts < dayStart) continue;
      executionsToday += 1;
      if (e.status === "success") {
        successesToday += 1;
        pnlToday += e.amountBnb;
        if (e.txHash) onChainToday += 1;
      }
    }

    let runningBots = 0;
    let openOpportunities = 0;
    let scansToday = 0;
    let lifetimePnl = 0;
    let payoutsTotal = 0;
    let liveCount = 0;
    const networks = { mainnet: 0, testnet: 0 };
    const chains = new Set<string>();
    for (const s of states) {
      if (s.botRunning) runningBots += 1;
      openOpportunities += s.openOpportunities;
      scansToday += s.scansToday;
      lifetimePnl += s.lifetimePnl;
      payoutsTotal += s.payoutsTotal;
      if (s.mode === "live") liveCount += 1;
      networks[s.network === "testnet" ? "testnet" : "mainnet"] += 1;
      chains.add(s.chainKey);
    }

    return {
      activeTerminals: states.length,
      runningBots,
      executionsToday,
      successesToday,
      winRate:
        executionsToday > 0
          ? Math.round((successesToday / executionsToday) * 100)
          : 0,
      pnlToday: Math.round(pnlToday * 1e6) / 1e6,
      onChainToday,
      lifetimePnl: Math.round(lifetimePnl * 1e6) / 1e6,
      payoutsTotal: Math.round(payoutsTotal * 1e6) / 1e6,
      openOpportunities,
      scansToday,
      liveCount,
      networks,
      chains: [...chains],
    };
}

/** Cached snapshot reader — the hot path every consumer actually pays. */
export const collectMetrics = internalQuery({
  args: {},
  handler: async (ctx): Promise<FleetMetrics> => {
    const row = await ctx.db
      .query("terminalConfig")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    if (
      row?.fleetMetrics &&
      row.fleetMetricsAt &&
      Date.now() - row.fleetMetricsAt < FLEET_METRICS_TTL_MS
    ) {
      try {
        return JSON.parse(row.fleetMetrics) as FleetMetrics;
      } catch {
        // corrupted snapshot — recompute below
      }
    }
    return await computeFleetMetrics(ctx);
  },
});

/** Fleet-metrics refresh cron — materializes the snapshot above. */
export const refreshFleetMetrics = internalMutation({
  args: {},
  handler: async (ctx): Promise<FleetMetrics> => {
    const metrics = await computeFleetMetrics(ctx);
    const json = JSON.stringify(metrics);
    const at = Date.now();
    const row = await ctx.db
      .query("terminalConfig")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    if (row) {
      await ctx.db.patch(row._id, { fleetMetrics: json, fleetMetricsAt: at });
    } else {
      await ctx.db.insert("terminalConfig", {
        key: "default",
        ...DEFAULT_TERMINAL_CONFIG,
        updatedAt: at,
        fleetMetrics: json,
        fleetMetricsAt: at,
      });
    }
    return metrics;
  },
});

/** Session key of the most recently stored signal (for open-detection). */
export const lastSignalSession = internalQuery({
  args: {},
  handler: async (ctx) => {
    const last = await ctx.db
      .query("telegramSignals")
      .withIndex("by_ts", (q) => q.gte("sentAt", 0))
      .order("desc")
      .first();
    return last?.session ?? null;
  },
});

/** One-way hash of the hidden operator email (never the email itself). */
export const operatorHash = internalQuery({
  args: {},
  handler: async (ctx) => {
    const op = await ctx.db.query("operatorConfig").first();
    return op?.emailHash ?? null;
  },
});

/** Persist a sent signal with its real delivery status. */
export const recordSignal = internalMutation({
  args: {
    kind: v.union(v.literal("session_open"), v.literal("session_update")),
    session: v.string(),
    sessionLabel: v.string(),
    title: v.string(),
    body: v.string(),
    score: v.number(),
    sentAt: v.number(),
    delivered: v.boolean(),
    deliveryNote: v.optional(v.string()),
    market: v.object({
      routeCount: v.number(),
      avgEdgePct: v.number(),
      liquidityUsd: v.number(),
      volumeUsd: v.number(),
      gasGwei: v.number(),
      dispersionPct: v.number(),
    }),
    metrics: v.object({
      activeTerminals: v.number(),
      runningBots: v.number(),
      executionsToday: v.number(),
      successesToday: v.number(),
      lifetimePnl: v.number(),
      openOpportunities: v.number(),
      scansToday: v.number(),
      networks: v.object({ mainnet: v.number(), testnet: v.number() }),
      chains: v.array(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("telegramSignals", args);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Message builder + shared compute/send pipeline
// ---------------------------------------------------------------------------

async function computeAndSendSignal(
  ctx: ActionCtx,
  kind: "session_open" | "session_update",
): Promise<{
  session: SessionSnapshot;
  score: AiScore;
  metrics: FleetMetrics;
  delivery: { enabled: boolean; ok: boolean; description: string };
}> {
  const now = Date.now();
  const defs = await ctx.runQuery(internal.signals.getSessionDefs, {});
  const session = sessionStateAtWith(now, defs);
  // Real live data — DexScreener feed on the core chain + real RPC gas price.
  const snapshot = await fetchMarketSnapshot("bsc");
  const gasGwei = await fetchGasGwei(CHAIN_INFO.bsc.rpc);
  const score = computeAiScore(snapshot, gasGwei);
  const metrics = await ctx.runQuery(internal.signals.collectMetrics, {});
  const { title, body } = buildSignalMessage(session, score, metrics, kind);

  // Real Telegram Bot API call — the response determines `delivered`.
  const delivery = await sendTelegramMessage(title, body);

  await ctx.runMutation(internal.signals.recordSignal, {
    kind,
    session: session.primary?.key ?? "none",
    sessionLabel: session.primary?.label ?? "All sessions closed",
    title,
    body,
    score: score.score,
    sentAt: now,
    delivered: delivery.ok,
    deliveryNote: delivery.description,
    market: {
      routeCount: score.routeCount,
      avgEdgePct: Math.round(score.avgEdge * 100) / 100,
      liquidityUsd: Math.round(score.totalLiq),
      volumeUsd: Math.round(score.totalVol),
      gasGwei: score.gasGwei == null ? 0 : Math.round(score.gasGwei * 10) / 10,
      dispersionPct: Math.round(score.dispersion * 100) / 100,
    },
    metrics: {
      activeTerminals: metrics.activeTerminals,
      runningBots: metrics.runningBots,
      executionsToday: metrics.executionsToday,
      successesToday: metrics.successesToday,
      lifetimePnl: metrics.lifetimePnl,
      openOpportunities: metrics.openOpportunities,
      scansToday: metrics.scansToday,
      networks: metrics.networks,
      chains: metrics.chains,
    },
  });

  return { session, score, metrics, delivery };
}

// ---------------------------------------------------------------------------
// Scheduled + manual signal actions
// ---------------------------------------------------------------------------

/**
 * Cron entry (every 15 minutes, see crons.ts). Fires a `session_open` signal
 * the first time a new primary session becomes active, otherwise a periodic
 * `session_update` — both carry the full live dashboard.
 */
export const runSessionSignal = internalAction({
  args: {},
  handler: async (
    ctx: ActionCtx,
  ): Promise<{
    session: SessionSnapshot;
    score: AiScore;
    metrics: FleetMetrics;
    delivery: { enabled: boolean; ok: boolean; description: string };
  }> => {
    const session = sessionStateAt(Date.now());
    const primaryKey = session.primary?.key ?? "none";
    const previous = await ctx.runQuery(internal.signals.lastSignalSession, {});
    const kind: "session_open" | "session_update" =
      session.primary !== null && previous !== primaryKey
        ? "session_open"
        : "session_update";
    const result = await computeAndSendSignal(ctx, kind);
    // Real in-app session alerts: when a NEW primary session opens, active
    // subscribers with the session-alerts preference get a bell entry too
    // (the Telegram channel send above is unaffected).
    if (kind === "session_open") {
      await ctx.runMutation(internal.notifications.recordSessionAlerts, {
        session: result.session.primary?.key ?? "none",
        sessionLabel: result.session.primary?.label ?? "All sessions closed",
        title: result.session.primary
          ? `${result.session.primary.flag} ${result.session.primary.label} session open`
          : "Market session update",
        body: `${result.session.primary ? `${result.session.primary.windowLabel} — ` : ""}${result.session.regime}. AI market score ${result.score.score}/100 (${result.score.rating}).`,
      });
    }
    return result;
  },
});

/**
 * Operator-triggered "send signal now" (Signals page button). The action
 * verifies the caller IS the terminal operator (server-side email hash
 * comparison — the email itself is never exposed) and then recomputes the
 * live dashboard and delivers it immediately.
 */
export const fireSessionSignal = action({
  args: {},
  handler: async (
    ctx: ActionCtx,
  ): Promise<{
    kind: "session_open" | "session_update";
    session: string;
    score: number;
    rating: string;
    delivered: boolean;
    deliveryNote: string;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) throw new Error("Sign in to send a signal.");
    const hash = await ctx.runQuery(internal.signals.operatorHash, {});
    const isOperator = hash != null && (await sha256Hex(email)) === hash;
    if (!isOperator) {
      throw new Error("Only the terminal operator can send signals.");
    }
    const session = sessionStateAt(Date.now());
    const primaryKey = session.primary?.key ?? "none";
    const previous = await ctx.runQuery(internal.signals.lastSignalSession, {});
    const kind: "session_open" | "session_update" =
      session.primary !== null && previous !== primaryKey
        ? "session_open"
        : "session_update";
    const result = await computeAndSendSignal(ctx, kind);
    if (kind === "session_open") {
      await ctx.runMutation(internal.notifications.recordSessionAlerts, {
        session: result.session.primary?.key ?? "none",
        sessionLabel: result.session.primary?.label ?? "All sessions closed",
        title: result.session.primary
          ? `${result.session.primary.flag} ${result.session.primary.label} session open`
          : "Market session update",
        body: `${result.session.primary ? `${result.session.primary.windowLabel} — ` : ""}${result.session.regime}. AI market score ${result.score.score}/100 (${result.score.rating}).`,
      });
    }
    return {
      kind,
      session: result.session.primary?.label ?? "All sessions closed",
      score: result.score.score,
      rating: result.score.rating,
      delivered: result.delivery.ok,
      deliveryNote: result.delivery.description,
    };
  },
});

// ---------------------------------------------------------------------------
// Dashboard query — live session state + the last signal snapshot + history
// ---------------------------------------------------------------------------

/** One-way SHA-256 hex digest (Web Crypto, available in Convex V8). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const getSignalDashboard = query({
  args: {},
  handler: async (ctx: QueryCtx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const row = await ctx.db
      .query("terminalConfig")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    const session = sessionStateAtWith(
      now,
      mergeSessionOverrides(SESSION_DEFS, row?.sessionOverrides ?? {}),
    );
    const latest = await ctx.db
      .query("telegramSignals")
      .withIndex("by_ts", (q) => q.gte("sentAt", 0))
      .order("desc")
      .first();
    const history = await ctx.db
      .query("telegramSignals")
      .withIndex("by_ts", (q) => q.gte("sentAt", 0))
      .order("desc")
      .take(10);
    return { now, session, latest, history };
  },
});

/**
 * Live market context for the terminal panels (operator AND subscriber
 * views) — the real session clock state (Sydney / Tokyo / London / New York
 * UTC windows, primary session, overlap regime, next-change countdown) plus
 * the signed-in user's recent honey-pot detections from the real scanner
 * trail (persisted notifications). Every value is computed from real time
 * and real events — never simulated.
 */
export const getTerminalContext = query({
  args: {},
  handler: async (ctx: QueryCtx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const row = await ctx.db
      .query("terminalConfig")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    const session = sessionStateAtWith(
      now,
      mergeSessionOverrides(SESSION_DEFS, row?.sessionOverrides ?? {}),
    );
    // BUDGET (DB I/O): read ONLY this user's honey-pot rows — the old
    // full-history collect (16k+ execution notifications ≈ 5 MB for the
    // operator) re-ran on every execution write while this query was
    // mounted, and only honey_pot rows were ever shown.
    const honeyPots = (
      await ctx.db
        .query("notifications")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", user._id).eq("kind", "honey_pot"),
        )
        .collect()
    )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5)
      .map((n) => ({
        title: n.title,
        body: n.body,
        ts: n.ts,
        chainKey: n.chainKey ?? null,
      }));
    return { now, session, honeyPots };
  },
});
