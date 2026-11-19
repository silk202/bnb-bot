/**
 * Realized-profit math — the ledger must report the wallet's measured SOL
 * delta, not a re-quoted expectation. Losses (fees, tip, rent) are negative and
 * must survive as such.
 */
import { describe, expect, test } from "bun:test";
import { realizedNetLamports } from "./solana-live-execution";

const SOL = 1_000_000_000;

describe("realizedNetLamports", () => {
  test("reports the measured gain against the deployed clip", () => {
    expect(realizedNetLamports(10 * SOL, 10.05 * SOL, 10 * SOL)).toEqual({
      netLamports: 50_000_000,
      netPct: 0.5,
    });
  });

  test("keeps a loss negative (priority fee + tip + rent)", () => {
    const out = realizedNetLamports(2 * SOL, 2 * SOL - 7_500_000, 2 * SOL);
    expect(out.netLamports).toBe(-7_500_000);
    expect(out.netPct).toBeLessThan(0);
  });

  test("rounds sub-lamport float noise to an integer delta", () => {
    expect(realizedNetLamports(1_000_000_000.4, 1_000_000_000.9, 1e9).netLamports).toBe(1);
  });

  test("never divides by a zero clip", () => {
    expect(realizedNetLamports(1 * SOL, 1.1 * SOL, 0).netPct).toBe(0);
  });

  test("treats non-finite balances as zero instead of inventing profit", () => {
    expect(realizedNetLamports(Number.NaN, 1 * SOL, 1 * SOL).netLamports).toBe(0);
  });
});
