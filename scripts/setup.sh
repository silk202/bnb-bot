#!/usr/bin/env bash
# FlashBolt Setup Script (Linux / macOS)
# Installs dependencies, provisions Convex, and starts the dev server.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { printf "${GREEN}▸${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}▸${RESET} %s\n" "$1"; }
error() { printf "${RED}✖${RESET} %s\n" "$1"; exit 1; }

# ── Pre-flight checks ──────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || error "Node.js is required. Install from https://nodejs.org"
command -v bun  >/dev/null 2>&1 || { warn "bun not found — installing..."; curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }
command -v git  >/dev/null 2>&1 || error "git is required."

echo ""
printf "${BOLD}⚡ FlashBolt Setup${RESET}\n"
echo ""

# ── Install dependencies ───────────────────────────────────────────────
info "Installing dependencies..."
bun install

# ── Provision Convex ───────────────────────────────────────────────────
if [ ! -f ".env.local" ] || ! grep -q "VITE_CONVEX_URL" .env.local 2>/dev/null; then
  info "Provisioning Convex backend..."
  bunx convex dev --once --configure=new 2>/dev/null || warn "Convex provisioning skipped (run 'bunx convex dev' manually)"
else
  info "Convex already configured (.env.local exists)"
fi

# ── Start dev server ───────────────────────────────────────────────────
info "Starting dev server..."
echo ""
printf "${BOLD}  → http://localhost:5173${RESET}\n"
echo ""
bun run dev
