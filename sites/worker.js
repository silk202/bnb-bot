// Freebuff Sites entry Worker.
//
// The app is a client-side Vite/React SPA. Routing, asset delivery and the
// single-page fallback are handled by the platform's static-assets binding, so
// this Worker forwards requests to it.
//
// For HTML documents it does two things the static layer cannot:
//
//   1. RPC configuration bridge — a static SPA cannot read server-side
//      secrets, and rebuilding just to change an endpoint is fragile. The
//      configured endpoints are injected as a non-executable JSON block
//      (`application/json`), which rpc-registry.ts reads from the DOM. Nothing
//      is logged, and no other secret is exposed this way.
//   2. A per-response nonce and a matching Content-Security-Policy. The policy
//      is only emitted on a response this Worker actually rewrote, so a host
//      that serves the same `dist/` without the Worker (Vercel, a plain static
//      server) is never sent a policy whose nonce its HTML does not carry.
//
// The nonce goes on every `<script>`/`<style>` tag in the document, including
// the inline boot watchdog and the boot-loader style block. No inline event
// handler is left in index.html, because a nonce policy blocks `onclick=`
// attributes — the crash watchdog binds its Reload button in script instead.
const RPC_KEYS = {
  BSC: { http: ["BSC_MAINNET_RPC_URL", "BNB_MAINNET_RPC_URL"], ws: ["WEBSOCKET_MAINNET_URL", "BSC_MAINNET_WS_URL"] },
  BSC_TESTNET: { http: ["BSC_TESTNET_RPC_URL", "BNB_TESTNET_RPC_URL"], ws: ["WEBSOCKET_TESTNET_URL", "BSC_TESTNET_WS_URL"] },
  ETHEREUM: { http: ["ETH_MAINNET_RPC_URL", "ETHEREUM_MAINNET_RPC_URL"], ws: [] },
  ETHEREUM_SEPOLIA: { http: ["ETH_SEPOLIA_RPC_URL", "SEPOLIA_RPC_URL", "ETHEREUM_SEPOLIA_RPC_URL"], ws: [] },
  ARBITRUM: { http: ["ARBITRUM_MAINNET_RPC_URL"], ws: [] },
  ARBITRUM_SEPOLIA: { http: ["ARBITRUM_SEPOLIA_RPC_URL"], ws: [] },
  POLYGON: { http: ["POLYGON_MAINNET_RPC_URL"], ws: [] },
  POLYGON_AMOY: { http: ["POLYGON_AMOY_RPC_URL"], ws: [] },
  BASE: { http: ["BASE_MAINNET_RPC_URL", "BASE_RPC_URL"], ws: ["BASE_MAINNET_WS_URL"] },
  BASE_SEPOLIA: { http: ["BASE_TESTNET_RPC_URL", "BASE_SEPOLIA_RPC_URL"], ws: ["BASE_TESTNET_WS_URL"] },
  OPTIMISM: { http: ["OPTIMISM_MAINNET_RPC_URL", "OP_MAINNET_RPC_URL"], ws: [] },
  OPTIMISM_SEPOLIA: { http: ["OPTIMISM_SEPOLIA_RPC_URL", "OP_SEPOLIA_RPC_URL"], ws: [] },
};

const HTTP = /^https?:\/\/[^\s]+$/i;
const WS = /^wss?:\/\/[^\s]+$/i;

function readList(value, pattern) {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter((v) => v && pattern.test(v));
}

/**
 * Collect configured endpoints. Values never leave the response body.
 *
 * Two shapes are emitted:
 *   - per-network blocks from the names above,
 *   - `env`: every configured RPC/WS value under its own name.
 * The second one matters because operators put several chains in one variable;
 * variable names cannot identify a chain, so the client probes `eth_chainId`
 * and files each URL under the chain it proves (see rpc-pools.ts).
 */
export function rpcConfigFromEnv(env) {
  const out = {};
  for (const [key, names] of Object.entries(RPC_KEYS)) {
    const http = names.http.flatMap((name) => readList(env?.[name], HTTP));
    const websocket = names.ws.flatMap((name) => readList(env?.[name], WS));
    if (http.length > 0 || websocket.length > 0) out[key] = { http, websocket };
  }

  const envValues = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!/(RPC_URL|RPC_URLS|WEBSOCKET|_WS_URL)$/i.test(name)) continue;
    if (typeof value !== "string") continue;
    const urls = readList(value, HTTP).concat(readList(value, WS));
    if (urls.length > 0) envValues[name] = urls.join(",");
  }
  if (Object.keys(envValues).length > 0) out.env = envValues;
  return out;
}

const JSON_SAFE = (config) => JSON.stringify(config).replace(/</g, "\\u003c");

/**
 * A fresh nonce per document response (128 bits, base64url).
 *
 * `crypto.getRandomValues` is available in Workers. The fallback keeps the
 * Worker honest if it is ever imported somewhere without WebCrypto: it still
 * returns a usable nonce instead of throwing on a page load.
 */
export function makeNonce() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * The document policy.
 *
 *   • `script-src` is nonce-anchored — this is the whole point: an injected
 *     inline script cannot run without the nonce, and the nonce is not
 *     guessable from the previous response. `'strict-dynamic'` extends trust
 *     transitively to scripts that an already-trusted script creates (the
 *     preview host's helper, wallet SDK chunks); it does NOT allow arbitrary
 *     third-party hosts to be named in the policy.
 *   • `'wasm-unsafe-eval'` is required by the real solc compiler on the Contract
 *     page, which instantiates WebAssembly inside its module Worker. It permits
 *     wasm compilation only — not `eval()` of JavaScript strings.
 *   • `style-src 'unsafe-inline'` is required by React's `style` props and the
 *     boot-loader `<style>`; a nonce alone cannot cover attribute styles.
 *   • `connect-src https: wss:` is required because RPC endpoints are
 *     operator-supplied and can be any host, as is the Convex deployment.
 *   • `frame-src https:` keeps wallet-provider popups/iframes working;
 *     `frame-ancestors 'none'` matches the static `X-Frame-Options: DENY`.
 */
export function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' https:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Stamp the nonce on every script/style element that does not already have one. */
export function withNonce(html, nonce) {
  return html
    .replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
}

function wantsHtmlDocument(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (!wantsHtmlDocument(request) || !response.ok) return response;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return response;

    const nonce = makeNonce();
    const config = rpcConfigFromEnv(env);
    const html = await response.text();
    let injected = withNonce(html, nonce);
    if (Object.keys(config).length > 0) {
      injected = injected.replace(
        "</head>",
        `<script id="flashbolt-rpc-config" type="application/json" nonce="${nonce}">${JSON_SAFE(config)}</script></head>`,
      );
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("cache-control", "no-store");
    headers.set("content-security-policy", contentSecurityPolicy(nonce));
    return new Response(request.method === "HEAD" ? null : injected, {
      status: response.status,
      headers,
    });
  },
};
