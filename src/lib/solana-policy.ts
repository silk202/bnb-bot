/**
 * SOL FlashBolt — execution policy.
 *
 * Pure, testable rules shared by the engine and the terminal UI so the number
 * the operator sees is the rule the engine enforces:
 *
 *  • Cluster pinning — the RPC must report the genesis hash the operator
 *    pinned (or the canonical hash for the selected cluster) BEFORE anything
 *    is signed. Both the pinned ("former") and the observed ("current") hash
 *    are reported, so a mainnet wallet pointed at a devnet RPC is refused
 *    with the two hashes side by side instead of silently trading elsewhere.
 *  • Wallet role — the in-app vault signer is the VAULT wallet; the injected
 *    extension is an EXTERNAL wallet. The vault rail carries the 0.05 SOL
 *    minimum clip; an external wallet keeps its own wallet-fit rules.
 *  • Execution rail — `jupiter` executes real Jupiter swaps; `solcontract`
 *    executes the FlashboltSolana program and is refused with the exact
 *    missing requirement (program ID, operator authorization, audit approval
 *    on mainnet) until that program exists.
 *  • Profit floor — a percent of the deployed clip, checked against the
 *    quotes that actually build the transactions.
 */

import { LAMPORTS_PER_SOL } from "./solana-jito";

/** The two rails the SOL terminal can execute on. */
export type SolExecutionRail = "jupiter" | "solcontract";

/** Which wallet signs: the in-app vault, a connected extension, or neither. */
export type SolWalletRole = "vault" | "external" | "none";

/** Genesis-bearing Solana clusters (testnet is its own chain, not devnet). */
export type SolGenesisCluster = "mainnet" | "devnet" | "testnet";

/**
 * Canonical genesis hashes. `getGenesisHash` returns exactly these; the pin is
 * the only reliable way to know which chain an RPC override actually serves.
 */
export const SOL_CLUSTER_GENESIS: Record<SolGenesisCluster, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

/** Map a genesis hash back to its cluster, or null when it is unknown. */
export function solClusterByGenesis(
  genesis: string | null | undefined,
): SolGenesisCluster | null {
  if (!genesis) return null;
  const needle = genesis.trim();
  for (const [cluster, hash] of Object.entries(SOL_CLUSTER_GENESIS) as Array<
    [SolGenesisCluster, string]
  >) {
    if (hash === needle) return cluster;
  }
  return null;
}

export interface SolClusterPinVerdict {
  ok: boolean;
  expectedGenesis: string;
  expectedCluster: SolGenesisCluster | null;
  observedGenesis: string | null;
  observedCluster: SolGenesisCluster | null;
  /** Exact human report naming both hashes (and the chain when known). */
  message: string;
}

/**
 * Compare the pinned genesis hash with the one the RPC just reported. An
 * unreadable hash is a refusal, never a pass: without it the cluster is
 * unknown and signing would be a guess.
 */
export function clusterPinVerdict(
  expectedGenesis: string | null | undefined,
  observedGenesis: string | null | undefined,
): SolClusterPinVerdict {
  const expected = (expectedGenesis ?? "").trim();
  const observed = observedGenesis ? observedGenesis.trim() : null;
  const expectedCluster = solClusterByGenesis(expected);
  const observedCluster = solClusterByGenesis(observed);
  const expectedLabel = expected
    ? `${expected}${expectedCluster ? ` (${expectedCluster})` : ""}`
    : "(none pinned)";
  const observedLabel = observed
    ? `${observed}${observedCluster ? ` (${observedCluster})` : ""}`
    : "(unreadable)";

  if (!expected) {
    return {
      ok: false,
      expectedGenesis: expected,
      expectedCluster,
      observedGenesis: observed,
      observedCluster,
      message:
        "No cluster genesis pin is set — refusing to sign until the chain is pinned. Set the pin in SOL Strategy → Network.",
    };
  }
  if (!observed) {
    return {
      ok: false,
      expectedGenesis: expected,
      expectedCluster,
      observedGenesis: null,
      observedCluster,
      message: `Could not read getGenesisHash from the configured RPC — the cluster is unverified against the pin ${expectedLabel}. Nothing was signed.`,
    };
  }
  if (observed !== expected) {
    return {
      ok: false,
      expectedGenesis: expected,
      expectedCluster,
      observedGenesis: observed,
      observedCluster,
      message: `Cluster mismatch: pinned ${expectedLabel} but the RPC reports ${observedLabel}. Nothing was signed or spent — fix the cluster or the RPC override.`,
    };
  }
  return {
    ok: true,
    expectedGenesis: expected,
    expectedCluster,
    observedGenesis: observed,
    observedCluster,
    message: `Cluster verified: ${observedLabel} matches the pin.`,
  };
}

/**
 * The vault's minimum Jupiter clip. Kept identical to the wallet-fit floor so
 * a vault swap below it would be fee/rent noise rather than an arbitrage.
 */
export const SOL_VAULT_MIN_SWAP_LAMPORTS = 50_000_000; // 0.05 SOL

