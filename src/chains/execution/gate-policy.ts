/**
 * Gate policy for the terminal's execution paths.
 *
 * Delegates the decision to `canSignLive` (registered ∧ formally activated ∧
 * executor armed ∧ chain match ∧ no kill switch). Paper mode signs nothing and
 * is not gated.
 *
 * There is no chain allowlist, no default to BSC, and no self-comparison: the
 * armed executor is evidence that a deployment exists on the chain, while the
 * activation record is what approves signing there.
 */
import { canSignLive } from "./authorization";
import { networkByKey } from "../registry/networks";
import { networkKeyFor } from "./preflight-keys";
import { activationStateFor, isFormallyActivated } from "../registry/activations";
import type { ReadinessState } from "../registry/chain-types";
import { evaluateReadiness } from "../validation/readiness-engine";
import { deploymentManifest } from "../registry/deployment-registry";

export type ExecutionIntent = "live" | "paper";

export interface GateEvaluation {
  allowed: boolean;
  reasons: string[];
  networkKey: string;
  chainId: number;
  readiness: ReadinessState;
  intent: ExecutionIntent;
  /** What allowed the operation, or why nothing did. */
  basis: "paper" | "activated-and-armed" | "none";
  activated: boolean;
  armed: boolean;
}

export function evaluateGate(args: {
  chainKey: string;
  network: "mainnet" | "testnet";
  wallet: string;
  /** Executor this operation will call. */
  executor: string;
  /** Executor the operator armed on this chain (state.deployments). */
  armedExecutor?: string;
  intent: ExecutionIntent;
  now?: number;
  globalKillSwitch?: boolean;
}): GateEvaluation {
  const networkKey = networkKeyFor(args.chainKey, args.network);
  const network = networkKey ? networkByKey(networkKey) : undefined;

  const readiness: ReadinessState = network
    ? evaluateReadiness({
        network,
        manifest: deploymentManifest(network.deploymentRegistry),
        outcomes: [],
        now: args.now,
      }).state
    : "UNCONFIGURED";

  const base = {
    networkKey: networkKey ?? "",
    chainId: network?.chainId ?? 0,
    readiness,
    intent: args.intent,
  };

  if (args.intent === "paper") {
    return {
      ...base,
      allowed: true,
      reasons: [],
      basis: "paper",
      activated: network
        ? isFormallyActivated(network.chainId, network.environment, args.now)
        : false,
      armed: false,
    };
  }

  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const signing = canSignLive({
    chainKey: args.chainKey,
    network: args.network,
    executor: args.executor,
    armedExecutor: args.armedExecutor,
    globalKillSwitch: args.globalKillSwitch,
  });

  const reasons = [...signing.reasons];
  if (!ADDRESS.test(args.wallet)) reasons.push("Wallet address is not a valid address.");

  return {
    ...base,
    chainId: signing.chainId || base.chainId,
    allowed: reasons.length === 0,
    reasons,
    basis: reasons.length === 0 ? "activated-and-armed" : "none",
    activated: signing.activated,
    armed: signing.armed,
  };
}

/** One-line operator message, safe to log and toast. */
export function gateRefusal(evaluation: GateEvaluation): string {
  return `Execution gate refused on ${evaluation.networkKey || "unknown network"} (${evaluation.intent}, readiness ${
    evaluation.readiness
  }): ${evaluation.reasons[0] ?? "no reason given"}`;
}
