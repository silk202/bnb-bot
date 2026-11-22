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
import { executeLiveSnipeBuy } from "./solana-live-execution";

const MINT = "So11111111111111111111111111111111111111112";

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
