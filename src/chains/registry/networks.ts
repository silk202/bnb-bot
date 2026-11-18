/**
 * The authoritative network registry.
 *
 * Every network the app knows about is listed exactly once here, with its real
 * chain id, native currency and explorer. RPC lists are filled by
 * rpc-registry.ts; deployment provenance lives in deployment-registry.ts.
 *
 * Base and Optimism are REGISTERED but have no deployment manifest and no
 * venues, so they can never be activated — which is different from being
 * omitted, and different from being pretend-ready.
 */
import { DEFAULT_VALIDATIONS, type NetworkConfig } from "./chain-types";
import { rpcFor } from "./rpc-registry";

export type { NetworkConfig } from "./chain-types";

interface NetworkSeed {
  key: string;
  name: string;
  chainId: number;
  environment: NetworkConfig["environment"];
  nativeCurrency: NetworkConfig["nativeCurrency"];
  explorerUrl: string;
  deploymentRegistry: string;
  /** Websocket endpoints are only listed when actually known to exist. */
  websocket?: string[];
}

const SEEDS: readonly NetworkSeed[] = [
  {
    key: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    environment: "mainnet",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    explorerUrl: "https://bscscan.com",
    deploymentRegistry: "bsc-mainnet",
  },
  {
    key: "bsc-testnet",
    name: "BSC Testnet",
    chainId: 97,
    environment: "testnet",
    nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
    explorerUrl: "https://testnet.bscscan.com",
    deploymentRegistry: "bsc-testnet",
  },
  {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    environment: "mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://etherscan.io",
    deploymentRegistry: "ethereum-mainnet",
  },
  {
    key: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    chainId: 11155111,
    environment: "testnet",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://sepolia.etherscan.io",
    deploymentRegistry: "ethereum-sepolia",
  },
  {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    environment: "mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://arbiscan.io",
    deploymentRegistry: "arbitrum-mainnet",
  },
  {
    key: "arbitrum-sepolia",
    name: "Arbitrum Sepolia",
    chainId: 421614,
    environment: "testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://sepolia.arbiscan.io",
    deploymentRegistry: "arbitrum-sepolia",
  },
  {
    key: "polygon",
    name: "Polygon PoS",
    chainId: 137,
    environment: "mainnet",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    explorerUrl: "https://polygonscan.com",
    deploymentRegistry: "polygon-mainnet",
  },
  {
    key: "polygon-amoy",
    name: "Polygon Amoy",
    chainId: 80002,
    environment: "testnet",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    explorerUrl: "https://amoy.polygonscan.com",
    deploymentRegistry: "polygon-amoy",
  },
  {
    key: "base",
    name: "Base",
    chainId: 8453,
    environment: "mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://basescan.org",
    deploymentRegistry: "base-mainnet",
  },
  {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    environment: "testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://sepolia.basescan.org",
    deploymentRegistry: "base-sepolia",
  },
  {
    key: "optimism",
    name: "Optimism",
    chainId: 10,
    environment: "mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://optimistic.etherscan.io",
    deploymentRegistry: "optimism-mainnet",
  },
  {
    key: "optimism-sepolia",
    name: "Optimism Sepolia",
    chainId: 11155420,
    environment: "testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    deploymentRegistry: "optimism-sepolia",
  },
];

/** The registry. Execution is literal `disabled` for every entry, always. */
export const NETWORKS: readonly NetworkConfig[] = SEEDS.map((seed) => {
  const rpc = rpcFor(seed.key, seed.environment);
  return {
    key: seed.key,
    name: seed.name,
    chainId: seed.chainId,
    environment: seed.environment,
    nativeCurrency: seed.nativeCurrency,
    rpc: {
      http: rpc.http,
      ...(seed.websocket?.length ? { websocket: seed.websocket } : {}),
    },
    explorerUrl: seed.explorerUrl,
    execution: { enabled: false, mode: "disabled" },
    deploymentRegistry: seed.deploymentRegistry,
    requiredValidations: DEFAULT_VALIDATIONS,
  };
});

const BY_KEY = new Map(NETWORKS.map((n) => [n.key, n]));

export function networkByKey(key: string): NetworkConfig | undefined {
  return BY_KEY.get(key);
}

export function networkByChainId(chainId: number): NetworkConfig | undefined {
  return NETWORKS.find((n) => n.chainId === chainId);
}

export function networksFor(environment: NetworkConfig["environment"]): NetworkConfig[] {
  return NETWORKS.filter((n) => n.environment === environment);
}

/** Chain ids are unique per network; a duplicate is a configuration bug. */
export function assertUniqueChainIds(): void {
  const seen = new Set<number>();
  for (const network of NETWORKS) {
    if (seen.has(network.chainId)) {
      throw new Error(`Duplicate chain id ${network.chainId} in the network registry.`);
    }
    seen.add(network.chainId);
  }
}
