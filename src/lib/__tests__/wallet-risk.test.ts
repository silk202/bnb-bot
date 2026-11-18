import { describe, expect, test } from "bun:test";
import {
  classifyApproval,
  classifyOutflow,
  classifyTokenSellability,
  UNLIMITED_THRESHOLD,
} from "../wallet-risk";

const TOKEN = "0x91975b5f0000000000000000000000000000abcd";
const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e"; // PancakeSwap V2
const STRANGER = "0xdead00000000000000000000000000000000beef";
const known = new Set([ROUTER]);

describe("classifyApproval", () => {
  test("ignores a revoked allowance", () => {
    expect(classifyApproval({ token: TOKEN, spender: STRANGER, allowance: 0n, knownSpenders: known })).toBeNull();
  });

  test("flags an unlimited allowance to an unrecognised spender as high", () => {
    const f = classifyApproval({ token: TOKEN, spender: STRANGER, allowance: UNLIMITED_THRESHOLD, knownSpenders: known });
    expect(f?.kind).toBe("drainable-approval");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("Unlimited");
  });

  test("treats an unlimited allowance to a known router as ordinary (medium)", () => {
    const f = classifyApproval({ token: TOKEN, spender: ROUTER, allowance: 2n ** 256n - 1n, knownSpenders: known });
    expect(f?.kind).toBe("drainable-approval");
    expect(f?.severity).toBe("medium");
  });

  test("flags a finite allowance to an unrecognised spender as medium", () => {
    const f = classifyApproval({ token: TOKEN, spender: STRANGER, allowance: 1000n, knownSpenders: known });
    expect(f?.kind).toBe("unexpected-contract-interaction");
    expect(f?.severity).toBe("medium");
  });

  test("ignores an ordinary allowance to a known router", () => {
    expect(classifyApproval({ token: TOKEN, spender: ROUTER, allowance: 1000n, knownSpenders: known })).toBeNull();
  });

  test("without a known-spender list, unlimited is always high", () => {
    const f = classifyApproval({ token: TOKEN, spender: ROUTER, allowance: UNLIMITED_THRESHOLD });
    expect(f?.severity).toBe("high");
  });
});

describe("classifyOutflow", () => {
  test("no finding when the drop matches expected spending", () => {
    expect(
      classifyOutflow({ baselineNative: 1, currentNative: 0.9, expectedSpentNative: 0.1 }),
    ).toBeNull();
  });

  test("flags a drop beyond tolerance plus dust", () => {
    const f = classifyOutflow({ baselineNative: 1, currentNative: 0.4, expectedSpentNative: 0.1 });
    expect(f?.kind).toBe("unexplained-outflow");
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("unexplained");
  });

  test("grades a small shortfall as medium so ordinary trading does not block payouts", () => {
    const f = classifyOutflow({ baselineNative: 10, currentNative: 9.5, expectedSpentNative: 0.2 });
    expect(f?.kind).toBe("unexplained-outflow");
    expect(f?.severity).toBe("medium");
  });

  test("grades a large unexplained drop as high", () => {
    const f = classifyOutflow({ baselineNative: 10, currentNative: 4, expectedSpentNative: 0.2 });
    expect(f?.severity).toBe("high");
  });

  test("tolerates small gas-level drift", () => {
    expect(classifyOutflow({ baselineNative: 1, currentNative: 0.99, expectedSpentNative: 0.01 })).toBeNull();
  });

  test("ignores non-finite balances", () => {
    expect(classifyOutflow({ baselineNative: Number.NaN, currentNative: 1, expectedSpentNative: 0 })).toBeNull();
  });
});

describe("classifyTokenSellability", () => {
  test("flags a token that loses more than the round-trip limit", () => {
    const f = classifyTokenSellability({ roundTripLossPct: 97, token: TOKEN });
    expect(f?.kind).toBe("honeypot-token");
    expect(f?.severity).toBe("high");
  });

  test("ignores a normal round trip", () => {
    expect(classifyTokenSellability({ roundTripLossPct: 3 })).toBeNull();
  });
});
