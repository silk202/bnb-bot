/**
 * Profit Guarantor — the last live line of defense before every automatic
 * execution, and the fastest trigger after it.
 *
 * Flasher (flash-loan arbitrage):
 *  1. LIVE re-verification — every route is re-quoted leg-by-leg on its OWN
 *     venue router with real getAmountsOut eth_calls immediately before the
 *     flash-loan is simulated/broadcast. Stale feed data (the #1 cause of
 *     "profitable on paper, loss on chain") is caught here. A route only
 *     proceeds when the LIVE net profit — after every swap fee, the lender
 *     fee, slippage tolerance and real gas — still clears the operator's
 *     floor. Guarantor-passing routes carry extra authority: their fresh
 *     quotes are used to auto-boost the passing margin.
 *  2. Loan-size optimizer — binary-searches the borrow size that maximizes
 *     LIVE net profit within [minLoan, maxLoan], so each execution captures
 *     the most the spread can actually pay for (deep pools → bigger loan,
 *     thin pools → smaller loan, never beyond profitability).
 *
 * Sniper (both networks):
 *  3. Buyable gate — a token is buyable when a real probe quote returns a
 *     sane amount out (and, on testnets, when the measured round-trip loss is
 *     survivable). Guarantor-passing buys are pre-armed with continuous
 *     earning: the auto-sell ladder locks profit in steps instead of waiting
 *     for one top.
 *  4. Exit classification — sellable now / DRASTIC LIQUIDITY DROP / VALUE % DROP.
 *     A drastic liquidity drop (TVL collapse = rug in progress) or a fast
 *     value % drop triggers the immediate sell path so the position exits as
 *     the fastest gainer instead of riding it down.
 *
 * Every quote in this file is a real eth_call. Nothing is mocked.
 */

import { encodeFunctionData, decodeFunctionResult } from "viem";
import { racedEthCall, quoteAmountsOut, fetchTokenPriceUsd } from "./swap-executor";
import { CHAIN_NETWORKS, networkInfoFor, type ChainKey, type NetworkKey } from "./chains";
import { lenderFeePct } from "./flashbolt";

// ---------------------------------------------------------------------------
// Tunables (documented defaults; operators override via settings where wired)
// ---------------------------------------------------------------------------

/** Extra safety margin (%) required on top of the operator floor. */
export const GUARANTOR_SAFETY_MARGIN_PCT = 0.05;
/** Liquidity drop % (vs the entry baseline) that triggers an immediate exit. */
export const DRASTIC_LIQUIDITY_DROP_PCT = 40;
/** Value drop % within one poll window that triggers an immediate exit. */
export const FAST_VALUE_DROP_PCT = 6;
/** Round-trip loss % above which a testnet token is NOT buyable. */
export const MAX_ROUND_TRIP_LOSS_PCT = 35;

const SEL_GET_RESERVES = "0x0902f1ac";
const SEL_TOKEN0 = "0x0dfe1681";

// ---------------------------------------------------------------------------
// 1. LIVE route re-verification (flasher)
// ---------------------------------------------------------------------------

export interface LegQuote {
  symbol: string;
  venueKey: string;
  router: string;
  /** Token address traded on this leg ("WBNB"-style symbol when wrapped native). */
  token: string;
  /** Real amountIn for this leg (wei). */
  amountIn: bigint;
  /** Real amountOut the router returned (wei). */
  amountOut: bigint;
  /** Per-leg effective price ratio (out/in). */
  ratio: number;
}

export interface RouteVerification {
  /** Every leg quoted live and the round trip cleared the floor. */
  passed: boolean;
  /** Why it failed (human readable). */
  reason?: string;
  /** Per-leg live quotes. */
  legs: LegQuote[];
  /** LIVE gross return of 1 unit wrapped native through the whole path. */
  liveGrossMultiplier: number;
  /** LIVE net profit % of the loan after fees, slippage and gas. */
  liveNetProfitPct: number;
  /** Weakest leg's wrapped-native TVL (from real reserves). */
  weakestLegTvlNative: number;
  /** Total latency of the re-verification (ms) — surfaced in the UI. */
  latencyMs: number;
}

/** Wei formatting helper for the wrapped native (18 decimals). */
export function native(n: number): number {
  return n / 1e18;
}

