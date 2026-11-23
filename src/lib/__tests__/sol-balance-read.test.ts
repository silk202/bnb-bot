/**
 * The getBalance boundary, crossed for real.
 *
 * This is the one RPC call that had no test at any level: every live path was
 * unit-tested up to the network, so `getBalance`'s `{ context, value }` envelope
 * was read as a bare number in five places and nothing noticed. These tests
 * start a real HTTP server (Bun.serve, no fetch stub, no mocking) so the
 * helper's contract with the wire format is asserted the way production sees
 * it — including the JSON-RPC error and transport-failure paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BUY_FEE_RESERVE_LAMPORTS,
  fetchSolBalanceLamports,
  preflightSolBuyBalance,
} from "../solana-live-execution";

const OWNER = "11111111111111111111111111111111";
const AMOUNT = 100_000_000; // 0.1 SOL

type Mode = "value" | "string-value" | "no-value" | "rpc-error" | "http-500";

let server: ReturnType<typeof Bun.serve>;
let rpcUrl = "";
let mode: Mode = "value";
let balanceValue = 0;
/** Every request body the helper actually sent — the params are part of the contract. */
const requests: Array<{ method?: string; params?: unknown[] }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method?: string; params?: unknown[] };
      requests.push(body);
      if (mode === "http-500") return new Response("upstream unavailable", { status: 500 });
      if (mode === "rpc-error") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32005, message: "node is behind" },
        });
      }
      const value = mode === "string-value" ? "123" : mode === "no-value" ? undefined : balanceValue;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: mode === "no-value" ? { context: { slot: 42 } } : { context: { slot: 42 }, value },
      });
    },
  });
  rpcUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("fetchSolBalanceLamports — reads the envelope the RPC sends", () => {
  test("returns the lamports inside { context, value }", async () => {
    mode = "value";
    balanceValue = 123_456_789;
    requests.length = 0;

    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).resolves.toBe(123_456_789);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("getBalance");
    expect(requests[0].params).toEqual([OWNER, { commitment: "confirmed" }]);
  });

  test("a funded zero balance is 0, not 'unreadable'", async () => {
    mode = "value";
    balanceValue = 0;
    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).resolves.toBe(0);
  });

  test("refuses a stringified value instead of coercing it", async () => {
    mode = "string-value";
    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).rejects.toThrow(
      "getBalance returned no numeric balance",
    );
  });

  test("refuses a result with no value field", async () => {
    mode = "no-value";
    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).rejects.toThrow(
      "getBalance returned no numeric balance",
    );
  });

  test("surfaces the node's own JSON-RPC error message", async () => {
    mode = "rpc-error";
    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).rejects.toThrow("node is behind");
  });

  test("fails honestly when the endpoint is not JSON at all", async () => {
    mode = "http-500";
    await expect(fetchSolBalanceLamports(rpcUrl, OWNER)).rejects.toThrow();
  });

  test("fails honestly when nothing is listening", async () => {
    await expect(fetchSolBalanceLamports("http://127.0.0.1:1", OWNER)).rejects.toThrow();
  });
});

describe("preflightSolBuyBalance — a real balance decides affordability", () => {
  test("a funded wallet is affordable (the bug this helper fixed)", async () => {
    mode = "value";
    balanceValue = 200_000_000; // 0.2 SOL

    const out = await preflightSolBuyBalance(rpcUrl, OWNER, AMOUNT);

    expect(out.kind).toBe("affordable");
    expect(out.ok).toBe(true);
    expect(out.balanceLamports).toBe(200_000_000);
    expect(out.requiredLamports).toBe(AMOUNT + BUY_FEE_RESERVE_LAMPORTS);
    expect(out.shortfallLamports).toBe(0);
    expect(out.message).toContain("Affordable");
  });

  test("a short wallet is refused with the exact shortfall", async () => {
    mode = "value";
    balanceValue = 104_000_000; // 0.104 SOL — 0.001 SOL short

    const out = await preflightSolBuyBalance(rpcUrl, OWNER, AMOUNT);

    expect(out.kind).toBe("insufficient");
    expect(out.ok).toBe(false);
    expect(out.shortfallLamports).toBe(1_000_000);
    expect(out.message).toContain("short by 0.00100 SOL");
    expect(out.message).toContain("Nothing was signed or spent");
  });

  test("an unreadable balance says so, and never claims a shortfall was measured", async () => {
    mode = "rpc-error";

    const out = await preflightSolBuyBalance(rpcUrl, OWNER, AMOUNT);

    expect(out.kind).toBe("unreadable");
    expect(out.ok).toBe(false);
    // Nothing was measured, so no shortfall may be reported.
    expect(out.shortfallLamports).toBe(0);
    expect(out.message).toContain("could not be read");
    expect(out.message).toContain(rpcUrl);
    expect(out.message).toContain("nothing was signed");
    // The old bug reported poverty for a funded wallet; that failure mode must
    // not come back in the wording either.
    expect(out.message).not.toContain("short by");
    expect(out.message).not.toContain("top up");
    expect(out.message).not.toContain("Insufficient");
  });

  test("the same verdict for a malformed value", async () => {
    mode = "string-value";
    const out = await preflightSolBuyBalance(rpcUrl, OWNER, AMOUNT);
    expect(out.kind).toBe("unreadable");
    expect(out.ok).toBe(false);
    expect(out.message).toContain("could not be read");
  });

  test("names the endpoint but never its credentials", async () => {
    mode = "rpc-error";
    const keyed = `${rpcUrl}/?api-key=SUPERSECRETVALUE`;

    const out = await preflightSolBuyBalance(keyed, OWNER, AMOUNT);

    expect(out.kind).toBe("unreadable");
    expect(out.message).not.toContain("SUPERSECRETVALUE");
    // The parameter name survives, its value never does.
    expect(out.message).toContain("?api-key=***");
  });

  test("a zero balance is still a poverty verdict, with the full required amount", async () => {
    mode = "value";
    balanceValue = 0;

    const out = await preflightSolBuyBalance(rpcUrl, OWNER, AMOUNT);

    expect(out.kind).toBe("insufficient");
    expect(out.ok).toBe(false);
    expect(out.shortfallLamports).toBe(AMOUNT + BUY_FEE_RESERVE_LAMPORTS);
    expect(out.message).toContain("short by");
    expect(out.message).not.toContain("could not be read");
  });
});
