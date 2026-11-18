/**
 * SOL FlashBolt — LIVE devnet drill of the exact production execution path.
 *
 * What this proves on REAL devnet (nothing mocked, nothing paper):
 *   1. The vault sealing a secret, re-locking, re-unlocking (real AES-GCM).
 *   2. An in-memory Keypair signing a real versioned transaction.
 *   3. A REAL airdrop → sendTransaction → getSignatureStatuses round trip on
 *      api.devnet.solana.com — the same postRpc/waitForSigConfirm path
 *      executeLiveArb/executeLiveSnipeBuy use in production.
 *   4. A real token-account query shape (getTokenAccountsByOwner) against
 *      the live RPC.
 *
 * Run:  bun scripts/devnet-drill.ts
 * Exit: 0 = every stage proved on the real cluster; 1 = a stage failed
 *       (the script prints exactly which stage and why — honest output).
 *
 * No app secrets are needed: the drill generates its own throwaway keypair
 * in memory, funds it with the devnet airdrop, and broadcasts only to
 * devnet. Mainnet is never touched.
 */

import { setVaultStorage, importToVault, lockVault, unlockVault, makeKeypairSigner, vaultSignerAddresses } from "../src/lib/solana-vault";
import { base58 } from "@scure/base";
import { SOL_RPC_ENDPOINTS } from "../src/lib/solana-jito";
import { solRpcCall, waitForSigConfirm, WSOL_MINT } from "../src/lib/solana-live-execution";

/** Minimal in-memory storage — the drill runs outside the browser. */
const mem = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
})();

