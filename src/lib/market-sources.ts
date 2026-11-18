/**
 * External market-data sources — pure functions, no Convex runtime.
 *
 * Every aggregator the terminal scans: DexScreener (via flashbolt's
 * fetchMarketSnapshot) + GeckoTerminal + DexPaprika + DEXTools + Dexview
 * + GMGN + Birdeye. Fetchers throw on HTTP failure — the Convex action
 * isolates them with Promise.allSettled and records per-source health
 * (pairs, latency, ok) so the operator sees exactly which sources are
 * contributing to the live route feed this cycle.
 *
 * Every value is real, live data — nothing is simulated or mocked.
 */
import { isSafeSymbol, type MarketSnapshot } from "./flashbolt";

// ---------------------------------------------------------------------------
// Raw API response types (verified against the live endpoints)
// ---------------------------------------------------------------------------

/**
 * GeckoTerminal pool shape (verified live): `attributes` carries pool-level
 * pricing only (`base_token_price_usd`, `quote_token_price_usd`,
 * `reserve_in_usd`, `volume_usd`) while the dex and the base/quote tokens
 * live exclusively in `relationships`, resolved against the `included`
 * array (token ids like "bsc_0x…", dex ids like "pancakeswap-v3-bsc").
 * A naive parser reading `base_token`/`dex_id`/`price_usd` from attributes
 * — none of which exist in the live API — silently drops every pool and
 * starves the live route feed with zero pairs.
 */
interface GeckoPoolAttrs {
  address?: string;
  base_token_price_usd?: string;
  quote_token_price_usd?: string;
  volume_usd?: { h24?: string };
  reserve_in_usd?: number | string;
  name?: string;
}

interface GeckoRelationRef {
  data?: { id?: string; type?: string };
}

interface GeckoPool {
  attributes?: GeckoPoolAttrs;
  relationships?: {
    base_token?: GeckoRelationRef;
    quote_token?: GeckoRelationRef;
    dex?: GeckoRelationRef;
  };
}

interface GeckoIncludedRecord {
  id?: string;
  type?: string;
  attributes?: { address?: string; symbol?: string; name?: string };
}

interface GMGNToken {
  symbol?: string;
  name?: string;
  address?: string;
  price?: number;
  volume_24h?: number;
  liquidity?: number;
  dex?: string;
  pair_address?: string;
  is_honeypot?: boolean;
}

interface BirdeyeToken {
  address?: string;
  symbol?: string;
  name?: string;
  price?: number;
  priceChange24hPercent?: number;
  volume24hUSD?: number;
  liquidity?: number;
  mc?: number;
  dex?: string;
  pairAddress?: string;
}

interface DexviewPair {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  price?: string;
  volume24h?: number;
  liquidity?: string;
  dexId?: string;
  pairAddress?: string;
}

interface DexPaprikaSearchPool {
  id?: string;
  dex_id?: string;
  volume_usd_24h?: number;
}

interface DexPaprikaPoolDetail {
  dex_id?: string;
  base_token_id?: string;
  last_price_usd?: number;
  liquidity_usd?: number;
  volume_usd_24h?: number;
  "24h"?: { volume_usd?: number };
  tokens?: Array<{ id?: string; symbol?: string }>;
}

