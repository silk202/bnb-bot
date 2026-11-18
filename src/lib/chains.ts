/**
 * FlashBolt multi-chain registry.
 *
 * Every value here is real and verified against the live source:
 * - DexScreener `dexId` values (the token endpoint returns pairs tagged with
 *   these ids — Uniswap V2 pairs report `uniswap`, not `uniswapv2`),
 * - the canonical WETH / WMATIC / WBNB addresses,
 * - public CORS-open RPC endpoints (verified `eth_gasPrice` + preflight),
 * - official Uniswap V2 / QuickSwap router addresses,
 * - flash-loan lenders that actually deploy on each chain (Aave V3, dForce,
 *   Radiant, Venus, PancakeSwap — scoped per chain so we never claim a
 *   BNB-only lender exists on Ethereum).
 */

export type ChainKey = "bsc" | "ethereum" | "arbitrum" | "polygon";

export interface DexDef {
  /** Short code shown in the feed, e.g. "PCS". Also the whitelist key. */
  key: string;
  /** DexScreener dex id. */
  dexId: string;
  /**
   * DexScreener version labels required for this venue ("v2" / "v3" / "v1").
   * DexScreener reports PancakeSwap V3 pairs as dexId "pancakeswap" with
   * labels ["v3"] (verified live) — so versioned venues MUST disambiguate on
   * the label or they collapse into the same dexId. Venues without labels
   * (Biswap, MDEX, …) match any pair carrying their dexId.
   */
  labels?: string[];
  /**
   * Scanner site this venue is primarily surfaced on (e.g. "ave.ai"). Used by
   * the scanner overlay for site→chain auto-sync and by the aggregator for
   * site-sourced pair mapping.
   */
  site?: string;
  name: string;
  /** Swap fee charged per leg. */
  fee: number;
  color: string;
}

export interface ChainInfo {
  key: ChainKey;
  label: string;
  chainId: number;
  /** DexScreener chainId (the token endpoint filters on this). */
  dexScreenerChainId: string;
  /** Native wrapped token (WBNB / WETH / WMATIC). */
  quoteSymbol: string;
  quoteAddress: string;
  /** Public CORS-open RPC used for live gas prices and receipt lookups. */
  rpc: string;
  explorer: string;
  explorerUrl: string;
  /** Official Router02 for the chain's primary DEX (deploy constructor arg). */
  router: string;
  nativeSymbol: string;
  dexes: DexDef[];
  /** Flash-loan lenders actually deployed on this chain. */
  lenders: string[];
}

