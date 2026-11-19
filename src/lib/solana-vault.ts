/**
 * Solana session vault — imported wallets, cryptographically sealed.
 *
 * Threat model, honestly stated:
 *  • The pasted secret (mnemonic / private key) is validated and derived
 *    LOCALLY by solana-import.ts (BIP39 + SLIP-0010 ed25519) — it is never
 *    logged, never sent to any server, and never written to disk in the
 *    clear.
 *  • At rest (between React re-mounts in the SAME browser tab) only
 *    AES-256-GCM ciphertext lives in sessionStorage. The AES key is derived
 *    from the operator's session passphrase with PBKDF2-SHA-256 (310k
 *    iterations) and kept ONLY in module memory — never persisted.
 *  • When the tab closes, sessionStorage dies with it: the operator
 *    re-enters the passphrase next session. `Lock` wipes memory + storage
 *    immediately.
 *  • Signing uses the in-memory Keypair directly (@noble/secp256k1-grade
 *    ed25519 via @solana/web3.js) — no extension round-trip, no prompt: the
 *    fastest real signing path a browser can offer. Network I/O (Jupiter
 *    quotes, RPC broadcast, confirmation) is NOT sub-millisecond; the
 *    sub-millisecond claim covers signer resolution + local signing only.
 *
 * Watch-only imports (public keys) never enter the vault: there is no
 * secret to encrypt and no signature possible — they persist as plain
 * addresses in the terminal state and are reported honestly.
 */
import { importSolWallet } from "./solana-import";
import type { SolSigningProvider } from "./solana-live-execution";

const STORAGE_KEY = "fb.solVault.v1";
const PBKDF2_ITERATIONS = 310_000;

interface VaultEntry {
  iv: string; // base64 AES-GCM IV (12 bytes)
  ct: string; // base64 ciphertext of the 64-byte secret key
}

interface VaultBlob {
  v: 1;
  salt: string; // base64 PBKDF2 salt (16 bytes)
  wallets: Record<string, VaultEntry>; // base58 address → entry
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
const memorySecrets = new Map<string, Uint8Array>(); // address → 64-byte secret
const watchOnly = new Set<string>(); // addresses imported without a secret

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

/** True when the vault holds decrypted secrets in memory (unlocked state). */
export function vaultUnlocked(): boolean {
  return aesKey !== null && memorySecrets.size > 0;
}

/** Addresses currently held as LIVE signers in memory. */
export function vaultSignerAddresses(): string[] {
  return [...memorySecrets.keys()];
}

/** Watch-only (public key) addresses registered this session. */
export function vaultWatchOnlyAddresses(): string[] {
  return [...watchOnly];
}

/** Whether ANY encrypted vault blob exists for this tab (locked or not). */
export function vaultExists(): boolean {
  return readBlob() !== null || memorySecrets.size > 0;
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
  memorySecrets.clear();
  for (const [address, entry] of Object.entries(blob.wallets)) {
    try {
      memorySecrets.set(address, await decryptSecret(key, entry));
    } catch {
      // single corrupt entry — skip it, the rest still load
    }
  }
  return memorySecrets.size > 0;
}

/**
 * Import a secret (mnemonic / private key) into the vault under the session
 * passphrase. Validates + derives locally first; on success the secret is
 * AES-encrypted into the tab's blob AND cached in memory for signing.
 * Returns the derived public address.
 */
export async function importToVault(
  secretInput: string,
  passphrase: string,
): Promise<{ address: string; via: "secretKey" | "mnemonic"; path?: string }> {
  const wallet = importSolWallet(secretInput); // throws SolImportError on bad input
  const secret = (() => {
    // Decode the already-validated base58 payload with bigint (64 bytes ≈
    // 88 chars — trivial cost) back into the raw 64-byte secret.
    const bs58Chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const ch of wallet.secretKeyBs58) {
      n = n * 58n + BigInt(bs58Chars.indexOf(ch));
    }
    const bytes = new Uint8Array(64);
    let i = 63;
    while (n > 0n && i >= 0) {
      bytes[i] = Number(n % 256n);
      n /= 256n;
      i -= 1;
    }
    return bytes;
  })();

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
  }

  blob.wallets[wallet.address] = await encryptSecret(key, secret);
  writeBlob(blob);
  aesKey = key;
  memorySecrets.set(wallet.address, secret);
  return { address: wallet.address, via: wallet.via, path: wallet.path };
}

