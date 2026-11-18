/**
 * FlashBolt wallet layer — real EIP-1193 connections only. No simulated
 * addresses, ever: if the extension is missing or rejects the request, the
 * connection fails loudly instead of fabricating a fake account.
 */

export type WalletKey = "metamask" | "trust" | "okx" | "binance" | "bybit";

export interface WalletDef {
  key: WalletKey;
  name: string;
  desc: string;
  installUrl: string;
}

export const WALLET_DEFS: WalletDef[] = [
  {
    key: "metamask",
    name: "MetaMask",
    desc: "The classic browser wallet",
    installUrl: "https://metamask.io/download/",
  },
  {
    key: "trust",
    name: "Trust Wallet",
    desc: "Mobile-first, injected on desktop",
    installUrl: "https://trustwallet.com/download",
  },
  {
    key: "okx",
    name: "OKX Wallet",
    desc: "OKX Web3 extension",
    installUrl: "https://www.okx.com/web3",
  },
  {
    key: "binance",
    name: "Binance Wallet",
    desc: "Binance's native wallet",
    installUrl: "https://www.binance.com/en/web3wallet",
  },
  {
    key: "bybit",
    name: "Bybit Wallet",
    desc: "Bybit's Web3 wallet extension",
    installUrl: "https://www.bybit.com/en/web3",
  },
];

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
  isTrust?: boolean;
  isOkxWallet?: boolean;
  isBinanceWallet?: boolean;
  isBybitWallet?: boolean;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

/** Find the injected provider for a wallet key (generic provider maps to MetaMask). */
export function detectProvider(key: WalletKey): EthereumProvider | null {
  if (typeof window === "undefined" || !window.ethereum) return null;
  const provider = window.ethereum;
  const flags: Record<WalletKey, boolean> = {
    metamask: !!provider.isMetaMask,
    trust: !!provider.isTrust,
    okx: !!provider.isOkxWallet,
    binance: !!provider.isBinanceWallet,
    bybit: !!provider.isBybitWallet,
  };
  if (flags[key]) return provider;
  // No extension self-identifies: treat the generic EIP-1193 provider as MetaMask.
  if (key === "metamask" && !Object.values(flags).some(Boolean)) return provider;
  return null;
}

export interface ConnectedWallet {
  key: WalletKey;
  address: string;
  balanceWei: string;
}

/**
 * Connect a wallet over EIP-1193.
 * Throws if the extension is missing or the user rejects the request — no
 * simulated fallback, so the terminal only ever sees real accounts.
 */
export async function connectWallet(
  key: WalletKey,
): Promise<ConnectedWallet> {
  const provider = detectProvider(key);
  if (!provider?.request) {
    const def = WALLET_DEFS.find((w) => w.key === key);
    throw new Error(
      `${def?.name ?? key} is not installed — install the browser extension and reload, then connect for real.`,
    );
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[] | undefined;
  const address = accounts?.[0];
  if (!address) throw new Error("No account returned by the wallet");
  let balanceWei = "0";
  try {
    balanceWei = String(
      await provider.request({
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    );
  } catch {
    // Balance probe can fail on non-default chains — the connection still works.
  }
  return { key, address, balanceWei };
}

export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function weiToBnb(wei: string): number {
  try {
    return Number(BigInt(wei || "0")) / 1e18;
  } catch {
    return 0;
  }
}
