#!/usr/bin/env bun
/**
 * Same headers, every host.
 *
 * `public/_headers` is what the Workers/Pages static layer sends;
 * `vercel.json` is what `taengine.freebuff.app` sends; `netlify.toml` is what
 * Netlify sends. They are edited by hand in three different formats, so they
 * drift — and the drift is invisible: a host that quietly stopped sending HSTS
 * or `X-Frame-Options` looks identical from the app.
 *
 * This resolves every file the way its host does — every matching rule applied
 * in file order, later values overriding earlier ones — for one path per
 * declared rule, and fails on any header that is missing, different or extra.
 * `public/_headers` is the reference; a host may not invent a header the
 * reference does not declare.
 *
 * Content-Security-Policy is deliberately absent from all three: the nonce is
 * minted per response by `sites/worker.js`, and hosts that do not run the
 * Worker are sent no policy rather than one whose nonce their HTML lacks.
 *
 * Usage: bun scripts/check-headers-parity.mjs   (also run by `bun run verify`)
 */
import { readFileSync } from "node:fs";

const REFERENCE_FILE = "public/_headers";
const HOST_FILES = ["vercel.json", "netlify.toml"];

/** `_headers` → [{ pattern, headers: Map }] (comments and blank lines skipped). */
function parseHeadersFile(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: line, headers: new Map() };
      blocks.push(current);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.+)$/);
    if (current && match) current.headers.set(match[1].toLowerCase(), match[2].trim());
  }
  return blocks;
}

/** Vercel `headers: [{ source, headers: [{key, value}] }]`. */
function parseVercel(text) {
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed.headers) ? parsed.headers : []).map((rule) => ({
    pattern: rule.source,
    headers: new Map((rule.headers ?? []).map((h) => [h.key.toLowerCase(), String(h.value).trim()])),
  }));
}

/**
 * Netlify `[[headers]] for = "…"` + `[headers.values]` blocks. Only that flat
 * shape is read; the `[build]` and `[[redirects]]` tables are ignored.
 */
function parseNetlify(text) {
  const blocks = [];
  let current = null;
  let inValues = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[\[headers\]\]$/.test(line)) {
      current = { pattern: null, headers: new Map() };
      blocks.push(current);
      inValues = false;
      continue;
    }
    if (/^\[headers\.values\]$/.test(line)) {
      inValues = true;
      continue;
    }
    if (line.startsWith("[")) {
      // Any other table (build, redirects, …) ends the header block.
      current = null;
      inValues = false;
      continue;
    }
    if (!current) continue;
    const match = line.match(/^([A-Za-z0-9-]+)\s*=\s*"(.+)"$/);
    if (!match) continue;
    if (match[1] === "for") current.pattern = match[2].trim();
    else if (inValues) current.headers.set(match[1].toLowerCase(), match[2].trim());
  }
  return blocks.filter((block) => block.pattern);
}

/** Cloudflare `*` and Vercel/Netlify `(.*)` all mean "anything"; escape the rest. */
function toRegExp(pattern) {
  const glob = pattern.replace(/\(\.[*]\)/g, "*");
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/** A concrete path the rule definitely applies to, for resolution. */
function probePath(pattern) {
  return pattern.replace(/\(\.[*]\)/g, "probe").replace(/\*/g, "probe");
}

function resolve(rules, path) {
  const effective = new Map();
  for (const rule of rules) {
    if (!toRegExp(rule.pattern).test(path)) continue;
    for (const [key, value] of rule.headers) effective.set(key, value);
  }
  return effective;
}

const reference = {
  label: REFERENCE_FILE,
  rules: parseHeadersFile(readFileSync(REFERENCE_FILE, "utf8")),
};
const hosts = HOST_FILES.map((file) => ({
  label: file,
  rules: file.endsWith(".json")
    ? parseVercel(readFileSync(file, "utf8"))
    : parseNetlify(readFileSync(file, "utf8")),
}));

if (reference.rules.length === 0) {
  console.error(`    FAIL: ${reference.label} declares no header rules`);
  process.exit(1);
}
for (const host of hosts) {
  if (host.rules.length === 0) {
    console.error(`    FAIL: ${host.label} declares no header rules`);
    process.exit(1);
  }
}

const paths = [
  ...new Set(
    [reference, ...hosts].flatMap((source) => source.rules.map((rule) => probePath(rule.pattern))),
  ),
];

const problems = [];
const compared = new Map(hosts.map((host) => [host.label, 0]));

for (const host of hosts) {
  for (const path of paths) {
    const expected = resolve(reference.rules, path);
    const actual = resolve(host.rules, path);
    const keys = new Set([...expected.keys(), ...actual.keys()]);
    for (const key of keys) {
      compared.set(host.label, compared.get(host.label) + 1);
      const want = expected.get(key);
      const got = actual.get(key);
      if (want === undefined) {
        problems.push(`${host.label}: ${path} sends ${key}: ${got} but ${reference.label} does not`);
      } else if (got === undefined) {
        problems.push(`${host.label}: ${path} is missing ${key}: ${want}`);
      } else if (want !== got) {
        problems.push(`${host.label}: ${path} sends ${key}: ${got} — ${reference.label} says ${want}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`    Host headers are out of parity with ${reference.label}:`);
  for (const problem of problems) console.error(`    FAIL: ${problem}`);
  process.exit(1);
}

for (const host of hosts) {
  console.log(
    `    ${reference.label} ↔ ${host.label}: ${paths.length} path(s), ${compared.get(host.label)} header(s) in parity`,
  );
}
