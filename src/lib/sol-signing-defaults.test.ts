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
import {
  executeLiveArb,
  executeLiveSnipeBuy,
  executeLiveSnipeSell,
} from "./solana-live-execution";
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
 * The other half: an EXIT takes no rail settings and consults no gate, because
 * this module builds a Jupiter sell and nothing else. A rail switch must not be
 * able to strand a position on chain, and there is no setting an older client
 * can send to withhold a close. These cases stop at the signer boundary and the
 * balance read — which is exactly where a gate refusal would have returned
 * `engine: "rail-gate"` instead.
 */
describe("signing gate — an exit is never refused by a rail switch", () => {
  test("an exit runs with no rail settings at all", async () => {
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

  test("an exit passes the engine check and reaches the real balance read", async () => {
    const armed: SolSigningProvider = {
      publicKey: { toString: () => "11111111111111111111111111111111" },
      signTransaction: async () => {
        throw new Error("nothing may be signed without a balance");
      },
    };
    const out = await executeLiveSnipeSell({
      mint: MINT,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
      provider: armed,
    });
    expect(out.ok).toBe(false);
    expect(out.error).not.toBe("no-wallet");
    expect(out.error).not.toContain("rail");
  });
});

/**
 * The OPEN path on the arbitrage engine: no persisted settings, or a rail that
 * is not Jupiter, must refuse BEFORE the signer is resolved. Passing no
 * provider at all is what makes that ordering observable — the refusal comes
 * back even though this environment has no wallet.
 */
describe("signing gate — arb refuses before a signer exists", () => {
  test("no rail settings means no route", async () => {
    const out = await executeLiveArb({
      mint: MINT,
      loanLamports: 100_000_000,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
    });
    expect(out.ok).toBe(false);
    expect(out.engine).toBe("rail-gate");
    expect(out.walletRole).toBe("none");
    expect(out.error).toContain("nothing was signed");
    expect(out.error).toContain("unknown engine");
  });

  test("an armed contract rail refuses the Jupiter route", async () => {
    const out = await executeLiveArb({
      mint: MINT,
      loanLamports: 100_000_000,
      slippageBps: 50,
      solRpcUrl: "http://127.0.0.1:1",
      railSettings: {
        rail: "solcontract",
        cluster: "testnet",
        programId: SOL_PROGRAM_ID_PIN,
        authorized: true,
        auditApproved: false,
      },
    });
    expect(out.ok).toBe(false);
    expect(out.engine).toBe("rail-gate");
    expect(out.error).toContain("the active rail is solcontract");
  });
});
