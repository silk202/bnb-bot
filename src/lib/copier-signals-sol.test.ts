/**
 * Copier parser — Solana signal tests. The shared parser must now surface
 * Solana signals (base58 mints, chain "solana") alongside the existing EVM
 * behavior, which must remain byte-for-byte unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
  COPIER_SOURCES,
  chainFromText,
  isLikelySolanaAddress,
  parseChannelMessages,
} from "./copier-signals";

describe("COPIER_SOURCES", () => {
  test("includes the two-venue listing channels", () => {
    const urls = COPIER_SOURCES.map((s) => s.url);
    expect(urls).toContain("https://t.me/s/arbitjet_arbitrage");
    expect(urls).toContain("https://t.me/s/AveSignalMonitor");
    expect(urls).toContain("https://t.me/s/BSCnewtokenspairs");
    expect(urls.length).toBeGreaterThanOrEqual(4);
  });
});

describe("isLikelySolanaAddress", () => {
  test("accepts real-looking base58 pubkeys", () => {
    // WSOL mint — the canonical example.
    expect(isLikelySolanaAddress("So11111111111111111111111111111111111111112")).toBe(true);
    // A typical random mint (mixed case + digits).
    expect(isLikelySolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  });

  test("rejects false positives", () => {
    expect(isLikelySolanaAddress("https")).toBe(false);
    expect(isLikelySolanaAddress("abcdefghijklmnopqrstuvwxyz")).toBe(false); // no digits
    expect(isLikelySolanaAddress("12345678901234567890123456789012")).toBe(false); // no letters case mix... digits+lower only
    expect(isLikelySolanaAddress("ABCDEFGHIJKLMNOPQRSTUVWXYZABCD")).toBe(false); // upper only
  });
});

describe("chainFromText", () => {
  test("maps solana hints", () => {
    expect(chainFromText("new mint on solana raydium")).toBe("solana");
  });
  test("defaults to bsc", () => {
    expect(chainFromText("no hints here")).toBe("bsc");
  });
});

describe("parseChannelMessages — Solana", () => {
  test("parses a pure Solana signal with mint + symbol", () => {
    const msgs = [
      {
        id: "1",
        text:
          "🚨 New listing on Solana Raydium\nBONKX — $BONKX\nPrice: $0.00042\nLiq: $85k\nMC: $1.2M\nEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        postedAt: 1_700_000_000_000,
        link: "https://t.me/test/1",
      },
    ];
    const out = parseChannelMessages(msgs);
    expect(out.length).toBe(1);
    expect(out[0]!.chain).toBe("solana");
    expect(out[0]!.address).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(out[0]!.symbol).toBe("BONKX");
    expect(out[0]!.liquidityUsd).toBe(85_000);
  });

  test("does not mistake t.me handles or urls for mints", () => {
    const msgs = [
      {
        id: "2",
        text:
          "Join https://t.me/somechannel and t.me/another for signals on solana",
        postedAt: 1_700_000_000_000,
        link: "",
      },
    ];
    const out = parseChannelMessages(msgs);
    expect(out.length).toBe(0);
  });

  test("keeps EVM parsing unchanged (bsc default, 0x addresses)", () => {
    const msgs = [
      {
        id: "3",
        text:
          "🚨 BSC signal\n$PEPE2 Price: $0.000012 Liq: $30k\n0x1234567890abcdef1234567890abcdef12345678",
        postedAt: 1_700_000_000_000,
        link: "https://t.me/test/3",
      },
    ];
    const out = parseChannelMessages(msgs);
    expect(out.length).toBe(1);
    expect(out[0]!.chain).toBe("bsc");
    expect(out[0]!.address).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  test("a message with an explicit solana hint and both address kinds yields both", () => {
    const msgs = [
      {
        id: "4",
        text:
          "Dual listing solana + bsc\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd\nEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        postedAt: 1_700_000_000_000,
        link: "",
      },
    ];
    const out = parseChannelMessages(msgs);
    const chains = out.map((o) => o.chain).sort();
    expect(chains).toEqual(["bsc", "solana"]);
  });
});
