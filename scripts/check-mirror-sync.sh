#!/usr/bin/env bash
#
# FlashBolt release guard.
# Verifies the packaged mirror is byte-for-byte in sync with the live source
# and free of forbidden contents (node_modules, .git, dist). Exits non-zero
# when anything drifts, so release scripts fail loudly instead of shipping a
# stale or leaking mirror.
#
# Usage:
#   bun run check:mirror                # checks mirror-v<version>.zip (package.json version)
#   VERSION=1.2.0 bun run check:mirror  # explicit version
#
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
ZIP="mirror-v${VERSION}.zip"
CHECK=".mirror-check"

if [ ! -f "$ZIP" ]; then
  echo "FAIL: $ZIP not found — run 'bun run package:mirror' first."
  exit 1
fi

rm -rf "$CHECK"
mkdir -p "$CHECK"
unzip -q "$ZIP" -d "$CHECK"

fail=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    fail=1
  fi
}

check "src/ is byte-identical to the live app" diff -r src "$CHECK/mirror/src"
check "package.json is in sync" diff -q package.json "$CHECK/mirror/package.json"
check "CHANGELOG.md is in sync" diff -q CHANGELOG.md "$CHECK/mirror/CHANGELOG.md"
check "README.md is in sync" diff -q README.md "$CHECK/mirror/README.md"
check "DRILLS.md is in sync" diff -q DRILLS.md "$CHECK/mirror/DRILLS.md"
check "DEPLOYMENT.md is in sync" diff -q DEPLOYMENT.md "$CHECK/mirror/DEPLOYMENT.md"
check "scripts/ are in sync" diff -r scripts "$CHECK/mirror/scripts"
check "drill release report is in sync" diff -q reports/drill-latest.txt "$CHECK/mirror/reports/drill-latest.txt"

forbidden=$(unzip -l "$ZIP" | grep -icE 'node_modules|/git/|dist/' || true)
if [ "$forbidden" -eq 0 ]; then
  echo "PASS: no forbidden contents (node_modules/.git/dist)"
else
  echo "FAIL: $forbidden forbidden entries found in $ZIP"
  fail=1
fi

rm -rf "$CHECK"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Mirror is OUT OF SYNC with the live source — fix the drift before releasing."
  exit 1
fi

echo ""
echo "OK: mirror-v${VERSION}.zip is in sync with the live source."
