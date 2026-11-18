import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evaluateGate, gateRefusal } from "../execution/gate-policy";
import { authorizeExternalWithdrawal, authorizeInternalPayout, canSignLive } from "../execution/authorization";
import { networkKeyFor } from "../execution/preflight-keys";
import { endpointPool } from "../registry/rpc-pools";
import {
  activationStateFor,
  hydrateActivations,
  isFormallyActivated,
  resetActivationStore,
} from "../registry/activations";
import { isBscChain } from "@/lib/chains";

const WALLET = "0x944c4c7b16c38e17f32291fbcb354de27111fa37";
const ARMED = "0x2c34a2fb58b2f9a3ff6ad4d3b5e5fbcd0b09cdd6";
const OTHER = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;

/**
 * What the backend's `chainActivations` query returns for BSC today.
 *
 * Every test hydrates this explicitly: activation is not compiled into the
 * bundle any more, so a store with nothing in it must refuse.
 */
const BSC_RECORD = {
  chainId: 56,
  environment: "mainnet",
  scope: "live-signing",
  status: "ACTIVE",
  approvedBy: "operator",
  activatedAt: NOW - DAY,
  expiresAt: NOW + 30 * DAY,
  evidenceRefs: ["reports/incident-2026-11-13-bnb-drain.md"],
};

beforeEach(() => hydrateActivations([BSC_RECORD], NOW));
afterEach(() => resetActivationStore());

describe("chain activation (backend record)", () => {
  test("BSC mainnet is activated only through the hydrated backend record", () => {
    expect(isFormallyActivated(56, "mainnet", NOW)).toBe(true);
    for (const [chainId, env] of [
      [137, "mainnet"], [8453, "mainnet"], [10, "mainnet"],
      [1, "mainnet"], [42161, "mainnet"], [97, "testnet"],
    ] as const) {
      expect(isFormallyActivated(chainId, env, NOW)).toBe(false);
    }
  });

  test("an unhydrated store refuses every chain (fail closed)", () => {
    resetActivationStore();
    expect(activationStateFor(56, "mainnet", NOW).state).toBe("not-loaded");
    expect(isFormallyActivated(56, "mainnet", NOW)).toBe(false);
    const decision = canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("No backend chain-activation record has been loaded");
  });

  test("an expired record stops authorizing even though it is stored ACTIVE", () => {
    hydrateActivations([{ ...BSC_RECORD, expiresAt: NOW - 1000 }], NOW);
    expect(activationStateFor(56, "mainnet", NOW).state).toBe("expired");
    const decision = canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("has expired");
  });

  test("a suspended record refuses signing", () => {
    hydrateActivations([{ ...BSC_RECORD, status: "SUSPENDED" }], NOW);
    const decision = canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("suspended");
  });

  test("a revoked record refuses signing", () => {
    hydrateActivations([{ ...BSC_RECORD, status: "REVOKED", revocationReason: "incident" }], NOW);
    const decision = canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("revoked");
  });

  test("a PENDING request authorizes nothing", () => {
    hydrateActivations([{ ...BSC_RECORD, status: "PENDING", activatedAt: undefined }], NOW);
    expect(isFormallyActivated(56, "mainnet", NOW)).toBe(false);
  });

  test("an approval pinned to a contract does not cover another armed executor", () => {
    hydrateActivations([{ ...BSC_RECORD, contractAddress: OTHER }], NOW);
    const decision = canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not the contract the activation approved");
  });

  test("a polygon approval is what would let polygon sign, not arming", () => {
    const polygon = { ...BSC_RECORD, chainId: 137 };
    hydrateActivations([BSC_RECORD, polygon], NOW);
    expect(isFormallyActivated(137, "mainnet", NOW)).toBe(true);
    expect(canSignLive({
      chainKey: "polygon", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    }).allowed).toBe(true);
    // BSC keeps working with both rows present.
    expect(canSignLive({
      chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED, now: NOW,
    }).allowed).toBe(true);
  });
});

describe("live signing requires activation AND arming", () => {
  test("BSC armed + activated can sign", () => {
    const decision = canSignLive({ chainKey: "bsc", network: "mainnet", executor: ARMED, armedExecutor: ARMED });
    expect(decision.allowed).toBe(true);
    expect(decision.activated).toBe(true);
    expect(decision.armed).toBe(true);
  });

  test("an armed Polygon contract cannot sign without activation", () => {
    const decision = canSignLive({ chainKey: "polygon", network: "mainnet", executor: ARMED, armedExecutor: ARMED });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("no formal activation record");
  });

  test("arming alone is not enough on BSC either", () => {
    const decision = canSignLive({ chainKey: "bsc", network: "mainnet", executor: ARMED });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("No executor is armed");
  });

  test("an executor that differs from the armed one is refused", () => {
    const decision = canSignLive({ chainKey: "bsc", network: "mainnet", executor: WALLET, armedExecutor: ARMED });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not the armed executor");
  });

  test("unknown chains fail closed", () => {
    const decision = canSignLive({ chainKey: "solana", network: "mainnet", executor: ARMED, armedExecutor: ARMED });
    expect(decision.allowed).toBe(false);
    expect(networkKeyFor("solana", "mainnet")).toBeUndefined();
  });
});

