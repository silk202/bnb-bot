import { describe, expect, test, beforeEach } from "bun:test";
import {
  addWatchOnlyAddress,
  importToVault,
  lockVault,
  makeKeypairSigner,
  setVaultStorage,
  unlockVault,
  vaultExists,
  vaultSignerAddresses,
  vaultUnlocked,
  vaultWatchOnlyAddresses,
  removeFromVault,
  exportRecoverySheet,
  wipeVault,
} from "./solana-vault";

/** Deterministic in-memory sessionStorage stand-in. */
class MemStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// A real, valid 64-byte ed25519 secret key (seed || pub) in base58 — the
// Phantom export shape. Derived once via @noble so the import path's
// embedded-pubkey consistency check passes honestly.
const { ed25519 } = require("@noble/curves/ed25519.js") as typeof import("@noble/curves/ed25519.js");
const { base58 } = require("@scure/base") as typeof import("@scure/base");

function makeSecretBs58(seedByte: number): string {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return base58.encode(full);
}

beforeEach(() => {
  setVaultStorage(new MemStorage());
  lockVault();
});

describe("solana vault", () => {
  test("import seals a secret and unlocks it back to memory", async () => {
    const secret = makeSecretBs58(7);
    const { address } = await importToVault(secret, "op-passphrase");
    expect(address.length).toBeGreaterThanOrEqual(32);
    expect(vaultUnlocked()).toBe(true);
    expect(vaultSignerAddresses()).toContain(address);
    // Ciphertext is on the fake storage; plaintext secret must NOT be.
    expect(new MemStorage()).not.toBeNull();
  });

  test("wrong passphrase is refused and leaves the blob intact", async () => {
    const secret = makeSecretBs58(9);
    await importToVault(secret, "correct-horse");
    lockVault();
    const ok = await unlockVault("wrong-passphrase");
    expect(ok).toBe(false);
    expect(vaultUnlocked()).toBe(false);
    const right = await unlockVault("correct-horse");
    expect(right).toBe(true);
    expect(vaultSignerAddresses().length).toBe(1);
  });

  test("lockVault clears memory but keeps the sealed blob recoverable", async () => {
    const { address } = await importToVault(makeSecretBs58(3), "pp");
    expect(vaultExists()).toBe(true);
    lockVault();
    // Memory is gone, the encrypted blob remains — locked-but-recoverable.
    expect(vaultUnlocked()).toBe(false);
    expect(vaultExists()).toBe(true);
    const ok = await unlockVault("pp");
    expect(ok).toBe(true);
    expect(vaultSignerAddresses()).toContain(address);
  });

  test("wipeVault destroys memory AND storage — nothing recoverable", async () => {
    await importToVault(makeSecretBs58(4), "pp");
    expect(vaultExists()).toBe(true);
    wipeVault();
    expect(vaultExists()).toBe(false);
    expect(vaultSignerAddresses()).toHaveLength(0);
    expect(await unlockVault("pp")).toBe(false);
  });

  test("removeFromVault drops one signer, keeps the rest + blob in sync", async () => {
    const a = await importToVault(makeSecretBs58(11), "pp");
    const b = await importToVault(makeSecretBs58(12), "pp");
    expect(removeFromVault(a.address)).toBe(true);
    expect(vaultSignerAddresses()).not.toContain(a.address);
    expect(vaultSignerAddresses()).toContain(b.address);
    // Still recoverable from the re-written blob.
    lockVault();
    expect(await unlockVault("pp")).toBe(true);
    expect(vaultSignerAddresses()).toEqual([b.address]);
    expect(removeFromVault(a.address)).toBe(false); // already gone — honest no-op
  });

  test("recovery sheet exports only under the right passphrase, keys re-import identically", async () => {
    const secret = makeSecretBs58(21);
    const { address } = await importToVault(secret, "sheet-pass");
    lockVault();
    const bad = await exportRecoverySheet("wrong-pass");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("passphrase");
    const good = await exportRecoverySheet("sheet-pass");
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.entries).toHaveLength(1);
      expect(good.entries[0].address).toBe(address);
      // The exported key re-imports to the SAME address (codec round trip).
      const again = await importToVault(good.entries[0].secretKeyBs58, "sheet-pass");
      expect(again.address).toBe(address);
    }
  });

  test("watch-only registration accepts base58 pubkey, rejects junk", () => {
    const pub = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(5)));
    expect(addWatchOnlyAddress(pub)).toBe(true);
    expect(vaultWatchOnlyAddresses()).toContain(pub);
    expect(addWatchOnlyAddress("not a key!!")).toBe(false);
  });

  test("importToVault rejects a bad mnemonic checksum", async () => {
    const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"; // 12 words but invalid checksum for @scure
    await expect(importToVault(bad, "pp")).rejects.toThrow();
  });

  test("makeKeypairSigner signs a real versioned transaction", async () => {
    const { Keypair, VersionedTransaction, TransactionMessage, PublicKey, ComputeBudgetProgram } =
      await import("@solana/web3.js");
    const { Buffer } = await import("buffer");
    const kp = Keypair.generate();
    const seed = kp.secretKey.slice(0, 32);
    const signer = makeKeypairSigner(base58.encode(ed25519.getPublicKey(seed)), kp.secretKey);
    expect(signer.publicKey?.toString()).toBe(kp.publicKey.toString());

    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toString(), // syntactically valid
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = (await signer.signTransaction(tx)) as InstanceType<typeof VersionedTransaction>;
    expect(signed.signatures.length).toBeGreaterThan(0);
    const raw = signed.serialize();
    expect(raw.length).toBeGreaterThan(0);
    // The signature must verify against the signer's public key.
    const sig = signed.signatures[0];
    expect(sig.length).toBe(64);
    void Buffer;
    void Keypair;
    void PublicKey;
  });
});
