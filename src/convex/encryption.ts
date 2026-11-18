import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Cryptographically encrypt/decrypt backend secrets (the terminal operator's
 * credentials, subscriber passcodes) with AES-256-GCM using the WebCrypto API
 * — available in the Convex Node runtime, the V8 runtime and the browser.
 *
 * Either context shape works: mutations write the fallback key (gateKeys) and
 * queries only ever read it, so both runtimes share this code. The single
 * write path is cast explicitly below.
 *
 * Key hierarchy (first match wins):
 * 1. `GATE_ENC_KEY` env var (64 hex chars) — preferred, set it in Keys.
 * 2. A SHA-256 digest of `JWT_PRIVATE_KEY` — stable across restarts when the
 *    auth key is configured.
 * 3. A random 32-byte key generated once and stored server-side in the
 *    `gateKeys` table. Never returned by any query or mutation.
 *
 * Nothing about the secrets is ever exposed to the frontend — only ciphertext
 * strings live on the operatorConfig / subscribers documents.
 */

/** Minimal structural context — any Convex context with a database handle
 * (mutation, query or action) can encrypt/decrypt backend secrets. */
type SecretCtx = { db: MutationCtx["db"] | QueryCtx["db"] };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function fetchOrCreateKey(ctx: SecretCtx): Promise<CryptoKey> {
  const envHex = process.env.GATE_ENC_KEY?.trim();
  if (envHex && /^[0-9a-fA-F]{64}$/.test(envHex)) {
    return importRawKey(hexToBytes(envHex));
  }
  const jwtKey = process.env.JWT_PRIVATE_KEY;
  if (jwtKey && jwtKey.length >= 16) {
    const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(jwtKey));
    return importRawKey(new Uint8Array(digest));
  }
  const existing = await ctx.db.query("gateKeys").first();
  if (existing) return importRawKey(base64ToBytes(existing.key));
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Only reachable when no env key exists AND no gateKeys row exists — and
  // then only from a mutation (a query can never create keys).
  await (ctx.db as MutationCtx["db"]).insert("gateKeys", { key: bytesToBase64(bytes) });
  return importRawKey(bytes);
}

/** Encrypt a secret. Returns "ivBase64.ciphertextBase64" (GCM tag included). */
export async function encryptSecret(ctx: SecretCtx, plain: string): Promise<string> {
  const key = await fetchOrCreateKey(ctx);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plain),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypt a secret previously produced by {@link encryptSecret}. */
export async function decryptSecret(ctx: SecretCtx, cipher: string): Promise<string> {
  const parts = cipher.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Malformed encrypted secret");
  }
  const key = await fetchOrCreateKey(ctx);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parts[0]) as unknown as BufferSource },
    key,
    base64ToBytes(parts[1]) as unknown as BufferSource,
  );
  return textDecoder.decode(plain);
}
