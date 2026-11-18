import { describe, expect, test } from "bun:test";
import {
  PASSCODE_TTL_MS,
  isPasscodeExpired,
  maskPasscode,
} from "../gate";
import { checkStrongPassword, passwordStrength } from "../password";

describe("gate helpers", () => {
  test("passcode TTL is 72 hours", () => {
    expect(PASSCODE_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });

  test("expiry: unexpired is usable, expired is rejected", () => {
    const now = 1_700_000_000_000;
    expect(isPasscodeExpired(now + 3_600_000, now)).toBe(false);
    expect(isPasscodeExpired(now - 1, now)).toBe(true);
    expect(isPasscodeExpired(now + PASSCODE_TTL_MS, now)).toBe(false);
  });

  test("maskPasscode never reveals the full passcode", () => {
    expect(maskPasscode("FB-X7K2-9Q4M")).toBe("FB-••••-9Q4M");
    expect(maskPasscode("AB")).toBe("••••");
    expect(maskPasscode("")).toBe("••••");
    expect(maskPasscode("FB-X7K2-9Q4M")).not.toContain("X7K2");
  });
});

describe("strong password rules (shared with the Convex provider)", () => {
  test("rejects short, capital-only, no-number, no-symbol passwords", () => {
    expect(checkStrongPassword("short").ok).toBe(false);
    expect(checkStrongPassword("alllowercase1!").ok).toBe(false); // no capital
    expect(checkStrongPassword("NoSymbolsHere1").ok).toBe(false); // no symbol
    expect(checkStrongPassword("NoNumbers!").ok).toBe(false); // no number
  });

  test("accepts a strong password: 8+ chars, capital, number, symbol", () => {
    const check = checkStrongPassword("Str0ng!Pass");
    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
  });

  test("strength meter scores 0..4", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("Str0ng!Pass")).toBe(4);
    expect(passwordStrength("abcdefgh")).toBe(1);
  });
});
