#!/usr/bin/env bun
/**
 * One deploy config, checked.
 *
 * `wrangler.toml` is the single source of truth for how the site is deployed:
 * the Worker entry, the compatibility date and the static-asset directory. The
 * platform's deploy call needs those values in `sites.deploy.json` as well, and
 * that duplication is unavoidable — what is avoidable is the two files drifting
 * apart until a deploy builds one tree and uploads another.
 *
 * This asserts parity instead of trusting it, checks that every declared module
 * exists, and refuses a config that points at a committed build output.
 *
 * Usage: bun scripts/check-deploy-config.mjs   (also run by `bun run verify`)
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const fail = (message) => {
  console.error(`    FAIL: ${message}`);
  process.exit(1);
};

const toml = readFileSync("wrangler.toml", "utf8");
const manifest = JSON.parse(readFileSync("sites.deploy.json", "utf8"));

/** Read `key = "value"` from a TOML section (empty string = top level). */
function readValue(section, key) {
  const lines = toml.split("\n");
  let inSection = section === "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    if (match && match[1] === key) return match[2];
  }
  return undefined;
}

const name = readValue("", "name");
const compatibilityDate = readValue("", "compatibility_date");
const main = readValue("", "main");
const assetsDirectory = readValue("assets", "directory");
const assetsBinding = readValue("assets", "binding");
const notFoundHandling = readValue("assets", "not_found_handling");

if (!name || !compatibilityDate || !main || !assetsDirectory) {
  fail("wrangler.toml is missing name / compatibility_date / main / [assets].directory");
}
if (assetsBinding !== "ASSETS") {
  fail(`wrangler.toml must bind the assets to ASSETS (found ${assetsBinding ?? "nothing"})`);
}

const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
const problems = [];

if (manifest.compatibilityDate !== compatibilityDate) {
  problems.push(`compatibilityDate: sites.deploy.json says ${manifest.compatibilityDate}, wrangler.toml says ${compatibilityDate}`);
}
if (modules.length === 0) {
  problems.push("sites.deploy.json declares no modules");
}
for (const module of modules) {
  const path = resolve(module.path ?? "");
  if (!module.path || !existsSync(path)) problems.push(`module path does not exist: ${module.path}`);
  if (module.type !== "esm") problems.push(`module ${module.name} must be type "esm"`);
}
const entryModule = modules.find((module) => module.name === manifest.entrypoint);
if (!entryModule) problems.push(`entrypoint ${manifest.entrypoint} is not one of the declared modules`);
if (modules.length > 0 && modules[0].path && `./${modules[0].path.replace(/^\.\//, "")}` !== `./${main}`) {
  problems.push(`sites.deploy.json serves ${modules[0].path}, wrangler.toml main is ${main}`);
}
if (manifest.assetsDirectory !== assetsDirectory) {
  problems.push(`assetsDirectory: sites.deploy.json says ${manifest.assetsDirectory}, wrangler.toml says ${assetsDirectory}`);
}
if (manifest.spa !== (notFoundHandling === "single-page-application")) {
  problems.push(
    `spa=${manifest.spa} in sites.deploy.json but not_found_handling=${notFoundHandling ?? "unset"} in wrangler.toml`,
  );
}

// A deploy must never upload a tree that is also tracked by git: that is how a
// stale copy becomes "the build" on one platform and a leftover on another.
const gitignore = readFileSync(".gitignore", "utf8");
const ignored = gitignore
  .split("\n")
  .map((line) => line.trim())
  .includes(assetsDirectory.replace(/^\.\//, "").replace(/\/$/, ""));
if (!ignored) problems.push(`${assetsDirectory} is not git-ignored — build output must not be committed`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`    FAIL: ${problem}`);
  process.exit(1);
}

const moduleNames = modules.map((module) => `${module.name} (${basename(module.path)})`).join(", ");
console.log(
  `    ${name}: ${moduleNames} → ${assetsDirectory}${manifest.spa ? " · SPA fallback" : ""} · compat ${compatibilityDate} · in sync`,
);