/** Classify a signing address against the unlocked vault addresses. */
export function solWalletRole(
  signerAddress: string | null | undefined,
  vaultAddresses: readonly string[],
): SolWalletRole {
  const address = (signerAddress ?? "").trim();
  if (!address) return "none";
  return vaultAddresses.includes(address) ? "vault" : "external";
}

export interface SolProfitFloor {
  basisLamports: number;
  floorPct: number;
  floorLamports: number;
}

/**
 * Turn the operator's percent floor into lamports on the clip that will
 * actually execute. An explicit absolute floor wins when it is larger.
 * Non-finite inputs collapse to zero so a bad setting can never invent a
 * negative floor.
 */
export function solProfitFloorLamports(
  basisLamports: number,
  minProfitPct?: number,
  explicitLamports?: number,
): SolProfitFloor {
  const basis = Number.isFinite(basisLamports)
    ? Math.max(0, Math.floor(basisLamports))
    : 0;
  const pct = Number.isFinite(minProfitPct)
    ? Math.max(0, Number(minProfitPct))
    : 0;
  const explicit = Number.isFinite(explicitLamports)
    ? Math.max(0, Math.floor(Number(explicitLamports)))
    : 0;
  const fromPct = Math.ceil((basis * pct) / 100);
  return {
    basisLamports: basis,
    floorPct: pct,
    floorLamports: Math.max(fromPct, explicit),
  };
}

export interface SolProfitFloorVerdict {
  ok: boolean;
  expectedNetLamports: number;
  floorLamports: number;
  message: string;
}

const fmtSol = (lamports: number): string =>
  (lamports / LAMPORTS_PER_SOL).toFixed(6);

/**
 * Execution-time gate: the quoted net of the exact route that would be signed
 * must clear the floor. The refusal carries the quote, the floor and the clip
 * so the operator can see why nothing was signed.
 */
export function profitFloorVerdict(
  expectedNetLamports: number,
  floor: SolProfitFloor,
): SolProfitFloorVerdict {
  const expected = Number.isFinite(expectedNetLamports)
    ? Math.round(expectedNetLamports)
    : 0;
  if (expected >= floor.floorLamports) {
    return {
      ok: true,
      expectedNetLamports: expected,
      floorLamports: floor.floorLamports,
      message: `Quoted net ${fmtSol(expected)} SOL clears the ${floor.floorPct}% floor (${fmtSol(floor.floorLamports)} SOL on a ${fmtSol(floor.basisLamports)} SOL clip).`,
    };
  }
  return {
    ok: false,
    expectedNetLamports: expected,
    floorLamports: floor.floorLamports,
    message: `Quoted net ${fmtSol(expected)} SOL is below the ${floor.floorPct}% execution floor (${fmtSol(floor.floorLamports)} SOL on a ${fmtSol(floor.basisLamports)} SOL clip) — nothing was signed or spent.`,
  };
}

export interface SolRailInput {
  rail: SolExecutionRail;
  cluster: "mainnet" | "testnet";
  programId?: string | null;
  /** Operator authorization binding this rail to the vault wallet. */
  authorized?: boolean;
  /** Independent audit sign-off (required before any mainnet contract use). */
  auditApproved?: boolean;
}

export interface SolRailVerdict {
  ok: boolean;
  rail: SolExecutionRail;
  /** The validated program ID, or null when the rail is not armed. */
  programId: string | null;
  /** Every unmet requirement, in operator language. */
  blockers: string[];
  message: string;
}

/** Base58 Solana address shape (program IDs are 32–44 chars). */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Can the selected rail execute at all? The Jupiter rail needs nothing but a
 * wallet; the contract rail needs a real deployed program, an explicit
 * operator authorization and — on mainnet — the audit sign-off. Until all of
 * that exists it refuses honestly instead of inventing a contract call.
 */
export function solRailVerdict(input: SolRailInput): SolRailVerdict {
  if (input.rail === "jupiter") {
    return {
      ok: true,
      rail: "jupiter",
      programId: null,
      blockers: [],
      message: `Jupiter rail armed — real swaps from the ${
        input.cluster === "mainnet" ? "mainnet" : "devnet"
      } wallet.`,
    };
  }

  const programId = (input.programId ?? "").trim();
  const blockers: string[] = [];
  if (!programId) {
    blockers.push(
      "no FlashboltSolana program ID — the program has not been built or deployed",
    );
  } else if (!BASE58_ADDRESS.test(programId)) {
    blockers.push(`program ID ${programId} is not a base58 Solana address`);
  }
  if (!input.authorized) {
    blockers.push(
      "contract rail is not authorized for the vault wallet — enable authorization after the deployment is verified",
    );
  }
  if (input.cluster === "mainnet" && !input.auditApproved) {
    blockers.push(
      "mainnet contract execution requires the independent audit sign-off — mainnet stays off until then",
    );
  }
  return {
    ok: blockers.length === 0,
    rail: "solcontract",
    programId: blockers.length === 0 || programId ? programId || null : null,
    blockers,
    message:
      blockers.length === 0
        ? `solcontract rail armed on ${input.cluster}: ${programId} is authorized for the vault wallet.`
        : `solcontract rail blocked — ${blockers.join("; ")}.`,
  };
}