/** Pair shape every external source feeds into mergeExternalPairs. */
export interface ExternalPair {
  dexId: string;
  labels?: string[];
  symbol: string;
  address: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeUsd: number;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * Real network fetch with a hard timeout. THROWS on HTTP failure or
 * timeout — callers that must not fail wrap it themselves, so one hung
 * third-party API can never stall the whole aggregated snapshot (Convex
 * actions have a wall clock budget — every source here is best-effort by
 * design, isolated with Promise.allSettled at the action level).
 */
export async function fetchJsonTimeout<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * GeckoTerminal (and DexPaprika) network ids differ from DexScreener's for
 * some chains — "eth" vs "ethereum", "polygon_pos" vs "polygon". Using the
 * DexScreener id silently 404s those chains down to zero pairs.
 */
const GECKO_NETWORK_ID: Record<string, string> = {
  bsc: "bsc",
  ethereum: "eth",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
};

function geckoNetworkId(chainKey: string): string {
  return GECKO_NETWORK_ID[chainKey] ?? chainKey;
}

const DEX_PAPRIKA_NETWORK_ID: Record<string, string> = {
  bsc: "bsc",
  ethereum: "eth",
  arbitrum: "arbitrum",
  polygon: "polygon",
};

function dexPaprikaNetworkId(chainKey: string): string {
  return DEX_PAPRIKA_NETWORK_ID[chainKey] ?? chainKey;
}

/**
 * Normalize an external dex id ("pancakeswap-v3-bsc", "pancakeswap_v2")
 * into the venue registry's DexScreener-style form: base dex id + version
 * labels. The registry disambiguates versioned venues purely on labels
 * (PCS = "pancakeswap"+"v2", PCS_V3 = "pancakeswap"+"v3"), so a raw
 * Gecko/Paprika id mapped without its version would collapse V3 pools into
 * V2 venues and fabricate phantom spreads.
 */
export function normalizeExternalDexId(rawId: string, networkId: string): { dexId: string; labels: string[] } | null {
  const lower = rawId.toLowerCase();
  const labels: string[] = [];
  const version = lower.match(/(?:^|[-_])v(\d+)(?:[-_]|$)/);
  if (version) labels.push(`v${version[1]}`);
  const netParts = networkId.toLowerCase().split(/[-_]/).filter(Boolean);
  let parts = lower.split(/[-_]/).filter(Boolean).filter((p) => !/^v\d+$/.test(p));
  while (
    parts.length > 1 &&
    netParts.length > 0 &&
    parts.slice(parts.length - netParts.length).join("-") === netParts.join("-")
  ) {
    parts = parts.slice(0, parts.length - netParts.length);
  }
  if (parts.length === 0) return null;
  return { dexId: parts.join("-"), labels };
}

// ---------------------------------------------------------------------------
// GeckoTerminal — trending + new pools
// ---------------------------------------------------------------------------

/**
 * Parse GeckoTerminal pools: resolve the dex + base/quote tokens from
 * `relationships` against the `included` array, and read prices from
 * `attributes.base_token_price_usd` / `quote_token_price_usd` (the only USD
 * prices the API exposes). When the quote side IS the chain's quote asset,
 * the quote's own USD price is emitted too — a real per-venue reference the
 * snapshot merge uses to normalize every route, even when DexScreener is
 * throttled. Every field comes from the live response — nothing mocked.
 */
export function parseGeckoPools(
  data: { data?: GeckoPool[]; included?: GeckoIncludedRecord[] },
  quoteSymbol: string,
  networkId: string,
  requireLiquidity: boolean,
): ExternalPair[] {
  const results: ExternalPair[] = [];
  const tokenById = new Map<string, { address?: string; symbol?: string }>();
  for (const rec of data.included ?? []) {
    if (rec.type === "token" && rec.id) {
      tokenById.set(rec.id, { address: rec.attributes?.address, symbol: rec.attributes?.symbol });
    }
  }
  for (const pool of data.data ?? []) {
    const a = pool.attributes;
    const baseId = pool.relationships?.base_token?.data?.id;
    const quoteId = pool.relationships?.quote_token?.data?.id;
    const dexRefId = pool.relationships?.dex?.data?.id;
    if (!a || !baseId || !dexRefId) continue;
    const normalized = normalizeExternalDexId(dexRefId, networkId);
    if (!normalized) continue;
    const priceUsd = Number(a.base_token_price_usd) || 0;
    const liquidityUsd = Number(a.reserve_in_usd) || 0;
    const volumeUsd = Number(a.volume_usd?.h24) || 0;
    if (priceUsd <= 0) continue;
    if (requireLiquidity && liquidityUsd <= 0) continue;
    const baseTok = tokenById.get(baseId);
    const base = (baseTok?.symbol ?? "").toUpperCase();
    if (base && base !== quoteSymbol) {
      const address = (baseTok?.address ?? baseId.slice(baseId.indexOf("_") + 1)).toLowerCase();
      if (address.startsWith("0x")) {
        results.push({
          dexId: normalized.dexId,
          labels: normalized.labels,
          symbol: base,
          address,
          priceUsd,
          liquidityUsd,
          volumeUsd,
        });
      }
    }
    // Quote-side USD reference for the chain's quote asset (e.g. WBNB).
    const quoteTok = quoteId ? tokenById.get(quoteId) : undefined;
    const quotePriceUsd = Number(a.quote_token_price_usd) || 0;
    if (quoteId && quoteTok && (quoteTok.symbol ?? "").toUpperCase() === quoteSymbol && quotePriceUsd > 0) {
      const quoteAddress = (quoteTok.address ?? quoteId.slice(quoteId.indexOf("_") + 1)).toLowerCase();
      if (quoteAddress.startsWith("0x")) {
        results.push({
          dexId: normalized.dexId,
          labels: normalized.labels,
          symbol: quoteSymbol,
          address: quoteAddress,
          priceUsd: quotePriceUsd,
          liquidityUsd,
          volumeUsd,
        });
      }
    }
  }
  return results;
}

export async function fetchGeckoTerminalPairs(quoteSymbol: string, chainKey: string): Promise<ExternalPair[]> {
  const networkId = geckoNetworkId(chainKey);
  const data = await fetchJsonTimeout<{ data?: GeckoPool[]; included?: GeckoIncludedRecord[] }>(
    `https://api.geckoterminal.com/api/v2/networks/${networkId}/trending_pools?page=1&include=dex,base_token,quote_token&sort=h24_volume_usd_liquidity_desc`,
  );
  return parseGeckoPools(data, quoteSymbol, networkId, true);
}

export async function fetchGeckoNewPoolPairs(quoteSymbol: string, chainKey: string): Promise<ExternalPair[]> {
  const networkId = geckoNetworkId(chainKey);
  const data = await fetchJsonTimeout<{ data?: GeckoPool[]; included?: GeckoIncludedRecord[] }>(
    `https://api.geckoterminal.com/api/v2/networks/${networkId}/new_pools?page=1&include=dex,base_token,quote_token&sort=created_at`,
  );
  // Brand-new pools may not carry reserves yet — only a real price is
  // required here (matching the pre-existing new-pool semantics).
  return parseGeckoPools(data, quoteSymbol, networkId, false);
}

// ---------------------------------------------------------------------------
// DexPaprika — free DEX analytics API, no key required
// ---------------------------------------------------------------------------

/**
 * The network pool listings were removed upstream (HTTP 410 pointing at
 * /pools/search), and search results carry no token symbols or name, so a
 * price cannot be attributed to a token honestly from search alone. Flow:
 * search the chain's quote asset → take the highest-24h-volume pools
 * (bounded fetch budget) → resolve each pool's detail, which declares
 * base_token_id explicitly plus full token symbols, so base/price
 * attribution is exact.
 */
const DEX_PAPRIKA_DETAIL_BUDGET = 10;

export async function fetchDexPaprikaPairs(quoteSymbol: string, chainKey: string): Promise<ExternalPair[]> {
  const results: ExternalPair[] = [];
  const networkId = dexPaprikaNetworkId(chainKey);
  const search = await fetchJsonTimeout<{ results?: DexPaprikaSearchPool[] }>(
    `https://api.dexpaprika.com/networks/${networkId}/pools/search?query=${encodeURIComponent(quoteSymbol)}`,
  );
  const candidates = (search.results ?? [])
    .filter((p): p is DexPaprikaSearchPool & { id: string } => typeof p.id === "string" && p.id.length > 0)
    .sort((a, b) => (b.volume_usd_24h ?? 0) - (a.volume_usd_24h ?? 0))
    .slice(0, DEX_PAPRIKA_DETAIL_BUDGET);
  if (candidates.length === 0) return results;
  const details = await Promise.allSettled(
    candidates.map((c) =>
      fetchJsonTimeout<DexPaprikaPoolDetail>(
        `https://api.dexpaprika.com/networks/${networkId}/pools/${c.id}`,
        6_000,
      ),
    ),
  );
  for (const settled of details) {
    if (settled.status !== "fulfilled" || !settled.value) continue;
    const pool = settled.value;
    if (!pool.dex_id) continue;
    const byId = new Map(
      (pool.tokens ?? []).filter((t) => t.id).map((t) => [t.id!.toLowerCase(), t]),
    );
    const baseTok = byId.get((pool.base_token_id ?? "").toLowerCase());
    const base = (baseTok?.symbol ?? "").toUpperCase();
    if (!base || base === quoteSymbol) continue;
    const priceUsd = pool.last_price_usd ?? 0;
    if (priceUsd <= 0) continue;
    const normalized = normalizeExternalDexId(pool.dex_id, networkId);
    if (!normalized) continue;
    results.push({
      dexId: normalized.dexId,
      labels: normalized.labels,
      symbol: base,
      address: (baseTok?.id ?? "").toLowerCase(),
      priceUsd,
      liquidityUsd: pool.liquidity_usd ?? 0,
      volumeUsd: pool.volume_usd_24h ?? pool["24h"]?.volume_usd ?? 0,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// DEXTools / Dexview / GMGN / Birdeye
// ---------------------------------------------------------------------------

export async function fetchDexToolsPairs(
  quoteSymbol: string,
  chainDexScreenerId: string,
): Promise<ExternalPair[]> {
  const results: ExternalPair[] = [];
  const data = await fetchJsonTimeout<{
    data?: Array<{
      dex?: string;
      baseToken?: { address?: string; symbol?: string };
      price?: number;
      liquidity?: number;
      volume?: { h24?: number };
    }>;
  }>(`https://api.dextools.io/v1/pair/top/${chainDexScreenerId}/24h`);
  for (const p of data.data ?? []) {
    if (!p.baseToken?.address || !p.dex) continue;
    const base = (p.baseToken.symbol ?? "").toUpperCase();
    if (base === quoteSymbol) continue;
    const priceUsd = p.price ?? 0;
    const liquidityUsd = p.liquidity ?? 0;
    const volumeUsd = p.volume?.h24 ?? 0;
    if (priceUsd <= 0) continue;
    results.push({
      dexId: p.dex.toLowerCase(),
      symbol: base,
      address: p.baseToken.address.toLowerCase(),
      priceUsd,
      liquidityUsd,
      volumeUsd,
    });
  }
  return results;
}

export async function fetchDexviewPairs(
  quoteSymbol: string,
  chainId: number,
): Promise<ExternalPair[]> {
  const results: ExternalPair[] = [];
  const data = await fetchJsonTimeout<{ data?: DexviewPair[] }>(
    `https://api.dexview.com/trending/dex?chainId=${chainId}&limit=50`,
  );
  for (const p of data.data ?? []) {
    if (!p.tokenAddress || !p.dexId) continue;
    const base = (p.tokenSymbol ?? "").toUpperCase();
    if (base === quoteSymbol) continue;
    const priceUsd = Number(p.price) || 0;
    const liquidityUsd = Number(p.liquidity) || 0;
    const volumeUsd = p.volume24h ?? 0;
    if (priceUsd <= 0) continue;
    results.push({
      dexId: p.dexId.toLowerCase(),
      symbol: base,
      address: p.tokenAddress.toLowerCase(),
      priceUsd,
      liquidityUsd,
      volumeUsd,
    });
  }
  return results;
}

export async function fetchGMGNPairs(
  quoteSymbol: string,
  chainDexScreenerId: string,
): Promise<ExternalPair[]> {
  const results: ExternalPair[] = [];
  const data = await fetchJsonTimeout<{ data?: { tokens?: GMGNToken[] } }>(
    `https://gmgn.ai/defi/quotation/v1/tokens/${chainDexScreenerId}/1h?orderby=volume&direction=desc&filters[]=renounced&filters[]=frozen&limit=50`,
  );
  for (const t of data.data?.tokens ?? []) {
    if (!t.address) continue;
    const base = (t.symbol ?? "").toUpperCase();
    if (base === quoteSymbol) continue;
    const priceUsd = t.price ?? 0;
    const liquidityUsd = t.liquidity ?? 0;
    const volumeUsd = t.volume_24h ?? 0;
    if (priceUsd <= 0) continue;
    results.push({
      dexId: (t.dex ?? "uniswap").toLowerCase(),
      symbol: base,
      address: t.address.toLowerCase(),
      priceUsd,
      liquidityUsd,
      volumeUsd,
    });
  }
  return results;
}

export async function fetchBirdeyePairs(
  quoteSymbol: string,
  chainDexScreenerId: string,
): Promise<ExternalPair[]> {
  const results: ExternalPair[] = [];
  const data = await fetchJsonTimeout<{ data?: { tokens?: BirdeyeToken[] } }>(
    `https://public-api.birdeye.so/defi/v3/token/trending?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=50&chain=${chainDexScreenerId}`,
  );
  for (const t of data.data?.tokens ?? []) {
    if (!t.address) continue;
    const base = (t.symbol ?? "").toUpperCase();
    if (base === quoteSymbol) continue;
    const priceUsd = t.price ?? 0;
    const liquidityUsd = t.liquidity ?? 0;
    const volumeUsd = t.volume24hUSD ?? 0;
    if (priceUsd <= 0) continue;
    results.push({
      dexId: (t.dex ?? "uniswap").toLowerCase(),
      symbol: base,
      address: t.address.toLowerCase(),
      priceUsd,
      liquidityUsd,
      volumeUsd,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// DEX ID mapping
// ---------------------------------------------------------------------------

export function mapDexId(
  externalDexId: string,
  chainDexes: Array<{ key: string; dexId: string; labels?: string[] }>,
  versionLabels?: string[],
): string | null {
  const lower = externalDexId.toLowerCase();
  const pairLabels = (versionLabels ?? []).map((l) => String(l).toLowerCase());
  // Exact dexId pass first. Versioned venues (declared labels) require the
  // pair to carry one of those labels — DexScreener reports PancakeSwap V3
  // as dexId "pancakeswap" + labels ["v3"], so without this guard a V3 pool
  // collapses into PCS and fabricates a phantom PCS↔PCS_V3 spread.
  for (const dex of chainDexes) {
    if (dex.dexId.toLowerCase() !== lower) continue;
    if (!dex.labels || dex.labels.length === 0) return dex.key;
    if (pairLabels.some((l) => dex.labels!.includes(l))) return dex.key;
  }
  for (const dex of chainDexes) {
    if (lower.includes(dex.dexId.toLowerCase()) || dex.dexId.toLowerCase().includes(lower)) return dex.key;
  }
  // Chains share the same dexIds ("pancakeswap", "uniswap", "sushiswap");
  // only fall back to a chain-local key so routes always resolve.
  const aliases: Record<string, string> = {
    "pancakeswap": "PCS",
    "pancakeswapv2": "PCS",
    "pancake-swap": "PCS",
    "pancakeswap-v3": "PCS_V3",
    "pancakeswapv3": "PCS_V3",
    "biswap": "BISWAP",
    "mdex": "MDEX",
    "mdexswap": "MDEX",
    "apeswap": "APESWAP",
    "ape-swap": "APESWAP",
    "babyswap": "BABYSWAP",
    "baby-swap": "BABYSWAP",
    "uniswap": "UNI",
    "sushiswap": "SUSHI",
  };
  const aliased = aliases[lower];
  if (aliased && chainDexes.some((d) => d.key === aliased)) return aliased;
  return null;
}

// ---------------------------------------------------------------------------
// Merge helpers — poison-resistant enrichment of the base snapshot
// ---------------------------------------------------------------------------

/**
 * Cross-source price plausibility bound. Real venues agree on an asset's
 * price within a few percent; spam/scam pools listing a major asset at a
 * fabricated price with enormous fake depth (e.g. "USDT" at $118,906 —
 * observed live) are unambiguous garbage at 20x+. Data-driven: nothing is
 * hard-coded, the bound only rejects deviations no real market produces.
 */
export const MAX_CROSS_SOURCE_DEVIATION = 20;

function priceIsPlausible(symbol: string, priceUsd: number, snapshot: MarketSnapshot): boolean {
  let min = Infinity;
  let max = 0;
  for (const venueQuotes of Object.values(snapshot.quotes)) {
    const q = venueQuotes[symbol];
    if (!q || q.usdPerToken <= 0) continue;
    min = Math.min(min, q.usdPerToken);
    max = Math.max(max, q.usdPerToken);
  }
  // First quote for the symbol — nothing to cross-check against yet.
  if (!Number.isFinite(min)) return true;
  return priceUsd <= max * MAX_CROSS_SOURCE_DEVIATION && priceUsd >= min / MAX_CROSS_SOURCE_DEVIATION;
}

export function mergeExternalPairs(
  snapshot: MarketSnapshot,
  pairs: ExternalPair[],
  chainDexes: Array<{ key: string; dexId: string; fee: number; labels?: string[] }>,
): void {
  for (const p of pairs) {
    // Convex rejects non-ASCII field names — one scam symbol like "USDT 人"
    // would crash the ENTIRE action during serialization and starve the live
    // feed (verified in production). Rejected outright, never sanitized into
    // a key that could collide with the real token ("USDT 人" → "USDT").
    if (!isSafeSymbol(p.symbol)) continue;
    // Reject scam/stale pool pricing that disagrees with every venue already
    // quoting the symbol — one poisoned pool must never fabricate a spread.
    if (!priceIsPlausible(p.symbol, p.priceUsd, snapshot)) continue;
    const dexKey = mapDexId(p.dexId, chainDexes, p.labels);
    if (!dexKey) continue;
    if (!snapshot.quotes[dexKey]) snapshot.quotes[dexKey] = {};
    const existing = snapshot.quotes[dexKey][p.symbol];
    if (!existing || p.liquidityUsd > existing.liquidityUsd) {
      snapshot.quotes[dexKey][p.symbol] = {
        usdPerToken: p.priceUsd,
        liquidityUsd: p.liquidityUsd,
        volumeUsd: p.volumeUsd,
      };
    }
    if (p.address) {
      if (!snapshot.tokenAddresses[dexKey]) snapshot.tokenAddresses[dexKey] = {};
      if (!snapshot.tokenAddresses[dexKey][p.symbol]) {
        snapshot.tokenAddresses[dexKey][p.symbol] = p.address;
      }
    }
  }
}

/**
 * Post-merge outlier sweep: once ≥3 venues quote a symbol, any quote
 * deviating more than MAX_CROSS_SOURCE_DEVIATION from the cross-venue
 * median is dropped regardless of merge order — so a poisoned pool that
 * merged first cannot anchor the quote-asset normalization or fabricate a
 * phantom spread against a later legitimate quote.
 */
export function dropPriceOutliers(snapshot: MarketSnapshot): void {
  const symbols = new Set<string>();
  for (const venueQuotes of Object.values(snapshot.quotes)) {
    for (const symbol of Object.keys(venueQuotes)) symbols.add(symbol);
  }
  for (const symbol of symbols) {
    const entries: Array<{ venue: string; usdPerToken: number }> = [];
    for (const [venue, venueQuotes] of Object.entries(snapshot.quotes)) {
      const q = venueQuotes[symbol];
      if (q && q.usdPerToken > 0) entries.push({ venue, usdPerToken: q.usdPerToken });
    }
    if (entries.length < 3) continue;
    const sorted = entries.map((e) => e.usdPerToken).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const { venue, usdPerToken } of entries) {
      if (usdPerToken > median * MAX_CROSS_SOURCE_DEVIATION || usdPerToken < median / MAX_CROSS_SOURCE_DEVIATION) {
        delete snapshot.quotes[venue][symbol];
      }
    }
  }
}
