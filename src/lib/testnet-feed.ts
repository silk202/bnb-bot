/**
 * Testnet live market engine — REAL on-chain data, no simulation.
 *
 * Testnets are not indexed by DexScreener, so the mainnet market-data path
 * (DexScreener/GeckoTerminal/DexView aggregators) cannot price them. This
 * engine builds the same MarketSnapshot the feed consumes directly from the
 * chain:
 *
 *  1. Pair discovery — `PairCreated` logs are read from each venue's V2
 *     factory with eth_getLogs (real event logs, newest first), plus
 *     GeckoTerminal `new_pools`/`pools` for testnets it indexes (Sepolia).
 *  2. Pricing — every discovered pair is priced with a REAL router
 *     `getAmountsOut` eth_call on [wrapped, token] and the reverse
 *     [token, wrapped] leg (buy-side AND sell-side, honestly).
 *  3. Liquidity — real `getReserves` from the pair contract (native-
 *     denominated on testnet, where no USD oracle exists).
 *
 * Prices are denominated in the chain's wrapped native token (WBNB / WETH),
 * which is exactly what triangular flash-loan arbitrage needs — the snapshot's
 * numeraire is set to 1 so `computeRoutes` produces native-denominated routes
 * with zero changes to its math.
 */

import {
  CHAIN_INFO,
  networkInfoFor,
  type ChainKey,
  type NetworkKey,
} from "./chains";
import type { ExchangeInfo, MarketSnapshot } from "./flashbolt";

// --- Minimal ABI selectors (constants — no dependencies) ---
const SEL_GET_AMOUNTS_OUT = "0xd06ca61f"; // getAmountsOut(uint256,address[])
const SEL_GET_RESERVES = "0x0902f1ac"; // getReserves()
const SEL_DECIMALS = "0x313ce567"; // decimals()
const SEL_SYMBOL = "0x95d89b41"; // symbol()
const SEL_TOKEN0 = "0x0dfe1681"; // token0()
const SEL_FACTORY = "0xc45a0155"; // factory()
const TOPIC_PAIR_CREATED =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9"; // PairCreated(address,address,address,uint256)

interface JsonRpcResult {
  result?: string;
  error?: { message?: string; data?: string };
}

/**
 * RPC with endpoint rotation: public endpoints rate-limit burst traffic, so
 * every call walks the chain's verified CORS-open endpoint list until one
 * answers. `endpoints` is [primary, ...fast fallbacks].
 *
 * Returns the JSON-RPC `result` verbatim — a hex STRING for most methods but
 * an ARRAY for eth_getLogs (the earlier string-only check silently discarded
 * every successful getLogs response, which is why factory discovery starved).
 * String consumers guard with `typeof x === "string"`.
 */
async function rpc(
  endpoints: string[],
  method: string,
  params: unknown[],
  timeoutMs = 6_000,
): Promise<unknown | null> {
  for (const endpoint of endpoints) {
    const raw = await rpcRaw(endpoint, method, params, timeoutMs);
    if (raw !== null && raw !== undefined) return raw;
  }
  return null;
}

/** rpc() for methods whose result must be a hex/data string. */
export async function rpcStr(
  endpoints: string[],
  method: string,
  params: unknown[],
  timeoutMs = 6_000,
): Promise<string | null> {
  const raw = await rpc(endpoints, method, params, timeoutMs);
  return typeof raw === "string" ? raw : null;
}

