/**
 * BNB FlashBolt — LIVE BSC-testnet drill of the exact production EVM path.
 *
 * What this proves on the REAL BSC testnet (nothing mocked, nothing paper):
 *   1. The EVM vault sealing a key, re-locking, re-unlocking (real AES-GCM),
 *      recovering the exact address the vault would hand to the signer seam.
 *   2. An in-memory viem account signing a real legacy transaction locally.
 *   3. Real funding: a BSC testnet faucet POST for the drill address
 *      (honest refusal with the address when every faucet is exhausted —
 *      pre-funded addresses are detected and used).
 *   4. A REAL eth_sendRawTransaction → eth_getTransactionReceipt round trip
 *      through sendSignedTransaction — the same function the Scanner
 *      flasher, Sniper buys/sells/payouts and withdrawals use in production.
 *
 * Run:  bun scripts/evm-drill.ts   (or: bun run drill:evm)
 * Exit: 0 = every stage proved on the real network; 1 = a stage failed
 *       (the script prints exactly which stage and why — honest output).
 *
 * No app secrets are needed: the drill generates its own throwaway key in
 * memory and broadcasts only to BSC testnet. Mainnet is never touched.
 */

import { setVaultStorage, importToVault, lockVault, unlockVault, getVaultHotWallet, vaultSignerAddresses } from "../src/lib/evm-vault";
import { BNB_NETWORKS } from "../src/lib/chain";
import { sendSignedTransaction, waitForRpcReceipt, buyToken, resolveSignerFor } from "../src/lib/swap-executor";
import { executionEnvFor } from "../src/lib/chains";

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
  console.log(`\n[evm-drill] BNB FlashBolt live-path drill — ${new Date().toISOString()}`);
  console.log(`[evm-drill] network: BSC testnet (${BNB_NETWORKS.testnet.rpc})\n`);

  const results: boolean[] = [];

  // ── Stage 1 — EVM vault: seal → lock → unlock (real WebCrypto AES-GCM) ──
  setVaultStorage(mem);
  const passphrase = "evm-drill-" + Math.random().toString(36).slice(2, 10);
  // DETERMINISTIC drill key with HIGH entropy: a fixed key keeps the same
  // address across re-runs so faucet grants persist, but human-guessable
  // constants (0x…42 and friends) are hunted by seed-sniper bots that fund
  // and wrap those accounts — so the key is SHA-256 derived from a
  // FlashBolt-specific label: unguessable, yet identical on every re-run.
  // NEVER use a fixed low-entropy key anywhere near mainnet.
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const drillSeed = sha256(new TextEncoder().encode("flashbolt-evm-drill-v1"));
  const drillPk = ("0x" + Buffer.from(drillSeed.slice(0, 32)).toString("hex")) as `0x${string}`;
  let vaultAddress = "";
  results.push(await stage(1, "EVM vault seal/lock/unlock (AES-256-GCM)", async () => {
    const { address } = await importToVault(drillPk, passphrase);
    vaultAddress = address;
    lockVault();
    const ok = await unlockVault(passphrase);
    if (!ok) throw new Error("unlock returned false");
    if (!vaultSignerAddresses().includes(address)) throw new Error("signer not in memory after unlock");
    const hw = getVaultHotWallet();
    if (!hw || hw.address !== address) throw new Error("vault hot-wallet seam did not resolve the signer");
    return address.slice(0, 10) + "…";
  }));

  const signer = getVaultHotWallet();
  if (!signer || signer.address !== vaultAddress) {
    console.error("\n[evm-drill] ✗ vault seam unusable — aborting before any network call.");
    return 1;
  }

  // ── Stage 2 — in-memory secp256k1 signing (viem, local, sub-ms) ──
  results.push(await stage(2, "in-memory secp256k1 signing (viem)", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(signer.privateKey);
    const signed = await account.signTransaction({
      type: "legacy",
      chainId: BNB_NETWORKS.testnet.chainId,
      to: signer.address,
      value: 0n,
      data: "0x",
      gas: 21_000n,
      gasPrice: 10_000_000_000n,
      nonce: 0,
    });
    // viem returns the SERIALIZED signed tx (RLP with 65-byte r||s||v). It
    // must be a real hex blob far longer than an unsigned tx, and the
    // signature must recover to exactly the vault signer's address.
    if (!/^0x[0-9a-fA-F]+$/.test(signed) || signed.length < 200) {
      throw new Error("signed tx is not a serialized signature blob");
    }
    const { recoverTransactionAddress } = await import("viem");
    const recovered = await recoverTransactionAddress({ serializedTransaction: signed });
    if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`signature recovers to ${recovered}, not ${signer.address}`);
    }
    return `sig ${signed.slice(0, 14)}… recovers to ${recovered.slice(0, 8)}…`;
  }));

  // ── Stage 3 — REAL testnet funding for the drill address ──
  const RPC = BNB_NETWORKS.testnet.rpc;
  const CHAIN_ID = BNB_NETWORKS.testnet.chainId;
  const owner = signer.address;
  console.log(`[evm-drill] drill address (deterministic, testnet-only): ${owner}`);
  let funded = false;
  results.push(await stage(3, "BSC testnet funding (real testBNB)", async () => {
    // Pre-funded? (re-run support — the address is deterministic per run)
    const { fetchWithTimeout } = await import("../src/lib/fetch-timeout");
    const probe = await fetchWithTimeout(RPC, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [owner, "latest"] }),
    });
    const probeJson = (await probe.json()) as { result?: string };
    const startWei = BigInt(probeJson.result ?? "0x0");
    if (startWei >= 50_000_000_000_000n) {
      // Hijack guard (same as the SOL drill): hunted keys get wrapped or
      // replaced by contracts that hold balances no drill key can spend —
      // require a pure EOA (empty code) before trusting a pre-funded balance.
      const code = await fetchWithTimeout(RPC, 8_000, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [owner, "latest"] }),
      });
      const codeJson = (await code.json()) as { result?: string };
      if ((codeJson.result ?? "0x") !== "0x") {
        throw new Error("drill address holds code (hunted/contract account) — regenerate the drill seed label");
      }
      funded = true;
      return `pre-funded: ${Number(startWei) / 1e18} testBNB`;
    }
    // Real faucet POSTs — community services; each may be down/rate-limited.
    const faucets: { url: string; note: string }[] = [
      { url: "https://testnet.bnbchain.org/faucet-smart/api/request", note: "official bnbchain.org" },
      { url: "https://faucet.mevblocker.io", note: "mevblocker (multi-chain)" },
    ];
    for (const f of faucets) {
      try {
        await fetchWithTimeout(f.url, 20_000, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: owner }), // shape shared by both services
        });
        // Poll the balance — the faucets broadcast internally.
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3_000));
          const bal = await fetchWithTimeout(RPC, 8_000, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [owner, "latest"] }),
          });
          const bj = (await bal.json()) as { result?: string };
          if (BigInt(bj.result ?? "0x0") > startWei) {
            funded = true;
            return `funded via ${f.note} (poll ${i * 3}s)`;
          }
        }
      } catch {
        // honest fallthrough to the next faucet
      }
    }
    const after = await fetchWithTimeout(RPC, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [owner, "latest"] }),
    });
    const afterJson = (await after.json()) as { result?: string };
    if (BigInt(afterJson.result ?? "0x0") >= 50_000_000_000_000n) {
      funded = true;
      return "pre-funded";
    }
    throw new Error("every faucet refused or timed out");
  }));

  if (!funded) {
    console.error("\n[evm-drill] ✗ Cannot continue — no testBNB funding path succeeded.");
    console.error("[evm-drill]   Fund the drill address manually and re-run:");
    console.error(`[evm-drill]   ${owner}`);
    console.error("[evm-drill]   https://testnet.bnbchain.org/faucet-smart");
    return 1;
  }

  // ── Stage 4 — REAL broadcast: the PRODUCTION send path end-to-end ──
  results.push(await stage(4, "sendSignedTransaction → on-chain receipt (production path)", async () => {
    // The exact production call shape: live gas price, live nonce, self-send
    // with an exactInput-style data stub. Full simulation gate first (the
    // executor's eth_call gate) — a reverting send must never be signed.
    const { transferNative } = await import("../src/lib/swap-executor");
    const { txHash, relay } = await transferNative(
      RPC,
      CHAIN_ID,
      signer.privateKey,
      signer.address,
      signer.address, // self-send — same production withdrawal path, zero risk
      0.0000001, // dust — proves the wire, not the wallet
      { enabled: false, network: "testnet" }, // drill never touches relays
    );
    void relay;
    const receipt = await waitForRpcReceipt(RPC, txHash, 60_000, 2_000);
    if (receipt.status !== "success") throw new Error("tx reverted on-chain");
    return `https://testnet.bscscan.com/tx/${txHash}`;
  }));

  // ── Stage 5 — REAL PancakeSwap swap through the PRODUCTION buy path ──
  // Pair discovery is live (factory PairCreated logs, BNB-paired only), the
  // quote + dual simulation are the executor's own, and the buy is signed by
  // the vault signer. No fixture addresses, no fake fills: if no live pair
  // passes the simulation, the stage FAILS honestly.
  results.push(await stage(5, "PancakeSwap swap via production buyToken (vault-signed)", async () => {
    const { fetchWithTimeout } = await import("../src/lib/fetch-timeout");
    const WBNB = BNB_NETWORKS.testnet.wbnb.toLowerCase();
    const FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17"; // PCS V2 testnet (chains registry)
    const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
    const head = await fetchWithTimeout(RPC, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }).then((r) => r.json() as Promise<{ result?: string }>);
    const latest = Number.parseInt(head.result ?? "0x0", 16);
    if (latest <= 0) throw new Error("eth_blockNumber failed");
    const fromBlock = `0x${Math.max(0, latest - 4500).toString(16)}`;
    const logsRes = await fetchWithTimeout(RPC, 12_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getLogs",
        params: [{ address: FACTORY, topics: [PAIR_CREATED_TOPIC], fromBlock, toBlock: "latest" }, "latest"],
      }),
    }).then((r) => r.json() as Promise<{ result?: { address: string; topics: string[] }[]; error?: { message?: string } }>);
    const logs = logsRes.result ?? [];
    if (logs.length === 0) throw new Error(logsRes.error?.message ?? `no PairCreated events in the last 4500 blocks`);
    const addrFromTopic = (t: string) => `0x${t.slice(-40)}`;
    const candidates = logs
      .map((log) => ({ pair: log.address.toLowerCase(), t0: addrFromTopic(log.topics[1]).toLowerCase(), t1: addrFromTopic(log.topics[2]).toLowerCase() }))
      .map((e) => (e.t0 === WBNB ? e.t1 : e.t1 === WBNB ? e.t0 : null))
      .filter((t): t is string => t !== null && t !== WBNB);
    const unique = [...new Set(candidates)];
    if (unique.length === 0) throw new Error(`${logs.length} new pairs, none BNB-paired — nothing real to swap`);
    console.log(`[evm-drill]   discovered ${logs.length} new pair(s), ${unique.length} BNB-paired candidate(s)`);

    const env = executionEnvFor("bsc", "testnet");
    const vaultSigner = getVaultHotWallet();
    if (!vaultSigner) throw new Error("vault signer vanished");
    const signer = resolveSignerFor(env, vaultSigner, null, null);
    if (!signer) throw new Error("production signer resolution failed");

    let lastError = "no candidates tried";
    for (const token of unique.slice(0, 4)) {
      try {
        const res = await buyToken({
          signer,
          env,
          tokenAddress: token,
          amountNative: 0.001, // dust-sized — proves the wire, not the wallet
          slippagePct: 15,
          recipient: vaultSigner.address,
        });
        if (!res.simulationPassed) {
          lastError = res.simulationError ?? "simulation failed";
          console.log(`[evm-drill]   ${token.slice(0, 10)}… sim refused (${lastError}) — next candidate`);
          continue;
        }
        if (res.status !== "success") {
          lastError = "buy reverted on-chain";
          console.log(`[evm-drill]   ${token.slice(0, 10)}… reverted — next candidate`);
          continue;
        }
        // REAL on-chain proof: the signer now HOLDS the bought token.
        const BALANCE_OF_ABI = [
          {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ name: "owner", type: "address" }],
            outputs: [{ type: "uint256" }],
          },
        ];
        const { encodeFunctionData, decodeFunctionResult } = await import("viem");
        const balCall = await fetchWithTimeout(RPC, 8_000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: token, data: encodeFunctionData({ abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [vaultSigner.address] }) }, "latest"],
          }),
        }).then((r) => r.json() as Promise<{ result?: string; error?: { message?: string } }>);
        if (!balCall.result) throw new Error("balanceOf eth_call failed");
        const held = decodeFunctionResult({ abi: BALANCE_OF_ABI, functionName: "balanceOf", data: balCall.result as `0x${string}` });
        if (held <= 0n) throw new Error("buy confirmed but token balance is zero");
        return `${(Number(held) / 1e18).toFixed(4)} tokens held · ${res.receivedTokensWei !== undefined ? "real receive-scan basis" : "quote basis"} · https://testnet.bscscan.com/tx/${res.txHash}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : "candidate failed";
        console.log(`[evm-drill]   candidate ${token.slice(0, 10)}… failed: ${lastError}`);
      }
    }
    throw new Error(`no live pair passed the real simulation — last: ${lastError}`);
  }));

  const passed = results.filter(Boolean).length;
  console.log(`\n[evm-drill] ══ VERDICT: ${passed}/${results.length} stages passed on REAL BSC testnet in ${Date.now() - t0}ms ══`);
  return passed === results.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[evm-drill] FATAL:", err);
    process.exit(1);
  });
