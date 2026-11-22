/**
 * The execution-rail WRITE gate — server side, in one testable place.
 *
 * `terminal.setSettings` is the only route into the persisted rail, and it has
 * to enforce what the UI merely suggests. Two things make that subtle:
 *
 *   1. the activation decision depends on the MERGED state (stored row + this
 *      patch), so arming the rail and setting its program ID in one save
 *      behaves exactly like doing it in two saves; and
 *   2. only a patch that touches a rail field is gated, so an unrelated save
 *      (slippage, cadence, venues) can neither be blocked by a rail that is
 *      already armed nor quietly change it.
 *
 * This module is deliberately free of Convex imports: the mutation calls it
 * and the test suite exercises the exact same function, so the gate the
 * operators rely on is the gate that is tested.
 */
import {
  mergeSolRailSettings,
  solRailVerdict,
  type SolExecutionRail,
  type SolRailSettings,
  type SolRailVerdict,
} from "../lib/sol-rail-gate";

/** The rail fields as they are stored on the terminal-state row. */
export interface StoredRailRow {
  solExecutionRail?: SolExecutionRail;
  solNetwork?: "mainnet" | "testnet";
  solContractProgramId?: string;
  solContractAuthorized?: boolean;
  solAuditApproved?: boolean;
}

/** The same fields as they arrive in a settings patch (all optional). */
export interface RailWritePatch {
  solExecutionRail?: SolExecutionRail;
  solNetwork?: "mainnet" | "testnet";
  solContractProgramId?: string;
  solContractAuthorized?: boolean;
  solAuditApproved?: boolean;
}

export interface RailWriteVerdict {
  /** True when this patch contains a rail field and was therefore checked. */
  gated: boolean;
  /** Stored state with the patch applied (what the write WOULD persist). */
  merged: SolRailSettings;
  /** The rail verdict, when the merged rail is armed and the patch was gated. */
  verdict: SolRailVerdict | null;
  /** The refusal message to throw, or null when the write may proceed. */
  error: string | null;
}

/**
 * Decide whether a settings patch may be written. A refusal is absolute: the
 * caller throws, so nothing in the patch is saved.
 */
export function gateSolRailWrite(
  stored: StoredRailRow,
  patch: RailWritePatch,
): RailWriteVerdict {
  const merged = mergeSolRailSettings(
    {
      rail: stored.solExecutionRail ?? "jupiter",
      cluster: stored.solNetwork ?? "mainnet",
      programId: stored.solContractProgramId,
      authorized: stored.solContractAuthorized ?? false,
      auditApproved: stored.solAuditApproved ?? false,
    },
    {
      rail: patch.solExecutionRail,
      cluster: patch.solNetwork,
      programId: patch.solContractProgramId,
      authorized: patch.solContractAuthorized,
      auditApproved: patch.solAuditApproved,
    },
  );

  const gated =
    patch.solExecutionRail !== undefined ||
    patch.solContractProgramId !== undefined ||
    patch.solContractAuthorized !== undefined ||
    patch.solAuditApproved !== undefined ||
    patch.solNetwork !== undefined;

  // A Jupiter write is never gated: the engine that signs swaps needs no
  // program, authorization or audit.
  if (!gated || merged.rail !== "solcontract") {
    return { gated, merged, verdict: null, error: null };
  }

  const verdict = solRailVerdict(merged);
  return {
    gated: true,
    merged,
    verdict,
    error: verdict.ok
      ? null
      : `Contract rail blocked — ${verdict.blockers.join("; ")}. Nothing was saved; the rail is unchanged.`,
  };
}
