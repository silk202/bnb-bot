/**
 * Telegram signal copier — shared parser, types and source registry.
 *
 * The Copier bot watches signal channels (t.me/AveSignalMonitor and any
 * operator-added channel) via their public web previews (t.me/s/<channel>),
 * parses token signals out of the raw HTML, scores them through gates
 * (liquidity, recency, buy pressure, honeypot heuristics), and surfaces the
 * profitable survivors for automated manual/auto snipe or arbitrage
 * execution in the Sniper terminal and the DEXView/GMGN/Ave overlay's
 * LIVE CANDIDATES.
 */

/** Signal source channels the copier watches — each is polled independently.
 *
 * Two-venue listings: besides brand-new pair channels, the registry tracks
 * channels that post tokens as they EXPAND to a second venue (arbitrage
 * listings, multi-DEX signal monitors) — exactly the profile the Flasher's
 * Telecopier needs to build cross-venue arbitrage routes.
 */
export const COPIER_SOURCES: Array<{ url: string; label: string }> = [
  { url: "https://t.me/s/AveSignalMonitor", label: "Ave Signal Monitor" },
  { url: "https://t.me/s/BSCnewtokenspairs", label: "BSC New Tokens Pairs" },
  { url: "https://t.me/s/arbitjet_arbitrage", label: "ArbitJet Arbitrage" },
  { url: "https://t.me/s/DEXArbitrageSignals", label: "DEX Arbitrage Signals" },
  { url: "https://t.me/s/MultiDexListings", label: "Multi-DEX Listings" },
];

/** Signal sources that specifically post cross-venue (two-venue) listings. */
export const TELECOPIER_SOURCES = COPIER_SOURCES.filter((s) =>
  ["arbitjet_arbitrage", "DEXArbitrageSignals", "MultiDexListings"].some((h) =>
    s.url.includes(h),
  ),
);

/** Source id stamped on signals, derived from the channel URL. */
export function sourceIdFor(url: string): string {
  return url.replace("https://", "").replace("/s/", "/");
}

/**
 * Parse a Telegram Bot API getUpdates response into raw channel messages.
 * Used for channels whose public web preview is disabled:
 * the operator adds the copier bot to the channel and polls via the token.
 */
export function parseTelegramUpdates(json: unknown): RawChannelMessage[] {
  const out: RawChannelMessage[] = [];
  const updates = (json as { result?: Array<Record<string, unknown>> })?.result ?? [];
  for (const u of updates) {
    // channel_post = posts in channels the bot is admin of; message = groups.
    const post = (u.channel_post ?? u.message) as
      | { text?: string; message_id?: number; date?: number; chat?: { username?: string } }
      | undefined;
    if (!post || typeof post.text !== "string") continue;
    const username = post.chat?.username ?? "unknown";
    out.push({
      id: String(post.message_id ?? post.date ?? out.length),
      text: post.text,
      postedAt: (post.date ?? 0) * 1000,
      link: "https://t.me/" + username,
    });
  }
  return out;
}

/** A parsed, gate-passing token signal ready for snipe/arbitrage execution. */
export interface CopierSignal {
  /** Unique key for dedupe: source + token address. */
  id: string;
  source: string;
  sourceLabel: string;
  /** Token contract address as posted. */
  address: string;
  symbol: string;
  name: string;
  /** Chain key when the signal states one (bsc / eth / arbitrum / polygon / base…). */
  chain: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  /** Signal message timestamp (ms) when known. */
  postedAt: number;
  /** ms the signal was captured into the pipeline. */
  capturedAt: number;
  /** Gate verdict: every copier signal is buyable by construction. */
  buyable: boolean;
  /** Raw message excerpt the signal was parsed from (truncated). */
  excerpt: string;
}

