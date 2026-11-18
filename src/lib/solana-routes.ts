/**
 * SOL Telecopier — signal → live arbitrage route engine (SOL FlashBolt).
 *
 * The BNB Telecopier turns each copied Telegram signal into a cross-venue
 * EVM route. This engine does the same on Solana: for each signal's mint it
 * pulls the token's live pairs from DexScreener, keeps pairs on whitelisted
 * Solana venues, computes the real cross-venue price spread and builds the
 * round trip  WSOL → Token (cheap venue) → WSOL (dear venue). Routes whose
 * legs do not exist on-chain are never emitted — nothing is simulated.
 */

import { SOL_CHAIN, SOL_DEXES, SOL_QUOTE, type SolDexDef } from "./solana";
import type { FlashRoute } from "./flashbolt";
import { SOL_MAX_LOAN_CAP, SOL_MIN_LOAN } from "./flashbolt";

/** A signal row as stored by the shared copier backend (copierSignals). */
export interface SolTelecopierSignal {
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

/** A signal converted into a WSOL flash-loan route for the SOL feed. */
export interface SolTelecopierRoute extends FlashRoute {
  /** The copier signal id the route was built from. */
  signalId: string;
  /** Telegram channel the signal came from. */
  signalSource: string;
  /** Token mint address from the signal. */
  tokenAddress: string;
  /** Real cross-venue price spread the legs were priced from (%). */
  venueSpreadPct: number;
  /** Loan size in SOL — same value as the native-units loanSizeBnb field. */
  loanSizeSol: number;
}

/** DexScreener pair subset used by the builder. */
interface DsPair {
  chainId?: string;
  dexId?: string;
  labels?: string[];
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { symbol?: string };
  /** 24h volume in USD — the staleness tell for venue-price sanity. */
  volume24hUsd?: number;
  /** 1h price change in percent — the other freshness signal. */
  priceChange1h?: number;
}

/** Fetch with a hard timeout — never hangs the poll loop. */
async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch a mint's live DexScreener pairs by token address.
 * Returns every venue where the token currently trades.
 */
export async function fetchSolTokenPairs(address: string): Promise<DsPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const data = await fetchJson<{ pairs?: DsPair[] }>(url);
  return Array.isArray(data.pairs) ? data.pairs : [];
}

/**
 * Resolve which terminal venue def a DexScreener pair belongs to when several
 * share one dexId (Raydium AMM v4 vs CLMM). Preference order:
 *   1. a def whose version labels match the pair's labels (DexScreener marks
 *      CLMM pairs with labels ["CLMM"], Whirlpools with ["wp"], DLMM with
 *      ["DLMM"] — verified live);
 *   2. an unversioned def (Raydium AMM v4, PumpSwap);
 *   3. the HIGHEST-FEE versioned def — the conservative pick, so an unknown
 *      label can never overstate a route's profit.
 */
function resolveVenue(defs: SolDexDef[], pairLabels: string[]): SolDexDef | null {
  if (defs.length === 0) return null;
  const versioned = defs.filter((d) => d.labels && d.labels.length > 0);
  const unversioned = defs.filter((d) => !d.labels || d.labels.length === 0);
  const labelMatch = versioned.find((d) => pairLabels.some((l) => d.labels!.includes(l)));
  if (labelMatch) return labelMatch;
  if (unversioned.length > 0) return unversioned[0]!;
  return versioned.reduce((a, b) => (b.fee > a.fee ? b : a)) ?? null;
}

/**
 * Build a real cross-venue arbitrage route from one copied Solana signal.
 *
 * Prices the signal's mint across whitelisted Solana venues (DexScreener
 * dexIds mapped onto SOL_DEXES), then emits the best two-venue round trip
 * as a triangular FlashRoute denominated in WSOL. Returns null when the
 * token does not trade on at least two whitelisted venues with real
 * liquidity — such signals cannot be flashed.
 */
