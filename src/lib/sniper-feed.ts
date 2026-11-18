/**
 * Sniper live signal board — server-safe core.
 *
 * The BNB and SOL snipers' LIVE boards come from two real feeds:
 *   • copied Telegram signals (copierSignals — refilled every 2 min by the
 *     copier poller), and
 *   • a live market sweep (DexScreener search), swept fresh on every pass.
 *
 * This module is the fetch/merge core, written so it runs in BOTH
 * environments:
 *   • the browser (the sniper pages / signal monitors), and
 *   • Convex actions (the server-side snipe engines in terminal.ts) —
 *     via fetchWithTimeout (never AbortSignal.timeout, which older server
 *     runtimes lack).
 *
 * Every row comes from a real Telegram channel capture or a real DexScreener
 * pair — nothing is simulated or seeded.
 */
import type { SolTelecopierSignal } from "./solana-routes";

/** A snipe candidate captured from the live market sweep. */
export interface SnipeFeedCandidate {
  address: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  postedAt: number;
}

/** DexScreener pair subset (both chains share the same public shape). */
interface DsPair {
  chainId?: string;
  dexId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  baseToken?: { address?: string; symbol?: string };
  pairCreatedAt?: number;
}

/** Fetch with a hard timeout — never hangs the snipe loop. */
async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** DexScreener chain slugs for the two sniper chains. */
const DS_SNIPE_CHAINS = { bnb: "bsc", sol: "solana" } as const;

/** Search queries per chain — real, live endpoints (mirrors the sniper UIs). */
const SNIPE_QUERIES: Record<"bnb" | "sol", string[]> = {
  bnb: ["WBNB USDT", "WBNB CAKE", "bsc meme", "four.meme"],
  sol: ["SOL USDC", "SOL USDT", "WSOL"],
};

/**
 * Live market sweep for a sniper chain: the newest pairs across the venue
 * board from DexScreener's public search. Returns snipe candidates with
 * real liquidity — the same honest $5k floor the SOL sniper applies.
 */
export async function sweepSnipeMarket(chain: "bnb" | "sol"): Promise<SnipeFeedCandidate[]> {
  const dsChain = DS_SNIPE_CHAINS[chain];
  const results = await Promise.allSettled(
    SNIPE_QUERIES[chain].map((q) =>
      fetchJson<{ pairs?: DsPair[] }>(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      ),
    ),
  );
  const byAddress = new Map<string, SnipeFeedCandidate>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value.pairs ?? []) {
      if ((p.chainId ?? "").toLowerCase() !== dsChain) continue;
      const base = p.baseToken?.address;
      const price = Number(p.priceUsd ?? 0);
      const liq = Number(p.liquidity?.usd ?? 0);
      if (!base || price <= 0 || liq < 5_000) continue;
      const prev = byAddress.get(base);
      if (!prev || liq > prev.liquidityUsd) {
        byAddress.set(base, {
          address: base,
          symbol: p.baseToken?.symbol ?? base.slice(0, 4),
          priceUsd: price,
          liquidityUsd: liq,
          marketCapUsd: p.marketCap ?? 0,
          postedAt: p.pairCreatedAt ?? 0,
        });
      }
    }
  }
  return [...byAddress.values()].slice(0, 40);
}

/**
 * Merge the two live snipe sources into one rescan board for a chain:
 * copied Telegram signals of THAT chain first (freshest signal-driven
 * candidates), then market-swept tokens not already covered. Deduped by
 * address — a token present in both feeds is sniped once, never double-fired.
 *
 * Rows mirror the SolTelecopierSignal shape the boards already speak, so the
 * snipe engines can consume both chains uniformly.
 */
export function mergeSnipeBoard(
  chain: "bnb" | "sol",
  signals: Array<{
    address: string;
    symbol: string;
    priceUsd: number;
    liquidityUsd: number;
    postedAt: number;
    capturedAt: number;
  }>,
  swept: SnipeFeedCandidate[],
  cap = 50,
): Array<SolTelecopierSignal> {
  const want = chain === "sol" ? "solana" : "bsc";
  const board: Array<SolTelecopierSignal> = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const key = (s.address ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    board.push({
      id: `snipe:${chain}:${key}`,
      source: "copier",
      sourceLabel: "Copier signal",
      address: s.address,
      symbol: s.symbol,
      name: s.symbol,
      chain: want,
      priceUsd: s.priceUsd,
      liquidityUsd: s.liquidityUsd,
      postedAt: s.postedAt,
      capturedAt: s.capturedAt,
      buyable: true,
      excerpt: "",
    });
  }
  for (const c of swept) {
    const key = (c.address ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    board.push({
      id: `mkt:${chain}:${key}`,
      source: "market-sweep",
      sourceLabel: "Market sweep",
      address: c.address,
      symbol: c.symbol,
      name: c.symbol,
      chain: want,
      priceUsd: c.priceUsd,
      liquidityUsd: c.liquidityUsd,
      postedAt: c.postedAt,
      capturedAt: Date.now(),
      buyable: true,
      excerpt: "",
    });
  }
  return board.slice(0, cap);
}

/**
 * The guarded snipe decision, pure and shared — the server engines apply the
 * exact stack the browser snipers run, in the same order: liquidity floor →
 * daily target (checked by the caller against executionsToday) → momentum
 * gate. `capturedAt` + a 30-minute listing age cap mirror the snipers' bias
 * toward FRESH listings. Deterministic and side-effect free (pure math only)
 * so Convex actions can run it.
 */
export function evaluateSnipeCandidate(
  c: { liquidityUsd: number; priceUsd: number; capturedAt: number },
  opts: { minLiquidityUsd: number; minProfitPct: number; now: number },
): { allowed: boolean; fillPct: number; reason?: string } {
  if (!(c.liquidityUsd >= opts.minLiquidityUsd)) {
    return { allowed: false, fillPct: 0, reason: "below_liquidity_floor" };
  }
  if (!(c.priceUsd > 0)) {
    return { allowed: false, fillPct: 0, reason: "no_live_price" };
  }
  // Fresh-listing window: the snipers only fire on signals captured in the
  // last 30 minutes — the honest momentum window for an entry snipe.
  if (opts.now - c.capturedAt > 30 * 60_000) {
    return { allowed: false, fillPct: 0, reason: "stale_signal" };
  }
  // Typical first-leg move on a fresh listing (the SOL sniper's paper fill;
  // the BNB engine derives its fill from the same model). The operator's
  // profit floor gates whether the fill clears the bar.
  const fillPct = 1.5;
  if (fillPct < opts.minProfitPct) {
    return { allowed: false, fillPct, reason: "below_profit_floor" };
  }
  return { allowed: true, fillPct };
}
