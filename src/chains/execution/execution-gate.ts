/**
 * The execution gate — the single security boundary before any transaction.
 *
 * Every check is additive: a missing fact denies. The gate cannot be opened by
 * the frontend, because `executionEnabled` and the activation record come from
 * a backend policy object; the registry's own `execution.enabled` is the literal
 * `false` and is reported here as an explicit refusal reason.
 */
import type { NetworkConfig, ReadinessState } from "../registry/chain-types";
import { evaluateActivation, type ActivationContext } from "../registry/activation-policy";

export interface ExecutionRequest {
  chainId: number;
  environment: "mainnet" | "testnet";
  wallet: string;
  executor: string;
}

export interface ExecutionPolicy {
  globalKillSwitch: boolean;
  /** Set only by a backend after activation. Never bound to a UI control. */
  executionEnabled: boolean;
  readiness: ReadinessState;
  activation: ActivationContext;
}

export interface GateDecision {
  allowed: boolean;
  reasons: string[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function canExecute(
  request: ExecutionRequest,
  network: NetworkConfig,
  policy: ExecutionPolicy,
): GateDecision {
  const reasons: string[] = [];

  if (policy.globalKillSwitch) reasons.push("Global kill switch is engaged.");
  if (!policy.executionEnabled) reasons.push("Execution is disabled by backend policy.");
  if (request.chainId !== network.chainId) {
    reasons.push(`Request chain ${request.chainId} does not match ${network.name} (${network.chainId}).`);
  }
  if (request.environment !== network.environment) {
    reasons.push(`Request environment ${request.environment} does not match ${network.environment}.`);
  }
  if (!ADDRESS.test(request.wallet)) reasons.push("Wallet address is not a valid address.");
  if (!ADDRESS.test(request.executor)) reasons.push("Executor address is not a valid address.");
  if (policy.readiness !== "ACTIVE") {
    reasons.push(`Network readiness is ${policy.readiness}, not ACTIVE.`);
  }
  // Typed as literal `false` in the registry, so this is a permanent refusal
  // until a backend activation path exists; widening keeps that explicit.
  const registryEnabled: boolean = network.execution.enabled;
  if (!registryEnabled) {
    reasons.push("Network execution flag is disabled in the registry.");
  }

  const activation = evaluateActivation(network, policy.activation);
  if (!activation.allowed) reasons.push(activation.reason);

  return { allowed: reasons.length === 0, reasons };
}

export function assertCanExecute(
  request: ExecutionRequest,
  network: NetworkConfig,
  policy: ExecutionPolicy,
): void {
  const decision = canExecute(request, network, policy);
  if (!decision.allowed) {
    throw new Error(`Execution refused for ${network.name}: ${decision.reasons.join(" ")}`);
  }
}

/**
 * RPC failover is provider-only. Changing the chain is a separate, explicit
 * operation and is never something a failover can do.
 */
export function assertSameChainForFailover(expectedChainId: number, observedChainId: number): void {
  if (expectedChainId !== observedChainId) {
    throw new Error(
      `RPC failover changed chain identity (${expectedChainId} → ${observedChainId}); refusing to continue.`,
    );
  }
}