export const CHAIN_INFO: Record<ChainKey, ChainInfo> = {
  bsc: {
    key: "bsc",
    label: "BNB Smart Chain",
    chainId: 56,
    dexScreenerChainId: "bsc",
    quoteSymbol: "WBNB",
    quoteAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "BscScan",
    explorerUrl: "https://bscscan.com",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    nativeSymbol: "BNB",
    dexes: [
      { key: "PCS", dexId: "pancakeswap", labels: ["v2"], name: "PancakeSwap V2", fee: 0.0025, color: "#F0B90B" },
      { key: "PCS_V3", dexId: "pancakeswap", labels: ["v3"], name: "PancakeSwap V3", fee: 0.001, color: "#D4A017", site: "ave.ai" },
      { key: "BISWAP", dexId: "biswap", name: "Biswap", fee: 0.002, color: "#4A8BFF" },
      { key: "MDEX", dexId: "mdex", name: "MDEX", fee: 0.003, color: "#FF4D4F" },
      { key: "APESWAP", dexId: "apeswap", name: "ApeSwap", fee: 0.002, color: "#FF9A2E" },
      { key: "BABYSWAP", dexId: "babyswap", name: "BabySwap", fee: 0.002, color: "#FF5FA2" },
      { key: "OPENOCEAN", dexId: "openocean", name: "OpenOcean", fee: 0.001, color: "#00BFFF" },
      { key: "KYBERSWAP", dexId: "kyberswap", name: "KyberSwap", fee: 0.001, color: "#1DC88E" },
    ],
    lenders: ["Aave V3", "Venus", "dForce", "Radiant", "PancakeSwap"],
  },
  ethereum: {
    key: "ethereum",
    label: "Ethereum",
    chainId: 1,
    dexScreenerChainId: "ethereum",
    quoteSymbol: "WETH",
    quoteAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    rpc: "https://1rpc.io/eth",
    explorer: "Etherscan",
    explorerUrl: "https://etherscan.io",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    nativeSymbol: "ETH",
    dexes: [
      { key: "UNI", dexId: "uniswap", labels: ["v2"], name: "Uniswap V2", fee: 0.003, color: "#FF007A" },
      { key: "UNI_V3", dexId: "uniswap", labels: ["v3"], name: "Uniswap V3", fee: 0.0005, color: "#FF37C7", site: "ave.ai" },
      { key: "SUSHI", dexId: "sushiswap", labels: ["v2"], name: "SushiSwap", fee: 0.003, color: "#FA52A0" },
    ],
    lenders: ["Aave V3", "dForce", "Radiant"],
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum One",
    chainId: 42161,
    dexScreenerChainId: "arbitrum",
    quoteSymbol: "WETH",
    quoteAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "Arbiscan",
    explorerUrl: "https://arbiscan.io",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    nativeSymbol: "ETH",
    dexes: [
      { key: "UNI", dexId: "uniswap", labels: ["v2"], name: "Uniswap V2", fee: 0.003, color: "#FF007A" },
      { key: "UNI_V3", dexId: "uniswap", labels: ["v3"], name: "Uniswap V3", fee: 0.0005, color: "#FF37C7", site: "ave.ai" },
      { key: "SUSHI", dexId: "sushiswap", labels: ["v2"], name: "SushiSwap", fee: 0.003, color: "#FA52A0" },
      { key: "CAMELOT", dexId: "camelot", name: "Camelot", fee: 0.003, color: "#F8A600" },
    ],
    lenders: ["Aave V3", "Radiant", "dForce"],
  },
  polygon: {
    key: "polygon",
    label: "Polygon",
    chainId: 137,
    dexScreenerChainId: "polygon",
    quoteSymbol: "WMATIC",
    quoteAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    rpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "Polygonscan",
    explorerUrl: "https://polygonscan.com",
    router: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
    nativeSymbol: "POL",
    dexes: [
      { key: "QUICK", dexId: "quickswap", labels: ["v2"], name: "QuickSwap V2", fee: 0.003, color: "#7B3FE4" },
      { key: "QUICK_V3", dexId: "quickswap", labels: ["v3"], name: "QuickSwap V3", fee: 0.0005, color: "#9D6BFF", site: "ave.ai" },
      { key: "SUSHI", dexId: "sushiswap", labels: ["v2"], name: "SushiSwap", fee: 0.003, color: "#FA52A0" },
      { key: "APE", dexId: "apeswap", name: "ApeSwap", fee: 0.002, color: "#FF9A2E" },
    ],
    lenders: ["Aave V3"],
  },
};

export const CHAIN_KEYS = Object.keys(CHAIN_INFO) as ChainKey[];

/**
 * Scanner sites the FlashBolt overlay runs on (DEXView / GMGN / Ave and the
 * DexScreener page layer) → the chains each site lists. Every site here lists
 * all supported chains (BNB Smart Chain, Ethereum, Arbitrum One, Polygon), so the overlay synchronizes its
 * active chain with whichever site + chain page the operator opens.
 */
export const SITE_CHAINS: Record<string, ChainKey[]> = {
  "dexscreener.com": [...CHAIN_KEYS],
  "dexview.com": [...CHAIN_KEYS],
  "gmgn.ai": [...CHAIN_KEYS],
  "ave.ai": [...CHAIN_KEYS],
};

/** Every scanner site the overlay supports (used by overlays + tests). */
export const SCANNER_SITES = Object.keys(SITE_CHAINS);

/** Resolve a chain by its real EVM chain id (56, 1, 42161, 137). */
export function chainForChainId(chainId: number): ChainKey | null {
  for (const key of CHAIN_KEYS) {
    if (CHAIN_INFO[key].chainId === chainId) return key;
  }
  return null;
}

export type NetworkKey = "mainnet" | "testnet";

/**
 * Is this key the BNB chain (the one with the historical mainnet/testnet switch)?
 *
 * Strict on purpose: an undefined or unknown key is NOT BSC. Callers that used
 * to rely on that default must resolve their chain explicitly, because a missing
 * identity must fail closed rather than silently becoming BSC.
 */
