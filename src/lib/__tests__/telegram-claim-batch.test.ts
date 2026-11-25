/**
 * /claim is a bounded batch that reports every outcome in one reply.
 *
 * Before this, one tap looped over every claimable plan, swallowed failures and
 * could answer "could not complete" while silently skipping plans it had tried.
 * These pin the replacement: per-asset totals, failures named with the amount
 * still sitting on them, "nothing changed" when every attempt failed, and an
 * explicit remaining count when the pass hit its batch limit.
 */
import { describe, expect, test } from "bun:test";
import { CLAIM_BATCH_LIMIT, claimBatchMessage } from "../telegramBot";

describe("/claim batch reply", () => {
  test("all claimed: one total per asset, no failure noise", () => {
    const text = claimBatchMessage({
      claimed: [
        { asset: "USDC", amount: 0.5 },
        { asset: "USDT", amount: 1.2 },
        { asset: "USDC", amount: 0.25 },
      ],
      failed: [],
      claimable: 3,
    });
    expect(text).toBe("✅ Claimed 3 earn plans — +0.75 USDC · +1.2 USDT.");
  });

  test("partial: names the plan left untouched with its accrued amount", () => {
    const text = claimBatchMessage({
      claimed: [{ asset: "USDC", amount: 0.5 }],
      failed: [{ asset: "USDT", accrued: 0.42 }],
      claimable: 2,
    });
    expect(text).toContain("✅ Claimed 1 of 2 earn plans — +0.5 USDC.");
    expect(text).toContain("• 1 left untouched: USDT (0.42 still there) — retry /claim.");
    expect(text).not.toContain("more claimable");
  });

  test("total failure says plainly that nothing changed", () => {
    const text = claimBatchMessage({
      claimed: [],
      failed: [
        { asset: "USDC", accrued: 0.1 },
        { asset: "USDT", accrued: 0.2 },
      ],
      claimable: 2,
    });
    expect(text).toContain("None of the 2 attempted earn plans could be claimed");
    expect(text).toContain("nothing was changed");
    expect(text).toContain("USDC (0.1 still there), USDT (0.2 still there)");
  });

  test("a truncated pass says how many are left and the batch size", () => {
    const claimed = Array.from({ length: CLAIM_BATCH_LIMIT }, () => ({
      asset: "USDC",
      amount: 0.1,
    }));
    const text = claimBatchMessage({
      claimed,
      failed: [],
      claimable: CLAIM_BATCH_LIMIT + 2,
    });
    expect(text).toContain(
      "• 2 more claimable plans — this pass ran a batch of 8; tap /claim again for the rest.",
    );
  });

  test("a long failure list is capped but counted", () => {
    const failed = Array.from({ length: 8 }, (_, i) => ({
      asset: `A${i}`,
      accrued: 0.1,
    }));
    const text = claimBatchMessage({ claimed: [], failed, claimable: 8 });
    expect(text).toContain("+2 more");
    expect(text).toContain("• 8 left untouched:");
  });

  test("the batch limit is eight", () => {
    expect(CLAIM_BATCH_LIMIT).toBe(8);
  });
});
