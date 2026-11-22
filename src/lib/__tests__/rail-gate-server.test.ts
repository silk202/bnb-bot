/**
 * Server-side tests for the execution-rail write gate.
 *
 * These call `gateSolRailWrite` — the exact function `terminal.setSettings`
 * calls before it patches the row — so they cover the path a direct mutation
 * call (or an older client) would take, not just what the UI allows.
 */
import { describe, expect, test } from "bun:test";
import { gateSolRailWrite } from "../../convex/rail-gate";
import { SOL_PROGRAM_ID_PIN } from "../sol-rail-gate";

const PIN = SOL_PROGRAM_ID_PIN;
const OTHER = "9xQeWvG816bUx9EPfWtbJb2n9dWVnJ4r3RxjKZQmVJ6c";

describe("gateSolRailWrite — activation in one save", () => {
  test("arming the contract rail with the pin, authorization and a devnet cluster passes", () => {
    const out = gateSolRailWrite(
      { solExecutionRail: "jupiter", solNetwork: "testnet" },
      {
        solExecutionRail: "solcontract",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
    );
    expect(out.gated).toBe(true);
    expect(out.error).toBeNull();
    expect(out.verdict?.ok).toBe(true);
    expect(out.merged.rail).toBe("solcontract");
    expect(out.merged.programId).toBe(PIN);
  });

  test("arming without a program ID is refused with the deployment reason", () => {
    const out = gateSolRailWrite(
      { solExecutionRail: "jupiter", solNetwork: "testnet" },
      { solExecutionRail: "solcontract", solContractAuthorized: true },
    );
    expect(out.error).toContain("no FlashboltSolana program ID");
    expect(out.error).toContain("Nothing was saved");
  });

  test("arming without the operator authorization is refused", () => {
    const out = gateSolRailWrite(
      { solExecutionRail: "jupiter", solNetwork: "testnet" },
      { solExecutionRail: "solcontract", solContractProgramId: PIN },
    );
    expect(out.error).toContain("not authorized for the vault wallet");
  });

  test("mainnet activation stays refused until the audit sign-off is on", () => {
    const out = gateSolRailWrite(
      { solExecutionRail: "jupiter", solNetwork: "mainnet" },
      {
        solExecutionRail: "solcontract",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
    );
    expect(out.error).toContain("independent audit sign-off");
  });
});

describe("gateSolRailWrite — the activation hole stays closed", () => {
  test("re-pointing an already-armed rail at another program is refused", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "testnet",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
      { solContractProgramId: OTHER },
    );
    // Gated even though the patch never mentions the rail: the merged rail is
    // still solcontract, so a bad ID cannot be written under it.
    expect(out.gated).toBe(true);
    expect(out.error).toContain("is not the pinned FlashboltSolana address");
    expect(out.verdict?.ok).toBe(false);
  });

  test("clearing the program ID on an armed rail is refused", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "testnet",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
      { solContractProgramId: "" },
    );
    expect(out.error).toContain("no FlashboltSolana program ID");
  });

  test("de-authorizing an armed rail is refused (no half-armed state)", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "testnet",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
      { solContractAuthorized: false },
    );
    expect(out.error).toContain("not authorized for the vault wallet");
  });

  test("switching an armed rail to mainnet without the audit is refused", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "testnet",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
      { solNetwork: "mainnet" },
    );
    expect(out.error).toContain("independent audit sign-off");
  });

  test("an armed rail can always be returned to Jupiter", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "mainnet",
        solContractProgramId: OTHER,
        solContractAuthorized: false,
      },
      { solExecutionRail: "jupiter" },
    );
    expect(out.error).toBeNull();
    expect(out.merged.rail).toBe("jupiter");
  });
});

describe("gateSolRailWrite — unrelated saves are never gated", () => {
  test("a Jupiter save is not gated", () => {
    const out = gateSolRailWrite(
      { solExecutionRail: "jupiter", solNetwork: "mainnet" },
      { solExecutionRail: "jupiter" },
    );
    expect(out.gated).toBe(true);
    expect(out.error).toBeNull();
    expect(out.verdict).toBeNull();
  });

  test("slippage/venue saves skip the gate even when the stored rail is armed", () => {
    const out = gateSolRailWrite(
      {
        solExecutionRail: "solcontract",
        solNetwork: "testnet",
        solContractProgramId: PIN,
        solContractAuthorized: true,
      },
      {},
    );
    expect(out.gated).toBe(false);
    expect(out.error).toBeNull();
    expect(out.merged.rail).toBe("solcontract");
  });
});
