/**
 * Tests for the Freebuff Sites entry Worker (sites/worker.js).
 *
 * Two things are proven here:
 *
 *   1. Deterministically, with a fake ASSETS binding and a fake env:
 *      - only HTML documents are rewritten,
 *      - every script/style tag carries the SAME nonce the policy names,
 *      - the policy is emitted only on a response this Worker rewrote,
 *      - the injected RPC block stays a non-executable `application/json`
 *        element and `<` is escaped.
 *
 *   2. With the operator's REAL configured endpoint, read from the untracked
 *      `.env.local` at run time and never printed: the value an operator sets
 *      in project settings is exactly the value the Worker puts in the served
 *      HTML. Skipped (not faked) when no such variable is configured, so a
 *      clean checkout reports "skipped" rather than a false pass.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import worker, {
  contentSecurityPolicy,
  makeNonce,
  rpcConfigFromEnv,
  withNonce,
} from "./worker.js";

const HTML = `<!doctype html>
<html>
  <head>
    <style>#boot{color:#fff}</style>
    <script type="module" src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.__boot = true;
    </script>
  </body>
</html>`;

function assets(html: string, contentType = "text/html; charset=utf-8") {
  return {
    fetch: async () =>
      new Response(html, {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=0, must-revalidate",
        },
      }),
  };
}

function htmlRequest(path = "/") {
  return new Request(`https://flashbolt.example${path}`, {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
}

describe("sites worker — nonce and policy", () => {
  it("stamps one nonce on every script and style and names it in the policy", async () => {
    const res = await worker.fetch(htmlRequest(), { ASSETS: assets(HTML) });
    const body = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";

    const nonces = [...body.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1]);
    const styleNonces = [...body.matchAll(/<style nonce="([^"]+)"/g)].map((m) => m[1]);

    expect(nonces.length).toBe(2); // the module bundle + the inline boot script
    expect(styleNonces.length).toBe(1);
    expect(new Set([...nonces, ...styleNonces]).size).toBe(1);

    const nonce = nonces[0];
    const scriptSrc = csp.split("script-src")[1]?.split(";")[0] ?? "";
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    // Trust is anchored on the nonce; dynamic helpers are reached through it.
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("http");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a different nonce per response", async () => {
    const a = await worker.fetch(htmlRequest(), { ASSETS: assets(HTML) });
    const b = await worker.fetch(htmlRequest(), { ASSETS: assets(HTML) });
    const nonceOf = (html: string) => /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonceOf(await a.text())).not.toBe(nonceOf(await b.text()));
  });

  it("never rewrites or policy-stamps a non-HTML response", async () => {
    const js = "console.log('bundle')";
    const res = await worker.fetch(htmlRequest("/assets/index-abc123.js"), {
      ASSETS: assets(js, "text/javascript; charset=utf-8"),
    });
    expect(await res.text()).toBe(js);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("leaves a document untouched when the client did not ask for HTML", async () => {
    // curl / fetch defaults — the asset layer's response, no CSP, no nonce.
    const request = new Request("https://flashbolt.example/", { headers: { accept: "*/*" } });
    const res = await worker.fetch(request, { ASSETS: assets(HTML) });
    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("keeps HEAD responses body-less while still sending the policy", async () => {
    const request = new Request("https://flashbolt.example/", {
      method: "HEAD",
      headers: { accept: "text/html" },
    });
    const res = await worker.fetch(request, { ASSETS: assets(HTML) });
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-security-policy")).toContain("script-src");
  });
});

