import { describe, expect, test } from "bun:test";
import { decideExit, type PositionInput } from "./solana-exit-engine";

const ENTRY = 1_000_000_000; // 1 SOL
const BALANCE = 2_000_000n; // 2 token units

const quoteAt = (sellOutLamports: number): number => sellOutLamports;

function base(over: Partial<PositionInput>): PositionInput {
  return {
    entryLamports: ENTRY,
    balanceRaw: BALANCE.toString(),
    sellOutLamports: quoteAt(1_120_000_000), // +12% ROI
    peakRoiPct: 0,
    profitTargetPct: 12,
    sellAmountPct: 100,
    trailingStopPct: 5,
    ...over,
  };
}

describe("solana exit engine", () => {
  test("holds when ROI is below target and no trail triggered", () => {
    const d = decideExit(base({ sellOutLamports: quoteAt(1_050_000_000), peakRoiPct: 5 })); // +5%
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toBe("none");
    expect(d.currentRoiPct).toBeCloseTo(5);
    expect(d.newPeakRoiPct).toBeCloseTo(5);
  });

  test("profit target sells the configured slice (50%)", () => {
    const d = decideExit(base({ sellAmountPct: 50 }));
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("profit_target");
    expect(d.amountRaw).toBe("1000000"); // half of 2_000_000
    expect(d.currentRoiPct).toBeCloseTo(12);
  });

  test("profit target 100% exits the full real balance", () => {
    const d = decideExit(base({ sellAmountPct: 100 }));
    expect(d.shouldExit).toBe(true);
    expect(d.amountRaw).toBe("2000000");
  });

  test("trailing stop fires on give-back from a paid peak (remainder exits whole)", () => {
    const d = decideExit(
      base({ sellOutLamports: quoteAt(1_080_000_000), peakRoiPct: 15, profitTargetPct: 999 }),
    ); // now +8%, peak +15%, trail 5 → 8 ≤ 15−5
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe("trailing_stop");
    expect(d.amountRaw).toBe("2000000");
  });

  test("trailing stop never fires from a peak that never paid", () => {
    const d = decideExit(
      base({ sellOutLamports: quoteAt(990_000_000), peakRoiPct: 3, profitTargetPct: 999 }),
    ); // peak +3% < trail 5 → hold, no exit
    expect(d.shouldExit).toBe(false);
    expect(d.newPeakRoiPct).toBeCloseTo(3);
  });

  test("no balance or no quote → honest hold with carried peak", () => {
    const zero = decideExit(base({ balanceRaw: "0", peakRoiPct: 7 }));
    expect(zero.shouldExit).toBe(false);
    expect(zero.newPeakRoiPct).toBeCloseTo(7);
    const noQuote = decideExit(base({ sellOutLamports: null, peakRoiPct: 9 }));
    expect(noQuote.shouldExit).toBe(false);
    expect(noQuote.newPeakRoiPct).toBeCloseTo(9);
  });

  test("loss position without triggers → hold with negative ROI reported", () => {
    const d = decideExit(
      base({ sellOutLamports: quoteAt(800_000_000), profitTargetPct: 12, peakRoiPct: -20, trailingStopPct: 0 }),
    ); // −20% ROI, no trailing configured
    expect(d.shouldExit).toBe(false);
    expect(d.currentRoiPct).toBeCloseTo(-20);
  });
});
