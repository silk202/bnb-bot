/**
 * Vault signer gate — the in-memory key has no confirmation dialog, so the
 * transaction it is handed must be one a FlashBolt route can actually need.
 * These tests pin the refusals: wrong fee payer, unapproved program, and any
 * System instruction that is not a plain tip transfer.
 */
import { describe, expect, test } from "bun:test";
import { VAULT_ALLOWED_PROGRAMS, vaultSignerVerdict } from "./solana-vault";

const VAULT = "9xQeWvG816bUx9EPf6cM4pQ9bYb1nW7yQmY5oH2v3kLm";
const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";

/** System transfer: u32 LE instruction index 2, then lamports + account data. */
function systemTransferData(): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, 1_000n, true);
  return data;
}

function systemAssignData(): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, 1, true); // Assign
  return data;
}

describe("vault signer verdict", () => {
  test("signs a Jupiter swap paid by the vault", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: VAULT,
      instructions: [
        { programId: JUPITER },
        { programId: TOKEN },
        { programId: "ComputeBudget111111111111111111111111111111" },
      ],
    });
    expect(verdict.ok).toBe(true);
  });

  test("allows the Jito tip transfer", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: VAULT,
      instructions: [{ programId: SYSTEM, data: systemTransferData() }],
    });
    expect(verdict.ok).toBe(true);
  });

  test("refuses when the fee payer is not the vault", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: OTHER,
      instructions: [{ programId: JUPITER }],
    });
    expect(verdict).toEqual({
      ok: false,
      error: `fee payer ${OTHER} is not the vault signer ${VAULT}`,
    });
  });

  test("refuses a missing fee payer", () => {
    expect(
      vaultSignerVerdict({ signer: VAULT, feePayer: null, instructions: [] }),
    ).toEqual({ ok: false, error: "transaction has no fee payer" });
  });

  test("refuses an unapproved program by name", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: VAULT,
      instructions: [{ programId: "EvilProgram1111111111111111111111111111111" }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("EvilProgram");
  });

  test("refuses System instructions other than transfer", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: VAULT,
      instructions: [{ programId: SYSTEM, data: systemAssignData() }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("not a transfer");
  });

  test("refuses a malformed System instruction (no data)", () => {
    const verdict = vaultSignerVerdict({
      signer: VAULT,
      feePayer: VAULT,
      instructions: [{ programId: SYSTEM, data: null }],
    });
    expect(verdict.ok).toBe(false);
  });

  test("the allowlist names real, non-empty programs", () => {
    const entries = Object.entries(VAULT_ALLOWED_PROGRAMS);
    expect(entries.length).toBeGreaterThan(5);
    for (const [programId, label] of entries) {
      expect(programId.length).toBeGreaterThanOrEqual(32);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(VAULT_ALLOWED_PROGRAMS[JUPITER]).toContain("Jupiter");
    expect(VAULT_ALLOWED_PROGRAMS[SYSTEM]).toContain("transfer");
  });
});
