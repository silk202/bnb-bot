/**
 * FlashBolt live market engine.
 *
 * Real BNB Chain pair prices are pulled from the free public DexScreener API
 * (https://docs.dexscreener.com) — no simulation anywhere in the feed, for
 * paper OR live mode. Routes are genuine triangular flash-loan arbitrages:
 * borrow WBNB, sweep 2–3 legs across DIFFERENT BNB DEXs, repay, keep the edge.
 *
 * The flash-loan LENDER rotates with every scan run so consecutive scans
 * borrow from a different liquidity pool. The optional Balancer v queue
 * prioritizes lenders by their documented fee (lowest first).
 */

import {
  CHAIN_INFO,
  effectiveRpc,
  isBscChain,
  type ChainKey,
  type DexDef,
} from "./chains";

export type { ChainKey } from "./chains";
export {
  CHAIN_INFO,
  CHAIN_KEYS,
  chainForChainId,
  effectiveRpc,
  isBscChain,
  SCANNER_SITES,
  SITE_CHAINS,
} from "./chains";

import type { NetworkKey } from "./chains";

export type RiskLevel = "low" | "medium" | "high";

export interface ExchangeInfo {
  /** Short code shown in the feed, e.g. "PCS". Also the whitelist key. */
  key: string;
  /** DexScreener dex id. */
  dexId: string;
  name: string;
  /** Swap fee charged per leg. */
  fee: number;
  color: string;
}

/** BNB Chain AMMs (the historical default). Other chains use CHAIN_INFO. */
export const EXCHANGES: ExchangeInfo[] = CHAIN_INFO.bsc.dexes;

/** Short codes, e.g. ["PCS","BISWAP","MDEX","APESWAP","BABYSWAP"]. */
export const EXCHANGE_KEYS = EXCHANGES.map((e) => e.key);

/** Flash-loan lenders on BNB Chain; the bot rotates through these per run. */
export const FLASH_LENDERS: readonly string[] = CHAIN_INFO.bsc.lenders;

/**
 * Real, documented flash-loan fees (percent of the borrowed principal) per
 * lender — from each protocol's official docs: Aave V3 0.05% flash-loan
 * premium, Venus 0.09% (flashLoanFeeMantissa), Radiant 0.09%, dForce
 * pool-configured (~0.05–0.09%), PancakeSwap V2 pool fee 0.25%. Nothing here
 * is fabricated; every value carries its source. The lender balancer uses
 * these to prioritize low-fee lenders before high-fee ones.
 */
export interface FlashLenderInfo {
  name: string;
  /** Numeric fee used for the balancer ordering, percent of principal. */
  feePct: number;
  /** Display label (handles documented ranges such as dForce). */
  feeLabel: string;
  /** Where the documented value comes from. */
  source: string;
}

export const FLASH_LENDER_INFO: FlashLenderInfo[] = [
  { name: "Aave V3", feePct: 0.05, feeLabel: "0.05%", source: "aave.com/docs — flash-loan premium" },
  { name: "Venus", feePct: 0.09, feeLabel: "0.09%", source: "docs-v4.venus.io — flashLoanFeeMantissa" },
  { name: "Radiant", feePct: 0.09, feeLabel: "0.09%", source: "docs.radiant.capital — flash-loan fee" },
  { name: "dForce", feePct: 0.09, feeLabel: "0.05–0.09%", source: "developers.dforce.network — pool-configured" },
  { name: "PancakeSwap", feePct: 0.25, feeLabel: "0.25%", source: "docs.pancakeswap.finance — V2 pool fee" },
];

/** Documented flash-loan fee for a lender, percent of principal (0 if unknown). */
export function lenderFeePct(lender: string): number {
  return FLASH_LENDER_INFO.find((l) => l.name === lender)?.feePct ?? 0;
}

/** Documented fee label for a lender. */
export function lenderFeeLabel(lender: string): string {
  return FLASH_LENDER_INFO.find((l) => l.name === lender)?.feeLabel ?? "—";
}

/**
 * Balancer v priority queue for a lender set: lenders sorted by documented
 * fee (lowest first) with the lowest-fee lender weighted so it is picked
 * more often than the high-fee ones. Only lenders that actually exist on
 * the chain are included.
 */
export function balancerQueueFor(lenders: readonly string[]): string[] {
  const sorted = [...FLASH_LENDER_INFO]
    .filter((l) => lenders.includes(l.name))
    .sort((a, b) => a.feePct - b.feePct);
  const queue: string[] = [];
  for (const lender of sorted) {
    queue.push(lender.name);
    // Low-fee priority: the cheapest lender appears twice in the cycle.
    if (lender === sorted[0]) queue.push(lender.name);
  }
  return queue;
}

/** Balancer v priority queue for the BNB Chain lenders. */
export const BALANCER_QUEUE: readonly string[] = balancerQueueFor(FLASH_LENDERS);

/**
 * Lender for a given scan run number — rotates so each run differs. When
 * `balanced` is enabled the rotation follows the Balancer v priority queue
 * (low-fee lenders before high-fee ones) instead of the legacy order. The
 * lender set is chain-scoped (e.g. Venus only exists on BNB Chain).
 */
export function lenderForRun(
  run: number,
  balanced = false,
  lenders: readonly string[] = FLASH_LENDERS,
): string {
  const queue = balanced ? balancerQueueFor(lenders) : lenders;
  const len = queue.length;
  if (len === 0) return "—";
  return queue[((run % len) + len) % len];
}

/**
 * Net profit after real costs, percent of the loan: the documented
 * flash-loan fee of the route's lender minus the configured slippage
 * tolerance. The bot's always-on profit guard refuses to execute any route
 * whose net after costs is ≤ 0 — in paper AND live mode.
 */
export function netProfitAfterCosts(route: FlashRoute, slippagePct: number): number {
  const fee = lenderFeePct(route.lender);
  const slippage = Number.isFinite(slippagePct) ? slippagePct : 0;
  return Math.round((route.profitPct - fee - slippage) * 10000) / 10000;
}

/**
 * Estimated gas for one FlashBoltArbitrage.execute() call: the 1 BNB flash
 * borrow, the Router02 swap legs, the repayment and the profit transfer. The
 * number is a documented estimate of the real on-chain cost (a 2–3 leg flash
 * swap through PancakeSwap V2 Router02 settles around this); the gas PRICE
 * itself comes live from the BNB RPC so the BNB cost tracks the market.
 */
export const EXECUTE_GAS_UNITS = 320_000;

