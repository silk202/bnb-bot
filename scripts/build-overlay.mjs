#!/usr/bin/env bun
/**
 * FlashBolt Scanner Overlay builder (CLI).
 *
 * Generates the complete, ready-to-install overlay artifacts with the
 * CURRENT chain registry stamped in:
 *
 *   public/overlay/flashbolt-sniper-overlay.user.js   — Tampermonkey/Violentmonkey userscript
 *   public/overlay/chrome-flashbolt-overlay.zip       — Chrome/Edge/Brave MV3 extension
 *   public/overlay/firefox-flashbolt-overlay.zip      — Firefox MV2 extension
 *   public/overlay/extension-chrome/…                 — unpacked Chrome extension folder
 *   public/overlay/extension-firefox/…                — unpacked Firefox extension folder
 *   public/overlay/README.md                          — install guide for both flavors
 *
 * public/overlay/ is served statically by the app itself (so the /download
 * page links always work) and is safe to commit — the artifacts are
 * deterministic builds from src/lib sources.
 *
 * Usage:
 *   bun run overlay            # build everything into public/overlay/
 *   bun run overlay --out DIR  # build into a custom directory
 *
 * No network access, no secrets — pure local generation from src/lib sources.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExtensionBundle, buildOverlayUserscript } from "../src/lib/overlay-script.ts";
import { CHAIN_INFO } from "../src/lib/chains.ts";
import { buildZip } from "../src/lib/zip.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "public/overlay");

// Chain registry exactly as the terminal ships it.
const chains = Object.values(CHAIN_INFO).map((c) => ({
  key: c.key,
  chainId: c.chainId,
  label: c.label,
  router: c.router,
  wrapped: c.quoteAddress,
  nativeSymbol: c.nativeSymbol,
  rpc: c.rpc,
}));

// Copier signals feed — override with the live deployment URL when set
// (COPIER_SIGNALS_URL), otherwise the overlay polls nothing and relies on
// its own site-layer capture (honest default for artifact builds).
const signalsUrl = process.env.COPIER_SIGNALS_URL || undefined;

// Convex HTTP origin (.convex.site) — stamps the daily-target gate endpoint
// (/api/overlay/execution) into artifact builds. Unset → the artifact ships
// unstamped and behaves as an operator/private install (no server gate).
const httpOrigin = (() => {
  const base = process.env.VITE_CONVEX_URL || "";
  if (!base) return undefined;
  const clean = base.endsWith("/") ? base.slice(0, -1) : base;
  return clean.replace(/\.convex\.cloud$/, ".convex.site");
})();

const config = { appOrigin: "https://flashbolt.app", signalsUrl, httpOrigin, chains };

// 1) Userscript
const userscript = buildOverlayUserscript(config);

// 2) Extension bundles (Chrome MV3 + Firefox MV2)
const bundle = buildExtensionBundle(config);

// 3) Write unpacked folders
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "extension-chrome"), { recursive: true });
mkdirSync(join(outDir, "extension-firefox"), { recursive: true });

for (const e of bundle.chromeEntries) writeFileSync(join(outDir, "extension-chrome", e.name), e.content);
for (const e of bundle.firefoxEntries) writeFileSync(join(outDir, "extension-firefox", e.name), e.content);

// 4) Write zips
const chromeZip = buildZip(bundle.chromeEntries);
const firefoxZip = buildZip(bundle.firefoxEntries);
writeFileSync(join(outDir, "chrome-flashbolt-overlay.zip"), chromeZip);
writeFileSync(join(outDir, "firefox-flashbolt-overlay.zip"), firefoxZip);

// 5) Userscript + readme
writeFileSync(join(outDir, "flashbolt-sniper-overlay.user.js"), userscript);
writeFileSync(join(outDir, "README.md"), bundle.readme);

console.log(`FlashBolt overlay artifacts written to ${outDir}`);
console.log(`  flashbolt-sniper-overlay.user.js  ${(userscript.length / 1024).toFixed(1)} KB (userscript)`);
console.log(`  chrome-flashbolt-overlay.zip      ${(chromeZip.length / 1024).toFixed(1)} KB (Chrome/Edge/Brave MV3)`);
console.log(`  firefox-flashbolt-overlay.zip     ${(firefoxZip.length / 1024).toFixed(1)} KB (Firefox MV2)`);
console.log(`  extension-chrome/  extension-firefox/  README.md`);
console.log(`\nInstall: see README.md — or grab the artifacts from the /download page.`);
