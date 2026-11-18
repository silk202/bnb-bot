import { describe, expect, test } from "bun:test";
import { describeVaultRemoval } from "../vault-remove-flow";

/**
 * The vault-remove flow is shared by the BNB and SOL Wallets pages; both
 * vaults destroy the tab's encrypted blob when the last signer is removed
 * (their own unit-tested semantics). These tests pin the DESCRIBED outcome:
 * clean-slate detection, remaining list, and the honest messages.
 */
describe("describeVaultRemoval — shared BNB/SOL vault removal reporting", () => {
  test("unknown address → honest no-op (removed: false, no message)", () => {
    const outcome = describeVaultRemoval({
      remove: () => false,
      remaining: () => ["0xaaa", "0xbbb"],
    });
    expect(outcome.removed).toBe(false);
    expect(outcome.cleanSlate).toBe(false);
    expect(outcome.message).toBe("");
    expect(outcome.remaining).toEqual(["0xaaa", "0xbbb"]);
  });

  test("last signer removed → clean slate with the exact report", () => {
    const outcome = describeVaultRemoval({
      remove: () => true,
      remaining: () => [],
    });
    expect(outcome.removed).toBe(true);
    expect(outcome.cleanSlate).toBe(true);
    expect(outcome.remaining).toEqual([]);
    expect(outcome.message).toContain("Clean slate");
    expect(outcome.message).toContain("encrypted blob was destroyed");
    expect(outcome.message).toContain("Import the replacement secret fresh");
  });

  test("one of several removed → remaining count reported, no clean slate", () => {
    const outcome = describeVaultRemoval({
      remove: () => true,
      remaining: () => ["0xccc"],
    });
    expect(outcome.removed).toBe(true);
    expect(outcome.cleanSlate).toBe(false);
    expect(outcome.remaining).toEqual(["0xccc"]);
    expect(outcome.message).toContain("1 signer(s) remain");
  });

  test("remove() runs exactly once and remaining() is read AFTER it", () => {
    let calls = 0;
    let state = ["0xk1", "0xk2"];
    const outcome = describeVaultRemoval({
      remove: () => {
        calls += 1;
        state = state.slice(1); // pop one, like removeFromVault would
        return true;
      },
      remaining: () => state,
    });
    expect(calls).toBe(1);
    expect(outcome.remaining).toEqual(["0xk2"]);
    expect(outcome.cleanSlate).toBe(false);
  });
});
