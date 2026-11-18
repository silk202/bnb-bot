/**
 * SOL live route feed — market sweep (server-safe core).
 *
 * The SOL FlashBolt's LIVE ROUTE FEED sweeps a live Solana token board
 * (DexScreener search profiles) and converts each captured token with a real
 * two-venue spread into a flash-loan route. This module is the fetch core,
 * written so it runs in BOTH environments:
 *   • the browser (useSolLiveFeed / SolMultiSignalMonitor), and
 *   • Convex actions (the server-side SOL engine pass in terminal.ts) —
 *     via fetchWithTimeout (never AbortSignal.timeout, which older server
 *     runtimes lack).
 *
 * Every candidate comes from a real DexScreener pair — nothing is simulated.
 */
import { SOL_CHAIN } from "./solana";
import type { SolTelecopierSignal } from "./solana-routes";

/** A Solana token candidate captured from the live market sweep. */
export interface SolFeedCandidate {
  address: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  dexId: string;
}

/** DexScreener pair subset (shared shape with the route engine). */
interface DsPair {
  chainId?: string;
  dexId?: string;
  labels?: string[];
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string };
  volume?: { h24?: number };
}

/** Fetch with a hard timeout — never hangs the scan loop. */
async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Live market sweep: the newest Solana pairs across the venue board from
 * DexScreener's public search. Returns buyable candidates (real liquidity)
 * ready for two-venue conversion.
 */
export async function sweepSolMarket(): Promise<SolFeedCandidate[]> {
  // DexScreener search profiles: recent high-liquidity Solana pairs.
  const queries = ["SOL USDC", "SOL USDT", "WSOL"];
  const results = await Promise.allSettled(
    queries.map((q) =>
      fetchJson<{ pairs?: DsPair[] }>(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      ),
    ),
  );
  const byAddress = new Map<string, SolFeedCandidate>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value.pairs ?? []) {
      if ((p.chainId ?? "").toLowerCase() !== SOL_CHAIN.dexScreenerChainId) continue;
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
          volume24h: p.volume?.h24 ?? 0,
          dexId: p.dexId ?? "",
        });
      }
    }
  }
  return [...byAddress.values()].slice(0, 60);
}

/**
 * Merge the two live SOL candidate sources into one rescan board:
 * copied Telegram signals first (freshest signal-driven candidates), then
 * market-swept tokens not already covered. Deduped by mint address —
 * a token present in both feeds is scanned once, never double-built.
 */
export function mergeSolCandidates(
  signals: SolTelecopierSignal[],
  swept: SolFeedCandidate[],
  cap = 60,
): SolTelecopierSignal[] {
  const board: SolTelecopierSignal[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const key = s.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    board.push(s);
  }
  for (const c of swept) {
    const key = c.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    board.push({
      id: "mkt:" + c.address,
      source: "market-sweep",
      sourceLabel: "Market sweep",
      address: c.address,
      symbol: c.symbol,
      name: c.symbol,
      chain: "solana",
      priceUsd: c.priceUsd,
      liquidityUsd: c.liquidityUsd,
      postedAt: 0,
      capturedAt: Date.now(),
      buyable: true,
      excerpt: "",
    });
  }
  return board.slice(0, cap);
}
