import { describe, expect, test } from "bun:test";
import {
  buildHighSignalRe,
  cleanXml,
  DEFAULT_NEWS_KEYWORDS,
  isHighSignal,
  parseRssItems,
} from "../news";

describe("cleanXml — RSS field sanitizer", () => {
  test("strips CDATA wrappers", () => {
    expect(cleanXml("<![CDATA[Flash loan profits surge]]>")).toBe(
      "Flash loan profits surge",
    );
  });

  test("decodes XML entities", () => {
    expect(cleanXml("Arbitrage &amp; MEV &lt;3 &quot;hot&quot; &#39;news&#39;")).toBe(
      "Arbitrage & MEV <3 \"hot\" 'news'",
    );
  });

  test("strips inline tags and collapses whitespace", () => {
    expect(cleanXml("<p>Hack  on   DeFi</p>  protocol")).toBe(
      "Hack on DeFi protocol",
    );
  });
});

describe("parseRssItems — real RSS parsing", () => {
  const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title><![CDATA[Flash loan arbitrage finds new edge on BSC]]></title>
      <link>https://example.com/flash-loan-edge</link>
      <pubDate>Mon, 12 Aug 2024 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>DeFi protocol reports record volume.</p>]]></description>
    </item>
    <item>
      <title>Exploit drained $4M from lending market</title>
      <link>https://example.com/exploit-drain</link>
      <pubDate>Mon, 12 Aug 2024 09:00:00 GMT</pubDate>
      <description>No CDATA here &amp; entities.</description>
    </item>
    <item>
      <title>Missing link item must be skipped</title>
      <link></link>
      <pubDate>Mon, 12 Aug 2024 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Relative link item must be skipped</title>
      <link>/only-a-path</link>
      <pubDate>Mon, 12 Aug 2024 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  test("parses real items and skips entries without valid absolute links", () => {
    const items = parseRssItems(SAMPLE_RSS, "CoinDesk");
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Flash loan arbitrage finds new edge on BSC");
    expect(items[0].link).toBe("https://example.com/flash-loan-edge");
    expect(items[0].source).toBe("CoinDesk");
    expect(items[0].pubDate).toContain("2024");
    expect(items[1].summary).toBe("No CDATA here & entities.");
  });

  test("returns an empty array for non-RSS input", () => {
    expect(parseRssItems("<html><body>not rss</body></html>", "Decrypt")).toEqual(
      [],
    );
  });
});

describe("isHighSignal — high-signal watchlist matching", () => {
  test("default watchlist flags flash-loan and arbitrage headlines", () => {
    expect(isHighSignal("Flash loan profits surge on BNB Chain")).toBe(true);
    expect(isHighSignal("Arbitrage bots rake in record fees")).toBe(true);
    expect(isHighSignal("MEV sandwich attacks climb")).toBe(true);
    expect(isHighSignal("Protocol exploit drains millions")).toBe(true);
    expect(isHighSignal("DeFi hack exposes vulnerability")).toBe(true);
  });

  test("benign headlines do not match", () => {
    expect(isHighSignal("Bitcoin reaches new all-time high")).toBe(false);
    expect(isHighSignal("Ethereum upgrade ships on time")).toBe(false);
  });

  test("custom keywords change what matches", () => {
    expect(
      isHighSignal("Bitcoin ETF approved by SEC", ["bitcoin", "etf"]),
    ).toBe(true);
    expect(isHighSignal("Flash loan profits surge", ["bitcoin", "etf"])).toBe(
      false,
    );
  });

  test("empty keywords never match", () => {
    expect(isHighSignal("Anything at all", [])).toBe(false);
  });

  test("buildHighSignalRe escapes regex metacharacters in keywords", () => {
    const re = buildHighSignalRe(["c++", "mev"]);
    expect(re.test("c++ is dangerous")).toBe(true);
    expect(re.test("mev rising")).toBe(true);
    expect(re.test("c is fine")).toBe(false);
  });

  test("default keywords list is the documented watchlist", () => {
    expect(DEFAULT_NEWS_KEYWORDS).toContain("flash loan");
    expect(DEFAULT_NEWS_KEYWORDS).toContain("arbitrage");
    expect(DEFAULT_NEWS_KEYWORDS).toContain("exploit");
  });
});
