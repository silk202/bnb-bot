import { describe, expect, test } from "bun:test";
import {
  assertChainMatch,
  assertExecutionAllowed,
  listNetworks,
  NETWORKS,
  providerCount,
} from "../network-registry";
import { ChainIdMismatchError, RpcManager, UncertainBroadcastError } from "../rpc-manager";

describe("network registry", () => {
  test("mainnet and testnet chain ids match the published table", () => {
    expect(NETWORKS.bsc.mainnet.chainId).toBe(56);
    expect(NETWORKS.bsc.testnet.chainId).toBe(97);
    expect(NETWORKS.ethereum.mainnet.chainId).toBe(1);
    expect(NETWORKS.ethereum.testnet.chainId).toBe(11155111);
    expect(NETWORKS.arbitrum.mainnet.chainId).toBe(42161);
    expect(NETWORKS.arbitrum.testnet.chainId).toBe(421614);
    expect(NETWORKS.polygon.mainnet.chainId).toBe(137);
    expect(NETWORKS.polygon.testnet.chainId).toBe(80002);
  });

  test("every network is defined for both modes, with distinct ids", () => {
    for (const mode of ["mainnet", "testnet"] as const) {
      const list = listNetworks(mode);
      expect(list).toHaveLength(4);
      expect(new Set(list.map((n) => n.chainId)).size).toBe(4);
    }
  });

  test("execution is gated on validated contracts, not on RPC availability", () => {
    expect(() => assertExecutionAllowed(NETWORKS.bsc.mainnet)).not.toThrow();
    for (const def of [
      NETWORKS.bsc.testnet,
      NETWORKS.ethereum.mainnet,
      NETWORKS.arbitrum.mainnet,
      NETWORKS.polygon.mainnet,
    ]) {
      expect(def.endpoints.length).toBeGreaterThan(0); // reachable…
      expect(() => assertExecutionAllowed(def)).toThrow(/not enabled/i); // …but not signing
    }
  });

  test("a mainnet config cannot run on a testnet wallet chain", () => {
    expect(() => assertChainMatch(NETWORKS.bsc.mainnet, 56)).not.toThrow();
    expect(() => assertChainMatch(NETWORKS.bsc.mainnet, 97)).toThrow(/Chain mismatch/);
    expect(() => assertChainMatch(NETWORKS.bsc.testnet, 56)).toThrow(/Chain mismatch/);
  });

  test("independence counts operators, not hostnames", () => {
    const def = { ...NETWORKS.bsc.mainnet, endpoints: [
      { url: "https://a.publicnode.com", provider: "publicnode" },
      { url: "https://b.publicnode.com", provider: "publicnode" },
      { url: "https://x.drpc.org", provider: "drpc" },
    ] };
    expect(providerCount(def)).toBe(2);
  });
});

const BSC = NETWORKS.bsc.mainnet;

function manager(transport: (url: string, method: string, params: unknown[]) => Promise<unknown>, extra = {}) {
  return new RpcManager(BSC, { transport: transport as never, confirmWindowMs: 0, ...extra });
}

describe("rpc manager", () => {
  test("rejects an endpoint whose chain id does not match", async () => {
    const mgr = manager(async (_url, method) => (method === "eth_chainId" ? "0x61" : "0x0"));
    const states = await mgr.healthCheck();
    expect(states.some((s) => s.chainIdOk)).toBe(false);
    expect(states[0].lastError).toContain("reports chain 97, expected 56");
  });

  test("call fails over to a healthy endpoint", async () => {
    const seen: string[] = [];
    const mgr = manager(async (url, method) => {
      if (method === "eth_chainId") return "0x38";
      seen.push(url);
      if (seen.length === 1) throw new Error("timeout");
      return "0x10";
    });
    await mgr.healthCheck();
    expect(await mgr.call<string>("eth_blockNumber", [])).toBe("0x10");
    expect(seen.length).toBe(2);
  });

  test("chain-id mismatch is surfaced as a typed error", async () => {
    const mgr = manager(async (_url, method) => (method === "eth_chainId" ? "0x1" : "0x0"));
    const [state] = await mgr.healthCheck();
    expect(state.chainIdOk).toBe(false);
    expect(new ChainIdMismatchError("u", 56, 1).message).toContain("expected 56");
  });

  test("a broadcast whose status is uncertain is not resent elsewhere", async () => {
    let sends = 0;
    const mgr = manager(async (_url, method) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_sendRawTransaction") {
        sends += 1;
        throw new Error("socket hang up");
      }
      return null; // getTransactionByHash: unknown everywhere
    });
    await mgr.healthCheck();
    await expect(mgr.broadcast("0xabc", "0xraw")).rejects.toBeInstanceOf(UncertainBroadcastError);
    expect(sends).toBeGreaterThan(1); // each candidate tried once…
  });

  test("after a failed send, a hash found on chain means success — no second send", async () => {
    let sends = 0;
    const mgr = manager(async (_url, method) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_sendRawTransaction") {
        sends += 1;
        throw new Error("timeout");
      }
      return { hash: "0xabc" }; // the tx IS on chain
    });
    await mgr.healthCheck();
    const res = await mgr.broadcast("0xabc", "0xraw");
    expect(res.hash).toBe("0xabc");
    expect(sends).toBe(1);
  });

  test("'already known' counts as broadcast success", async () => {
    const mgr = manager(async (_url, method) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_sendRawTransaction") throw new Error("already known");
      return null;
    });
    await mgr.healthCheck();
    await expect(mgr.broadcast("0xabc", "0xraw")).resolves.toMatchObject({ hash: "0xabc" });
  });
});