/** Raw channel message before enrichment. */
export interface RawChannelMessage {
  id: string;
  text: string;
  postedAt: number;
  link: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/g;
/** Solana base58 addresses (32–44 chars, no 0OIl) — pubkeys / mint addresses. */
const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/** Parse a Solana base58 address candidate and reject obvious false positives
 *  (URLs, telegram handles, plain words). Real pubkeys contain mixed case+digits
 *  and never start with common url/word prefixes. */
export function isLikelySolanaAddress(raw: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return false;
  // Reject base58 strings that are all lowercase or all uppercase or have no
  // digits — real ed25519 pubkeys are effectively random base58.
  const hasDigit = /[0-9]/.test(raw);
  const hasLower = /[a-z]/.test(raw);
  const hasUpper = /[A-Z]/.test(raw);
  if (!hasDigit || !hasLower || !hasUpper) return false;
  // Common false positives seen in signal posts (urls, handles, words).
  if (/^(https?|www|tme|tme[s]|amp)/.test(raw)) return false;
  return true;
}

const CHAIN_HINTS: Array<[RegExp, string]> = [
  [/\b(sui|aptos)\b/i, "other"],
  [/\b(tron|trx)\b/i, "other"],
  [/\b(solana|sol)\b/i, "solana"],
  [/\b(base)\b/i, "base"],
  [/\b(arbitrum|arb)\b/i, "arbitrum"],
  [/\b(eth|ethereum|erc20)\b/i, "ethereum"],
  [/\b(polygon|matic|pol)\b/i, "polygon"],
  [/\b(bsc|bnb|bep20|pancake)\b/i, "bsc"],
];

/** Map a signal's free text onto a chain key; defaults to the dominant chain (bsc). */
export function chainFromText(text: string): string {
  for (const [re, key] of CHAIN_HINTS) if (re.test(text)) return key;
  return "bsc";
}

/**
 * Parse "$1.23k" / "45.6M" / "1234.5" suffix numbers.
 */
function parseCompactNum(raw: string): number {
  const m = raw.replace(/,/g, "").match(/^([\d.]+)\s*([kKmMbB])?/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return 0;
  const suf = (m[2] ?? "").toLowerCase();
  const mult = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : 1;
  return v * mult;
}

function num(text: string, patterns: RegExp[]): number {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const v = parseCompactNum(m[1]);
    if (v > 0) return v;
  }
  return 0;
}

/** Pull the ticker out of the signal text, falling back to an address stub. */
export function symbolFromText(text: string, address: string): string {
  const ticker = text.match(/\$([A-Za-z0-9]{2,15})\b/);
  if (ticker) return ticker[1].toUpperCase();
  const named = text.match(/(?:^|\n)\s*(?:name|token|coin)\s*[:\-]?\s*([A-Za-z0-9$ ]{2,20})/i);
  if (named) return named[1].trim().split(/\s+/)[0].toUpperCase().slice(0, 11);
  return address.slice(0, 6) + "…" + address.slice(-4);
}

/** A single parsed candidate from one message/address pair. */
export interface ParsedSignal {
  address: string;
  symbol: string;
  name: string;
  chain: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  postedAt: number;
  excerpt: string;
}

/**
 * Parse raw channel messages into candidate signals. Returns one signal per
 * address found. Solana messages are parsed natively (base58 mint address +
 * "solana" chain) so the SOL FlashBolt terminal can consume them; EVM
 * signals pass through unchanged for the BNB terminals. Messages without a
 * recognizable address are skipped entirely.
 */
export function parseChannelMessages(messages: RawChannelMessage[]): ParsedSignal[] {
  const out: ParsedSignal[] = [];
  for (const msg of messages) {
    const text = msg.text ?? "";
    const chain = chainFromText(text);
    const evmAddrs = text.match(EVM_ADDR) ?? [];

    // --- Solana messages: strip candidate words then parse base58 mints ---
    if (!evmAddrs.length || chain === "solana") {
      // Remove URLs / handles / t.me links first so their path segments are
      // not mistaken for base58 pubkeys.
      const stripped = text
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\bt\.me\/\S+/g, " ")
        .replace(/@\w+/g, " ");
      const solAddrs = (stripped.match(SOL_ADDR) ?? []).filter(isLikelySolanaAddress);
      // A solana signal needs an explicit solana hint OR a base58 mint with
      // no EVM address in the message.
      const solHints = /\b(solana|raydium|orca|meteora|jupiter|jito|pumpfun|pump\.fun|pumpswap|spl)\b/i;
      if (solAddrs.length && (solHints.test(text) || !evmAddrs.length)) {
        const priceUsd = num(text, [
          /price[:\s$]+([\d.,]+\s*[kKmMbB]?)\s*(?:usd|\$)/i,
          /\$\s?([\d.,]+\s*[kKmMbB]?)/,
        ]);
        const liquidityUsd = num(text, [
          /(?:liq|liquidity)[:\s$]+([\d.,]+\s*[kKmMbB]?)/i,
        ]);
        const marketCapUsd = num(text, [
          /(?:mc|mcap|market\s*cap)[:\s$]+([\d.,]+\s*[kKmMbB]?)/i,
        ]);
        const symbol = symbolFromText(text, solAddrs[0]!);
        const excerpt = text.length > 180 ? text.slice(0, 180) + "…" : text;
        for (const addr of solAddrs) {
          out.push({
            address: addr,
            symbol,
            name: symbol,
            chain: "solana",
            priceUsd,
            liquidityUsd,
            marketCapUsd,
            postedAt: msg.postedAt || 0,
            excerpt,
          });
        }
        // A pure-solana message yields solana signals only.
        if (!evmAddrs.length) continue;
      } else if (!evmAddrs.length) {
        continue;
      }
    }

    // --- EVM messages (existing behavior) ---
    // When the message ALSO carried a Solana hint (dual listings), the
    // solana chain tag must not leak onto EVM signals — re-derive the EVM
    // chain with solana-specific vocabulary stripped.
    const evmChain = chainFromText(text.replace(/\b(solana|raydium|orca|meteora|jupiter|jito|pumpfun|pump\.fun|pumpswap|spl)\b/gi, " "));
    const priceUsd = num(text, [
      /price[:\s$]+([\d.,]+\s*[kKmMbB]?)\s*(?:usd|\$)/i,
      /\$\s?([\d.,]+\s*[kKmMbB]?)/,
    ]);
    const liquidityUsd = num(text, [
      /(?:liq|liquidity)[:\s$]+([\d.,]+\s*[kKmMbB]?)/i,
    ]);
    const marketCapUsd = num(text, [
      /(?:mc|mcap|market\s*cap)[:\s$]+([\d.,]+\s*[kKmMbB]?)/i,
    ]);
    const symbol = symbolFromText(text, evmAddrs[0] ?? "0x" + "0".repeat(40));
    const excerpt = text.length > 180 ? text.slice(0, 180) + "…" : text;
    for (const addr of evmAddrs) {
      out.push({
        address: addr,
        symbol,
        name: symbol,
        chain: evmChain,
        priceUsd,
        liquidityUsd,
        marketCapUsd,
        postedAt: msg.postedAt || 0,
        excerpt,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML extraction (t.me/s/<channel> public previews)
// ---------------------------------------------------------------------------

/** Strip tags + decode the handful of entities Telegram emits. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Extract raw messages from a t.me/s/<channel> preview page. Each message is
 * an element with class "tgme_widget_message_text" inside a
 * "tgme_widget_message_wrap"; ids and timestamps come from the wrapping
 * message element's data-post / <time datetime>.
 */
export function extractMessagesFromPreview(html: string): RawChannelMessage[] {
  const messages: RawChannelMessage[] = [];
  // Split the page into per-message blocks to keep id/time/text associated.
  const blocks = html.split(/class="tgme_widget_message_wrap/).slice(1);
  for (const block of blocks) {
    const postMatch = block.match(/data-post="[^"]*\/(\d+)"/);
    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    // The text widget: take the FIRST message_text block (replies embed their own).
    const textStart = block.indexOf('class="tgme_widget_message_text');
    if (textStart === -1) continue;
    const openTagEnd = block.indexOf(">", textStart);
    if (openTagEnd === -1) continue;
    let depth = 1;
    let end = openTagEnd + 1;
    let closeStart = -1; // position of the message_text element's own closing tag
    while (end < block.length && depth > 0) {
      const nextOpen = block.indexOf("<", end);
      const nextClose = block.indexOf("</", end);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        // self-closing tags like <br/> don't open a depth
        const selfClosing = block[nextOpen + 1] === "/" || block[block.indexOf(">", nextOpen) - 1] === "/";
        if (!selfClosing) depth++;
        end = block.indexOf(">", nextOpen) + 1;
      } else {
        depth--;
        if (depth === 0) {
          closeStart = nextClose;
          end = block.indexOf(">", nextClose) + 1;
          break;
        }
        end = block.indexOf(">", nextClose) + 1;
      }
    }
    const rawHtml = block.slice(openTagEnd + 1, closeStart === -1 ? end - 3 : closeStart);
    const text = htmlToText(rawHtml);
    if (!text) continue;
    let postedAt = 0;
    if (timeMatch) {
      const t = Date.parse(timeMatch[1]);
      if (Number.isFinite(t)) postedAt = t;
    }
    messages.push({
      id: postMatch ? postMatch[1] : String(postedAt) + ":" + text.slice(0, 24),
      text,
      postedAt,
      link: timeMatch ? timeMatch[1] : "",
    });
  }
  return messages;
}
