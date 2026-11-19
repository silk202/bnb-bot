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
  fetchJitoTipAccounts,
  pickJitoTipAccount,
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

describe("Jito tip accounts", () => {
  test("are fetched from the block engine (not hard-coded) and cached per engine", async () => {
    installFetch((url, body) => {
      expect(String(url)).toContain("/api/v1/bundles");
      expect((body as { method: string }).method).toBe("getTipAccounts");
      return { result: ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"] };
    });
    const first = await fetchJitoTipAccounts("https://tip-cache.example");
    expect(first).toHaveLength(1);
    await fetchJitoTipAccounts("https://tip-cache.example");
    expect(fetchCalls).toHaveLength(1); // second call served from cache
  });

  test("an empty list is a refusal, not a silent untipped submission", async () => {
    installFetch(() => ({ result: [] }));
    expect(fetchJitoTipAccounts("https://tip-empty.example")).rejects.toThrow(
      "no tip accounts",
    );
  });

  test("attaches a real System-transfer tip to the unsigned bytes", async () => {
    const { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } = await import(
      "@solana/web3.js"
    );
    const { Buffer } = await import("buffer");
    const payer = Keypair.generate();
    const tipAccount = Keypair.generate().publicKey;
    installFetch(() => ({ result: [tipAccount.toBase58()] }));

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const unsigned = new VersionedTransaction(message);
    unsigned.signatures = [new Uint8Array(64)];
    const base64 = Buffer.from(unsigned.serialize()).toString("base64");

    const out = await import("./solana-jito").then((m) =>
      m.addJitoTipToUnsignedTx(base64, {
        payer: payer.publicKey.toBase58(),
        rpcUrl: "https://unused.example",
        engines: ["https://tip-engine.example"],
        tipLamports: 1_000,
      }),
    );
    expect(out.tipLamports).toBe(1_000);

    const after = VersionedTransaction.deserialize(Buffer.from(out.txBase64, "base64"));
    expect(after.message.compiledInstructions).toHaveLength(2);
    const tipIx = after.message.compiledInstructions[1]!;
    expect(after.message.staticAccountKeys[tipIx.programIdIndex]!.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(new DataView(tipIx.data.buffer, tipIx.data.byteOffset, 4).getUint32(0, true)).toBe(2);
    expect(after.signatures).toHaveLength(1);
  });

  test("the pick stays inside the fetched list for every seed", () => {
    const accounts = ["tip-a", "tip-b", "tip-c"];
    expect(pickJitoTipAccount(accounts, 0)).toBe("tip-a");
    expect(pickJitoTipAccount(accounts, 0.999999)).toBe("tip-c");
    expect(pickJitoTipAccount(accounts, Number.NaN)).toBe("tip-a");
    expect(() => pickJitoTipAccount([], 0.5)).toThrow("no Jito tip accounts");
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