export async function buildSolTelecopierRoute(
  signal: SolTelecopierSignal,
  opts: {
    /** Whitelisted venue keys (SOL_DEXES keys, e.g. ["RAY","ORCA"]). */
    dexWhitelist: string[];
    /** Flash-loan lender for the generated route. */
    lender: string;
    /** Loan size in SOL. */
    loanSizeSol: number;
    /** Route id seed (scan run). */
    run: number;
  },
): Promise<SolTelecopierRoute | null> {
  // Terminal DEX key grouping: several venues share a dexId (raydium),
  // disambiguated per pair via labels.
  const allowed = new Map<string, SolDexDef[]>();
  for (const d of SOL_DEXES) {
    if (opts.dexWhitelist.length > 0 && !opts.dexWhitelist.includes(d.key)) continue;
    const id = d.dexId.toLowerCase();
    const group = allowed.get(id);
    if (group) group.push(d);
    else allowed.set(id, [d]);
  }
  if (allowed.size < 2) return null;

  let pairs: DsPair[];
  try {
    pairs = await fetchSolTokenPairs(signal.address);
  } catch {
    return null;
  }

  // Keep only real pairs on Solana on whitelisted venues with real liquidity.
  const candidates = pairs
    .filter((p) => (p.chainId ?? "").toLowerCase() === SOL_CHAIN.dexScreenerChainId)
    .map((p) => {
      const group = allowed.get((p.dexId ?? "").toLowerCase());
      const venue = group ? resolveVenue(group, Array.isArray(p.labels) ? p.labels : []) : null;
      const price = Number(p.priceUsd ?? 0);
      const liq = Number(p.liquidity?.usd ?? 0);
      if (!venue || price <= 0 || liq < 5_000) return null;
      // VENUE-PRICE SANITY: a pair that traded NOTHING in 24h and moved 0%
      // in an hour carries a STALE mark — mixing it against a fresh venue
      // produced phantom spreads like +10,040,671% on memecoins. Those are
      // quoting artifacts, never executable, so the stale side is dropped
      // from arb consideration (the venue still exists; the price is just
      // not live). Applied ONLY when DexScreener actually reports both
      // signals — absent fields mean unknown freshness, which the spread
      // absurdity cap below still bounds.
      if (p.volume24hUsd !== undefined && p.priceChange1h !== undefined) {
        const volume24hUsd = Number(p.volume24hUsd);
        const moved1h = Math.abs(Number(p.priceChange1h ?? 0));
        if (volume24hUsd < 1_000 && moved1h < 0.01) return null;
      }
      return { venue, price, liq };
    })
    .filter((x): x is { venue: SolDexDef; price: number; liq: number } => x !== null);

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
  // ABSURDITY CAP: cross-venue marks for the same mint can never diverge by
  // orders of magnitude while both are live — anything beyond +200% is a
  // stale-vs-fresh artifact (or a honeypot quote). Dropping it keeps the
  // ledger honest: no more million-percent paper PnL.
  if (spreadPct > 200) return null;
  // Round-trip arb nets the spread minus two legs' fees; price both in.
  const grossPct = spreadPct - (cheap.venue.fee + dear.venue.fee) * 100;

  const symbol = signal.symbol || cheap.venue.key;
  const legs = [SOL_QUOTE.symbol, cheap.venue.key, symbol, dear.venue.key, SOL_QUOTE.symbol];
  const now = Date.now();
  const ttlSeconds = Math.max(45, Math.min(90, 75 - Math.floor((now - signal.capturedAt) / 60_000)));
  // Strategy bounds: [SOL_MIN_LOAN, requested size] clamped by the 5/50 cap.
  const loanSizeSol = Math.max(
    SOL_MIN_LOAN,
    Math.min(opts.loanSizeSol, SOL_MAX_LOAN_CAP),
  );

  return {
    id: `stc-${signal.id}-${opts.run}`,
    legs,
    dexes: [cheap.venue.key, dear.venue.key],
    profitPct: Math.round(grossPct * 100) / 100,
    spreadBps: Math.max(0, Math.round(spreadPct * 100)),
    ttlSeconds,
    // Telegram signals carry honeypot risk on new tokens — rated medium.
    mevRisk: 45,
    lender: opts.lender,
    // loanSizeBnb = loan size in NATIVE units; on Solana that is SOL.
    loanSizeBnb: loanSizeSol,
    loanAsset: SOL_QUOTE.symbol,
    loanSizeSol,
    liquidityUsd: Math.min(cheap.liq, dear.liq),
    signalId: signal.id,
    signalSource: signal.sourceLabel,
    tokenAddress: signal.address,
    venueSpreadPct: Math.round(spreadPct * 100) / 100,
  };
}

/**
 * Convert a batch of Solana signals into routes. Signals whose mints have no
 * two-venue spread are skipped (never fabricated) — the rest land in the SOL
 * LIVE ROUTE FEED and can execute through the normal guard stack.
 */
export async function buildSolTelecopierRoutes(
  signals: SolTelecopierSignal[],
  opts: Parameters<typeof buildSolTelecopierRoute>[1],
  maxRoutes = 6,
): Promise<SolTelecopierRoute[]> {
  const routes: SolTelecopierRoute[] = [];
  const seen = new Set<string>();
  // Freshest signals first — sub-millisecond capture ordering.
  const ordered = [...signals].sort((a, b) => b.capturedAt - a.capturedAt);
  for (const s of ordered) {
    if (routes.length >= maxRoutes) break;
    // Only flash signals the parser marked buyable on Solana — cross-chain
    // tokens cannot be flashed here. Filters run BEFORE the address dedupe
    // so a rejected signal can never poison the key for a later usable copy.
    if (!s.buyable) continue;
    if (s.chain !== "solana") continue;
    const key = s.address.toLowerCase() + ":solana";
    if (seen.has(key)) continue;
    seen.add(key);
    const route = await buildSolTelecopierRoute(s, opts).catch(() => null);
    if (route) routes.push(route);
  }
  return routes;
}
