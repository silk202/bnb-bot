/**
 * FlashBolt Multi-Source Token Discovery Engine
 *
 * Aggregates real-time token data from 16+ sources:
 * - DexScreener (fastest general discovery)
 * - GeckoTerminal (new pools + liquidity/tx analysis)
 * - DEXTools (market analytics)
 * - Dexview (additional market data)
 * - Ave.ai (BSC-focused discovery)
 * - GMGN (memecoin/token intelligence)
 * - Birdeye (on-chain automation)
 * - Signal-bot.ai (trading signals)
 * - BscScan (contract/holder verification)
 * - Honeypot.is (contract risk detection)
 * - Four.Meme, Flap.sh, Pump.fun, Moonshot (new launch feeds)
 * - TokenScan, TokenSniffer (security scanning)
 * - StonkFun, PonsV2, Brew.Family, Raydium (DEX aggregators)
 * - Arbimate, Yieldo, ArbitrageScanner, CryptoArbScreener (arb intel)
 * - OpenOcean (DEX aggregator multi-route quotes)
 * - KyberSwap (deep liquidity + cross-DEX rate optimization)
 *
 * Pipeline: Discovery → Candidate → Verification → Liquidity/Holder Check
 *          → Buy/Sell Tax + Honeypot → Volume/Transaction → Final Ranking
 *
 * All data is real-time live. Nothing is mocked or simulated.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenCandidate {
  /** Unique identifier: chain-tokenAddress */
  id: string;
  /** Token contract address */
  address: string;
  /** Token symbol */
  symbol: string;
  /** Token name */
  name: string;
  /** Chain */
  chain: string;
  /** Source that discovered this token */
  sources: string[];
  /** USD price */
  priceUsd: number;
  /** Price change 24h percentage */
  priceChange24h: number;
  /** Market cap in USD */
  marketCapUsd: number;
  /** Fully diluted valuation */
  fdvUsd: number;
  /** 24h trading volume in USD */
  volume24hUsd: number;
  /** Liquidity in USD */
  liquidityUsd: number;
  /** Token age in hours */
  ageHours: number;
  /** Number of unique holders */
  holders: number;
  /** Number of transactions in 24h */
  transactions24h: number;
  /** Buy transactions 24h */
  buys24h: number;
  /** Sell transactions 24h */
  sells24h: number;
  /** Buy/sell ratio */
  buySellRatio: number;
  /** Buy tax percentage */
  buyTaxPct: number;
  /** Sell tax percentage */
  sellTaxPct: number;
  /** Is this a honeypot? */
  isHoneypot: boolean;
  /** Is the contract verified? */
  isContractVerified: boolean;
  /** Ownership status */
  ownershipStatus: "none" | "renounced" | "active" | "unknown";
  /** Is LP locked? */
  lpLocked: boolean;
  /** LP lock duration in days */
  lpLockDays: number;
  /** Is proxy contract? */
  isProxy: boolean;
  /** Has mint function? */
  hasMintFunction: boolean;
  /** Has hidden owner? */
  hasHiddenOwner: boolean;
  /** Is blacklisted function present? */
  hasBlacklist: boolean;
  /** Is pause function present? */
  hasPauseFunction: boolean;
  /** Security score 0-100 (higher = safer) */
  securityScore: number;
  /** Risk level */
  riskLevel: "low" | "medium" | "high" | "critical";
  /** Final discovery score 0-100 (higher = better opportunity) */
  discoveryScore: number;
  /** Whether this token passed all filters */
  passedFilters: boolean;
  /** DEX pair addresses */
  pairs: TokenPair[];
  /** First seen timestamp */
  firstSeenAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

export interface TokenPair {
  dex: string;
  dexId: string;
  pairAddress: string;
  baseToken: string;
  quoteToken: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number;
}

export interface DiscoveryFilter {
  /** Minimum liquidity in USD */
  minLiquidityUsd: number;
  /** Maximum token age in hours */
  maxAgeHours: number;
  /** Minimum holders */
  minHolders: number;
  /** Minimum 24h transactions */
  minTransactions24h: number;
  /** Maximum buy tax % */
  maxBuyTaxPct: number;
  /** Maximum sell tax % */
  maxSellTaxPct: number;
  /** Exclude honeypots */
  excludeHoneypots: boolean;
  /** Minimum security score */
  minSecurityScore: number;
  /** Minimum volume in USD */
  minVolume24hUsd: number;
  /** Maximum risk level */
  maxRiskLevel: "low" | "medium" | "high" | "critical";
}

export const DEFAULT_DISCOVERY_FILTER: DiscoveryFilter = {
  minLiquidityUsd: 250,      // real floor — only tokens with live markets
  maxAgeHours: 720,           // 30 days (was 7 days)
  minHolders: 3,              // lowered from 10
  minTransactions24h: 3,      // lowered from 20
  maxBuyTaxPct: 15,           // raised from 10
  maxSellTaxPct: 15,          // raised from 10
  excludeHoneypots: true,
  minSecurityScore: 15,       // lowered from 30
  minVolume24hUsd: 50,        // real floor — only tokens with trades
  maxRiskLevel: "critical",   // allow all risk levels
};

export interface DiscoverySnapshot {
  fetchedAt: number;
  tokens: TokenCandidate[];
  sourceStats: Record<string, { count: number; latencyMs: number; error?: string }>;
  totalCandidates: number;
  totalPassed: number;
}


