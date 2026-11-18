/**
 * Real multi-chain swap execution layer for the Sniper bot (buy + sell) —
 * BSC, Ethereum, Arbitrum and Polygon all behave EXACTLY like BSC:
 *
 * Everything here hits real endpoints — no simulation of results, no fake
 * hashes:
 *  - quotes come from the chain's own router via eth_call `getAmountsOut`
 *  - every send is pre-flighted with a FULL eth_estimateGas + eth_call dual
 *    simulation — if it would revert, nothing is broadcast and zero gas
 *    is spent (the same zero-gas guarantee as the flash-loan executor)
 *  - simulations are RACED across all fast CORS-open endpoints for the
 *    selected chain (first definitive answer wins) to minimize latency
 *  - prices come from DexScreener live pair data (chain-scoped)
 *  - transactions are signed either by the app-held hot wallet (raw tx,
 *    truly automatic — no popup) or through the injected wallet provider
 *
 * The only difference between chains is the execution environment
 * (router / wrapped-native / RPC / chainId) — see executionEnvFor().
 */
import {
  encodeFunctionData,
  decodeFunctionResult,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getWalletAddress,
  ensureWalletChainId,
  waitForFlashLoanReceipt,
  fetchGasPriceGwei,
  type Eip1193Provider,
  type WalletChainTarget,
} from "./chain";
import { executionEnvFor, type ChainExecutionEnv, type ChainKey } from "./chains";
import { executionTargetReasons } from "../chains/registry/discovery-store";
import {
  isChainPrivateSubmitDegraded,
  resolvePrivateRpc,
  sendRawPrivate,
} from "./private-rpc";
import type { PrivateSubmitNetwork } from "./private-rpc";

// ---------------------------------------------------------------------------
// ABIs (UniV2-fork Router02 — identical signatures on every supported chain:
// PancakeSwap BSC, Uniswap Ethereum/Arbitrum, QuickSwap Polygon)
// ---------------------------------------------------------------------------

const ROUTER_SWAP_ABI = [
  {
    type: "function",
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ROUTER_QUOTE_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Signer resolution — hot wallet (automatic, raw txs) or injected wallet
// ---------------------------------------------------------------------------

export type SwapSigner =
  | {
      kind: "hot";
      env: ChainExecutionEnv;
      privateKey: `0x${string}`;
      from: string;
      nativeSymbol: string;
    }
  | {
      kind: "injected";
      env: ChainExecutionEnv;
      provider: Eip1193Provider;
      from: string;
    };

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

interface RpcTx {
  from: string;
  to: Hex;
  data: Hex;
  value?: Hex;
}

async function rpcRequest<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(rpcUrl, 15_000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "RPC error");
  return json.result as T;
}

// ---------------------------------------------------------------------------
// RPC racing — the simulation round-trip is the physical floor on execution
// latency, so every simulation is RACED across all endpoints for the chain:
// the FIRST DEFINITIVE answer (success OR revert) wins; only network
// failures (timeout, unreachable) are skipped. Endpoints live-verified:
// correct chainId + open CORS.
// ---------------------------------------------------------------------------

const FAST_RPC_SETS: Record<number, string[]> = {
  56: [
    "https://rpc-bsc.48.club",
    "https://bsc.publicnode.com",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed1.ninicoin.io",
  ],
  97: [
    "https://bsc-testnet-rpc.publicnode.com",
    "https://data-seed-prebsc-1-s1.binance.org:8545",
    "https://data-seed-prebsc-2-s1.binance.org:8545",
  ],
  1: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
  11155111: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://rpc.sepolia.org",
  ],
  137: [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.llamarpc.com",
  ],
  80002: ["https://polygon-amoy-bor-rpc.publicnode.com"],
  42161: [
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ],
  421614: [
    "https://arbitrum-sepolia-rpc.publicnode.com",
    "https://arbitrum-sepolia.drpc.org",
  ],
};

/** Endpoints for a chainId, always including the canonical RPC last (fallback). */
export function rpcSetFor(chainId: number, canonical: string): string[] {
  const set = FAST_RPC_SETS[chainId] ?? [];
  return set.includes(canonical) ? set : [...set, canonical];
}

/** One endpoint's answer: definitive (ok/revert) or a network miss. */
type EndpointAnswer<T> =
  | { kind: "ok"; value: T; latencyMs: number; endpoint: string }
  | { kind: "revert"; error: string; latencyMs: number; endpoint: string }
  | { kind: "network"; error: string; endpoint: string };

/**
 * Resolve with the first DEFINITIVE answer; resolve network-only if every
 * endpoint missed. A revert IS a definitive verdict (the EVM executed the
 * tx and it failed) — it must not wait on slower endpoints.
 */
function firstDefinitive<T>(tasks: Array<Promise<EndpointAnswer<T>>>): Promise<EndpointAnswer<T>> {
  return new Promise((resolve) => {
    let pending = tasks.length;
    let settled = false;
    let lastNetwork = "all endpoints unreachable";
    for (const task of tasks) {
      task.then((answer) => {
        if (settled) return;
        if (answer.kind !== "network") {
          settled = true;
          resolve(answer);
          return;
        }
        lastNetwork = answer.error;
        pending -= 1;
        if (pending === 0 && !settled) {
          settled = true;
          resolve({ kind: "network", error: lastNetwork, endpoint: "none" });
        }
      }).catch(() => {
        if (settled) return;
        pending -= 1;
        if (pending === 0 && !settled) {
          settled = true;
          resolve({ kind: "network", error: lastNetwork, endpoint: "none" });
        }
      });
    }
  });
}

