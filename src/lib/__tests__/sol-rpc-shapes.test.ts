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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fetchTokenBalanceRaw,
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
let answer: (method: string, params: unknown[]) => unknown = () => null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as RpcRequest;
      requests.push(body);
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
    });
  });
});
