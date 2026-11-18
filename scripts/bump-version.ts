/**
 * bump-version.ts — one command, every surface in lockstep.
 *
 * A version bump must reach ALL of these at once or they drift:
 *   - package.json                       (the app)
 *   - src/lib/overlay-script.ts          OVERLAY_VERSION   (BNB overlay)
 *   - src/lib/sol-overlay-script.ts      SOL_OVERLAY_VERSION (SOL overlay)
 *   - CHANGELOG.md                       (new section stub)
 *   - public/overlay/*                   (rebuilt zips + userscript served
 *                                         by the Downloads page — done by
 *                                         running the overlay build)
 * The version-sync test (src/lib/__tests__/version-sync.test.ts) enforces
 * the const ↔ package.json equality, so this script plus that test keep the
 * app, overlay, desktop overlay and downloads surfaces concurrently updated.
 *
 * Usage:
 *   bun scripts/bump-version.ts 2.10.0
 *   bun scripts/bump-version.ts 2.10.0 --dry-run   # show edits, write nothing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+$/;
const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const BNB_SCRIPT_PATH = join(ROOT, "src", "lib", "overlay-script.ts");
const SOL_SCRIPT_PATH = join(ROOT, "src", "lib", "sol-overlay-script.ts");

const BNB_CONST = "OVERLAY_VERSION";
const SOL_CONST = "SOL_OVERLAY_VERSION";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  console.error("Usage: bun scripts/bump-version.ts <x.y.z> [--dry-run]");
  process.exit(1);
}

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!target) fail("missing version argument");
if (!SEMVER.test(target)) fail(`"${target}" is not valid x.y.z semver`);

const read = (path: string) => readFileSync(path, "utf8");

// ── package.json ────────────────────────────────────────────────────────────
const pkgRaw = read(PKG_PATH);
const pkg = JSON.parse(pkgRaw) as { version: string };
const current = pkg.version;
if (target === current) {
  console.log(`✓ already at ${current} — nothing to do`);
  process.exit(0);
}

// ── overlay version consts (exact-line replacement, nothing else touched) ──
function replaceConst(
  path: string,
  source: string,
  constName: string,
  next: string,
): string {
  const pattern = new RegExp(
    `(export const ${constName} = ")\\d+\\.\\d+\\.\\d+(";?)`,
  );
  if (!pattern.test(source)) {
    fail(`could not find ${constName} in ${path}`);
  }
  return source.replace(pattern, `$1${next}$2`);
}

const bnbRaw = read(BNB_SCRIPT_PATH);
const solRaw = read(SOL_SCRIPT_PATH);
const bnbNext = replaceConst(BNB_SCRIPT_PATH, bnbRaw, BNB_CONST, target);
const solNext = replaceConst(SOL_SCRIPT_PATH, solRaw, SOL_CONST, target);

// ── CHANGELOG stub — insert right after the intro paragraph ────────────────
const changelogRaw = read(CHANGELOG_PATH);
const anchor = "All notable changes to FlashBolt.\n";
const stub = `\n## [${target}] — Unreleased\n\n- Describe the release here. Version sync across app + both overlays was\n  handled by \`bun run version:bump\`; the overlay artifacts were rebuilt.\n`;
let changelogNext = changelogRaw;
if (changelogRaw.includes(`## [${target}]`)) {
  console.log(`· CHANGELOG already has a [${target}] section — leaving it`);
} else if (!changelogRaw.includes(anchor)) {
  fail("could not find the CHANGELOG intro anchor line");
} else {
  changelogNext = changelogRaw.replace(anchor, anchor + stub);
}

// ── apply (or print) ────────────────────────────────────────────────────────
const edits: Array<[string, string, string]> = [
  [PKG_PATH, pkgRaw, pkgRaw.replace(current, target)],
  [BNB_SCRIPT_PATH, bnbRaw, bnbNext],
  [SOL_SCRIPT_PATH, solRaw, solNext],
  [CHANGELOG_PATH, changelogRaw, changelogNext],
];

console.log(`Bumping ${current} → ${target}${dryRun ? " (dry run)" : ""}`);
for (const [path, before, after] of edits) {
  if (before === after) {
    console.log(`· ${path.replace(ROOT + "/", "")}: unchanged`);
    continue;
  }
  console.log(`✓ ${path.replace(ROOT + "/", "")}: updated`);
  if (!dryRun) writeFileSync(path, after);
}

if (dryRun) {
  console.log("Dry run — no files written, no overlay rebuilt.");
  process.exit(0);
}

// Rebuild the committed overlay artifacts so the Downloads-page zips and
// userscript carry the new version immediately.
const build = Bun.spawnSync(["bun", "run", "overlay"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  fail("overlay rebuild failed — version files were written; fix and re-run `bun run overlay`");
}

console.log(`\n✓ ${current} → ${target} applied everywhere.`);
console.log("  Next: review CHANGELOG, then `bun test` (version-sync) and commit.");
