import { describe, expect, test } from "bun:test";
import { CHAIN_INFO } from "@/lib/chains";
import { allDeploymentManifests, assertRegistryAddressesWellFormed, deploymentManifest } from "../registry/deployment-registry";
import { assertUniqueChainIds, NETWORKS, networkByKey } from "../registry/networks";
import { evaluateActivation, type ActivationRecord } from "../registry/activation-policy";
import { evaluateReadiness, executionPermittedByReadiness, ladderState } from "../validation/readiness-engine";
import { canExecute, type ExecutionPolicy } from "../execution/execution-gate";
import { EmergencyCircuitBreaker } from "../execution/emergency-circuit-breaker";
import { validateRpc } from "../validation/rpc-validator";
import type { ValidationOutcome } from "../registry/chain-types";

const PASS_ALL: ValidationOutcome[] = [
  "rpc",
  "executor",
  "router",
  "factory",
  "tokens",
  "liquidity",
  "flashloan",
  "simulation",
  "security",
].map((requirement) => ({ requirement, result: "pass", detail: "test" }) as ValidationOutcome);

describe("network registry", () => {
  test("every supported mainnet and testnet is registered with a unique chain id", () => {
    expect(() => assertUniqueChainIds()).not.toThrow();
    const keys = NETWORKS.map((n) => n.key);
    for (const key of ["bsc", "bsc-testnet", "ethereum", "ethereum-sepolia", "arbitrum", "arbitrum-sepolia", "polygon", "polygon-amoy", "base", "base-sepolia", "optimism", "optimism-sepolia"]) {
      expect(keys).toContain(key);
    }
    expect(NETWORKS).toHaveLength(12);
  });

  test("every network declares an identity and a real explorer", () => {
    for (const network of NETWORKS) {
      expect(network.chainId).toBeGreaterThan(0);
      expect(network.nativeCurrency.symbol.length).toBeGreaterThan(0);
      expect(network.explorerUrl).toMatch(/^https:\/\//);
    }
  });

  test("execution is literal disabled on every network", () => {
    for (const network of NETWORKS) {
      expect(network.execution).toEqual({ enabled: false, mode: "disabled" });
    }
  });
});

describe("deployment registry", () => {
  test("addresses are well-formed and no manifest claims to be validated", () => {
    expect(() => assertRegistryAddressesWellFormed()).not.toThrow();
    for (const manifest of allDeploymentManifests()) {
      expect(manifest.status).not.toBe("validated");
    }
  });

  test("mainnet router addresses are the repo's verified ones, not invented", () => {
    const manifest = deploymentManifest("bsc-mainnet");
    expect(manifest?.router?.address).toBe(CHAIN_INFO.bsc.router);
    expect(manifest?.factory?.address).toBe("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73");
  });

  test("networks without a validated DEX deployment are unavailable", () => {
    expect(deploymentManifest("base-mainnet")?.status).toBe("unavailable");
    expect(deploymentManifest("optimism-sepolia")?.status).toBe("unavailable");
  });
});

describe("readiness engine", () => {
  const bsc = networkByKey("bsc")!;

  test("no validation run means REGISTERED, not verified", () => {
    const report = evaluateReadiness({ network: bsc, manifest: deploymentManifest("bsc-mainnet"), outcomes: [] });
    expect(report.state).toBe("REGISTERED");
    expect(report.execution).toBe("OFF");
    expect(report.blocking[0]).toContain("rpc");
  });

  test("a passing ladder stops at READY_FOR_REVIEW — never ACTIVE", () => {
    const report = evaluateReadiness({ network: bsc, manifest: deploymentManifest("bsc-mainnet"), outcomes: PASS_ALL });
    expect(report.state).toBe("READY_FOR_REVIEW");
    expect(executionPermittedByReadiness(report.state)).toBe(false);
  });

  test("the first unmet requirement stops the ladder", () => {
    const partial = PASS_ALL.filter((o) => o.requirement !== "simulation");
    const { state } = ladderState(bsc, partial);
    expect(state).toBe("INTEGRATIONS_VERIFIED");
  });

  test("a failed requirement blocks even when everything after it passes", () => {
    const withFailure = PASS_ALL.map((o) =>
      o.requirement === "liquidity" ? { ...o, result: "fail" as const, detail: "no pool" } : o,
    );
    const report = evaluateReadiness({ network: bsc, manifest: deploymentManifest("bsc-mainnet"), outcomes: withFailure });
    expect(report.state).toBe("CONTRACTS_VERIFIED");
    expect(report.blocking.join(" ")).toContain("no pool");
  });

  test("a suspended network reports SUSPENDED with execution off", () => {
    const report = evaluateReadiness({
      network: bsc,
      manifest: deploymentManifest("bsc-mainnet"),
      outcomes: PASS_ALL,
      suspendedReason: "RPC desync observed",
    });
    expect(report.state).toBe("SUSPENDED");
    expect(report.execution).toBe("OFF");
  });
});

describe("activation policy", () => {
  const now = 1_000_000;
  const base: ActivationRecord = {
    chainId: 97,
    environment: "testnet",
    scope: "execution",
    authorizedBy: "operator@flashbolt",
    authorizationLevel: "testnet",
    reason: "drill",
    authorizedAt: now - 1000,
    expiresAt: now + 60_000,
  };
  const bscTestnet = networkByKey("bsc-testnet")!;
  const bsc = networkByKey("bsc")!;

  test("testnet activation is valid within its window", () => {
    expect(evaluateActivation(bscTestnet, { record: base, now, globalKillSwitch: false }).allowed).toBe(true);
  });

  test("expired and mismatched records are refused", () => {
    expect(evaluateActivation(bscTestnet, { record: { ...base, expiresAt: now - 1 }, now, globalKillSwitch: false }).allowed).toBe(false);
    expect(evaluateActivation(bsc, { record: base, now, globalKillSwitch: false }).allowed).toBe(false);
  });

  test("mainnet requires production level and an attestation", () => {
    const mainnetRecord: ActivationRecord = { ...base, chainId: 56, environment: "mainnet", authorizationLevel: "production" };
    expect(evaluateActivation(bsc, { record: mainnetRecord, now, globalKillSwitch: false }).allowed).toBe(false);
    expect(
      evaluateActivation(bsc, { record: { ...mainnetRecord, attestation: "att-123" }, now, globalKillSwitch: false }).allowed,
    ).toBe(true);
  });

  test("the global kill switch overrides everything", () => {
    expect(evaluateActivation(bscTestnet, { record: base, now, globalKillSwitch: true }).allowed).toBe(false);
  });
});

describe("execution gate", () => {
  const bscTestnet = networkByKey("bsc-testnet")!;
  const request = {
    chainId: 97,
    environment: "testnet" as const,
    wallet: "0x944c4c7b16c38e17f32291fbcb354de27111fa37",
    executor: "0x2c34a2fb58b2f9a3ff6ad4d3b5e5fbcd0b09cdd6",
  };
  const now = 1_000_000;
  const policy = (over: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
    globalKillSwitch: false,
    executionEnabled: true,
    readiness: "ACTIVE",
    activation: {
      now,
      globalKillSwitch: false,
      record: {
        chainId: 97,
        environment: "testnet",
        scope: "execution",
        authorizedBy: "operator@flashbolt",
        authorizationLevel: "testnet",
        reason: "drill",
        authorizedAt: now - 1000,
        expiresAt: now + 60_000,
      },
    },
    ...over,
  });

  test("default policy denies execution", () => {
    const decision = canExecute(request, bscTestnet, {
      globalKillSwitch: false,
      executionEnabled: false,
      readiness: "READY_FOR_REVIEW",
      activation: { now, globalKillSwitch: false },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  test("even a fully authorized policy is refused while the registry flag is disabled", () => {
    const decision = canExecute(request, bscTestnet, policy());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("Network execution flag is disabled in the registry.");
  });

  test("a mainnet request cannot ride a testnet policy", () => {
    const decision = canExecute({ ...request, chainId: 56, environment: "mainnet" }, bscTestnet, policy());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("does not match");
  });

  test("a mismatched environment is refused", () => {
    const decision = canExecute({ ...request, environment: "mainnet" }, bscTestnet, policy());
    expect(decision.allowed).toBe(false);
  });
});

describe("circuit breaker", () => {
  test("trips after consecutive failures and only resets with an operator", () => {
    const breaker = new EmergencyCircuitBreaker(2);
    breaker.recordFailure("rpc down");
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure("rpc down");
    expect(breaker.isOpen()).toBe(true);
    expect(() => breaker.reset("", "retry")).toThrow();
    breaker.reset("operator@flashbolt", "provider restored");
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("rpc validation", () => {
  const transport = (answers: Record<string, { chain: string; head?: string }>) =>
    (async (url: string, method: string) => {
      const answer = answers[url];
      if (!answer) throw new Error("unreachable");
      if (method === "eth_chainId") return answer.chain;
      if (method === "eth_blockNumber") return answer.head ?? "0x10";
      throw new Error("unexpected method");
    }) as never;

  test("an endpoint reporting the wrong chain fails", async () => {
    const report = await validateRpc({
      expectedChainId: 56,
      endpoints: [{ url: "a", provider: "a" }],
      transport: transport({ a: { chain: "0x61" } }),
    });
    expect(report.outcome.result).toBe("fail");
    expect(report.outcome.detail).toContain("expected 56");
  });

  test("verified endpoints that disagree on head fail the consistency check", async () => {
    const report = await validateRpc({
      expectedChainId: 56,
      endpoints: [
        { url: "a", provider: "a" },
        { url: "b", provider: "b" },
      ],
      transport: transport({ a: { chain: "0x38", head: "0x100" }, b: { chain: "0x38", head: "0x400" } }),
    });
    expect(report.outcome.result).toBe("fail");
    expect(report.outcome.detail).toContain("disagree");
  });

  test("consistent endpoints across two providers pass", async () => {
    const report = await validateRpc({
      expectedChainId: 56,
      endpoints: [
        { url: "a", provider: "a" },
        { url: "b", provider: "b" },
      ],
      transport: transport({ a: { chain: "0x38", head: "0x100" }, b: { chain: "0x38", head: "0x110" } }),
    });
    expect(report.outcome.result).toBe("pass");
    expect(report.outcome.detail).toContain("2 provider(s)");
  });
});
