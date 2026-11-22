/**
 * SOL FlashBolt — the execution-rail gate, shared by the browser and Convex.
 *
 * This module has **no imports on purpose**. The same function runs in the
 * React app (to disable a rail it cannot execute) and inside the Convex
 * mutation that persists the rail (so a blocked rail cannot be activated by an
 * older client or a direct mutation call). Keeping it dependency-free is what
 * makes that possible — importing `solana-policy` into a Convex function would
 * drag `@solana/web3.js` into the Convex runtime, and a copied second
 * implementation would drift from the UI on the first change.
 */

/** The two rails the SOL terminal can execute on. */
export type SolExecutionRail = "jupiter" | "solcontract";

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

/** Stored rail settings, plus the fields the gate reads. */
export type SolRailSettings = SolRailInput;

/**
 * Merge a partial settings patch over the stored values. `??` is deliberate:
 * a stored `false` (not authorized, not audited) must survive a patch that
 * does not mention the field, and an explicit `false` must override `true`.
 */
export function mergeSolRailSettings(
  stored: SolRailSettings,
  patch?: Partial<SolRailSettings> | null,
): SolRailSettings {
  return {
    rail: patch?.rail ?? stored.rail,
    cluster: patch?.cluster ?? stored.cluster,
    programId: patch?.programId ?? stored.programId,
    authorized: patch?.authorized ?? stored.authorized,
    auditApproved: patch?.auditApproved ?? stored.auditApproved,
  };
}

/** Base58 Solana address shape (program IDs are 32–44 chars). */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The pinned FlashboltSolana program address — the public key of the retained
 * deployment keypair, confirmed 2026-11-21. Every instruction the app builds
 * is encoded from the tracked IDL, and that IDL describes this address alone,
 * so any other configured ID is a mismatch the app cannot execute. It is
 * exported from this dependency-free module so the browser, the Convex
 * mutation and the drift test all read the same pin.
 */
export const SOL_PROGRAM_ID_PIN =
  "82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd";

/**
 * The refusal used by a signing path that could not read the persisted rail.
 *
 * "No settings" is not "Jupiter is armed": a caller that cannot prove which
 * engine the operator selected must not sign at all. Fail closed, and say why.
 */
export const SOL_RAIL_UNVERIFIED_MESSAGE =
  "the operator's persisted rail settings were not available, so nothing was signed — the gate never signs on an unknown engine. Reload the terminal and try again";

/**
 * The engine a signing path is about to use. `jupiter` is the only engine with
 * an implemented signer today; `solcontract` is the FlashboltSolana program.
 */
export type SolSigningEngine = SolExecutionRail;

export interface SolSigningGateInput extends SolRailInput {
  /** Which engine is asking to sign — never inferred from the rail alone. */
  engine: SolSigningEngine;
}

/**
 * Can the selected rail execute at all? The Jupiter rail needs nothing but a
 * wallet; the contract rail needs a real deployed program, an explicit
 * operator authorization and — on mainnet — the audit sign-off. Until all of
 * that exists it refuses honestly instead of inventing a contract call.
 */
export function solRailVerdict(input: SolRailInput): SolRailVerdict {
  if (input.rail === "jupiter") {
    return jupiterVerdict(input.cluster);
  }

  return contractVerdict(input);
}

/**
 * The SIGNING gate — the last check before a key touches a transaction.
 *
 * `solRailVerdict` answers "can this rail execute?"; this answers "may THIS
 * engine sign right now?". Two independent facts are required:
 *
 *   1. the engine asking to sign is the rail the operator activated, and
 *   2. that rail's own verdict passes (pinned program ID, authorization,
 *      mainnet audit).
 *
 * They are separate on purpose. A Jupiter swap path must not sign while the
 * operator has armed flash arbitrage, and the contract engine must not sign on
 * a rail that the settings mutation would have refused. Callers pass the live
 * settings from the execution surface, so neither the UI nor an older client
 * can get bytes signed by an engine that is not armed.
 */
export function solSigningVerdict(input: SolSigningGateInput): SolRailVerdict {
  if (input.engine === "jupiter") {
    if (input.rail !== "jupiter") {
      const blockers = [
        `the active rail is ${input.rail}, not jupiter — this path only signs Jupiter swaps`,
      ];
      return {
        ok: false,
        rail: "jupiter",
        programId: null,
        blockers,
        message: `Jupiter signing blocked — ${blockers.join("; ")}. Nothing was signed or spent.`,
      };
    }
    const armed = jupiterVerdict(input.cluster);
    return {
      ...armed,
      message: `Jupiter signing armed — real swaps from the ${clusterLabel(
        input.cluster,
      )} wallet.`,
    };
  }

  const verdict = contractVerdict(input);
  if (verdict.ok) {
    return { ...verdict, message: `Flash arbitrage signing armed — ${verdict.message}` };
  }
  return {
    ...verdict,
    message: `Flash arbitrage signing blocked — ${verdict.blockers.join("; ")}. Nothing was signed or spent.`,
  };
}

function clusterLabel(cluster: SolRailInput["cluster"]): string {
  return cluster === "mainnet" ? "mainnet" : "devnet";
}

function jupiterVerdict(cluster: SolRailInput["cluster"]): SolRailVerdict {
  return {
    ok: true,
    rail: "jupiter",
    programId: null,
    blockers: [],
    message: `Jupiter rail armed — real swaps from the ${clusterLabel(cluster)} wallet.`,
  };
}

function contractVerdict(input: SolRailInput): SolRailVerdict {
  const programId = (input.programId ?? "").trim();
  const blockers: string[] = [];
  if (!programId) {
    blockers.push(
      "no FlashboltSolana program ID — the program has not been built or deployed",
    );
  } else if (!BASE58_ADDRESS.test(programId)) {
    blockers.push(`program ID ${programId} is not a base58 Solana address`);
  } else if (programId !== SOL_PROGRAM_ID_PIN) {
    blockers.push(
      `program ID ${programId} is not the pinned FlashboltSolana address ${SOL_PROGRAM_ID_PIN} — the tracked IDL can only encode instructions for the pinned program`,
    );
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
    programId: programId || null,
    blockers,
    message:
      blockers.length === 0
        ? `solcontract rail armed on ${input.cluster}: ${programId} is authorized for the vault wallet.`
        : `solcontract rail blocked — ${blockers.join("; ")}.`,
  };
}
