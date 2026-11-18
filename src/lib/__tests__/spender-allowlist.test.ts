import { describe, expect, test } from "bun:test";
import { knownSpendersFor } from "../spender-allowlist";
import { CHAIN_INFO, CHAIN_NETWORKS } from "../chains";

describe("knownSpendersFor", () => {
  // The regression this exists to prevent: a single-router allowlist graded
  // every honest approval to another venue as drainable, blocking payouts.
  test("covers every venue router the app swaps through, on both networks", () => {
    const set = knownSpendersFor({ chainKey: "bsc", network: "mainnet" });
    expect(set.has(CHAIN_INFO.bsc.router.toLowerCase())).toBe(true);
    for (const network of ["mainnet", "testnet"] as const) {
      for (const venue of CHAIN_NETWORKS.bsc[network].venues) {
        expect(set.has(venue.router.toLowerCase())).toBe(true);
      }
    }
    expect(set.size).toBeGreaterThan(1);
  });

  test("includes caller-supplied addresses (armed contract, signer)", () => {
    const contract = "0x00000000000000000000000000000000000000aa";
    const signer = "0x00000000000000000000000000000000000000bb";
    const set = knownSpendersFor({ chainKey: "bsc", extra: [contract, signer, undefined, null] });
    expect(set.has(contract)).toBe(true);
    expect(set.has(signer)).toBe(true);
  });

  test("ignores junk entries instead of trusting them", () => {
    const set = knownSpendersFor({ chainKey: "bsc", extra: ["not-an-address", "0x123", " "] });
    for (const entry of set) expect(entry).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("mainnet and testnet sets agree on the shared routers", () => {
    const mainnet = knownSpendersFor({ chainKey: "bsc", network: "mainnet" });
    const testnet = knownSpendersFor({ chainKey: "bsc", network: "testnet" });
    expect([...testnet].every((a) => mainnet.has(a))).toBe(true);
  });
});