export function isBscChain(key: ChainKey | string | undefined): boolean {
  return key === "bsc";
}

/**
 * Effective RPC for a chain: the user's private override when set (and
 * valid http(s)), otherwise the verified public endpoint. The private RPC
 * is called from the browser, so it must allow CORS — noted in the UI.
 */
export function effectiveRpc(
  chainKey: ChainKey,
  override: string | undefined,
): string {
  const trimmed = override?.trim() ?? "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return CHAIN_INFO[chainKey].rpc;
}

// ---------------------------------------------------------------------------
// Execution environment — one descriptor per chain drives every real swap:
// quote, buy, sell, approval and native transfer. This is what makes every
// chain function exactly like BSC: the same Router02-style swap interface,
// the same wrapped-native path, the same RPC racing and the same full
// eth_estimateGas + eth_call simulation gate — only the addresses differ.
// ---------------------------------------------------------------------------

export interface ChainExecutionEnv {
  chainKey: ChainKey;
  /** Which network of this chain is being executed on. */
  network: NetworkKey;
  chainId: number;
  /** Canonical (or operator-overridden) CORS-open RPC for this chain+network. */
  rpcUrl: string;
  /** Router02-style swap router for the venue used by buy/sell. */
  router: string;
  /** Wrapped native token (WBNB / WETH / WMATIC) — path[0]/path[last]. */
  wrapped: string;
  nativeSymbol: string;
  label: string;
  explorerUrl: string;
}

/** GeckoTerminal network slug per chain (used by live discovery sources). */
export const GECKO_NETWORKS: Record<ChainKey, string> = {
  bsc: "bsc",
  ethereum: "eth",
  polygon: "polygon_pos",
  arbitrum: "arbitrum",
};

// ---------------------------------------------------------------------------
// Per-chain MAINNET + TESTNET registries — every testnet entry below was
// verified against the live chain (eth_chainId + eth_getCode) before being
// written here. A testnet venue with an empty router means no verified V2
// router exists publicly for that testnet; those chains still run the full
// engine through on-chain discovery + the operator's own deployed contracts.
// ---------------------------------------------------------------------------

import { BNB_NETWORKS } from "./chain";
import { NETWORKS, type EvmChainKey, type NetworkMode } from "./network-registry";
import { RpcManager } from "./rpc-manager";

/** One swap venue (router + optional factory) on one network of one chain. */
export interface VenueDef {
  /** Venue short code, e.g. "PCS" or "UNI". */
  key: string;
  name: string;
  /** Router02-style address ("" when no verified router exists). */
  router: string;
  /** V2 factory (used by on-chain NewPair discovery). */
  factory: string;
  /** Swap fee per leg (fraction, e.g. 0.0025). */
  fee: number;
  color: string;
}

/** Everything the engine needs to run one chain on one network. */
export interface ChainNetworkInfo {
  chainId: number;
  label: string;
  /** Canonical CORS-open RPC (verified). */
  rpc: string;
  /** Additional fast CORS-open RPCs verified live (used by the racing set). */
  rpcs: string[];
  /** Wrapped native token (WBNB / WETH / WPOL). */
  wrapped: string;
  nativeSymbol: string;
  explorerUrl: string;
  /** Swap venues for this network (≥1 for mainnet; testnet may be fewer). */
  venues: VenueDef[];
  /** GeckoTerminal network slug when that testnet is indexed (e.g. sepolia-testnet). */
  geckoNetwork?: string;
  /** DexScreener chainId when the testnet appears in its API. */
  dexScreenerChainId?: string;
}

