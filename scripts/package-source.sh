#!/usr/bin/env bash
# FlashBolt Source Code Packaging Script
#
# Builds ONE folder-wrapped source archive of the working tree — not a git
# snapshot — so the bytes an operator/guest downloads always match the code
# that is actually running (uncommitted fixes included). The archive is
# written to public/downloads/, which Vite copies into dist/ verbatim, so the
# account menu's "Download source" link can serve it directly with no GitHub,
# release page or third-party host in the path.
#
# Contents: every root config (package.json, bun.lock, tsconfig*, vite/tailwind/
# postcss/eslint config, host descriptors, docs) plus the entire src/ and
# src/convex/ trees. Excluded: dependencies, build output, VCS metadata and all
# environment files except the committed .env.example template.
#
# Regenerate after source changes with:  bun run source:package
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RESET='\033[0m'

info() { printf "${GREEN}▸${RESET} %s\n" "$1"; }

cd "$(dirname "$0")/.."

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\(.*\)".*/\1/')
ARCHIVE_NAME="flashbolt-v${VERSION}"
OUT_DIR="public/downloads"
ZIP_NAME="flashbolt-source.zip"
TAR_NAME="flashbolt-source.tar.gz"

echo ""
printf "${BOLD}📦 Packaging FlashBolt v${VERSION} source code${RESET}\n"
echo ""

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/$ARCHIVE_NAME"
mkdir -p "$ROOT" "$OUT_DIR"

# ── Stage the working tree under a single top-level folder ─────────────
# The archive is downloadable, so the exclude list is a security boundary, not
# just tidiness: no local state, deploy caches, database export dumps or env
# files may ever be packaged.
info "Staging working tree as ${ARCHIVE_NAME}/ ..."
tar -cf - \
    --exclude=./node_modules \
    --exclude=./.git \
    --exclude=./dist \
    --exclude=./dist-ssr \
    --exclude=./isolate \
    --exclude=./build \
    --exclude=./output \
    --exclude=./coverage \
    --exclude=./out \
    --exclude=./release \
    --exclude=./desktop-dist \
    --exclude=./extension-build \
    --exclude=./exports \
    --exclude=./export \
    --exclude='./flashbolt-export*' \
    --exclude=./reports \
    --exclude=./.bun \
    --exclude=./.npm \
    --exclude=./.yarn \
    --exclude=./.cache \
    --exclude=./.turbo \
    --exclude=./.vite \
    --exclude=./.parcel-cache \
    --exclude=./.vly \
    --exclude=./.vercel \
    --exclude=./.netlify \
    --exclude=./.render \
    --exclude=./.wrangler \
    --exclude=./.sst \
    --exclude=./.mirror-check \
    --exclude=./cloudflare-worker/dist \
    --exclude=./"$OUT_DIR" \
    --exclude='./*.zip' \
    --exclude='./*.tar.gz' \
    --exclude='./*.tar.bz2' \
    --exclude='./*.7z' \
    --exclude='./*.jsonl' \
    --exclude='./*.log' \
    --exclude='./*.tsbuildinfo' \
    --exclude='./freebuff.local.json' \
    --exclude='./.dev.vars' \
    --exclude='./.env' \
    --exclude='./.env.*' \
    --exclude='./.DS_Store' \
    --exclude='./Thumbs.db' \
    . | ( cd "$ROOT" && tar -xf - )

# The committed template is documentation, not a secret — carry it along so a
# self-hoster can see exactly which keys to provide.
if [ -f ".env.example" ]; then cp ".env.example" "$ROOT/"; fi

# ── Create the archives (root entry is the folder itself) ──────────────
info "Creating ZIP archive..."
rm -f "${OUT_DIR}/${ZIP_NAME}"
( cd "$STAGE" && zip -qr -X "${OLDPWD}/${OUT_DIR}/${ZIP_NAME}" "${ARCHIVE_NAME}" )

info "Creating TAR.GZ archive..."
rm -f "${OUT_DIR}/${TAR_NAME}"
tar czf "${OUT_DIR}/${TAR_NAME}" -C "$STAGE" "${ARCHIVE_NAME}"

# ── Summary ────────────────────────────────────────────────────────────
echo ""
info "Archives written to ${OUT_DIR}/:"
ls -lh "${OUT_DIR}/${ZIP_NAME}" "${OUT_DIR}/${TAR_NAME}"
echo ""
info "Served at /downloads/${ZIP_NAME} and /downloads/${TAR_NAME} by the account menu (operator/guest only)."
echo ""
