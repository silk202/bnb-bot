import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RPC_BY_CHAIN,
  compareObservedCode,
  hasRuntimeCode,
  observeRuntimeCode,
  runtimeCodeHash,
} from "../../convex/bytecodeGuard";

const EXECUTOR = "0x2c34a2fb58b2f9a3ff6ad4d3b5e5fbcd0b09cdd6";
const CODE_A = "0x6000600055";
const CODE_B = "0x6001600155";

/** Minimal Response stand-in for the injected fetch. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const rpcOk = (result: string) =>
  (async () =>
    json({ jsonrpc: "2.0", id: 1, result })) as unknown as (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;

const rpcFail = (message = "boom") =>
  (async () =>
    json({ jsonrpc: "2.0", id: 1, error: { message } })) as unknown as (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;

describe("runtime code shape", () => {
  test("distinguishes deployed code from an empty account", () => {
    expect(hasRuntimeCode("0x6000")).toBe(true);
    expect(hasRuntimeCode("0x")).toBe(false);
    expect(hasRuntimeCode("")).toBe(false);
    expect(hasRuntimeCode("6000")).toBe(false);
  });

  test("hashes code deterministically, case-insensitively, and differently per code", () => {
    const a = runtimeCodeHash(CODE_A);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(runtimeCodeHash("0x6000600055")).toBe(a);
    expect(runtimeCodeHash("0x60006000 55".replace(" ", ""))).toBe(a);
    expect(runtimeCodeHash(CODE_B)).not.toBe(a);
  });
});

describe("compareObservedCode", () => {
  test("accepts the chain's hash in any case", () => {
    const hash = runtimeCodeHash(CODE_A);
    const result = compareObservedCode({
      expected: hash.toUpperCase().replace("0X", "0x"),
      observedHash: hash,
      address: EXECUTOR,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain(EXECUTOR);
  });

  test("refuses a hash the chain did not report", () => {
    const result = compareObservedCode({
      expected: "0x" + "11".repeat(32),
      observedHash: runtimeCodeHash(CODE_A),
      address: EXECUTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match");
    expect(result.message).toContain("chain reports");
  });
});

describe("observeRuntimeCode", () => {
  test("hashes what the first answering RPC returns", async () => {
    const observed = await observeRuntimeCode({
      rpcUrls: ["https://rpc.one.example"],
      address: EXECUTOR,
      fetchImpl: rpcOk(CODE_A),
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("unreachable");
    expect(observed.hash).toBe(runtimeCodeHash(CODE_A));
    expect(observed.bytes).toBe((CODE_A.length - 2) / 2);
  });

  test("falls through a failing RPC to the next and reports the one that answered", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      if (url.includes("one")) return json({ error: { message: "rate limited" } });
      return json({ result: CODE_A });
    }) as unknown as (url: string, init: RequestInit) => Promise<Response>;
    const observed = await observeRuntimeCode({
      rpcUrls: ["https://rpc.one.example", "https://rpc.two.example"],
      address: EXECUTOR,
      fetchImpl,
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("unreachable");
    expect(observed.url).toContain("two");
    expect(calls).toBe(2);
  });

  test("refuses when every RPC fails", async () => {
    const observed = await observeRuntimeCode({
      rpcUrls: ["https://rpc.one.example", "https://rpc.two.example"],
      address: EXECUTOR,
      fetchImpl: rpcFail("down"),
    });
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("unreachable");
    expect(observed.code).toBe("rpc");
    expect(observed.message).toContain("refusing to pin unverified");
    expect(observed.message).toContain("rpc.one.example");
  });

  test("refuses an empty account instead of hashing 0x", async () => {
    const observed = await observeRuntimeCode({
      rpcUrls: ["https://rpc.one.example"],
      address: EXECUTOR,
      fetchImpl: rpcOk("0x"),
    });
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("unreachable");
    expect(observed.code).toBe("no-code");
    expect(observed.message).toContain("No contract code");
  });

  test("refuses a malformed address before any request", async () => {
    const observed = await observeRuntimeCode({
      rpcUrls: ["https://rpc.one.example"],
      address: "0x1234",
      fetchImpl: rpcOk(CODE_A),
    });
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("unreachable");
    expect(observed.code).toBe("invalid-address");
  });

  test("refuses when no RPC is configured", async () => {
    const observed = await observeRuntimeCode({ rpcUrls: [], address: EXECUTOR });
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("unreachable");
    expect(observed.code).toBe("rpc");
    expect(observed.message).toContain("No RPC endpoint");
  });
});
