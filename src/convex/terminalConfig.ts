import { v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isOperatorEmail } from "./operatorEmails";
import { DEFAULT_NEWS_KEYWORDS } from "../lib/news";

/**
 * Operator-tunable terminal settings — honeypot scanner thresholds, the
 * market-news high-signal watchlist and per-session market windows. A single
 * `terminalConfig` row (key "default"); every consumer falls back to these
 * documented defaults when the row is missing, so the terminal works out of
 * the box and only changes when the operator saves real values from the
 * console. All values are real settings enforced by the actual scanner,
 * news and signal engines — nothing simulated.
 */

export interface TerminalConfig {
  honeyMinProfitPct: number;
  honeyMinLiquidityUsd: number;
  newsKeywords: string[];
  sessionOverrides: Record<string, { openMin: number; closeMin: number }>;
  updatedAt: number;
}

export const DEFAULT_TERMINAL_CONFIG: Omit<TerminalConfig, "updatedAt"> = {
  honeyMinProfitPct: 0.5,
  honeyMinLiquidityUsd: 250_000,
  newsKeywords: [...DEFAULT_NEWS_KEYWORDS],
  sessionOverrides: {},
};

const SESSION_KEYS = new Set(["sydney", "tokyo", "london", "new_york"]);

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1439, Math.max(0, Math.round(value)));
}

/** Shape a stored row into the typed config (or the defaults). */
export function configFromRow(
  row: {
    honeyMinProfitPct: number;
    honeyMinLiquidityUsd: number;
    newsKeywords: string[];
    sessionOverrides?: Record<string, { openMin: number; closeMin: number }>;
    updatedAt: number;
  } | null,
  now = Date.now(),
): TerminalConfig {
  if (!row) return { ...DEFAULT_TERMINAL_CONFIG, updatedAt: now };
  const overrides: Record<string, { openMin: number; closeMin: number }> = {};
  for (const [key, win] of Object.entries(row.sessionOverrides ?? {})) {
    if (SESSION_KEYS.has(key)) {
      overrides[key] = {
        openMin: clampMinutes(win.openMin),
        closeMin: clampMinutes(win.closeMin),
      };
    }
  }
  return {
    honeyMinProfitPct:
      Number.isFinite(row.honeyMinProfitPct) && row.honeyMinProfitPct >= 0
        ? row.honeyMinProfitPct
        : DEFAULT_TERMINAL_CONFIG.honeyMinProfitPct,
    honeyMinLiquidityUsd:
      Number.isFinite(row.honeyMinLiquidityUsd) && row.honeyMinLiquidityUsd >= 0
        ? row.honeyMinLiquidityUsd
        : DEFAULT_TERMINAL_CONFIG.honeyMinLiquidityUsd,
    newsKeywords:
      Array.isArray(row.newsKeywords) && row.newsKeywords.length > 0
        ? row.newsKeywords.map((k) => k.trim()).filter((k) => k.length > 0)
        : [...DEFAULT_TERMINAL_CONFIG.newsKeywords],
    sessionOverrides: overrides,
    updatedAt: row.updatedAt,
  };
}

async function fetchConfigRow(ctx: Pick<QueryCtx | MutationCtx, "db">) {
  return await ctx.db
    .query("terminalConfig")
    .withIndex("by_key", (q) => q.eq("key", "default"))
    .first();
}

/** Backend-only view of the effective config (actions, crons, internals). */
export const getEffectiveConfig = internalQuery({
  args: {},
  handler: async (ctx) => configFromRow(await fetchConfigRow(ctx)),
});

/** Terminal view — current effective settings (any signed-in user). */
export const getTerminalConfig = query({
  args: {},
  handler: async (ctx) => {
    return configFromRow(await fetchConfigRow(ctx));
  },
});

/**
 * Operator console — save real terminal settings. Operator-gated (server-side
 * email check). Only the provided fields are updated; the rest keep their
 * current effective values. Session windows are clamped to 0–1439 UTC
 * minutes-of-day and restricted to the four known sessions; keywords are
 * trimmed and empties dropped.
 */
export const updateTerminalConfig = mutation({
  args: {
    honeyMinProfitPct: v.optional(v.number()),
    honeyMinLiquidityUsd: v.optional(v.number()),
    newsKeywords: v.optional(v.array(v.string())),
    sessionOverrides: v.optional(
      v.record(
        v.string(),
        v.object({ openMin: v.number(), closeMin: v.number() }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || !(await isOperatorEmail(ctx, email))) {
      throw new Error("Only the terminal operator can change terminal settings.");
    }
    const row = await fetchConfigRow(ctx);
    const current = configFromRow(row);

    const next: TerminalConfig = {
      honeyMinProfitPct:
        args.honeyMinProfitPct !== undefined
          ? Math.max(0, args.honeyMinProfitPct)
          : current.honeyMinProfitPct,
      honeyMinLiquidityUsd:
        args.honeyMinLiquidityUsd !== undefined
          ? Math.max(0, args.honeyMinLiquidityUsd)
          : current.honeyMinLiquidityUsd,
      newsKeywords:
        args.newsKeywords !== undefined
          ? args.newsKeywords.map((k) => k.trim()).filter((k) => k.length > 0)
          : current.newsKeywords,
      sessionOverrides: current.sessionOverrides,
      updatedAt: Date.now(),
    };
    if (args.sessionOverrides !== undefined) {
      const overrides: Record<string, { openMin: number; closeMin: number }> =
        {};
      for (const [key, win] of Object.entries(args.sessionOverrides)) {
        if (SESSION_KEYS.has(key)) {
          overrides[key] = {
            openMin: clampMinutes(win.openMin),
            closeMin: clampMinutes(win.closeMin),
          };
        }
      }
      next.sessionOverrides = overrides;
    }

    const doc = {
      key: "default",
      honeyMinProfitPct: next.honeyMinProfitPct,
      honeyMinLiquidityUsd: next.honeyMinLiquidityUsd,
      newsKeywords: next.newsKeywords,
      sessionOverrides: next.sessionOverrides,
      updatedAt: next.updatedAt,
    };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("terminalConfig", doc);
    return next;
  },
});
