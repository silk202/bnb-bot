/**
 * Activation policy — the separate authorization step.
 *
 * Validation makes a network *eligible*; this file decides whether a network is
 * *activated*. The record is produced by a backend, auditable operation, never
 * by a frontend setting: nothing in the UI can construct one, and mainnet needs
 * a production-level authorization plus an attestation id.
 */
import type { NetworkConfig, NetworkEnvironment } from "./chain-types";

export interface ActivationRecord {
  chainId: number;
  environment: NetworkEnvironment;
  scope: "execution";
  /** Who authorized it (operator identity, never a wallet address). */
  authorizedBy: string;
  /** Testnet can be authorized at testnet level; mainnet requires production. */
  authorizationLevel: "testnet" | "production";
  reason: string;
  authorizedAt: number;
  expiresAt: number;
  /** Backend attestation id — mandatory for mainnet. */
  attestation?: string;
}

export interface ActivationContext {
  record?: ActivationRecord;
  now: number;
  globalKillSwitch: boolean;
}

export interface ActivationDecision {
  allowed: boolean;
  reason: string;
}

const MAX_WINDOW_MS = 24 * 60 * 60_000;

export function evaluateActivation(
  network: Pick<NetworkConfig, "chainId" | "environment" | "name">,
  ctx: ActivationContext,
): ActivationDecision {
  if (ctx.globalKillSwitch) {
    return { allowed: false, reason: "Global kill switch is engaged." };
  }
  const record = ctx.record;
  if (!record) {
    return { allowed: false, reason: "No activation record — execution stays disabled." };
  }
  if (record.scope !== "execution") {
    return { allowed: false, reason: `Activation scope "${record.scope}" does not permit execution.` };
  }
  if (record.chainId !== network.chainId || record.environment !== network.environment) {
    return {
      allowed: false,
      reason: `Activation is for chain ${record.chainId} (${record.environment}), not ${network.chainId} (${network.environment}).`,
    };
  }
  if (!record.authorizedBy.trim()) {
    return { allowed: false, reason: "Activation has no authorizing operator." };
  }
  if (!Number.isFinite(record.authorizedAt) || record.authorizedAt > ctx.now) {
    return { allowed: false, reason: "Activation timestamp is invalid or in the future." };
  }
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= ctx.now) {
    return { allowed: false, reason: "Activation has expired." };
  }
  if (record.expiresAt - record.authorizedAt > MAX_WINDOW_MS) {
    return { allowed: false, reason: "Activation window exceeds 24 hours and must be re-issued." };
  }
  if (network.environment === "mainnet") {
    if (record.authorizationLevel !== "production") {
      return { allowed: false, reason: "Mainnet requires a production-level authorization." };
    }
    if (!record.attestation?.trim()) {
      return { allowed: false, reason: "Mainnet activation requires a backend attestation id." };
    }
  } else if (record.authorizationLevel !== "testnet") {
    return { allowed: false, reason: "Testnet activation must use testnet-level authorization." };
  }
  return { allowed: true, reason: "Activation record is valid." };
}
