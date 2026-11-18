#!/usr/bin/env bash
#
# FlashBolt mirror packager.
# Packages the current source into mirror-v<version>.zip (mirror/ layout),
# excluding node_modules, .git, zips, dist and all .env* secrets.
#
# Usage:
#   bun run package:mirror              # uses package.json version
#   VERSION=1.1.0 bun run package:mirror # override
#
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
OUT="mirror-v${VERSION}.zip"
STAGE=".mirror-stage"

echo "== Packaging FlashBolt mirror v${VERSION} =="

rm -rf "$STAGE"
rm -f "$OUT"

mkdir -p "$STAGE/mirror"
mkdir -p "$STAGE/mirror/reports"

cp -R reports/drill-latest.txt "$STAGE/mirror/reports/drill-latest.txt"

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude "node_modules" \
    --exclude ".git" \
    --exclude ".gitignore" \
    --exclude "*.zip" \
    --exclude ".env*" \
    --exclude "dist" \
    --exclude "$STAGE" \
    --exclude "package-lock.json" \
    ./ "$STAGE/mirror/"
else
  cp -R \
    src public scripts reports \
    README.md CHANGELOG.md DRILLS.md DEPLOYMENT.md package.json bun.lock index.html vite.config.ts \
    tsconfig.json tsconfig.app.json tsconfig.node.json eslint.config.js \
    postcss.config.cjs components.json convex.json integrations.md main.ts \
    sst-env.d.ts vly-toolbar-readonly.tsx \
    "$STAGE/mirror/"
fi

(cd "$STAGE" && zip -r -q "../$OUT" mirror)

rm -rf "$STAGE"

echo "Wrote $OUT"
echo "Entries: $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files"
