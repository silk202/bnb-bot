/**
 * The other Solana RPC result shapes, pinned at the wire.
 *
 * `getBalance` was read as a bare number in five places because nothing ever
 * crossed the network boundary in a test. Two more calls had the same exposure
 * and one of them was wrong: `getSignatureStatuses` also answers an RpcResponse
 * (`{ context, value }`), and reading it as an array made every landed
 * transaction look unconfirmed until the 60s wait expired.
 *
 * A real HTTP server (Bun.serve, no fetch stub, no mocking) answers the shapes
 * the node actually sends, so a future refactor that drops `.value` fails here
 * instead of in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchTokenBalanceRaw,
  readBlockHeight,
  resetHeightCache,
  solRpcCall,
  waitForSigConfirm,
} from "../solana-live-execution";

const OWNER = "A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd";
const MINT = "So11111111111111111111111111111111111111112";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

interface RpcRequest {
  method?: string;
  params?: unknown[];
}

let server: ReturnType<typeof Bun.serve>;
let rpcUrl = "";
/** Every request the modules actually sent — params are part of the contract. */
const requests: RpcRequest[] = [];
/** When each request arrived, for pinning the poll schedule. */
const sentAt: number[] = [];
let answer: (method: string, params: unknown[]) => unknown = () => null;
/** Non-JSON / non-2xx replies: a proxy error page, a rate-limited 429. */
let respondWith: ((method: string) => Response | null) | null = null;

// The height cache is module state on purpose (a burst of waiters shares one
// reading), so every test starts from a cold one.
beforeEach(() => {
  resetHeightCache();
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as RpcRequest;
      requests.push(body);
      sentAt.push(Date.now());
      const override = respondWith?.(body.method ?? "");
      if (override) return override;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: answer(body.method ?? "", body.params ?? []),
      });
    },
  });
  rpcUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

/** One jsonParsed token account; `null` = a parser that produced no amount. */
function tokenAccount(amount: string | null) {
  return {
    pubkey: "TokenAcct1111111111111111111111111111111",
    account: {
      data: {
        parsed: amount === null ? undefined : { info: { tokenAmount: { amount } } },
      },
    },
  };
}

