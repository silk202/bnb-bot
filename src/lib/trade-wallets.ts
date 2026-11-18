// FlashBolt Trade — real wallet connection (address-only, never keys).
//
// Connects to INJECTED browser wallets for deposits/withdrawals:
//   • EVM (MetaMask, Trust Wallet, OKX, Bitget): window.ethereum (EIP-1193)
//   • Solana (Phantom, Solflare, Backpack): window.solana / window.solflare /
//     window.backpack (solana provider standard: connect() → publicKey)
//   • Exchange apps (Binance, Bybit): paste-address flow — exchanges cannot
//     be injected, so the honest path is copying the receiving address.
//
// SECURITY: private keys never leave the wallet extension. This module reads
// public addresses and requests MESSAGE signatures only (deposit-address
// binding challenges) — the server verifies those signatures before any
// address is stored. Nothing is stored client-side beyond the session.

import type { TradeNetworkDef } from "@/convex/tradeAssets";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  providers?: Eip1193Provider[];
};

type SolanaProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect?: () => Promise<void>;
};

// window.ethereum is already declared by viem's types (EthereumProvider).
// Narrow it locally for the EIP-1193 calls we make, and add the Solana
// injectors that nothing else declares.
declare global {
  interface Window {
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
  }
}

type EthProvider = Eip1193Provider & { providers?: Eip1193Provider[] };

function eth(): EthProvider | null {
  return (window.ethereum as unknown as EthProvider | undefined) ?? null;
}

export type WalletId =
  | "metamask"
  | "trust"
  | "okx"
  | "bitget"
  | "phantom"
  | "solflare"
  | "backpack"
  | "binance"
  | "bybit";

export type WalletInfo = {
  id: WalletId;
  name: string;
  kind: "evm" | "solana" | "exchange";
  /** true when the extension is injected in this browser right now. */
  injected: boolean;
  installUrl?: string;
  color: string;
};

function findInjectedEvm(prefer: (p: Eip1193Provider) => boolean): Eip1193Provider | null {
  const ethProvider = eth();
  if (!ethProvider) return null;
  // Some wallets expose a providers array (multi-wallet browsers).
  const list = ethProvider.providers?.length ? ethProvider.providers : [ethProvider];
  return list.find(prefer) ?? null;
}

export function hasInjectedEvm(): boolean {
  return typeof window !== "undefined" && Boolean(eth());
}

export function hasInjectedSolana(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.solana || window.solflare || window.backpack)
  );
}

export const WALLETS: WalletInfo[] = [
  { id: "metamask", name: "MetaMask", kind: "evm", injected: false, installUrl: "https://metamask.io/download/", color: "#F6851B" },
  { id: "trust", name: "Trust Wallet", kind: "evm", injected: false, installUrl: "https://trustwallet.com/download", color: "#3375BB" },
  { id: "okx", name: "OKX Wallet", kind: "evm", injected: false, installUrl: "https://www.okx.com/web3", color: "#8CA3FB" },
  { id: "bitget", name: "Bitget Wallet", kind: "evm", injected: false, installUrl: "https://web3.bitget.com/", color: "#00F0FF" },
  { id: "phantom", name: "Phantom", kind: "solana", injected: false, installUrl: "https://phantom.app/download", color: "#AB9FF2" },
  { id: "solflare", name: "Solflare", kind: "solana", injected: false, installUrl: "https://solflare.com/download", color: "#FFC107" },
  { id: "backpack", name: "Backpack", kind: "solana", injected: false, installUrl: "https://backpack.app/download", color: "#E33E3F" },
  { id: "binance", name: "Binance (paste address)", kind: "exchange", injected: false, installUrl: "https://www.binance.com/en/my/wallet/account/main/withdraw", color: "#F0B90B" },
  { id: "bybit", name: "Bybit (paste address)", kind: "exchange", injected: false, installUrl: "https://www.bybit.com/user/assets/withdraw", color: "#F7A600" },
];

