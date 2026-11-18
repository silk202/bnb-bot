/**
 * EVM session vault — imported wallets, cryptographically sealed.
 *
 * Threat model, honestly stated (mirrors solana-vault.ts exactly):
 *  • The pasted secret (mnemonic / private key) is validated and derived
 *    LOCALLY by evm-import.ts (BIP39 m/44'/60'/0'/0/0 via viem/accounts).
 *    It is never logged, never sent to any server, and never written to
 *    disk in the clear.
 *  • At rest (between React re-mounts in the SAME browser tab) only
 *    AES-256-GCM ciphertext lives in sessionStorage. The AES key is derived
 *    from the operator's session passphrase with PBKDF2-SHA-256 (310k
 *    iterations) and kept ONLY in module memory — never persisted, and
 *    non-extractable so raw key material can never be read back out.
 *  • When the tab closes, sessionStorage dies with it: the operator
 *    re-enters the passphrase next session. `Lock` wipes memory + storage
 *    immediately.
 *  • Signing uses the in-memory viem account directly — real secp256k1
 *    ECDSA, in-process, no extension round-trip, no popup: the fastest
 *    real signing path a browser can offer. Network I/O (RPC broadcast,
 *    receipts) is NOT sub-millisecond; the sub-millisecond claim covers
 *    signer resolution + local signing only.
 *
 * Watch-only imports (public addresses) never enter the vault: there is
 * no secret to encrypt and no signature possible — they persist as plain
 * addresses in the terminal state and are reported honestly.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { importEvmWallet } from "./evm-import";

const STORAGE_KEY = "fb.evmVault.v1";
const PBKDF2_ITERATIONS = 310_000;

interface VaultEntry {
  iv: string; // base64 AES-GCM IV (12 bytes)
  ct: string; // base64 ciphertext of the 32-byte private key
}

interface VaultBlob {
  v: 1;
  salt: string; // base64 PBKDF2 salt (16 bytes)
  wallets: Record<string, VaultEntry>; // lowercase address → entry
}

/** Storage abstraction — window.sessionStorage in the app, injectable in tests. */
export interface VaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): VaultStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let storageOverride: VaultStorage | null | undefined;
export function setVaultStorage(store: VaultStorage | null): void {
  storageOverride = store;
}
function activeStorage(): VaultStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  return defaultStorage();
}

// ── Module memory — the ONLY place plaintext material and keys live ──
let aesKey: CryptoKey | null = null;
let cachedSalt: Uint8Array | null = null;
const memoryKeys = new Map<string, `0x${string}`>(); // lowercase address → 0x private key
let watchOnly = new Set<string>(); // checksummed addresses imported without a secret

// ── base64 helpers (Uint8Array-safe) ──
function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

/** Normalize an address for vault map keys (lowercase, 0x kept). */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable — the raw key material can never be read back out
    ["encrypt", "decrypt"],
  );
}

async function encryptSecret(key: CryptoKey, secret: Uint8Array): Promise<VaultEntry> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    secret as BufferSource,
  );
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