describe("fetchTokenBalanceRaw — sums the token accounts the node returns", () => {
  test("two accounts are added as raw units, not decimals", async () => {
    answer = () => ({ context: { slot: 42 }, value: [tokenAccount("700"), tokenAccount("300")] });
    requests.length = 0;

    await expect(fetchTokenBalanceRaw(rpcUrl, OWNER, MINT)).resolves.toBe("1000");

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("getTokenAccountsByOwner");
    expect(requests[0].params).toEqual([
      OWNER,
      { mint: MINT },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
  });

  test("no accounts is 0 raw units, not an error", async () => {
    answer = () => ({ context: { slot: 42 }, value: [] });
    await expect(fetchTokenBalanceRaw(rpcUrl, OWNER, MINT)).resolves.toBe("0");
  });

  test("an account without a parsed amount is skipped, not crashed on", async () => {
    answer = () => ({ context: { slot: 42 }, value: [tokenAccount(null), tokenAccount("5")] });
    await expect(fetchTokenBalanceRaw(rpcUrl, OWNER, MINT)).resolves.toBe("5");
  });
});

describe("getGenesisHash — a bare string, which the cluster pin compares", () => {
  test("the hash comes back unchanged, with no params", async () => {
    answer = () => GENESIS;
    requests.length = 0;

    await expect(solRpcCall<string>(rpcUrl, "getGenesisHash", [])).resolves.toBe(GENESIS);

    expect(requests[0].method).toBe("getGenesisHash");
    expect(requests[0].params).toEqual([]);
  });
});

describe("waitForSigConfirm — reads the RpcResponse envelope", () => {
  test("a confirmed status inside { context, value } confirms the tx", async () => {
    answer = () => ({
      context: { slot: 9 },
      value: [{ slot: 8, err: null, confirmationStatus: "confirmed" }],
    });
    requests.length = 0;

    await expect(waitForSigConfirm(SIG, rpcUrl, 2_000)).resolves.toEqual({
      confirmed: true,
      err: null,
      expired: false,
    });

    expect(requests[0].method).toBe("getSignatureStatuses");
    expect(requests[0].params).toEqual([[SIG], { searchHistory: true }]);
  });

  test("finalized counts as confirmed too", async () => {
    answer = () => ({
      context: { slot: 9 },
      value: [{ slot: 8, err: null, confirmationStatus: "finalized" }],
    });
    await expect(waitForSigConfirm(SIG, rpcUrl, 2_000)).resolves.toEqual({
      confirmed: true,
      err: null,
      expired: false,
    });
  });

  test("a reverted tx surfaces the node's own error object, not [object Object]", async () => {
    answer = () => ({
      context: { slot: 9 },
      value: [
        { slot: 8, err: { InstructionError: [0, { Custom: 6001 }] }, confirmationStatus: "confirmed" },
      ],
    });

    const out = await waitForSigConfirm(SIG, rpcUrl, 2_000);

    expect(out.confirmed).toBe(false);
    expect(out.err).toContain("Custom");
    expect(out.err).toContain("6001");
    expect(out.err).not.toContain("[object Object]");
  });

  test("a signature the node has not seen yet polls, then times out honestly", async () => {
    answer = () => ({ context: { slot: 9 }, value: [null] });

    await expect(waitForSigConfirm(SIG, rpcUrl, 20)).resolves.toEqual({
      confirmed: false,
      err: "confirmation timeout",
      expired: false,
    });
  });

  test("poll gaps grow, so five seconds of waiting costs three requests, not four", async () => {
    answer = () => ({ context: { slot: 9 }, value: [null] });
    requests.length = 0;
    sentAt.length = 0;

    const startedAt = Date.now();
    const out = await waitForSigConfirm(SIG, rpcUrl, 5_000);
    const elapsed = Date.now() - startedAt;

    expect(out).toEqual({ confirmed: false, err: "confirmation timeout", expired: false });
    // 0 s, 1.5 s, 4.5 s. A flat 1.5 s loop would have sent a fourth at 4.5 s+.
    expect(sentAt).toHaveLength(3);
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(1_300);
    expect(gaps[1]).toBeGreaterThanOrEqual(2_700);
    // The last sleep is clamped to the deadline, so the call does not overshoot.
    expect(elapsed).toBeLessThan(6_000);
  }, 15_000);

  test("a short timeout never sleeps past its own deadline", async () => {
    answer = () => ({ context: { slot: 9 }, value: [null] });
    requests.length = 0;

    const startedAt = Date.now();
    await waitForSigConfirm(SIG, rpcUrl, 50);

    expect(requests).toHaveLength(1);
    // The old flat 1.5 s sleep made a 20 ms wait last 1.5 s.
    expect(Date.now() - startedAt).toBeLessThan(700);
  });
});

describe("waitForSigConfirm — a dead blockhash fails at the expiry", () => {
  test("past lastValidBlockHeight the wait ends immediately with expired: true", async () => {
    answer = (method) =>
      method === "getBlockHeight"
        ? 1_000_042
        : { context: { slot: 1_000_500 }, value: [null] };
    requests.length = 0;

    const startedAt = Date.now();
    const out = await waitForSigConfirm(SIG, rpcUrl, 60_000, { lastValidBlockHeight: 1_000_000 });

    expect(out.confirmed).toBe(false);
    expect(out.expired).toBe(true);
    expect(out.err).toContain("blockhash expired");
    // 60 s of waiting would have been patience; the tx can never land.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    // The status slot is past the window, but a slot is not a height: the real
    // height is read before the tx is declared dead, then the wait ends.
    expect(requests.map((r) => r.method)).toEqual(["getSignatureStatuses", "getBlockHeight"]);
  });

  test("a landed tx costs one request — no height probe at all", async () => {
    answer = () => ({
      context: { slot: 1_000_005 },
      value: [{ slot: 1_000_004, err: null, confirmationStatus: "confirmed" }],
    });
    requests.length = 0;

    const out = await waitForSigConfirm(SIG, rpcUrl, 2_000, { lastValidBlockHeight: 1_000_000 });

    expect(out).toEqual({ confirmed: true, err: null, expired: false });
    expect(requests.map((r) => r.method)).toEqual(["getSignatureStatuses"]);
  });

  test("inside the window the wait continues without a height read", async () => {
    let probes = 0;
    answer = (method) => {
      if (method === "getBlockHeight") throw new Error("height read must be skipped inside the window");
      probes += 1;
      return probes >= 3
        ? {
            context: { slot: 1_000_000 },
            value: [{ slot: 999_990, err: null, confirmationStatus: "confirmed" }],
          }
        : { context: { slot: 1_000_000 }, value: [null] };
    };
    requests.length = 0;

    const out = await waitForSigConfirm(SIG, rpcUrl, 8_000, { lastValidBlockHeight: 1_000_010 });

    expect(out).toEqual({ confirmed: true, err: null, expired: false });
    // `context.slot` <= lastValidBlockHeight proves the height is still inside
    // the window, so the extra `getBlockHeight` probe is never sent.
    expect(requests.map((r) => r.method)).toEqual([
      "getSignatureStatuses",
      "getSignatureStatuses",
      "getSignatureStatuses",
    ]);
  }, 15_000);

  test("the slot is never used AS the height — a skipped slot cannot kill a live tx", async () => {
    answer = (method) =>
      method === "getBlockHeight"
        ? 999_999 // still inside lastValidBlockHeight
        : { context: { slot: 1_000_200 }, value: [null] }; // slot already past it
    requests.length = 0;

    const out = await waitForSigConfirm(SIG, rpcUrl, 40, { lastValidBlockHeight: 1_000_000 });

    expect(out).toEqual({ confirmed: false, err: "confirmation timeout", expired: false });
    expect(requests.map((r) => r.method)).toContain("getBlockHeight");
  });

  test("a failing status probe cannot hide the expiry", async () => {
    // The node answers the height but 503s the status call: the expiry check
    // must still run, because a dead tx is dead whatever the status API says.
    respondWith = (method) =>
      method === "getSignatureStatuses"
        ? new Response("upstream down", {
            status: 503,
            headers: { "content-type": "text/plain" },
          })
        : null;
    answer = () => 1_000_042;
    requests.length = 0;

    const out = await waitForSigConfirm(SIG, rpcUrl, 60_000, { lastValidBlockHeight: 1_000_000 });

    expect(out.expired).toBe(true);
    expect(requests.map((r) => r.method)).toContain("getBlockHeight");
    respondWith = null;
  });
});

describe("readBlockHeight — one late read serves the whole burst", () => {
  test("two waiters on the same endpoint share one getBlockHeight", async () => {
    answer = (method) =>
      method === "getBlockHeight"
        ? 1_000_042
        : { context: { slot: 1_000_500 }, value: [null] };
    requests.length = 0;

    const [a, b] = await Promise.all([
      waitForSigConfirm(SIG, rpcUrl, 60_000, { lastValidBlockHeight: 1_000_000 }),
      waitForSigConfirm(SIG, rpcUrl, 60_000, { lastValidBlockHeight: 1_000_000 }),
    ]);

    expect(a.expired).toBe(true);
    expect(b.expired).toBe(true);
    // Both are past the window and both need the height — one request, not two.
    expect(requests.filter((r) => r.method === "getBlockHeight")).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  test("a fresh reading is reused and an expired one is read again", async () => {
    answer = () => 1_000_042;
    requests.length = 0;

    await expect(readBlockHeight(rpcUrl)).resolves.toBe(1_000_042);
    await expect(readBlockHeight(rpcUrl)).resolves.toBe(1_000_042);
    expect(requests).toHaveLength(1);

    // maxAgeMs 0 means "never reuse", so the caller gets a fresh answer.
    await expect(readBlockHeight(rpcUrl, 0)).resolves.toBe(1_000_042);
    expect(requests).toHaveLength(2);
  });

  test("a failed height read is not cached", async () => {
    respondWith = (method) =>
      method === "getBlockHeight"
        ? new Response("upstream down", {
            status: 503,
            headers: { "content-type": "text/plain" },
          })
        : null;
    requests.length = 0;

    await expect(readBlockHeight(rpcUrl)).rejects.toThrow();

    respondWith = null;
    answer = () => 1_000_042;
    await expect(readBlockHeight(rpcUrl)).resolves.toBe(1_000_042);
    expect(requests).toHaveLength(2);
  });
});

describe("postRpc — transport failures surface as themselves", () => {
  test("a 502 proxy page names the method, the status and the redacted endpoint", async () => {
    respondWith = () =>
      new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });

    const keyed = `${rpcUrl}/AbCdEfGhIjKlMnOp`;
    const err = await solRpcCall(keyed, "getBalance", [OWNER]).catch((e: Error) => e.message);

    expect(typeof err).toBe("string");
    const message = err as string;
    expect(message).toContain("getBalance failed");
    expect(message).toContain("HTTP 502");
    expect(message).toContain("502 Bad Gateway");
    // The provider key rides in the path — it must not ride in the error.
    expect(message).not.toContain("AbCdEfGhIjKlMnOp");
    expect(message).toContain("/***");
    respondWith = null;
  });

  test("a 429 with a JSON error body keeps the node's own message", async () => {
    respondWith = () =>
      Response.json(
        { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } },
        { status: 429 },
      );

    const err = await solRpcCall(rpcUrl, "getBalance", [OWNER]).catch((e: Error) => e.message);
    expect(err).toContain("HTTP 429");
    expect(err).toContain("rate limited");
    respondWith = null;
  });

  test("a 200 that is not JSON does not become an opaque parse error", async () => {
    respondWith = () => new Response("not json at all", { status: 200 });

    const err = await solRpcCall(rpcUrl, "getGenesisHash", []).catch((e: Error) => e.message);
    expect(err).toContain("getGenesisHash failed");
    expect(err).toContain("not json at all");
    respondWith = null;
  });

  test("a JSON-RPC error object is reported with its message and code", async () => {
    respondWith = () =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } });

    const err = await solRpcCall(rpcUrl, "getBalance", [OWNER]).catch((e: Error) => e.message);
    expect(err).toContain("invalid params");
    expect(err).toContain("code -32602");
    respondWith = null;
  });

  test("a reply with no result field is an error, not undefined cast to T", async () => {
    respondWith = () => Response.json({ jsonrpc: "2.0", id: 1 });

    const err = await solRpcCall(rpcUrl, "getBalance", [OWNER]).catch((e: Error) => e.message);
    expect(err).toContain("no result");
    respondWith = null;
  });
});
