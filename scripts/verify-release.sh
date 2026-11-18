#!/usr/bin/env bash
# FlashBolt release verify — one command before any deploy or mirror package.
#
# Runs the full gate:
#   1. TypeScript typecheck (tsc -b --noEmit)
#   2. Full test suite (bun test)
#   3. Deploy config parity (wrangler.toml ↔ sites.deploy.json)
#   4. Host header parity (public/_headers ↔ vercel.json, netlify.toml)
#   5. Overlay artifact verification:
#        - artifacts exist in public/overlay/
#        - userscript + both manifests carry the app version (package.json)
#        - the daily-target gate endpoint is stamped into all three bundles
#   6. Live-path drill gate (no bypass flag, by design):
#        - reports/drill-latest.txt holds a fresh (24h) 2/2 combined verdict
#          — produce it with: bun run drill:report
#
# Usage:
#   bun run verify
#   bash scripts/verify-release.sh

set -euo pipefail
cd "$(dirname "$0")/.."

APP_VERSION="$(bun -e 'console.log(require("./package.json").version)')"
echo "==> FlashBolt release verify — v${APP_VERSION}"
echo

# ── 1. Typecheck ────────────────────────────────────────────────────────────
echo "==> [1/6] TypeScript typecheck"
bun tsc -b --noEmit
echo "    OK"

# ── 2. Full test suite ──────────────────────────────────────────────────────
echo "==> [2/6] Test suite"
bun test
echo "    OK"

# ── 3. Deploy config parity ─────────────────────────────────────────────────
echo "==> [3/6] Deploy config (wrangler.toml is the source of truth)"
bun scripts/check-deploy-config.mjs
echo "    OK"

# ── 4. Host header parity ───────────────────────────────────────────────────
echo "==> [4/6] Host headers (public/_headers ↔ vercel.json, netlify.toml)"
bun scripts/check-headers-parity.mjs
echo "    OK"

# ── 4. Overlay artifact verification ────────────────────────────────────────
echo "==> [5/6] Overlay artifacts"

US="public/overlay/flashbolt-sniper-overlay.user.js"
CHROME_MANIFEST="public/overlay/extension-chrome/manifest.json"
FIREFOX_MANIFEST="public/overlay/extension-firefox/manifest.json"
CHROME_ZIP="public/overlay/chrome-flashbolt-overlay.zip"
FIREFOX_ZIP="public/overlay/firefox-flashbolt-overlay.zip"

for f in "$US" "$CHROME_MANIFEST" "$FIREFOX_MANIFEST" "$CHROME_ZIP" "$FIREFOX_ZIP" "public/overlay/README.md"; do
  [ -f "$f" ] || { echo "    FAIL: missing artifact $f — run: bun run overlay"; exit 1; }
done
echo "    artifacts present"

check_version() {
  local file="$1" pattern="$2" label="$3"
  if grep -q "$pattern" "$file"; then
    echo "    $label: v${APP_VERSION} OK"
  else
    echo "    FAIL: $label is not v${APP_VERSION} — version drift, rebuild with: bun run overlay"
    exit 1
  fi
}

check_version "$US" "@version[[:space:]]*${APP_VERSION}" "userscript"
check_version "$CHROME_MANIFEST" "\"version\": \"${APP_VERSION}\"" "Chrome manifest"
check_version "$FIREFOX_MANIFEST" "\"version\": \"${APP_VERSION}\"" "Firefox manifest"
check_version "public/overlay/README.md" "v${APP_VERSION}" "install README"

check_gate() {
  local file="$1" label="$2"
  if grep -q "overlay/execution" "$file"; then
    echo "    $label: gate endpoint stamped"
  else
    echo "    FAIL: $label missing the daily-target gate stamp — set VITE_CONVEX_URL and rebuild with: bun run overlay"
    exit 1
  fi
}

check_gate "$US" "userscript"
check_gate "public/overlay/extension-chrome/overlay.js" "Chrome bundle"
check_gate "public/overlay/extension-firefox/overlay.js" "Firefox bundle"

# ── 5. Live-path drill gate ────────────────────────────────────────
echo "==> [6/6] Live-path drill report (fresh 2/2 required — see DRILLS.md)"
bun scripts/check-drill-gate.ts
echo "    OK"

echo
echo "==> All checks passed (v${APP_VERSION}) — safe to deploy."
