#!/usr/bin/env bash
#
# FlashBolt Git Sync — one command to push the current project state to every
# configured git remote (GitHub origin + the platform remotes used for
# deploys: Render, plus any Vercel/Netlify/Cloudflare git-integration remotes
# you have added). Pairs with the Freebuff dashboard's Settings → GitHub Sync
# panel, which owns the private repository + its automatic bidirectional sync.
#
# What it does (nothing mocked — every step is a real command with a real
# exit status, and the script fails loudly instead of pretending):
#   1. Pre-flight: typecheck + full test suite (the same gate deploys use),
#      then the live-drill gate status is SURFACED (warn-only) before any
#      commit — sync ships source and never blocks on the drill hold, but it
#      never hides it either (releases are held by `bun run verify`).
#   2. Shows git status + the remotes it will push to.
#   3. Commits any staged/unstaged changes with a conventional message
#      (skipped when the tree is clean).
#   4. Pushes HEAD to every remote that has a matching branch — remotes that
#      are not configured are reported and skipped, never faked.
#
# Usage:
#   bun run git:sync                       # full gate + commit + push all
#   SKIP_GATE=1 bun run git:sync           # skip typecheck/tests (fast sync)
#   MESSAGE="feat: x" bun run git:sync     # custom commit message
#
set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'
info() { printf "${GREEN}▸${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}▸${RESET} %s\n" "$1"; }
fail() { printf "${RED}✖${RESET} %s\n" "$1"; exit 1; }

# ── 1. Release gate (typecheck + tests) ────────────────────────────────
if [ "${SKIP_GATE:-0}" != "1" ]; then
  info "Pre-flight gate: typecheck + tests"
  bun run typecheck
  bun test
else
  warn "SKIP_GATE=1 — pre-flight typecheck/tests skipped"
fi

# ── 1b. Live drill gate status — surfaced BEFORE committing, never blocking
#        the sync itself. The gate script prints the exact hold reason (verdict,
#        staleness, addresses to fund); sync continues so source still ships.
if bash scripts/report-drill-status.sh; then
  info "Drill gate: fresh 2/2 combined verdict — releases are unblocked."
else
  warn "Drill gate HOLDS releases right now (see the HOLD lines above for the exact reason and addresses)."
  warn "Your pre-flight gate just passed — the one-time faucet drips in DRILLS.md ('Funding — manual, one-time') are the only step left before a green: bun run verify"
  warn "Sync continues (source sync is not a release); after funding, re-run: bun run drill:report"
fi

# ── 2. Remotes inventory (honest: only what actually exists) ───────────
info "Configured git remotes:"
git remote -v || fail "not a git repository"
REMOTES="$(git remote || true)"
if [ -z "${REMOTES//[$'\t\r\n ']/}" ]; then
  fail "no git remotes configured — create 'origin' via the Freebuff dashboard → Settings → GitHub Sync → Create & Sync (it provisions the private repo AND bidirectional sync), or manually: git remote add origin <url>"
fi

# ── 3. Commit pending work (skipped when clean) ────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  MESSAGE="${MESSAGE:-chore: sync project state (${BRANCH}) — bots, git-sync, deploy surface}"
  info "Committing pending changes: ${MESSAGE}"
  git add -A
  git commit -m "${MESSAGE}"
else
  info "Working tree clean — nothing to commit"
fi

# ── 4. Push HEAD to every remote with a matching branch ────────────────
PUSHED=0
SKIPPED=0
for remote in ${REMOTES}; do
  if git ls-remote --exit-code --heads "${remote}" "${BRANCH}" >/dev/null 2>&1 ||
     [ "${remote}" = "origin" ]; then
    info "Pushing ${BRANCH} → ${remote}"
    git push "${remote}" "${BRANCH}"
    PUSHED=$((PUSHED + 1))
  else
    warn "Remote '${remote}' has no '${BRANCH}' branch — skipped (create it there first if intended)"
    SKIPPED=$((SKIPPED + 1))
  fi
done

echo ""
info "Git sync complete: ${PUSHED} remote(s) pushed, ${SKIPPED} skipped, branch '${BRANCH}'."
info "GitHub ↔ Freebuff bidirectional sync (dashboard → Settings → GitHub Sync) picks this up automatically."