/** Register a watch-only (public key) address — tracked, never signable. */
export function addWatchOnlyAddress(address: string): boolean {
  const clean = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return false;
  watchOnly.add(clean);
  return true;
}

/**
 * Lock: clear every plaintext secret and key from module memory. The
 * tab's ENCRYPTED blob stays — entering the passphrase again restores the
 * signers (this is the state a page reload naturally lands in).
 */
export function lockVault(): void {
  memorySecrets.clear();
  aesKey = null;
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
  if (!memorySecrets.has(address)) return false;
  memorySecrets.delete(address);
  const blob = readBlob();
  if (blob && blob.wallets[address]) {
    delete blob.wallets[address];
    if (Object.keys(blob.wallets).length === 0) {
      activeStorage()?.removeItem(STORAGE_KEY);
      aesKey = null;
    } else {
      writeBlob(blob);
    }
  }
  return true;
}

export interface RecoveryEntry {
  address: string;
  /** base58 64-byte secret key (seed || pub) — the importable form. */
  secretKeyBs58: string;
  via: "secretKey" | "mnemonic";
  /** Derivation path when the import was a mnemonic (best-effort record). */
  path?: string;
}

/**
 * Recovery sheet — exports EVERY vaulted secret in plaintext AFTER the
 * passphrase is re-verified (PBKDF2 re-derivation, real gate). This is the
 * operator's own cold-backup escape hatch: without it, a wiped tab takes
 * the keys with it. Honest limitation, stated in the sheet: mnemonic
 * imports are stored as their DERIVED ed25519 key — the original word list
 * was never persisted and cannot be reconstructed; back it up separately.
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
  for (const [address, entry] of Object.entries(blob.wallets)) {
    try {
      const secret = await decryptSecret(key, entry);
      entries.push({
        address,
        secretKeyBs58: encodeBs58(secret),
        via: "secretKey",
      });
    } catch {
      return { ok: false, error: "Wrong session passphrase — the sheet was NOT generated." };
    }
  }
  if (entries.length === 0) {
    return { ok: false, error: "Vault decrypt failed — nothing exported." };
  }
  const stamp = new Date().toISOString();
  const lines: string[] = [
    "FLASHBOLT · SOLANA VAULT RECOVERY SHEET",
    `generated: ${stamp}`,
    "════════════════════════════════════════════════════════════",
    "Treat this file like cash. Anyone holding these keys holds the",
    "funds. Store offline; never paste into any website or chat.",
    "",
    "NOTE: mnemonic imports are vaulted as their DERIVED ed25519 key",
    "(base58 below). The original word list was never stored — keep",
    "your seed phrase backed up separately.",
    "",
  ];
  entries.forEach((e, i) => {
    lines.push(`— wallet ${i + 1} —`);
    lines.push(`address:     ${e.address}`);
    lines.push(`private key: ${e.secretKeyBs58}`);
    lines.push("");
  });
  return { ok: true, entries, text: lines.join("\n") };
}

/** base58 encoder shared by the recovery sheet (matches the importer's codec). */
function encodeBs58(bytes: Uint8Array): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = chars[Number(n % 58n)] + out;
    n /= 58n;
  }
  // leading zero bytes → leading "1"s (base58 convention)
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * Programs the in-memory signer will sign for. The vault has no wallet
 * confirmation dialog, so the transaction it is handed must be one a FlashBolt
 * route can actually need: a DEX aggregator swap, SPL token movement and the
 * compute/system/tip bookkeeping around it. Anything else is refused by name
 * instead of being signed blindly.
 */
