/**
 * Types for the multi-chain execution readiness framework.
 *
 * Three states are deliberately separate:
 *   registered  — the chain exists in the registry with an identity and RPCs,
 *   validated   — contracts/integrations/simulation/security checks passed,
 *   active      — explicit authorization was granted.
 *
 * Registration never activates. Validation never activates. Only an activation
 * record turns execution on.
 */

export type NetworkEnvironment = "mainnet" | "testnet";

export type ExecutionMode =
  | "disabled"
  | "observe"
  | "simulate"
  | "testnet-live"
  | "mainnet-live";

/** Ordered readiness ladder. Only ACTIVE permits execution. */
export const READINESS_ORDER = [
  "UNCONFIGURED",
  "REGISTERED",
  "RPC_VERIFIED",
  "CONTRACTS_VERIFIED",
  "INTEGRATIONS_VERIFIED",
  "SIMULATION_PASSED",
  "SECURITY_APPROVED",
  "READY_FOR_REVIEW",
  "ACTIVE",
] as const;

export type ReadinessState = (typeof READINESS_ORDER)[number] | "SUSPENDED";

/** One thing that must be validated before a network may be activated. */
export type ValidationRequirement =
  | "rpc"
  | "executor"
  | "router"
  | "factory"
  | "tokens"
  | "liquidity"
  | "flashloan"
  | "simulation"
  | "security";

export const DEFAULT_VALIDATIONS: readonly ValidationRequirement[] = [
  "rpc",
  "executor",
  "router",
  "factory",
  "tokens",
  "liquidity",
  "flashloan",
  "simulation",
  "security",
];

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: 18;
}

export interface NetworkConfig {
  key: string;
  name: string;
  chainId: number;
  environment: NetworkEnvironment;
  nativeCurrency: NativeCurrency;
  /** Populated by rpc-registry.ts from env or verified public endpoints. */
  rpc: { http: string[]; websocket?: string[] };
  explorerUrl: string;
  /**
   * Literal `disabled` in the registry. Activation is a backend operation, so
   * this can never be flipped by editing a frontend setting.
   */
  execution: { enabled: false; mode: "disabled" };
  /** Deployment manifest id (deployment-registry.ts). */
  deploymentRegistry: string;
  requiredValidations: readonly ValidationRequirement[];
}

export type DeploymentStatus = "unavailable" | "unverified" | "validated" | "revoked";

export interface DeploymentVerification {
  sourceVerified: boolean;
  bytecodeVerified: boolean;
  chainVerified: boolean;
  deploymentVerified: boolean;
  lastValidatedAt?: string;
}

export interface ExecutorDeployment {
  address: string;
  runtimeCodeHash: string;
  deploymentTx: string;
  deploymentBlock: number;
}

export interface VerifiedDeployment {
  chainId: number;
  protocol: string;
  protocolVersion: string;
  executor?: ExecutorDeployment;
  router?: string;
  factory?: string;
  verification: DeploymentVerification;
  status: DeploymentStatus;
  /** Why the status is not `validated`, in operator words. */
  note?: string;
}

export type CheckResult = "pass" | "fail" | "pending" | "unsupported";

export interface ValidationOutcome {
  requirement: ValidationRequirement | "deployment";
  result: CheckResult;
  detail: string;
}
