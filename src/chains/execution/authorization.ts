/**
 * Four independent authorization controls.
 *
 *   1. executor arming   — an operator deployed and armed a contract on a chain
 *   2. chain activation  — that chain was formally approved for live signing
 *   3. internal payout   — executor → designated vault, only for earned profit
 *   4. external withdrawal — vault → outside address; disabled by default
 *
 * No control may stand in for another:
 *   - arming does not activate a chain,
 *   - activation does not authorize withdrawals,
 *   - a connected wallet or a typed address is never authorization,
 *   - a successful internal payout does not license an external transfer.
 *
 * The live-signing decision is deliberately a conjunction; the tautological
 * "executor === armedExecutor" check that existed before is gone — the armed
 * address is only evidence that a deployment exists on that chain, and the
 * activation record carries the approval.
 */
import { networkByKey } from "../registry/networks";
import { activationStateFor, isFormallyActivated } from "../registry/activations";
import { networkKeyFor } from "./preflight-keys";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface SigningRequest {
  chainKey: string;
  network: "mainnet" | "testnet";
  /** Optional clock, used by callers that already hold one. */
  now?: number;
  /** Executor that will receive the call. */
  executor: string;
  /** Executor the operator armed on this chain (state.deployments). */
  armedExecutor?: string;
  globalKillSwitch?: boolean;
}

export interface SigningDecision {
  allowed: boolean;
  reasons: string[];
  chainId: number;
  networkKey: string;
  activated: boolean;
  armed: boolean;
}

/**
 * canSignLive = registered ∧ activated ∧ armed ∧ chain-match ∧ not suspended.
 * Every clause is checked; none implies another.
 */
export function canSignLive(request: SigningRequest): SigningDecision {
  const networkKey = networkKeyFor(request.chainKey, request.network);
  const base = { chainId: 0, networkKey: networkKey ?? "", activated: false, armed: false };

  if (!networkKey) {
    return { ...base, allowed: false, reasons: [`Unknown chain "${request.chainKey}" — failing closed.`] };
  }
  const network = networkByKey(networkKey);
  if (!network) {
    return { ...base, allowed: false, reasons: [`Network "${networkKey}" is not registered.`] };
  }

  // Activation comes from the backend store — an unexpired ACTIVE record for
  // this chain and environment. An unloaded store is "not activated".
  const activation = activationStateFor(network.chainId, network.environment, request.now ?? Date.now());
  const activated = activation.activated;
  const armed = Boolean(request.armedExecutor && ADDRESS.test(request.armedExecutor));
  const reasons: string[] = [];

  if (request.globalKillSwitch) reasons.push("Global kill switch is engaged.");
  if (!activated) {
    reasons.push(activation.reason);
  } else if (
    activation.record?.contractAddress &&
    armed &&
    !sameAddress(request.armedExecutor!, activation.record.contractAddress)
  ) {
    // Approval is pinned to one contract: arming a different one is not covered.
    reasons.push(
      `Armed executor ${request.armedExecutor!.slice(0, 10)}… is not the contract the activation approved (${activation.record.contractAddress.slice(0, 10)}…).`,
    );
  }
  if (!armed) reasons.push(`No executor is armed on ${network.name} — arming is required for live signing.`);
  if (armed && ADDRESS.test(request.executor) && !sameAddress(request.executor, request.armedExecutor!)) {
    reasons.push(`Requested executor ${request.executor.slice(0, 10)}… is not the armed executor ${request.armedExecutor!.slice(0, 10)}…`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    chainId: network.chainId,
    networkKey,
    activated,
    armed,
  };
}

export interface InternalPayoutRequest extends SigningRequest {
  /** Destination of the profit (must be the designated vault/hot wallet). */
  destination: string;
  /** The configured BSC vault/hot wallet for this chain. */
  vaultAddress?: string;
  /** Chronicled payout-signer address (executor or vault signer). */
  signer: string;
  amountNative: number;
  /** Profit this execution actually realised, if known. */
  availableProfitNative?: number;
}

export interface PayoutDecision extends SigningDecision {
  kind: "internal-payout" | "external-withdrawal";
}

/**
 * Internal payout: executor → designated vault, on the activated chain, for
 * earned profit only. Refused when the executor is not armed.
 */
export function authorizeInternalPayout(request: InternalPayoutRequest): PayoutDecision {
  const signing = canSignLive(request);
  const reasons = [...signing.reasons];

  if (!request.vaultAddress || !ADDRESS.test(request.vaultAddress)) {
    reasons.push("No designated vault/hot wallet is configured for this chain.");
  } else if (!sameAddress(request.destination, request.vaultAddress)) {
    // A different destination is an EXTERNAL withdrawal, not an internal payout.
    reasons.push("Destination is not the designated vault — use the internal payout flow, not an external transfer.");
  }

  if (!Number.isFinite(request.amountNative) || request.amountNative <= 0) {
    reasons.push("Payout amount must be a positive number.");
  }
  if (
    typeof request.availableProfitNative === "number" &&
    Number.isFinite(request.availableProfitNative) &&
    request.amountNative > request.availableProfitNative + 1e-9
  ) {
    reasons.push(
      `Payout ${request.amountNative} exceeds earned profit ${request.availableProfitNative} — only realised profit may be paid out.`,
    );
  }

  return { ...signing, kind: "internal-payout", allowed: reasons.length === 0, reasons };
}

export interface ExternalWithdrawalRequest {
  chainKey: string;
  network: "mainnet" | "testnet";
  /** Destination, whether typed or from a connected wallet. */
  destination: string;
  source: "typed-address" | "connected-wallet";
}

/**
 * External withdrawal: vault → outside address.
 *
 * Always refused. There is no approved withdrawal mechanism, and nothing else
 * in the system may substitute for it: not arming, not activation, not a
 * connected extension, not a typed address.
 */
export function authorizeExternalWithdrawal(request: ExternalWithdrawalRequest): PayoutDecision {
  const networkKey = networkKeyFor(request.chainKey, request.network);
  const network = networkKey ? networkByKey(networkKey) : undefined;
  return {
    allowed: false,
    kind: "external-withdrawal",
    reasons: [
      `External withdrawals are disabled (destination supplied via ${request.source === "typed-address" ? "a typed address" : "a connected wallet"}). ` +
        "No withdrawal authorization mechanism is implemented; arming and activation never authorize a transfer out of the vault.",
    ],
    chainId: network?.chainId ?? 0,
    networkKey: networkKey ?? "",
    activated: network ? isFormallyActivated(network.chainId, network.environment) : false,
    armed: false,
  };
}
