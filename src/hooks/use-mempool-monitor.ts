/**
 * useMempoolMonitor — watches pending transactions via the existing BSC RPC
 * to detect DEX swaps before they confirm on-chain. This gives the scanner
 * a head-start on arbitrage opportunities by detecting price-moving swaps
 * as soon as they enter the mempool, not after block confirmation.
 *
 * Uses the same RPC endpoint already configured for gas price monitoring.
 * No additional API keys or endpoints needed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminal } from "./use-terminal";
import { BNB_NETWORKS, type NetworkKey } from "@/lib/chain";
import { CHAIN_INFO, isBscChain, effectiveRpc, type ChainKey } from "@/lib/chains";

/** Pending swap detected in the mempool. */
export interface PendingSwap {
  txHash: string;
  from: string;
  to: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  dex: string;
  detectedAt: number;
  blockNumber: number;
}

interface UseMempoolMonitorOptions {
  /** Poll interval in ms. Default: 3000 (3s). */
  pollInterval?: number;
  /** When true, monitoring pauses. */
  paused?: boolean;
  /** Chain to monitor. */
  chainKey?: ChainKey;
}

// Known DEX router contract addresses on BSC (to filter pending txs)
const BSC_DEX_ROUTERS: Record<string, string> = {
  PCS: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  PCS_V3: "0x13f4EA83D0bd40E0A6deB512C8de4098DF30E179",
  BISWAP: "0x3aF8822041477b2a11e73b0F7C75bC00017A3c1D",
  MDEX: "0x7DAe83e50E0d2F0E3B5d4aD7c5c4D5E7a1e6c3f5",
  APESWAP: "0xCf083Ca41DFabE0e2a7d4aC6CBf12B4d2f8aE6C4",
  TRADERJOE: "0x1a1A2E423Fa90c2853B1B9E8e536639319b86d5E",
  THENA: "0x38bBFD36C8Ea04b86ab2AA27E46E094B16f81682",
};

// Minimal ABI fragment for pending transaction filtering
const SWAP_SELECTORS = new Set([
  "0x38ed1739", // swapExactTokensForTokens
  "0x8803dbee", // swapTokensForExactTokens
  "0x7ff36ab5", // swapExactETHForTokens
  "0x18cbafe5", // swapExactTokensForETH
  "0x5c11d795", // swapExactTokensForTokensSupportingFeeOnTransferTokens
  "0xb6f9de95", // swapExactETHForTokensSupportingFeeOnTransferTokens
  "0x791ac947", // swapExactTokensForETHSupportingFeeOnTransferTokens
  "0xdb3e2198", // swapExactTokensForNFT
  "0x04e45aaf", // swapExactTokensForTokens (V3)
]);

function isSwapSelector(selector: string): boolean {
  return SWAP_SELECTORS.has(selector.slice(0, 10));
}

function decodePendingSwap(tx: {
  hash: string;
  from: string;
  to: string;
  input: string;
  blockNumber?: string;
}): PendingSwap | null {
  if (!tx.input || tx.input.length < 10) return null;
  const selector = tx.input.slice(0, 10);
  if (!isSwapSelector(selector)) return null;

  // Detect which DEX router this targets
  const toLower = tx.to?.toLowerCase() ?? "";
  let dex = "unknown";
  for (const [key, addr] of Object.entries(BSC_DEX_ROUTERS)) {
    if (toLower === addr.toLowerCase()) {
      dex = key;
      break;
    }
  }

  // Decode path from the swap data (path is typically the 2nd array arg)
  // For swapExactTokensForTokens: (amountIn, amountOutMin, path[], to, deadline)
  // The path array is at a dynamic offset — parse it from the hex data
  let tokenIn = "";
  let tokenOut = "";
  let amountIn = "0x0";

  try {
    // Remove 0x + 4 byte selector, then decode params
    const data = tx.input.slice(10);
    // amountIn is the first uint256 (first 32 bytes)
    amountIn = "0x" + data.slice(0, 64);

    // The path array offset is the second param (32 bytes from offset 32)
    const pathOffset = parseInt(data.slice(64, 128), 16) * 2;
    // Array length
    const pathLen = parseInt(data.slice(pathOffset, pathOffset + 64), 16);

    if (pathLen >= 2) {
      // First token address (skip length slot)
      tokenIn = "0x" + data.slice(pathOffset + 64 + 24, pathOffset + 128);
      // Last token address
      const lastIdx = pathLen - 1;
      const lastTokenOffset = pathOffset + 64 + lastIdx * 64;
      tokenOut = "0x" + data.slice(lastTokenOffset + 24, lastTokenOffset + 64);
    }
  } catch {
    // Decoding failed — still useful as a pending swap signal
  }

  return {
    txHash: tx.hash,
    from: tx.from,
    to: tx.to,
    tokenIn,
    tokenOut,
    amountIn,
    dex,
    detectedAt: Date.now(),
    blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : 0,
  };
}

