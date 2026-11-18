/**
 * Copier bot parser tests — real parsing behavior of the shared
 * copier-signals library: the source registry, HTML preview extraction,
 * address/chain/symbol parsing, Bot API updates parsing and dedupe keys.
 */
import { describe, expect, test } from "bun:test";
import {
  COPIER_SOURCES,
  chainFromText,
  extractMessagesFromPreview,
  htmlToText,
  parseChannelMessages,
  parseTelegramUpdates,
  sourceIdFor,
  symbolFromText,
} from "./copier-signals";

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

describe("copier sources", () => {
  test("watches both requested Telegram channels", () => {
    const urls = COPIER_SOURCES.map((s) => s.url);
    expect(urls).toContain("https://t.me/s/AveSignalMonitor");
    expect(urls).toContain("https://t.me/s/BSCnewtokenspairs");
    expect(urls).not.toContain("https://t.me/s/Tokenscan");
    // The registry grew with the operator-requested two-venue channels
    // (arbitjet + arbitrage/listing feeds) — the originals stay intact.
    expect(urls).toContain("https://t.me/s/arbitjet_arbitrage");
    expect(COPIER_SOURCES.length).toBeGreaterThanOrEqual(4);
  });

  test("sourceIdFor derives stable per-channel dedupe keys", () => {
    expect(sourceIdFor("https://t.me/s/AveSignalMonitor")).toBe("t.me/AveSignalMonitor");
    expect(sourceIdFor("https://t.me/s/BSCnewtokenspairs")).toBe("t.me/BSCnewtokenspairs");
  });
});

describe("htmlToText", () => {
  test("strips tags and decodes entities", () => {
    expect(htmlToText("<p>Buy <b>$FOO</b> &amp; moon</p>")).toBe("Buy $FOO & moon");
    expect(htmlToText("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToText("&quot;quoted&quot; &#39;single&#39; &lt;tag&gt;")).toBe('"quoted" \'single\' <tag>');
  });
});

describe("parseChannelMessages", () => {
  test("parses an EVM token signal with chain, symbol and metrics", () => {
    const sigs = parseChannelMessages([
      {
        id: "1",
        text: `New gem $PEPE on BSC!\nCA: ${ADDR_A}\nLiq: $35k MC: $120k Price: $0.00001`,
        postedAt: 1700000000000,
        link: "https://t.me/AveSignalMonitor/1",
      },
    ]);
    expect(sigs.length).toBe(1);
    const s = sigs[0]!;
    expect(s.address).toBe(ADDR_A);
    expect(s.symbol).toBe("PEPE");
    expect(s.chain).toBe("bsc");
    expect(s.liquidityUsd).toBe(35000);
    expect(s.marketCapUsd).toBe(120000);
    expect(s.postedAt).toBe(1700000000000);
  });

  test("emits one signal per EVM address in the message", () => {
    const sigs = parseChannelMessages([
      { id: "2", text: `Pair watch ${ADDR_A} and ${ADDR_B} on arbitrum`, postedAt: 0, link: "" },
    ]);
    expect(sigs.map((s) => s.address)).toEqual([ADDR_A, ADDR_B]);
    expect(sigs[0]!.chain).toBe("arbitrum");
  });

  test("maps ethereum/polygon chain hints", () => {
    expect(chainFromText("erc20 launch on eth")).toBe("ethereum");
    expect(chainFromText("matic pol token")).toBe("polygon");
    expect(chainFromText("base runner")).toBe("base");
  });

  test("defaults to bsc when no chain is stated", () => {
    expect(chainFromText("no chain hint here")).toBe("bsc");
  });

  test("skips solana-only signals (EVM-only sniper)", () => {
    const sigs = parseChannelMessages([
      { id: "3", text: "Solana runner 7VfCXTUz3mABqefG3YJ2xzgBWkYv6YbMKmQ9STPumpFun", postedAt: 0, link: "" },
    ]);
    expect(sigs.length).toBe(0);
  });

  test("skips messages without any address", () => {
    const sigs = parseChannelMessages([{ id: "4", text: "market looking spicy today", postedAt: 0, link: "" }]);
    expect(sigs.length).toBe(0);
  });

  test("falls back to an address-stub symbol when no ticker present", () => {
    const sigs = parseChannelMessages([
      { id: "5", text: `fresh contract ${ADDR_A}`, postedAt: 0, link: "" },
    ]);
    expect(sigs[0]!.symbol).toContain("0x");
  });
});

describe("symbolFromText", () => {
  test("extracts the $TICKER", () => {
    expect(symbolFromText("buy $wojak now", ADDR_A)).toBe("WOJAK");
  });
});

describe("extractMessagesFromPreview", () => {
  test("extracts message text, post id and timestamp from a t.me/s page", () => {
    const html = `
      <html><body>
      <div class="tgme_widget_message_wrap js-widget_message_wrap">
        <div class="tgme_widget_message" data-post="AveSignalMonitor/42">
          <div class="tgme_widget_message_bubble">
            <time datetime="2026-01-01T12:00:00+00:00"></time>
            <div class="tgme_widget_message_text js-message_text" dir="auto">New listing <b>$GEM</b><br>CA: ${ADDR_B} on BSC</div>
          </div>
        </div>
      </div>
      </body></html>`;
    const msgs = extractMessagesFromPreview(html);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.id).toBe("42");
    expect(msgs[0]!.text).toContain("$GEM");
    expect(msgs[0]!.text).toContain(ADDR_B);
    expect(msgs[0]!.postedAt).toBe(Date.parse("2026-01-01T12:00:00+00:00"));

    const sigs = parseChannelMessages(msgs);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.address).toBe(ADDR_B);
    expect(sigs[0]!.symbol).toBe("GEM");
  });

  test("returns nothing for a page without messages", () => {
    expect(extractMessagesFromPreview("<html><body>tg channel</body></html>")).toEqual([]);
  });
});

describe("parseTelegramUpdates", () => {
  test("maps channel_post entries to raw messages", () => {
    const updates = {
      result: [
        {
          channel_post: {
            message_id: 7,
            date: 1700000000,
            text: `bsc pair alert ${ADDR_A} on eth`,
            chat: { username: "BSCnewtokenspairs" },
          },
        },
      ],
    };
    const msgs = parseTelegramUpdates(updates);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.id).toBe("7");
    expect(msgs[0]!.link).toBe("https://t.me/BSCnewtokenspairs");
    expect(msgs[0]!.postedAt).toBe(1700000000000);

    const sigs = parseChannelMessages(msgs);
    expect(sigs[0]!.address).toBe(ADDR_A);
    expect(sigs[0]!.chain).toBe("ethereum");
  });

  test("ignores non-text updates", () => {
    expect(parseTelegramUpdates({ result: [{ edited_message: { text: undefined } }] })).toEqual([]);
  });
});
