/**
 * Platform-aware deep link for the TAEngine bot — the account menu's
 * "Telegram Bot" row navigates with these URLs, both for the native-anchor
 * path (identity already cached) and the one-time connect-then-redirect
 * path. One builder, so both paths are guaranteed to open the same place.
 *
 * URL contracts — each VERIFIED against Telegram Web K's shipped router
 * (web.telegram.org/k, build 2.2/676), not assumed:
 *
 *  • mobile/tablet, with or without a code → `https://t.me/<bot>[?start=code]`
 *    — the official Android App Link / iOS Universal Link: the Telegram app
 *    opens the bot chat directly (Telegram's own get-app page only when the
 *    app is missing).
 *  • desktop, NO code → `https://web.telegram.org/k/#@<bot>` — Web K's
 *    hash router (`onHashChangeUnsafe`) falls through its default branch to
 *    `openUsername({userName: "@<bot>"})`: the bot chat opens immediately.
 *  • desktop, WITH a code → `https://web.telegram.org/k/#?tgaddr=<enc>` where
 *    `<enc>` is `encodeURIComponent("https://t.me/<bot>?start=<code>")` —
 *    the router's `tgaddr` branch calls `openUrl`, which classifies the t.me
 *    URL to its internal `im` handler; that handler builds the link with
 *    `start: "start" in t ? t.start : void 0`, so the pairing payload lands
 *    as the chat's start param (the START button carries `/start <code>`,
 *    and it auto-fires when the bot needs no start button).
 *
 * WHY NOT the shorter-looking `#@<bot>?start=<code>`: Web K splits the hash
 * at `?` for query params but its `@`-branch passes ONLY
 * `{userName, lastMsgId, threadId}` to `openUsername` — the `start` payload
 * is parsed and then silently DROPPED. The chat still opens, but pairing
 * would depend solely on the server's auto-pair policy instead of the code.
 */
export interface TelegramBotLinkInput {
  /** Bot @username WITHOUT the leading @ (e.g. "TAEngine_bot"). */
  username: string;
  /** Live pairing code, or null when none/expired. */
  code: string | null;
  /** True on phones/tablets (Android/iOS UA, or touch-Macintosh iPadOS). */
  mobile: boolean;
}

export function buildTelegramBotLink({
  username,
  code,
  mobile,
}: TelegramBotLinkInput): string {
  if (mobile) {
    return `https://t.me/${username}${code ? `?start=${code}` : ""}`;
  }
  if (!code) {
    return `https://web.telegram.org/k/#@${username}`;
  }
  const target = `https://t.me/${username}?start=${code}`;
  return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(target)}`;
}