/**
 * Run `fn` over `items` with at most `limit` tasks in flight. Public RPCs
 * throttle bursts: pricing 24 pairs with raw Promise.all fires ~100 calls at
 * once and every endpoint rate-limits the whole batch (verified live — all
 * quotes returned null under burst, the same calls succeed sequentially).
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function rpcRaw(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs = 6_000,
): Promise<unknown | null> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(endpoint, timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as JsonRpcResult & { result?: unknown };
    // A JSON-RPC error body is NOT a result: "limit exceeded" and range
    // rejections must fall through to the next endpoint, otherwise the
    // discovery ladder locks onto a failing node and returns zero pairs.
    if (json.error) return null;
    return json.result ?? null;
  } catch {
    return null;
  }
}

/** One discovered testnet pair with its real pricing data. */
export interface TestnetPair {
  /** Token contract address (lowercase). */
  token: string;
  /** Token symbol when resolvable, else the shortened address. */
  symbol: string;
  /** Pair (pool) contract address. */
  pair: string;
  /** Venue key this pair trades on, e.g. "PCS". */
  venueKey: string;
  /** Wrapped native (WBNB/WETH) per 1 whole token — real getAmountsOut quote. */
  nativePerToken: number;
  /** Wrapped-native reserve ×2 (native-denominated TVL estimate). */
  liquidityNative: number;
  /** Round-trip [wrapped→token→wrapped] loss % — sell-side honesty signal. */
  roundTripLossPct: number;
  decimals: number;
  /** Block the PairCreated event was seen at (0 when sourced from GeckoTerminal). */
  createdAtBlock: number;
  /** Where this pair was discovered. */
  source: "factory-logs" | "geckoterminal";
}

