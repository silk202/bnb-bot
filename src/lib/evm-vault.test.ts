import { describe, expect, test, beforeEach } from "bun:test";
import {
  addWatchOnlyAddress,
  importToVault,
  lockVault,
  setVaultStorage,
  unlockVault,
  vaultExists,
  vaultSignerAddresses,
  vaultUnlocked,
  vaultWatchOnlyAddresses,
  removeFromVault,
  exportRecoverySheet,
  wipeVault,
  getVaultPrivateKey,
  getVaultHotWallet,
} from "./evm-vault";
import { privateKeyToAccount } from "viem/accounts";
import { looksLikeMnemonic, looksLikePrivateKey, connectEvmChain } from "./evm-import";

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
  has(key: string): boolean {
    return this.map.has(key);
  }
  getRaw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

// Real, well-formed test vectors. The private key is a canonical test key
// (its address is deterministic); the mnemonic is the famous BIP39 test
// vector — valid words, valid checksum, well-known first account.
const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const MNEMONIC = "test test test test test test test test test test test junk";

beforeEach(() => {
  setVaultStorage(new MemStorage());
  lockVault();
});

describe("evm import classifiers", () => {
  test("mnemonic vs private key detection", () => {
    expect(looksLikeMnemonic(MNEMONIC)).toBe(true);
    expect(looksLikePrivateKey(TEST_PK)).toBe(true);
    expect(looksLikePrivateKey(TEST_PK.slice(2))).toBe(true);
    expect(looksLikeMnemonic(TEST_PK)).toBe(false);
    expect(looksLikePrivateKey(MNEMONIC)).toBe(false);
    expect(looksLikePrivateKey("0x1234")).toBe(false);
  });
});

describe("evm vault", () => {
  test("import seals a key and unlocks it back to memory", async () => {
    const { address } = await importToVault(TEST_PK, "op-passphrase");
    expect(address.toLowerCase()).toBe(privateKeyToAccount(TEST_PK).address.toLowerCase());
    expect(vaultUnlocked()).toBe(true);
    expect(vaultSignerAddresses()).toContain(privateKeyToAccount(TEST_PK).address);
    // Ciphertext is on the fake storage; plaintext must NOT be.
    const raw = (setVaultStorage as unknown as { storageOverride: { getRaw(k: string): string } }).storageOverride;
    void raw; // storage content checked via vaultExists + absence of plaintext below
    expect(vaultExists()).toBe(true);
  });

  test("ciphertext in storage never contains the private key material", async () => {
    const mem = new MemStorage();
    setVaultStorage(mem);
    lockVault();
    await importToVault(TEST_PK, "pass");
    const blob = mem.getRaw("fb.evmVault.v1") ?? "";
    // The SECRET must never appear — bare hex, 0x-prefixed, or in ciphertext.
    expect(blob).not.toContain(TEST_PK.slice(2));
    expect(blob).not.toContain(TEST_PK);
    // Addresses are PUBLIC identifiers (they are the map keys, same as the
    // SOL vault) — only the key material is encrypted, which is verified by
    // the recovery-sheet round-trip test below.
    expect(blob.length).toBeGreaterThan(50); // real ciphertext present
    expect(blob).toContain("iv");
  });

  test("lock wipes memory; unlock restores signers with the right passphrase", async () => {
    const { address } = await importToVault(TEST_PK, "op-passphrase");
    expect(vaultUnlocked()).toBe(true);
    lockVault();
    expect(vaultUnlocked()).toBe(false);
    expect(getVaultPrivateKey()).toBeNull();
    expect(getVaultHotWallet()).toBeNull();
    // Wrong passphrase refused — vault stays sealed.
    expect(await unlockVault("wrong")).toBe(false);
    expect(vaultUnlocked()).toBe(false);
    // Right passphrase restores.
    expect(await unlockVault("op-passphrase")).toBe(true);
    expect(getVaultPrivateKey()).not.toBeNull();
    expect(vaultSignerAddresses()).toContain(address);
  });

  test("mnemonic import derives the canonical BIP44 first account", async () => {
    const { address, via, path } = await importToVault(MNEMONIC, "op-passphrase");
    expect(via).toBe("mnemonic");
    expect(path).toContain("m/44'/60'");
    // This is the well-known first account of the BIP39 test vector.
    expect(address.toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  test("importing the same key twice is idempotent", async () => {
    await importToVault(TEST_PK, "pass");
    const second = await importToVault(`  ${TEST_PK}  `, "pass");
    expect(vaultSignerAddresses().length).toBe(1);
    expect(second.address.toLowerCase()).toBe(privateKeyToAccount(TEST_PK).address.toLowerCase());
  });

  test("wrong passphrase on a sealed vault refuses the import", async () => {
    await importToVault(TEST_PK, "pass-one");
    await expect(importToVault(MNEMONIC, "pass-two")).rejects.toThrow(/Wrong session passphrase/);
    expect(vaultSignerAddresses().length).toBe(1);
  });

  test("removeFromVault drops one signer; wipe destroys the blob", async () => {
    const a = await importToVault(TEST_PK, "pass");
    const b = await importToVault(MNEMONIC, "pass");
    expect(vaultSignerAddresses().length).toBe(2);
    expect(removeFromVault(b.address)).toBe(true);
    expect(vaultSignerAddresses().length).toBe(1);
    expect(removeFromVault("0x0000000000000000000000000000000000000000")).toBe(false);
    lockVault();
    // Vault still exists (encrypted blob) — unlock brings the survivor back.
    expect(await unlockVault("pass")).toBe(true);
    expect(vaultSignerAddresses()).toContain(a.address);
    wipeVault();
    expect(vaultExists()).toBe(false);
    expect(await unlockVault("pass")).toBe(false);
  });

  test("watch-only addresses register but never sign", () => {
    const addr = "0x1234567890AbcdEF1234567890aBcdef12345678";
    expect(addWatchOnlyAddress(addr)).toBe(true);
    expect(addWatchOnlyAddress("0x1234")).toBe(false);
    expect(vaultWatchOnlyAddresses()).toContain(addr);
    expect(getVaultPrivateKey()).toBeNull();
    expect(getVaultHotWallet()).toBeNull();
  });

  test("recovery sheet requires the real passphrase and exports importable keys", async () => {
    await importToVault(TEST_PK, "op-pass");
    await importToVault(MNEMONIC, "op-pass");
    const bad = await exportRecoverySheet("wrong-pass");
    expect(bad.ok).toBe(false);
    const good = await exportRecoverySheet("op-pass");
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.entries.length).toBe(2);
      const mn = good.entries.find((e) => e.address.toLowerCase() === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
      expect(mn?.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
      // The exported key re-imports to the SAME address (round-trip).
      const reimported = privateKeyToAccount(mn!.privateKey).address.toLowerCase();
      expect(reimported).toBe(mn!.address.toLowerCase());
      expect(good.text).toContain("RECOVERY SHEET");
      expect(good.text).not.toContain(MNEMONIC); // the words were never stored
    }
  });

  test("invalid input throws and stores nothing", async () => {
    await expect(importToVault("not a valid key", "pass")).rejects.toThrow();
    await expect(importToVault("test test bad mnemonic", "pass")).rejects.toThrow();
    expect(vaultExists()).toBe(false);
    expect(vaultUnlocked()).toBe(false);
  });
});

describe("connectEvmChain (live RPC check)", () => {
  test("refuses a non-JSON-RPC endpoint honestly", async () => {
    const status = await connectEvmChain("mainnet", "https://example.com");
    expect(status.connected).toBe(false);
    expect(status.error).toBeTruthy();
  });
});
