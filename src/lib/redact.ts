/**
 * RPC endpoints without their credentials.
 *
 * Provider keys ride inside the URL — `?api-key=…` on Helius, `/v2/<key>` on
 * Alchemy, userinfo on a private gateway — and those strings end up in
 * operator-facing errors, toasts, logs and support tickets. The host is enough
 * to identify which endpoint a message is about; the secret half must not
 * travel with it.
 *
 * Deliberately conservative: a query string is dropped entirely (its values are
 * usually the key), any path segment long enough to be a key is masked, and
 * `user:pass@` userinfo never survives because only the parsed host is used.
 */

/** Path segments at least this long are treated as keys and masked. */
const KEY_LIKE_SEGMENT_LENGTH = 12;

export function redactRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all (a cluster name, an empty setting) — it cannot be
    // printed as an endpoint, and echoing it verbatim could be the key.
    return "(unreadable RPC URL)";
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => (segment.length >= KEY_LIKE_SEGMENT_LENGTH ? "***" : segment))
    .join("/");
  // `parsed.host` excludes userinfo, so `https://user:pass@host` keeps only host.
  const query = parsed.search ? "?***" : "";
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}
