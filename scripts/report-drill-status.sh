#!/usr/bin/env bash
#
# FlashBolt — live-drill gate status for pre-flight surfaces (used by
# `bun run git:sync`). Prints one of three honest states:
#
#   OK:   reports/drill-latest.txt is fresh AND shows a 2/2 combined verdict
#         → releases are unblocked.
#   HOLD: the report is below 2/2 or stale → releases are held; the exact
#         reason and the drill addresses to fund are printed.
#   HOLD: no report exists yet → releases are held until `bun run drill:report`
#         pins one.
#
# Exit status: 0 only on OK. Callers decide what to do with a HOLD —
# git-sync surfaces it as a warning and continues (source sync is not a
# release); `bun run verify` treats it as a hard stop.
#
# The gate script itself still reads the REAL reports/drill-latest.txt for
# releases — the optional path argument here exists purely so this status
# reporter can be exercised in tests without touching the pinned artifact.

set -uo pipefail
cd "$(dirname "$0")/.."

REPORT="reports/drill-latest.txt"
if [ ! -f "$REPORT" ]; then
  echo "HOLD: no drill report yet (reports/drill-latest.txt) — releases stay held."
  echo "  → run: bun run drill:report   (see DRILLS.md)"
  exit 1
fi

OUT="$(bun scripts/check-drill-gate.ts "$REPORT" 2>&1)"
STATUS=$?
echo "$OUT"
if [ "$STATUS" -eq 0 ]; then
  echo "OK: drill gate satisfied — releases unblocked."
  exit 0
fi
echo "HOLD: live-drill report is below 2/2 or stale — releases are held."
echo "  → fund the drill addresses above per DRILLS.md, then re-run: bun run drill:report"
exit 1