async function decryptSecret(key: CryptoKey, entry: VaultEntry): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(entry.iv) as BufferSource },
    key,
    b64decode(entry.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

function readBlob(): VaultBlob | null {
  const store = activeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultBlob;
    if (parsed?.v !== 1 || typeof parsed.salt !== "string" || !parsed.wallets) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeBlob(blob: VaultBlob): void {
  const store = activeStorage();
  if (!store) return; // no storage (tests / hardened browsers) → memory-only session
  store.setItem(STORAGE_KEY, JSON.stringify(blob));
}

// ── Public API ───────────────────────────────────────────────────────────

/** True when the vault holds decrypted keys in memory (unlocked state). */
export function vaultUnlocked(): boolean {
  return aesKey !== null && memoryKeys.size > 0;
}

/** Addresses currently held as LIVE signers in memory (checksummed). */
export function vaultSignerAddresses(): string[] {
  return [...memoryKeys.keys()].map((a) => privateKeyToAccount(memoryKeys.get(a)!).address);
}

/** Watch-only (public address) entries registered this session. */
export function vaultWatchOnlyAddresses(): string[] {
  return [...watchOnly];
}

/** Whether ANY encrypted vault blob exists for this tab (locked or not). */
export function vaultExists(): boolean {
  return readBlob() !== null || memoryKeys.size > 0;
}

/**
 * Unlock: derive the AES key from the passphrase and decrypt every stored
 * wallet into memory. Returns false on a wrong passphrase (or corrupt blob)
 * — the stored blob is left untouched so a retry can succeed.
 */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const blob = readBlob();
  if (!blob) return false;
  const salt = b64decode(blob.salt);
  const key = await deriveAesKey(passphrase, salt);
  const first = Object.values(blob.wallets)[0];
  if (!first) return false;
  try {
    // Probe with one entry — a wrong passphrase throws here.
    await decryptSecret(key, first);
  } catch {
    return false;
  }
  aesKey = key;
  cachedSalt = salt;
  memoryKeys.clear();
  for (const [address, entry] of Object.entries(blob.wallets)) {
    try {
      const bytes = await decryptSecret(key, entry);
      memoryKeys.set(address, bytesToHex(bytes));
    } catch {
      // single corrupt entry — skip it, the rest still load
    }
  }
  return memoryKeys.size > 0;
}

/**
 * Import a secret (mnemonic / private key) into the vault under the session
 * passphrase. Validates + derives locally first; on success the key is
 * AES-encrypted into the tab's blob AND cached in memory for signing.
 * Returns the derived public address (checksummed).
 */
export async function importToVault(
  secretInput: string,
  passphrase: string,
): Promise<{ address: string; via: "privateKey" | "mnemonic"; path?: string }> {
  const wallet = importEvmWallet(secretInput); // throws EvmImportError on bad input
  const secretBytes = hexToBytes(wallet.privateKey);

  let blob = readBlob();
  let key: CryptoKey;
  if (blob) {
    // Existing tab blob → the passphrase must reproduce its key (probe).
    const salt = b64decode(blob.salt);
    const probe = await deriveAesKey(passphrase, salt);
    const first = Object.values(blob.wallets)[0];
    if (first) {
      try {
        await decryptSecret(probe, first);
      } catch {
        throw new Error("Wrong session passphrase for this tab's vault — unlock first or use the same passphrase.");
      }
    }
    key = probe;
  } else {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveAesKey(passphrase, salt);
    blob = { v: 1, salt: b64encode(salt), wallets: {} };
    cachedSalt = salt;
  }

  const mapKey = normalizeAddress(wallet.address);
  blob.wallets[mapKey] = await encryptSecret(key, secretBytes);
  writeBlob(blob);
  aesKey = key;
  memoryKeys.set(mapKey, wallet.privateKey);
  return { address: wallet.address, via: wallet.via, path: wallet.path };
}

/** Register a watch-only (public address) — tracked, never signable. */
export function addWatchOnlyAddress(address: string): boolean {
  const clean = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) return false;
  watchOnly.add(clean);
  return true;
}

/**
 * Lock: clear every plaintext key from module memory. The tab's ENCRYPTED
 * blob stays — entering the passphrase again restores the signers (this is
 * the state a page reload naturally lands in).
 */
export function lockVault(): void {
  memoryKeys.clear();
  aesKey = null;
  cachedSalt = null;
}

/**
 * Wipe: lock AND destroy the tab's encrypted blob. Immediate, no undo —
 * the only way back is importing the secret again.
 */
export function wipeVault(): void {
  lockVault();
  watchOnly.clear();
  activeStorage()?.removeItem(STORAGE_KEY);
}

/**
 * Remove ONE signer from the vault: memory entry dropped immediately, the
 * encrypted blob re-written without it. Requires the vault to be unlocked
 * (the same session that armed the signer manages it).
 */
export function removeFromVault(address: string): boolean {
  const mapKey = normalizeAddress(address);
  if (!memoryKeys.has(mapKey)) return false;
  memoryKeys.delete(mapKey);
  const blob = readBlob();
  if (blob && blob.wallets[mapKey]) {
    delete blob.wallets[mapKey];
    if (Object.keys(blob.wallets).length === 0) {
      activeStorage()?.removeItem(STORAGE_KEY);
      aesKey = null;
      cachedSalt = null;
    } else {
      writeBlob(blob);
    }
  }
  return true;
}