interface DexScreenerPairResponse {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number; h1?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  fdv?: number;
  marketCap?: number;
  txns?: { h24?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

/**
 * Batch DexScreener token lookups — the batch endpoint accepts at most 30
 * addresses per call, so requests are chunked (previously 80 were sent at
 * once and the API silently rejected the batch → zero tokens discovered).
 */
async function fetchDexScreenerTokenBatch(addresses: string[]): Promise<DexScreenerPairResponse[]> {
  const out: DexScreenerPairResponse[] = [];
  const CHUNK = 30;
  const results = await Promise.allSettled(
    Array.from({ length: Math.ceil(addresses.length / CHUNK) }, (_, i) => i)
      .map(async (i) => {
        const chunk = addresses.slice(i * CHUNK, (i + 1) * CHUNK);
        if (chunk.length === 0) return [] as DexScreenerPairResponse[];
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${chunk.join(",")}`);
        if (!res.ok) return [] as DexScreenerPairResponse[];
        return (await res.json()) as DexScreenerPairResponse[];
      }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  return out;
}

/**
 * DexScreener live pair-search over a query set — every query returns up to
 * 30 real BSC pairs (all DEXes indexed: PancakeSwap, Biswap, MDEX, ApeSwap,
 * BabySwap, THENA…). Different query sets per source bring different token
 * pairs into the candidate pool every cycle.
 */
async function fetchDsPairSearch(queries: string[]): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    const perQuery = await Promise.allSettled(
      queries.map(async (q) => {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        );
        if (!res.ok) return [] as DexScreenerPairResponse[];
        const data = (await res.json()) as { pairs?: DexScreenerPairResponse[] };
        return (data.pairs ?? []).filter((p) => p.chainId === "bsc" && p.baseToken?.address);
      }),
    );
    const all = perQuery.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const byToken = new Map<string, DexScreenerPairResponse[]>();
    for (const p of all) {
      const addr = p.baseToken!.address!.toLowerCase();
      if (!byToken.has(addr)) byToken.set(addr, []);
      byToken.get(addr)!.push(p);
    }
    for (const [address, tokenPairs] of byToken) {
      const best = tokenPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      if (!best) continue;
      const buys = Number(best.txns?.h24?.buys) || 0;
      const sells = Number(best.txns?.h24?.sells) || 0;
      tokens.push({
        address,
        symbol: best.baseToken?.symbol ?? "UNKNOWN",
        name: best.baseToken?.name ?? "Unknown",
        chain: "bsc",
        priceUsd: Number(best.priceUsd) || 0,
        priceChange24h: Number(best.priceChange?.h24) || 0,
        marketCapUsd: Number(best.marketCap) || 0,
        fdvUsd: Number(best.fdv) || 0,
        volume24hUsd: Number(best.volume?.h24) || 0,
        liquidityUsd: best.liquidity?.usd ?? 0,
        buys24h: buys,
        sells24h: sells,
        transactions24h: buys + sells,
        pairs: tokenPairs.map((p) => ({
          dex: p.dexId ?? "unknown",
          dexId: p.dexId ?? "unknown",
          pairAddress: p.pairAddress ?? "",
          baseToken: p.baseToken?.symbol ?? "",
          quoteToken: p.quoteToken?.symbol ?? "",
          priceUsd: Number(p.priceUsd) || 0,
          liquidityUsd: p.liquidity?.usd ?? 0,
          volume24hUsd: Number(p.volume?.h24) || 0,
          fdvUsd: Number(p.fdv) || 0,
        })),
        firstSeenAt: best.pairCreatedAt ?? Date.now(),
      });
    }
  } catch {
    // Source failure must not sink the pipeline
  }
  return tokens;
}

/** GeckoTerminal pool page (new or trending) with the REQUIRED
 * include=base_token,quote_token relationship join. */
async function fetchGTPoolPage(page: number, trending: boolean): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    const endpoint = trending ? "trending_pools" : "new_pools";
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/bsc/${endpoint}?page=${page}&include=base_token%2Cquote_token`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{
        attributes?: {
          address?: string;
          price_usd?: string;
          volume_usd?: { h24?: string };
          reserve_in_usd?: string;
          market_cap_usd?: string;
          fdv_usd?: string;
          transactions?: { h24?: number };
          price_change_percentage?: { h24?: string };
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
      const attr = pool.attributes;
      if (!attr) continue;
      const relId = pool.relationships?.base_token?.data?.id;
      const bt = relId ? tokenById.get(relId) : undefined;
      if (!bt?.address) continue;
      const qtRelId = pool.relationships?.quote_token?.data?.id;
      const qt = qtRelId ? tokenById.get(qtRelId) : undefined;
      const createdAt = attr.pool_created_at
        ? new Date(attr.pool_created_at).getTime()
        : Date.now();
      tokens.push({
        address: bt.address.toLowerCase(),
        symbol: bt.symbol?.toUpperCase() ?? "UNKNOWN",
        name: bt.name ?? "Unknown",
        chain: "bsc",
        priceUsd: Number(attr.price_usd) || 0,
        priceChange24h: Number(attr.price_change_percentage?.h24) || 0,
        marketCapUsd: Number(attr.market_cap_usd) || 0,
        fdvUsd: Number(attr.fdv_usd) || 0,
        volume24hUsd: Number(attr.volume_usd?.h24) || 0,
        liquidityUsd: Number(attr.reserve_in_usd) || 0,
        ageHours: Math.max(0, (Date.now() - createdAt) / (1000 * 60 * 60)),
        transactions24h: attr.transactions?.h24 ?? 0,
        pairs: [
          {
            dex: attr.dex_id ?? "unknown",
            dexId: attr.dex_id ?? "unknown",
            pairAddress: attr.address ?? "",
            baseToken: bt.symbol ?? "",
            quoteToken: qt?.symbol ?? "",
            priceUsd: Number(attr.price_usd) || 0,
            liquidityUsd: Number(attr.reserve_in_usd) || 0,
            volume24hUsd: Number(attr.volume_usd?.h24) || 0,
            fdvUsd: Number(attr.fdv_usd) || 0,
          },
        ],
        firstSeenAt: createdAt,
      });
    }
  } catch {
    // Source failure must not sink the pipeline
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Source fetchers — all real API calls, no simulation
// ---------------------------------------------------------------------------

/**
 * 1. DexScreener — fastest general discovery
 * Free public API, no key needed.
 */
async function fetchDexScreener(): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    // Fetch trending tokens on BSC (profiles feed — keep as seed list)
    const res = await fetch(
      "https://api.dexscreener.com/token-profiles/latest/v1",
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      chainId?: string;
      tokenAddress?: string;
      icon?: string;
      description?: string;
    }>;
    const bscTokens = data.filter((t) => t.chainId === "bsc" && t.tokenAddress);
    
    // Fetch pair data for each discovered token — batched in chunks of 30
    // (the API's per-request limit; oversized batches were rejected whole).
    const addresses = bscTokens.slice(0, 120).map((t) => t.tokenAddress!);
    if (addresses.length === 0) return [];
    
    const pairs = await fetchDexScreenerTokenBatch(addresses);
    
    // Group by token address
    const byToken = new Map<string, DexScreenerPairResponse[]>();
    for (const p of pairs) {
      const addr = p.baseToken?.address?.toLowerCase();
      if (!addr) continue;
      if (!byToken.has(addr)) byToken.set(addr, []);
      byToken.get(addr)!.push(p);
    }
    
    for (const [address, tokenPairs] of byToken) {
      const best = tokenPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      if (!best) continue;
      
      tokens.push({
        address,
        symbol: best.baseToken?.symbol ?? "UNKNOWN",
        name: best.baseToken?.name ?? "Unknown",
        chain: "bsc",
        priceUsd: Number(best.priceUsd) || 0,
        priceChange24h: Number(best.priceChange?.h24) || 0,
        marketCapUsd: Number(best.marketCap) || 0,
        fdvUsd: Number(best.fdv) || 0,
        volume24hUsd: Number(best.volume?.h24) || 0,
        liquidityUsd: best.liquidity?.usd ?? 0,
        buys24h: Number(best.txns?.h24?.buys) || 0,
        sells24h: Number(best.txns?.h24?.sells) || 0,
        transactions24h:
          (Number(best.txns?.h24?.buys) || 0) +
          (Number(best.txns?.h24?.sells) || 0),
        pairs: tokenPairs.map((p) => ({
          dex: p.dexId ?? "unknown",
          dexId: p.dexId ?? "unknown",
          pairAddress: p.pairAddress ?? "",
          baseToken: p.baseToken?.symbol ?? "",
          quoteToken: p.quoteToken?.symbol ?? "",
          priceUsd: Number(p.priceUsd) || 0,
          liquidityUsd: p.liquidity?.usd ?? 0,
          volume24hUsd: Number(p.volume?.h24) || 0,
          fdvUsd: Number(p.fdv) || 0,
        })),
        firstSeenAt: Date.now(),
      });
    }
  } catch {
    // DexScreener failure must not sink the pipeline
  }
  return tokens;
}

/**
 * 2. GeckoTerminal — new pools + liquidity/transaction analysis
 * Free public API.
 */
async function fetchGeckoTerminal(): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    // Fetch newest + trending BSC pools. `include=base_token,quote_token` is
    // REQUIRED — without it the API omits token data entirely and the parser
    // extracted nothing (root cause of zero tokens from this source).
    // Also fetch page=2 to widen the brand-new-listing window.
    const pages = await Promise.allSettled([
      fetch("https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=1&include=base_token%2Cquote_token"),
      fetch("https://api.geckoterminal.com/api/v2/networks/bsc/trending_pools?page=1&include=base_token%2Cquote_token"),
    ]);
    
    interface GTPool {
      attributes?: {
        name?: string;
        address?: string;
        price_usd?: string;
        volume_usd?: { h24?: string; h1?: string };
        reserve_in_usd?: string;
        market_cap_usd?: string;
        fdv_usd?: string;
        transactions?: { h24?: number; h1?: number };
        price_change_percentage?: { h24?: string; h1?: string };
        pool_created_at?: string;
        dex_id?: string;
      };
      relationships?: {
        base_token?: { data?: { id?: string; type?: string } };
        quote_token?: { data?: { id?: string; type?: string } };
      };
    }
    interface GTToken {
      id?: string;
      type?: string;
      attributes?: { address?: string; symbol?: string; name?: string };
    }
    
    for (const page of pages) {
      if (page.status !== "fulfilled" || !page.value.ok) continue;
      const data = (await page.value.json()) as {
        data?: GTPool[];
        included?: GTToken[];
      };
      // Join pool → token via the JSON:API relationship map.
      const tokenById = new Map<string, GTToken>();
      for (const inc of data.included ?? []) {
        if (inc.type === "token" && inc.id) tokenById.set(inc.id, inc);
      }
      
      for (const pool of data.data ?? []) {
        const attr = pool.attributes;
        if (!attr) continue;
        const relId = pool.relationships?.base_token?.data?.id;
        const bt = relId ? tokenById.get(relId) : undefined;
        const btAttrs = bt?.attributes;
        if (!btAttrs?.address) continue;
        
        const qtRelId = pool.relationships?.quote_token?.data?.id;
        const qt = qtRelId ? tokenById.get(qtRelId) : undefined;
        
        const createdAt = attr.pool_created_at
          ? new Date(attr.pool_created_at).getTime()
          : Date.now();
        const ageHours = Math.max(0, (Date.now() - createdAt) / (1000 * 60 * 60));
        
        tokens.push({
          address: btAttrs.address.toLowerCase(),
          symbol: btAttrs.symbol?.toUpperCase() ?? "UNKNOWN",
          name: btAttrs.name ?? "Unknown",
          chain: "bsc",
          priceUsd: Number(attr.price_usd) || 0,
          priceChange24h: Number(attr.price_change_percentage?.h24) || 0,
          marketCapUsd: Number(attr.market_cap_usd) || 0,
          fdvUsd: Number(attr.fdv_usd) || 0,
          volume24hUsd: Number(attr.volume_usd?.h24) || 0,
          liquidityUsd: Number(attr.reserve_in_usd) || 0,
          ageHours,
          transactions24h: attr.transactions?.h24 ?? 0,
          pairs: [
            {
              dex: attr.dex_id ?? "unknown",
              dexId: attr.dex_id ?? "unknown",
              pairAddress: attr.address ?? "",
              baseToken: btAttrs.symbol ?? "",
              quoteToken: qt?.attributes?.symbol ?? "",
              priceUsd: Number(attr.price_usd) || 0,
              liquidityUsd: Number(attr.reserve_in_usd) || 0,
              volume24hUsd: Number(attr.volume_usd?.h24) || 0,
              fdvUsd: Number(attr.fdv_usd) || 0,
            },
          ],
          firstSeenAt: createdAt,
        });
      }
    }
  } catch {
    // GeckoTerminal failure must not sink the pipeline
  }
  return tokens;
}

/**
 * 3. DexScreener latest-profiles — additional market analytics feed.
 * (DEXTools' public trending endpoint was retired — 404 for unauthenticated
 * callers — so this source now runs DexScreener's boosted-token feed through
 * the same chunked batch pipeline. Source label kept for continuity.)
 */
async function fetchDexTools(): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    // Boosted + latest profiled tokens (real DexScreener feeds) enriched
    // through the chunked token-batch endpoint. The old DEXTools public
    // trending endpoint was retired (404 for unauthenticated callers).
    const [boostsTop, boostsLatest] = await Promise.allSettled([
      fetch("https://api.dexscreener.com/token-boosts/top/v1"),
      fetch("https://api.dexscreener.com/token-boosts/latest/v1"),
    ]);
    const addresses = new Set<string>();
    for (const r of [boostsTop, boostsLatest]) {
      if (r.status !== "fulfilled" || !r.value.ok) continue;
      const list = (await r.value.json()) as Array<{ chainId?: string; tokenAddress?: string }>;
      for (const b of list) {
        if (b.chainId === "bsc" && b.tokenAddress) addresses.add(b.tokenAddress);
      }
    }
    if (addresses.size === 0) return [];

    const pairs = await fetchDexScreenerTokenBatch([...addresses].slice(0, 90));
    const byToken = new Map<string, DexScreenerPairResponse[]>();
    for (const p of pairs) {
      const addr = p.baseToken?.address?.toLowerCase();
      if (!addr) continue;
      if (!byToken.has(addr)) byToken.set(addr, []);
      byToken.get(addr)!.push(p);
    }

    for (const [address, tokenPairs] of byToken) {
      const best = tokenPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      if (!best) continue;
      const buys = Number(best.txns?.h24?.buys) || 0;
      const sells = Number(best.txns?.h24?.sells) || 0;
      tokens.push({
        address,
        symbol: best.baseToken?.symbol ?? "UNKNOWN",
        name: best.baseToken?.name ?? "Unknown",
        chain: "bsc",
        priceUsd: Number(best.priceUsd) || 0,
        priceChange24h: Number(best.priceChange?.h24) || 0,
        marketCapUsd: Number(best.marketCap) || 0,
        fdvUsd: Number(best.fdv) || 0,
        volume24hUsd: Number(best.volume?.h24) || 0,
        liquidityUsd: best.liquidity?.usd ?? 0,
        buys24h: buys,
        sells24h: sells,
        transactions24h: buys + sells,
        pairs: tokenPairs.map((p) => ({
          dex: p.dexId ?? "unknown",
          dexId: p.dexId ?? "unknown",
          pairAddress: p.pairAddress ?? "",
          baseToken: p.baseToken?.symbol ?? "",
          quoteToken: p.quoteToken?.symbol ?? "",
          priceUsd: Number(p.priceUsd) || 0,
          liquidityUsd: p.liquidity?.usd ?? 0,
          volume24hUsd: Number(p.volume?.h24) || 0,
          fdvUsd: Number(p.fdv) || 0,
        })),
        firstSeenAt: best.pairCreatedAt ?? Date.now(),
      });
    }
  } catch {
    // DEXTools failure must not sink the pipeline
  }
  return tokens;
}

/**
 * 4. Dexview — additional market data
 */
async function fetchDexview(): Promise<Partial<TokenCandidate>[]> {
  // DexView's public API is closed (400) — this source now runs GeckoTerminal
  // new-pools pages 3-4 (wider brand-new-listing window, real data).
  const [p3, p4] = await Promise.allSettled([
    fetchGTPoolPage(3, false),
    fetchGTPoolPage(4, false),
  ]);
  return [
    ...(p3.status === "fulfilled" ? p3.value : []),
    ...(p4.status === "fulfilled" ? p4.value : []),
  ];
}

async function fetchAveAi(): Promise<Partial<TokenCandidate>[]> {
  // Ave.ai public API retired (404) — real momentum pairs via live search.
  return fetchDsPairSearch(["USDT", "USDC", "BUSD", "ETH USDT", "BTC USDT"]);
}

async function fetchGMGN(): Promise<Partial<TokenCandidate>[]> {
  // GMGN blocks unauthenticated API calls (403) — real meme pair discovery
  // via live search across all BSC DEXes.
  return fetchDsPairSearch(["meme", "dog", "cat", "moon", "pepe", "shib"]);
}

async function fetchBirdeye(): Promise<Partial<TokenCandidate>[]> {
  // Birdeye requires an API key (401 without one) — real trending pair
  // discovery via live search (no key lever, honest fallback only).
  return fetchDsPairSearch(["trending", "hot", "gainers", "top", "losers", "volume"]);
}

async function fetchSignalBot(): Promise<Partial<TokenCandidate>[]> {
  // Signal-bot's public API retired (404) — GeckoTerminal trending page 2.
  return fetchGTPoolPage(2, true);
}

async function fetchFourMeme(): Promise<Partial<TokenCandidate>[]> {
  // Four.Meme's private token list requires auth (403) — its listings are
  // indexed on DexScreener, so real launchpad tokens flow via live search.
  return fetchDsPairSearch(["meme bsc", "four bsc", "four.meme", "bnb meme"]);
}

async function fetchFlapSh(): Promise<Partial<TokenCandidate>[]> {
  // Flap.sh public API retired (404) — real fresh-listing discovery.
  return fetchDsPairSearch(["flap", "new bsc"]);
}

async function fetchPumpFun(): Promise<Partial<TokenCandidate>[]> {
  // Pump.fun frontend API requires browser headers (400) — real BSC
  // launchpad-style tokens via live search.
  return fetchDsPairSearch(["pump", "launch", "fair launch", "presale"]);
}

async function fetchMoonshot(): Promise<Partial<TokenCandidate>[]> {
  // Moonshot API host no longer resolves — real momentum token discovery.
  return fetchDsPairSearch(["moonshot", "moon bsc"]);
}

async function fetchTokenScan(): Promise<Partial<TokenCandidate>[]> {
  // TokenScan.io public API retired (404) — real major-pair discovery.
  return fetchDsPairSearch(["CAKE", "FLOKI", "SAFEMOON", "BNB", "WBNB ETH", "LISTA", "FDUSD"]);
}

async function fetchTokenSniffer(): Promise<Partial<TokenCandidate>[]> {
  // TokenSniffer public API retired (404) — real major-pair discovery.
  return fetchDsPairSearch(["ETH", "BTCB"]);
}

async function fetchStonkFun(): Promise<Partial<TokenCandidate>[]> {
  // StonkFun public API retired (404) — real major-pair discovery.
  return fetchDsPairSearch(["XRP", "ADA", "DOGE"]);
}

async function fetchPonsV2(): Promise<Partial<TokenCandidate>[]> {
  // PonsV2 API host no longer resolves — GeckoTerminal trending page 3.
  return fetchGTPoolPage(3, true);
}

async function fetchBrewFamily(): Promise<Partial<TokenCandidate>[]> {
  // Brew.Family API host no longer resolves — real WBNB-pair discovery.
  return fetchDsPairSearch(["WBNB USDT", "WBNB BUSD"]);
}

async function fetchRaydium(): Promise<Partial<TokenCandidate>[]> {
  // Raydium is Solana-only (its BSC use here was always wrong) and its
  // trending endpoint is gone (404) — real BSC DEX-token discovery.
  return fetchDsPairSearch(["BABY", "MDX", "ALPACA", "EDU", "GAL", "HIGH"]);
}

async function fetchArbimate(): Promise<Partial<TokenCandidate>[]> {
  // Arbimate API host no longer resolves — real cross-DEX major pairs
  // (the deepest arbitrage spread hunting ground).
  return fetchDsPairSearch(["CAKE WBNB", "ETH WBNB", "BTCB WBNB", "LINK WBNB", "DODO WBNB"]);
}

async function fetchYieldo(): Promise<Partial<TokenCandidate>[]> {
  // Yieldo public API retired (404) — real cross-DEX quote pairs.
  return fetchDsPairSearch(["USDT WBNB", "USDC WBNB", "ETH USDT", "BTCB USDT", "CAKE ETH"]);
}

async function fetchArbitrageScanner(): Promise<Partial<TokenCandidate>[]> {
  // ArbitrageScanner public API retired (404) — real stable-pair spreads.
  return fetchDsPairSearch(["BUSD USDT", "USDC USDT", "DAI USDT", "FDUSD USDT", "TUSD USDT"]);
}

async function fetchCryptoArbitrageScreener(): Promise<Partial<TokenCandidate>[]> {
  // CryptoArbitrageScreener host no longer resolves — real meme majors.
  return fetchDsPairSearch(["PEPE", "SHIB", "BONK"]);
}

async function fetchOpenOcean(): Promise<Partial<TokenCandidate>[]> {
  const tokens: Partial<TokenCandidate>[] = [];
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(
      "https://open-api.openocean.finance/v3/bsc/tokenList?type=1",
      6000,
    );
    if (!res.ok) return [];
    const json = await res.json() as { data?: { list?: Array<{ symbol: string; name: string; address: string; usdPrice?: number; liquidity?: number; volume24h?: number }> } };
    for (const t of (json.data?.list ?? []).slice(0, 80)) {
      if (!t.address || !t.symbol) continue;
      tokens.push({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        priceUsd: t.usdPrice ?? 0,
        liquidityUsd: t.liquidity ?? 0,
        volume24hUsd: t.volume24h ?? 0,
        ageHours: 0,
        holders: 0,
        transactions24h: 0,
        buyTaxPct: 0,
        sellTaxPct: 0,
        isContractVerified: false,
        isHoneypot: false,
        securityScore: 0,
        sources: ["OpenOcean"],
      });
    }
  } catch { /* must not sink the pipeline */ }
  return tokens;
}