/** Decode Error(string) / Panic(uint256) revert payloads. */
function decodeRevertData(data: string): string | undefined {
  if (data?.startsWith("0x08c379a0")) {
    const hex = data.slice(10);
    try {
      const bytes = hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
      return (
        new TextDecoder()
          .decode(new Uint8Array(bytes))
          .replace(/\0/g, "")
          .trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  if (data?.startsWith("0x4e487b71")) {
    try {
      return `Panic(0x${BigInt("0x" + data.slice(10)).toString(16)})`;
    } catch {
      return "Arithmetic panic";
    }
  }
  return undefined;
}

interface SimResult {
  /** True when the node would execute the tx without reverting. */
  success: boolean;
  /** Actual revert reason / network error text when failed. */
  error?: string;
  /** Raw eth_call return data from the full read-only execution (hex). */
  returnData?: string;
  /** Real wall-clock cost of the winning simulation, milliseconds. */
  latencyMs: number;
  /** How many endpoints were raced in parallel. */
  raced: number;
  /** Winning endpoint for the confirmation pass. */
  endpoint?: string;
}

/**
 * FULL pre-flight execution simulation — the dual gate that runs before
 * EVERY automatic execution (buy, sell, payout, and the flash-loan
 * executor's eth_call path), on EVERY chain:
 *
 *   1. eth_estimateGas — RACED across every fast endpoint for the chain
 *      (first definitive answer wins): the EVM runs the complete
 *      transaction without mining it. A revert (honeypot, tax trap,
 *      slippage cap, no liquidity) is a definitive verdict → the caller
 *      broadcasts NOTHING and zero gas is spent.
 *   2. eth_call — full read-only execution of the exact same calldata on
 *      the winning endpoint as the confirmation pass (also zero gas).
 *
 * Real measured latency is returned for the operator's visibility.
 */
export async function simulateSwapTx(
  rpcUrl: string,
  tx: RpcTx,
  chainId = 56,
): Promise<SimResult & { gasHex: string }> {
  const endpoints = rpcSetFor(chainId, rpcUrl);
  const t0 = performance.now();

  const callParams: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data };
  if (tx.value && tx.value !== "0x0") callParams.value = tx.value;

  const answer = await firstDefinitive(
    endpoints.map((endpoint) =>
      (async (): Promise<EndpointAnswer<string>> => {
        const start = performance.now();
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_estimateGas",
              params: [{ ...callParams, gas: "0x1e8480" }],
            }),
          });
          const json = (await res.json()) as {
            result?: string;
            error?: { message?: string; data?: string };
          };
          const latencyMs = performance.now() - start;
          if (json.error) {
            const reason =
              (json.error.data ? decodeRevertData(json.error.data) : undefined) ??
              json.error.message ??
              "simulation reverted";
            return { kind: "revert", error: reason, latencyMs, endpoint };
          }
          if (!json.result) return { kind: "network", error: "empty result", endpoint };
          return { kind: "ok", value: json.result, latencyMs, endpoint };
        } catch (e) {
          return {
            kind: "network",
            error: e instanceof Error ? e.message : "endpoint unreachable",
            endpoint,
          };
        }
      })(),
    ),
  );

  const raced = endpoints.length;

  if (answer.kind === "revert") {
    return {
      success: false,
      error: answer.error,
      latencyMs: performance.now() - t0,
      raced,
      endpoint: answer.endpoint,
      gasHex: "",
    };
  }
  if (answer.kind === "network") {
    return {
      success: false,
      error: `RPC unreachable — refusing to broadcast (${answer.error})`,
      latencyMs: performance.now() - t0,
      raced,
      gasHex: "",
    };
  }

  // Pass 2/3 — the target must actually hold contract code. A "successful"
  // estimateGas proves nothing when `to` has no code: the EVM accepts a call
  // to an EOA, charges gas and executes nothing, so a mistyped router or
  // aggregator address would otherwise be broadcast as a "passing" route.
  // Empty calldata IS a plain value transfer, where an EOA target is correct.
  const isValueTransfer = !tx.data || tx.data === "0x";
  if (!isValueTransfer) {
    const code = await rpcRequest<string>(answer.endpoint, "eth_getCode", [
      tx.to,
      "latest",
    ]).catch(() => null);
    if (code !== null && !hasContractCode(code)) {
      return {
        success: false,
        error: `${tx.to} has no contract code on this chain — the call would execute nothing`,
        latencyMs: performance.now() - t0,
        raced,
        endpoint: answer.endpoint,
        gasHex: answer.value,
      };
    }
    // A zero gas estimate for real calldata is a provider anomaly, not a
    // green light: nothing that runs code costs zero gas.
    if (answer.value === "0x0" || answer.value === "0x") {
      return {
        success: false,
        error: "gas estimate of zero for a contract call — refusing to broadcast",
        latencyMs: performance.now() - t0,
        raced,
        endpoint: answer.endpoint,
        gasHex: answer.value,
      };
    }
  }

  // Pass 3/3 — full eth_call of the exact same calldata on the winning
  // endpoint; its return data is kept as evidence of the simulated result.
  let returnData: string;
  try {
    returnData = await rpcRequest<string>(answer.endpoint, "eth_call", [callParams, "latest"]);
  } catch (callErr) {
    return {
      success: false,
      error: callErr instanceof Error ? callErr.message : "eth_call confirmation failed",
      latencyMs: performance.now() - t0,
      raced,
      endpoint: answer.endpoint,
      gasHex: "",
    };
  }
  return {
    success: true,
    latencyMs: performance.now() - t0,
    raced,
    endpoint: answer.endpoint,
    gasHex: answer.value,
    returnData,
  };
}

