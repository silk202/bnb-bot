/**
 * Compatibility view over the single authoritative registry.
 *
 * The endpoints and chain ids used to be listed twice — here and in
 * `src/chains/registry/*`. They are now derived from
 * `src/chains/registry/networks.ts` and `rpc-registry.ts`, so there is exactly
 * one place an endpoint or a chain id is defined.
 *
 * Kept as a module because the terminal's RPC manager and the wallet code import
 * these names (`NETWORKS`, `assertChainMatch`, …).
 */
import {
  NETWORKS as REGISTRY_NETWORKS,
  networkByKey,
  type NetworkConfig,
} from "../chains/registry/networks";
import { rpcProviders } from "../chains/registry/rpc-registry";

export type EvmChainKey = "bsc" | "ethereum" | "arbitrum" | "polygon";
export type NetworkMode = "mainnet" | "testnet";

export interface NetworkEndpoint {
  url: string;
  ws?: string;
  /** Provider family — independence is counted by operator, not hostname. */
  provider: string;
  archive?: boolean;
}

export interface NetworkDefinition {
  key: EvmChainKey;
  mode: NetworkMode;
  chainId: number;
  name: string;
  nativeSymbol: string;
  explorer: string;
  endpoints: NetworkEndpoint[];
  executionReady: boolean;
  executionBlockedReason?: string;
  logsOnPublicRpc: boolean;
}

/** Registry network key for a chain + mode. */
const REGISTRY_KEY: Record<EvmChainKey, Record<NetworkMode, string>> = {
  bsc: { mainnet: "bsc", testnet: "bsc-testnet" },
  ethereum: { mainnet: "ethereum", testnet: "ethereum-sepolia" },
  arbitrum: { mainnet: "arbitrum", testnet: "arbitrum-sepolia" },
  polygon: { mainnet: "polygon", testnet: "polygon-amoy" },
};

function define(key: EvmChainKey, mode: NetworkMode): NetworkDefinition {
  const registryKey = REGISTRY_KEY[key][mode];
  const network: NetworkConfig | undefined = networkByKey(registryKey);
  if (!network) throw new Error(`Network "${registryKey}" missing from the central registry.`);

  // Only BSC mainnet is the app's cleared production path. This mirrors
  // LIVE_CLEARED_CHAINS in src/chains/execution/gate-policy.ts; the gate is the
  // authority at signing time, this flag only describes capability.
  const executionReady = key === "bsc" && mode === "mainnet";

  return {
    key,
    mode,
    chainId: network.chainId,
    name: network.name,
    nativeSymbol: network.nativeCurrency.symbol,
    explorer: network.explorerUrl,
    endpoints: rpcProviders(registryKey, mode).map((endpoint) => ({
      url: endpoint.url,
      provider: endpoint.provider,
    })),
    executionReady,
    ...(executionReady
      ? {}
      : {
          executionBlockedReason:
            "Execution stays disabled until on-chain validation passes and a backend activation record is issued.",
        }),
    // BSC documents that eth_getLogs is disabled on its public endpoints.
    logsOnPublicRpc: !(key === "bsc" && mode === "mainnet"),
  };
}

export const NETWORKS: Record<EvmChainKey, Record<NetworkMode, NetworkDefinition>> = {
  bsc: { mainnet: define("bsc", "mainnet"), testnet: define("bsc", "testnet") },
  ethereum: { mainnet: define("ethereum", "mainnet"), testnet: define("ethereum", "testnet") },
  arbitrum: { mainnet: define("arbitrum", "mainnet"), testnet: define("arbitrum", "testnet") },
  polygon: { mainnet: define("polygon", "mainnet"), testnet: define("polygon", "testnet") },
};

export function networkFor(key: EvmChainKey, mode: NetworkMode): NetworkDefinition {
  return NETWORKS[key][mode];
}

export function listNetworks(mode: NetworkMode): NetworkDefinition[] {
  return (Object.keys(NETWORKS) as EvmChainKey[]).map((key) => NETWORKS[key][mode]);
}

/** The hard stop: a network only signs when execution was validated/cleared. */
export function assertExecutionAllowed(def: NetworkDefinition): void {
  if (!def.executionReady) {
    throw new Error(
      `Execution is not enabled on ${def.name} (chain ${def.chainId}): ` +
        `${def.executionBlockedReason ?? "contracts and venues are unvalidated"}.`,
    );
  }
}

/** Never let a mainnet transaction ride a testnet configuration, or the reverse. */
export function assertChainMatch(def: NetworkDefinition, walletChainId: number): void {
  if (walletChainId !== def.chainId) {
    throw new Error(
      `Chain mismatch: configuration is ${def.name} (${def.chainId}) but the wallet reports ${walletChainId}. ` +
        "Refusing to sign.",
    );
  }
  const canonical = REGISTRY_NETWORKS.find((n) => n.key === REGISTRY_KEY[def.key][def.mode]);
  if (!canonical || canonical.chainId !== def.chainId) {
    throw new Error(`Registry inconsistency for ${def.key}/${def.mode}.`);
  }
}

/** Distinct infrastructure operators, not distinct hostnames. */
export function providerCount(def: NetworkDefinition): number {
  return new Set(def.endpoints.map((e) => e.provider)).size;
}

export { REGISTRY_NETWORKS };