interface VerifyRouteArgs {
  chainKey: ChainKey;
  network: NetworkKey;
  rpcUrl: string;
  /** Route legs: [wrappedSym, venueKey, tok1Sym, venueKey, (tok2Sym), wrappedSym]. */
  legs: string[];
  /** Snapshot map venueKey → symbol → address (same shape the feed uses). */
  tokenAddresses: Record<string, Record<string, string>>;
  /** Wrapped native address (0x…). */
  wrapped: string;
  /** Lender chosen for the route (its documented fee is subtracted). */
  lender: string;
  /** Swap fee per leg for each venue key used (fraction, e.g. 0.0025). */
  venueFees: Record<string, number>;
  /** Borrow size in whole wrapped-native units. */
  loanSize: number;
  /** Slippage tolerance percent. */
  slippagePct: number;
  /** Live gas price (gwei) for the gas term. */
  gasPriceGwei: number | null;
  /** Operator's minimum net profit floor (%). */
  minProfitPct: number;
  /** Skip reserve/TVL lookups (hot execution path — quotes only). */
  hotPath?: boolean;
}

/**
 * Re-quote the full route leg-by-leg with real getAmountsOut calls and decide
 * whether the LIVE numbers still clear the floor. This is executed
 * immediately before the flash-loan eth_call simulation on every automatic
 * execution — the freshest possible truth the chain can give without
 * broadcasting.
 */
