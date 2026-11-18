/**
 * Normalize `VITE_CONVEX_URL` before it reaches the Convex client.
 *
 * Why this exists: the value is rewritten by external secret sync (Keys/API
 * keys → `.env.local`) and has come back quoted and space-padded —
 * `' https://<deployment>.convex.cloud'` — which passes a bare `.trim()` and
 * then hands Convex a URL whose first character is a quote. That surfaced as a
 * blank page in a build that looked configured. The URL itself never changed,
 * so the fix belongs on the read side: normalize whatever arrives, and only
 * reject what genuinely is not a URL.
 *
 * Still no default: a build without a usable value renders the "Backend not
 * configured" screen rather than attaching to someone else's deployment
 * (DEPLOYMENT.md — no deployment URL is baked into the source).
 */

import { isForbiddenDeployment } from "./deployment-target";

const QUOTE_CHARS = /^["'`]+|["'`]+$/g;
// Full match on purpose: a value with a path, query or trailing text is not a
// deployment URL, and handing it to Convex produces a confusing failure deeper
// in. Rejecting it yields the honest "Backend not configured" screen instead.
const HTTP_ORIGIN = /^https?:\/\/[^\s/?#]+$/i;

/** Trim, strip wrapping quotes, drop trailing slashes, validate, allowlist. */
export function resolveConvexUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();
  // Repeated because a sync can add both a quote pair and padding, in either
  // order: `' https://… '` → trim → `' https://… '` → strip → trim again.
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(QUOTE_CHARS, "").trim();
    if (next === value) break;
    value = next;
  }
  value = value.replace(/\/+$/, "");
  if (!value || !HTTP_ORIGIN.test(value)) return undefined;
  // Never attach to a foreign deployment: metrics and every other request would
  // point there. Rejected behaves like unconfigured (see deployment-target.ts).
  if (isForbiddenDeployment(value)) return undefined;
  return value;
}

/**
 * The deployment's HTTP-actions origin (`*.convex.site`), which serves
 * `/api/overlay/execution` (daily-target gate) and `/api/copier/signals`.
 */
export function convexHttpOrigin(raw: unknown): string | undefined {
  const url = resolveConvexUrl(raw);
  if (!url) return undefined;
  return url.replace(/\.convex\.cloud$/, ".convex.site");
}