/**
 * True when an `eth_getCode` answer is real deployed bytecode. Providers
 * answer "0x", "0x0" or "0x00" for an address with no code, so comparing
 * to exactly "0x" is not enough.
 */
export function hasContractCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return /^0x[0-9a-fA-F]*$/.test(code) && code.replace(/^0x/, "").replace(/0/g, "").length > 0;
}

// ---------------------------------------------------------------------------
// On-chain reads (quotes raced the same way — first definitive answer wins)
// ---------------------------------------------------------------------------

export async function racedEthCall(
  chainId: number,
  canonicalRpc: string,
  to: Hex,
  data: Hex,
  from?: string,
): Promise<string> {
  const params: Record<string, string> = { to, data };
  if (from) params.from = from;
  const endpoints = rpcSetFor(chainId, canonicalRpc);
  const answer = await firstDefinitive(
    endpoints.map((endpoint) =>
      (async (): Promise<EndpointAnswer<string>> => {
        try {
          const { fetchWithTimeout } = await import("./fetch-timeout");
          const res = await fetchWithTimeout(endpoint, 4_000, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [params, "latest"],
            }),
          });
          const json = (await res.json()) as {
            result?: string;
            error?: { message?: string; data?: string };
          };
          if (json.error) {
            const reason =
              (json.error.data ? decodeRevertData(json.error.data) : undefined) ??
              json.error.message ??
              "call reverted";
            return { kind: "revert", error: reason, latencyMs: 0, endpoint };
          }
          if (json.result === null || json.result === undefined) {
            return { kind: "network", error: "empty result", endpoint };
          }
          return { kind: "ok", value: json.result, latencyMs: 0, endpoint };
        } catch (e) {
          return {
            kind: "network",
            error: e instanceof Error ? e.message : "endpoint unreachable",
            endpoint,
          };
        }
      })(),
    ),
  );
  if (answer.kind === "ok") return answer.value;
  throw new Error(answer.kind === "revert" ? answer.error : `RPC unreachable (${answer.error})`);
}

/** Real on-chain router quote: expected token wei out for an exact input. */
export async function quoteAmountsOut(
  rpcUrl: string,
  router: Hex,
  amountInWei: bigint,
  path: Hex[],
  chainId: number,
  from?: string,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ROUTER_QUOTE_ABI,
    functionName: "getAmountsOut",
    args: [amountInWei, path],
  });
  const result = await racedEthCall(chainId, rpcUrl, router, data, from);
  const amounts = decodeFunctionResult({
    abi: ROUTER_QUOTE_ABI,
    functionName: "getAmountsOut",
    data: result as Hex,
  });
  const out = amounts[amounts.length - 1];
  if (out <= 0n) throw new Error("Router quoted zero output");
  return out;
}

export async function fetchTokenDecimals(rpcUrl: string, token: Hex, chainId: number): Promise<number> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals", args: [] });
  const result = await racedEthCall(chainId, rpcUrl, token, data);
  return Number(BigInt(result));
}

export async function fetchTokenBalance(rpcUrl: string, token: Hex, owner: string, chainId: number): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner as Hex] });
  const result = await racedEthCall(chainId, rpcUrl, token, data);
  return BigInt(result);
}

export async function fetchTokenAllowance(rpcUrl: string, token: Hex, owner: string, spender: string, chainId: number): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner as Hex, spender as Hex],
  });
  const result = await racedEthCall(chainId, rpcUrl, token, data);
  return BigInt(result);
}

/**
 * Live token USD price from DexScreener (real pair data, deepest pair wins,
 * chain-scoped when a chainId is given). Returns null when the token has no
 * live pair — never fabricates a price.
 */