/** BNB cost of an execution at a given gas price in gwei. */
export function gasCostBnb(gasPriceGwei: number, gasUnits = EXECUTE_GAS_UNITS): number {
  if (!Number.isFinite(gasPriceGwei) || gasPriceGwei < 0) return 0;
  return (gasUnits * gasPriceGwei) / 1e9;
}

// ---------------------------------------------------------------------------
// Shared per-route cost model (computeRoutes engine + generated tier)
// ---------------------------------------------------------------------------

/** Gas units for a 2–3 leg flash-loan arbitrage route (shared cost model). */
export const ROUTE_GAS_UNITS = 350_000;

/** Safety margin (%) added on top of every route's real costs. */
export const ROUTE_SAFETY_MARGIN_PCT = 0.15;

/**
 * Liquidity-derived slippage estimate (%) for a route's weakest leg — used by
 * BOTH the computeRoutes engine and the generated route tier so a route
 * prices identically whichever tier surfaces it.
 */
export function routeSlippagePct(minLiquidityUsd: number): number {
  return minLiquidityUsd < 10_000
    ? 0.5
    : minLiquidityUsd < 50_000
      ? 0.3
      : minLiquidityUsd < 200_000
        ? 0.15
        : 0.05;
}

/**
 * Net profit after costs AND gas, percent of the loan. The gas cost (BNB) is
 * converted to a percent of the borrowed loan size and subtracted from the
 * net-after-costs figure — real RPC gas price, real loan size.
 */
export function netProfitAfterGas(
  route: FlashRoute,
  netAfterCostsPct: number,
  gasPriceGwei: number,
): number {
  const gasBnb = gasCostBnb(gasPriceGwei);
  const gasPct = route.loanSizeBnb > 0 ? (gasBnb / route.loanSizeBnb) * 100 : 0;
  return Math.round((netAfterCostsPct - gasPct) * 10000) / 10000;
}

/**
 * Honeypot scanner thresholds: only genuinely high-profit routes with real
 * high liquidity qualify — nothing is fabricated, this is a strict filter on
 * the live computed routes.
 */
export const HONEY_POT_MIN_PROFIT_PCT = 0.5;
export const HONEY_POT_MIN_LIQUIDITY_USD = 250_000;

/**
 * Honeypot filter. Thresholds default to the documented constants and can
 * be overridden with the operator-tuned values from the terminalConfig table
 * (the scanner passes them through so the live filter always matches what
 * the operator configured in the console).
 */
export function isHoneyPot(
  route: FlashRoute,
  minProfitPct: number = HONEY_POT_MIN_PROFIT_PCT,
  minLiquidityUsd: number = HONEY_POT_MIN_LIQUIDITY_USD,
): boolean {
  return route.profitPct >= minProfitPct && route.liquidityUsd >= minLiquidityUsd;
}

export const SCAN_CADENCES = [15, 30, 60] as const;
export type ScanCadence = (typeof SCAN_CADENCES)[number];

/**
 * Feed data-quality guards (constants, not settings — they protect against
 * GARBAGE DATA, not operator preference):
 *
 * - MIN_ROUTE_LIQUIDITY_USD: thin scam pairs (verified live: $0.58–$2k pools
 *   named "SUSDT"/"USDT.Z") carry stale, wildly wrong prices; any route
 *   through them is fictional. Real arb lives on pools with real depth.
 * - MAX_ROUTE_PROFIT_PCT: a genuine cross-DEX spread never exceeds tens of
 *   percent. Anything larger means the two legs priced DIFFERENT tokens or a
 *   stale pool — reporting it would be fabrication.
 */
export const MIN_ROUTE_LIQUIDITY_USD = 1_000;
export const MAX_ROUTE_PROFIT_PCT = 50;

export interface FlashRoute {
  id: string;
  /**
   * Interleaved token/DEX legs. The FIRST and LAST entries are the LOAN
   * ASSET's symbol — WBNB routes read ["WBNB","PCS","CAKE","BISWAP","WBNB"],
   * stable-denominated routes read ["USDT","PCS","CAKE","BISWAP","USDT"]
   * (the path itself wraps through the chain quote for execution).
   */
  legs: string[];
  /** DEX short codes used, in order. */
  dexes: string[];
  /** Net profit as a percentage of the loan, after swap fees. */
  profitPct: number;
  /** Gross spread captured, in basis points (before fees). */
  spreadBps: number;
  ttlSeconds: number;
  /** MEV risk 0–100 (low-liquidity legs score higher). */
  mevRisk: number;
  /** Flash-loan lender for this scan run. */
  lender: string;
  /** Borrowed size for this route, in the loan asset (0.1..maxLoan). */
  loanSizeBnb: number;
  /** Symbol of the asset the loan is denominated in (WBNB / USDT / USDC…). */
  loanAsset: string;
  /** Weakest leg liquidity, in USD. */
  liquidityUsd: number;
  /**
   * How the edge was found: "triangular" (same-chain cross-DEX triangle),
   * "cross-chain" (same-asset spread across chains, executed on the selected
   * chain) or "statistical" (discovery-pipeline signal). Persistence-only —
   * the trail attributes real executions per method.
   */
  method?: "triangular" | "cross-chain" | "statistical";
}

/**
 * Profit of a route in the LOAN ASSET (WBNB routes → WBNB profit, USDT
 * routes → USDT profit). Nothing is converted or faked — the loan size is
 * denominated in the loan asset and the percentage applies to it.
 */
export function routeProfitBnb(route: FlashRoute): number {
  return Math.round(route.loanSizeBnb * (route.profitPct / 100) * 1e6) / 1e6;
}

export function routeLabel(route: FlashRoute): string {
  return route.legs.join(" → ");
}

