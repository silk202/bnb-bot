#!/usr/bin/env bash
#
# Network-free self-test for scripts/check-4-tasks.sh.
#
# The guard's ring, its baseline ledger and its --json verdict are pure shell +
# python: no deployment is touched, so their invariants can be proved on any
# machine and any runner. They need to be, because every bug found here was
# silent — nothing in a run log or an exit code showed it:
#
#   * the ledger's "have I seen this stamp?" search also matched the `Replaced
#     by` cell of the row that superseded it, so every second stamp looked
#     present (measured: 6 of 12 rows written, no warning, no error);
#   * skipped checks were recorded with the status `skip` while the counter read
#     `skipped`, so a run with two skips reported `skipped: 0`;
#   * a note printed before its check's verdict (check 6 copies superseded
#     stamps into the ledger before it reports) was filed under the previous
#     check, so the JSON said check 5b had a baseline-ledger detail and check 6
#     had none.
#
# The functions are extracted from the real script rather than copied, so this
# test cannot pass against a stale duplicate of them.
#
# Usage: bun run check:guard    (or: bash scripts/test-task-guard.sh)
# Exit:  0 = every assertion passed, 1 = at least one failed.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

GUARD="scripts/check-4-tasks.sh"
[ -f "$GUARD" ] || { printf 'FAIL cannot find %s\n' "$GUARD"; exit 1; }

TMP="$(mktemp -d)" || { printf 'FAIL cannot create a temp dir\n'; exit 1; }
trap 'rm -rf "$TMP"' EXIT INT TERM

PASSED=0
FAILED=0
ok() { PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf 'FAIL %s\n' "$1"; [ $# -gt 1 ] && printf '       %s\n' "$2"; return 0; }
eq() { # name want got
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want '$2', got '$3'"; fi
}
has() { # name needle haystack
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "missing '$2' in: $(printf '%s' "$3" | head -c 400)" ;; esac
}
hasnt() { # name needle haystack
  case "$3" in *"$2"*) bad "$1" "unexpected '$2' in: $(printf '%s' "$3" | head -c 400)" ;; *) ok "$1" ;; esac
}

# The function exactly as the guard defines it: from its `name() {` line to the
# first closing brace at column 0. Every function body below is indented, so the
# first column-0 `}` is the function's own. The signature line usually carries a
# trailing comment (`ring_files() { # dir -> …`), so the match is on the prefix.
extract() { # fn
  awk -v sig="$1() {" 'substr($0, 1, length(sig)) == sig { on = 1 }
    on { print }
    on && $0 == "}" { exit }' "$GUARD"
}

for fn in ring_files ring_stats trim_ring ledger_row ledger_append ledger_backfill write_baseline emit_json; do
  body="$(extract "$fn")"
  if [ -z "$body" ]; then bad "extract ${fn}()" "the guard no longer defines it at column 0"; continue; fi
  eval "$body" || bad "define ${fn}()" "eval failed"
done

# Stubs for the few collaborators the extracted functions call: the real ones
# record verdicts, these only need to be callable and to yield their text.
info() { printf 'NOTE %s\n' "$1"; }
say() { printf '%s\n' "$*"; }
FIX=0
LAST_CHECK_ID=-

# ── the ring: count limit ──────────────────────────────────────────────────
mkdir -p "$TMP/ring"
for i in 1 2 3 4 5; do printf 'run %s\n' "$i" > "$TMP/ring/20260101T00000${i}Z.txt"; done
trim_err="$(trim_ring "$TMP/ring" 3 0 2>&1 >/dev/null)"
eq "ring keeps the newest run for each slot" \
  "20260101T000003Z.txt 20260101T000004Z.txt 20260101T000005Z.txt" \
  "$(cd "$TMP/ring" && ls | tr '\n' ' ' | sed 's/ $//')"
has "count trim says how many it dropped" "trimmed 2 oldest run(s)" "$trim_err"
has "count trim names the limit it applied" "limit count 3" "$trim_err"

# A .json ring entry (a --json run) is part of the same ring.
mkdir -p "$TMP/mixed"
for i in 1 2 3; do : > "$TMP/mixed/20260101T00000${i}Z.txt"; done
: > "$TMP/mixed/20260101T000004Z.json"
: > "$TMP/mixed/notes.md"
eq "ring counts .txt and .json entries, and nothing else" "4" "$(ring_stats "$TMP/mixed" | cut -d' ' -f1)"

