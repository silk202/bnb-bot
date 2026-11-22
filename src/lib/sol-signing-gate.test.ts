/**
 * Signing-gate tests — the check that runs before a key touches a transaction.
 *
 * `solSigningVerdict` is called by every live execution entry point
 * (`executeLiveArb`, `executeLiveSnipeBuy`, `executeLiveSnipeSell`) with the
 * operator's persisted settings, so these cases are the engine boundary rather
 * than a UI convenience.
 */
import { describe, expect, test } from "bun:test";
import { SOL_PROGRAM_ID_PIN, solSigningVerdict } from "./sol-rail-gate";

const ARMED_CONTRACT = {
  rail: "solcontract" as const,
  cluster: "testnet" as const,
  programId: SOL_PROGRAM_ID_PIN,
  authorized: true,
  auditApproved: false,
};

describe("solSigningVerdict — Jupiter engine", () => {
  test("signs when Jupiter is the armed rail", () => {
    const v = solSigningVerdict({
      engine: "jupiter",
      rail: "jupiter",
      cluster: "mainnet",
    });
    expect(v.ok).toBe(true);
    expect(v.message).toContain("Jupiter signing armed");
  });

  test("refuses to sign a swap while flash arbitrage is the armed rail", () => {
    const v = solSigningVerdict({
      engine: "jupiter",
      ...ARMED_CONTRACT,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers).toHaveLength(1);
    expect(v.message).toContain("the active rail is solcontract");
    expect(v.message).toContain("Nothing was signed or spent");
  });

  test("devnet and mainnet both arm the Jupiter engine (no program needed)", () => {
    for (const cluster of ["mainnet", "testnet"] as const) {
      expect(
        solSigningVerdict({ engine: "jupiter", rail: "jupiter", cluster }).ok,
      ).toBe(true);
    }
  });
});

describe("solSigningVerdict — flash arbitrage engine", () => {
  test("refuses while the rail itself is not armed", () => {
    const v = solSigningVerdict({
      engine: "solcontract",
      rail: "solcontract",
      cluster: "testnet",
      programId: SOL_PROGRAM_ID_PIN,
      authorized: false,
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("Flash arbitrage signing blocked");
    expect(v.blockers.join(" ")).toContain("not authorized for the vault wallet");
  });

  test("refuses an unpinned program ID", () => {
    const v = solSigningVerdict({
      engine: "solcontract",
      rail: "solcontract",
      cluster: "testnet",
      programId: "9xQeWvG816bUx9EPfWtbJb2n9dWVnJ4r3RxjKZQmVJ6c",
      authorized: true,
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("is not the pinned FlashboltSolana address");
  });

  test("refuses mainnet without the audit sign-off", () => {
    const v = solSigningVerdict({
      engine: "solcontract",
      ...ARMED_CONTRACT,
      cluster: "mainnet",
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("independent audit sign-off");
  });

  test("arms on devnet once the pin and authorization are set", () => {
    const v = solSigningVerdict({ engine: "solcontract", ...ARMED_CONTRACT });
    expect(v.ok).toBe(true);
    expect(v.message).toContain("Flash arbitrage signing armed");
    expect(v.programId).toBe(SOL_PROGRAM_ID_PIN);
  });
});
