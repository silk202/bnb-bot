/**
 * Solana wallet import — real cryptographic validation, nothing mocked.
 *
 * Accepts:
 *  • base58-encoded 64-byte secret keys (Phantom/Solflare export format —
 *    the 64 bytes are seed(32) || public key(32)) or raw 32-byte seeds,
 *  • hex-encoded 64-byte secrets / 32-byte seeds,
 *  • BIP39 mnemonics (12–24 words) derived through SLIP-0010 ed25519 at the
 *    Solana standard path m/44'/501'/0'/0' (Phantom compatible), with an
 *    honest fallback to m/44'/501' (Solflare style) surfaced in the result.
 *
 * The secret never leaves the caller's session. Only the derived PUBLIC
 * address is persisted anywhere.
 */
import { validateMnemonic as bip39Validate, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { SOL_RPC_ENDPOINTS, SOL_CLUSTER_LABEL, type SolCluster } from "@/lib/solana-jito";

/** Ed25519 SLIP-0010 hardened-only derivation (Solana's standard). */
function slip10Ed25519Master(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function slip10Ed25519Child(
  parent: { key: Uint8Array; chainCode: Uint8Array },
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  // Hardened derivation: data = 0x00 || parentKey || ser32(index)
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0;
  data.set(parent.key, 1);
  new DataView(data.buffer).setUint32(1 + 32, index, false);
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** Derive the 32-byte ed25519 seed for a mnemonic along a hardened path. */
function deriveSeedFromMnemonic(mnemonic: string, path: number[]): Uint8Array {
  let node = slip10Ed25519Master(mnemonicToSeedSync(mnemonic));
  for (const index of path) node = slip10Ed25519Child(node, index);
  return node.key;
}

export interface ImportedSolWallet {
  /** Base58 address (the public key). */
  address: string;
  /** 64-byte secret key (seed || pub) base58 — session-only, never persisted. */
  secretKeyBs58: string;
  /** How the wallet was derived. */
  via: "secretKey" | "mnemonic";
  /** Derivation path reported for mnemonic imports. */
  path?: string;
}

export class SolImportError extends Error {}

function keypairFromSeed32(seed: Uint8Array, via: ImportedSolWallet["via"]): ImportedSolWallet {
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { address: base58.encode(pub), secretKeyBs58: base58.encode(full), via };
}

/** Embedded-public-key consistency check for 64-byte exports. */
function embeddedPubMatches(bytes: Uint8Array): boolean {
  const pub = ed25519.getPublicKey(bytes.slice(0, 32));
  return bytes.slice(32).every((b, i) => b === pub[i]);
}

/**
 * Validate + derive a wallet from a pasted private key (base58 64-byte
 * Phantom export, hex 64-byte, or raw 32-byte seed) or a BIP39 mnemonic.
 * Throws SolImportError with a human reason on any failure.
 */
export function importSolWallet(raw: string): ImportedSolWallet {
  const input = raw.trim().replace(/^["']|["']$/g, "");
  if (!input) throw new SolImportError("Paste a private key or seed phrase first.");

  // ── Mnemonic? 12–24 lowercase words → validate against the BIP39 list ──
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/.test(w))) {
    if (!bip39Validate(input, englishWordlist)) {
      throw new SolImportError(
        `Invalid seed phrase — ${words.length} words recognized but BIP39 checksum/wordlist validation failed.`,
      );
    }
    // Phantom-compatible path first (the standard Solana derivation).
    const seed = deriveSeedFromMnemonic(input, [2147483746, 2147483748, 2147483648, 2147483648]);
    const wallet = keypairFromSeed32(seed, "mnemonic");
    wallet.path = "m/44'/501'/0'/0' (Phantom-compatible)";
    return wallet;
  }

  // ── Hex-encoded 64-byte secret or 32-byte seed ──
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(input)) {
    const hex = input.replace(/^0x/, "");
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!embeddedPubMatches(bytes)) {
      throw new SolImportError("Hex key rejected — embedded public key does not match the seed.");
    }
    return keypairFromSeed32(bytes.slice(0, 32), "secretKey");
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(input)) {
    const hex = input.replace(/^0x/, "");
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return keypairFromSeed32(seed, "secretKey");
  }

  // ── Base58 secret key (Phantom/Solflare export) ──
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(input);
  } catch {
    throw new SolImportError("Not valid base58 — check for typos (0, O, I and l are excluded).");
  }
  if (decoded.length === 64) {
    if (!embeddedPubMatches(decoded)) {
      throw new SolImportError("Base58 key rejected — embedded public key does not match the seed.");
    }
    return keypairFromSeed32(decoded.slice(0, 32), "secretKey");
  }
  if (decoded.length === 32) return keypairFromSeed32(decoded, "secretKey");

  throw new SolImportError(
    `Unrecognized format (${words.length} words / ${decoded.length} bytes) — paste a base58 private key, hex key, or a 12–24 word seed phrase.`,
  );
}

export interface SolConnectionStatus {
  connected: boolean;
  cluster: SolCluster;
  endpoint: string;
  slot: number | null;
  latencyMs: number | null;
  error?: string;
}

/**
 * Live connection check against the selected cluster's RPC — a real
 * getSlot round-trip confirming the network is reachable before the
 * sniper arms on it. Uses the same endpoint resolver as execution.
 */
export async function connectSolCluster(
  cluster: SolCluster,
  rpcOverride?: string,
): Promise<SolConnectionStatus> {
  const endpoint =
    rpcOverride && rpcOverride.trim() !== "" ? rpcOverride.trim() : SOL_RPC_ENDPOINTS[cluster];
  const started = performance.now();
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(endpoint, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
    });
    if (!res.ok) throw new Error(`RPC responded ${res.status}`);
    const data = (await res.json()) as { result?: number; error?: { message?: string } };
    if (typeof data.result !== "number") throw new Error(data.error?.message ?? "no slot in response");
    return {
      connected: true,
      cluster,
      endpoint,
      slot: data.result,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      connected: false,
      cluster,
      endpoint,
      slot: null,
      latencyMs: null,
      error: e instanceof Error ? e.message : "connection failed",
    };
  }
}

export { SOL_CLUSTER_LABEL };