describe("gate policy", () => {
  test("BSC clears through activation + arming", () => {
    const decision = evaluateGate({
      chainKey: "bsc", network: "mainnet", wallet: WALLET, executor: ARMED, armedExecutor: ARMED, intent: "live",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.basis).toBe("activated-and-armed");
  });

  test("Polygon with an armed contract is still refused", () => {
    const decision = evaluateGate({
      chainKey: "polygon", network: "mainnet", wallet: WALLET, executor: ARMED, armedExecutor: ARMED, intent: "live",
    });
    expect(decision.allowed).toBe(false);
    expect(gateRefusal(decision)).toContain("polygon");
  });

  test("paper mode is not gated", () => {
    const decision = evaluateGate({
      chainKey: "polygon", network: "mainnet", wallet: WALLET, executor: ARMED, intent: "paper",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.basis).toBe("paper");
  });

  test("kill switch denies BSC too", () => {
    const decision = evaluateGate({
      chainKey: "bsc", network: "mainnet", wallet: WALLET, executor: ARMED, armedExecutor: ARMED,
      intent: "live", globalKillSwitch: true,
    });
    expect(decision.allowed).toBe(false);
  });

  test("a malformed wallet is refused", () => {
    const decision = evaluateGate({
      chainKey: "bsc", network: "mainnet", wallet: "0x123", executor: ARMED, armedExecutor: ARMED, intent: "live",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Wallet address");
  });
});

describe("internal payout vs external withdrawal", () => {
  const vault = WALLET;
  const base = { chainKey: "bsc", network: "mainnet" as const, signer: vault, vaultAddress: vault };

  test("internal payout to the designated vault is allowed on BSC with an armed executor", () => {
    const decision = authorizeInternalPayout({
      ...base, destination: vault, executor: ARMED, armedExecutor: ARMED, amountNative: 0.05, availableProfitNative: 0.1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.kind).toBe("internal-payout");
  });

  test("internal payout to any other address is not an internal payout", () => {
    const decision = authorizeInternalPayout({
      ...base, destination: ARMED, executor: ARMED, armedExecutor: ARMED, amountNative: 0.05,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not the designated vault");
  });

  test("internal payout above realised profit is refused", () => {
    const decision = authorizeInternalPayout({
      ...base, destination: vault, executor: ARMED, armedExecutor: ARMED, amountNative: 1, availableProfitNative: 0.1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds earned profit");
  });

  test("internal payout without an armed executor is refused", () => {
    const decision = authorizeInternalPayout({ ...base, destination: vault, executor: ARMED, amountNative: 0.05 });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("No executor is armed");
  });

  test("internal payout on an unactivated chain is refused even when armed", () => {
    const decision = authorizeInternalPayout({
      chainKey: "polygon", network: "mainnet", signer: vault, vaultAddress: vault, destination: vault,
      executor: ARMED, armedExecutor: ARMED, amountNative: 0.05,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("no formal activation record");
  });

  test("external withdrawals are refused for typed and connected destinations alike", () => {
    for (const source of ["typed-address", "connected-wallet"] as const) {
      const decision = authorizeExternalWithdrawal({
        chainKey: "bsc", network: "mainnet", destination: ARMED, source,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons[0]).toContain("External withdrawals are disabled");
    }
  });

  test("external withdrawal stays refused even on the activated chain with everything else set", () => {
    // Nothing about BSC's activation or arming may leak into this decision.
    const decision = authorizeExternalWithdrawal({
      chainKey: "bsc", network: "mainnet", destination: vault, source: "connected-wallet",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.armed).toBe(false);
  });
});

describe("chain identity", () => {
  test("isBscChain no longer treats undefined as BSC", () => {
    expect(isBscChain(undefined)).toBe(false);
    expect(isBscChain("")).toBe(false);
    expect(isBscChain("bsc")).toBe(true);
    expect(isBscChain("polygon")).toBe(false);
  });
});

describe("endpoint pool", () => {
  test("splits a chained list and keeps only http(s) URLs", () => {
    const holder = globalThis as { __FLASHBOLT_RPC__?: Record<string, unknown> };
    holder.__FLASHBOLT_RPC__ = {
      env: { BSC_MAINNET_RPC_URL: "https://bsc.example , https://base.example\nhttps://op.example, wss://ws.example" },
    };
    const pool = endpointPool();
    const urls = pool.map((p) => p.url);
    expect(urls).toContain("https://bsc.example");
    expect(urls).toContain("https://base.example");
    expect(urls).toContain("https://op.example");
    expect(urls).not.toContain("wss://ws.example");
    delete holder.__FLASHBOLT_RPC__;
  });
});
