/**
 * RPC endpoints without their credentials.
 *
 * Provider keys ride inside the URL — `?api-key=…` on Helius, `/v2/<key>` on
 * Alchemy, userinfo on a private gateway — and those strings end up in
 * operator-facing errors, toasts, logs and support tickets. The host is enough
 * to identify which endpoint a message is about; the secret half must not
 * travel with it.
 *
 * Deliberately shape-based, not length-based: masking every path segment of 12+
 * characters over-redacted real routes (`/solana-mainnet`, `/mainnet-beta`),
 * which made an outage message less useful without hiding anything. A segment
 * is masked when it LOOKS like a credential — hex/uuid blobs, mixed-case
 * alphanumeric blobs, long opaque tokens, or a segment that names itself a key.
 * Query VALUES never survive (that is where provider keys live); parameter
 * NAMES do, because `?api-key=***` still tells the operator which endpoint
 * shape failed. Userinfo and the fragment are dropped entirely because only
 * `parsed.host` is used and the fragment is never printed.
 */

/** A segment that advertises itself as a credential is one. */
const SECRET_WORD = /(api[-_]?key|secret|token|auth|signature|password)/i;
const HEX = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mixed-case alphanumeric key such as `AbCdEfGhIjKlMnOp` (Alchemy/Infura). */
const MIXED_CASE_BLOB = (segment: string): boolean =>
  segment.length >= 16 && /[A-Z]/.test(segment) && /[a-z]/.test(segment);
/** Anything this long and unbroken is opaque, whatever its case. */
const LONG_BLOB_LENGTH = 24;

/**
 * True when a path segment is shaped like a credential rather than a route.
 * Exported so the redaction contract is testable on its own.
 */
export function looksLikeRpcKey(segment: string): boolean {
  if (!segment) return false;
  if (SECRET_WORD.test(segment)) return true;
  if (UUID.test(segment)) return true;
  // A dash/underscore makes a human route (`solana-mainnet`, `mainnet_beta`).
  const bare = !segment.includes("-") && !segment.includes("_");
  if (!bare) return false;
  if (HEX.test(segment) && segment.length >= 16) return true;
  if (MIXED_CASE_BLOB(segment)) return true;
  return segment.length >= LONG_BLOB_LENGTH;
}

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
    .map((segment) => (looksLikeRpcKey(segment) ? "***" : segment))
    .join("/");
  // Values are masked, names kept: `?api-key=***` names the failure without
  // carrying the key. A valueless flag survives as itself.
  const query = Array.from(parsed.searchParams.entries())
    .map(([name, value]) => (value ? `${name}=***` : name))
    .join("&");
  // `parsed.host` excludes userinfo, so `https://user:pass@host` keeps only host.
  return `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ""}`;
}