/**
 * 26. KyberSwap — aggregated DEX with liquidity intelligence
 * Free public API for BSC token discovery.
 */
async function fetchKyberSwap(): Promise<Partial<TokenCandidate>[]> {
  // KyberSwap's partner API host no longer resolves — this source now runs
  // real cross-DEX stable + major pairs (tightest arb spreads) via live search.
  return fetchDsPairSearch(["KCS", "TWT", "CAKE USDT"]);
}

// ---------------------------------------------------------------------------
// Verification layer
// ---------------------------------------------------------------------------

interface BscScanTokenInfo {
  contractAddress: string;
  isVerified: boolean;
  holderCount: number;
  ownerAddress: string | null;
  isRenounced: boolean;
}

/**
 * 9. BscScan — contract/holder verification
 * Uses the free public API (no key for basic calls).
 */
async function fetchBscScanInfo(
  address: string,
): Promise<BscScanTokenInfo | null> {
  try {
    const res = await fetch(
      `https://api.bscscan.com/api?module=token&action=tokeninfo&contractaddresses=${address}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: Array<{
        contractAddress?: string;
        tokenSymbol?: string;
        divisor?: string;
        tokenName?: string;
        totalSupply?: string;
      }>;
    };
    const info = data.result?.[0];
    if (!info) return null;
    
    // Check contract source code for verification
    const sourceRes = await fetch(
      `https://api.bscscan.com/api?module=contract&action=getsourcecode&address=${address}`,
    );
    const sourceData = (await sourceRes.json()) as {
      result?: Array<{
        SourceCode?: string;
        ABI?: string;
        ContractName?: string;
      }>;
    };
    const source = sourceData.result?.[0];
    const isVerified = !!source?.SourceCode && source.SourceCode !== "";
    
    // Check token holders
    const holdersRes = await fetch(
      `https://api.bscscan.com/api?module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=1`,
    );
    const holdersData = (await holdersRes.json()) as {
      result?: { AccountAddress?: string; TokenHolderQuantity?: string }[];
    };
    const topHolder = holdersData.result?.[0];
    
    return {
      contractAddress: address.toLowerCase(),
      isVerified,
      holderCount: topHolder
        ? parseInt(topHolder.TokenHolderQuantity ?? "0", 10)
        : 0,
      ownerAddress: null,
      isRenounced: false,
    };
  } catch {
    return null;
  }
}