/** GeckoTerminal pool payload (subset actually used). */
interface GtPool {
  id?: string;
  attributes?: {
    name?: string;
    address?: string;
    base_token_price_native_currency?: string;
    reserve_in_native_currency?: string;
    volume_usd?: { h24?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

const metaCache = new Map<string, { decimals: number; symbol: string }>();

async function fetchTokenMeta(endpoints: string[], token: string) {
  const cached = metaCache.get(token);
  if (cached) return cached;
  const [dRaw, sRaw] = await Promise.all([
    rpcStr(endpoints, "eth_call", [{ to: token, data: SEL_DECIMALS }, "latest"]),
    rpcStr(endpoints, "eth_call", [{ to: token, data: SEL_SYMBOL }, "latest"]),
  ]);
  let decimals = 18;
  if (dRaw && dRaw.length >= 66) {
    const d = Number.parseInt(dRaw, 16);
    if (Number.isFinite(d) && d > 0 && d <= 36) decimals = d;
  }
  let symbol = "";
  if (sRaw && sRaw.length >= 130) {
    try {
      const len = Number.parseInt(sRaw.slice(66, 130), 16);
      if (len > 0 && len <= 64) {
        const hex = sRaw.slice(130, 130 + len * 2);
        let out = "";
        for (let i = 0; i < hex.length; i += 2) {
          out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
        }
        symbol = out.replace(/\0/g, "").trim().toUpperCase();
      }
    } catch {
      symbol = "";
    }
  }
  const meta = { decimals, symbol };
  metaCache.set(token, meta);
  return meta;
}

/**
 * Read recent PairCreated logs from a V2 factory. Returns wrapped-native
 * pairs, newest first (real event logs — this is how brand-new listings are
 * captured seconds after they land on chain).
 */
export async function discoverFactoryPairs(
  endpoints: string[],
  factory: string,
  wrapped: string,
): Promise<Array<{ token: string; pair: string; block: number }>> {
  const latestHex = await rpcStr(endpoints, "eth_blockNumber", []);
  if (!latestHex) return [];
  const latest = Number.parseInt(latestHex, 16);
  // Nodes cap eth_getLogs windows differently (publicnode BSC: 10k blocks,
  // publicnode Sepolia: 50k, Binance seeds: reject everything) — so the ladder
  // must walk RANGE × ENDPOINT: for every range size, try every endpoint
  // before shrinking. A single-endpoint ladder can dead-end when the range it
  // needs is only accepted by a later endpoint (verified live on BSC testnet).
  for (const range of [50_000, 10_000, 2_000, 200]) {
    const fromHex = `0x${Math.max(0, latest - range).toString(16)}`;
    let logs: Array<Record<string, string>> | null = null;
    for (const endpoint of endpoints) {
      logs = (await rpc(
        [endpoint],
        "eth_getLogs",
        [
          {
            fromBlock: fromHex,
            toBlock: "latest",
            address: factory,
            topics: [TOPIC_PAIR_CREATED],
          },
        ],
        9_000,
      )) as Array<Record<string, string>> | null;
      if (logs !== null) break; // this endpoint accepted the range
    }
    if (logs === null) continue; // every endpoint rejected this range — shrink it
    const w = wrapped.toLowerCase();
    const out: Array<{ token: string; pair: string; block: number }> = [];
    for (const log of logs) {
      const token0 = log.topics?.[1];
      const token1 = log.topics?.[2];
      const pair = log.data?.slice(0, 66);
      if (!token0 || !token1 || !pair || pair.length < 66) continue;
      const t0 = `0x${token0.slice(26)}`.toLowerCase();
      const t1 = `0x${token1.slice(26)}`.toLowerCase();
      const pairAddr = `0x${pair.slice(26)}`.toLowerCase();
      const token = t0 === w ? t1 : t1 === w ? t0 : null;
      if (!token || token === w) continue;
      out.push({
        token,
        pair: pairAddr,
        block: Number.parseInt(log.blockNumber ?? "0x0", 16),
      });
    }
    return out.reverse(); // logs arrive oldest → newest
  }
  return [];
}

/**
 * Real two-sided quote for a pair: buy-side via router getAmountsOut
 * [wrapped→token] and sell-side via getAmountsOut [token→wrapped]. Both are
 * genuine eth_call executions against the venue router.
 */
export async function quotePair(
  endpoints: string[],
  router: string,
  wrapped: string,
  token: string,
  decimals: number,
): Promise<{ nativePerToken: number; roundTripLossPct: number } | null> {
  const probeIn = 10n ** 16n; // 0.01 wrapped native — real probe size
  const encAmount = (n: bigint) => n.toString(16).padStart(64, "0");
  // Proper dynamic-array ABI encoding: offset (0x40) + length word + data.
  // (Concatenating bare addresses omits the offset/length words — the
  // decoder then reads a huge offset and the call reverts on every node.)
  const encPath = (p: string[]) =>
    "0000000000000000000000000000000000000000000000000000000000000040" +
    encAmount(BigInt(p.length)) +
    p.map((a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0")).join("");
  const buyData = `${SEL_GET_AMOUNTS_OUT}${encAmount(probeIn)}${encPath([wrapped, token])}` as `0x${string}`;
  const buyRaw = await rpcStr(endpoints, "eth_call", [{ to: router, data: buyData }, "latest"]);
  if (!buyRaw || buyRaw.length < 194) return null; // offset + len + 2 amounts
  const tokenOutRaw = BigInt(`0x${buyRaw.slice(-64)}`);
  if (tokenOutRaw <= 0n) return null;

  // Sell the exact tokens received back to wrapped — honest sell-side probe.
  const sellData = `${SEL_GET_AMOUNTS_OUT}${encAmount(tokenOutRaw)}${encPath([token, wrapped])}` as `0x${string}`;
  const sellRaw = await rpcStr(endpoints, "eth_call", [{ to: router, data: sellData }, "latest"]);
  let roundTripLossPct = 100;
  if (sellRaw && sellRaw.length >= 194) {
    const wrappedBack = BigInt(`0x${sellRaw.slice(-64)}`);
    roundTripLossPct =
      wrappedBack > 0n
        ? Math.max(0, (1 - Number(wrappedBack) / Number(probeIn)) * 100)
        : 100;
  }

  const nativePerToken = Number(probeIn) / 1e18 / (Number(tokenOutRaw) / 10 ** decimals);
  if (!Number.isFinite(nativePerToken) || nativePerToken <= 0) return null;
  return { nativePerToken, roundTripLossPct };
}

/** Real reserves from the pair contract — native-denominated TVL estimate. */
async function fetchLiquidity(
  endpoints: string[],
  pair: string,
  wrapped: string,
): Promise<number> {
  const raw = await rpcStr(endpoints, "eth_call", [{ to: pair, data: SEL_GET_RESERVES }, "latest"]);
  if (!raw || raw.length < 130) return 0;
  const reserve0 = BigInt(`0x${raw.slice(2, 66)}`);
  const reserve1 = BigInt(`0x${raw.slice(66, 130)}`);
  const t0raw = await rpcStr(endpoints, "eth_call", [{ to: pair, data: SEL_TOKEN0 }, "latest"]);
  if (!t0raw || t0raw.length < 66) return 0;
  const token0 = `0x${t0raw.slice(26)}`.toLowerCase();
  const reserveNative = token0 === wrapped.toLowerCase() ? reserve0 : reserve1;
  return (Number(reserveNative) / 1e18) * 2;
}

/** Resolve a router's factory when the venue entry doesn't pin one. */
async function routerFactory(endpoints: string[], router: string): Promise<string | null> {
  const raw = await rpcStr(endpoints, "eth_call", [{ to: router, data: SEL_FACTORY }, "latest"]);
  if (!raw || raw.length < 66) return null;
  return `0x${raw.slice(26)}`;
}

/** GeckoTerminal pools for a testnet it indexes (real indexed data). */
async function geckoPools(network: string, path: string): Promise<GtPool[]> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(
      `https://api.geckoterminal.com/api/v2/networks/${network}/${path}?page=1`,
      8_000,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: GtPool[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

/** Price a discovered pair fully (meta + two-sided quote + liquidity). */
export async function pricePair(
  endpoints: string[],
  router: string,
  wrapped: string,
  venueKey: string,
  found: { token: string; pair: string; block: number },
  knownSymbol?: string,
  knownLiquidity?: number,
): Promise<TestnetPair | null> {
  const meta = await fetchTokenMeta(endpoints, found.token);
  const q = await quotePair(endpoints, router, wrapped, found.token, meta.decimals);
  if (!q) return null;
  const liquidityNative =
    knownLiquidity !== undefined && knownLiquidity > 0
      ? knownLiquidity
      : await fetchLiquidity(endpoints, found.pair, wrapped);
  return {
    token: found.token,
    symbol: knownSymbol || meta.symbol,
    pair: found.pair,
    venueKey,
    nativePerToken: q.nativePerToken,
    liquidityNative,
    roundTripLossPct: q.roundTripLossPct,
    decimals: meta.decimals,
    createdAtBlock: found.block,
    source: knownSymbol !== undefined && knownLiquidity !== undefined ? "geckoterminal" : "factory-logs",
  };
}

export interface TestnetFeedResult {
  snapshot: MarketSnapshot;
  /** Newly discovered + priced pairs this cycle (drives the LIVE TOKEN FEED). */
  pairs: TestnetPair[];
  /** Human-readable notes about which sources answered. */
  notes: string[];
}

/**
 * Build a real MarketSnapshot for a chain's TESTNET from on-chain + indexed
 * sources. Prices are wrapped-native denominated; the snapshot numeraire is
 * 1 so `computeRoutes` works unchanged.
 */
export async function buildTestnetSnapshot(
  chainKey: ChainKey,
  network: NetworkKey = "testnet",
): Promise<TestnetFeedResult> {
  const info = networkInfoFor(chainKey, network);
  const chain = CHAIN_INFO[chainKey];
  // Endpoint list: [primary, ...verified fast fallbacks]. Rotation defeats
  // per-endpoint rate limits during burst discovery.
  const endpoints = [info.rpc, ...info.rpcs];
  const wrapped = info.wrapped.toLowerCase();
  const notes: string[] = [];
  const pairs: TestnetPair[] = [];

  // Venue entries for the snapshot (computeRoutes prefers snapshot.venues).
  const venues: ExchangeInfo[] = info.venues.map((v) => ({
    key: v.key,
    dexId: v.key.toLowerCase(),
    name: v.name,
    fee: v.fee,
    color: v.color,
  }));

  // ---- Discovery source A: GeckoTerminal (when the testnet is indexed) ----
  const gtNetwork = info.geckoNetwork;
  const gtPools = new Map<string, { symbol: string; pool: string; liq: number }>();
  if (gtNetwork && wrapped) {
    const pools = [
      ...(await geckoPools(gtNetwork, "new_pools")),
      ...(await geckoPools(gtNetwork, "pools")),
    ];
    for (const p of pools) {
      const baseId = p.relationships?.base_token?.data?.id ?? "";
      const token = baseId.includes("_") ? baseId.split("_").pop() : undefined;
      const a = p.attributes;
      if (!token || !a?.address) continue;
      const nativeRaw = Number(a.base_token_price_native_currency ?? 0);
      const liq = Number(a.reserve_in_native_currency ?? 0);
      if (!Number.isFinite(nativeRaw) || nativeRaw <= 0) continue;
      const symbol = (a.name ?? "").split("/")[0]?.trim().toUpperCase() ?? "";
      // Keep the deepest pool per token.
      if (!gtPools.has(token) || (gtPools.get(token)?.liq ?? 0) < liq) {
        gtPools.set(token, { symbol, pool: a.address.toLowerCase(), liq });
      }
    }
    if (gtPools.size > 0) notes.push(`GeckoTerminal ${gtNetwork}: ${gtPools.size} pools`);
  }

  // ---- Discovery source B: factory PairCreated logs per venue (real events) ----
  for (const venue of info.venues) {
    if (!venue.router || !wrapped) continue;
    const factory = venue.factory || (await routerFactory(endpoints, venue.router)) || "";
    if (!factory) continue;
    const discovered = await discoverFactoryPairs(endpoints, factory, wrapped);
    if (discovered.length > 0) {
      notes.push(`${venue.key} factory: ${discovered.length} new pairs in recent blocks`);
    }
    // Concurrency-capped pricing: burst protection against rate-limited RPCs.
    const priced = await mapLimit(discovered.slice(0, 24), 4, (d) =>
      pricePair(endpoints, venue.router, wrapped, venue.key, d),
    );
    for (const p of priced) if (p) pairs.push(p);
  }

  // ---- Cross-check GeckoTerminal pools with a real router quote ----
  if (gtPools.size > 0 && info.venues.length > 0) {
    const primary = info.venues[0];
    if (primary?.router && wrapped) {
      const seen = new Set(pairs.map((p) => p.token));
      const gtTokens = [...gtPools.entries()].slice(0, 24);
      const priced = await mapLimit(gtTokens, 4, ([token, g]) =>
        seen.has(token)
          ? Promise.resolve(null)
          : pricePair(
              endpoints,
              primary.router,
              wrapped,
              primary.key,
              { token, pair: g.pool, block: 0 },
              g.symbol,
              g.liq,
            ),
      );
      for (const p of priced) if (p) pairs.push(p);
    }
  }

  // ---- Build the MarketSnapshot (numeraire = 1 wrapped native) ----
  const quotes: MarketSnapshot["quotes"] = {};
  const tokenAddresses: MarketSnapshot["tokenAddresses"] = {};
  for (const p of pairs) {
    const key = p.symbol || p.token;
    if (!quotes[p.venueKey]) quotes[p.venueKey] = {};
    if (!tokenAddresses[p.venueKey]) tokenAddresses[p.venueKey] = {};
    const existing = quotes[p.venueKey][key];
    // Prefer the deeper pool for the same (venue, token).
    if (!existing || existing.liquidityUsd < p.liquidityNative) {
      quotes[p.venueKey][key] = {
        usdPerToken: p.nativePerToken,
        liquidityUsd: p.liquidityNative,
        volumeUsd: 0,
      };
      tokenAddresses[p.venueKey][key] = p.token;
    }
  }

  const snapshot: MarketSnapshot = {
    fetchedAt: Date.now(),
    quotes,
    tokenAddresses,
    // Numeraire 1: all prices are already wrapped-native denominated.
    wbnbUsd: pairs.length > 0 ? 1 : 0,
    wbnbUsdByDex: Object.fromEntries(venues.map((v) => [v.key, 1])),
    chainKey,
    quoteSymbol: chain.quoteSymbol,
    quoteAddress: info.wrapped,
    venues: venues.length > 0 ? venues : undefined,
    // Real testnet lenders only: the venues' own flash-swap + Aave V3 markets
    // that officially deploy on these testnets. lenderFeePct() knows both.
    lenders: testnetLenders(chainKey),
    network,
  };

  return { snapshot, pairs, notes };
}

/** Lenders that genuinely exist on each testnet (pair flash-swap / Aave markets). */
export function testnetLenders(chainKey: ChainKey): string[] {
  switch (chainKey) {
    case "bsc":
      return ["PancakeSwap"]; // PCS V2 pair flash swap — verified testnet deployment
    case "ethereum":
    case "arbitrum":
    case "polygon":
      return ["Aave V3"]; // Aave V3 has official Sepolia/Amoy markets
  }
}
