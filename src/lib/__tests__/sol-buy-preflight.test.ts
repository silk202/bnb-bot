import { describe, expect, test } from "bun:test";
import {
  BUY_FEE_RESERVE_LAMPORTS,
  SOL_FIT_MIN_LOAN_LAMPORTS,
  computeBuyAffordability,
  fitRouteLoanToWallet,
} from "../solana-live-execution";

// 0.1 SOL = 100_000_000 lamports; the default fee/rent reserve is 0.005 SOL.
const AMOUNT = 100_000_000;
const RESERVE = BUY_FEE_RESERVE_LAMPORTS; // 5_000_000
const REQUIRED = AMOUNT + RESERVE; // 105_000_000 = 0.105 SOL

describe("computeBuyAffordability — the no-doomed-Phantom-popup guard", () => {
  test("exact fit (amount + reserve) is affordable", () => {
    const a = computeBuyAffordability(REQUIRED, AMOUNT);
    expect(a.ok).toBe(true);
    expect(a.shortfallLamports).toBe(0);
    expect(a.requiredLamports).toBe(REQUIRED);
  });

  test("one lamport short is refused with the exact shortfall", () => {
    const a = computeBuyAffordability(REQUIRED - 1, AMOUNT);
    expect(a.ok).toBe(false);
    expect(a.shortfallLamports).toBe(1);
  });

  test("classic failing case: 0.104 SOL wallet, 0.1 SOL buy → short 0.001 SOL", () => {
    const a = computeBuyAffordability(104_000_000, AMOUNT);
    expect(a.ok).toBe(false);
    expect(a.shortfallLamports).toBe(1_000_000);
    expect(a.message).toContain("0.10400 SOL");
    expect(a.message).toContain("0.10500 SOL");
    expect(a.message).toContain("short by 0.00100 SOL");
  });

  test("refusal message is honest: nothing signed, nothing spent", () => {
    const a = computeBuyAffordability(0, AMOUNT);
    expect(a.ok).toBe(false);
    expect(a.message).toContain("Nothing was signed or spent");
  });

  test("affordable message carries the real numbers", () => {
    const a = computeBuyAffordability(REQUIRED, AMOUNT);
    expect(a.message).toContain("0.10500 SOL");
    expect(a.message).toContain("covers buy 0.10000");
    expect(a.message).toContain("0.00500 SOL");
  });

  test("custom reserve is respected (caller can tighten/loosen headroom)", () => {
    const a = computeBuyAffordability(10_000_000, 8_000_000, 3_000_000);
    expect(a.ok).toBe(false);
    expect(a.requiredLamports).toBe(11_000_000);
    expect(a.shortfallLamports).toBe(1_000_000);
  });

  test("negative and NaN inputs are floored to 0 — never fakes affordability", () => {
    const a = computeBuyAffordability(-5, Number.NaN, -1);
    expect(a.balanceLamports).toBe(0);
    expect(a.amountLamports).toBe(0);
    expect(a.reserveLamports).toBe(0);
    expect(a.ok).toBe(true); // 0 required, 0 held — trivially affordable
    expect(a.shortfallLamports).toBe(0);
  });

  test("empty wallet refuses a huge buy with the full shortfall", () => {
    const a = computeBuyAffordability(0, 1_000_000_000_000);
    expect(a.ok).toBe(false);
    expect(a.shortfallLamports).toBe(1_000_000_000_000 + RESERVE);
  });

  test("fractional lamport values render at 5-decimal SOL precision", () => {
    const a = computeBuyAffordability(500_000, 0);
    expect(a.message).toContain("0.00500 SOL");
  });
});

describe("fitRouteLoanToWallet — oversized clips land as smaller REAL trades", () => {
  test("no fit needed when the wallet covers the request", () => {
    const f = fitRouteLoanToWallet(REQUIRED, AMOUNT);
    expect(f.ok).toBe(true);
    expect(f.fitted).toBe(false);
    expect(f.loanLamports).toBe(AMOUNT);
  });

  test("the screenshot case: 0.061 SOL wallet vs a 9 SOL signal → fits to 0.056 SOL", () => {
    const f = fitRouteLoanToWallet(61_000_000, 9_000_000_000);
    expect(f.ok).toBe(true);
    expect(f.fitted).toBe(true);
    expect(f.loanLamports).toBe(56_000_000);
    expect(f.message).toContain("9.00000 SOL requested");
    expect(f.message).toContain("0.05600 SOL executable");
    expect(f.message).toContain("lands at the fitted size");
  });

  test("floor boundary: exactly the 0.05 SOL minimum clip still fits", () => {
    const f = fitRouteLoanToWallet(SOL_FIT_MIN_LOAN_LAMPORTS + RESERVE, 9_000_000_000);
    expect(f.ok).toBe(true);
    expect(f.fitted).toBe(true);
    expect(f.loanLamports).toBe(SOL_FIT_MIN_LOAN_LAMPORTS);
  });

  test("one lamport below the floor refuses with the exact top-up math", () => {
    const f = fitRouteLoanToWallet(SOL_FIT_MIN_LOAN_LAMPORTS + RESERVE - 1, 9_000_000_000);
    expect(f.ok).toBe(false);
    expect(f.fitted).toBe(false);
    expect(f.loanLamports).toBe(0);
    expect(f.message).toContain("below the 0.05000 SOL minimum clip");
    expect(f.message).toContain("top up to at least 0.05500 SOL");
    expect(f.message).toContain("Nothing was signed or spent");
  });

  test("unknown balance (NaN) floors to 0 and refuses — never fakes a fit", () => {
    const f = fitRouteLoanToWallet(Number.NaN, 9_000_000_000);
    expect(f.ok).toBe(false);
    expect(f.balanceLamports).toBe(0);
    expect(f.loanLamports).toBe(0);
    expect(f.message).toContain("top up to at least 0.05500 SOL");
  });

  test("custom reserve and floor are respected (caller can tune the fit window)", () => {
    const f = fitRouteLoanToWallet(11_000_000, 100_000_000, 1_000_000, 5_000_000);
    expect(f.ok).toBe(true);
    expect(f.fitted).toBe(true);
    expect(f.loanLamports).toBe(10_000_000);
  });
});
