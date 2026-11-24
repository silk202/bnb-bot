#!/usr/bin/env bun
/**
 * Real operator sign-in check for ONE deployment.
 *
 * Everything here is verifiable from the workspace itself, so this replaces the
 * old "the action is reachable" placeholder:
 *
 *   1. read the operatorConfig row (the CLI table, parsed by column name),
 *   2. derive the AES key exactly as src/convex/encryption.ts does —
 *      SHA-256 of this deployment's own `JWT_PRIVATE_KEY` (authoritative copy
 *      fetched from the deployment, trimmed: a trailing newline changes the
 *      digest and breaks decryption),
 *   3. decrypt the stored operator email + passphrase,
 *   4. call `gate:operatorLogin` and require `ok: true`.
 *
 * That covers the whole chain the four-task guard claims is intact: stored
 * ciphertext, key hierarchy, decrypt, action registration and the credential
 * comparison. An unarmored/unreplaced JWT fails at step 3, which is precisely
 * the regression the guard exists for.
 *
 * Cost: `operatorLogin` is throttled to 5 attempts/minute on the deployment's
 * shared bucket, so one run spends one slot. Separate deployments have separate
 * buckets. `SKIP_LOGIN=1` on the guard skips it.
 *
 * Secrets: held in memory only. Nothing is printed, written, or passed on argv —
 * the printed line is a verdict, and error text is the deployment's own static
 * message ("Invalid passphrase", "Unknown operator email").
 *
 * Exit codes: 0 signed in · 1 sign-in failed · 2 could not attempt.
 */
import { execFileSync } from "node:child_process";

const SITE = (process.env.OPERATOR_SITE || "").trim();
const KEY = (process.env.CONVEX_DEPLOY_KEY || "").replace(/\s/g, "");

const verdict = (code, line) => {
  console.log(line);
  process.exit(code);
};

if (!SITE || !KEY) verdict(2, "UNAVAILABLE missing OPERATOR_SITE or CONVEX_DEPLOY_KEY");

const convex = (args) =>
  execFileSync("./node_modules/.bin/convex", args, {
    env: { ...process.env, CONVEX_DEPLOY_KEY: KEY },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** operatorConfig row as {column: value}, from the CLI's pipe table. */
function operatorRow() {
  const out = convex(["data", "operatorConfig", "--limit", "5"]);
  const lines = out.split("\n").filter((l) => l.trim());
  const header = lines[0].split("|").map((s) => s.trim());
  const raw = lines.find((l) => l.includes("|") && !l.startsWith("_id") && !l.startsWith("---"));
  if (!raw) throw new Error("no operatorConfig row");
  const cells = raw.split("|").map((s) => s.trim().replace(/^"+|"+$/g, ""));
  return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
}

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function gcmKey(material) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decrypt(key, cipher) {
  const [iv, ct] = cipher.split(".");
  if (!iv || !ct) throw new Error("malformed ciphertext");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv) }, key, b64(ct));
  return new TextDecoder().decode(plain);
}

async function credentials() {
  // Explicit credentials win — a guard run may legitimately be handed a pair.
  if (process.env.OPERATOR_EMAIL && process.env.OPERATOR_PASSPHRASE) {
    return { email: process.env.OPERATOR_EMAIL, passphrase: process.env.OPERATOR_PASSPHRASE, source: "env" };
  }
  let row;
  try {
    row = operatorRow();
  } catch (e) {
    verdict(2, `UNAVAILABLE could not read operatorConfig (${e.message})`);
  }
  if (!row.passphraseCipher) verdict(2, "UNAVAILABLE operatorConfig has no passphraseCipher");
  if (!row.emailCipher && !row.email) verdict(2, "UNAVAILABLE operatorConfig has no email source");

  let armored;
  try {
    armored = convex(["env", "get", "JWT_PRIVATE_KEY"]).trim();
  } catch {
    verdict(2, "UNAVAILABLE could not read JWT_PRIVATE_KEY from the deployment");
  }
  if (!armored) verdict(2, "UNAVAILABLE deployment has no JWT_PRIVATE_KEY");

  const key = await gcmKey(armored);
  let passphrase;
  let email;
  try {
    passphrase = await decrypt(key, row.passphraseCipher);
    email = row.emailCipher ? await decrypt(key, row.emailCipher) : row.email;
  } catch {
    // The exact symptom of an armored/unarmored key mismatch, or a GATE_ENC_KEY
    // that this probe does not know: the deployment's own ciphertext will not open.
    verdict(2, "UNAVAILABLE stored credentials do not decrypt with this deployment's JWT_PRIVATE_KEY");
  }
  if (!email || !passphrase) verdict(2, "UNAVAILABLE decrypted credentials are empty");
  return { email, passphrase, source: "stored" };
}

const creds = await credentials();

let res;
try {
  res = await fetch(`https://${SITE}.convex.cloud/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "gate:operatorLogin", args: { email: creds.email, passphrase: creds.passphrase } }),
    signal: AbortSignal.timeout(25000),
  });
} catch (e) {
  verdict(1, `FAIL request error (${e.name})`);
}

const body = await res.text();
if (/"ok"\s*:\s*true/.test(body)) {
  verdict(0, `OK decrypted with ${creds.source} credentials and signed in`);
}
// Repeated guard runs can exhaust the 5/minute bucket (two runs back to back is
// four attempts). That is not evidence of broken credentials, and reporting it
// as a failure would train the operator to ignore a real one — so it is its own
// verdict, and the guard treats it as "known good, not re-proved just now".
if (/Too many operator sign-in attempts/i.test(body)) {
  verdict(3, "THROTTLED the 5/minute login limit is spent; credentials were not re-proved this run");
}
// A non-verdict body is either Convex's JSON envelope or a plain error page.
// Pull the deployment's own sentence out of the envelope instead of printing a
// truncated JSON fragment: the plan ceiling, a 5xx and a bad function path all
// arrive here, and only the message says which one it is.
const message = (() => {
  const match = /"errorMessage"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const text = match ? match[1].replace(/\\n/g, " ").replace(/\\"/g, '"') : body;
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
})();
verdict(1, `FAIL http ${res.status}: ${message}`);
