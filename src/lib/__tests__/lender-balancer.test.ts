import { describe, expect, test } from "bun:test";
import {
  balancerQueueFor,
  lenderForRun,
  lenderFeePct,
  FLASH_LENDER_INFO,
} from "../flashbolt";
import { CHAIN_INFO, CHAIN_KEYS } from "../chains";

describe("balancer v queue — lowest fee first, every cycle", () => {
  test("BNB Chain rotation starts from the lowest documented fee", () => {
    const queue = balancerQueueFor(CHAIN_INFO.bsc.lenders);
    // Only lenders that actually deploy on the chain are in the queue.
    for (const lender of queue) {
      expect(CHAIN_INFO.bsc.lenders.includes(lender)).toBe(true);
    }
    // Cycle always opens with the cheapest lender (Aave V3, 0.05%).
    const cheapest = FLASH_LENDER_INFO.filter((l) =>
      CHAIN_INFO.bsc.lenders.includes(l.name),
    ).sort((a, b) => a.feePct - b.feePct)[0]!.name;
    expect(lenderForRun(0, true, CHAIN_INFO.bsc.lenders)).toBe(cheapest);
    expect(lenderForRun(1, true, CHAIN_INFO.bsc.lenders)).toBe(cheapest);
    // …and every cycle repeats it (the wrap point too).
    expect(lenderForRun(queue.length, true, CHAIN_INFO.bsc.lenders)).toBe(queue[0]);
  });

  test("queues are strictly ordered by documented fee (ties keep input order)", () => {
    for (const chainKey of CHAIN_KEYS) {
      const queue = balancerQueueFor(CHAIN_INFO[chainKey].lenders);
      const fees = queue.map((name) => lenderFeePct(name));
      // Every lender appears after all strictly-cheaper ones.
      for (let i = 1; i < fees.length; i++) {
        expect(fees[i] >= fees[i - 1]).toBe(true);
      }
    }
  });

  test("every supported chain degrades safely (single-lender chains repeat it)", () => {
    for (const chainKey of CHAIN_KEYS) {
      const lenders = CHAIN_INFO[chainKey].lenders;
      for (let run = 0; run < lenders.length * 2 + 2; run++) {
        const lender = lenderForRun(run, true, lenders);
        expect(typeof lender).toBe("string");
        expect(lender.length > 0).toBe(true);
      }
      // Single-lender chains never return the em-dash placeholder.
      if (lenders.length === 1) {
        expect(lenderForRun(0, true, lenders)).toBe(lenders[0]);
      }
    }
  });
});