export function riskLevel(mevRisk: number): RiskLevel {
  if (mevRisk >= 70) return "high";
  if (mevRisk >= 40) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Market data (DexScreener)
// ---------------------------------------------------------------------------

export interface DexQuote {
  /** USD price of the token on this DEX. */
  usdPerToken: number;
  liquidityUsd: number;
  volumeUsd: number;
}

/**
 * A flash-loan asset discovered from live pool data. V2 pairs flash-swap
 * EITHER side of any pair, so every asset with a deep wrapped-native pair on
 * enough venues can back a flash loan — WBNB, USDT, USDC, BTCB, whatever the
 * market reports. Nothing is hard-coded: entries come from the real snapshot.
 */
export interface LoanCandidate {
  /** Asset symbol (WBNB / USDT / USDC / BTCB…). */
  symbol: string;
  /** Real on-chain token address from the live pair data (lowercase). */
  address: string;
  /** Deepest wrapped-native pair liquidity for this asset, in USD. */
  liquidityUsd: number;
  /** How many venues quote a wrapped-native pair for this asset. */
  venues: number;
  /** Venue keys quoting this asset against the wrapped native. */
  venueKeys: string[];
}

/** Minimum USD liquidity for a non-native asset to qualify as a loan base. */
export const LOAN_ASSET_MIN_LIQUIDITY_USD = 250_000;

/**
 * Discover flash-loan assets from a snapshot's own live quote data: any
 * asset quoted against the wrapped native on >= minVenues whitelisted venues
 * with real depth qualifies (V2 pairs flash-swap either side of the pair).
 * The wrapped native itself is the settlement asset of every venue and is
 * added by the snapshot builder, not here. Deepest-first ordering.
 */
export function discoverLoanAssets(
  input: Pick<MarketSnapshot, "quotes" | "tokenAddresses"> & { quoteSymbol?: string },
  minVenues = 2,
  minLiquidityUsd = LOAN_ASSET_MIN_LIQUIDITY_USD,
): LoanCandidate[] {
  const quoteSymbol = input.quoteSymbol ?? "WBNB";
  const byAsset = new Map<string, LoanCandidate>();
  for (const [dexKey, perToken] of Object.entries(input.quotes)) {
    for (const [symbol, quote] of Object.entries(perToken)) {
      if (symbol === quoteSymbol) continue;
      if (quote.usdPerToken <= 0 || quote.liquidityUsd <= 0) continue;
      const address = input.tokenAddresses[dexKey]?.[symbol];
      if (!address) continue;
      const entry = byAsset.get(symbol) ?? {
        symbol,
        address,
        liquidityUsd: 0,
        venues: 0,
        venueKeys: [],
      };
      if (quote.liquidityUsd > entry.liquidityUsd) {
        entry.liquidityUsd = quote.liquidityUsd;
        entry.address = address;
      }
      if (!entry.venueKeys.includes(dexKey)) entry.venueKeys.push(dexKey);
      entry.venues = entry.venueKeys.length;
      byAsset.set(symbol, entry);
    }
  }
  return [...byAsset.values()]
    .filter((a) => a.venues >= minVenues && a.liquidityUsd >= minLiquidityUsd)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, 8);
}

/**
 * Per-source fetch health for one snapshot cycle — measured live, never
 * fabricated. Drives the Scanner's source health chips.
 */
export interface SourceHealth {
  /** Real pair count the source contributed this cycle. */
  pairs: number;
  /** Wall-clock fetch duration in milliseconds. */
  ms: number;
  /** false = the source's HTTP request failed (timeout / non-200). */
  ok: boolean;
}

export interface MarketSnapshot {
  fetchedAt: number;
  /** dexKey -> token symbol -> quote */
  quotes: Record<string, Record<string, DexQuote>>;
  /** dexKey -> token symbol -> real on-chain token address (for live paths). */
  tokenAddresses: Record<string, Record<string, string>>;
  /** Global quote-token/USD reference (fallback when a DEX lacks a base pair). */
  wbnbUsd: number;
  /** Per-DEX quote-token/USD when the DEX reports a base pair. */
  wbnbUsdByDex: Record<string, number>;
  /** Chain this snapshot was fetched for (defaults to bsc). */
  chainKey?: ChainKey;
  /** Which network of that chain (mainnet aggregator data vs on-chain testnet data). */
  network?: NetworkKey;
  /** Quote token symbol (WBNB / WETH / WMATIC). */
  quoteSymbol?: string;
  /** Real on-chain quote token address. */
  quoteAddress?: string;
  /**
   * Venues present in this snapshot. When set (on-chain/testnet snapshots),
   * computeRoutes uses THESE instead of the chain's DexScreener dex registry —
   * testnet venues differ from mainnet venues. */
  venues?: ExchangeInfo[];
  /** Lenders that exist on this chain+network (testnets have a smaller set). */
  lenders?: string[];
  /**
   * Flash-loan assets DISCOVERED from this snapshot's live pool data — the
   * wrapped native first, then every asset with deep wrapped-native pairs on
   * >=2 venues (USDT, USDC, BTCB, …). Built by fetchMarketSnapshot; on-demand
   * snapshots fall back to discoverLoanAssets(). Never hard-coded.
   */
  loanAssets?: LoanCandidate[];
  /**
   * Per-source fetch health for this cycle: which external sources ran,
   * how many real pairs each contributed, and how long each took. Built
   * by fetchAggregatedSnapshot — powers the Scanner's source health chips
   * so a starving feed is diagnosable at a glance. Never mocked.
   */
  sourceHealth?: Record<string, SourceHealth>;
}

/** DexScreener pair fields used for v3-aware venue matching. */
interface DexScreenerPair extends RawPair {
  labels?: string[];
}

interface RawPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  /** Base-token price denominated in the quote token (verified live). */
  priceNative?: string | number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

/**
 * v3-aware venue resolution: a pair matches a registry venue when its dexId
 * matches AND — when the venue declares version labels — the pair carries at
 * least one of them. DexScreener reports PancakeSwap V3 as dexId
 * "pancakeswap" + labels ["v3"] (verified live), so without label matching a
 * V3 pool would be double-counted as a fake PCS↔PCS_V3 spread. Returns null
 * when the pair belongs to no registered venue.
 */
function matchDexDef(
  p: DexScreenerPair,
  chain: (typeof CHAIN_INFO)[ChainKey],
): DexDef | null {
  const dexId = (p.dexId ?? "").toLowerCase();
  if (!dexId) return null;
  const pairLabels = (p.labels ?? []).map((l) => String(l).toLowerCase());
  for (const dex of chain.dexes) {
    if (dex.dexId.toLowerCase() !== dexId) continue;
    if (!dex.labels || dex.labels.length === 0) return dex;
    if (pairLabels.some((l) => dex.labels!.includes(l))) return dex;
  }
  // Label-less fallback: registry venues without labels must still catch
  // pairs of their dexId when the pair carries NO version labels at all
  // (e.g. Biswap/MDEX never report labels).
  if (pairLabels.length === 0) {
    return chain.dexes.find((d) => d.dexId.toLowerCase() === dexId && !d.labels) ?? null;
  }
  return null;
}

