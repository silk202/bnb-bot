/**
 * Generic EVM adapter.
 *
 * One implementation serves every network; chain-specific behaviour is data in
 * the registry (addresses, venues, fees), not forked code. That is what keeps a
 * testnet on the same execution path as its mainnet instead of a simplified
 * copy.
 */
import { keccak256 } from "viem";
import type { NetworkConfig } from "../registry/chain-types";
import { rpcCall } from "@/lib/json-rpc";

export interface EvmAdapter {
  network: NetworkConfig;
  rpcUrl: string;
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  code(address: string): Promise<string>;
  bytecodeHash(address: string): Promise<string>;
  call(to: string, data: string): Promise<string>;
  estimateGas(tx: { from: string; to: string; data: string; value?: string }): Promise<bigint>;
  gasPrice(): Promise<bigint>;
}

type Transport = <T>(url: string, method: string, params: unknown[], timeoutMs?: number) => Promise<T>;

export function createEvmAdapter(
  network: NetworkConfig,
  rpcUrl: string,
  transport: Transport = rpcCall,
): EvmAdapter {
  const call = <T>(method: string, params: unknown[]) => transport<T>(rpcUrl, method, params);

  return {
    network,
    rpcUrl,
    async chainId() {
      return Number.parseInt(await call<string>("eth_chainId", []), 16);
    },
    async blockNumber() {
      return Number.parseInt(await call<string>("eth_blockNumber", []), 16);
    },
    async code(address) {
      return await call<string>("eth_getCode", [address, "latest"]);
    },
    async bytecodeHash(address) {
      const code = await this.code(address);
      if (!code || code === "0x") throw new Error(`${address} has no code on ${network.name}.`);
      return keccak256(code as `0x${string}`);
    },
    async call(to, data) {
      return await call<string>("eth_call", [{ to, data }, "latest"]);
    },
    async estimateGas(tx) {
      return BigInt(
        await call<string>("eth_estimateGas", [
          { from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: tx.value } : {}) },
        ]),
      );
    },
    async gasPrice() {
      return BigInt(await call<string>("eth_gasPrice", []));
    },
  };
}

/** A chain-id check that must succeed before any adapter is used for signing. */
export async function verifyAdapterChain(adapter: EvmAdapter): Promise<void> {
  const observed = await adapter.chainId();
  if (observed !== adapter.network.chainId) {
    throw new Error(
      `Adapter chain mismatch on ${adapter.rpcUrl}: reported ${observed}, expected ${adapter.network.chainId}.`,
    );
  }
}
