/**
 * Deployment provenance per network.
 *
 * Rule: an address is only here if it is a real deployment this repository can
 * justify. Nothing is invented, and nothing starts as `validated` — that status
 * is produced by the readiness engine from on-chain checks, never typed here.
 *
 * What is present today:
 *   - canonical V2 router/factory addresses (PancakeSwap, Uniswap, QuickSwap)
 *     taken from CHAIN_INFO/CHAIN_NETWORKS, which were verified live,
 *   - the wrapped native token per network,
 *   - flash-loan lenders actually deployed on that chain (CHAIN_INFO.lenders).
 *
 * What is deliberately absent:
 *   - executors: they are deployed per operator through the Contract page, so
 *     there is no manifest until the deployment is verified. `executor` stays
 *     undefined and the readiness engine reports `pending`.
 */
import { CHAIN_NETWORKS, type ChainKey, type NetworkKey } from "../../lib/chains";
import type { DeploymentStatus } from "./chain-types";

export interface AddressRef {
  address: string;
  /** Why this address is trusted to be what it claims. */
  evidence: string;
}

export interface NetworkDeploymentManifest {
  id: string;
  chainId: number;
  /** Registry key (networks.ts). */
  networkKey: string;
  protocol: string;
  protocolVersion: string;
  router?: AddressRef;
  factory?: AddressRef;
  wrappedToken?: AddressRef;
  lenders: AddressRef[];
  executor?: { address: string; runtimeCodeHash: string; deploymentTx: string; deploymentBlock: number };
  status: DeploymentStatus;
  note?: string;
}

interface Pair {
  key: ChainKey;
  network: NetworkKey;
  id: string;
  chainId: number;
}

const PAIRS: readonly Pair[] = [
  { key: "bsc", network: "mainnet", id: "bsc-mainnet", chainId: 56 },
  { key: "bsc", network: "testnet", id: "bsc-testnet", chainId: 97 },
  { key: "ethereum", network: "mainnet", id: "ethereum-mainnet", chainId: 1 },
  { key: "ethereum", network: "testnet", id: "ethereum-sepolia", chainId: 11155111 },
  { key: "arbitrum", network: "mainnet", id: "arbitrum-mainnet", chainId: 42161 },
  { key: "arbitrum", network: "testnet", id: "arbitrum-sepolia", chainId: 421614 },
  { key: "polygon", network: "mainnet", id: "polygon-mainnet", chainId: 137 },
  { key: "polygon", network: "testnet", id: "polygon-amoy", chainId: 80002 },
];

/** Networks registered without any deployment evidence — never ready. */
const EMPTY_MANIFESTS: readonly NetworkDeploymentManifest[] = [
  { id: "base-mainnet", chainId: 8453, networkKey: "base", protocol: "none", protocolVersion: "-", lenders: [], status: "unavailable", note: "No router, factory or lender deployment has been validated for this network." },
  { id: "base-sepolia", chainId: 84532, networkKey: "base-sepolia", protocol: "none", protocolVersion: "-", lenders: [], status: "unavailable", note: "Registered only. No validated DEX deployment exists here yet." },
  { id: "optimism-mainnet", chainId: 10, networkKey: "optimism", protocol: "none", protocolVersion: "-", lenders: [], status: "unavailable", note: "No router, factory or lender deployment has been validated for this network." },
  { id: "optimism-sepolia", chainId: 11155420, networkKey: "optimism-sepolia", protocol: "none", protocolVersion: "-", lenders: [], status: "unavailable", note: "Registered only. No validated DEX deployment exists here yet." },
];

const PROTOCOL_BY_CHAIN: Record<ChainKey, { protocol: string; version: string }> = {
  bsc: { protocol: "PancakeSwap V2", version: "Router02" },
  ethereum: { protocol: "Uniswap V2", version: "Router02" },
  arbitrum: { protocol: "Uniswap V2", version: "Router02" },
  polygon: { protocol: "QuickSwap V2", version: "Router02" },
};

function manifestFor(pair: Pair): NetworkDeploymentManifest {
  const info = CHAIN_NETWORKS[pair.key][pair.network];
  const venue = info.venues[0];
  const meta = PROTOCOL_BY_CHAIN[pair.key];
  // CHAIN_INFO.lenders lists protocol NAMES ("Aave V3", "Venus", …), not pool
  // addresses. Recording a name as an address would be fabrication, so the
  // manifest carries none until a real lender address is verified — and the
  // flash-loan check therefore stays `pending`.
  const lenders: AddressRef[] = [];

  // Testnet venues can legitimately be empty; that is `unavailable`, not a mock.
  if (!venue) {
    return {
      id: pair.id,
      chainId: pair.chainId,
      networkKey: pair.id,
      protocol: meta.protocol,
      protocolVersion: meta.version,
      lenders,
      status: "unavailable",
      note: "No verified V2 deployment is known on this network — integration unavailable.",
    };
  }

  return {
    id: pair.id,
    chainId: pair.chainId,
    networkKey: pair.id,
    protocol: meta.protocol,
    protocolVersion: meta.version,
    router: { address: venue.router, evidence: `${meta.protocol} canonical router on ${info.label}` },
    factory: { address: venue.factory, evidence: `${meta.protocol} canonical factory on ${info.label}` },
    ...(info.wrapped ? { wrappedToken: { address: info.wrapped, evidence: `wrapped native token on ${info.label}` } } : {}),
    lenders,
    // Addresses exist, but nothing has been re-validated in this build.
    status: "unverified",
    note: "Router/factory addresses known; awaiting live on-chain validation. No verified flash-loan pool address is recorded, so that requirement stays pending.",
  };
}

const MANIFESTS: readonly NetworkDeploymentManifest[] = [
  ...PAIRS.map(manifestFor),
  ...EMPTY_MANIFESTS,
];

const BY_ID = new Map(MANIFESTS.map((m) => [m.id, m]));

export function deploymentManifest(id: string): NetworkDeploymentManifest | undefined {
  return BY_ID.get(id);
}

export function allDeploymentManifests(): readonly NetworkDeploymentManifest[] {
  return MANIFESTS;
}

/**
 * Every address in the registry must be syntactically an EVM address. This is a
 * guard against typos and placeholders — it is not a substitute for on-chain
 * verification, which is the validator's job.
 */
export function assertRegistryAddressesWellFormed(): void {
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  for (const manifest of MANIFESTS) {
    const refs = [manifest.router, manifest.factory, manifest.wrappedToken, ...manifest.lenders];
    for (const ref of refs) {
      if (ref && !ADDRESS.test(ref.address)) {
        throw new Error(`${manifest.id}: "${ref.address}" is not a well-formed address.`);
      }
    }
  }
}
