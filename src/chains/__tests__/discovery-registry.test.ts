import { afterEach, describe, expect, test } from "bun:test";
import {
  discoveryStoreState,
  executionTargetReasons,
  hydrateValidatedDiscovery,
  hydrateInternalDestinations,
  hydrateValidatedRpcEndpoints,
  internalDestinationFor,
  isApprovedInternalDestination,
  isValidatedAddress,
  resetDiscoveryStore,
  validatedRpcUrls,
} from "../registry/discovery-store";
import { comparePinnedCode, runtimeCodeHash } from "../execution/bytecode-pin";
import { buyToken, sellToken } from "../../lib/swap-executor";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e";
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";

afterEach(() => resetDiscoveryStore());

describe("validated RPC ordering", () => {
  test("nothing is preferred before the backend answers", () => {
    expect(validatedRpcUrls(56)).toEqual({ stored: [], discovered: [] });
    expect(discoveryStoreState().rpcLoadedAt).toBe(0);
  });

  test("stored endpoints come first, discovered second, both only when validated", () => {
    // The rows arriving here are already the backend's VALIDATED, unexpired set.
    hydrateValidatedRpcEndpoints(
      [
        { chainId: 56, url: "https://fast-discovered.example", origin: "discovered", latencyMs: 10 },
        { chainId: 56, url: "https://slow-stored.example", origin: "stored", latencyMs: 400 },
        { chainId: 56, url: "https://other-stored.example", origin: "operator", latencyMs: 50 },
        { chainId: 137, url: "https://polygon.example", origin: "stored", latencyMs: 5 },
      ],
      NOW,
    );
    const urls = validatedRpcUrls(56);
    expect(urls.stored).toEqual(["https://other-stored.example", "https://slow-stored.example"]);
    expect(urls.discovered).toEqual(["https://fast-discovered.example"]);
    expect(urls.stored.concat(urls.discovered)[0]).toBe("https://other-stored.example");
    expect(validatedRpcUrls(137).discovered).toEqual([]);
  });

  test("an expired cached row is dropped on hydration", () => {
    hydrateValidatedRpcEndpoints(
      [{ chainId: 56, url: "https://stale.example", origin: "stored", expiresAt: NOW - 1 }],
      NOW,
    );
    expect(validatedRpcUrls(56).stored).toEqual([]);
  });
});

describe("validated address registry", () => {
  test("nothing is validated before hydration", () => {
    expect(isValidatedAddress({ chainId: 56, kind: "router", address: ROUTER })).toBe(false);
    expect(executionTargetReasons({ chainId: 56, router: ROUTER })[0]).toContain("has not loaded");
  });

  test("addresses are matched case-insensitively and only for the right chain and kind", () => {
    hydrateValidatedDiscovery(
      [{ chainId: 56, kind: "router", address: ROUTER.toLowerCase() }],
      NOW,
    );
    expect(isValidatedAddress({ chainId: 56, kind: "router", address: ROUTER.toUpperCase().replace("0X", "0x") })).toBe(true);
    expect(isValidatedAddress({ chainId: 137, kind: "router", address: ROUTER })).toBe(false);
    expect(isValidatedAddress({ chainId: 56, kind: "factory", address: ROUTER })).toBe(false);
  });

  test("execution targets must each be validated", () => {
    hydrateValidatedDiscovery(
      [
        { chainId: 56, kind: "router", address: ROUTER },
        { chainId: 56, kind: "factory", address: FACTORY },
      ],
      NOW,
    );
    expect(executionTargetReasons({ chainId: 56, router: ROUTER, factory: FACTORY })).toEqual([]);
    expect(executionTargetReasons({ chainId: 56, router: ROUTER, factory: "0x1111111111111111111111111111111111111111" })[0]).toContain(
      "Factory",
    );
  });

  test("an expired approval stops counting", () => {
    hydrateValidatedDiscovery(
      [{ chainId: 56, kind: "router", address: ROUTER, expiresAt: NOW + DAY }],
      NOW,
    );
    expect(isValidatedAddress({ chainId: 56, kind: "router", address: ROUTER, now: NOW })).toBe(true);
    expect(isValidatedAddress({ chainId: 56, kind: "router", address: ROUTER, now: NOW + 2 * DAY })).toBe(false);
  });
});

describe("executor bytecode pin", () => {
  const code = "0x60006000556001600055";

  test("a matching pin passes", () => {
    const verdict = comparePinnedCode({ pinned: runtimeCodeHash(code), observedCode: code, address: ROUTER });
    expect(verdict.ok).toBe(true);
    expect(verdict.unpinned).toBe(false);
  });

  test("a changed contract under the same approval is refused", () => {
    const verdict = comparePinnedCode({
      pinned: runtimeCodeHash("0xdeadbeef"),
      observedCode: code,
      address: ROUTER,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("does not match the activation approval");
  });

  test("an unpinned approval proceeds but says so", () => {
    const verdict = comparePinnedCode({ observedCode: code, address: ROUTER });
    expect(verdict.ok).toBe(true);
    expect(verdict.unpinned).toBe(true);
    expect(verdict.reason).toContain("UNPINNED");
  });

  test("no code at the executor address is refused", () => {
    const verdict = comparePinnedCode({ pinned: runtimeCodeHash(code), observedCode: "0x", address: ROUTER });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("No contract code");
  });
});

describe("internal destination registry", () => {
  test("nothing is internal until the backend says so", () => {
    expect(internalDestinationFor(56)).toBeUndefined();
    expect(isApprovedInternalDestination(56, ROUTER)).toBe(false);
  });

  test("an approved destination is matched case-insensitively per chain", () => {
    hydrateInternalDestinations([{ chainId: 56, address: ROUTER.toUpperCase().replace("0X", "0x") }]);
    expect(isApprovedInternalDestination(56, ROUTER.toLowerCase())).toBe(true);
    expect(isApprovedInternalDestination(137, ROUTER)).toBe(false);
    expect(internalDestinationFor(56)?.address).toBe(ROUTER.toLowerCase());
  });
});

describe("swap target gate", () => {
  const signer = { from: ROUTER, privateKey: `0x${"11".repeat(32)}` } as never;
  const env = {
    chainKey: "bsc" as const,
    network: "mainnet" as const,
    chainId: 56,
    rpcUrl: "https://bsc.invalid",
    router: ROUTER,
    wrapped: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    nativeSymbol: "BNB",
    label: "BNB Smart Chain",
    explorerUrl: "https://bscscan.com",
  };

  test("an unvalidated router never receives a signed swap", async () => {
    const result = await buyToken({
      signer,
      env,
      tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      amountNative: 0.01,
      slippagePct: 1,
      recipient: ROUTER,
    });
    expect(result.simulationPassed).toBe(false);
    expect(result.blocked?.code).toBe("unvalidated-target");
    expect(result.blocked?.reason).toMatch(/Router|not loaded/);
    expect(result.simulationError).toContain("Swap target blocked");
  });

  test("selling through an unvalidated router is blocked too", async () => {
    const result = await sellToken({
      signer,
      env,
      tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      sellPct: 50,
      slippagePct: 1,
      recipient: ROUTER,
    });
    expect(result.simulationPassed).toBe(false);
    expect(result.blocked?.code).toBe("unvalidated-target");
    expect(result.blocked?.reason).toMatch(/Router|not loaded/);
    expect(result.simulationError).toContain("Swap target blocked");
  });
});