# ── the ring: byte budget ──────────────────────────────────────────────────
mkdir -p "$TMP/size"
printf '%0200d' 0 > "$TMP/size/20260101T000001Z.txt"
printf '%0200d' 0 > "$TMP/size/20260101T000002Z.txt"
trim_err="$(trim_ring "$TMP/size" 20 250 2>&1 >/dev/null)"
eq "size trim drops the oldest until the ring fits" "20260101T000002Z.txt" "$(cd "$TMP/size" && ls)"
has "size trim names the budget it applied" "limit size 250 B" "$trim_err"

# One verdict larger than the whole budget is kept: the ring exists to be read.
mkdir -p "$TMP/oversize"
printf '%0500d' 0 > "$TMP/oversize/20260101T000001Z.txt"
trim_err="$(trim_ring "$TMP/oversize" 20 100 2>&1 >/dev/null)"
eq "the newest run is never trimmed for size" "20260101T000001Z.txt" "$(cd "$TMP/oversize" && ls)"
has "an over-budget single verdict says it was kept" "kept, never trim the only verdict" "$trim_err"

# ── the baseline ledger ────────────────────────────────────────────────────
export PROTECTED_URL="https://protected.invalid"
export PROTECTED_BASELINE="$TMP/.task-baseline"
export PROTECTED_BASELINE_LEDGER="$TMP/reports/baseline-history.md"
export PROTECTED_BASELINE_HISTORY=10
mkstamp() { printf '20260101T0000%02dZ-%012d' "$1" "$1"; }

# A baseline that has already accumulated 12 superseded stamps (the cap is 10,
# so the next advance has to trim) plus the stamp in force.
{
  printf 'url=%s\nstamp=%s\nrecorded=2026-01-01T00:00:00Z\n' "$PROTECTED_URL" "$(mkstamp 99)"
  for i in $(seq 0 11); do
    printf 'history=%s recorded=2026-01-01T00:00:00Z superseded=2026-01-02T00:00:00Z replaced_by=%s (platform rollout)\n' \
      "$(mkstamp "$i")" "$(mkstamp $((i + 1)))"
  done
} > "$PROTECTED_BASELINE"

out="$(ledger_backfill 2>&1)"
eq "backfill copies every stamp the baseline remembers" "12" "$(grep -c '^| `' "$PROTECTED_BASELINE_LEDGER")"
has "backfill reports how many it copied" "copied 12 superseded stamp(s)" "$out"
dupes="$(for i in $(seq 0 11); do
  n="$(grep -c "^| \`$(mkstamp "$i")\` |" "$PROTECTED_BASELINE_LEDGER")"
  [ "$n" = 1 ] || printf '%s=%s ' "$(mkstamp "$i")" "$n"
done)"
eq "every stamp appears exactly once as the first cell" "" "$dupes"

before="$(cksum < "$PROTECTED_BASELINE_LEDGER")"
out="$(ledger_backfill 2>&1)"
eq "a second backfill changes nothing" "$before" "$(cksum < "$PROTECTED_BASELINE_LEDGER")"
eq "a second backfill is silent" "" "$out"

# The advance that used to lose stamps: 12 lines + 1 superseded, 10-line cap.
advice="$(write_baseline "$(mkstamp 50)" "$(mkstamp 99)" "2026-01-01T00:00:00Z" "platform rollout" 2>&1)"
eq "the baseline is capped at 10 history lines" "10" "$(grep -c '^history=' "$PROTECTED_BASELINE")"
has "the advance names the count it dropped from the baseline" "3 oldest superseded stamp(s) dropped" "$advice"
has "the advance names each dropped stamp" "$(mkstamp 0)" "$advice"
eq "the superseded stamp becomes the newest history line" "1" \
  "$(grep -c "^history=$(mkstamp 99) " "$PROTECTED_BASELINE")"
eq "the superseded stamp is in the ledger" "1" \
  "$(grep -c "^| \`$(mkstamp 99)\` |" "$PROTECTED_BASELINE_LEDGER")"
eq "no stamp is lost: 12 old + 1 superseded are in the ledger" "13" "$(grep -c '^| `' "$PROTECTED_BASELINE_LEDGER")"

