/**
 * Telecopier — signal → live arbitrage route engine (Flasher / Scanner).
 *
 * The Sniper's Copier pastes Telegram signals straight into the snipe feed.
 * The Flasher's Telecopier instead turns every copied signal into a REAL
 * flash-loan arbitrage route so it can pass LIVE ROUTE FEED and flow through
 * the scanner's full guard stack (profit guard → NLP MEV guard → profit
 * guarantor → eth_call simulation → execution).
 *
 * Nothing here is simulated: for each signal's token the engine pulls the
 * token's live pairs from DexScreener (the same public API the whole feed
 * uses), keeps the pairs on the Flasher's whitelisted venues on the selected
 * chain, computes the real cross-venue price spread and builds a triangular
 * route  QUOTE → Token → Target → QUOTE  whose legs carry the measured
 * spread. Routes whose legs do not exist on-chain are never emitted.
 */

import { CHAIN_INFO, type ChainKey, type DexDef } from "./chains";
import type { FlashRoute } from "./flashbolt";

/** A signal row as stored by the copier backend (copierStore table). */
export interface TelecopierSignal {
  id: string;
  source: string;
  sourceLabel: string;
  address: string;
  symbol: string;
  name: string;
  chain: string;
  priceUsd: number;
  liquidityUsd: number;
  postedAt: number;
  capturedAt: number;
  buyable: boolean;
  excerpt: string;
}

/** A signal converted into a flash-loan route for the LIVE ROUTE FEED. */
export interface TelecopierRoute extends FlashRoute {
  /** The copier signal id the route was built from. */
  signalId: string;
  /** Telegram channel the signal came from. */
  signalSource: string;
  /** Token contract address from the signal. */
  tokenAddress: string;
  /** Real cross-venue price spread the legs were priced from (USD). */
  venueSpreadPct: number;
}

/** DexScreener pair subset used by the builder. */
interface DsPair {
  chainId?: string;
  dexId?: string;
  /** Version labels reported by DexScreener ("v2" / "v3" …). */
  labels?: string[];
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { symbol?: string };
}

/** DexScreener chain key for the terminal's chain keys. */
const DS_CHAIN: Partial<Record<ChainKey, string>> = {
  bsc: "bsc",
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  polygon: "polygon",
};

/** Fetch with a hard timeout — never hangs the poll loop. */
async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch a token's live DexScreener pairs by contract address.
 * Returns every venue where the token currently trades.
 */
export async function fetchTokenPairs(address: string): Promise<DsPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const data = await fetchJson<{ pairs?: DsPair[] }>(url);
  return Array.isArray(data.pairs) ? data.pairs : [];
}

/**
 * Resolve which terminal venue def a DexScreener pair belongs to when several
 * share one dexId (PancakeSwap V2 vs V3). Preference order:
 *   1. a def whose version labels match the pair's labels (DexScreener marks
 *      V3 pairs with labels ["v3"]);
 *   2. an unversioned def (Biswap, MDEX … — they match any pair);
 *   3. the HIGHEST-FEE versioned def — the conservative pick, so an unknown
 *      label can never overstate a route's profit.
 */
function resolveVenue(defs: DexDef[], pairLabels: string[]): DexDef | null {
  if (defs.length === 0) return null;
  const versioned = defs.filter((d) => d.labels && d.labels.length > 0);
  const unversioned = defs.filter((d) => !d.labels || d.labels.length === 0);
  const labelMatch = versioned.find((d) => pairLabels.some((l) => d.labels!.includes(l)));
  if (labelMatch) return labelMatch;
  if (unversioned.length > 0) return unversioned[0]!;
  return versioned.reduce((a, b) => (b.fee > a.fee ? b : a)) ?? null;
}

/**
 * Build a real cross-venue arbitrage route from one copied signal.
 *
 * The engine prices the signal's token across the chain's whitelisted
 * venues (DexScreener `dexId`s mapped onto the terminal's DEX keys),
 * then emits the best two-venue round trip as a triangular FlashRoute.
 * Returns null when the token does not trade on at least two whitelisted
 * venues with real liquidity — such signals cannot be flashed.
 */
