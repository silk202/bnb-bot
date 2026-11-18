/**
 * FlashBolt on-chain execution layer.
 *
 * Real EIP-1193 transactions for live mode. The terminal never holds keys —
 * every send goes through the user's injected wallet, and the only thing we
 * build client-side is the `execute(address[],uint256)` calldata for a
 * deployed FlashBoltArbitrage contract.
 */
import { encodeFunctionData, isAddress, type Hex } from "viem";

export type NetworkKey = "mainnet" | "testnet";

export interface BnbNetworkInfo {
  label: string;
  chainId: number;
  rpc: string;
  wbnb: string;
  router: string;
  explorer: string;
  explorerUrl: string;
  networkSlug: string;
  nativeSymbol: string;
}

/**
 * BNB Chain network registry — single source of truth used by the Contract
 * page, the live Scanner executor and the sidebar. Router addresses are the
 * official PancakeSwap V2 Router02 contracts.
 */
export const BNB_NETWORKS: Record<NetworkKey, BnbNetworkInfo> = {
  mainnet: {
    label: "BNB Smart Chain",
    chainId: 56,
    rpc: "https://bsc-dataseed.binance.org",
    wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    explorer: "BscScan",
    explorerUrl: "https://bscscan.com",
    networkSlug: "mainnet",
    nativeSymbol: "BNB",
  },
  testnet: {
    label: "BNB Testnet",
    chainId: 97,
    rpc: "https://data-seed-prebsc-1-s1.binance.org:8545",
    wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    explorer: "BscScan Testnet",
    explorerUrl: "https://testnet.bscscan.com",
    networkSlug: "testnet",
    nativeSymbol: "BNB",
  },
};

export function networkForChainId(chainId: number): NetworkKey | null {
  if (chainId === BNB_NETWORKS.mainnet.chainId) return "mainnet";
  if (chainId === BNB_NETWORKS.testnet.chainId) return "testnet";
  return null;
}

/** The flash-borrow marker the FlashBoltArbitrage contract expects for WBNB. */
export const FLASH_BORROW_MARKER = "0x0000000000000000000000000000000000000000" as Hex;

// ---------------------------------------------------------------------------
// EIP-1193 provider helpers
// ---------------------------------------------------------------------------

export interface Eip1193Request {
  method: string;
  params?: unknown[];
}

export interface Eip1193Provider {
  request(args: Eip1193Request): Promise<unknown>;
}

export function getInjectedProvider(): Eip1193Provider | null {
  const injected = (globalThis as { ethereum?: unknown }).ethereum;
  if (typeof window === "undefined" || !injected) return null;
  return injected as unknown as Eip1193Provider;
}

