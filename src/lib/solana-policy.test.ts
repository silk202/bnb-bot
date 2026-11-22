/**
 * Execution policy: the cluster pin, the wallet role, the vault minimum clip,
 * the execution-time profit floor and the two rails. These are the rules the
 * engine enforces; the UI displays the same verdicts.
 */
import { describe, expect, test } from "bun:test";
import {
  SOL_CLUSTER_GENESIS,
  SOL_PROGRAM_ID_PIN,
  SOL_VAULT_MIN_SWAP_LAMPORTS,
  clusterPinVerdict,
  profitFloorVerdict,
  solClusterByGenesis,
  solProfitFloorLamports,
  solRailVerdict,
  solWalletRole,
} from "./solana-policy";

const SOL = 1_000_000_000;
/** The pinned FlashboltSolana address — any other ID is refused by the gate. */
const PROGRAM = SOL_PROGRAM_ID_PIN;

describe("cluster pinning", () => {
  test("maps the canonical genesis hashes to their clusters", () => {
    expect(solClusterByGenesis(SOL_CLUSTER_GENESIS.mainnet)).toBe("mainnet");
    expect(solClusterByGenesis(SOL_CLUSTER_GENESIS.devnet)).toBe("devnet");
    expect(solClusterByGenesis(SOL_CLUSTER_GENESIS.testnet)).toBe("testnet");
    expect(solClusterByGenesis("unknown")).toBeNull();
    expect(solClusterByGenesis(null)).toBeNull();
  });

  test("passes only when the observed hash equals the pin", () => {
    const same = clusterPinVerdict(
      SOL_CLUSTER_GENESIS.mainnet,
      SOL_CLUSTER_GENESIS.mainnet,
    );
    expect(same.ok).toBe(true);
    expect(same.observedCluster).toBe("mainnet");

    const mismatch = clusterPinVerdict(
      SOL_CLUSTER_GENESIS.mainnet,
      SOL_CLUSTER_GENESIS.devnet,
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("mainnet");
    expect(mismatch.message).toContain("devnet");
    expect(mismatch.message).toContain(SOL_CLUSTER_GENESIS.devnet);
  });

  test("an unreadable genesis is a refusal, never a pass", () => {
    const out = clusterPinVerdict(SOL_CLUSTER_GENESIS.mainnet, null);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("getGenesisHash");
  });

  test("an empty pin refuses instead of trusting the RPC", () => {
    const out = clusterPinVerdict("", SOL_CLUSTER_GENESIS.mainnet);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("pin");
  });
});

describe("wallet role", () => {
  test("classifies the vault signer, the extension and no wallet", () => {
    expect(solWalletRole("Vault111", ["Vault111", "Vault222"])).toBe("vault");
    expect(solWalletRole("Phantom111", ["Vault111"])).toBe("external");
    expect(solWalletRole(null, ["Vault111"])).toBe("none");
    expect(solWalletRole("", [])).toBe("none");
  });

  test("the vault minimum clip is 0.05 SOL", () => {
    expect(SOL_VAULT_MIN_SWAP_LAMPORTS).toBe(0.05 * SOL);
  });
});

describe("execution-time profit floor", () => {
  test("converts the percent floor onto the deployed clip", () => {
    expect(solProfitFloorLamports(10 * SOL, 0.2)).toEqual({
      basisLamports: 10 * SOL,
      floorPct: 0.2,
      floorLamports: 20_000_000,
    });
  });

  test("the larger absolute floor wins", () => {
    expect(solProfitFloorLamports(10 * SOL, 0.2, 50_000_000).floorLamports).toBe(
      50_000_000,
    );
  });

  test("garbage input collapses to a zero floor", () => {
    expect(solProfitFloorLamports(Number.NaN, Number.NaN).floorLamports).toBe(0);
    expect(solProfitFloorLamports(10 * SOL, -5).floorLamports).toBe(0);
  });

  test("passes at/above the floor and refuses below it with both numbers", () => {
    const floor = solProfitFloorLamports(10 * SOL, 0.2);
    expect(profitFloorVerdict(20_000_000, floor).ok).toBe(true);
    expect(profitFloorVerdict(25_000_000, floor).ok).toBe(true);
    const below = profitFloorVerdict(4_000_000, floor);
    expect(below.ok).toBe(false);
    expect(below.message).toContain("0.004000");
    expect(below.message).toContain("0.020000");
  });

  test("a negative quote never clears a zero floor", () => {
    expect(profitFloorVerdict(-1_000, solProfitFloorLamports(1 * SOL, 0)).ok).toBe(
      false,
    );
  });
});

describe("execution rail", () => {
  test("the Jupiter rail is always available", () => {
    const v = solRailVerdict({ rail: "jupiter", cluster: "mainnet" });
    expect(v.ok).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  test("the contract rail names every missing requirement", () => {
    const v = solRailVerdict({ rail: "solcontract", cluster: "mainnet" });
    expect(v.ok).toBe(false);
    expect(v.blockers.length).toBe(3);
    expect(v.blockers.join(" ")).toContain("program");
    expect(v.blockers.join(" ")).toContain("authorized");
    expect(v.blockers.join(" ")).toContain("audit");
  });

  test("a malformed program ID is refused by value", () => {
    const v = solRailVerdict({
      rail: "solcontract",
      cluster: "testnet",
      programId: "not-a-program",
      authorized: true,
      auditApproved: true,
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("not-a-program");
  });

  test("devnet contract execution needs no audit sign-off", () => {
    const v = solRailVerdict({
      rail: "solcontract",
      cluster: "testnet",
      programId: PROGRAM,
      authorized: true,
    });
    expect(v.ok).toBe(true);
    expect(v.programId).toBe(PROGRAM);
  });

  test("mainnet stays off without the audit even when authorized", () => {
    const v = solRailVerdict({
      rail: "solcontract",
      cluster: "mainnet",
      programId: PROGRAM,
      authorized: true,
      auditApproved: false,
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("audit");
  });
});