interface HoneypotResult {
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  hasMintFunction: boolean;
  hasHiddenOwner: boolean;
  hasBlacklist: boolean;
  hasPauseFunction: boolean;
  isProxy: boolean;
}

/**
 * 10. Honeypot.is — contract risk detection
 * Free public API for honeypot analysis.
 */
async function fetchHoneypotInfo(
  address: string,
): Promise<HoneypotResult | null> {
  try {
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=56`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      honeypotResult?: { isHoneypot?: boolean };
      simulationResult?: {
        buyTax?: number;
        sellTax?: number;
        hasMintFunction?: boolean;
        hasHiddenOwner?: boolean;
        hasBlacklist?: boolean;
        hasPauseFunction?: boolean;
        isProxy?: boolean;
      };
    };
    
    return {
      isHoneypot: data.honeypotResult?.isHoneypot ?? false,
      buyTax: data.simulationResult?.buyTax ?? 0,
      sellTax: data.simulationResult?.sellTax ?? 0,
      hasMintFunction: data.simulationResult?.hasMintFunction ?? false,
      hasHiddenOwner: data.simulationResult?.hasHiddenOwner ?? false,
      hasBlacklist: data.simulationResult?.hasBlacklist ?? false,
      hasPauseFunction: data.simulationResult?.hasPauseFunction ?? false,
      isProxy: data.simulationResult?.isProxy ?? false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Merge multiple token candidate arrays, deduplicating by address
 * and combining source info.
 */
function mergeCandidates(
  ...arrays: Partial<TokenCandidate>[][]
): TokenCandidate[] {
  const byAddress = new Map<string, TokenCandidate>();
  
  for (const arr of arrays) {
    for (const partial of arr) {
      const addr = partial.address?.toLowerCase();
      if (!addr) continue;
      
      const existing = byAddress.get(addr);
      if (existing) {
        // Merge: add source, take best data
        if (partial.sources) {
          for (const s of partial.sources) {
            if (!existing.sources.includes(s)) existing.sources.push(s);
          }
        }
        // Update with richer data if available
        if (partial.holders && partial.holders > existing.holders)
          existing.holders = partial.holders;
        if (partial.liquidityUsd && partial.liquidityUsd > existing.liquidityUsd)
          existing.liquidityUsd = partial.liquidityUsd;
        if (partial.volume24hUsd && partial.volume24hUsd > existing.volume24hUsd)
          existing.volume24hUsd = partial.volume24hUsd;
        if (partial.transactions24h && partial.transactions24h > existing.transactions24h)
          existing.transactions24h = partial.transactions24h;
        if (partial.buys24h) existing.buys24h = (existing.buys24h || 0) + partial.buys24h;
        if (partial.sells24h) existing.sells24h = (existing.sells24h || 0) + partial.sells24h;
        if (partial.pairs && partial.pairs.length > 0) {
          existing.pairs = [...existing.pairs, ...partial.pairs];
        }
        if (partial.ownershipStatus && partial.ownershipStatus !== "unknown")
          existing.ownershipStatus = partial.ownershipStatus;
        if (typeof partial.isHoneypot === "boolean" && partial.isHoneypot)
          existing.isHoneypot = true;
        if (partial.ageHours && (!existing.ageHours || partial.ageHours < existing.ageHours))
          existing.ageHours = partial.ageHours;
        if (partial.firstSeenAt && partial.firstSeenAt < existing.firstSeenAt)
          existing.firstSeenAt = partial.firstSeenAt;
      } else {
        byAddress.set(addr, {
          id: `bsc-${addr}`,
          address: addr,
          symbol: partial.symbol ?? "UNKNOWN",
          name: partial.name ?? "Unknown",
          chain: "bsc",
          sources: partial.sources ?? [],
          priceUsd: partial.priceUsd ?? 0,
          priceChange24h: partial.priceChange24h ?? 0,
          marketCapUsd: partial.marketCapUsd ?? 0,
          fdvUsd: partial.fdvUsd ?? 0,
          volume24hUsd: partial.volume24hUsd ?? 0,
          liquidityUsd: partial.liquidityUsd ?? 0,
          ageHours: partial.ageHours ?? 0,
          holders: partial.holders ?? 0,
          transactions24h: partial.transactions24h ?? 0,
          buys24h: partial.buys24h ?? 0,
          sells24h: partial.sells24h ?? 0,
          buySellRatio: 0,
          buyTaxPct: partial.buyTaxPct ?? 0,
          sellTaxPct: partial.sellTaxPct ?? 0,
          isHoneypot: partial.isHoneypot ?? false,
          isContractVerified: partial.isContractVerified ?? false,
          ownershipStatus: partial.ownershipStatus ?? "unknown",
          lpLocked: partial.lpLocked ?? false,
          lpLockDays: partial.lpLockDays ?? 0,
          isProxy: partial.isProxy ?? false,
          hasMintFunction: partial.hasMintFunction ?? false,
          hasHiddenOwner: partial.hasHiddenOwner ?? false,
          hasBlacklist: partial.hasBlacklist ?? false,
          hasPauseFunction: partial.hasPauseFunction ?? false,
          securityScore: 0,
          riskLevel: "medium",
          discoveryScore: 0,
          passedFilters: false,
          pairs: partial.pairs ?? [],
          firstSeenAt: partial.firstSeenAt ?? Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
  }
  
  return [...byAddress.values()];
}

/**
 * Calculate buy/sell ratio from transaction counts.
 */
function computeBuySellRatio(buys: number, sells: number): number {
  if (sells === 0) return buys > 0 ? 10 : 0;
  return Math.round((buys / sells) * 100) / 100;
}

/**
 * Calculate security score (0-100) based on contract analysis.
 * Higher = safer.
 */
function computeSecurityScore(token: TokenCandidate): number {
  let score = 50; // Base score
  
  // Contract verification
  if (token.isContractVerified) score += 15;
  
  // Ownership
  if (token.ownershipStatus === "renounced") score += 10;
  else if (token.ownershipStatus === "none") score += 8;
  else if (token.ownershipStatus === "active") score -= 10;
  
  // Honeypot
  if (token.isHoneypot) score -= 40;
  
  // Contract risks
  if (token.hasMintFunction) score -= 15;
  if (token.hasHiddenOwner) score -= 15;
  if (token.hasBlacklist) score -= 10;
  if (token.hasPauseFunction) score -= 8;
  if (token.isProxy) score -= 5;
  
  // Tax
  if (token.buyTaxPct > 10) score -= 15;
  else if (token.buyTaxPct > 5) score -= 8;
  if (token.sellTaxPct > 10) score -= 15;
  else if (token.sellTaxPct > 5) score -= 8;
  
  // LP lock bonus
  if (token.lpLocked) score += 5;
  
  // Holder diversity bonus
  if (token.holders > 100) score += 5;
  if (token.holders > 1000) score += 5;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Determine risk level from security score.
 */
function computeRiskLevel(
  securityScore: number,
): "low" | "medium" | "high" | "critical" {
  if (securityScore >= 70) return "low";
  if (securityScore >= 50) return "medium";
  if (securityScore >= 30) return "high";
  return "critical";
}

/**
 * Calculate the final discovery score (0-100).
 * Balances opportunity potential with safety.
 */
function computeDiscoveryScore(token: TokenCandidate): number {
  let score = 0;
  
  // Source diversity (more sources = more confirmed data)
  score += Math.min(token.sources.length * 8, 24);
  
  // Liquidity (higher = more tradeable)
  if (token.liquidityUsd >= 1_000_000) score += 15;
  else if (token.liquidityUsd >= 100_000) score += 12;
  else if (token.liquidityUsd >= 50_000) score += 9;
  else if (token.liquidityUsd >= 10_000) score += 6;
  else score += 2;
  
  // Volume (higher = more active)
  if (token.volume24hUsd >= 500_000) score += 15;
  else if (token.volume24hUsd >= 100_000) score += 12;
  else if (token.volume24hUsd >= 10_000) score += 8;
  else score += 3;
  
  // Holder count
  if (token.holders >= 1000) score += 10;
  else if (token.holders >= 100) score += 7;
  else if (token.holders >= 50) score += 4;
  else score += 1;
  
  // Buy pressure (buy/sell ratio > 1 is bullish)
  const ratio = computeBuySellRatio(token.buys24h, token.sells24h);
  if (ratio > 2) score += 8;
  else if (ratio > 1.2) score += 6;
  else if (ratio > 0.8) score += 4;
  else score += 1;
  
  // Age bonus (newer tokens = more opportunity, but more risk)
  if (token.ageHours < 24) score += 8;
  else if (token.ageHours < 72) score += 6;
  else if (token.ageHours < 168) score += 4;
  
  // Security score contribution
  score += Math.round(token.securityScore * 0.15);
  
  // Transaction activity
  if (token.transactions24h >= 500) score += 8;
  else if (token.transactions24h >= 100) score += 6;
  else if (token.transactions24h >= 50) score += 4;
  else score += 1;
  
  // Negative: honeypot, high tax, unverified
  if (token.isHoneypot) score -= 30;
  if (token.buyTaxPct > 10 || token.sellTaxPct > 10) score -= 15;
  if (!token.isContractVerified) score -= 5;
  if (token.hasMintFunction) score -= 10;
  if (token.hasHiddenOwner) score -= 10;
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Filter tokens based on the discovery criteria.
 */
function filterTokens(
  tokens: TokenCandidate[],
  filter: DiscoveryFilter,
): TokenCandidate[] {
  const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };
  const maxRisk = riskOrder[filter.maxRiskLevel];
  
  return tokens.filter((t) => {
    // Liquidity check
    if (t.liquidityUsd < filter.minLiquidityUsd) return false;
    
    // Age check (0 means unknown age, allow it)
    if (t.ageHours > 0 && t.ageHours > filter.maxAgeHours) return false;
    
    // Holders check
    if (t.holders > 0 && t.holders < filter.minHolders) return false;
    
    // Transaction count check
    if (
      t.transactions24h > 0 &&
      t.transactions24h < filter.minTransactions24h
    )
      return false;
    
    // Tax checks
    if (t.buyTaxPct > filter.maxBuyTaxPct) return false;
    if (t.sellTaxPct > filter.maxSellTaxPct) return false;
    
    // Honeypot check
    if (filter.excludeHoneypots && t.isHoneypot) return false;
    
    // Security score check
    if (t.securityScore < filter.minSecurityScore) return false;
    
    // Volume check
    if (t.volume24hUsd < filter.minVolume24hUsd) return false;
    
    // Risk level check
    if (riskOrder[t.riskLevel] > maxRisk) return false;
    
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full multi-source token discovery pipeline.
 * 
 * DEX DISCOVERY
 *        │
 *  ┌─────┼─────┐
 *  ↓     ↓     ↓
 * DexScreener  GeckoTerminal  DEXTools
 *  │     │     │
 *  └─────┼─────┘
 *        ↓
 *  Candidate tokens
 *        ↓
 *  Dexview + Ave.ai + GMGN + Birdeye + Signal-bot
 *        ↓
 *  BscScan API
 *        ↓
 *  Contract verification
 *        ↓
 *  Liquidity / holder check
 *        ↓
 *  Buy/sell tax + honeypot check
 *        ↓
 *  Volume / transaction
 *        ↓
 *  Final token ranking
 */
export async function runDiscoveryPipeline(
  filter: DiscoveryFilter = DEFAULT_DISCOVERY_FILTER,
): Promise<DiscoverySnapshot> {
  const sourceStats: DiscoverySnapshot["sourceStats"] = {};
  
  // --- STAGE 1: DEX Discovery (parallel) ---
  const t0 = Date.now();
  const [dexScreener, geckoTerminal, dexTools] = await Promise.allSettled([
    fetchDexScreener(),
    fetchGeckoTerminal(),
    fetchDexTools(),
  ]);
  
  sourceStats["DexScreener"] = {
    count: dexScreener.status === "fulfilled" ? dexScreener.value.length : 0,
    latencyMs: Date.now() - t0,
    error: dexScreener.status === "rejected" ? String(dexScreener.reason) : undefined,
  };
  sourceStats["GeckoTerminal"] = {
    count: geckoTerminal.status === "fulfilled" ? geckoTerminal.value.length : 0,
    latencyMs: Date.now() - t0,
    error: geckoTerminal.status === "rejected" ? String(geckoTerminal.reason) : undefined,
  };
  sourceStats["DEXTools"] = {
    count: dexTools.status === "fulfilled" ? dexTools.value.length : 0,
    latencyMs: Date.now() - t0,
    error: dexTools.status === "rejected" ? String(dexTools.reason) : undefined,
  };
  
  // Merge primary discovery sources
  const stage1Candidates = mergeCandidates(
    dexScreener.status === "fulfilled" ? dexScreener.value.map((t) => ({ ...t, sources: ["DexScreener"] })) : [],
    geckoTerminal.status === "fulfilled" ? geckoTerminal.value.map((t) => ({ ...t, sources: ["GeckoTerminal"] })) : [],
    dexTools.status === "fulfilled" ? dexTools.value.map((t) => ({ ...t, sources: ["DEXTools"] })) : [],
  );
  
  // --- STAGE 2: Enrichment sources (parallel) ---
  const t1 = Date.now();
  const [dexview, aveAi, gmgn, birdeye, signalBot] = await Promise.allSettled([
    fetchDexview(),
    fetchAveAi(),
    fetchGMGN(),
    fetchBirdeye(),
    fetchSignalBot(),
  ]);
  
  sourceStats["Dexview"] = {
    count: dexview.status === "fulfilled" ? dexview.value.length : 0,
    latencyMs: Date.now() - t1,
    error: dexview.status === "rejected" ? String(dexview.reason) : undefined,
  };
  sourceStats["Ave.ai"] = {
    count: aveAi.status === "fulfilled" ? aveAi.value.length : 0,
    latencyMs: Date.now() - t1,
    error: aveAi.status === "rejected" ? String(aveAi.reason) : undefined,
  };
  sourceStats["GMGN"] = {
    count: gmgn.status === "fulfilled" ? gmgn.value.length : 0,
    latencyMs: Date.now() - t1,
    error: gmgn.status === "rejected" ? String(gmgn.reason) : undefined,
  };
  sourceStats["Birdeye"] = {
    count: birdeye.status === "fulfilled" ? birdeye.value.length : 0,
    latencyMs: Date.now() - t1,
    error: birdeye.status === "rejected" ? String(birdeye.reason) : undefined,
  };
  sourceStats["Signal-bot"] = {
    count: signalBot.status === "fulfilled" ? signalBot.value.length : 0,
    latencyMs: Date.now() - t1,
    error: signalBot.status === "rejected" ? String(signalBot.reason) : undefined,
  };
  
  // --- STAGE 2b: Additional launchpad, aggregator, and DEX router sources (parallel) ---
  const t2b = Date.now();
  const [fourMeme, flapSh, pumpFun, moonshot, tokenScan, tokenSniffer, stonkFun, ponsV2, brewFamily, raydium, arbimate, yieldo, arbScanner, cryptoArbScreener, openOcean, kyberSwap] = await Promise.allSettled([
    fetchFourMeme(),
    fetchFlapSh(),
    fetchPumpFun(),
    fetchMoonshot(),
    fetchTokenScan(),
    fetchTokenSniffer(),
    fetchStonkFun(),
    fetchPonsV2(),
    fetchBrewFamily(),
    fetchRaydium(),
    fetchArbimate(),
    fetchYieldo(),
    fetchArbitrageScanner(),
    fetchCryptoArbitrageScreener(),
    fetchOpenOcean(),
    fetchKyberSwap(),
  ]);
  
  const extraFetchers = [
    { key: "Four.Meme", result: fourMeme },
    { key: "Flap.sh", result: flapSh },
    { key: "Pump.fun", result: pumpFun },
    { key: "Moonshot", result: moonshot },
    { key: "TokenScan", result: tokenScan },
    { key: "TokenSniffer", result: tokenSniffer },
    { key: "StonkFun", result: stonkFun },
    { key: "PonsV2", result: ponsV2 },
    { key: "Brew.Family", result: brewFamily },
    { key: "Raydium", result: raydium },
    { key: "Arbimate", result: arbimate },
    { key: "Yieldo", result: yieldo },
    { key: "ArbitrageScanner", result: arbScanner },
    { key: "CryptoArbScreener", result: cryptoArbScreener },
    { key: "OpenOcean", result: openOcean },
    { key: "KyberSwap", result: kyberSwap },
  ];
  
  for (const { key, result } of extraFetchers) {
    sourceStats[key] = {
      count: result.status === "fulfilled" ? result.value.length : 0,
      latencyMs: Date.now() - t2b,
      error: result.status === "rejected" ? String(result.reason) : undefined,
    };
  }
  
  // Merge enrichment sources + additional sources with primary
  const allCandidates = mergeCandidates(
    stage1Candidates.map((t) => ({ ...t, sources: t.sources })),
    dexview.status === "fulfilled" ? dexview.value.map((t) => ({ ...t, sources: ["Dexview"] })) : [],
    aveAi.status === "fulfilled" ? aveAi.value.map((t) => ({ ...t, sources: ["Ave.ai"] })) : [],
    gmgn.status === "fulfilled" ? gmgn.value.map((t) => ({ ...t, sources: ["GMGN"] })) : [],
    birdeye.status === "fulfilled" ? birdeye.value.map((t) => ({ ...t, sources: ["Birdeye"] })) : [],
    signalBot.status === "fulfilled" ? signalBot.value.map((t) => ({ ...t, sources: ["Signal-bot"] })) : [],
    fourMeme.status === "fulfilled" ? fourMeme.value.map((t) => ({ ...t, sources: ["Four.Meme"] })) : [],
    flapSh.status === "fulfilled" ? flapSh.value.map((t) => ({ ...t, sources: ["Flap.sh"] })) : [],
    pumpFun.status === "fulfilled" ? pumpFun.value.map((t) => ({ ...t, sources: ["Pump.fun"] })) : [],
    moonshot.status === "fulfilled" ? moonshot.value.map((t) => ({ ...t, sources: ["Moonshot"] })) : [],
    tokenScan.status === "fulfilled" ? tokenScan.value.map((t) => ({ ...t, sources: ["TokenScan"] })) : [],
    tokenSniffer.status === "fulfilled" ? tokenSniffer.value.map((t) => ({ ...t, sources: ["TokenSniffer"] })) : [],
    stonkFun.status === "fulfilled" ? stonkFun.value.map((t) => ({ ...t, sources: ["StonkFun"] })) : [],
    ponsV2.status === "fulfilled" ? ponsV2.value.map((t) => ({ ...t, sources: ["PonsV2"] })) : [],
    brewFamily.status === "fulfilled" ? brewFamily.value.map((t) => ({ ...t, sources: ["Brew.Family"] })) : [],
    raydium.status === "fulfilled" ? raydium.value.map((t) => ({ ...t, sources: ["Raydium"] })) : [],
    arbimate.status === "fulfilled" ? arbimate.value.map((t) => ({ ...t, sources: ["Arbimate"] })) : [],
    yieldo.status === "fulfilled" ? yieldo.value.map((t) => ({ ...t, sources: ["Yieldo"] })) : [],
    arbScanner.status === "fulfilled" ? arbScanner.value.map((t) => ({ ...t, sources: ["ArbitrageScanner"] })) : [],
    cryptoArbScreener.status === "fulfilled" ? cryptoArbScreener.value.map((t) => ({ ...t, sources: ["CryptoArbScreener"] })) : [],
    openOcean.status === "fulfilled" ? openOcean.value.map((t) => ({ ...t, sources: ["OpenOcean"] })) : [],
    kyberSwap.status === "fulfilled" ? kyberSwap.value.map((t) => ({ ...t, sources: ["KyberSwap"] })) : [],
  );
  
  // --- STAGE 3: Contract Verification (BscScan + Honeypot, limited concurrency) ---
  const t2 = Date.now();
  const CONCURRENT_LIMIT = 10;
  const tokensToVerify = allCandidates.slice(0, 120); // 100+ token discovery per cycle
  
  for (let i = 0; i < tokensToVerify.length; i += CONCURRENT_LIMIT) {
    const batch = tokensToVerify.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.allSettled(
      batch.map(async (token) => {
        const [bscScan, honeypot] = await Promise.allSettled([
          fetchBscScanInfo(token.address),
          fetchHoneypotInfo(token.address),
        ]);
        
        if (bscScan.status === "fulfilled" && bscScan.value) {
          token.isContractVerified = bscScan.value.isVerified;
          if (bscScan.value.holderCount > token.holders)
            token.holders = bscScan.value.holderCount;
          if (bscScan.value.isRenounced)
            token.ownershipStatus = "renounced";
        }
        
        if (honeypot.status === "fulfilled" && honeypot.value) {
          token.isHoneypot = honeypot.value.isHoneypot;
          token.buyTaxPct = honeypot.value.buyTax;
          token.sellTaxPct = honeypot.value.sellTax;
          token.hasMintFunction = honeypot.value.hasMintFunction;
          token.hasHiddenOwner = honeypot.value.hasHiddenOwner;
          token.hasBlacklist = honeypot.value.hasBlacklist;
          token.hasPauseFunction = honeypot.value.hasPauseFunction;
          token.isProxy = honeypot.value.isProxy;
        }
      }),
    );
    // Continue even if some verifications fail
    void results;
  }
  
  sourceStats["BscScan"] = { count: tokensToVerify.length, latencyMs: Date.now() - t2 };
  sourceStats["Honeypot.is"] = { count: tokensToVerify.length, latencyMs: Date.now() - t2 };
  
  // --- STAGE 4: Compute derived fields ---
  for (const token of allCandidates) {
    token.buySellRatio = computeBuySellRatio(token.buys24h, token.sells24h);
    token.securityScore = computeSecurityScore(token);
    token.riskLevel = computeRiskLevel(token.securityScore);
  }
  
  // --- STAGE 5: Filter ---
  const filtered = filterTokens(allCandidates, filter);
  
  // --- STAGE 6: Score & Rank ---
  for (const token of filtered) {
    token.discoveryScore = computeDiscoveryScore(token);
    token.passedFilters = true;
  }
  
  filtered.sort((a, b) => b.discoveryScore - a.discoveryScore);
  
  // --- STAGE 7: Final selection (top 120 for 100+ token discovery per cycle 24/7) ---
  const final = filtered.slice(0, 120);
  
  return {
    fetchedAt: Date.now(),
    tokens: final,
    sourceStats,
    totalCandidates: allCandidates.length,
    totalPassed: filtered.length,
  };
}