/** Wallets currently injected & connectable in this browser. */
export function detectWallets(): WalletInfo[] {
  return WALLETS.map((w) => ({
    ...w,
    injected:
      w.kind === "evm"
        ? hasInjectedEvm() && findInjectedEvm((p) => {
            switch (w.id) {
              case "metamask": return Boolean(p.isMetaMask);
              case "trust": return Boolean(p.isTrust || p.isTrustWallet);
              case "okx": return Boolean((p as unknown as { isOKXWallet?: boolean }).isOKXWallet);
              case "bitget": return Boolean((p as unknown as { isBitKeep?: boolean }).isBitKeep);
              default: return false;
            }
          }) !== null
        : w.kind === "solana"
          ? w.id === "phantom"
            ? Boolean(window.solana?.isPhantom)
            : w.id === "solflare"
              ? Boolean(window.solflare)
              : Boolean(window.backpack)
          : false,
  }));
}

/** Connect an EVM wallet and return the first public address. */
async function connectEvm(): Promise<string> {
  const ethProvider = eth();
  if (!ethProvider) throw new Error("No EVM wallet injected — install MetaMask, Trust, OKX or Bitget.");
  const accounts = (await ethProvider.request({ method: "eth_requestAccounts" })) as string[];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("No account authorized — unlock the wallet and try again.");
  }
  return accounts[0];
}

/**
 * Sign a message with an EVM wallet (EIP-191 personal_sign). Returns the
 * hex signature — verification happens SERVER-SIDE via ecrecover.
 */
export async function signMessageEvm(message: string): Promise<string> {
  const ethProvider = eth();
  if (!ethProvider) throw new Error("No EVM wallet injected.");
  const accounts = (await ethProvider.request({ method: "eth_accounts" })) as string[];
  const address = Array.isArray(accounts) && accounts[0] ? accounts[0] : await connectEvm();
  return (await ethProvider.request({
    method: "personal_sign",
    params: [hexUtf8(message), address],
  })) as string;
}

function hexUtf8(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

// Base58 (Bitcoin alphabet) encoder for ed25519 signatures — mirrors the
// decoder in src/convex/tradeCustody.ts without pulling another dependency.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

/**
 * Sign a message with a Solana wallet (Phantom/Solflare/Backpack sign the
 * raw UTF-8 bytes; the signature comes back base58 or hex — we normalize
 * to base58 for the server's ed25519 verify).
 */
export async function signMessageSolana(
  id: WalletId,
  message: string,
): Promise<string> {
  const provider =
    id === "phantom" ? window.solana : id === "solflare" ? window.solflare : window.backpack;
  if (!provider) throw new Error("Wallet not injected.");
  if (WALLETS.find((w) => w.id === id)?.kind !== "solana") {
    throw new Error("Only Solana wallets can sign Solana challenges.");
  }
  await provider.connect();
  const res = await (
    provider as unknown as {
      signMessage: (msg: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array }>;
    }
  ).signMessage(new TextEncoder().encode(message), "utf8");
  const sig = res?.signature;
  if (!sig) throw new Error("Wallet returned no signature.");
  return base58Encode(sig);
}

/** Connect a Solana wallet and return the public key. */
async function connectSolana(id: WalletId): Promise<string> {
  const provider =
    id === "phantom" ? window.solana : id === "solflare" ? window.solflare : window.backpack;
  if (!provider) throw new Error("Wallet not injected — install the extension first.");
  const res = await provider.connect();
  const addr = res?.publicKey?.toString();
  if (!addr) throw new Error("Wallet returned no public key.");
  return addr;
}

/**
 * Connect any wallet by id. Exchanges cannot be connected (no injection) —
 * they return null and the UI falls back to the paste/copy flow.
 */
export async function connectWallet(id: WalletId): Promise<string | null> {
  const info = WALLETS.find((w) => w.id === id);
  if (!info) throw new Error("Unknown wallet.");
  if (info.kind === "exchange") return null; // paste-address flow
  if (info.kind === "evm") return await connectEvm();
  return await connectSolana(id);
}

/** Basic address validation per network family (client-side sanity check). */
export function validateAddress(addr: string, net: TradeNetworkDef): boolean {
  const a = addr.trim();
  if (!a) return false;
  switch (net.chainKind) {
    case "evm":
      return /^0x[a-fA-F0-9]{40}$/.test(a);
    case "solana":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
    case "utxo":
      // BTC bech32 / P2PKH / P2SH; LTC shares the shapes (L/M prefix differs).
      return (
        /^(bc1|ltc1)[0-9a-z]{11,71}$/.test(a) ||
        /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a) ||
        /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a)
      );
    case "monero":
      return /^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(a);
    default:
      return a.length >= 20;
  }
}