export async function getWalletAddress(provider: Eip1193Provider): Promise<string | null> {
  try {
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[] | undefined;
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function getWalletChainId(provider: Eip1193Provider): Promise<number | null> {
  try {
    const hex = (await provider.request({ method: "eth_chainId" })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return null;
  }
}

export function isAddressLike(value: string): boolean {
  return isAddress(value.trim().toLowerCase() as Hex);
}

// ---------------------------------------------------------------------------
// Live gas price (real RPC data — never simulated)
// ---------------------------------------------------------------------------

/**
 * Fetch the current network gas price in gwei straight from the real BNB
 * Chain RPC (`eth_gasPrice`). Returns null when the RPC is unreachable so
 * callers can degrade gracefully instead of fabricating a price.
 */
export async function fetchGasPriceGwei(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_gasPrice",
        params: [],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string };
    const wei = BigInt(data.result ?? "0");
    return Number(wei) / 1e9; // wei -> gwei
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Calldata building
// ---------------------------------------------------------------------------

/**
 * ABI of the deploy-ready FlashBoltArbitrage contract (see Contract page).
 * Multi-asset: `loanAsset` is ANY deep-liquidity quote asset discovered in
 * the live market feed (WBNB, USDT, USDC, BTCB, …) — V2 pairs flash-swap
 * either side of a pair, so no asset is privileged on-chain.
 */
const FLASHBOLT_EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "loanAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "profit", type: "uint256" }],
  },
] as const;

/**
 * Encode `execute(address loanAsset, uint256 amount, address[] path, uint256 amountOutMin)`
 * calldata. `path` must start and end with `loanAsset`; the contract
 * flash-borrows `amount` of that asset, sweeps the legs, repays principal +
 * fee and reverts unless net profit clears the on-chain profit gate.
 */
export function buildExecuteData(
  loanAsset: Hex,
  amountWei: bigint,
  path: Hex[],
  amountOutMin: bigint,
): Hex {
  return encodeFunctionData({
    abi: FLASHBOLT_EXECUTE_ABI,
    functionName: "execute",
    args: [loanAsset, amountWei, path, amountOutMin],
  });
}

/**
 * Compute `amountOutMin` (in the loan asset's own decimals) for a route:
 * expected final asset after the profit spread, minus the configured
 * slippage tolerance. The principal is passed explicitly so stable-
 * denominated loans scale the same way as native-denominated ones.
 */
export function computeAmountOutMin(
  principalWei: bigint,
  profitPct: number,
  slippagePct: number,
): bigint {
  if (principalWei <= 0n) return 0n;
  const profitBps = Math.round(Math.max(0, profitPct) * 100); // 0.35% -> 35
  const multiplier = 10000 + profitBps; // 100.35% in bps
  const expectedWei = (principalWei * BigInt(multiplier)) / 10000n;
  const slipBps = Math.max(0, Math.min(10000, Math.round(Math.max(0, slippagePct) * 100)));
  return (expectedWei * BigInt(10000 - slipBps)) / 10000n;
}

// ---------------------------------------------------------------------------
// Hot-wallet submission helpers — the FlashBoltArbitrage contract gates
// execute() to the DEPLOYER (Ownable), so a hot wallet may only drive the
// flasher when it IS the deployer. These helpers verify that on-chain with a
// real owner() eth_call and estimate gas for the exact calldata — no gas is
// spent on either (both are read-only).
// ---------------------------------------------------------------------------

/** Left-pads an address to a 32-byte word for owner() return comparison. */
export function padAddressToWord(address: string): string {
  return `0x000000000000000000000000${address.toLowerCase().replace(/^0x/, "")}`;
}

/**
 * Read-only on-chain ownership check: does `address` own `contractAddress`?
 * A hot wallet that is NOT the deployer would have its tx reverted at the
 * onlyOwner gate — this catches that BEFORE any signature is produced.
 */
export async function isFlashBoltOwner(
  rpcUrl: string,
  contractAddress: string,
  address: string,
): Promise<boolean> {
  try {
    const { fetchWithTimeout } = await import("./fetch-timeout");
    const res = await fetchWithTimeout(rpcUrl, 8_000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data: "0x8da5cb5b" }, "latest"], // owner()
      }),
    });
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    const owner = (json.result ?? "").toLowerCase();
    return owner.length === 66 && owner === padAddressToWord(address);
  } catch {
    return false;
  }
}

/**
 * Real eth_estimateGas for the exact flash-loan calldata from the signing
 * address. Read-only — a revert here means the tx would fail and nothing
 * is signed or sent (the raced eth_call simulation remains the zero-gas gate).
 */
export async function estimateFlashLoanGas(
  rpcUrl: string,
  from: string,
  contractAddress: string,
  data: Hex,
): Promise<bigint> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(rpcUrl, 10_000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_estimateGas",
      params: [{ from, to: contractAddress, data }],
    }),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error || !json.result) {
    throw new Error(json.error?.message ?? "gas estimation unavailable");
  }
  // Pad ~20% over the estimate — flash-loan leg prices move between
  // estimate and inclusion; a too-tight gas cap aborts a live win.
  const estimated = BigInt(json.result);
  return (estimated * 120n) / 100n;
}

// ---------------------------------------------------------------------------
// Sending + confirmation
// ---------------------------------------------------------------------------

export interface FlashLoanReceipt {
  status: "success" | "reverted";
  txHash: Hex;
  blockNumber: number;
  gasUsed: string;
  /** Present on contract-creation receipts — the deployed contract address. */
  contractAddress?: string;
  /** Real gas cost in BNB: receipt gasUsed × the tx's actual gas price. */
  gasUsedBnb?: number;
}