/** Real network fetch with a hard timeout so one hung request never stalls a scan cycle. */
async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Fetch live pair prices for a chain from DexScreener (free, no API key).
 *
 * Sources (all real, in priority order):
 *  1. quote-token pairs via `/latest/dex/tokens/{WBNB|WETH|WMATIC}` — every
 *     DEX pairs against the wrapped native on-chain, so this single endpoint
 *     yields cross-DEX quotes directly ( PancakeSwap V2/V3, Biswap, MDEX, …).
 *  2. `/latest/dex/search` — broadened to the wrapped-native symbol AND the
 *     chain slug AND the wrapped/USDT pair, because DexScreener's search is
 *     keyword-based and a single term misses most fresh listings.
 *  3. trending token profiles → `/tokens/v1/{chain}/{addresses}` batch.
 *
 * Pairs are matched to venues v3-aware (dexId + version labels, verified
 * against the live API: PancakeSwap V3 reports dexId "pancakeswap" with
 * labels ["v3"], Uniswap V2 "uniswap" + ["v2"], Camelot "camelot").
 */
/**
 * Convex serializes snapshots into documents whose field names must be
 * non-control ASCII — a single scam token like "USDT 人" in a quote book
 * crashes the ENTIRE action server-side and starves the live feed (verified
 * in production). Symbols that are not printable ASCII are impersonator/fake
 * tokens: they are rejected at ingest so they can never become object keys —
 * and never "cleaned" into a key that could collide with the real token.
 */
export function isSafeSymbol(symbol: string): boolean {
  return /^[\x21-\x7E]{1,32}$/.test(symbol);
}

export async function fetchMarketSnapshot(
  chainKey: ChainKey = "bsc",
): Promise<MarketSnapshot> {
  const chain = CHAIN_INFO[chainKey];
  const quoteSymbol = chain.quoteSymbol;
  const quotes: MarketSnapshot["quotes"] = {};
  const tokenAddresses: MarketSnapshot["tokenAddresses"] = {};
  const wbnbUsdByDex: Record<string, number> = {};
  const wbnbLiq: Record<string, number> = {};
  const wbnbUsdCandidates: number[] = [];

  const pushQuote = (dexKey: string, symbol: string, quote: DexQuote, address?: string) => {
    // Non-ASCII impersonator symbols are rejected outright — they would crash
    // Convex serialization server-side (see isSafeSymbol) and starve the feed.
    if (!isSafeSymbol(symbol)) return;
    if (!quotes[dexKey]) quotes[dexKey] = {};
    const existing = quotes[dexKey][symbol];
    // Prefer the more liquid pair for the same (dex, token).
    if (!existing || quote.liquidityUsd > existing.liquidityUsd) {
      quotes[dexKey][symbol] = quote;
      if (address) {
        if (!tokenAddresses[dexKey]) tokenAddresses[dexKey] = {};
        tokenAddresses[dexKey][symbol] = address;
      }
    }
  };

  /**
   * Ingest ONE pair pricing BOTH sides — the un-starvation fix.
   *
   * DexScreener caps every endpoint at 30 pairs, so half-measures starve the
   * snapshot: the previous ingest kept only the base side (e.g. USDT in
   * USDT/WBNB) and used WBNB/USDT pairs solely for the reference price. With
   * the 30-pair cap that yielded 2 venues / 6 tokens and zero routes.
   *
   * `priceNative` (base price in quote units, present on every verified pair)
   * recovers the quote side: in WBNB/USDT the quote token USDT prices at
   * priceUsd / priceNative (base $750 ÷ 751.8 USDT-per-WBNB ≈ $1 USDT). Both
   * sides enter the quotes map, so 30 pairs → up to 60 real token prices.
   */
  const ingestPair = (dex: DexDef, p: DexScreenerPair) => {
    const base = (p.baseToken?.symbol ?? "").toUpperCase();
    const quoteSym = (p.quoteToken?.symbol ?? "").toUpperCase();
    const priceUsd = Number(p.priceUsd);
    const priceNative = Number(p.priceNative);
    const liquidityUsd = p.liquidity?.usd ?? 0;
    const volumeUsd = p.volume?.h24 ?? 0;
    if (!base || !Number.isFinite(priceUsd) || priceUsd <= 0) return;

    // Base side: priced directly by the API.
    if (base === quoteSymbol) {
      wbnbUsdCandidates.push(priceUsd);
      if ((wbnbLiq[dex.key] ?? 0) < liquidityUsd) {
        wbnbUsdByDex[dex.key] = priceUsd;
        wbnbLiq[dex.key] = liquidityUsd;
      }
    } else {
      pushQuote(dex.key, base, { usdPerToken: priceUsd, liquidityUsd, volumeUsd }, p.baseToken?.address);
    }

    // Quote side: recovered from priceNative when the quote is a different
    // real token (USDT / USDC / …). Its USD price is the pair's own implied
    // rate: base USD price ÷ (quote units per base unit) — e.g. a $750.27
    // WBNB priced at 751.8 USDT implies USDT ≈ $0.998. Multiplying instead of
    // dividing would inflate stables by ~priceNative× and corrupt every
    // USD-denominated cost (gas share, loan-asset pricing) downstream.
    if (quoteSym && quoteSym !== base && quoteSym !== quoteSymbol && Number.isFinite(priceNative) && priceNative > 0) {
      const quoteSideUsd = priceUsd / priceNative;
      if (quoteSideUsd > 0) {
        pushQuote(
          dex.key,
          quoteSym,
          { usdPerToken: quoteSideUsd, liquidityUsd, volumeUsd },
          p.quoteToken?.address,
        );
      }
    }
  };

  // --- Primary fetch: quote-token pairs (WBNB / WETH / WMATIC) ---
  try {
    const data = (await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${chain.quoteAddress}`,
    )) as { pairs?: DexScreenerPair[] } | null;
    if (data?.pairs) {
      for (const p of data.pairs) {
        if (p.chainId !== chain.dexScreenerChainId) continue;
        const dex = matchDexDef(p, chain);
        if (!dex) continue;
        ingestPair(dex, p);
      }
    }
  } catch {
    // A chain failing must not sink the rest of the terminal.
  }

  // --- Secondary fetch: broadened searches for wider token coverage ---
  // The old single `?q=<chain-slug>` search returned only ~30 pairs (verified
  // live), missing most listings. Several keyword searches — wrapped-native
  // symbol, wrapped/USDT and the chain slug — cover majors AND fresh tokens,
  // giving computeRoutes a much larger triangular universe.
  try {
    const queries = [
      quoteSymbol,
      `${quoteSymbol} USDT`,
      `${quoteSymbol} USDC`,
      chain.dexScreenerChainId,
    ];
    const results = await Promise.allSettled(
      queries.map((q) =>
        fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`) as Promise<{ pairs?: DexScreenerPair[] } | null>,
      ),
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value?.pairs) continue;
      for (const p of r.value.pairs) {
        if (p.chainId !== chain.dexScreenerChainId) continue;
        const dex = matchDexDef(p, chain);
        if (!dex) continue;
        // Both sides priced — same ingest as the primary fetch.
        ingestPair(dex, p);
      }
    }
  } catch {
    // Secondary fetch failure must not sink the feed.
  }

  // --- Tertiary fetch: trending tokens on the chain via DexScreener ---
  // Discover additional high-volume tokens that may form arb paths.
  try {
    const profiles = (await fetchJson(
      `https://api.dexscreener.com/token-profiles/latest/v1`,
    )) as Array<{ chainId?: string; tokenAddress?: string }> | null;
    if (profiles) {
      const chainTokens = profiles
        .filter((t) => t.chainId === chain.dexScreenerChainId && t.tokenAddress)
        .slice(0, 20)
        .map((t) => t.tokenAddress!);
      if (chainTokens.length > 0) {
        // DexScreener supports comma-separated token addresses
        const batchData = (await fetchJson(
          `https://api.dexscreener.com/tokens/v1/${chain.dexScreenerChainId}/${chainTokens.join(",")}`,
        )) as DexScreenerPair[] | { pairs?: DexScreenerPair[] } | null;
        const batchPairs = Array.isArray(batchData)
          ? batchData
          : batchData?.pairs ?? [];
        for (const p of batchPairs) {
          const dex = matchDexDef(p, chain);
          if (!dex) continue;
          // Both sides priced — same ingest as the primary fetch.
          ingestPair(dex, p);
        }
      }
    }
  } catch {
    // Tertiary fetch failure must not sink the feed.
  }

  // Quote token never appeared as a base pair anywhere ⇒ 0, so no route can
  // be priced until real data arrives. Never fabricates a spot price.
  const sorted = wbnbUsdCandidates
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  // Honest fallback: no quote-base pair reported anywhere ⇒ 0, so no route
  // can be priced until real data arrives. Never fabricates a spot price.
  const wbnbUsd =
    sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];

  // Flash-loan asset discovery from the SAME live pool data the routes price
  // from: every asset with deep wrapped-native pairs on >=2 venues qualifies
  // (V2 pairs flash-swap either side). Deepest-first, wrapped native first.
  const quoteLiq = Math.max(...Object.values(wbnbUsdByDex), 0);
  const loanAssets: LoanCandidate[] = [
    {
      symbol: quoteSymbol,
      address: chain.quoteAddress.toLowerCase(),
      liquidityUsd: quoteLiq,
      venues: Object.keys(wbnbUsdByDex).length,
      venueKeys: Object.keys(wbnbUsdByDex),
    },
    ...discoverLoanAssets({ quotes, tokenAddresses, quoteSymbol }),
  ];

  return {
    fetchedAt: Date.now(),
    quotes,
    tokenAddresses,
    wbnbUsd,
    wbnbUsdByDex,
    chainKey,
    quoteSymbol,
    quoteAddress: chain.quoteAddress,
    loanAssets,
  };
}

