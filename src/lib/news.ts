/**
 * Pure helpers for the real RSS market-news pipeline — kept dependency-free
 * so the parsing and watchlist matching can be unit-tested. The Convex news
 * action (src/convex/news.ts) uses these to fetch real CoinDesk /
 * CoinTelegraph / Decrypt headlines, cache them and match brand-new items
 * against the high-signal watchlist. Nothing here is generated or simulated:
 * the functions only ever transform and filter real published content.
 */

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  pubDate: string;
  summary: string;
}

/** Default high-signal watchlist — matches the original hardcoded regex. */
export const DEFAULT_NEWS_KEYWORDS = [
  "flash loan",
  "flashloan",
  "arbitrage",
  "mev",
  "sandwich",
  "hack",
  "hacked",
  "hacker",
  "exploit",
  "vulnerability",
  "drain",
  "delist",
] as const;

/** Minimal XML-safe entity / CDATA / tag stripping for RSS item fields. */
export function cleanXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRssItems(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const grab = (tag: string): string => {
      const inner = block.match(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`),
      );
      return inner ? cleanXml(inner[1]) : "";
    };
    const title = grab("title");
    const link = grab("link").trim();
    if (!title || !link || !/^https?:\/\//.test(link)) continue;
    items.push({
      source,
      title,
      link,
      pubDate: grab("pubDate"),
      summary: grab("description").slice(0, 240),
    });
  }
  return items;
}

/**
 * Build a case-insensitive high-signal matcher from watchlist keywords.
 * Each keyword is anchored to a word start; any trailing word characters are
 * allowed so plurals and inflections (hacks, drained, vulnerabilities) still
 * match, while the keyword itself must still appear verbatim (\b cannot be
 * quantified in JS, so a soft tail is used instead of \b?).
 */
export function buildHighSignalRe(
  keywords: readonly string[],
): RegExp {
  const pattern = keywords
    .filter((k) => k.trim().length > 0)
    .map((k) => {
      const esc = k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `\\b${esc}\\w*`;
    })
    .join("|");
  return pattern.length > 0 ? new RegExp(pattern, "i") : /(?!)/;
}

/** Does a real headline/summary match the high-signal watchlist? */
export function isHighSignal(
  text: string,
  keywords: readonly string[] = DEFAULT_NEWS_KEYWORDS,
): boolean {
  return buildHighSignalRe(keywords).test(text);
}