export const VAULT_ALLOWED_PROGRAMS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter aggregator v6",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  "11111111111111111111111111111111": "System (transfer only)",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};

/** The only System instruction the vault signs: `transfer` (u32 LE index 2). */
const SYSTEM_TRANSFER_IX = 2;

export interface VaultSignerInstruction {
  programId: string;
  data?: Uint8Array | null;
}

export type VaultSignerVerdict = { ok: true } | { ok: false; error: string };

function systemInstructionIndex(data?: Uint8Array | null): number {
  if (!data || data.length < 4) return -1;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

/**
 * Pure gate the in-memory signer applies before touching the key:
 *  • the fee payer must be the vaulted address (no paying for someone else's
 *    transaction),
 *  • every program must be allowlisted above,
 *  • System instructions are limited to `transfer` (a tip), so an `assign` or
 *    authority-changing instruction is never signed silently.
 */
export function vaultSignerVerdict(opts: {
  signer: string;
  feePayer: string | null;
  instructions: VaultSignerInstruction[];
}): VaultSignerVerdict {
  if (!opts.feePayer) return { ok: false, error: "transaction has no fee payer" };
  if (opts.feePayer !== opts.signer) {
    return {
      ok: false,
      error: `fee payer ${opts.feePayer} is not the vault signer ${opts.signer}`,
    };
  }
  for (const ix of opts.instructions) {
    const label = VAULT_ALLOWED_PROGRAMS[ix.programId];
    if (!label) {
      return {
        ok: false,
        error: `program ${ix.programId} is not on the vault's approved list`,
      };
    }
    if (ix.programId === "11111111111111111111111111111111") {
      const index = systemInstructionIndex(ix.data);
      if (index !== SYSTEM_TRANSFER_IX) {
        return {
          ok: false,
          error: `System instruction #${index} is not a transfer — the vault only signs a tip transfer`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * The vault's REAL signing provider for an imported wallet: an in-memory
 * Keypair signing synchronously — no extension, no prompt. Returns null
 * while locked (the caller must fall back to the injected wallet honestly).
 */
export function getVaultSigner(address?: string): SolSigningProvider | null {
  const pick = address ?? memorySecrets.keys().next().value;
  if (!pick) return null;
  const secret = memorySecrets.get(pick);
  if (!secret) return null;
  return makeKeypairSigner(pick, secret);
}

/** Build a SolSigningProvider over raw 64-byte secret bytes. */
export function makeKeypairSigner(address: string, secret64: Uint8Array): SolSigningProvider {
  const publicKey = { toString: () => address };
  return {
    publicKey,
    async signTransaction(tx: unknown): Promise<unknown> {
      // Import lazily so the vault also works in pure-logic tests.
      const { Keypair, VersionedTransaction, Transaction } = await import("@solana/web3.js");
      const keypair = Keypair.fromSecretKey(secret64);
      if (tx instanceof VersionedTransaction) {
        const msg = tx.message;
        const feePayer = msg.staticAccountKeys[0]?.toBase58() ?? null;
        const instructions = msg.compiledInstructions.map((ix) => ({
          programId: msg.staticAccountKeys[ix.programIdIndex]!.toBase58(),
          data: ix.data,
        }));
        const verdict = vaultSignerVerdict({ signer: address, feePayer, instructions });
        if (!verdict.ok) throw new Error(`Vault signer refused: ${verdict.error}`);
        tx.sign([keypair]); // real ed25519 signature, in-process
        return tx;
      }
      if (tx instanceof Transaction) {
        const verdict = vaultSignerVerdict({
          signer: address,
          feePayer: tx.feePayer?.toBase58() ?? null,
          instructions: tx.instructions.map((ix) => ({
            programId: ix.programId.toBase58(),
            data: ix.data,
          })),
        });
        if (!verdict.ok) throw new Error(`Vault signer refused: ${verdict.error}`);
        tx.partialSign(keypair);
        return tx;
      }
      throw new Error("Unsupported transaction type for vault signing.");
    },
  };
}
