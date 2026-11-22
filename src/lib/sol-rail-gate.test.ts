/**
 * The Convex mutation does not receive a whole settings object — it merges the
 * patch it was called with over the stored row. These tests pin that merge,
 * because a stored `false` silently turning into `undefined` would arm a rail
 * the operator never authorized.
 *
 * The second half pins the program address. The app encodes every
 * FlashboltSolana instruction from the tracked IDL, so the gate only arms the
 * address that IDL declares — and the test proves `declare_id!`, `Anchor.toml`,
 * the IDL and the deploy preflight all still agree with the constant.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SOL_PROGRAM_ID_PIN,
  mergeSolRailSettings,
  solRailVerdict,
  type SolRailSettings,
} from "./sol-rail-gate";

const PROGRAM = "82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd";

const stored: SolRailSettings = {
  rail: "jupiter",
  cluster: "testnet",
  programId: PROGRAM,
  authorized: false,
  auditApproved: false,
};

describe("mergeSolRailSettings", () => {
  test("a stored false survives a patch that does not mention it", () => {
    const next = mergeSolRailSettings(stored, { rail: "solcontract" });
    expect(next.authorized).toBe(false);
    expect(next.auditApproved).toBe(false);
    expect(next.programId).toBe(PROGRAM);
  });

  test("an explicit false overrides a stored true", () => {
    const next = mergeSolRailSettings(
      { ...stored, authorized: true },
      { authorized: false },
    );
    expect(next.authorized).toBe(false);
  });

  test("the patch wins for every field it does mention", () => {
    const next = mergeSolRailSettings(stored, {
      rail: "solcontract",
      cluster: "mainnet",
      authorized: true,
      auditApproved: true,
    });
    expect(next).toEqual({
      rail: "solcontract",
      cluster: "mainnet",
      programId: PROGRAM,
      authorized: true,
      auditApproved: true,
    });
  });

  test("activating the contract rail is refused until the merged state passes", () => {
    const blocked = solRailVerdict(
      mergeSolRailSettings(stored, { rail: "solcontract" }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join(" ")).toContain("authorized");

    const armed = solRailVerdict(
      mergeSolRailSettings(stored, { rail: "solcontract", authorized: true }),
    );
    expect(armed.ok).toBe(true);
    expect(armed.programId).toBe(PROGRAM);
  });

  test("Jupiter is allowed from any merged state", () => {
    const verdict = solRailVerdict(
      mergeSolRailSettings({ ...stored, authorized: false }, { rail: "jupiter" }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });
});

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

describe("pinned program address", () => {
  const armed = {
    rail: "solcontract" as const,
    cluster: "testnet" as const,
    authorized: true,
  };

  test("the pinned address is the only one that arms the contract rail", () => {
    const pinned = solRailVerdict({ ...armed, programId: SOL_PROGRAM_ID_PIN });
    expect(pinned.ok).toBe(true);
    expect(pinned.programId).toBe(SOL_PROGRAM_ID_PIN);

    // A real, valid base58 program address — refused only because it is not
    // the address the tracked IDL describes.
    const other = solRailVerdict({
      ...armed,
      programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    });
    expect(other.ok).toBe(false);
    expect(other.blockers.join(" ")).toContain("pinned");
  });

  test("declare_id!, Anchor.toml, the IDL and the preflight gate carry the pin", () => {
    const lib = readFileSync(
      join(PROJECT_ROOT, "solana/programs/flashbolt_solana/src/lib.rs"),
      "utf8",
    );
    expect(lib).toContain(`declare_id!("${SOL_PROGRAM_ID_PIN}")`);

    const anchor = readFileSync(join(PROJECT_ROOT, "solana/Anchor.toml"), "utf8");
    const programLines =
      anchor.match(/^flashbolt_solana\s*=\s*"([^"]+)"/gm) ?? [];
    expect(programLines.length).toBe(2);
    for (const line of programLines) {
      expect(line).toContain(SOL_PROGRAM_ID_PIN);
    }

    const idl = JSON.parse(
      readFileSync(
        join(PROJECT_ROOT, "solana/idl/flashbolt_solana.json"),
        "utf8",
      ),
    ) as { address?: string };
    expect(idl.address).toBe(SOL_PROGRAM_ID_PIN);

    const preflight = readFileSync(
      join(PROJECT_ROOT, "scripts/solana-program-preflight.sh"),
      "utf8",
    );
    expect(preflight).toContain(`EXPECTED_ID="${SOL_PROGRAM_ID_PIN}"`);
  });
});