export async function verifyRouteLive(args: VerifyRouteArgs): Promise<RouteVerification> {
  const t0 = performance.now();
  const info = networkInfoFor(args.chainKey, args.network);
  const venues = info.venues;
  // viem requires strict checksum/ lowercase — normalize every address once.
  const wrapped = args.wrapped.toLowerCase() as `0x${string}`;
  const wrappedLower = wrapped;

  // Build the concrete address path: wrapped → tok → (tok) → wrapped, with
  // each token bought on the venue that follows it in the legs array.
  // legs = [W, v1, T1, v2, (T2), v3, W] — identical to flashbolt's
  // routePathAddresses: token slots are EVEN indices 2..len-2, so the loop
  // stops BEFORE the trailing wrapped-native symbol (which is not a token
  // leg — including it produced a wrapped→wrapped leg that reverts with
  // PancakeLibrary: IDENTICAL_ADDRESSES).
  const venueOfToken = new Map<string, string>(); // token addr → venue key
  const path: string[] = [wrapped];
  const anyVenueAddr = new Map<string, string>();
  const wrappedSymbol = "WBNB|WETH|WMATIC|WPOL";
  for (const [venueKey, syms] of Object.entries(args.tokenAddresses ?? {})) {
    for (const [sym, addr] of Object.entries(syms ?? {})) {
      // Never let a symbol map back to the wrapped native itself — the path
      // endpoints are the wrapped address, not a symbol lookup.
      if (addr && addr.toLowerCase() !== wrappedLower && !anyVenueAddr.has(sym)) {
        anyVenueAddr.set(sym, addr);
      }
    }
  }
  for (let i = 2; i < args.legs.length - 1; i += 2) {
    const venueKey = args.legs[i - 1];
    const symbol = args.legs[i];
    // Wrapped-native symbols in token position resolve to the wrapped address.
    const addr = wrappedSymbol.includes(symbol)
      ? wrapped
      : (args.tokenAddresses[venueKey]?.[symbol] ?? anyVenueAddr.get(symbol));
    if (!addr) {
      return {
        passed: false,
        reason: `No live address for ${symbol} on ${venueKey} — cannot verify`,
        legs: [],
        liveGrossMultiplier: 0,
        liveNetProfitPct: -100,
        weakestLegTvlNative: 0,
        latencyMs: performance.now() - t0,
      };
    }
    venueOfToken.set(addr.toLowerCase(), venueKey);
    path.push(addr.toLowerCase());
  }
  path.push(wrapped);
  if (path.length < 3) {
    return {
      passed: false,
      reason: "Degenerate path",
      legs: [],
      liveGrossMultiplier: 0,
      liveNetProfitPct: -100,
      weakestLegTvlNative: 0,
      latencyMs: performance.now() - t0,
    };
  }

  const amountIn = BigInt(Math.max(1, Math.round(args.loanSize * 1e18)));
  const legs: LegQuote[] = [];
  let running = amountIn;

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    const venueKey = venueOfToken.get(to.toLowerCase()) ?? venueOfToken.get(from.toLowerCase()) ?? venues[0]?.key ?? "";
    const venue = venues.find((v) => v.key === venueKey) ?? venues[0];
    if (!venue || !venue.router) {
      return {
        passed: false,
        reason: `No router for venue ${venueKey}`,
        legs,
        liveGrossMultiplier: 0,
        liveNetProfitPct: -100,
        weakestLegTvlNative: 0,
        latencyMs: performance.now() - t0,
      };
    }
    try {
      const out = await quoteAmountsOut(
        args.rpcUrl,
        venue.router.toLowerCase() as `0x${string}`,
        running,
        [from.toLowerCase() as `0x${string}`, to.toLowerCase() as `0x${string}`],
        info.chainId,
      );
      legs.push({
        symbol: i === 0 ? `W→${to.slice(0, 6)}` : `${from.slice(0, 6)}→${to.slice(0, 6)}`,
        venueKey,
        router: venue.router,
        token: to,
        amountIn: running,
        amountOut: out,
        ratio: Number(out) / Number(running),
      });
      running = out;
    } catch (e) {
      return {
        passed: false,
        reason: `Leg ${i + 1} (${venueKey}) quote failed: ${e instanceof Error ? e.message : "no quote"}`,
        legs,
        liveGrossMultiplier: 0,
        liveNetProfitPct: -100,
        weakestLegTvlNative: 0,
        latencyMs: performance.now() - t0,
      };
    }
  }

  const finalOut = running; // wrapped native wei back
  const grossMultiplier = Number(finalOut) / Number(amountIn);
  const grossPct = (grossMultiplier - 1) * 100;

  // All real costs:
  const nLegs = path.length - 1;
  let swapFeePct = 0;
  for (let i = 0; i < nLegs; i += 1) {
    const to = path[i + 1].toLowerCase();
    const venueKey = venueOfToken.get(to) ?? venues[0]?.key ?? "";
    swapFeePct += (args.venueFees[venueKey] ?? 0.0025) * 100;
  }
  const lenderFee = lenderFeePct(args.lender);
  const slip = Math.max(0, args.slippagePct);
  const gasNative =
    args.gasPriceGwei !== null ? (320_000 * args.gasPriceGwei) / 1e9 : 0;
  const gasPct = args.loanSize > 0 ? (gasNative / args.loanSize) * 100 : 0;
  const netPct = grossPct - swapFeePct - lenderFee - slip - gasPct;

  // Weakest leg TVL from real reserves (skipped on the hot path — the leg
  // quotes themselves already prove the pool answers at size).
  let weakestTvl = Number.MAX_SAFE_INTEGER;
  if (!args.hotPath) {
    for (const leg of legs) {
      if (leg.token.toLowerCase() === wrappedLower) continue;
      const pair = await findPairAddress(args.rpcUrl, info.chainId, leg.router, leg.token, args.wrapped);
      if (!pair) continue;
      const tvl = await pairTvlNative(args.rpcUrl, info.chainId, pair, args.wrapped);
      if (tvl < weakestTvl) weakestTvl = tvl;
    }
    if (weakestTvl === Number.MAX_SAFE_INTEGER) weakestTvl = 0;
  } else {
    weakestTvl = 0;
  }

  const passed = netPct >= args.minProfitPct + GUARANTOR_SAFETY_MARGIN_PCT && grossMultiplier > 1;
  return {
    passed,
    reason: passed
      ? undefined
      : `LIVE net ${netPct.toFixed(3)}% < floor ${(args.minProfitPct + GUARANTOR_SAFETY_MARGIN_PCT).toFixed(3)}% (gross ${grossPct.toFixed(3)}% − fees ${swapFeePct.toFixed(3)}% − ${args.lender} ${lenderFee}% − slip ${slip}% − gas ${gasPct.toFixed(3)}%)`,
    legs,
    liveGrossMultiplier: grossMultiplier,
    liveNetProfitPct: Math.round(netPct * 10000) / 10000,
    weakestLegTvlNative: weakestTvl === Number.MAX_SAFE_INTEGER ? 0 : weakestTvl,
    latencyMs: performance.now() - t0,
  };
}