/**
 * Resolve the real token addresses for a route's legs into an execution
 * path: [WBNB, T1, (T2), WBNB]. Token legs are bought on the DEX that
 * follows them in the legs array (e.g. "CAKE" after "PCS"). Returns null
 * when any token address is missing from the live snapshot — such a route
 * can be paper-executed but not sent on chain.
 */
export function routePathAddresses(
  route: FlashRoute,
  snapshot: MarketSnapshot,
  wbnbAddress: string,
): string[] | null {
  const path: string[] = [wbnbAddress];
  for (let i = 2; i < route.legs.length - 1; i += 2) {
    const symbol = route.legs[i];
    const dexKey = route.legs[i - 1];
    const address = snapshot.tokenAddresses[dexKey]?.[symbol];
    if (!address) return null;
    path.push(address);
  }
  path.push(wbnbAddress);
  return path;
}

// ---------------------------------------------------------------------------
// Triangular route computation
// ---------------------------------------------------------------------------

export interface FeedSettings {
  /** Whitelisted DEX short codes. */
  dexWhitelist: string[];
  /**
   * Minimum all-in NET margin, percent — applied to each route's TRUE net
   * after its own venue swap fees, lender fee, slippage, gas and safety
   * margin (the engine prices every route individually).
   */
  minProfit: number;
  /** 2 = WBNB→T1→WBNB, 3 = WBNB→T1→T2→WBNB. */
  maxHops: 2 | 3;
  mevGuard: boolean;
  /** Upper bound for the flash loan, BNB (min is 0.1). */
  maxLoan: number;
  /** Minimum flash loan size, BNB (never below BNB_MIN_LOAN = 0.1). */
  minLoan: number;
  /** Daily flash loan execution limit (1 = no limit when set to Infinity). */
  dailyFlashLimit: number;
  /** Opportunity TTL window in seconds (40–90). */
  ttlWindow: number;
  /**
   * Flash-loan assets to price routes in, beyond the wrapped native.
   * Entries must be symbols DISCOVERED in the live snapshot (deep pairs on
   * >=2 venues — USDT, USDC, BTCB, whatever the market reports); unknown or
   * undiscovered symbols are ignored. Empty ⇒ native-denominated only.
   */
  loanAssets?: string[];
}

/**
 * Flash-loan bounds (strategy spec):
 *   • BNB flasher — min BNB loan 0.1 (default max 0.1), max 5/10 BNB.
 *   • SOL flasher — min SOL loan 0.05 (default max 5), max 5/50 SOL.
 *     The 0.05 floor matches the wallet-fit minimum clip (on Solana the
 *     wallet fronts the clip; a 0.055 SOL wallet can fund a 0.05 SOL route),
 *     so the strategy floor and the execution fit agree end to end.
 * User-tunable maxLoan values are clamped to these caps everywhere.
 */
export const BNB_MIN_LOAN = 0.1;
export const BNB_MAX_LOAN_CAP = 10;
export const SOL_MIN_LOAN = 0.05;
export const SOL_MAX_LOAN_CAP = 50;

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  dexWhitelist: [...EXCHANGE_KEYS],
  minProfit: 0.1,
  maxHops: 3,
  mevGuard: true,
  // min BNB loan 0.1 default (strategy spec) — max raised to the 5/10 cap
  maxLoan: 10,
  minLoan: 0.1,
  dailyFlashLimit: 3,
  ttlWindow: 90,
};

