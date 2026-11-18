/**
 * Terminal chain key → registry network key.
 *
 * There is deliberately no default: an unknown chain must fail closed, not be
 * treated as BSC. `undefined` is the answer for anything we cannot map.
 */
export type TerminalChainKey = "bsc" | "ethereum" | "arbitrum" | "polygon";

const TESTNET_KEY: Record<TerminalChainKey, string> = {
  bsc: "bsc-testnet",
  ethereum: "ethereum-sepolia",
  arbitrum: "arbitrum-sepolia",
  polygon: "polygon-amoy",
};

export function networkKeyFor(
  chainKey: string,
  network: "mainnet" | "testnet",
): string | undefined {
  if (!(chainKey in TESTNET_KEY)) return undefined;
  const key = chainKey as TerminalChainKey;
  return network === "testnet" ? TESTNET_KEY[key] : key;
}
