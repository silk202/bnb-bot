/**
 * EVM wallet import — real cryptographic validation, nothing mocked.
 *
 * Accepts:
 *  • BIP39 mnemonics (12–24 words) derived through viem/accounts'
 *    mnemonicToAccount at the EVM standard path m/44'/60'/0'/0/0
 *    (MetaMask / Trust Wallet compatible),
 *  • secp256k1 private keys as 0x-prefixed or bare 64-hex-char strings.
 *
 * The secret never leaves the caller's session. Only the derived PUBLIC
 * address is persisted anywhere — mirrors the SOL importer's contract.
 */
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { toHex } from "viem";
import { BNB_NETWORKS, networkForChainId, type NetworkKey } from "@/lib/chain";

export class EvmImportError extends Error {}

/** true when the words could be a mnemonic (12–24 lowercase words). */
export function looksLikeMnemonic(input: string): boolean {
  const words = input.trim().split(/\s+/).filter(Boolean);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/.test(w));
}

/** true when the input is a well-formed 32-byte private key in hex. */
export function looksLikePrivateKey(input: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(input.trim());
}

function accountFromPrivateKey(raw: string): PrivateKeyAccount {
  const hex = raw.trim();
  const pk = (hex.startsWith("0x") ? hex : `0x${hex}`) as `0x${string}`;
  try {
    return privateKeyToAccount(pk);
  } catch {
    throw new EvmImportError(
      "Invalid private key — expected a 32-byte secp256k1 key in hex (0x-prefixed or bare).",
    );
  }
}

export interface ImportedEvmWallet {
  /** Checksummed 20-byte address. */
  address: string;
  /** 32-byte private key, 0x-prefixed — session-only, never persisted. */
  privateKey: `0x${string}`;
  /** How the wallet was derived. */
  via: "privateKey" | "mnemonic";
  /** Derivation path reported for mnemonic imports. */
  path?: string;
}

/**
 * Validate + derive a wallet from a pasted private key or BIP39 mnemonic.
 * Throws EvmImportError with a human reason on any failure. The derived
 * private key is returned for the caller to vault — this function performs
 * no I/O and stores nothing.
 */
export function importEvmWallet(raw: string): ImportedEvmWallet {
  const input = raw.trim().replace(/^["']|["']$/g, "");
  if (!input) throw new EvmImportError("Paste a private key or seed phrase first.");

  if (looksLikeMnemonic(input)) {
    try {
      const account = mnemonicToAccount(input);
      const hd = account.getHdKey();
      if (!hd.privateKey) throw new EvmImportError("HD derivation returned no private key.");
      return {
        address: account.address,
        privateKey: toHex(hd.privateKey),
        via: "mnemonic",
        path: "m/44'/60'/0'/0/0 (BIP44 — MetaMask/Trust compatible)",
      };
    } catch (e) {
      if (e instanceof EvmImportError) throw e;
      throw new EvmImportError(
        "Invalid seed phrase — BIP39 wordlist/checksum validation failed.",
      );
    }
  }

  if (looksLikePrivateKey(input)) {
    const account = accountFromPrivateKey(input);
    const hex = input.startsWith("0x") ? (input as `0x${string}`) : (`0x${input}` as `0x${string}`);
    return { address: account.address, privateKey: hex, via: "privateKey" };
  }

  const words = input.split(/\s+/).filter(Boolean).length;
  throw new EvmImportError(
    `Unrecognized format (${words} word(s), ${input.length} chars) — paste a 0x private key or a 12–24 word seed phrase.`,
  );
}

export interface EvmConnectionStatus {
  connected: boolean;
  network: NetworkKey;
  endpoint: string;
  chainId: number | null;
  latencyMs: number | null;
  error?: string;
}

/**
 * Live connection check against the selected network's RPC — a real
 * eth_chainId round-trip confirming the node is reachable before the
 * signer arms on it. Uses the same endpoint resolver as execution.
 */
export async function connectEvmChain(
  network: NetworkKey,
  rpcOverride?: string,
): Promise<EvmConnectionStatus> {
  const endpoint =
    rpcOverride && rpcOverride.trim() !== "" ? rpcOverride.trim() : BNB_NETWORKS[network].rpc;
  const started = performance.now();
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(endpoint, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!res.ok) throw new Error(`RPC responded ${res.status}`);
    const data = (await res.json()) as { result?: string; error?: { message?: string } };
    if (typeof data.result !== "string") {
      throw new Error(data.error?.message ?? "no chainId in response");
    }
    const chainId = Number.parseInt(data.result, 16);
    const expected = BNB_NETWORKS[network].chainId;
    return {
      connected: true,
      network,
      endpoint,
      chainId,
      latencyMs: Math.round(performance.now() - started),
      error:
        networkForChainId(chainId) === null
          ? `node reports chainId ${chainId} — not a ${BNB_NETWORKS[network].label} endpoint`
          : undefined,
    };
  } catch (e) {
    return {
      connected: false,
      network,
      endpoint,
      chainId: null,
      latencyMs: null,
      error: e instanceof Error ? e.message : "connection failed",
    };
  }
}