function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Compute the top triangular arbitrage routes from a live snapshot.
 * Every route crosses at least two DIFFERENT DEXs and is tagged with the
 * flash-loan lender for this scan run (Balancer v queue when `balanced`).
 */
/**
 * Resolve the on-chain address of a route's LOAN ASSET from the live
 * snapshot: the wrapped native resolves to the chain quote; anything else
 * uses the real token address the market data reported (any venue quoting
 * it). Returns null when the feed never saw the asset — such a route stays
 * paper-only. Nothing is hard-coded.
 */
export function resolveLoanAssetAddress(
  loanAsset: string,
  snapshot: MarketSnapshot,
  quoteAddress: string,
): string | null {
  const quoteSymbol = snapshot.quoteSymbol ?? "WBNB";
  if (loanAsset === quoteSymbol) return quoteAddress.toLowerCase();
  for (const perToken of Object.values(snapshot.tokenAddresses)) {
    const addr = perToken[loanAsset];
    if (addr) return addr.toLowerCase();
  }
  return null;
}

/**
 * Live USD price of a loan asset from its own quote data: the deepest venue
 * quoting the symbol wins. Stables come out at their real pegged price, the
 * wrapped native falls back to the snapshot reference. Nothing hard-coded.
 * Exported for the generated-route tier so every denomination prices from
 * the same live quotes (WETH on Ethereum, WBNB on BSC, stables everywhere).
 */
export function assetUsdPrice(symbol: string, snapshot: MarketSnapshot): number {
  let best = 0;
  let bestLiq = 0;
  for (const perToken of Object.values(snapshot.quotes)) {
    const q = perToken[symbol];
    if (q && q.usdPerToken > 0 && q.liquidityUsd > bestLiq) {
      best = q.usdPerToken;
      bestLiq = q.liquidityUsd;
    }
  }
  if (best > 0) return best;
  return symbol === (snapshot.quoteSymbol ?? "WBNB") ? snapshot.wbnbUsd : 0;
}

/**
 * Compute live cross-venue flash-loan routes from a real market snapshot.
 *
 * Every route's `profitPct` is ALL-IN net: the per-venue swap fees are
 * multiplied into the round trip, then the documented flash-loan fee of the
 * run's lender, the liquidity-derived slippage of the weakest leg, the
 * live-RPC gas share of the route's OWN loan size (converted into the loan
 * denomination at live USD prices) and a safety margin are deducted PER
 * ROUTE. The operator's `settings.minProfit` applies to that true net edge —
 * no flat worst-case break-even anywhere. Nothing is simulated: every input
 * comes from the aggregated live snapshot.
 */
