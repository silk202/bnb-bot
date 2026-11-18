/**
 * Cluster / RPC endpoint map + public-RPC submission tests.
 *
 * Verifies: endpoint table shape, resolveSolRpcUrl override behavior,
 * solSubmissionPath relay selection, and solSendPublicTx honest behavior
 * (real JSON-RPC POST, error surfacing, signature extraction).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  JITO_BLOCK_ENGINES,
  SOL_CLUSTER_LABEL,
  SOL_RPC_ENDPOINTS,
  resolveSolRpcUrl,
  solSendPublicTx,
  solSubmissionPath,
} from "./solana-jito";

const realFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];

function installFetch(handler: (url: string, body: unknown) => unknown | Promise<unknown>) {
  fetchCalls.length = 0;
  // @ts-expect-error — minimal test double
  globalThis.fetch = async (url: string | URL, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    fetchCalls.push({ url: String(url), body });
    const out = await handler(String(url), body);
    return {
      ok: true,
      status: 200,
      json: async () => out,
    };
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SOL cluster endpoint map", () => {
  test("official endpoints are the documented public RPCs", () => {
    expect(SOL_RPC_ENDPOINTS.mainnet).toBe("https://api.mainnet-beta.solana.com");
    expect(SOL_RPC_ENDPOINTS.testnet).toBe("https://api.devnet.solana.com");
  });

  test("cluster labels are human-readable", () => {
    expect(SOL_CLUSTER_LABEL.mainnet).toContain("Mainnet");
    expect(SOL_CLUSTER_LABEL.testnet).toContain("Devnet");
  });

  test("resolveSolRpcUrl honors per-cluster overrides and falls back cleanly", () => {
    expect(resolveSolRpcUrl("mainnet")).toBe(SOL_RPC_ENDPOINTS.mainnet);
    // Overrides are keyed by cluster ("mainnet" | "testnet").
    expect(resolveSolRpcUrl("testnet", { testnet: "https://my-node.example" })).toBe(
      "https://my-node.example",
    );
    // Empty override = official endpoint.
    expect(resolveSolRpcUrl("mainnet", { mainnet: "" })).toBe(SOL_RPC_ENDPOINTS.mainnet);
    // Override for a different cluster is ignored.
    expect(resolveSolRpcUrl("testnet", { mainnet: "https://my-node.example" })).toBe(
      SOL_RPC_ENDPOINTS.testnet,
    );
  });

  test("submission path: mainnet = Jito engines, testnet = public RPC", () => {
    const main = solSubmissionPath("mainnet");
    expect(main.relay).toBe("jito");
    expect(main.engines).toEqual(JITO_BLOCK_ENGINES.mainnet);

    const test = solSubmissionPath("testnet");
    expect(test.relay).toBe("public-rpc");
    expect(test.engines).toHaveLength(0);
  });
});

describe("solSendPublicTx", () => {
  test("posts a real JSON-RPC sendTransaction with skipPreflight and returns the signature", async () => {
    installFetch(() => ({ result: "5SigAbcDef" }));

    const out = await solSendPublicTx("SGNBASE64==", { rpcUrl: "https://api.devnet.solana.com" });
    expect(out.id).toBe("5SigAbcDef");
    expect(out.engine).toBe("https://api.devnet.solana.com");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.devnet.solana.com");
    const body = fetchCalls[0].body as { method: string; params: unknown[] };
    expect(body.method).toBe("sendTransaction");
    expect(body.params[0]).toBe("SGNBASE64==");
    expect(body.params[1]).toEqual({
      encoding: "base64",
      skipPreflight: true,
      maxRetries: 0,
    });
  });

  test("surfaces RPC errors honestly instead of fabricating a signature", async () => {
    installFetch(() => ({ error: { message: "invalid transaction" } }));
    expect(solSendPublicTx("SGNBASE64==")).rejects.toThrow("invalid transaction");
  });

  test("a missing result is an error, never a fake hash", async () => {
    installFetch(() => ({}));
    expect(solSendPublicTx("SGNBASE64==")).rejects.toThrow("no transaction signature");
  });
});
