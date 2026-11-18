/**
 * Preflight for the terminal's execution paths.
 *
 * Thin wrapper over the gate policy so call sites keep one import. Live
 * execution is cleared only when the caller supplies the executor that is
 * actually armed for that chain — there is no chain allowlist and no default to
 * BSC. Paper mode signs nothing and is not gated.
 */
import { evaluateGate, gateRefusal, type ExecutionIntent, type GateEvaluation } from "./gate-policy";

export type { ExecutionIntent, GateEvaluation };
export { gateRefusal };
export { networkKeyFor } from "./preflight-keys";

export function preflightExecution(args: {
  chainKey: string;
  network: "mainnet" | "testnet";
  wallet: string;
  executor: string;
  /** The executor armed on this chain (state.deployments[chainKey].contractAddress). */
  armedExecutor?: string;
  /** Defaults to "live": callers that sign must pass nothing and stay gated. */
  intent?: ExecutionIntent;
  now?: number;
  globalKillSwitch?: boolean;
}): GateEvaluation {
  return evaluateGate({ ...args, intent: args.intent ?? "live" });
}

/**
 * One-line refusal for any decision shape (gate, payout or withdrawal), so call
 * sites do not need to know which authorization layer answered.
 */
export function refusalMessage(decision: { networkKey: string; reasons: string[] }): string {
  return `Refused on ${decision.networkKey || "unknown network"}: ${decision.reasons[0] ?? "no reason given"}`;
}