export function computeRoutes(
  snapshot: MarketSnapshot,
  settings: FeedSettings,
  run: number,
  count = 8,
  balanced = false,
  gasPriceGwei: number | null = null,
  /**
   * Near-miss mode: keep routes whose GROSS cross-venue edge is real and
   * positive (spreadBps > 0 on pools with real depth) even when the ALL-IN
   * net after costs is negative. Verified live, BSC's honest market state is
   * gross spreads ~0.10% against ~1% of costs — the strict live filters
   * would starve BOTH tiers to 0 routes forever, leaving the feed empty
   * while the generator tier still shows routes. Live-tier honesty is
   * unchanged; only the near-miss pass is allowed below break-even.
   */
  nearMiss = false,
): FlashRoute[] {
  const chain = CHAIN_INFO[snapshot.chainKey ?? "bsc"];
  const quoteSymbol = snapshot.quoteSymbol ?? chain.quoteSymbol;
  // On-chain/testnet snapshots carry their own venue set (which differs from
  // the mainnet DexScreener registry); otherwise use the chain registry.
  const available = snapshot.venues ?? chain.dexes;
  const dexes = available.filter((e) => settings.dexWhitelist.includes(e.key));
  if (dexes.length < 2) return [];

  const lenders = snapshot.lenders ?? chain.lenders;
  const lender = lenderForRun(run, balanced, lenders);
  // Token universe is data-driven: everything the whitelisted DEXs report.
  const tokenSet = new Set<string>();
  for (const d of dexes) {
    for (const symbol of Object.keys(snapshot.quotes[d.key] ?? {})) {
      if (symbol !== quoteSymbol) tokenSet.add(symbol);
    }
  }
  const tokens = [...tokenSet];
  const routes: FlashRoute[] = [];

  const wbnbFor = (dexKey: string): number =>
    snapshot.wbnbUsdByDex[dexKey] ?? snapshot.wbnbUsd;
  const rate = (dexKey: string, symbol: string, assetUsd: number): number | undefined => {
    const q = snapshot.quotes[dexKey]?.[symbol];
    if (!q || q.usdPerToken <= 0 || assetUsd <= 0) return undefined;
    return q.usdPerToken / assetUsd;
  };
  const liquidity = (dexKey: string, symbol: string): number =>
    snapshot.quotes[dexKey]?.[symbol]?.liquidityUsd ?? 0;

  const pushRoute = (
    seed: string,
    t1: string,
    t2: string | null,
    d1: ExchangeInfo,
    d2: ExchangeInfo,
    d3: ExchangeInfo,
    netRaw: number,
    netAfterFees: number,
    loanAsset: string,
    assetUsd: number,
  ) => {
    const profitPct = (netAfterFees - 1) * 100;
    const spreadBps = Math.max(0, Math.round((netRaw - 1) * 10000));
    // Legs are named in the LOAN ASSET; stable-denominated routes read
    // ["USDT",…,"USDT"] and wrap through the native quote on execution.
    const legs =
      t2 === null
        ? [loanAsset, d1.key, t1, d2.key, loanAsset]
        : [loanAsset, d1.key, t1, d2.key, t2, d3.key, loanAsset];
    const dexesUsed = t2 === null ? [d1.key, d2.key] : [d1.key, d2.key, d3.key];
    const minLiq = Math.min(
      liquidity(d1.key, t1),
      t2 === null ? liquidity(d2.key, t1) : liquidity(d2.key, t2),
      t2 === null ? Number.MAX_SAFE_INTEGER : liquidity(d3.key, t2),
    );
    const seedHash = hashSeed(seed);
    // Low liquidity ⇒ deeper MEV exposure (front-run / sandwich).
    const baseRisk =
      minLiq < 50_000 ? 76 : minLiq < 200_000 ? 48 : minLiq < 800_000 ? 28 : 14;
    const mevRisk = Math.max(4, Math.min(97, baseRisk + (seedHash % 15) - 7));
    const ttlSeconds = Math.max(
      40,
      Math.min(90, settings.ttlWindow + (seedHash % 15) - 7),
    );
    // Loan size scales with the weakest leg's liquidity, clamped into the
    // strategy bounds [minLoan, maxLoan] — the hard 5/10 cap only limits
    // oversized values, never overrides a smaller strategy max. Sizing is
    // USD-depth-derived and uniform for every loan denomination (the asset
    // price already normalizes each leg's rate).
    const loanFloor = Math.min(settings.minLoan, BNB_MAX_LOAN_CAP);
    const loanCeiling = Math.min(settings.maxLoan, BNB_MAX_LOAN_CAP);
    const loanSizeBnb = Math.max(
      loanFloor,
      Math.min(
        loanCeiling,
        Math.max(loanFloor, Math.round((minLiq / 25_000) * 10) / 10),
      ),
    );
    // ALL-IN net: on top of the venue swap fees already multiplied into
    // `profitPct`, deduct the documented flash-loan fee of THIS route's
    // lender, the liquidity-derived slippage of the weakest leg, the live-RPC
    // gas share of THIS route's own loan size (gas is paid in the native
    // asset, converted into the loan denomination at live USD prices) and the
    // safety margin. Priced per route — never a flat estimate.
    const slippagePct = routeSlippagePct(minLiq);
    const gasNative = gasPriceGwei !== null
      ? gasCostBnb(gasPriceGwei, ROUTE_GAS_UNITS)
      : 0.001; // conservative fallback when the RPC is unreachable
    const gasInAsset =
      assetUsd > 0 && snapshot.wbnbUsd > 0
        ? (gasNative * snapshot.wbnbUsd) / assetUsd
        : gasNative;
    const gasPct = loanSizeBnb > 0 ? (gasInAsset / loanSizeBnb) * 100 : 0;
    const allInPct =
      profitPct - lenderFeePct(lender) - slippagePct - gasPct - ROUTE_SAFETY_MARGIN_PCT;
    routes.push({
      id: `route-${run}-${seedHash.toString(36)}`,
      legs,
      dexes: dexesUsed,
      profitPct: Math.round(allInPct * 100) / 100,
      spreadBps,
      ttlSeconds,
      mevRisk,
      lender,
      loanSizeBnb,
      loanAsset,
      liquidityUsd: minLiq === Number.MAX_SAFE_INTEGER ? 0 : minLiq,
    });
  };

  // Loan bases: the wrapped native always; plus every DISCOVERED asset the
  // operator enabled (empty/missing ⇒ native-only, exactly the old behavior).
  // Asset USD price comes from its own live quotes — nothing hard-coded.
  const discovered = (snapshot.loanAssets ?? []).filter(
    (a) => a.symbol !== quoteSymbol,
  );
  const enabledSymbols = (settings.loanAssets ?? []).filter((s) =>
    discovered.some((a) => a.symbol === s),
  );
  const loanBases: Array<{ symbol: string; usd: number }> = [
    { symbol: quoteSymbol, usd: snapshot.wbnbUsd },
    ...enabledSymbols.map((symbol) => ({
      symbol,
      usd: assetUsdPrice(symbol, snapshot),
    })),
  ];
  for (const base of loanBases) {
    if (!(base.usd > 0)) continue;
    /**
     * The loan asset's LIVE price ON EACH VENUE. Cross-venue arbitrage
     * exists precisely because the quote token trades at DIFFERENT rates
     * per venue (verified live: WBNB ~751.3 USDT on PCS vs ~749.9 on
     * BabySwap — 18 bps of real dispersion). Normalizing every leg by ONE
     * global quote price cancelled that dispersion and understated every
     * gross edge by 10–100×, starving the engine to 0 routes even while
     * real spreads sat in the snapshot. Entry and exit legs are priced at
     * each venue's own rates; mid legs share one venue so any constant
     * divisor cancels.
     */
    const assetUsdOn = (dexKey: string): number =>
      base.symbol === quoteSymbol
        ? wbnbFor(dexKey)
        : snapshot.quotes[dexKey]?.[base.symbol]?.usdPerToken || base.usd;
  for (const t1 of tokens) {
    // 2-leg triangle: ASSET → T1 on D1 → ASSET on D2 (D1 ≠ D2).
    for (const d1 of dexes) {
      for (const d2 of dexes) {
        if (d1.key === d2.key) continue;
        const r1 = rate(d1.key, t1, assetUsdOn(d1.key));
        const r2 = rate(d2.key, t1, assetUsdOn(d2.key));
        if (!r1 || !r2 || r1 <= 0 || r2 <= 0) continue;
        const netRaw = (1 / r1) * r2;
        const net = netRaw * (1 - d1.fee) * (1 - d2.fee);
        pushRoute(`2-${base.symbol}-${t1}-${d1.key}-${d2.key}`, t1, null, d1, d2, d2, netRaw, net, base.symbol, base.usd);
      }
    }

    // 3-leg triangle: ASSET → T1 on D1 → T2 on D2 → ASSET on D3 (D1 ≠ D3).
    if (settings.maxHops >= 3) {
      for (const t2 of tokens) {
        if (t1 === t2) continue;
        for (const d1 of dexes) {
          for (const d2 of dexes) {
            for (const d3 of dexes) {
              if (d1.key === d3.key) continue;
              const r1 = rate(d1.key, t1, assetUsdOn(d1.key));
              const r2a = rate(d2.key, t1, base.usd);
              const r2b = rate(d2.key, t2, base.usd);
              const r3 = rate(d3.key, t2, assetUsdOn(d3.key));
              if (!r1 || !r2a || !r2b || !r3) continue;
              if (r1 <= 0 || r2a <= 0 || r2b <= 0 || r3 <= 0) continue;
              const netRaw = (1 / r1) * (r2b / r2a) * r3;
              const net = netRaw * (1 - d1.fee) * (1 - d2.fee) * (1 - d3.fee);
              pushRoute(
                `3-${base.symbol}-${t1}-${t2}-${d1.key}-${d2.key}-${d3.key}`,
                t1,
                t2,
                d1,
                d2,
                d3,
                netRaw,
                net,
                base.symbol,
                base.usd,
              );
            }
          }
        }
      }
    }
  }
  }

  // Keep only routes with a PLAUSIBLE edge on pools with real depth, rank
  // by net profit, dedupe. The plausibility guards keep junk pairs
  // (stale/scam pricing) out of the feed — nothing is fabricated.
  //
  // LIVE tier: the all-in net must be genuinely positive and clear the
  // operator's margin — unchanged.
  // NEAR-MISS tier: every route with a REAL positive gross edge (spreadBps
  // > 0 before any fee) on pools with real depth qualifies, even when the
  // all-in costs exceed the gross spread. ranked closest-to-profitability
  // first. Same engine, same real quotes — only the profitability cut is
  // loosened, never the data-plausibility guards.
  const seen = new Set<string>();
  return routes
    .filter((r) => (nearMiss ? r.spreadBps > 0 : r.profitPct > 0.001))
    // Operator's minimum margin on the TRUE (all-in) net edge (live only).
    .filter((r) => nearMiss || r.profitPct >= settings.minProfit)
    .filter((r) => r.liquidityUsd >= MIN_ROUTE_LIQUIDITY_USD)
    .filter((r) => r.profitPct <= MAX_ROUTE_PROFIT_PCT)
    .sort((a, b) => b.profitPct - a.profitPct)
    .filter((r) => {
      const key = r.legs.join(">");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count);
}

// ---------------------------------------------------------------------------
// eth_call simulation — zero-gas pre-flight check
// ---------------------------------------------------------------------------

/**
 * Simulate a flash-loan execution via eth_call (read-only, zero gas cost).
 * Returns true if the on-chain node considers the transaction valid.
 * Catches reverts from profit guards, slippage caps, insufficient liquidity,
 * paused tokens, and honeypot traps — all before spending any gas.
 */
export async function simulateFlashLoanTx(
  rpcUrl: string,
  contractAddress: string,
  from: string,
  data: `0x${string}`,
  chainId: number,
): Promise<{ success: boolean; error?: string; latencyMs: number; raced: number }> {
  // Raced full eth_call simulation: the exact execute() calldata is executed
  // read-only on every fast CORS-open endpoint for the chain in parallel —
  // the FIRST DEFINITIVE verdict wins (a revert is definitive; only network
  // misses are skipped). This is the flasher's zero-gas pre-broadcast gate:
  // a failed simulation means NOTHING is sent and no gas is spent.
  const endpoints = rpcSetFor(chainId, rpcUrl);
  const params: Record<string, string> = {
    from,
    to: contractAddress,
    data,
    gas: "0x1e8480", // 2M gas limit for simulation
  };
  const t0 = performance.now();

  const raced = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const { fetchWithTimeout } = await import("./fetch-timeout");
        const res = await fetchWithTimeout(endpoint, 4_000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [params, "latest"],
          }),
        });
        const json = (await res.json()) as {
          result?: string;
          error?: { message?: string; data?: string };
        };
        if (json.error) {
          const reason =
            (json.error.data?.startsWith("0x08c379a0")
              ? (() => {
                  try {
                    const bytes =
                      json.error.data!.slice(10).match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
                    return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0/g, "").trim();
                  } catch {
                    return undefined;
                  }
                })()
              : undefined) ?? json.error.message ?? json.error.data ?? "Simulation reverted";
          return { definitive: true as const, ok: false as const, error: reason };
        }
        if (json.result && json.result !== "0x" && json.result.startsWith("0x08c379a0")) {
          // Result itself encodes Error(string) — a revert with a reason.
          try {
            const bytes = json.result.slice(10).match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
            const msg = new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0/g, "").trim();
            return { definitive: true as const, ok: false as const, error: msg || "Simulation reverted" };
          } catch {
            return { definitive: true as const, ok: false as const, error: "Simulation reverted" };
          }
        }
        return { definitive: true as const, ok: true as const };
      } catch {
        // Network miss — not a verdict; other endpoints still race.
        return { definitive: false as const, ok: false as const, error: "endpoint unreachable" };
      }
    }),
  );

  const latencyMs = performance.now() - t0;
  const firstDefinitive = raced.find((r) => r.definitive);
  if (!firstDefinitive) {
    return {
      success: false,
      error: "RPC unreachable — refusing to broadcast (zero gas saved)",
      latencyMs,
      raced: endpoints.length,
    };
  }
  if (!firstDefinitive.ok) {
    return { success: false, error: firstDefinitive.error, latencyMs, raced: endpoints.length };
  }
  return { success: true, latencyMs, raced: endpoints.length };
}

