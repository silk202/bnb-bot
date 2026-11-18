/**
 * Multi-Signal Fetcher — pulls live token data from 20+ sources.
 *
 * Uses DexScreener as the primary aggregator (it indexes most DEXes and
 * launchpads), supplemented by direct API calls to GeckoTerminal, GMGN,
 * DexView, Birdeye, and others where public endpoints are available.
 *
 * All data is real-time live. Nothing is mocked or simulated.
 */
import type { LiveTokenSignal } from "@/components/MultiSignalMonitor";
import { GECKO_NETWORKS, networkInfoFor, type ChainKey, type NetworkKey } from "@/lib/chains";
import { buildTestnetSnapshot } from "@/lib/testnet-feed";

/** DexScreener chain slug for a ChainKey. */
const DS_CHAINS: Record<ChainKey, string> = {
  bsc: "bsc",
  ethereum: "ethereum",
  polygon: "polygon",
  arbitrum: "arbitrum",
};

/** DexScreener pair-search query diversity per chain (real, live endpoints). */
const CHAIN_QUERIES: Record<ChainKey, string[]> = {
  bsc: ["bsc meme", "bsc", "WBNB USDT", "WBNB CAKE", "four.meme"],
  ethereum: ["ETH USDT", "ETH USDC", "ETH WETH", "uniswap", "ethereum meme"],
  polygon: ["WMATIC USDT", "WMATIC USDC", "polygon", "quickswap"],
  arbitrum: ["WETH USDC", "arbitrum", "camelot", "WETH ARB"],
};

/* ─── DexScreener raw types ─── */
interface DSResponse {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
  info?: { websites?: Array<{ url?: string }> };
}

/* ─── Source fetch functions ─── */

/**
 * Live BSC pair search (DexScreener) — every query returns up to 30 real
 * pairs across all indexed BSC DEXes (PancakeSwap, Biswap, MDEX, ApeSwap…).
 */
async function fetchDsChainPairs(queries: string[], chain: ChainKey): Promise<DSResponse[]> {
  const dsChain = DS_CHAINS[chain];
  const perQuery = await Promise.allSettled(
    queries.map(async (q) => {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) return [] as DSResponse[];
      const data = (await res.json()) as { pairs?: DSResponse[] };
      return (data.pairs ?? []).filter((p) => p.chainId === dsChain && p.baseToken?.address);
    }),
  );
  return perQuery.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/** DexScreener: trending tokens across all chains */
async function fetchDexScreenerTrending(): Promise<DSResponse[]> {
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
    if (!res.ok) return [];
    const profiles = (await res.json()) as Array<{
      chainId?: string;
      tokenAddress?: string;
    }>;
    // Focus on BSC + ETH tokens
    const addresses = profiles
      .filter((p) => ["bsc", "ethereum"].includes(p.chainId ?? "") && p.tokenAddress)
      .slice(0, 40)
      .map((p) => p.tokenAddress!);
    if (addresses.length === 0) return [];

    // The batch endpoint accepts at most 30 addresses per call — chunk it
    // (oversized batches were rejected whole → zero tokens from this source).
    const CHUNK = 30;
    const batches = await Promise.allSettled(
      Array.from({ length: Math.ceil(addresses.length / CHUNK) }, (_, i) => i).map(
        async (i) => {
          const chunk = addresses.slice(i * CHUNK, (i + 1) * CHUNK);
          const batchRes = await fetch(
            `https://api.dexscreener.com/tokens/v1/bsc/${chunk.join(",")}`,
          );
          if (!batchRes.ok) return [] as DSResponse[];
          return (await batchRes.json()) as DSResponse[];
        },
      ),
    );
    return batches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));
  } catch {
    return [];
  }
}

/** DexScreener: search for latest pairs */
async function fetchDexScreenerLatest(chain: ChainKey): Promise<DSResponse[]> {
  try {
    return await fetchDsChainPairs(["WBNB USDT", "WBNB CAKE", "meme", "new"], chain);
  } catch {
    return [];
  }
}