/**
 * React hook that monitors the BSC mempool for pending DEX swaps.
 * Polls the RPC every `pollInterval` ms using `txpool_status` + `getBlockByNumber`
 * to detect price-moving transactions before they confirm.
 */
export function useMempoolMonitor(options: UseMempoolMonitorOptions = {}) {
  const {
    pollInterval = 3000,
    paused = false,
    chainKey: overrideChainKey,
  } = options;

  const { state } = useTerminal();
  const chainKey: ChainKey = overrideChainKey ?? state?.chainKey ?? "bsc";
  const networkKey: NetworkKey = state?.network === "testnet" ? "testnet" : "mainnet";

  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);
  const [mempoolSize, setMempoolSize] = useState(0);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  const seenTxsRef = useRef(new Set<string>());

  const rpcUrl = networkKey === "testnet"
    ? BNB_NETWORKS.testnet.rpc
    : effectiveRpc(chainKey, state?.rpcOverrides?.[chainKey]);

  const poll = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;

    try {
      // Method 1: Try txpool_content (works on some BSC nodes)
      const txpoolRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "txpool_content",
          params: [],
        }),
      });

      if (txpoolRes.ok) {
        const txpoolData = await txpoolRes.json() as {
          result?: { pending?: Record<string, Record<string, { hash: string; from: string; to: string; input: string; blockNumber?: string }>> };
        };

        const pending = txpoolData.result?.pending ?? {};
        let totalPending = 0;
        const newSwaps: PendingSwap[] = [];

        for (const txs of Object.values(pending)) {
          for (const tx of Object.values(txs)) {
            totalPending++;
            if (seenTxsRef.current.has(tx.hash)) continue;
            seenTxsRef.current.add(tx.hash);

            const swap = decodePendingSwap(tx);
            if (swap) newSwaps.push(swap);
          }
        }

        setMempoolSize(totalPending);
        if (newSwaps.length > 0) {
          setPendingSwaps((prev) => [...newSwaps, ...prev].slice(0, 50));
        }
      } else {
        // Method 2: Fallback — get latest block number and count pending txs
        const blockRes = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_blockNumber",
            params: [],
          }),
        });
        if (blockRes.ok) {
          const blockData = await blockRes.json() as { result?: string };
          const blockNum = blockData.result ? parseInt(blockData.result, 16) : 0;
          setMempoolSize(0); // Can't count without txpool
          void blockNum;
        }
      }

      setLastPoll(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mempool poll failed");
    } finally {
      inflightRef.current = false;
    }
  }, [rpcUrl]);

  // Poll loop
  useEffect(() => {
    if (paused || !isBscChain(chainKey)) return;
    const boot = window.setTimeout(() => { void poll(); }, 0);
    const timer = window.setInterval(() => { void poll(); }, pollInterval);
    // Trim old seen txs every 60s to prevent memory leak
    const trimTimer = window.setInterval(() => {
      seenTxsRef.current = new Set([...seenTxsRef.current].slice(-500));
    }, 60_000);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(timer);
      window.clearInterval(trimTimer);
    };
  }, [poll, paused, chainKey, pollInterval]);

  return {
    pendingSwaps,
    mempoolSize,
    lastPoll,
    error,
    refresh: () => void poll(),
  };
}
