/**
 * mergeSolCandidates tests — the server-side SOL engine's candidate board
 * builder. Signals and market-swept tokens must merge deduped by mint,
 * signals first, capped, with swept tokens shaped as scan-ready signal rows.
 * Real fixtures, no mocking.
 */
import { describe, expect, test } from "bun:test";
import { mergeSolCandidates } from "./solana-feed";
import type { SolTelecopierSignal } from "./solana-routes";

function signal(mint: string): SolTelecopierSignal {
  return {
    id: `ch1 : ${mint}`,
    source: "t.me/ch1",
    sourceLabel: "Channel 1",
    address: mint,
    symbol: "SIG",
    name: "Signalled token",
    chain: "solana",
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    postedAt: 1,
    capturedAt: 2,
    buyable: true,
    excerpt: "",
  };
}

function swept(mint: string) {
  return {
    address: mint,
    symbol: "SWP",
    priceUsd: 0.002,
    liquidityUsd: 80_000,
    volume24h: 10_000,
    dexId: "raydium",
  };
}

describe("mergeSolCandidates", () => {
  test("signals come first, swept tokens fill the rest", () => {
    const merged = mergeSolCandidates(
      [signal("mintA"), signal("mintB")],
      [swept("mintC"), swept("mintD")],
    );
    expect(merged.map((m) => m.address)).toEqual(["mintA", "mintB", "mintC", "mintD"]);
  });

  test("a token present in both feeds is deduped to the signal row", () => {
    const merged = mergeSolCandidates([signal("mintA")], [swept("mintA")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("ch1 : mintA");
    expect(merged[0]!.sourceLabel).toBe("Channel 1");
  });

  test("swept tokens become market-sweep scan rows (buyable, solana)", () => {
    const merged = mergeSolCandidates([], [swept("mintC")]);
    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.id).toBe("mkt:mintC");
    expect(row.source).toBe("market-sweep");
    expect(row.chain).toBe("solana");
    expect(row.buyable).toBe(true);
    expect(row.address).toBe("mintC");
    expect(row.symbol).toBe("SWP");
    expect(row.priceUsd).toBe(0.002);
    expect(row.liquidityUsd).toBe(80_000);
  });

  test("case-insensitive mint dedupe (addresses differ only by case)", () => {
    const merged = mergeSolCandidates([signal("MintA")], [swept("mINtA")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("ch1 : MintA");
  });

  test("cap: signals win their seats, the board never exceeds it", () => {
    const signals = [signal("s1"), signal("s2"), signal("s3")];
    const sweptRows = ["c1", "c2", "c3", "c4"].map(swept);
    const merged = mergeSolCandidates(signals, sweptRows, 5);
    expect(merged).toHaveLength(5);
    expect(merged.slice(0, 3).map((m) => m.address)).toEqual(["s1", "s2", "s3"]);
  });

  test("empty feeds yield an empty board", () => {
    expect(mergeSolCandidates([], [])).toEqual([]);
  });
});