rows_before="$(grep -c '^| `' "$PROTECTED_BASELINE_LEDGER")"
write_baseline "$(mkstamp 51)" "$(mkstamp 50)" "2026-01-01T00:00:00Z" "platform rollout" >/dev/null 2>&1
eq "a second advance adds exactly one ledger row" "$((rows_before + 1))" "$(grep -c '^| `' "$PROTECTED_BASELINE_LEDGER")"

rm -f "$PROTECTED_BASELINE_LEDGER"
out="$(ledger_backfill 2>&1)"
eq "a deleted ledger is rebuilt from the baseline" "10" "$(grep -c '^| `' "$PROTECTED_BASELINE_LEDGER")"
has "the rebuild says how many it copied" "copied 10 superseded stamp(s)" "$out"

# ── the JSON verdict ───────────────────────────────────────────────────────
# The records file is the guard's own format (status<TAB>id<TAB>message), so this
# exercises emit_json exactly as a run fills it — including the ordering that used
# to misfile check 6's ledger note.
CHECKS_FILE="$TMP/checks.tsv"
{
  printf 'pass\t1\t1. .env.local VITE_CONVEX_URL = https://dev.example\n'
  printf 'note\t1\trepair tolerated both spellings\n'
  printf 'skipped\t1\t1. build-target check skipped (SKIP_BUILD_TARGET=1)\n'
  printf 'blocked\t4c\t4c. dev function serving disabled by the provider: plan limits\n'
  printf 'note\t6\tbaseline ledger: copied 10 superseded stamp(s) to reports/baseline-history.md\n'
  printf 'pass\t6\t6. protected deployment healthy; reference unchanged\n'
  printf 'fail\t7a\t7a. operatorConfig is not exactly one row per deployment (dev 0, prod 1)\n'
  printf 'note\t9\ta note whose check never reported\n'
} > "$CHECKS_FILE"

RUN_TS="2026-01-01T00:00:00Z"
COMMIT_LABEL="deadbee (main)"
GITHUB_REF_NAME="main"
TASK_REPORT="$TMP/report.json"
TASK_GUARD_RUN_LOG="$TMP/ring/20260101T000000Z.json"
TASK_GUARD_HISTORY_DIR="$TMP/ring"
TASK_GUARD_KEEP=20
TASK_GUARD_MAX_BYTES=262144
JSON="$(emit_json blocked 2)"

py() { printf '%s' "$JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
eq "json is one document with the schema tag" "flashbolt.task-guard/1" "$(py 'd["schema"]')"
eq "json counts pass" "2" "$(py 'd["counts"]["pass"]')"
eq "json counts skipped under the status it records" "1" "$(py 'd["counts"]["skipped"]')"
eq "json counts blocked" "1" "$(py 'd["counts"]["blocked"]')"
eq "json counts fail" "1" "$(py 'd["counts"]["fail"]')"
eq "json verdict and exit code are the caller's" "blocked 2" "$(py 'd["result"] + " " + str(d["exit_code"])')"
eq "json mode is verify" "verify" "$(py 'd["mode"]')"
eq "json commit labels the run" "deadbee (main)" "$(py 'd["commit"]')"
eq "json records the report path" "$TMP/report.json" "$(py 'd["report"]')"
eq "json records the ring budget" "262144" "$(py 'str(d["ring"]["max_bytes"])')"
eq "the id is kept per verdict" "1,1,4c,6,7a" "$(py '",".join(c["id"] for c in d["checks"])')"
eq "a note after its verdict stays with it" "['repair tolerated both spellings']" "$(py 'd["checks"][0]["details"]')"
eq "a note before its check's verdict waits for that check" \
  "['baseline ledger: copied 10 superseded stamp(s) to reports/baseline-history.md']" \
  "$(py '[c for c in d["checks"] if c["id"] == "6"][0]["details"]')"
eq "and is not filed under the previous check" "[]" \
  "$(py '[c for c in d["checks"] if c["id"] == "4c"][0]["details"]')"
eq "a skipped verdict carries no details" "[]" \
  "$(py '[c for c in d["checks"] if c["status"] == "skipped"][0]["details"]')"
eq "a note for a check that never reported is surfaced, not dropped" \
  "['9: a note whose check never reported']" "$(py 'd["notes"]')"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf 'task guard self-test: all %s assertions passed\n' "$PASSED"
  exit 0
fi
printf 'task guard self-test: %s passed, %s FAILED\n' "$PASSED" "$FAILED"
exit 1