describe("sites worker — RPC injection", () => {
  it("injects configured endpoints as non-executable JSON, escaping '<'", async () => {
    const env = {
      BSC_MAINNET_RPC_URL: "https://rpc.example.invalid/bsc</script>",
      WEBSOCKET_MAINNET_URL: "wss://ws.example.invalid",
      UNRELATED_SECRET: "must-not-appear",
      CONVEX_DEPLOY_KEY: "must-not-appear",
    };
    const res = await worker.fetch(htmlRequest(), { ASSETS: assets(HTML), ...env });
    const body = await res.text();

    const block = /<script id="flashbolt-rpc-config" type="application\/json" nonce="([^"]+)">(.*?)<\/script>/s.exec(body);
    expect(block).not.toBeNull();
    expect(body).not.toContain("must-not-appear");
    expect(block![1]).toBe(/<script nonce="([^"]+)"/.exec(body)?.[1]);

    const parsed = JSON.parse(block![2].replace(/\\u003c/g, "<")) as {
      BSC: { http: string[]; websocket: string[] };
      env: Record<string, string>;
    };
    expect(parsed.BSC.http).toEqual(["https://rpc.example.invalid/bsc</script>"]);
    expect(parsed.BSC.websocket).toEqual(["wss://ws.example.invalid"]);
    expect(parsed.env["BSC_MAINNET_RPC_URL"]).toBe("https://rpc.example.invalid/bsc</script>");
  });

  it("does not inject a block when nothing is configured", async () => {
    const res = await worker.fetch(htmlRequest(), { ASSETS: assets(HTML) });
    expect(await res.text()).not.toContain("flashbolt-rpc-config");
  });

  it("drops malformed values instead of passing them to the chain", () => {
    const config = rpcConfigFromEnv({
      BSC_MAINNET_RPC_URL: "javascript:alert(1), https://ok.example.invalid",
      WEBSOCKET_MAINNET_URL: "not-a-websocket",
    });
    expect(config.BSC).toEqual({ http: ["https://ok.example.invalid"], websocket: [] });
    expect(config.env).toEqual({ BSC_MAINNET_RPC_URL: "https://ok.example.invalid" });
  });

  it("mints a URL-safe nonce and a policy that names it", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(contentSecurityPolicy(nonce)).toContain(`'nonce-${nonce}'`);
    expect(withNonce('<script src="/a.js"></script>', nonce)).toContain(`<script nonce="${nonce}" src="/a.js">`);
  });
});

/**
 * The real-secret proof.
 *
 * Reads the operator's untracked `.env.local` (never committed, never printed)
 * and asserts the exact configured endpoint — byte for byte — reaches the HTML
 * the Worker serves. Only a masked host and a length are reported, so the value
 * cannot leak through CI output or a transcript.
 */
describe("sites worker — real configured secret", () => {
  const envPath = join(import.meta.dir, "..", ".env.local");
  const key = "BSC_MAINNET_RPC_URL";
  let realValue: string | undefined;

  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    if (line) {
      realValue = line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .trim();
    }
  }

  it.skipIf(!realValue)(`injects every endpoint the operator configured in ${key} unchanged`, async () => {
    // A variable may name several endpoints, so the proof is: every configured
    // URL reaches the client list, byte for byte, and none is dropped.
    const expected = realValue!
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter((v) => /^https?:\/\//i.test(v));
    expect(expected.length).toBeGreaterThan(0);

    const res = await worker.fetch(htmlRequest(), {
      ASSETS: assets(HTML),
      [key]: realValue,
    });
    const body = await res.text();
    const start = body.indexOf('<script id="flashbolt-rpc-config" type="application/json"');
    expect(start).toBeGreaterThan(-1);
    const end = body.indexOf("</script>", start);
    const payload = body.slice(body.indexOf(">", start) + 1, end);

    const parsed = JSON.parse(payload) as {
      BSC?: { http: string[]; websocket: string[] };
      env?: Record<string, string>;
    };
    expect(parsed.BSC?.http).toEqual(expected);
    expect(parsed.env?.[key]).toBe(expected.join(","));

    const host = new URL(expected[0]).host;
    // Only the protocol, host length and count are reported — no host
    // characters, so an API key in a hostname or path cannot leak into output.
    console.log(
      `  ✓ real ${key}: ${expected.length} endpoint(s) injected (${new URL(expected[0]).protocol}, ${host.length}-char host)`,
    );
  });

  it.skipIf(!realValue)("does not leak the configured endpoint into a non-HTML response", async () => {
    const first = realValue!
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter((v) => /^https?:\/\//i.test(v))[0];
    const res = await worker.fetch(htmlRequest("/assets/app.js"), {
      ASSETS: assets("console.log(1)", "text/javascript"),
      [key]: realValue,
    });
    expect(await res.text()).not.toContain(first);
  });
});