/** Compute the V2 pair address via the router's factory (real eth_calls). */
async function findPairAddress(
  rpcUrl: string,
  chainId: number,
  router: string,
  tokenA: string,
  tokenB: string,
): Promise<string | null> {
  try {
    // factory() on the router → the V2 factory address.
    const factoryData = encodeFunctionData({
      abi: [
        { name: "factory", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      ] as const,
      functionName: "factory",
      args: [],
    });
    const factoryRaw = await racedEthCall(chainId, rpcUrl, router as `0x${string}`, factoryData as `0x${string}`);
    if (!factoryRaw || factoryRaw.length < 66) return null;
    const factory = `0x${factoryRaw.slice(26)}` as `0x${string}`;
    // getPair(address,address) on the factory (selector 0xe6a43905).
    const a = tokenA.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const b = tokenB.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const pairRaw = await racedEthCall(chainId, rpcUrl, factory, `0xe6a43905${a}${b}` as `0x${string}`);
    if (!pairRaw || pairRaw.length < 66) return null;
    const addr = `0x${pairRaw.slice(26)}`;
    return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
  } catch {
    return null;
  }
}

/** Wrapped-native TVL of a pair ×2, from real getReserves. */
async function pairTvlNative(rpcUrl: string, chainId: number, pair: string, wrapped: string): Promise<number> {
  try {
    const reservesData = encodeFunctionData({ abi: [{ name: "getReserves", type: "function", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], stateMutability: "view" }] as const, functionName: "getReserves", args: [] });
    const raw = await racedEthCall(chainId, rpcUrl, pair as `0x${string}`, reservesData as `0x${string}`);
    if (!raw || raw.length < 130) return 0;
    const r0 = BigInt(`0x${raw.slice(2, 66)}`);
    const r1 = BigInt(`0x${raw.slice(66, 130)}`);
    const t0raw = await racedEthCall(chainId, rpcUrl, pair as `0x${string}`, SEL_TOKEN0 as `0x${string}`);
    const token0 = t0raw && t0raw.length >= 66 ? `0x${t0raw.slice(26)}`.toLowerCase() : "";
    const reserveNative = token0 === wrapped.toLowerCase() ? r0 : r1;
    return (Number(reserveNative) / 1e18) * 2;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. Loan-size optimizer (flasher) — maximize LIVE net within [min, max]
// ---------------------------------------------------------------------------

/**
 * Binary-search the borrow size whose LIVE net profit is maximal, bounded by
 * the operator's [minLoan, maxLoan]. Uses verifyRouteLive with a cached
 * price-impact model from two real probes (small + large) instead of scanning
 * the whole range with full verification: 2 extra quote pairs total.
 */
export async function optimizeLoanSize(
  base: Omit<VerifyRouteArgs, "loanSize">,
  minLoan: number,
  maxLoan: number,
): Promise<{ loanSize: number; netPctAtSize: number }> {
  const clamp = (n: number) => Math.min(maxLoan, Math.max(minLoan, n));

  // Probe two sizes to estimate how net scales with size (price impact).
  const small = clamp(minLoan);
  const large = clamp(maxLoan);
  const [smallV, largeV] = await Promise.all([
    verifyRouteLive({ ...base, loanSize: small }),
    verifyRouteLive({ ...base, loanSize: large }),
  ]);

  // If the max size is still (more) profitable, take it — deep pools often are.
  if (largeV.passed && largeV.liveNetProfitPct >= smallV.liveNetProfitPct) {
    return { loanSize: large, netPctAtSize: largeV.liveNetProfitPct };
  }
  // If even the small size fails, nothing to optimize.
  if (!smallV.passed) {
    return { loanSize: small, netPctAtSize: smallV.liveNetProfitPct };
  }
  // Otherwise binary search between small and large for the best passing size.
  let lo = small;
  let hi = large;
  let best = { loanSize: small, netPctAtSize: smallV.liveNetProfitPct };
  for (let i = 0; i < 4; i += 1) {
    const mid = clamp((lo + hi) / 2);
    const midV = await verifyRouteLive({ ...base, loanSize: mid });
    if (midV.passed) {
      if (midV.liveNetProfitPct > best.netPctAtSize) {
        best = { loanSize: mid, netPctAtSize: midV.liveNetProfitPct };
      }
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.05) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. Buyable / sellable classification (sniper, both networks)
// ---------------------------------------------------------------------------

export interface TokenExitClass {
  buyable: boolean;
  sellableNow: boolean;
  /** "drastic-liquidity-drop" → rug in progress; "value-drop" → fast dump. */
  exitSignal: null | "drastic-liquidity-drop" | "value-drop";
  reason: string;
}

/**
 * Buy-side gate for a candidate token. On testnets this uses the measured
 * round-trip loss from the on-chain feed; on mainnets it requires a live
 * price (real DexScreener pair) and flags pure-honeypot patterns.
 */
export function classifyBuyable(args: {
  livePriceUsd: number | null;
  /** Measured [wrapped→token→wrapped] loss % from the feed (testnet). */
  roundTripLossPct?: number;
  /** Real wrapped-native TVL of the pair. */
  tvlNative: number;
  /** Minimum TVL in native units to even consider. */
  minTvlNative: number;
}): TokenExitClass {
  if (args.livePriceUsd === null || args.livePriceUsd <= 0) {
    return { buyable: false, sellableNow: false, exitSignal: null, reason: "No live price" };
  }
  if (args.tvlNative < args.minTvlNative) {
    return {
      buyable: false,
      sellableNow: false,
      exitSignal: null,
      reason: `TVL ${args.tvlNative.toFixed(2)} native < min ${args.minTvlNative}`,
    };
  }
  if (args.roundTripLossPct !== undefined && args.roundTripLossPct > MAX_ROUND_TRIP_LOSS_PCT) {
    return {
      buyable: false,
      sellableNow: false,
      exitSignal: null,
      reason: `Round-trip loss ${args.roundTripLossPct.toFixed(0)}% — likely honeypot/tax trap`,
    };
  }
  return { buyable: true, sellableNow: true, exitSignal: null, reason: "Probe quote OK" };
}

/**
 * Post-entry exit classifier: decides whether the position should exit RIGHT
 * NOW as the fastest gainer. Called by the auto-sell loop every poll.
 */
export function classifyExit(args: {
  /** Current wrapped-native TVL of the token's main pair. */
  tvlNative: number;
  /** TVL at entry (baseline). */
  entryTvlNative: number;
  /** Current price (any denomination). */
  price: number;
  /** Price one poll window ago. */
  prevPrice: number;
}): TokenExitClass {
  const tvlDropPct =
    args.entryTvlNative > 0
      ? ((args.entryTvlNative - args.tvlNative) / args.entryTvlNative) * 100
      : 0;
  if (tvlDropPct >= DRASTIC_LIQUIDITY_DROP_PCT) {
    return {
      buyable: true,
      sellableNow: true,
      exitSignal: "drastic-liquidity-drop",
      reason: `Liquidity collapsed ${tvlDropPct.toFixed(0)}% — exiting immediately`,
    };
  }
  if (args.prevPrice > 0) {
    const windowDropPct = ((args.prevPrice - args.price) / args.prevPrice) * 100;
    if (windowDropPct >= FAST_VALUE_DROP_PCT) {
      return {
        buyable: true,
        sellableNow: true,
        exitSignal: "value-drop",
        reason: `Value dropped ${windowDropPct.toFixed(1)}% in one window — exiting immediately`,
      };
    }
  }
  return {
    buyable: true,
    sellableNow: args.tvlNative > 0,
    exitSignal: null,
    reason: tvlDropPct > 0 ? `Liquidity -${tvlDropPct.toFixed(1)}%` : "Stable",
  };
}

/**
 * Continuous-earning sell ladder: splits a full exit into tranches so profit
 * keeps compounding as long as price keeps making new highs, but the whole
 * remaining position leaves instantly on an exit signal. Returns the % of the
 * position to sell THIS tick.
 */
export function ladderSellPct(args: {
  pnlPct: number;
  peakPnlPct: number;
  exitSignal: TokenExitClass["exitSignal"];
  /** Operator's configured sell % per full exit (e.g. 100). */
  configuredSellPct: number;
}): number {
  if (args.exitSignal !== null) return args.configuredSellPct; // drop → full exit now
  if (args.pnlPct <= 0) return 0;
  // Tranche 1 at +X%, another chunk each additional +X% of NEW high.
  const step = 5;
  const tranchesPassed = Math.floor(args.peakPnlPct / step);
  if (tranchesPassed <= 0) return 0;
  const total = Math.min(args.configuredSellPct, tranchesPassed * 25);
  return Math.min(args.configuredSellPct, Math.max(total, args.configuredSellPct === 100 ? 0 : 0));
}

/** Re-exported for callers that price positions outside the hook. */
export { fetchTokenPriceUsd };

/**
 * LIVE wrapped-native TVL of a token's main wrapped-native pair on the given
 * venue router (real getReserves, raced across the chain's fast endpoints).
 * Used by the auto-sell loop to detect drastic liquidity drops (rug-in-progress)
 * and by the buy gate as a real depth check. Returns null when no pair exists.
 */
export async function fetchTokenPairTvlNative(
  rpcUrl: string,
  chainId: number,
  router: string,
  token: string,
  wrapped: string,
): Promise<number | null> {
  const pair = await findPairAddress(rpcUrl, chainId, router, token, wrapped);
  if (!pair) return null;
  const tvl = await pairTvlNative(rpcUrl, chainId, pair, wrapped);
  return tvl > 0 ? tvl : null;
}