/**
 * Minimal wallet-chain target (BNB networks and CHAIN_INFO entries are both
 * structurally compatible — chainId, label, rpc, explorerUrl, nativeSymbol).
 */
export interface WalletChainTarget {
  chainId: number;
  label: string;
  rpc: string;
  explorerUrl: string;
  nativeSymbol: string;
}

export interface SendFlashLoanParams {
  provider: Eip1193Provider;
  /** Target chain (BNB mainnet/testnet or any CHAIN_INFO chain). */
  chain: WalletChainTarget;
  from: string;
  contractAddress: string;
  data: Hex;
}

/** Switch the wallet to a target chain (adds the chain when missing). */
export async function ensureWalletChainId(
  provider: Eip1193Provider,
  chain: WalletChainTarget,
): Promise<void> {
  const targetHex = `0x${chain.chainId.toString(16)}`;
  const current = await getWalletChainId(provider);
  if (current === chain.chainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetHex }],
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetHex,
            chainName: chain.label,
            nativeCurrency: {
              name: chain.nativeSymbol,
              symbol: chain.nativeSymbol,
              decimals: 18,
            },
            rpcUrls: [chain.rpc],
            blockExplorerUrls: [chain.explorerUrl],
          },
        ],
      });
      return;
    }
    throw error;
  }
}

/** Switch the wallet to a BNB network (thin wrapper over ensureWalletChainId). */
export async function ensureWalletChain(
  provider: Eip1193Provider,
  network: NetworkKey,
): Promise<void> {
  await ensureWalletChainId(provider, BNB_NETWORKS[network]);
}

/** Send the flash-loan execution transaction via the injected wallet. */
export async function sendFlashLoanExecution({
  provider,
  chain,
  from,
  contractAddress,
  data,
}: SendFlashLoanParams): Promise<Hex> {
  await ensureWalletChainId(provider, chain);
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: contractAddress.trim().toLowerCase() as Hex,
        data,
        value: "0x0",
      },
    ],
  })) as Hex;
}

/**
 * Poll `eth_getTransactionReceipt` until the tx mines or the timeout passes.
 * Never fabricates a result — a reverted tx is reported as `reverted`.
 */
