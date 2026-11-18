import { afterEach, describe, expect, test } from "bun:test";
import { padAddressToWord } from "../chain";
import {
  cacheLatencyRanking,
  currentPrivateRpcRanking,
  getRelayHealth,
  isChainPrivateSubmitDegraded,
  isPrivateRpcAvailable,
  isRelayDegraded,
  orderEndpointsByLatency,
  privateRpcSet,
  recordRelayFailure,
  recordRelaySuccess,
  RELAY_COOLDOWN_MS,
  RELAY_FAIL_THRESHOLD,
  resetRelayHealth,
  resolvePrivateRpc,
} from "../private-rpc";

describe("flasher hot-wallet ownership check", () => {
  test("pads an address into the owner() return word format", () => {
    const addr = "0xAbC0000000000000000000000000000000000001";
    expect(padAddressToWord(addr)).toBe(
      "0x000000000000000000000000abc0000000000000000000000000000000000001",
    );
  });

  test("padding is case-insensitive on the address hex", () => {
    const a = padAddressToWord("0xAAA0000000000000000000000000000000000001");
    const b = padAddressToWord("0xaaa0000000000000000000000000000000000001");
    expect(a).toBe(b);
  });
});

describe("private-rpc registry (real documented endpoints)", () => {
  test("Ethereum mainnet resolves Flashbots Protect first", () => {
    expect(resolvePrivateRpc(1, "mainnet")).toBe("https://rpc.flashbots.net/fast");
  });

  test("BSC mainnet resolves bloXroute Protect", () => {
    expect(resolvePrivateRpc(56, "mainnet")).toBe("https://bsc.rpc.blxrbdn.com");
  });

  test("Sepolia testnet resolves Flashbots Protect testnet", () => {
    expect(resolvePrivateRpc(11155111, "testnet")).toBe("https://rpc-sepolia.flashbots.net");
  });

  test("chains without a public no-key relay resolve null — honest fallback", () => {
    expect(resolvePrivateRpc(42161, "mainnet")).toBeNull(); // Arbitrum One
    expect(resolvePrivateRpc(137, "mainnet")).toBeNull(); // Polygon
    expect(resolvePrivateRpc(97, "testnet")).toBeNull(); // BSC testnet
  });

  test("availability mirrors resolution", () => {
    expect(isPrivateRpcAvailable(1, "mainnet")).toBe(true);
    expect(isPrivateRpcAvailable(56, "mainnet")).toBe(true);
    expect(isPrivateRpcAvailable(137, "mainnet")).toBe(false);
    expect(isPrivateRpcAvailable(97, "testnet")).toBe(false);
  });

  test("full set includes the bloXroute Ethereum backup endpoint", () => {
    const set = privateRpcSet(1, "mainnet");
    expect(set).toContain("https://rpc.flashbots.net/fast");
    expect(set).toContain("https://eth-protect.rpc.blxrbdn.com");
  });
});

describe("latency-ranked relay routing", () => {
  test("healthy relays sort by latency — fastest first", () => {
    const order = orderEndpointsByLatency([
      { endpoint: "https://slow.example", ok: true, latencyMs: 300 },
      { endpoint: "https://fast.example", ok: true, latencyMs: 42 },
      { endpoint: "https://mid.example", ok: true, latencyMs: 120 },
    ]);
    expect(order).toEqual([
      "https://fast.example",
      "https://mid.example",
      "https://slow.example",
    ]);
  });

  test("unhealthy relays always rank last — kept for failover attempts", () => {
    const order = orderEndpointsByLatency([
      { endpoint: "https://down.example", ok: false, latencyMs: 1 },
      { endpoint: "https://slow.example", ok: true, latencyMs: 900 },
    ]);
    expect(order).toEqual(["https://slow.example", "https://down.example"]);
  });

  test("cacheLatencyRanking stores and currentPrivateRpcRanking reads it", () => {
    // Distinct chainId so the module-level cache never crosses tests.
    const probes = [
      { endpoint: "https://b.example", ok: true, latencyMs: 200 },
      { endpoint: "https://a.example", ok: true, latencyMs: 30 },
    ];
    const order = cacheLatencyRanking(999001, "mainnet", probes);
    expect(order[0]).toBe("https://a.example");
    expect(currentPrivateRpcRanking(999001, "mainnet")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("ranking is scoped per chain+network — no cross-key bleed", () => {
    expect(currentPrivateRpcRanking(999002, "mainnet")).toBeNull();
    expect(currentPrivateRpcRanking(999001, "testnet")).toBeNull();
  });

  test("unknown chain/network has no ranking", () => {
    expect(currentPrivateRpcRanking(888888, "mainnet")).toBeNull();
  });
});

describe("relay health — consecutive-failure auto-degradation", () => {
  afterEach(() => resetRelayHealth());

  const EP = "https://relay.test/health";

  test("fresh relay is healthy and not degraded", () => {
    expect(getRelayHealth(EP).consecutiveFails).toBe(0);
    expect(isRelayDegraded(EP)).toBe(false);
  });

  test(`${RELAY_FAIL_THRESHOLD} consecutive failures trigger the cooldown`, () => {
    recordRelayFailure(EP, "timeout 1");
    recordRelayFailure(EP, "timeout 2");
    expect(isRelayDegraded(EP)).toBe(false);
    recordRelayFailure(EP, "timeout 3");
    expect(isRelayDegraded(EP)).toBe(true);
    expect(getRelayHealth(EP).lastError).toBe("timeout 3");
  });

  test("cooldown lasts RELAY_COOLDOWN_MS from the third failure", () => {
    for (let i = 0; i < RELAY_FAIL_THRESHOLD; i++) recordRelayFailure(EP, "down");
    const h = getRelayHealth(EP);
    expect(h.degradedUntil).not.toBeNull();
    const remaining = (h.degradedUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(RELAY_COOLDOWN_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(RELAY_COOLDOWN_MS);
  });

  test("a single success resets the consecutive-failure counter", () => {
    recordRelayFailure(EP, "down");
    recordRelayFailure(EP, "down");
    recordRelaySuccess(EP);
    expect(getRelayHealth(EP).consecutiveFails).toBe(0);
    recordRelayFailure(EP, "down");
    recordRelayFailure(EP, "down");
    expect(isRelayDegraded(EP)).toBe(false); // needs a fresh 3rd fail
  });

  test("chain degradation is true only when EVERY registered relay is degraded", () => {
    const relays = privateRpcSet(1, "mainnet");
    expect(relays.length).toBeGreaterThanOrEqual(2);
    // Degrade only the first relay — chain stays healthy.
    for (let i = 0; i < RELAY_FAIL_THRESHOLD; i++) recordRelayFailure(relays[0], "down");
    expect(isChainPrivateSubmitDegraded(1, "mainnet")).toBe(false);
    // Degrade the rest — chain flips to public-RPC fallback.
    for (const r of relays.slice(1)) {
      for (let i = 0; i < RELAY_FAIL_THRESHOLD; i++) recordRelayFailure(r, "down");
    }
    expect(isChainPrivateSubmitDegraded(1, "mainnet")).toBe(true);
  });

  test("chains without relays are never 'degraded'", () => {
    expect(isChainPrivateSubmitDegraded(42161, "mainnet")).toBe(false);
  });
});