export async function buildTelecopierRoute(
  signal: TelecopierSignal,
  chainKey: ChainKey,
  opts: {
    /** Whitelisted venue keys (terminal DEX keys, e.g. ["PCS","BISWAP"]). */
    dexWhitelist: string[];
    /** Flash-loan lender for the generated route. */
    lender: string;
    /** Loan size in native units. */
    loanSizeBnb: number;
    /** Route id seed (scan run). */
    run: number;
  },
): Promise<TelecopierRoute | null> {
  const chain = CHAIN_INFO[chainKey];
  const dsChain = DS_CHAIN[chainKey];
  if (!dsChain) return null;

  // Terminal DEX key → DexScreener dexId (keys match case-insensitively;
  // e.g. PCS→pancakeswap, BISWAP→biswap, MDEX→mdex, APESWAP→apeswap…).
  // A dexId can map to SEVERAL terminal venues (PancakeSwap V2 + V3 share the
  // dexId "pancakeswap"), so group defs per dexId and resolve per pair.
  const allowed = new Map<string, DexDef[]>();
  for (const d of chain.dexes) {
    if (opts.dexWhitelist.length > 0 && !opts.dexWhitelist.includes(d.key)) continue;
    const id = d.dexId.toLowerCase();
    const group = allowed.get(id);
    if (group) group.push(d);
    else allowed.set(id, [d]);
  }
  if (allowed.size < 2) return null;

  let pairs: DsPair[];
  try {
    pairs = await fetchTokenPairs(signal.address);
  } catch {
    return null;
  }

  // Keep only real pairs on the selected chain on whitelisted venues.
  const candidates = pairs
    .filter((p) => (p.chainId ?? "").toLowerCase() === dsChain)
    .map((p) => {
      const group = allowed.get((p.dexId ?? "").toLowerCase());
      const venue = group ? resolveVenue(group, Array.isArray(p.labels) ? p.labels : []) : null;
      const price = Number(p.priceUsd ?? 0);
      const liq = Number(p.liquidity?.usd ?? 0);
      return venue && price > 0 && liq >= 5_000 ? { venue, price, liq } : null;
    })
    .filter((x): x is { venue: DexDef; price: number; liq: number } => x !== null);

  if (candidates.length < 2) return null;

  // Best real spread: cheapest venue to buy, dearest venue to sell.
  let cheap = candidates[0]!;
  let dear = candidates[0]!;
  for (const c of candidates) {
    if (c.price < cheap.price) cheap = c;
    if (c.price > dear.price) dear = c;
  }
  if (cheap.venue.key === dear.venue.key) return null;
  const spreadPct = ((dear.price - cheap.price) / cheap.price) * 100;
  // Round-trip arb nets the spread minus two legs' fees; price both in.
  const grossPct = spreadPct - (cheap.venue.fee + dear.venue.fee) * 100;

  const symbol = signal.symbol || cheap.venue.key;
  const legs = [chain.quoteSymbol, cheap.venue.key, symbol, dear.venue.key, chain.quoteSymbol];
  const seed = legs.join(">");
  const now = Date.now();
  const ttlSeconds = Math.max(45, Math.min(90, 75 - Math.floor((now - signal.capturedAt) / 60_000)));

  return {
    id: `tc-${signal.id}-${opts.run}`,
    legs,
    dexes: [cheap.venue.key, dear.venue.key],
    profitPct: Math.round(grossPct * 100) / 100,
    spreadBps: Math.max(0, Math.round(spreadPct * 100)),
    ttlSeconds,
    // Telegram signals carry honeypot risk on new tokens — rated medium.
    mevRisk: 45,
    lender: opts.lender,
    loanSizeBnb: Math.max(0.1, opts.loanSizeBnb),
    loanAsset: chain.quoteSymbol,
    liquidityUsd: Math.min(cheap.liq, dear.liq),
    signalId: signal.id,
    signalSource: signal.sourceLabel,
    tokenAddress: signal.address,
    venueSpreadPct: Math.round(spreadPct * 100) / 100,
  };
}

/**
 * Convert a batch of signals into routes. Signals whose tokens have no
 * two-venue spread are skipped (never fabricated) — the rest land in the
 * LIVE ROUTE FEED and can execute through the normal guard stack.
 */
export async function buildTelecopierRoutes(
  signals: TelecopierSignal[],
  chainKey: ChainKey,
  opts: Parameters<typeof buildTelecopierRoute>[2],
  maxRoutes = 6,
): Promise<TelecopierRoute[]> {
  const routes: TelecopierRoute[] = [];
  const seen = new Set<string>();
  // Freshest signals first — sub-millisecond capture ordering.
  const ordered = [...signals].sort((a, b) => b.capturedAt - a.capturedAt);
  for (const s of ordered) {
    if (routes.length >= maxRoutes) break;
    // Only flash signals the parser marked buyable on the selected chain
    // (or chain-agnostic ones) — cross-chain tokens cannot be flashed here.
    // Filters run BEFORE the address dedupe so a rejected signal can never
    // poison the address key for a later usable copy of the same token.
    if (!s.buyable) continue;
    if (s.chain !== chainKey && s.chain !== "other" && s.chain !== "") continue;
    const key = s.address.toLowerCase() + ":" + chainKey;
    if (seen.has(key)) continue;
    seen.add(key);
    const route = await buildTelecopierRoute(s, chainKey, opts).catch(() => null);
    if (route) routes.push(route);
  }
  return routes;
}