export async function waitForFlashLoanReceipt(
  provider: Eip1193Provider,
  txHash: Hex,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<FlashLoanReceipt> {
  const start = Date.now();
  let receipt: Record<string, string> | null = null;
  while (Date.now() - start < timeoutMs) {
    receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as Record<string, string> | null;
    if (receipt) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!receipt) {
    throw new Error("Timed out waiting for the transaction to be mined");
  }
  const status = receipt.status;
  if (status !== "0x1" && status !== "0x0") {
    throw new Error("Transaction has no final status yet");
  }
  // Real gas cost: receipt gasUsed × the tx's actual gas price (the receipt's
  // effectiveGasPrice when present, otherwise eth_getTransactionByHash).
  let gasUsedBnb: number | undefined;
  let contractAddress: string | undefined;
  try {
    if (typeof receipt.contractAddress === "string" && receipt.contractAddress) {
      contractAddress = receipt.contractAddress;
    }
    const gasPriceHex =
      receipt.effectiveGasPrice ??
      ((await provider.request({
        method: "eth_getTransactionByHash",
        params: [txHash],
      })) as { gasPrice?: string } | null)?.gasPrice;
    if (gasPriceHex) {
      gasUsedBnb = computeGasUsedBnb(receipt.gasUsed ?? "0x0", gasPriceHex);
    }
  } catch {
    // Gas cost is a nicety for analytics — it never blocks confirmation.
  }
  return {
    status: status === "0x1" ? "success" : "reverted",
    txHash,
    blockNumber: Number.parseInt(receipt.blockNumber ?? "0", 16),
    gasUsed: String(Number.parseInt(receipt.gasUsed ?? "0", 16)),
    contractAddress,
    gasUsedBnb,
  };
}

// ---------------------------------------------------------------------------
// One-click deployment (Contract page) + on-chain receipt lookup (History)
// ---------------------------------------------------------------------------

/**
 * Real gas cost in BNB: gasUsed × gasPrice (both hex strings). Overflow-safe
 * BigInt math, rounded to 6 decimals. Garbage input degrades to 0 instead of
 * throwing, so analytics never crash on malformed RPC replies.
 */
export function computeGasUsedBnb(gasUsedHex: string, gasPriceHex: string): number {
  try {
    const gasUsed = BigInt(gasUsedHex || "0x0");
    const gasPrice = BigInt(gasPriceHex || "0x0");
    const wei = gasUsed * gasPrice;
    const bnb = Number(wei / 10n ** 12n) / 1e6; // wei → BNB, 6-decimal precision
    return Math.round(bnb * 1e6) / 1e6;
  } catch {
    return 0;
  }
}

/**
 * Concatenate solc creation bytecode + ABI-encoded constructor args into the
 * exact deploy payload sent to eth_sendTransaction.
 */
export function buildDeployData(bytecode: Hex, constructorArgs: string): Hex {
  const code = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const args = constructorArgs.startsWith("0x")
    ? constructorArgs.slice(2)
    : constructorArgs;
  return `0x${(code + args).toLowerCase()}` as Hex;
}

export interface SendDeployParams {
  provider: Eip1193Provider;
  /** Target chain (BNB mainnet/testnet or any CHAIN_INFO chain). */
  chain: WalletChainTarget;
  from: string;
  data: Hex;
}

/**
 * Switch the wallet to the target chain and broadcast a contract-creation
 * transaction (bytecode + constructor args). Returns the tx hash — the
 * caller polls `waitForFlashLoanReceipt` for the deployed address.
 *
 * NOTE: this path is for INJECTED wallets (eth_sendTransaction — the
 * extension signs). The hot-wallet deploy path signs locally and uses
 * `sendSignedTransaction` from swap-executor.ts (private relay when
 * available), because EIP-1193 has no generic create-tx raw-send that
 * keeps the key inside the page.
 */
export async function sendDeployTransaction({
  provider,
  chain,
  from,
  data,
}: SendDeployParams): Promise<Hex> {
  await ensureWalletChainId(provider, chain);
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, data, value: "0x0" }],
  })) as Hex;
}

export interface OnChainReceipt {
  status: "success" | "reverted" | "pending";
  blockNumber: number;
  gasUsed: string;
  gasUsedBnb?: number;
  /** Present on contract-creation receipts — the deployed contract address. */
  contractAddress?: string;
}

/**
 * Read the real receipt for a tx hash straight from the BNB RPC (CORS-open
 * public endpoints, same source the gas estimator uses). Returns null on
 * network failure and "pending" while the tx is unmined — never fabricated.
 */
export async function fetchTransactionReceipt(
  rpcUrl: string,
  txHash: Hex,
): Promise<OnChainReceipt | null> {
  try {
    const post = async (method: string, params: unknown[]) => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: unknown };
      return data.result ?? null;
    };
    const receipt = (await post("eth_getTransactionReceipt", [txHash])) as Record<
      string,
      string
    > | null;
    if (!receipt) {
      return { status: "pending", blockNumber: 0, gasUsed: "0x0" };
    }
    const status: OnChainReceipt["status"] =
      receipt.status === "0x1"
        ? "success"
        : receipt.status === "0x0"
          ? "reverted"
          : "pending";
    const gasUsed = receipt.gasUsed ?? "0x0";
    let gasUsedBnb: number | undefined;
    const gasPriceHex =
      receipt.effectiveGasPrice ??
      ((await post("eth_getTransactionByHash", [txHash])) as {
        gasPrice?: string;
      } | null)?.gasPrice;
    if (gasPriceHex) {
      gasUsedBnb = computeGasUsedBnb(gasUsed, gasPriceHex);
    }
    return {
      status,
      blockNumber: Number.parseInt(receipt.blockNumber ?? "0x0", 16),
      gasUsed,
      gasUsedBnb,
      contractAddress:
        typeof receipt.contractAddress === "string" &&
        receipt.contractAddress &&
        receipt.contractAddress !== "0x0000000000000000000000000000000000000000"
          ? receipt.contractAddress
          : undefined,
    };
  } catch {
    return null;
  }
}
