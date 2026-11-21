/**
 * The Solana execution plan is read from the tracked IDL, so this suite is the
 * drift alarm: if the program's surface changes, or a hard-coded address in
 * the UI diverges from the IDL, one of these fails before the operator sees a
 * stale instruction list.
 */
import { describe, expect, test } from "bun:test";
import {
  FLASHBOLT_ERRORS,
  FLASHBOLT_IDL_META,
  FLASHBOLT_INSTRUCTIONS,
  FLASHBOLT_INSTRUCTION_NAMES,
  FLASHBOLT_PROGRAM_ID,
  FLASH_ARB_IN_IDL,
  FLASH_ARB_STEPS,
  JUPITER_LEND,
  JUPITER_SWAP_STEPS,
  SOL_ENGINE_PLANS,
  flashboltInstructionLine,
  solPlanTally,
  solPlanStatusLabel,
} from "./solana-execution-plan";

describe("FlashboltSolana IDL wiring", () => {
  test("program address is the confirmed, retained one", () => {
    expect(FLASHBOLT_PROGRAM_ID).toBe(
      "82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd",
    );
    expect(FLASHBOLT_IDL_META.version).toBe("0.1.0");
  });

  test("declares the six configuration instructions and no execution one", () => {
    expect(FLASHBOLT_INSTRUCTION_NAMES).toEqual([
      "accept_admin",
      "initialize_config",
      "pause_program",
      "propose_admin",
      "unpause_program",
      "update_authorities",
    ]);
    expect(FLASH_ARB_IN_IDL).toBe(false);
  });

  test("every instruction carries its accounts, and arguments are flattened", () => {
    for (const ix of FLASHBOLT_INSTRUCTIONS) {
      expect(ix.accounts.length).toBeGreaterThan(0);
      expect(flashboltInstructionLine(ix)).toContain(ix.name);
    }
    const update = FLASHBOLT_INSTRUCTIONS.find((ix) => ix.name === "update_authorities");
    expect(update?.args).toEqual([
      { name: "executor", type: "option<pubkey>" },
      { name: "pause_authority", type: "option<pubkey>" },
    ]);
  });

  test("signers come from the IDL, not from a hand-written list", () => {
    const initialize = FLASHBOLT_INSTRUCTIONS.find((ix) => ix.name === "initialize_config");
    expect(initialize?.signers).toContain("admin");
    const accept = FLASHBOLT_INSTRUCTIONS.find((ix) => ix.name === "accept_admin");
    expect(accept?.signers).toContain("pending_admin");
  });

  test("error codes are contiguous from 6000", () => {
    expect(FLASHBOLT_ERRORS.length).toBe(10);
    expect(FLASHBOLT_ERRORS[0]).toEqual({ code: 6000, name: "UnauthorizedAdmin" });
    expect(FLASHBOLT_ERRORS.map((e) => e.code)).toEqual(
      FLASHBOLT_ERRORS.map((_, i) => 6000 + i),
    );
  });
});

describe("Jupiter Lend verification record", () => {
  test("carries the mainnet flashloan and liquidity programs", () => {
    expect(JUPITER_LEND.mainnet.flashloan).toBe(
      "jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS",
    );
    expect(JUPITER_LEND.mainnet.liquidity).toBe(
      "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
    );
  });

  test("zero fee, bracketed shape, and devnet recorded as not deployed", () => {
    expect(JUPITER_LEND.feePct).toBe(0);
    // The fee the settings card prints comes from this decoded word, not from
    // a literal next to it.
    expect(JUPITER_LEND.admin.feeWord).toBe(0);
    expect(JUPITER_LEND.shape).toBe("bracketed");
    expect(JUPITER_LEND.devnet.deployed).toBe(false);
    expect(JUPITER_LEND.devnet.checkedOn).toBe("2026-11-21");
  });
});

describe("engine plans", () => {
  test("Jupiter Swap is done except for the isolation step", () => {
    const tally = solPlanTally(JUPITER_SWAP_STEPS);
    expect(tally.done).toBe(tally.total - 1);
    expect(JUPITER_SWAP_STEPS[JUPITER_SWAP_STEPS.length - 1]?.status).toBe("next");
  });

  test("flash arbitrage stops at the devnet lender gate", () => {
    const blocked = FLASH_ARB_STEPS.filter((s) => s.status === "blocked").map((s) => s.id);
    expect(blocked).toContain("lender-devnet");
    expect(blocked).toContain("audit");
    expect(FLASH_ARB_STEPS.find((s) => s.id === "flash-arb")?.status).toBe("pending");
  });

  test("both engines are presented with a status label for every step", () => {
    expect(SOL_ENGINE_PLANS.map((p) => p.id)).toEqual(["jupiter-swap", "flash-arb"]);
    for (const plan of SOL_ENGINE_PLANS) {
      for (const step of plan.steps) {
        expect(solPlanStatusLabel(step.status).length).toBeGreaterThan(0);
        expect(step.evidence.length).toBeGreaterThan(0);
      }
    }
  });
});