/** Fast CORS-open RPC endpoints per chain (live-verified chainId + CORS). */
const FAST_RPC_SETS: Record<number, string[]> = {
  56: [
    "https://rpc-bsc.48.club",
    "https://bsc.publicnode.com",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed1.ninicoin.io",
  ],
  97: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
  1: ["https://ethereum-rpc.publicnode.com"],
  137: ["https://polygon-bor-rpc.publicnode.com"],
  42161: ["https://arbitrum-one-rpc.publicnode.com"],
};

/** Endpoints for a chainId, always including the canonical RPC last (fallback). */
export function rpcSetFor(chainId: number, canonical: string): string[] {
  const set = FAST_RPC_SETS[chainId] ?? [];
  return set.includes(canonical) ? set : [...set, canonical];
}

/**
 * Daily execution tracker — enforces per-day flash-loan and snipe limits.
 * Stored in localStorage (client-side only, no backend changes needed).
 */
export interface DailyExecTracker {
  date: string;           // YYYY-MM-DD
  flashCount: number;     // flash-loan executions today
  snipeCount: number;     // snipe executions today
  wins: number;           // successful txs today
  losses: number;         // failed/reverted txs today
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadDailyTracker(key: string): DailyExecTracker {
  try {
    const raw = localStorage.getItem(`tracker_${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as DailyExecTracker;
      if (parsed.date === todayKey()) return parsed;
    }
  } catch { /* ignore */ }
  return { date: todayKey(), flashCount: 0, snipeCount: 0, wins: 0, losses: 0 };
}

export function saveDailyTracker(key: string, tracker: DailyExecTracker): void {
  tracker.date = todayKey();
  try { localStorage.setItem(`tracker_${key}`, JSON.stringify(tracker)); } catch { /* ignore */ }
}

export function incrementTracker(key: string, type: "flash" | "snipe", status: "win" | "loss"): DailyExecTracker {
  const tracker = loadDailyTracker(key);
  if (type === "flash") tracker.flashCount++;
  else tracker.snipeCount++;
  if (status === "win") tracker.wins++;
  else tracker.losses++;
  saveDailyTracker(key, tracker);
  return tracker;
}

export function canExecute(key: string, type: "flash" | "snipe", limit: number): boolean {
  if (limit <= 0 || !isFinite(limit)) return true; // 0 or Infinity = unlimited
  const tracker = loadDailyTracker(key);
  const count = type === "flash" ? tracker.flashCount : tracker.snipeCount;
  return count < limit;
}
