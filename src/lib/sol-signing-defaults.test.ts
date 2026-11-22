/**
 * The tightened default, exercised where it actually runs.
 *
 * `executeLiveSnipeBuy` used to fall back to the Jupiter rail when its caller
 * supplied no settings, so an older client (or a tab whose settings had not
 * loaded) could sign a real swap on an engine the operator never selected. The
 * refusal must happen BEFORE the quote, the signer and the simulation — hence
 * a dead RPC URL here: reaching the network at all would fail differently.
 */
import { describe, expect, test } from "bun:test";
import { executeLiveSnipeBuy, executeLiveSnipeSell } from "./solana-live-execution";
import type { SolSigningProvider } from "./solana-live-execution";
import { SOL_PROGRAM_ID_PIN } from "./sol-rail-gate";

const MINT = "So11111111111111111111111111111111111111112";

/**
 * A signer that exists but holds no key: the exit reaches the signer lookup,
 * which is exactly what proves the gate let it through. `signTransaction`
 * throwing means a test can never sign even if the path somehow got that far.
 */
const NO_WALLET: SolSigningProvider = {
  publicKey: null,
  signTransaction: async () => {
    throw new Error("an exit must never reach the wallet in these tests");
  },
};

describe("signing gate default — buy without rail settings", () => {
  test("refuses before a signer or a quote is resolved", async () => {
    const out = await executeLiveSnipeBuy({
      mint: MINT,
      amountLamports: 10_000_000,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1", // unreachable on purpose
    });
    expect(out.ok).toBe(false);
    expect(out.engine).toBe("rail-gate");
    expect(out.error).toContain("nothing was signed");
    expect(out.error).toContain("unknown engine");
  });

  test("still refuses when the settings row exists but the rail is not Jupiter", async () => {
    const out = await executeLiveSnipeBuy({
      mint: MINT,
      amountLamports: 10_000_000,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
      railSettings: {
        rail: "solcontract",
        cluster: "testnet",
        programId: "82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd",
        authorized: true,
        auditApproved: false,
      },
    });
    expect(out.ok).toBe(false);
    expect(out.engine).toBe("rail-gate");
    expect(out.error).toContain("the active rail is solcontract");
  });
});

/**
 * The other half of the tightened default: an EXIT keeps a fixed Jupiter rail
 * when the caller supplies no settings, so a live position is never stranded
 * on chain by a rail switch. These tests stop at the signer boundary — the
 * provider has no key — which is precisely where a gate refusal would have
 * returned `engine: "rail-gate"` instead.
 */
describe("signing gate default — exit keeps the position rail", () => {
  test("an exit with no settings is not refused by the gate", async () => {
    const out = await executeLiveSnipeSell({
      mint: MINT,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1", // unreachable on purpose
      provider: NO_WALLET,
    });
    expect(out.engine).not.toBe("rail-gate");
    expect(out.engine).toBe("none");
    expect(out.error).toBe("no-wallet");
  });

  test("an exit still runs while the operator has armed flash arbitrage", async () => {
    const out = await executeLiveSnipeSell({
      mint: MINT,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
      provider: NO_WALLET,
      railSettings: {
        rail: "solcontract",
        cluster: "testnet",
        programId: SOL_PROGRAM_ID_PIN,
        authorized: true,
        auditApproved: false,
      },
    });
    expect(out.engine).toBe("none");
    expect(out.error).toBe("no-wallet");
  });

  test("an exit with explicit Jupiter settings behaves the same", async () => {
    const out = await executeLiveSnipeSell({
      mint: MINT,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
      provider: NO_WALLET,
      railSettings: { rail: "jupiter", cluster: "testnet" },
    });
    expect(out.engine).toBe("none");
    expect(out.error).toBe("no-wallet");
  });
});