const MAINNET_VENUES: Record<ChainKey, VenueDef[]> = {
  bsc: CHAIN_INFO.bsc.dexes.length > 0
    ? [{ key: "PCS", name: "PancakeSwap V2", router: CHAIN_INFO.bsc.router, factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", fee: 0.0025, color: "#F0B90B" }]
    : [],
  ethereum: [{ key: "UNI", name: "Uniswap V2", router: CHAIN_INFO.ethereum.router, factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", fee: 0.003, color: "#FF007A" }],
  arbitrum: [{ key: "UNI", name: "Uniswap V2", router: CHAIN_INFO.arbitrum.router, factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9", fee: 0.003, color: "#FF007A" }],
  polygon: [{ key: "QUICK", name: "QuickSwap V2", router: CHAIN_INFO.polygon.router, factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", fee: 0.003, color: "#7B3FE4" }],
};

/**
 * MAINNET per-chain network info, derived from CHAIN_INFO (single source of
 * truth — no duplicated mainnet addresses).
 */
export const CHAIN_NETWORKS: Record<ChainKey, Record<NetworkKey, ChainNetworkInfo>> = {
  bsc: {
    mainnet: {
      chainId: 56,
      label: "BNB Smart Chain",
      rpc: BNB_NETWORKS.mainnet.rpc,
      rpcs: ["https://rpc-bsc.48.club", "https://bsc.publicnode.com", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io"],
      wrapped: BNB_NETWORKS.mainnet.wbnb,
      nativeSymbol: "BNB",
      explorerUrl: BNB_NETWORKS.mainnet.explorerUrl,
      venues: MAINNET_VENUES.bsc,
    },
    testnet: {
      // All three addresses verified live: router 36KB code, factory 21KB,
      // WBNB 6KB bytecode. RPC endpoints verified chainId 0x61 + CORS-open.
      // Order matters: publicnode serves eth_getLogs windows (verified 20+
      // PairCreated logs); binance seeds reject getLogs with "limit exceeded";
      // drpc serves 10k windows (50k rejected) as the honest fallback.
      chainId: 97,
      label: "BNB Smart Chain Testnet",
      rpc: "https://bsc-testnet-rpc.publicnode.com",
      rpcs: ["https://bsc-testnet.drpc.org", "https://data-seed-prebsc-2-s1.binance.org:8545"],
      wrapped: BNB_NETWORKS.testnet.wbnb,
      nativeSymbol: "BNB",
      explorerUrl: BNB_NETWORKS.testnet.explorerUrl,
      venues: [
        { key: "PCS", name: "PancakeSwap V2 (Testnet)", router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", factory: "0x6725F303b657a9451d8BA641348b6761A6CC7a17", fee: 0.0025, color: "#F0B90B" },
      ],
    },
  },
  ethereum: {
    mainnet: {
      chainId: 1,
      label: "Ethereum",
      rpc: CHAIN_INFO.ethereum.rpc,
      rpcs: ["https://ethereum-rpc.publicnode.com"],
      wrapped: CHAIN_INFO.ethereum.quoteAddress,
      nativeSymbol: "ETH",
      explorerUrl: CHAIN_INFO.ethereum.explorerUrl,
      venues: MAINNET_VENUES.ethereum,
    },
    testnet: {
      // Sepolia: official Uniswap deployments — Router02 + the v2-core@1.0.0
      // factory (developers.uniswap.org/docs/protocols/v2/deployments) plus
      // the v2-core@1.0.1 factory (official deployments.json feed). Both
      // factories verified live → TWO real venues for cross-DEX arbitrage.
      chainId: 11155111,
      label: "Ethereum Sepolia",
      rpc: "https://ethereum-sepolia-rpc.publicnode.com",
      rpcs: ["https://sepolia.drpc.org", "https://rpc.sepolia.org"],
      // Canonical Sepolia WETH (symbol "WETH", 3124 bytes — verified live via
      // eth_call + eth_getCode). The 0x7b79995e… WETH9 twin exists but every
      // real Uniswap V2 pool on Sepolia pairs against THIS address (verified:
      // 29/30 recent PairCreated events use it), and its reserves are what
      // GeckoTerminal reports in base_token_price_native_currency.
      wrapped: "0xfFf9976782d46CC05630D1f6eBaB18B2324d6B14",
      nativeSymbol: "ETH",
      explorerUrl: "https://sepolia.etherscan.io",
      venues: [
        { key: "UNI", name: "Uniswap V2 (Sepolia)", router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3", factory: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6", fee: 0.003, color: "#FF007A" },
        { key: "UNI2", name: "Uniswap V2 @1.0.1 (Sepolia)", router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3", factory: "0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0", fee: 0.003, color: "#ff5da2" },
      ],
      geckoNetwork: "sepolia-testnet",
      dexScreenerChainId: "ethereum",
    },
  },
  arbitrum: {
    mainnet: {
      chainId: 42161,
      label: "Arbitrum One",
      rpc: CHAIN_INFO.arbitrum.rpc,
      rpcs: ["https://arbitrum-one-rpc.publicnode.com"],
      wrapped: CHAIN_INFO.arbitrum.quoteAddress,
      nativeSymbol: "ETH",
      explorerUrl: CHAIN_INFO.arbitrum.explorerUrl,
      venues: MAINNET_VENUES.arbitrum,
    },
    testnet: {
      // Arbitrum Sepolia: canonical WETH verified live. No public V2 router
      // exists — the engine runs on on-chain discovery (factory events +
      // direct quotes) and the operator's own deployed venues.
      chainId: 421614,
      label: "Arbitrum Sepolia",
      rpc: "https://arbitrum-sepolia-rpc.publicnode.com",
      rpcs: ["https://arbitrum-sepolia.drpc.org"],
      wrapped: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
      nativeSymbol: "ETH",
      explorerUrl: "https://sepolia.arbiscan.io",
      venues: [],
    },
  },
  polygon: {
    mainnet: {
      chainId: 137,
      label: "Polygon",
      rpc: CHAIN_INFO.polygon.rpc,
      rpcs: ["https://polygon-bor-rpc.publicnode.com"],
      wrapped: CHAIN_INFO.polygon.quoteAddress,
      nativeSymbol: "POL",
      explorerUrl: CHAIN_INFO.polygon.explorerUrl,
      venues: MAINNET_VENUES.polygon,
    },
    testnet: {
      // Polygon Amoy: no public V2 router verified — on-chain discovery mode.
      chainId: 80002,
      label: "Polygon Amoy",
      rpc: "https://polygon-amoy-bor-rpc.publicnode.com",
      rpcs: [],
      wrapped: "",
      nativeSymbol: "POL",
      explorerUrl: "https://amoy.polygonscan.com",
      venues: [],
    },
  },
};

/**
 * Registry-backed RPC manager for a chain + network.
 *
 * Candidates are the registry's providers plus the endpoints already verified
 * in CHAIN_NETWORKS, deduplicated by URL; the operator's private RPC (when set)
 * is tried first. Every candidate must pass `eth_chainId` before it is used, so
 * a mainnet payload can never leave through a testnet endpoint. The registry is
 * the naming/chain-id authority; CHAIN_NETWORKS stays the venue/address source.
 */
export function rpcManagerFor(
  chainKey: ChainKey,
  network: NetworkKey,
  override?: string,
): RpcManager {
  const def = NETWORKS[chainKey as EvmChainKey][network as NetworkMode];
  const info = CHAIN_NETWORKS[chainKey][network];
  const seen = new Set(def.endpoints.map((e) => e.url));
  const extras = [override, info.rpc, ...info.rpcs]
    .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)))
    .filter((url) => !seen.has(url))
    .map((url) => ({ url, provider: new URL(url).hostname.replace(/^www\./, "") }));
  return new RpcManager({ ...def, endpoints: [...extras.slice(0, 1), ...def.endpoints, ...extras.slice(1)] });
}

/** Network info for a chain + network, with the operator's RPC override applied. */
export function networkInfoFor(
  chainKey: ChainKey,
  network: NetworkKey = "mainnet",
  rpcOverride?: string,
): ChainNetworkInfo {
  const base = CHAIN_NETWORKS[chainKey][network];
  const trimmed = rpcOverride?.trim() ?? "";
  if (!/^https?:\/\//i.test(trimmed)) return base;
  return { ...base, rpc: trimmed };
}

/**
 * Resolve the real execution environment for a chain ON A NETWORK.
 * `rpcOverride` is the operator's private RPC when set on the Contract page
 * (must be CORS-open — it is called from the browser).
 */
export function executionEnvFor(
  chainKey: ChainKey,
  network: NetworkKey = "mainnet",
  rpcOverride?: string,
): ChainExecutionEnv {
  const info = networkInfoFor(chainKey, network, rpcOverride);
  return {
    chainKey,
    chainId: info.chainId,
    rpcUrl: info.rpc,
    router: info.venues[0]?.router ?? "",
    wrapped: info.wrapped,
    nativeSymbol: info.nativeSymbol,
    label: info.label,
    explorerUrl: info.explorerUrl,
    network,
  };
}