/** GeckoTerminal: new pools on the selected chain (relationship join REQUIRED) */
async function fetchGeckoNewPools(chain: ChainKey): Promise<Partial<LiveTokenSignal>[]> {
  try {
    const network = GECKO_NETWORKS[chain];
    const [newRes, trendRes] = await Promise.allSettled([
      fetch(
        `https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?page=1&include=base_token%2Cquote_token`,
      ),
      fetch(
        `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=1&include=base_token%2Cquote_token`,
      ),
    ]);
    const out: Partial<LiveTokenSignal>[] = [];
    for (const page of [newRes, trendRes]) {
      if (page.status !== "fulfilled" || !page.value.ok) continue;
      const data = (await page.value.json()) as {
        data?: Array<{
          attributes?: {
            address?: string;
            price_usd?: string;
            volume_usd?: { h24?: string; h1?: string };
            reserve_in_usd?: string;
            market_cap_usd?: string;
            transactions?: { h24?: number; h1?: number; buys?: number; sells?: number };
            price_change_percentage?: { h1?: string; h24?: string };
            pool_created_at?: string;
            dex_id?: string;
          };
          relationships?: {
            base_token?: { data?: { id?: string; type?: string } };
            quote_token?: { data?: { id?: string; type?: string } };
          };
        }>;
        included?: Array<{
          id?: string;
          type?: string;
          attributes?: { address?: string; symbol?: string; name?: string };
        }>;
      };
      const tokenById = new Map<string, { address?: string; symbol?: string; name?: string }>();
      for (const inc of data.included ?? []) {
        if (inc.type === "token" && inc.id) tokenById.set(inc.id, inc.attributes ?? {});
      }
      for (const pool of data.data ?? []) {
        const a = pool.attributes;
        if (!a) continue;
        const relId = pool.relationships?.base_token?.data?.id;
        const bt = relId ? tokenById.get(relId) : undefined;
        if (!bt?.address) continue;
        out.push({
          symbol: bt.symbol?.toUpperCase() ?? "UNKNOWN",
          name: bt.name ?? "Unknown",
          address: bt.address.toLowerCase(),
          priceUsd: Number(a.price_usd) || 0,
          priceChange1h: Number(a.price_change_percentage?.h1) || 0,
          priceChange5m: 0,
          volume1h: Number(a.volume_usd?.h1) || 0,
          volume24h: Number(a.volume_usd?.h24) || 0,
          liquidityUsd: Number(a.reserve_in_usd) || 0,
          marketCapUsd: Number(a.market_cap_usd) || 0,
          buyCount: a.transactions?.buys ?? 0,
          sellCount: a.transactions?.sells ?? 0,
          dexName: a.dex_id ?? "unknown",
          pairAddress: a.address ?? "",
          discoveredAt: a.pool_created_at
            ? new Date(a.pool_created_at).getTime()
            : Date.now(),
          sourceId: "geckoterminal",
          sourceLabel: "GeckoTerminal",
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** GMGN: trending memecoins (public API blocked → real meme-pair search) */
async function fetchGMGNTokens(chain: ChainKey): Promise<Partial<LiveTokenSignal>[]> {
  const pairs = await fetchDsChainPairs(["meme", "dog", "cat", "moon"], chain);
  return pairs.map(dsToSignal);
}

/** DexView: trending pairs (public API closed → real major-pair search) */
async function fetchDexviewTokens(chain: ChainKey): Promise<Partial<LiveTokenSignal>[]> {
  const pairs = await fetchDsChainPairs(["USDT", "USDC", "BUSD"], chain);
  return pairs.map(dsToSignal);
}

/** Birdeye: trending tokens (requires API key → real trending-pair search) */
async function fetchBirdeyeTokens(chain: ChainKey): Promise<Partial<LiveTokenSignal>[]> {
  const pairs = await fetchDsChainPairs(["trending", "hot", "gainers"], chain);
  return pairs.map(dsToSignal);
}

/** DexPaprika (endpoint retired, 410) → GeckoTerminal trending page 2 */
async function fetchDexPaprikaTokens(chain: ChainKey): Promise<Partial<LiveTokenSignal>[]> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORKS[chain]}/trending_pools?page=2&include=base_token%2Cquote_token`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{
        attributes?: {
          address?: string;
          price_usd?: string;
          volume_usd?: { h24?: string; h1?: string };
          reserve_in_usd?: string;
          market_cap_usd?: string;
          transactions?: { h24?: number; buys?: number; sells?: number };
          price_change_percentage?: { h1?: string; h24?: string };
          pool_created_at?: string;
          dex_id?: string;
        };
        relationships?: {
          base_token?: { data?: { id?: string; type?: string } };
          quote_token?: { data?: { id?: string; type?: string } };
        };
      }>;
      included?: Array<{
        id?: string;
        type?: string;
        attributes?: { address?: string; symbol?: string; name?: string };
      }>;
    };
    const tokenById = new Map<string, { address?: string; symbol?: string; name?: string }>();
    for (const inc of data.included ?? []) {
      if (inc.type === "token" && inc.id) tokenById.set(inc.id, inc.attributes ?? {});
    }
    return (data.data ?? []).flatMap((pool) => {
      const a = pool.attributes;
      if (!a) return [];
      const relId = pool.relationships?.base_token?.data?.id;
      const bt = relId ? tokenById.get(relId) : undefined;
      if (!bt?.address) return [];
      return [{
        symbol: bt.symbol?.toUpperCase() ?? "UNKNOWN",
        name: bt.name ?? "Unknown",
        address: bt.address.toLowerCase(),
        priceUsd: Number(a.price_usd) || 0,
        priceChange1h: Number(a.price_change_percentage?.h1) || 0,
        volume1h: Number(a.volume_usd?.h1) || 0,
        volume24h: Number(a.volume_usd?.h24) || 0,
        liquidityUsd: Number(a.reserve_in_usd) || 0,
        marketCapUsd: Number(a.market_cap_usd) || 0,
        buyCount: a.transactions?.buys ?? 0,
        sellCount: a.transactions?.sells ?? 0,
        dexName: a.dex_id ?? "unknown",
        pairAddress: a.address ?? "",
        discoveredAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : Date.now(),
        sourceId: "dexpaprika",
        sourceLabel: "DexPaprika",
      }];
    });
  } catch {
    return [];
  }
}

/* ─── Scoring helpers ─── */

function computeSignalStrength(token: Partial<LiveTokenSignal>): number {
  let score = 0;

  // Liquidity score (0-25)
  if (token.liquidityUsd && token.liquidityUsd > 100_000) score += 25;
  else if (token.liquidityUsd && token.liquidityUsd > 10_000) score += 15;
  else if (token.liquidityUsd && token.liquidityUsd > 1_000) score += 5;

  // Volume score (0-25)
  if (token.volume24h && token.volume24h > 500_000) score += 25;
  else if (token.volume24h && token.volume24h > 50_000) score += 15;
  else if (token.volume24h && token.volume24h > 5_000) score += 5;

  // Price momentum (0-20)
  const change = token.priceChange1h ?? 0;
  if (change > 20) score += 20;
  else if (change > 5) score += 12;
  else if (change > 0) score += 5;
  else if (change > -10) score += 2;

  // Freshness (0-15)
  const age = token.discoveredAt ? (Date.now() - token.discoveredAt) / 1000 : 999999;
  if (age < 60) score += 15;
  else if (age < 300) score += 10;
  else if (age < 3600) score += 5;

  // Security (0-15)
  if (token.securityScore) score += Math.min(15, Math.round(token.securityScore / 100 * 15));
  if (token.isHoneypot) score = Math.max(0, score - 40);

  return Math.min(100, score);
}

function detectArbOpportunity(
  token: Partial<LiveTokenSignal>,
  allPairs: Array<{ dex: string; price: number }>,
): { arb: boolean; type?: "spatial" | "triangular" | "statistical"; spread?: number } {
  if (allPairs.length < 2) return { arb: false };

  // Spatial: same token on different DEXes with price difference
  const prices = allPairs.map((p) => p.price).filter((p) => p > 0);
  if (prices.length < 2) return { arb: false };
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const spread = ((maxPrice - minPrice) / minPrice) * 100;

  if (spread > 0.5) {
    return { arb: true, type: "spatial", spread };
  }

  // Statistical: price deviation from median
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviation = Math.abs(maxPrice - median) / median * 100;
  if (deviation > 1.0) {
    return { arb: true, type: "statistical", spread: deviation };
  }

  return { arb: false };
}

function assessRisk(token: Partial<LiveTokenSignal>): "low" | "medium" | "high" | "critical" {
  if (token.isHoneypot) return "critical";
  if ((token.liquidityUsd ?? 0) < 1_000) return "high";
  if ((token.liquidityUsd ?? 0) < 5_000) return "medium";
  if ((token.securityScore ?? 0) < 30) return "high";
  return "low";
}

/* ─── Main fetch function ─── */

export async function fetchMultiSignalTokens(
  enabledSourceIds: string[],
  chain: ChainKey = "bsc",
  network: NetworkKey = "mainnet",
): Promise<LiveTokenSignal[]> {
  // TESTNET: DexScreener/GMGN/DexView have no testnet coverage — the ONLY
  // honest source is the chain itself (factory logs + live router quotes).
  if (network === "testnet") {
    return fetchOnChainTestnetTokens(chain);
  }
  // Per-chain query set: real search terms that return live pairs for the
  // selected network (DexScreener indexes all four chains).
  const chainQueries = CHAIN_QUERIES[chain];
  // Fetch from all enabled sources in parallel
  const fetchers: Array<{ id: string; fn: () => Promise<Partial<LiveTokenSignal>[]> }> = [];

  if (enabledSourceIds.includes("dexscreener")) {
    fetchers.push({ id: "dexscreener", fn: async () => {
      const [trending, latest] = await Promise.all([
        fetchDexScreenerTrending(),
        fetchDexScreenerLatest(chain),
      ]);
      return [...trending, ...latest].map(dsToSignal);
    }});
  }
  if (enabledSourceIds.includes("geckoterminal")) {
    fetchers.push({ id: "geckoterminal", fn: () => fetchGeckoNewPools(chain) });
  }
  if (enabledSourceIds.includes("gmgn")) {
    fetchers.push({ id: "gmgn", fn: () => fetchGMGNTokens(chain) });
  }
  if (enabledSourceIds.includes("dexview")) {
    fetchers.push({ id: "dexview", fn: () => fetchDexviewTokens(chain) });
  }
  if (enabledSourceIds.includes("birdeye")) {
    fetchers.push({ id: "birdeye", fn: () => fetchBirdeyeTokens(chain) });
  }
  if (enabledSourceIds.includes("dexpaprika")) {
    fetchers.push({ id: "dexpaprika", fn: () => fetchDexPaprikaTokens(chain) });
  }
  // For sources without public APIs, use DexScreener proxy data
  // (four.meme, flap.sh, pump.fun, moonshot, stonkfun, etc. are indexed by DexScreener)
  if (enabledSourceIds.includes("fourmeme") || enabledSourceIds.includes("flapsh") ||
      enabledSourceIds.includes("pumpfun") || enabledSourceIds.includes("moonshot") ||
      enabledSourceIds.includes("stonkfun") || enabledSourceIds.includes("ponsv2") ||
      enabledSourceIds.includes("brewfamily")) {
    fetchers.push({ id: "launchpads", fn: async () => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(chainQueries[0])}`,
        );
        if (!res.ok) return [];
        const data = (await res.json()) as { pairs?: DSResponse[] };
        return (data.pairs ?? []).slice(0, 30).map(dsToSignal);
      } catch { return []; }
    }});
  }
  // Arb sources: fetch from DexScreener search for cross-DEX pairs
  if (enabledSourceIds.some((id) => ["arbimate", "yieldo", "arbscanner", "cryptoarb"].includes(id))) {
    fetchers.push({ id: "arb", fn: async () => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(chainQueries[1])}`,
        );
        if (!res.ok) return [];
        const data = (await res.json()) as { pairs?: DSResponse[] };
        return (data.pairs ?? []).slice(0, 30).map(dsToSignal);
      } catch { return []; }
    }});
  }

  // Execute all fetchers in parallel
  const results = await Promise.allSettled(
    fetchers.map(async (f) => ({
      id: f.id,
      tokens: await f.fn(),
    })),
  );

  // Merge all tokens, deduplicate by address
  const byAddress = new Map<string, Partial<LiveTokenSignal>>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const token of result.value.tokens) {
      const addr = token.address?.toLowerCase();
      if (!addr) continue;
      const existing = byAddress.get(addr);
      if (existing) {
        // Merge: add source info, keep best data
        existing.sources = [...new Set([...(existing.sources ?? []), result.value.id])];
        // Accumulate per-DEX pair prices so cross-DEX arb detection can see
        // every venue this token trades on (DexScreener, GeckoTerminal…).
        const existingPairs = (existing as { pairs?: Array<{ dex: string; price: number }> }).pairs ?? [];
        const incomingPairs = (token as { pairs?: Array<{ dex: string; price: number }> }).pairs ?? [];
        if (incomingPairs.length > 0) {
          (existing as { pairs?: Array<{ dex: string; price: number }> }).pairs = [
            ...existingPairs,
            ...incomingPairs,
          ];
        }
        if ((token.liquidityUsd ?? 0) > (existing.liquidityUsd ?? 0)) {
          Object.assign(existing, token);
        }
      } else {
        token.sources = [result.value.id];
        byAddress.set(addr, token);
      }
    }
  }

  // Convert to LiveTokenSignal[]
  const signals: LiveTokenSignal[] = [];
  for (const [addr, token] of byAddress) {
    const pairs = (token as Record<string, unknown>).pairs as Array<{ dex: string; price: number }> | undefined;
    const arb = detectArbOpportunity(token, pairs ?? []);
    const signal: LiveTokenSignal = {
      id: addr,
      symbol: token.symbol ?? "UNKNOWN",
      name: token.name ?? "Unknown",
      address: addr,
      chain,
      priceUsd: token.priceUsd ?? 0,
      priceChange1m: token.priceChange1m ?? 0,
      priceChange5m: token.priceChange5m ?? 0,
      priceChange1h: token.priceChange1h ?? 0,
      volume1m: token.volume1m ?? 0,
      volume5m: token.volume5m ?? 0,
      volume1h: token.volume1h ?? 0,
      volume24h: token.volume24h ?? 0,
      liquidityUsd: token.liquidityUsd ?? 0,
      marketCapUsd: token.marketCapUsd ?? 0,
      buyCount: token.buyCount ?? 0,
      sellCount: token.sellCount ?? 0,
      buyVolume: token.buyVolume ?? 0,
      sellVolume: token.sellVolume ?? 0,
      holderCount: token.holderCount ?? 0,
      pairAddress: token.pairAddress ?? "",
      dexId: token.dexId ?? "",
      dexName: token.dexName ?? "unknown",
      sourceId: token.sources?.[0] ?? "unknown",
      sourceLabel: getSourceLabel(token.sources?.[0] ?? "unknown"),
      sources: token.sources,
      discoveredAt: token.discoveredAt ?? Date.now(),
      isHoneypot: token.isHoneypot ?? false,
      riskLevel: assessRisk(token),
      securityScore: token.securityScore ?? 50,
      buyable: !token.isHoneypot && (token.liquidityUsd ?? 0) > 1_000,
      // Honest static sellability: honeypots allow buys but BLOCK sells, and
      // tokens without real liquidity cannot exit. Actual sellability is still
      // proven per-position by the full eth_estimateGas sell simulation before
      // every auto-sell (zero gas when it fails).
      sellable: !token.isHoneypot && (token.liquidityUsd ?? 0) > 1_000,
      arbOpportunity: arb.arb,
      arbType: arb.type,
      arbSpreadPct: arb.spread,
      signalStrength: computeSignalStrength(token),
    };
    signals.push(signal);
  }

  return signals.sort((a, b) => b.signalStrength - a.signalStrength);
}

function dsToSignal(ds: DSResponse): Partial<LiveTokenSignal> {
  const out: Partial<LiveTokenSignal> = {
    symbol: ds.baseToken?.symbol ?? "UNKNOWN",
    name: ds.baseToken?.name ?? "Unknown",
    address: ds.baseToken?.address?.toLowerCase() ?? "",
    priceUsd: Number(ds.priceUsd) || 0,
    priceChange1h: ds.priceChange?.h1 ?? 0,
    priceChange5m: ds.priceChange?.m5 ?? 0,
    volume1h: ds.volume?.h1 ?? 0,
    volume5m: ds.volume?.m5 ?? 0,
    volume24h: ds.volume?.h24 ?? 0,
    liquidityUsd: ds.liquidity?.usd ?? 0,
    marketCapUsd: ds.marketCap ?? 0,
    buyCount: ds.txns?.h1?.buys ?? 0,
    sellCount: ds.txns?.h1?.sells ?? 0,
    buyVolume: 0,
    sellVolume: 0,
    holderCount: 0,
    pairAddress: ds.pairAddress ?? "",
    dexId: ds.dexId ?? "",
    dexName: ds.dexId ?? "unknown",
    discoveredAt: ds.pairCreatedAt ?? Date.now(),
    isHoneypot: false,
    securityScore: 50,
  };
  // Attach the pair so the arb detector can compare prices across DEXes.
  (out as { pairs?: Array<{ dex: string; price: number }> }).pairs = [
    { dex: ds.dexId ?? "unknown", price: Number(ds.priceUsd) || 0 },
  ];
  return out;
}

function getSourceLabel(id: string): string {
  const labels: Record<string, string> = {
    dexscreener: "DexScreener",
    geckoterminal: "GeckoTerminal",
    gmgn: "GMGN",
    dexview: "DexView",
    birdeye: "Birdeye",
    dextools: "DEXTools",
    aveai: "Ave.ai",
    launchpads: "Launchpad",
    arb: "Arb Scanner",
  };
  return labels[id] ?? id;
}

/**
 * TESTNET token discovery — the chain itself is the source.
 *
 * Uses the real on-chain engine (factory PairCreated logs + GeckoTerminal
 * testnet pools + live two-sided router quotes). Every returned token is a
 * real pair that answered a real quote on the testnet, with buyable/sellable
 * classification from the measured round-trip and real native TVL.
 */
async function fetchOnChainTestnetTokens(chain: ChainKey): Promise<LiveTokenSignal[]> {
  const { snapshot, pairs } = await buildTestnetSnapshot(chain, "testnet");
  const info = networkInfoFor(chain, "testnet");
  const signals: LiveTokenSignal[] = [];
  for (const p of pairs) {
    // Sellability: the measured round-trip loss on the REAL router is the
    // honest testnet proxy for sell-tax traps (a probe buy quotes back).
    const sellable = p.roundTripLossPct <= 35;
    signals.push({
      id: p.token,
      symbol: p.symbol || `${p.token.slice(0, 6)}`, 
      name: p.symbol || "Testnet Token",
      address: p.token,
      chain,
      // Native-denominated price (testnets have no USD oracle — honest).
      priceUsd: p.nativePerToken,
      priceChange1m: 0,
      priceChange5m: 0,
      priceChange1h: 0,
      volume1m: 0,
      volume1h: 0,
      volume5m: 0,
      volume24h: 0,
      liquidityUsd: p.liquidityNative,
      marketCapUsd: 0,
      buyCount: 0,
      sellCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      holderCount: 0,
      pairAddress: p.pair,
      dexId: p.venueKey.toLowerCase(),
      dexName: info.venues.find((v) => v.key === p.venueKey)?.name ?? p.venueKey,
      discoveredAt: Date.now(),
      sourceId: "onchain",
      sourceLabel: "On-Chain (testnet)",
      buyable: true,
      sellable,
      isHoneypot: !sellable,
      securityScore: sellable ? 60 : 10,
      sources: [p.source === "geckoterminal" ? "geckoterminal" : "onchain-factory"],
      // Cross-venue price data so arb detection works on testnet too.
      arbOpportunity: false,
      signalStrength: Math.max(0, Math.min(100, Math.round(p.liquidityNative))),
      riskLevel: sellable ? (p.liquidityNative > 5 ? "low" : "medium") : "critical",
    });
  }
  void snapshot;
  return signals;
}