export interface RecoveryEntry {
  address: string;
  /** 0x-prefixed 32-byte private key — the importable form. */
  privateKey: `0x${string}`;
  via: "privateKey" | "mnemonic";
  /** Derivation path when the import was a mnemonic (best-effort record). */
  path?: string;
}

/**
 * Recovery sheet — exports EVERY vaulted key in plaintext AFTER the
 * passphrase is re-verified (PBKDF2 re-derivation, real gate). This is the
 * operator's own cold-backup escape hatch: without it, a wiped tab takes
 * the keys with it. Honest limitation, stated in the sheet: mnemonic
 * imports are vaulted as their DERIVED secp256k1 key — the original word
 * list was never persisted and cannot be reconstructed; back it up
 * separately.
 */
export async function exportRecoverySheet(
  passphrase: string,
): Promise<{ ok: true; entries: RecoveryEntry[]; text: string } | { ok: false; error: string }> {
  const blob = readBlob();
  if (!blob || Object.keys(blob.wallets).length === 0) {
    return { ok: false, error: "No vault exists in this tab — nothing to recover." };
  }
  const key = await deriveAesKey(passphrase, b64decode(blob.salt));
  const entries: RecoveryEntry[] = [];
  for (const [mapKey, entry] of Object.entries(blob.wallets)) {
    try {
      const bytes = await decryptSecret(key, entry);
      const pk = bytesToHex(bytes);
      const account = privateKeyToAccount(pk);
      entries.push({ address: account.address, privateKey: pk, via: "privateKey" });
      void mapKey;
    } catch {
      return { ok: false, error: "Wrong session passphrase — the sheet was NOT generated." };
    }
  }
  if (entries.length === 0) {
    return { ok: false, error: "Vault decrypt failed — nothing exported." };
  }
  const stamp = new Date().toISOString();
  const lines: string[] = [
    "FLASHBOLT · EVM VAULT RECOVERY SHEET",
    `generated: ${stamp}`,
    "════════════════════════════════════════════════════════════",
    "Treat this file like cash. Anyone holding these keys holds the",
    "funds. Store offline; never paste into any website or chat.",
    "",
    "NOTE: mnemonic imports are vaulted as their DERIVED secp256k1",
    "key (hex below). The original word list was never stored — keep",
    "your seed phrase backed up separately.",
    "",
  ];
  entries.forEach((e, i) => {
    lines.push(`— wallet ${i + 1} —`);
    lines.push(`address:     ${e.address}`);
    lines.push(`private key: ${e.privateKey}`);
    lines.push("");
  });
  return { ok: true, entries, text: lines.join("\n") };
}

/**
 * The vault's REAL signing key for an imported wallet: the raw 0x private
 * key handed to the swap executor's hot-wallet path (viem signs locally —
 * no extension, no prompt). Returns null while locked (the caller must
 * fall back to the injected wallet honestly).
 *
 * `address` matches case-insensitively; omit it to take the single vaulted
 * signer (or an arbitrary one when several are loaded).
 */
export function getVaultPrivateKey(address?: string): `0x${string}` | null {
  if (memoryKeys.size === 0) return null;
  if (address) {
    const key = memoryKeys.get(normalizeAddress(address));
    return key ?? null;
  }
  return memoryKeys.values().next().value ?? null;
}

/**
 * Resolve the vault's hot-wallet object for `resolveSignerFor`: the EXACT
 * shape the BNB live-execution seam already consumes. Null while locked —
 * never a fabricated signer.
 */
export function getVaultHotWallet(): { privateKey: `0x${string}`; address: string } | null {
  const pk = getVaultPrivateKey();
  if (!pk) return null;
  return { privateKey: pk, address: privateKeyToAccount(pk).address };
}

/**
 * A typed view of the vault signer for UI rows (checksummed address only —
 * the private key never crosses this boundary).
 */
export function getVaultSignerView(): { address: string; type: "hot" } | null {
  const hw = getVaultHotWallet();
  return hw ? { address: hw.address, type: "hot" } : null;
}

/** Hex convenience re-export for callers composing calldata around the vault. */
export type { Hex };