async function stage(n: number, name: string, run: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const msg = await run();
    console.log(`  ✓ Stage ${n} · ${name} (${Date.now() - t0}ms) — ${msg}`);
    return true;
  } catch (e) {
    console.error(`  ✗ Stage ${n} · ${name} FAILED (${Date.now() - t0}ms): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main(): Promise<number> {
  const t0 = Date.now();
  console.log(`\n[devnet-drill] SOL FlashBolt live-path drill — ${new Date().toISOString()}`);
  console.log(`[devnet-drill] cluster: devnet (${SOL_RPC_ENDPOINTS.testnet})\n`);

  const results: boolean[] = [];

  // ── Stage 1 — vault: seal → lock → unlock (real WebCrypto AES-GCM) ──
  setVaultStorage(mem);
  const passphrase = "drill-passphrase-" + Math.random().toString(36).slice(2, 10);
  const { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey, TransactionInstruction, ComputeBudgetProgram } =
    await import("@solana/web3.js");
  // DETERMINISTIC drill key with HIGH entropy: a fixed seed keeps the same
  // address across re-runs (faucet grants persist), but human-guessable
  // constants (all-7s, 0x…42) are swept by devnet seed-sniper bots that
  // airdrop and wrap those accounts — so the seed is SHA-256 derived from a
  // FlashBolt-specific label: unguessable, yet identical on every re-run.
  // NEVER use a fixed low-entropy key anywhere near mainnet.
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const drillSeed = sha256(new TextEncoder().encode("flashbolt-devnet-drill-v1"));
  const drillKeypair = Keypair.fromSeed(drillSeed);
  const secretBs58 = base58.encode(new Uint8Array(drillKeypair.secretKey));
  results.push(await stage(1, "vault seal/lock/unlock (AES-256-GCM)", async () => {
    const { address } = await importToVault(secretBs58, passphrase);
    lockVault();
    const ok = await unlockVault(passphrase);
    if (!ok) throw new Error("unlock returned false");
    if (!vaultSignerAddresses().includes(address)) throw new Error("signer not in memory after unlock");
    return address.slice(0, 8) + "…";
  }));

  // ── Stage 2 — in-memory Keypair signs a real versioned tx ──
  const signerAddress = vaultSignerAddresses()[0];
  results.push(await stage(2, "in-memory ed25519 signing (sub-ms)", async () => {
    const { Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, PublicKey } = await import("@solana/web3.js");
    const owner = drillKeypair.publicKey.toBase58();
    // Recover the raw secret the same way the vault does (drill-local; the
    // app holds it in memory only).
    const bs58 = (await import("@scure/base")).base58;
    // The vault won't hand out secrets — rebuild a signer from the same
    // secret the drill generated above (base58 of 64-byte keypair).
    const secret64 = bs58.decode(secretBs58);
    const signer = makeKeypairSigner(owner, new Uint8Array(secret64));
    if (!signer.publicKey) throw new Error("signer has no public key");
    const msg = new TransactionMessage({
      payerKey: drillKeypair.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = (await signer.signTransaction(tx)) as InstanceType<typeof VersionedTransaction>;
    if (signed.signatures.length === 0) throw new Error("no signature produced");
    return `sig ${base58.encode(signed.signatures[0]).slice(0, 12)}…`;
  }));

  // ── Stage 3 — REAL airdrop → sendTransaction → confirm on devnet ──
  const RPC = SOL_RPC_ENDPOINTS.testnet;
  const ownerPk = drillKeypair.publicKey;
  if (ownerPk.toBase58() !== signerAddress) throw new Error("drill keypair ≠ vault signer — abort");
  console.log(`[devnet-drill] drill address (deterministic, devnet-only): ${ownerPk.toBase58()}`);

  let funded = false;
  results.push(await stage(3, "devnet funding (real SOL)", async () => {
    // Path A — the cluster's built-in airdrop.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const sig = await solRpcCall<string>(RPC, "requestAirdrop", [ownerPk.toBase58(), 500_000_000]);
        const c = await waitForSigConfirm(sig, RPC, 45_000);
        if (c.confirmed) {
          funded = true;
          return "0.5 SOL airdropped + confirmed";
        }
      } catch {
        // fall through to path B
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    // Path B — the public faucet.solana.com API (real HTTP funding service).
    try {
      const { fetchWithTimeout } = await import("../src/lib/fetch-timeout");
      const res = await fetchWithTimeout("https://faucet.solana.com/api/request-airdrop", 20_000, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: ownerPk.toBase58(), amount: 500_000_000 }),
      });
      const json = (await res.json()) as { error?: unknown };
      if (!json.error) {
        // The faucet returns the tx for its own send — poll our balance.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3_000));
          const bal = await solRpcCall<{ value: number }>(RPC, "getBalance", [ownerPk.toBase58()]);
          if (bal.value > 0) {
            funded = true;
            return `${(bal.value / 1_000_000_000).toFixed(3)} SOL via faucet.solana.com`;
          }
        }
      }
    } catch {
      // honest failure below
    }
    const bal = await solRpcCall<{ value: number }>(RPC, "getBalance", [ownerPk.toBase58()]);
    if (bal.value >= 50_000_000) {
      // Hijack guard: the account must be SYSTEM-owned to sign or pay fees.
      // Seed-sniper bots wrap hunted low-entropy keys into SPL token
      // accounts — those hold lamports but can never be a tx fee payer.
      const info = await solRpcCall<{ value: { owner: string } | null }>(RPC, "getAccountInfo", [
        ownerPk.toBase58(),
        { encoding: "base64" },
      ]);
      const ownerProgram = info.value?.owner ?? "11111111111111111111111111111111";
      if (ownerProgram !== "11111111111111111111111111111111") {
        throw new Error(
          `drill address is owned by ${ownerProgram.slice(0, 12)}… (hunted/wrapped key) — regenerate the drill seed label`,
        );
      }
      funded = true;
      return `pre-funded: ${(bal.value / 1_000_000_000).toFixed(3)} SOL`;
    }
    throw new Error("both funding paths refused (daily faucet limit)");
  }));

  if (!funded) {
    console.error("\n[devnet-drill] ✗ Cannot continue — devnet faucet refused funding (rate limit?).");
    console.error("[devnet-drill]   Fund the drill address manually and re-run:");
    console.error(`[devnet-drill]   ${ownerPk.toBase58()}`);
    return 1;
  }

  // ── Stage 4 — REAL broadcast: sendTransaction + on-chain confirmation ──
  results.push(await stage(4, "sendTransaction → on-chain confirmation", async () => {
    const { fetchWithTimeout } = await import("../src/lib/fetch-timeout");
    // Latest blockhash + lastValidBlockHeight — the real preflight.
    // (JSON-RPC nests the payload under .value — read it there.)
    const bh = await solRpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>(RPC, "getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: ownerPk,
        recentBlockhash: bh.value.blockhash,
        instructions: [
          SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: ownerPk, lamports: 1_000 }),
          new TransactionInstruction({
            keys: [{ pubkey: ownerPk, isSigner: true, isWritable: true }],
            programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), // SPL Memo
            data: Buffer.from("flashbolt-devnet-drill"),
          }),
        ],
      }).compileToV0Message(),
    );
    tx.sign([drillKeypair]);
    const wire = Buffer.from(tx.serialize()).toString("base64");
    const res = await fetchWithTimeout(RPC, 15_000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wire, { encoding: "base64" }] }),
    });
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error("sendTransaction rejected: " + (json.error.message ?? "unknown"));
    const sig = json.result as string;
    const c = await waitForSigConfirm(sig, RPC, 60_000);
    if (!c.confirmed) throw new Error("did not confirm: " + (c.err ?? "timeout"));
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }));

  // ── Stage 5 — REAL token-account query shape (as the sell leg uses) ──
  results.push(await stage(5, "getTokenAccountsByOwner (live RPC)", async () => {
    const json = await solRpcCall<{ value: unknown[] }>(RPC, "getTokenAccountsByOwner", [
      ownerPk.toBase58(),
      { mint: WSOL_MINT },
      { encoding: "jsonParsed" },
    ]);
    return `${json.value?.length ?? 0} wSOL account(s) — query shape verified live`;
  }));

  const passed = results.filter(Boolean).length;
  console.log(`\n[devnet-drill] ══ VERDICT: ${passed}/${results.length} stages passed on REAL devnet in ${Date.now() - t0}ms ══`);
  return passed === results.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[devnet-drill] FATAL:", err);
    process.exit(1);
  });