export async function fetchTokenPriceUsd(tokenAddress: string, chainId?: number): Promise<number | null> {
  try {
    const suffix = chainId ? `?chain_ids=${chainId}` : "";
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}${suffix}`,
      8_000,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }>;
    };
    let best: { price: number; liq: number } | null = null;
    for (const p of data.pairs ?? []) {
      if (chainId && p.chainId && p.chainId !== String(chainId)) continue;
      const price = Number(p.priceUsd);
      if (!Number.isFinite(price) || price <= 0) continue;
      const liq = p.liquidity?.usd ?? 0;
      if (!best || liq > best.liq) best = { price, liq };
    }
    return best?.price ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sending (raw for hot wallet / eth_sendTransaction for injected)
// ---------------------------------------------------------------------------

/**
 * Optional pre-flight for the hot-wallet CONTRACT DEPLOY path: real
 * eth_estimateGas for the creation tx (no `to`) from the hot wallet, so the
 * locally signed deploy has a real gas cap instead of a guess. Read-only —
 * zero gas. Returns null when the node refuses (e.g. constructor would
 * revert) — the caller then refuses to sign (nothing broadcast, zero gas).
 */
export async function estimateCreateGasHot(
  rpcUrl: string,
  from: string,
  data: Hex,
): Promise<bigint | null> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(rpcUrl, 10_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_estimateGas",
        params: [{ from, data }],
      }),
    });
    const json = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (json.error || !json.result) return null;
    // ~10% pad — creation gas depends on the constructor run.
    return (BigInt(json.result) * 110n) / 100n;
  } catch {
    return null;
  }
}/**
 * Serialize + sign a legacy (type-0) CONTRACT-CREATION transaction with a
 * hot-wallet key — the exact bytes `sendSignedCreateTransaction` broadcasts.
 * Exported pure (no network) so the create form (`to: null`, calldata,
 * chainId) is unit-testable. viem serializes `to: null` as the empty
 * recipient — the canonical create-tx form.
 */
export async function signCreateTransaction(
  privateKey: `0x${string}`,
  tx: { chainId: number; data: Hex; gas: bigint; gasPriceWei: bigint; nonce: bigint },
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  return account.signTransaction({
    type: "legacy",
    chainId: tx.chainId,
    to: null,
    data: tx.data,
    value: 0n,
    gas: tx.gas,
    gasPrice: tx.gasPriceWei,
    nonce: Number(tx.nonce),
  });
}

/**
 * Sign a CONTRACT-CREATION transaction locally with the hot wallet key and
 * broadcast — the hot-wallet deploy path (no wallet popup, fully automatic):
 *   • no `to` — the data IS the solc creation bytecode + constructor args
 *   • real gas cap from a live eth_estimateGas pre-flight (read-only)
 *   • with `privateSubmit` and a registered relay (Flashbots Protect on
 *     Ethereum, bloXroute Protect on BSC) the SIGNED bytes go to the
 *     private relay first, hidden from the public mempool until inclusion
 *   • otherwise the raw bytes go out the public RPC exactly like the
 *     injected-wallet deploy
 *
 * Returns which channel actually carried the bytes so the deploy record can
 * attribute the broadcast honestly (never claims "private" when it wasn't).
 */
export async function sendSignedCreateTransaction(
  rpcUrl: string,
  chainId: number,
  privateKey: `0x${string}`,
  deployData: Hex,
  privateSubmit?: { enabled: boolean; network: PrivateSubmitNetwork },
): Promise<{ txHash: Hex; relay?: string; relayDegraded?: boolean }> {
  // Pre-flight gas cap — a node refusal means the deploy would revert on
  // chain, so nothing is signed or broadcast (zero gas spent).
  const gas = await estimateCreateGasHot(rpcUrl, privateKeyToAccount(privateKey).address, deployData);
  if (gas === null) {
    throw new Error(
      "Creation gas estimation failed — the constructor would revert or the RPC is unreachable. Nothing was signed or broadcast.",
    );
  }
  const account = privateKeyToAccount(privateKey);
  const { wei } = await gasPriceWeiFor(rpcUrl);
  const nonce = await nextNonce(rpcUrl, account.address);
  const signed = await signCreateTransaction(privateKey, {
    chainId,
    data: deployData,
    gas,
    gasPriceWei: wei,
    nonce,
  });
  if (privateSubmit?.enabled) {
    if (resolvePrivateRpc(chainId, privateSubmit.network)) {
      if (isChainPrivateSubmitDegraded(chainId, privateSubmit.network)) {
        return {
          txHash: await rpcRequest<Hex>(rpcUrl, "eth_sendRawTransaction", [signed]),
          relayDegraded: true,
        };
      }
      const { txHash, endpoint } = await sendRawPrivate(signed, chainId, privateSubmit.network);
      return { txHash, relay: endpoint };
    }
    // No relay registered for this chain/network → honest public fallback.
  }
  return { txHash: await rpcRequest<Hex>(rpcUrl, "eth_sendRawTransaction", [signed]) };
}

/** Current gas price in wei (read-only RPC round-trip). */
export async function gasPriceWeiFor(rpcUrl: string): Promise<{ wei: bigint; gwei: number }> {
  const gwei = await fetchGasPriceGwei(rpcUrl);
  if (gwei === null) throw new Error("RPC unreachable — gas price unknown, refusing to send");
  const wei = BigInt(Math.ceil(gwei * 1e9));
  return { wei, gwei };
}

/** Pending transaction count for an address (read-only RPC round-trip). */
export async function nextNonce(rpcUrl: string, address: string): Promise<bigint> {
  const hex = await rpcRequest<string>(rpcUrl, "eth_getTransactionCount", [address, "pending"]);
  return BigInt(hex ?? "0x0");
}

/**
 * Sign a legacy (type-0) transaction locally with the hot wallet key and
 * broadcast. Automatic — no wallet popup — so this is the path that gives
 * true sub-second auto-execution on any chain.
 *
 * With `privateSubmit` enabled and a real private relay registered for the
 * chain/network (Flashbots Protect on Ethereum, bloXroute Protect on BSC),
 * the SIGNED bytes go to the relay instead of the public mempool —
 * sandwich/frontrun bots can't see the tx before inclusion, and reverted
 * txs never land on chain (zero gas on failure — same guarantee as the
 * eth_call gate). With no relay available the tx goes out the public RPC
 * exactly as before.
 */
export async function sendSignedTransaction(
  rpcUrl: string,
  chainId: number,
  privateKey: `0x${string}`,
  tx: { to: Hex; data: Hex; value?: bigint; gas: bigint; gasPriceWei: bigint; nonce: bigint; /** opt-in: also measure the signing latency in µs-precision ms */ microsecond?: boolean },
  privateSubmit?: { enabled: boolean; network: PrivateSubmitNetwork },
): Promise<{ txHash: Hex; relay?: string; relayDegraded?: boolean; signingLatencyMs?: number }> {
  const account = privateKeyToAccount(privateKey);
  // REAL measured latency of the local signing call — this is the sub-ms
  // figure reported in execution alerts. Measured around the exact call that
  // produced the broadcast bytes; never estimated, never mocked.
  const signStart = performance.now();
  const signed = await account.signTransaction({
    type: "legacy",
    chainId,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
    gasPrice: tx.gasPriceWei,
    nonce: Number(tx.nonce),
  });
  const signingLatencyMs = tx.microsecond === true ? performance.now() - signStart : undefined;
  if (privateSubmit?.enabled) {
    if (resolvePrivateRpc(chainId, privateSubmit.network)) {
      // AUTO-FAILOVER: when every relay for the chain is serving its
      // consecutive-failure cooldown, skip the relay path entirely and use
      // the public RPC so the trade still goes out immediately.
      if (isChainPrivateSubmitDegraded(chainId, privateSubmit.network)) {
        return {
          txHash: await rpcRequest<Hex>(rpcUrl, "eth_sendRawTransaction", [signed]),
          relayDegraded: true,
        };
      }
      // Private relay first — hidden from the public mempool until inclusion.
      const { txHash, endpoint } = await sendRawPrivate(signed, chainId, privateSubmit.network);
      return { txHash, relay: endpoint };
    }
    // No relay registered for this chain/network → honest public fallback.
  }
  return { txHash: await rpcRequest<Hex>(rpcUrl, "eth_sendRawTransaction", [signed]) };
}

/** Poll eth_getTransactionReceipt on the public RPC (hot-wallet path). */
export async function waitForRpcReceipt(
  rpcUrl: string,
  txHash: Hex,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<{ status: "success" | "reverted"; txHash: Hex; gasUsedBnb: number; gasPriceGwei: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpcRequest<Record<string, string> | null>(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      const ok = (receipt.status ?? "0x0") === "0x1";
      const gasUsed = BigInt(receipt.gasUsed ?? "0x0");
      const effGasPrice = BigInt(receipt.effectiveGasPrice ?? "0x0");
      return {
        status: ok ? "success" : "reverted",
        txHash,
        gasUsedBnb: Number(gasUsed * effGasPrice) / 1e18,
        gasPriceGwei: Number(effGasPrice) / 1e9,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Receipt timeout — tx still pending");
}

// ---------------------------------------------------------------------------
// BUY — swapExactETHForTokensSupportingFeeOnTransferTokens (any chain)
// ---------------------------------------------------------------------------

export interface BuyParams {
  signer: SwapSigner;
  /** Real execution environment for the selected chain. */
  env: ChainExecutionEnv;
  /** Target token contract address. */
  tokenAddress: string;
  /** Purchase size in the chain's native token. */
  amountNative: number;
  /** Slippage tolerance percent (from the sniper's slippage floor setting). */
  slippagePct: number;
  recipient: string;
  /** Private-relay submission for the hot-wallet broadcast (anti-frontrun). */
  privateSubmit?: { enabled: boolean; network: PrivateSubmitNetwork };
}

/**
 * Why an execution was refused before any transaction existed.
 *
 * This is NOT a simulation failure: nothing was simulated because policy
 * refused first. Callers must report it as an authorization refusal so the
 * operator does not go hunting for a contract bug that is not there.
 */
export interface BlockedExecution {
  code: "unvalidated-target";
  reason: string;
}

export interface BuyResult {
  /** false = refused or failed → nothing sent, zero gas spent */
  simulationPassed: boolean;
  simulationError?: string;
  /** Set when policy refused the execution before simulating anything. */
  blocked?: BlockedExecution;
  /** Measured wall-clock cost of the full dual simulation, ms. */
  simulationLatencyMs?: number;
  simulationRaced?: number;
  /**
   * REAL wall-clock cost of the local secp256k1 signing call (ms) — measured
   * in sendSignedTransaction around the actual `account.signTransaction` call
   * (the same real execution the tx bytes came from). Undefined on the
   * injected-wallet path: the extension does the signing, so the app cannot
   * honestly measure it.
   */
  signingLatencyMs?: number;
  txHash?: Hex;
  status?: "success" | "reverted";
  /** Real on-chain quoted expected token amount (wei). */
  quotedTokensWei?: bigint;
  /** Actual token balance after the buy (wei) — real received amount basis. */
  receivedTokensWei?: bigint;
  /** Real decimals of the token. */
  decimals?: number;
  gasUsedBnb?: number;
  /** Private relay that carried the broadcast (undefined = public RPC path). */
  relay?: string;
  /** True when all relays were in cooldown and the tx fell back to the public RPC. */
  relayDegraded?: boolean;
}

export async function buyToken(params: BuyParams): Promise<BuyResult> {
  const { signer, env, tokenAddress, amountNative, slippagePct, recipient } = params;
  const router = env.router as Hex;
  // Swap target gate: the router must be validated by the backend's discovery
  // registry for this chain. Unvalidated infrastructure never receives a
  // signed transaction, even if it is compiled into the app's own registry.
  const targetReasons = executionTargetReasons({ chainId: env.chainId, router: env.router });
  if (targetReasons.length > 0) {
    return {
      simulationPassed: false,
      blocked: { code: "unvalidated-target", reason: targetReasons.join(" ") },
      simulationError: `Swap target blocked — ${targetReasons.join(" ")}`,
    };
  }
  const wrapped = env.wrapped as Hex;
  const token = tokenAddress.trim().toLowerCase() as Hex;
  const amountInWei = BigInt(Math.max(1, Math.round(amountNative * 1e9))) * 10n ** 9n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);

  // 1. Real on-chain quote — expected tokens out for this exact input.
  let quotedTokensWei: bigint;
  try {
    quotedTokensWei = await quoteAmountsOut(env.rpcUrl, router, amountInWei, [wrapped, token], env.chainId, signer.from);
  } catch (e) {
    return { simulationPassed: false, simulationError: e instanceof Error ? e.message : "Quote failed" };
  }
  // amountOutMin with the operator's slippage tolerance.
  const slipBps = Math.max(0, Math.min(9_900, Math.round(Math.max(0, slippagePct) * 100)));
  const amountOutMin = (quotedTokensWei * BigInt(10_000 - slipBps)) / 10_000n;

  const data = encodeFunctionData({
    abi: ROUTER_SWAP_ABI,
    functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [amountOutMin, [wrapped, token], recipient as Hex, deadline],
  });

  // 2. FULL dual simulation (raced eth_estimateGas + eth_call) — zero gas
  //    when it fails; nothing is ever broadcast on a failed simulation.
  const sim = await simulateSwapTx(
    env.rpcUrl,
    { from: signer.from, to: router, data, value: `0x${amountInWei.toString(16)}` },
    env.chainId,
  );
  if (!sim.success) {
    return {
      simulationPassed: false,
      simulationError: sim.error ?? "Transaction would revert",
      simulationLatencyMs: sim.latencyMs,
      simulationRaced: sim.raced,
    };
  }
  const gas = BigInt(sim.gasHex) + 50_000n; // headroom for fee-on-transfer logic

  // 3. Broadcast — ONLY after the full simulation passed.
  let txHash: Hex;
  let relay: string | undefined;
  let relayDegraded: boolean | undefined;
  let signingLatencyMs: number | undefined;
  if (signer.kind === "hot") {
    const { wei } = await gasPriceWeiFor(env.rpcUrl);
    const nonce = await nextNonce(env.rpcUrl, signer.from);
    ({ txHash, relay, relayDegraded, signingLatencyMs } = await sendSignedTransaction(env.rpcUrl, env.chainId, signer.privateKey, {
      to: router,
      data,
      value: amountInWei,
      microsecond: true,
      gas,
      gasPriceWei: wei,
      nonce,
    }, params.privateSubmit));
  } else {
    await ensureWalletChainId(signer.provider, {
      chainId: env.chainId,
      label: env.label,
      rpc: env.rpcUrl,
      explorerUrl: env.explorerUrl,
      nativeSymbol: env.nativeSymbol,
    });
    txHash = (await signer.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: signer.from,
          to: router,
          data,
          value: `0x${amountInWei.toString(16)}`,
          gas: `0x${gas.toString(16)}`,
        },
      ],
    })) as Hex;
  }

  // 4. Confirm.
  const receipt =
    signer.kind === "hot"
      ? await waitForRpcReceipt(env.rpcUrl, txHash)
      : await (async () => {
          const r = await waitForFlashLoanReceipt(signer.provider, txHash);
          return { status: r.status, txHash: r.txHash, gasUsedBnb: r.gasUsedBnb ?? 0 };
        })();

  if (receipt.status !== "success") {
    return {
      simulationPassed: true,
      simulationLatencyMs: sim.latencyMs,
      simulationRaced: sim.raced,
      signingLatencyMs,
      txHash,
      relay,
      relayDegraded,
      status: "reverted",
      quotedTokensWei,
      gasUsedBnb: receipt.gasUsedBnb,
    };
  }

  // 5. Real received amount = post-buy balance of the recipient.
  const decimals = await fetchTokenDecimals(env.rpcUrl, token, env.chainId);
  let receivedTokensWei: bigint | undefined;
  try {
    receivedTokensWei = await fetchTokenBalance(env.rpcUrl, token, recipient, env.chainId);
  } catch {
    receivedTokensWei = undefined;
  }
  return {
    simulationPassed: true,
    simulationLatencyMs: sim.latencyMs,
    simulationRaced: sim.raced,
    signingLatencyMs,
    txHash,
    relay,
    relayDegraded,
    status: "success",
    quotedTokensWei,
    receivedTokensWei,
    decimals,
    gasUsedBnb: receipt.gasUsedBnb,
  };
}

// ---------------------------------------------------------------------------
// SELL — swapExactTokensForETHSupportingFeeOnTransferTokens (any chain)
// ---------------------------------------------------------------------------

export interface SellParams {
  signer: SwapSigner;
  /** Real execution environment for the selected chain. */
  env: ChainExecutionEnv;
  tokenAddress: string;
  /** Fraction of the held balance to sell (0–100). */
  sellPct: number;
  slippagePct: number;
  recipient: string;
  /** Private-relay submission for the hot-wallet broadcast (anti-frontrun). */
  privateSubmit?: { enabled: boolean; network: PrivateSubmitNetwork };
}

export interface SellResult {
  simulationPassed: boolean;
  simulationError?: string;
  /** Set when policy refused the execution before simulating anything. */
  blocked?: BlockedExecution;
  /** Measured wall-clock cost of the full dual simulation, ms. */
  simulationLatencyMs?: number;
  simulationRaced?: number;
  /** REAL measured signing latency (ms) on the hot-wallet path. */
  signingLatencyMs?: number;
  txHash?: Hex;
  status?: "success" | "reverted";
  amountInWei?: bigint;
  amountOutMinWei?: bigint;
  gasUsedBnb?: number;
  /** Private relay that carried the broadcast (undefined = public RPC path). */
  relay?: string;
  /** True when all relays were in cooldown and the tx fell back to the public RPC. */
  relayDegraded?: boolean;
}

export async function sellToken(params: SellParams): Promise<SellResult> {
  const { signer, env, tokenAddress, sellPct, slippagePct, recipient } = params;
  const router = env.router as Hex;
  const targetReasons = executionTargetReasons({ chainId: env.chainId, router: env.router });
  if (targetReasons.length > 0) {
    return {
      simulationPassed: false,
      blocked: { code: "unvalidated-target", reason: targetReasons.join(" ") },
      simulationError: `Swap target blocked — ${targetReasons.join(" ")}`,
    };
  }
  const wrapped = env.wrapped as Hex;
  const token = tokenAddress.trim().toLowerCase() as Hex;

  // Real held balance.
  const balance = await fetchTokenBalance(env.rpcUrl, token, recipient, env.chainId);
  if (balance <= 0n) {
    return { simulationPassed: false, simulationError: `No balance of ${tokenAddress} in ${recipient}` };
  }
  const pct = Math.max(1, Math.min(100, Math.round(sellPct)));
  const amountIn = (balance * BigInt(pct)) / 100n;
  if (amountIn <= 0n) {
    return { simulationPassed: false, simulationError: "Sell amount rounds to zero" };
  }

  // Real on-chain quote for the sell leg.
  let quotedOut: bigint;
  try {
    quotedOut = await quoteAmountsOut(env.rpcUrl, router, amountIn, [token, wrapped], env.chainId, recipient);
  } catch (e) {
    return { simulationPassed: false, simulationError: e instanceof Error ? e.message : "Quote failed" };
  }
  const slipBps = Math.max(0, Math.min(9_900, Math.round(Math.max(0, slippagePct) * 100)));
  const amountOutMin = (quotedOut * BigInt(10_000 - slipBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);

  // Approval — check the real allowance first, approve only the shortfall.
  const allowance = await fetchTokenAllowance(env.rpcUrl, token, recipient, router, env.chainId);
  if (allowance < amountIn) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [router, amountIn],
    });
    // The approval itself is fully simulated too (tax tokens can block it).
    const approveSim = await simulateSwapTx(env.rpcUrl, { from: signer.from, to: token, data: approveData }, env.chainId);
    if (!approveSim.success) {
      return {
        simulationPassed: false,
        simulationError: approveSim.error ?? "Approval would revert",
        simulationLatencyMs: approveSim.latencyMs,
        simulationRaced: approveSim.raced,
      };
    }
    let approveHash: Hex;
    if (signer.kind === "hot") {
      const { wei } = await gasPriceWeiFor(env.rpcUrl);
      const nonce = await nextNonce(env.rpcUrl, signer.from);
      ({ txHash: approveHash } = await sendSignedTransaction(env.rpcUrl, env.chainId, signer.privateKey, {
        to: token,
        data: approveData,
        gas: 120_000n,
        gasPriceWei: wei,
        nonce,
      }, params.privateSubmit));
    } else {
      approveHash = (await signer.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: signer.from, to: token, data: approveData, value: "0x0", gas: "0x1d4c0" }],
      })) as Hex;
    }
    // Wait for the approval before swapping.
    const approveReceipt =
      signer.kind === "hot"
        ? await waitForRpcReceipt(env.rpcUrl, approveHash)
        : await (async () => {
            const r = await waitForFlashLoanReceipt(signer.provider, approveHash);
            return { status: r.status, txHash: r.txHash, gasUsedBnb: r.gasUsedBnb ?? 0 };
          })();
    if (approveReceipt.status !== "success") {
      return { simulationPassed: true, txHash: approveHash, status: "reverted" };
    }
  }

  const data = encodeFunctionData({
    abi: ROUTER_SWAP_ABI,
    functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    args: [amountIn, amountOutMin, [token, wrapped], recipient as Hex, deadline],
  });

  // FULL dual simulation — zero gas when the sell would revert.
  const sim = await simulateSwapTx(env.rpcUrl, { from: signer.from, to: router, data }, env.chainId);
  if (!sim.success) {
    return {
      simulationPassed: false,
      simulationError: sim.error ?? "Sell would revert (honeypot/tax?)",
      simulationLatencyMs: sim.latencyMs,
      simulationRaced: sim.raced,
    };
  }
  const gas = BigInt(sim.gasHex) + 50_000n;

  let txHash: Hex;
  let relay: string | undefined;
  let relayDegraded: boolean | undefined;
  let signingLatencyMs: number | undefined;
  if (signer.kind === "hot") {
    const { wei } = await gasPriceWeiFor(env.rpcUrl);
    const nonce = await nextNonce(env.rpcUrl, signer.from);
    ({ txHash, relay, relayDegraded, signingLatencyMs } = await sendSignedTransaction(env.rpcUrl, env.chainId, signer.privateKey, {
      to: router,
      data,
      microsecond: true,
      gas,
      gasPriceWei: wei,
      nonce,
    }, params.privateSubmit));
  } else {
    txHash = (await signer.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: signer.from, to: router, data, value: "0x0", gas: `0x${gas.toString(16)}` }],
    })) as Hex;
  }

  const receipt =
    signer.kind === "hot"
      ? await waitForRpcReceipt(env.rpcUrl, txHash)
      : await (async () => {
          const r = await waitForFlashLoanReceipt(signer.provider, txHash);
          return { status: r.status, txHash: r.txHash, gasUsedBnb: r.gasUsedBnb ?? 0 };
        })();

  return {
    simulationPassed: true,
    simulationLatencyMs: sim.latencyMs,
    simulationRaced: sim.raced,
    signingLatencyMs,
    txHash,
    relay,
    relayDegraded,
    status: receipt.status,
    amountInWei: amountIn,
    amountOutMinWei: amountOutMin,
    gasUsedBnb: receipt.gasUsedBnb,
  };
}

// ---------------------------------------------------------------------------
// OPTIONAL hot-wallet native payout/withdrawal (real transfer, any chain)
// ---------------------------------------------------------------------------

export async function transferNative(
  rpcUrl: string,
  chainId: number,
  privateKey: `0x${string}`,
  from: string,
  to: string,
  amountNative: number,
  privateSubmit?: { enabled: boolean; network: PrivateSubmitNetwork },
): Promise<{ txHash: Hex; relay?: string }> {
  const { wei } = await gasPriceWeiFor(rpcUrl);
  const nonce = await nextNonce(rpcUrl, from);
  const value = BigInt(Math.max(1, Math.round(amountNative * 1e9))) * 10n ** 9n;
  // Full dual simulation first — zero gas when the transfer would fail.
  const sim = await simulateSwapTx(rpcUrl, { from, to: to as Hex, data: "0x", value: `0x${value.toString(16)}` }, chainId);
  if (!sim.success) {
    throw new Error(sim.error ?? "Transfer simulation failed — zero gas spent");
  }
  return sendSignedTransaction(rpcUrl, chainId, privateKey, {
    to: to as Hex,
    data: "0x",
    value,
    gas: 21_000n,
    gasPriceWei: wei,
    nonce,
  }, privateSubmit);
}

/**
 * Resolve the auto-execution signer for the SELECTED chain: the hot wallet
 * first (fully automatic — signs locally, no popups), then the injected
 * wallet. The env carries the real chainId/RPC so every downstream buy /
 * sell / payout targets the chain the operator selected.
 */
export function resolveSignerFor(
  env: ChainExecutionEnv,
  hotWallet: { privateKey: `0x${string}`; address: string } | null,
  provider: Eip1193Provider | null,
  injectedAddress: string | null,
): SwapSigner | null {
  if (hotWallet) {
    return {
      kind: "hot",
      env,
      privateKey: hotWallet.privateKey,
      from: hotWallet.address,
      nativeSymbol: env.nativeSymbol,
    };
  }
  if (provider && injectedAddress) {
    return { kind: "injected", env, provider, from: injectedAddress };
  }
  return null;
}

/** Convenience wrapper preserving the previous call shape (BSC default). */
export function resolveSignerFrom(
  hotWallet: { privateKey: `0x${string}`; address: string } | null,
  provider: Eip1193Provider | null,
  chainKey: ChainKey = "bsc",
  injectedAddress: string | null,
  rpcOverride?: string,
  network: "mainnet" | "testnet" = "mainnet",
): SwapSigner | null {
  return resolveSignerFor(executionEnvFor(chainKey, network, rpcOverride), hotWallet, provider, injectedAddress);
}
