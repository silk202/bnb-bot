/**
 * Cross-chain DEX arbitrage engine — real market data, no simulation.
 *
 * DexScreener indexes all four supported chains with one search endpoint,
 * so the same asset (matched by SYMBOL across chains) can be compared
 * price-vs-price in real time. A positive cross-chain spread means the
 * asset is cheap on one chain and expensive on another; when the asset
 * also trades on the operator's SELECTED chain, the spread is executable
 * there through the same per-chain execution path every chain now shares
 * (flash-loan contract for the flasher, router buy/sell for the sniper) —
 * each leg fully eth_estimateGas+eth_call simulated before broadcast.
 *
 * The engine is deliberately honest about what it can execute:
 *  - same-chain DEX-vs-DEX legs  → executable atomically on that chain
 *  - pure cross-chain legs       → surfaced as spreads; execution happens
 *    on the chain the operator selected (buy where cheap on THAT chain's
 *    venue, sell into its most expensive venue), with the cross-chain
 *    quote chain's price carried as the fair-value reference.
 */
import { CHAIN_KEYS, type ChainKey } from "./chains";

export interface CrossChainPair {
  chainId: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  pairCreatedAt: number;
}

export interface CrossChainSpread {
  symbol: string;
  /** Cheapest chain + venue. */
  cheapChain: ChainKey;
  cheapDex: string;
  cheapPriceUsd: number;
  /** Most expensive chain + venue. */
  dearChain: ChainKey;
  dearDex: string;
  dearPriceUsd: number;
  /** Net spread percent (cheap → dear), before fees. */
  spreadPct: number;
  /** Pairs found per chain — the real evidence behind the spread. */
  pairs: CrossChainPair[];
  /** Chains where the asset has live liquidity ≥ minLiquidityUsd. */
  liquidChains: ChainKey[];
  detectedAt: number;
}

const SEARCH_ENDPOINT = "https://api.dexscreener.com/latest/dex/search?q=";

interface DSPair {
  chainId?: string;
  dexId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  baseToken?: { symbol?: string };
}

/** Live pairs for one search query (one HTTP call, up to 30 pairs). */
async function searchPairs(query: string): Promise<DSPair[]> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(
      `${SEARCH_ENDPOINT}${encodeURIComponent(query)}`,
      8_000,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { pairs?: DSPair[] };
    return data.pairs ?? [];
  } catch {
    return [];
  }
}

const DS_TO_KEY: Record<string, ChainKey> = {
  bsc: "bsc",
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  polygon: "polygon",
};

/**
 * Detect real cross-chain spreads for a set of symbols (e.g. the tokens the
 * scanner's discovery pipeline just surfaced). One DexScreener call per
 * symbol; each call returns pairs on every chain where the symbol trades.
 */
export async function detectCrossChainSpreads(
  symbols: string[],
  opts?: { minLiquidityUsd?: number; maxSymbols?: number },
): Promise<CrossChainSpread[]> {
  const minLiq = opts?.minLiquidityUsd ?? 5_000;
  const capped = symbols.slice(0, opts?.maxSymbols ?? 20);

  const results = await Promise.allSettled(
    capped.map(async (symbol): Promise<CrossChainSpread | null> => {
      const pairs = await searchPairs(symbol);
      const byChain = new Map<ChainKey, CrossChainPair>();
      for (const p of pairs) {
        const key = DS_TO_KEY[p.chainId ?? ""];
        if (!key) continue;
        if (p.baseToken?.symbol?.toUpperCase() !== symbol.toUpperCase()) continue;
        const price = Number(p.priceUsd);
        if (!Number.isFinite(price) || price <= 0) continue;
        const liq = p.liquidity?.usd ?? 0;
        if (liq < minLiq) continue;
        const existing = byChain.get(key);
        // Deepest pair per chain is the executable venue.
        if (!existing || liq > existing.liquidityUsd) {
          byChain.set(key, {
            chainId: p.chainId!,
            dexId: p.dexId ?? "unknown",
            priceUsd: price,
            liquidityUsd: liq,
            volume24h: p.volume?.h24 ?? 0,
            pairCreatedAt: p.pairCreatedAt ?? 0,
          });
        }
      }
      if (byChain.size < 2) return null;
      const entries = [...byChain.entries()].sort((a, b) => a[1].priceUsd - b[1].priceUsd);
      const [cheapChain, cheap] = entries[0];
      const [dearChain, dear] = entries[entries.length - 1];
      const spreadPct = ((dear.priceUsd - cheap.priceUsd) / cheap.priceUsd) * 100;
      if (spreadPct <= 0.1) return null; // below fee floor — not a real opportunity
      return {
        symbol: symbol.toUpperCase(),
        cheapChain,
        cheapDex: cheap.dexId,
        cheapPriceUsd: cheap.priceUsd,
        dearChain,
        dearDex: dear.dexId,
        dearPriceUsd: dear.priceUsd,
        spreadPct,
        pairs: entries.map(([, p]) => p),
        liquidChains: entries.map(([k]) => k),
        detectedAt: Date.now(),
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<CrossChainSpread | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((s): s is CrossChainSpread => s !== null)
    .sort((a, b) => b.spreadPct - a.spreadPct);
}

/**
 * Executable cross-chain routes for the SELECTED chain: a spread is
 * actionable here when the selected chain is one of the chains where the
 * asset trades — the local leg (buy or sell on the local venue) executes
 * through the chain's own execution environment, with the other chain's
 * price as the fair-value reference.
 */
export function actionableForChain(
  spreads: CrossChainSpread[],
  chainKey: ChainKey,
): CrossChainSpread[] {
  return spreads.filter((s) => s.liquidChains.includes(chainKey));
}

/** All supported chains, for iterating cross-chain sweeps. */
export const ALL_CHAINS = CHAIN_KEYS;
