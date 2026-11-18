/**
 * Readiness engine: turns validation outcomes into a state.
 *
 * Pure and total — it takes results, it never runs checks itself, so a report
 * can be audited and replayed. It can reach READY_FOR_REVIEW at most. ACTIVE is
 * not produced here (or anywhere in the frontend): that requires the activation
 * record handled by execution-gate.ts.
 */
import {
  READINESS_ORDER,
  type NetworkConfig,
  type ReadinessState,
  type ValidationOutcome,
  type ValidationRequirement,
} from "../registry/chain-types";
import type { NetworkDeploymentManifest } from "../registry/deployment-registry";

export interface ReadinessReport {
  networkKey: string;
  name: string;
  chainId: number;
  environment: NetworkConfig["environment"];
  state: ReadinessState;
  /** Execution as this report can honestly describe it. */
  execution: "OFF";
  checks: ValidationOutcome[];
  blocking: string[];
  generatedAt: number;
}

/**
 * Validation groups in ladder order. A stage is only reached when EVERY member
 * of its group passed — one missing liquidity pool does not leave a network at
 * "integrations verified".
 */
const STAGES: readonly { stage: ReadinessState; requires: readonly ValidationRequirement[] }[] = [
  { stage: "RPC_VERIFIED", requires: ["rpc"] },
  { stage: "CONTRACTS_VERIFIED", requires: ["executor", "router", "factory"] },
  { stage: "INTEGRATIONS_VERIFIED", requires: ["tokens", "liquidity", "flashloan"] },
  { stage: "SIMULATION_PASSED", requires: ["simulation"] },
  { stage: "SECURITY_APPROVED", requires: ["security"] },
];

const STAGE_INDEX = new Map(READINESS_ORDER.map((s, i) => [s, i]));

/**
 * Highest stage whose requirement group is fully satisfied, walking the
 * required validations in their canonical order. The first unmet requirement
 * stops the ladder — later passes cannot skip it.
 */
export function ladderState(
  network: Pick<NetworkConfig, "requiredValidations">,
  outcomes: readonly ValidationOutcome[],
): { state: ReadinessState; blocking: string[] } {
  const byRequirement = new Map<ValidationRequirement, ValidationOutcome>();
  for (const outcome of outcomes) {
    if (outcome.requirement === "deployment") continue;
    byRequirement.set(outcome.requirement, outcome);
  }

  let state: (typeof READINESS_ORDER)[number] = "REGISTERED";
  const blocking: string[] = [];

  for (const stage of STAGES) {
    // A stage only applies if the network actually requires one of its parts.
    if (!stage.requires.some((r) => network.requiredValidations.includes(r))) continue;
    for (const requirement of stage.requires) {
      if (!network.requiredValidations.includes(requirement)) continue;
      const outcome = byRequirement.get(requirement);
      if (!outcome) {
        blocking.push(`${requirement}: not run`);
        return { state, blocking };
      }
      if (outcome.result !== "pass") {
        blocking.push(`${requirement}: ${outcome.result} — ${outcome.detail}`);
        return { state, blocking };
      }
    }
    state = stage.stage as (typeof READINESS_ORDER)[number];
  }
  // Everything passed: eligible for review — still not ACTIVE.
  const review = "READY_FOR_REVIEW" as const;
  return {
    state: STAGE_INDEX.get(review)! >= STAGE_INDEX.get(state)! ? review : state,
    blocking,
  };
}

export function evaluateReadiness(args: {
  network: NetworkConfig;
  manifest?: NetworkDeploymentManifest;
  outcomes: readonly ValidationOutcome[];
  suspendedReason?: string;
  now?: number;
}): ReadinessReport {
  const { network, manifest, outcomes } = args;
  const base = {
    networkKey: network.key,
    name: network.name,
    chainId: network.chainId,
    environment: network.environment,
    execution: "OFF" as const,
    checks: [...outcomes],
    generatedAt: args.now ?? Date.now(),
  };

  if (args.suspendedReason) {
    return { ...base, state: "SUSPENDED", blocking: [args.suspendedReason] };
  }

  // A network with no RPC configuration cannot even reach REGISTERED+1, and a
  // manifest that does not exist or is unavailable blocks contracts entirely.
  const rpcOutcome = outcomes.find((o) => o.requirement === "rpc");
  if (network.rpc.http.length === 0 || rpcOutcome?.result === "fail") {
    return {
      ...base,
      state: "REGISTERED",
      blocking: [
        network.rpc.http.length === 0
          ? "No RPC endpoint configured for this network."
          : `rpc: fail — ${rpcOutcome?.detail ?? "endpoint rejected"}`,
      ],
    };
  }

  if (!manifest || manifest.status === "unavailable") {
    return {
      ...base,
      state: "RPC_VERIFIED",
      blocking: [manifest?.note ?? "No deployment manifest for this network."],
    };
  }

  const ladder = ladderState(network, outcomes);
  return { ...base, state: ladder.state, blocking: ladder.blocking };
}

/** Readiness never enables execution; this asserts the invariant in tests. */
export function executionPermittedByReadiness(state: ReadinessState): boolean {
  return state === "ACTIVE";
}
