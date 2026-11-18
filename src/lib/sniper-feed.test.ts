/**
 * Sniper feed core tests — the server-side snipe engines' candidate board
 * builder + guarded snipe decision. Signals and market-swept tokens must
 * merge deduped by address per chain, signals first, capped, and the guard
 * stack must reject exactly what the browser snipers reject. Real fixtures,
 * no mocking.
 */
import { describe, expect, test } from "bun:test";
import { mergeSnipeBoard, evaluateSnipeCandidate } from "./sniper-feed";

function signal(address: string, capturedAt = 1_000) {
  return {
    address,
    symbol: "SIG",
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    postedAt: 900,
    capturedAt,
  };
}

function swept(address: string) {
  return {
    address,
    symbol: "SWP",
    priceUsd: 0.002,
    liquidityUsd: 80_000,
    marketCapUsd: 1_000_000,
    postedAt: 0,
  };
}

describe("mergeSnipeBoard", () => {
  test("signals come first, swept tokens fill the rest", () => {
    const board = mergeSnipeBoard(
      "bnb",
      [signal("0xaaa"), signal("0xbbb")],
      [swept("0xccc"), swept("0xddd")],
    );
    expect(board.map((r) => r.address)).toEqual(["0xaaa", "0xbbb", "0xccc", "0xddd"]);
  });

  test("a token present in both feeds is deduped to the signal row", () => {
    const board = mergeSnipeBoard("bnb", [signal("0xaaa")], [swept("0xaaa")]);
    expect(board).toHaveLength(1);
    expect(board[0]!.source).toBe("copier");
  });

  test("swept rows carry the real sweep source and chain tag", () => {
    const board = mergeSnipeBoard("sol", [], [swept("MintAce")]);
    expect(board).toHaveLength(1);
    expect(board[0]!.source).toBe("market-sweep");
    expect(board[0]!.chain).toBe("solana");
    expect(board[0]!.buyable).toBe(true);
  });

  test("dedupe is case-insensitive on EVM addresses", () => {
    const board = mergeSnipeBoard("bnb", [signal("0xAAA")], [swept("0xaaa")]);
    expect(board).toHaveLength(1);
    expect(board[0]!.source).toBe("copier");
  });

  test("cap keeps signals in their seats first", () => {
    const signals = Array.from({ length: 6 }, (_, i) => signal(`0x${i}`));
    const swpt = Array.from({ length: 6 }, (_, i) => swept(`0x${i + 10}`));
    const board = mergeSnipeBoard("bnb", signals, swpt, 8);
    expect(board).toHaveLength(8);
    expect(board.slice(0, 6).every((r) => r.source === "copier")).toBe(true);
  });

  test("empty feeds produce an empty board (nothing fabricated)", () => {
    expect(mergeSnipeBoard("bnb", [], [])).toEqual([]);
  });
});

describe("evaluateSnipeCandidate", () => {
  const now = 1_000_000;
  const opts = { minLiquidityUsd: 5_000, minProfitPct: 0.2, now };

  test("rejects below the liquidity floor", () => {
    const g = evaluateSnipeCandidate(
      { liquidityUsd: 4_999, priceUsd: 0.1, capturedAt: now },
      opts,
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("below_liquidity_floor");
  });

  test("rejects a zero price (no live quote)", () => {
    const g = evaluateSnipeCandidate(
      { liquidityUsd: 50_000, priceUsd: 0, capturedAt: now },
      opts,
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("no_live_price");
  });

  test("rejects stale signals outside the 30-minute freshness window", () => {
    const g = evaluateSnipeCandidate(
      { liquidityUsd: 50_000, priceUsd: 0.1, capturedAt: now - 31 * 60_000 },
      opts,
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("stale_signal");
  });

  test("accepts a fresh, liquid, priced signal with the paper fill", () => {
    const g = evaluateSnipeCandidate(
      { liquidityUsd: 50_000, priceUsd: 0.1, capturedAt: now - 5 * 60_000 },
      opts,
    );
    expect(g.allowed).toBe(true);
    expect(g.fillPct).toBe(1.5);
    expect(g.reason).toBeUndefined();
  });

  test("rejects when the fill cannot clear the operator's profit floor", () => {
    const g = evaluateSnipeCandidate(
      { liquidityUsd: 50_000, priceUsd: 0.1, capturedAt: now - 5 * 60_000 },
      { ...opts, minProfitPct: 2.0 },
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("below_profit_floor");
  });
});
