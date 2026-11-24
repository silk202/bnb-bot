#!/usr/bin/env bash
#
# FlashBolt task guard.
#
# Verifies the four Convex migration tasks that keep regressing when project
# secrets are re-synced, plus the three deployment surfaces that have to stay
# intact around them:
#
#   1. .env.local build target carries a clean, unquoted VITE_CONVEX_URL
#      (cosmetic drift — quotes/space from a secret sync — is normalized on
#      every run, because the URL itself is unchanged and the app sanitizes it)
#   2. dev + prod deploy keys are accepted
#   3. overlay artifacts are stamped with the production site origin
#   4. both deployments carry the four required environment variables
#      (+ JWT_PRIVATE_KEY is the 1703-byte armored key that decrypts the
#      stored operator credentials — the unarmored variant breaks AES)
#      (4d signs in for real: the stored credentials are decrypted with this
#       deployment's own key and used against gate:operatorLogin, so a broken
#       key hierarchy fails here instead of being assumed healthy)
#   5. the published Sites preview still serves the app (HTML, a real asset and
#      an SPA deep route — not just a 200)
#   6. the protected deployment is healthy AND on the same backend build as the
#      fleet (Convex's /version is a platform build stamp shared by every
#      deployment, so a change means a platform rollout, not a deploy — the
#      check explains this and keeps the superseded reference in history)
#   7. dev and prod data agree: operatorConfig count matches, every user has
#      exactly one authAccount on each side, and dev is never behind prod
#
# Usage:
#   bun run check:tasks          # verify only
#   bun run check:tasks --fix    # repair .env.local, re-apply JWKS/JWT + reseed,
#                                # re-record the protected-deployment baseline
#
# Optional inputs (from .env.local or the environment):
#   OPERATOR_EMAIL / OPERATOR_PASSPHRASE   sign in with these instead of the
#                                          decrypted stored credentials
#   SKIP_LOGIN=1                           skip the live sign-in (4d) — each run
#                                          spends one of the 5/minute slots
#   SKIP_BUILD_TARGET=1                    skip check 1 — it inspects the local
#                                          .env.local, which CI never has (CI
#                                          passes the deploy keys as secrets)
#   PREVIEW_URL=""  or SKIP_PREVIEW=1      skip check 5
#   PROTECTED_URL                          deployment that must stay untouched
#   PROTECTED_BASELINE                     baseline file (default .task-baseline)
#   TASK_REPORT                            run log (default reports/task-guard-latest.txt)
#
# Exit code: 0 = all checks pass, 1 = at least one failure, 2 = no check failed
#            but the provider blocked at least one (nothing was proved false).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# Every run leaves a timestamped verdict file — "it passed last week" needs a
# when. The guard re-executes itself once so tee sees the whole output while the
# parent still returns the child's exact exit status (pipefail alone would not
# preserve a `blocked` exit code of 2 distinctly enough for the caller's eyes).
if [ "${TASK_GUARD_TEE:-0}" != "1" ]; then
  TASK_REPORT="${TASK_REPORT-reports/task-guard-latest.txt}"
  mkdir -p "$(dirname "$TASK_REPORT")" 2>/dev/null
  TASK_GUARD_TEE=1 TASK_REPORT="$TASK_REPORT" bash "$0" "$@" 2>&1 | tee "$TASK_REPORT"
  exit "${PIPESTATUS[0]}"
fi

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

# The Convex CLI retries (and effectively hangs) against a deployment the
# provider has disabled, so every CLI call gets a hard ceiling. Measured
# 2026-11-24: `convex data` against the plan-capped prod deployment blocked past
# 4 minutes with no output, which would eat a CI job's whole timeout.
CLI_TIMEOUT="${CLI_TIMEOUT:-20}"
# A full export downloads a zip and is slower than a table read; a timeout there
# is not a rejected key either (a bad key fails immediately with a message).
EXPORT_TIMEOUT="${EXPORT_TIMEOUT:-120}"

CONVEX_BIN="./node_modules/.bin/convex"
[ -x "$CONVEX_BIN" ] || { echo "FAIL  dependencies missing — run: bun install"; exit 1; }
# The guard deliberately owns no URL rule of its own: it calls the app's module
# (src/lib/convex-url.ts) and the login probe (scripts/operator-login.mjs).
command -v bun >/dev/null 2>&1 || { echo "FAIL  bun is required to run the shared URL rule and login probe"; exit 1; }

# shellcheck disable=SC1091
set -a; . ./.env.local 2>/dev/null; set +a

DEV_KEY="$(printf %s "${CONVEX_DEPLOY_KEY_1:-}" | tr -d '[:space:]')"
PROD_KEY="$(printf %s "${CONVEX_DEPLOY_KEY_2:-}" | tr -d '[:space:]')"
ZANY_KEY_CLEAN="$(printf %s "${ZANY_KEY:-}" | tr -d '[:space:]')"
DEV_SITE="${DEV_SITE:-pastel-pelican-634}"
PROD_SITE="${PROD_SITE:-flexible-frog-776}"
EXPECTED_URL="${VITE_CONVEX_URL_EXPECTED:-https://${DEV_SITE}.convex.cloud}"
OVERLAY_EXPECTED="${OVERLAY_EXPECTED:-https://${PROD_SITE}.convex.site}"
REQUIRED_ENVS="VLY_CONVEX_AUTH_ISSUER JWKS JWT_PRIVATE_KEY SITE_URL"
PROTECTED_BASELINE="${PROTECTED_BASELINE:-.task-baseline}"

FAIL=0
BLOCKED=0
PROVIDER_BLOCKED=0
pass() { printf 'PASS    %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1"; FAIL=$((FAIL + 1)); }
info() { printf '        %s\n' "$1"; }
# A provider-side outage or plan ceiling is not a code verdict. Counting it
# separately keeps a billing window from reading as a broken migration, while
# still never printing green for something that was not proved.
blocked() { printf 'BLOCKED %s\n' "$1"; BLOCKED=$((BLOCKED + 1)); PROVIDER_BLOCKED=1; }

site_of() { [ "$1" = "dev" ] && echo "$DEV_SITE" || echo "$PROD_SITE"; }
key_of()  { [ "$1" = "dev" ] && echo "$DEV_KEY" || echo "$PROD_KEY"; }

# Single source for the URL rule. The guard used to carry its own sed copy,
# which is exactly how two normalizers drift apart — it now asks the same
# TypeScript module the client uses, so bash holds no rule at all.
sanitize_url() {
  URL_RAW="$1" bun -e 'import { resolveConvexUrl } from "./src/lib/convex-url.ts"; process.stdout.write(resolveConvexUrl(process.env.URL_RAW) ?? "");' 2>/dev/null
}

# The deployment's own error text, out of Convex's JSON envelope. `\n` arrives
# escaped; the request id is kept because it is the one handle support can use.
error_detail() {
  printf '%s' "$1" | sed -n 's/.*"errorMessage":"\([^"]*\)".*/\1/p' \
    | sed 's/\\n/ /g; s/[[:space:]]\{1,\}/ /g; s/^ //; s/ $//'
}
is_plan_cap() { printf '%s' "$1" | grep -qi 'free plan limits\|deployments have been disabled'; }
# "Server Error" with nothing after it is infrastructure, not a function verdict:
# a thrown error carries its message in the same field.
is_bare_provider_error() {
  printf '%s' "$1" | grep -Eq '^(http [0-9]{3}: )?\[Request ID: [^]]*\] Server Error$'
}

echo "task guard — 4 migration + 3 deployment checks — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "run log: ${TASK_REPORT:-stdout only}"
echo

# ── 1. build target ────────────────────────────────────────────────────────
# Check 1 is a developer-machine invariant: it inspects the untracked
# .env.local, which a runner never has. CI sets SKIP_BUILD_TARGET=1 so the other
# six checks run there and this one says so instead of failing on a file that is
# intentionally absent.
if [ "${SKIP_BUILD_TARGET:-0}" = "1" ]; then
  info "1. build-target check skipped (SKIP_BUILD_TARGET=1 — .env.local is a developer-machine file)"
else
# Cosmetic drift (a secret sync writing `' url'`) is repaired in place even
# without --fix: the sanitized value is provably the intended deployment, and
# leaving the file broken only guarantees the next failure. A genuinely
# different URL still fails.
current_url="$(grep -m1 '^VITE_CONVEX_URL=' .env.local 2>/dev/null | cut -d= -f2-)"
clean_url="$(sanitize_url "$current_url")"
if [ "$clean_url" = "$EXPECTED_URL" ]; then
  if [ "$current_url" = "$EXPECTED_URL" ]; then
    pass "1. .env.local VITE_CONVEX_URL = $EXPECTED_URL"
  else
    python3 - "$EXPECTED_URL" <<'PY'
import re, sys
want = sys.argv[1]
p = ".env.local"
s = open(p, encoding="utf-8").read()
s = re.sub(r"(?m)^VITE_CONVEX_URL=.*$", f"VITE_CONVEX_URL={want}", s, count=1)
if "VITE_CONVEX_URL=" not in s:
    s = s.rstrip("\n") + f"\nVITE_CONVEX_URL={want}\n"
open(p, "w", encoding="utf-8").write(s)
PY
    pass "1. .env.local VITE_CONVEX_URL normalized -> $EXPECTED_URL (secret sync re-quoted it; app tolerates both)"
  fi
elif [ "$FIX" = "1" ]; then
  python3 - "$EXPECTED_URL" <<'PY'
import re, sys
want = sys.argv[1]
p = ".env.local"
s = open(p, encoding="utf-8").read()
s = re.sub(r"(?m)^VITE_CONVEX_URL=.*$", f"VITE_CONVEX_URL={want}", s, count=1)
if "VITE_CONVEX_URL=" not in s:
    s = s.rstrip("\n") + f"\nVITE_CONVEX_URL={want}\n"
open(p, "w", encoding="utf-8").write(s)
PY
  pass "1. .env.local VITE_CONVEX_URL repaired -> $EXPECTED_URL (was '${clean_url:-unset}')"
else
  fail "1. .env.local VITE_CONVEX_URL is '${clean_url:-unset}' (expected '$EXPECTED_URL')"
fi
fi

# ── 2. deploy keys ─────────────────────────────────────────────────────────
for env_name in dev prod; do
  key="$(key_of "$env_name")"
  if [ -z "$key" ]; then
    fail "2. ${env_name} deploy key missing from .env.local"
    continue
  fi
  CONVEX_DEPLOY_KEY="$key" timeout "$EXPORT_TIMEOUT" "$CONVEX_BIN" export --path "/tmp/fbt-${env_name}.zip" >/dev/null 2>&1
  rc=$?
  rm -f "/tmp/fbt-${env_name}.zip"
  if [ $rc -eq 0 ]; then
    pass "2. ${env_name} deploy key accepted (export exit 0)"
  elif [ $rc -eq 124 ]; then
    # Not a rejection: a wrong key is refused in seconds with a message. The
    # export is simply slow (or the deployment is disabled by the provider).
    blocked "2. ${env_name} deploy key check inconclusive — export timed out after ${EXPORT_TIMEOUT}s (not a rejection)"
  else
    fail "2. ${env_name} deploy key rejected (export exit ${rc})"
  fi
done

# ── 3. overlay stamp ───────────────────────────────────────────────────────
stamps="$(grep -rhoE 'https://[a-z0-9-]+\.convex\.site' public/overlay --exclude='*.zip' 2>/dev/null | sort -u)"
zip_stamps="$(for z in public/overlay/*.zip; do unzip -p "$z" 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.convex\.site'; done | sort -u)"
if [ "$stamps" = "$OVERLAY_EXPECTED" ] && [ "$zip_stamps" = "$OVERLAY_EXPECTED" ]; then
  pass "3. overlay files + zips stamped $OVERLAY_EXPECTED"
else
  fail "3. overlay stamp drift — files: '${stamps:-none}' zips: '${zip_stamps:-none}' (expected $OVERLAY_EXPECTED)"
  info "regenerate with: VITE_CONVEX_URL=$(echo "$OVERLAY_EXPECTED" | sed 's/\.convex\.site$/.convex.cloud/') bun run overlay:out"
fi

# ── 4. env vars + JWT integrity + login coverage ───────────────────────────
for env_name in dev prod; do
  key="$(key_of "$env_name")"
  site="$(site_of "$env_name")"
  [ -z "$key" ] && { fail "4. ${env_name} env check skipped (no deploy key)"; continue; }

  envs="$(CONVEX_DEPLOY_KEY="$key" "$CONVEX_BIN" env list 2>/dev/null | grep -oE '^[A-Z0-9_]+' | sort | tr '\n' ' ')"
  missing=""
  for want in $REQUIRED_ENVS; do
    case " $envs " in *" $want "*) ;; *) missing="$missing $want" ;; esac
  done
  [ -z "$missing" ] && pass "4a. ${env_name} env vars present [${envs% }]" || fail "4a. ${env_name} env vars missing:${missing}"

  jwt="$(CONVEX_DEPLOY_KEY="$key" "$CONVEX_BIN" env get JWT_PRIVATE_KEY 2>/dev/null | tr -d '\n')"
  jwt_len=${#jwt}
  armored=no
  case "$jwt" in *BEGIN*) armored=yes ;; esac

  if [ "$armored" = "yes" ] && [ "$jwt_len" -eq 1703 ]; then
    pass "4b. ${env_name} JWT_PRIVATE_KEY armored, 1703 bytes (decryption intact)"
  elif [ "$FIX" = "1" ] && [ -n "$ZANY_KEY_CLEAN" ]; then
    CONVEX_DEPLOY_KEY="$ZANY_KEY_CLEAN" "$CONVEX_BIN" env get JWT_PRIVATE_KEY 2>/dev/null > /tmp/fbt-jwt.raw
    CONVEX_DEPLOY_KEY="$ZANY_KEY_CLEAN" "$CONVEX_BIN" env get JWKS 2>/dev/null > /tmp/fbt-jwks.json
    CONVEX_DEPLOY_KEY="$key" "$CONVEX_BIN" env set JWKS --from-file /tmp/fbt-jwks.json >/dev/null 2>&1
    CONVEX_DEPLOY_KEY="$key" "$CONVEX_BIN" env set JWT_PRIVATE_KEY --from-file /tmp/fbt-jwt.raw >/dev/null 2>&1
    curl -sS -m 20 -o /dev/null -X POST "https://${site}.convex.cloud/api/mutation" \
      -H 'Content-Type: application/json' -d '{"path":"gate:seedOperator","args":{}}'
    rm -f /tmp/fbt-jwt.raw /tmp/fbt-jwks.json
    pass "4b. ${env_name} JWT_PRIVATE_KEY re-applied + operator reseeded"
  else
    fail "4b. ${env_name} JWT_PRIVATE_KEY is unarmored/len ${jwt_len} — decrypt will fail (run --fix)"
  fi

  status_body="$(curl -sS -m 20 -X POST "https://${site}.convex.cloud/api/query" -H 'Content-Type: application/json' \
    -d '{"path":"gate:operatorStatus","args":{}}' 2>/dev/null)"
  seeded="$(printf '%s' "$status_body" | grep -o 'seeded":[a-z]*' | cut -d: -f2)"
  detail="$(error_detail "$status_body")"
  if [ "$seeded" = "true" ]; then
    pass "4c. ${env_name} gate:operatorStatus seeded:true"
  elif is_plan_cap "$status_body"; then
    blocked "4c. ${env_name} function serving disabled by the provider: ${detail:-no error text}"
    info "not a code defect — an upgrade or the next usage window lifts it; re-run then"
  elif is_bare_provider_error "$detail"; then
    blocked "4c. ${env_name} provider returned an infrastructure error: ${detail}"
  elif [ -n "$detail" ]; then
    fail "4c. ${env_name} gate:operatorStatus failed: ${detail}"
  else
    fail "4c. ${env_name} gate:operatorStatus = '${seeded:-unreachable}'"
  fi

  # 4d. Real operator sign-in.
  # scripts/operator-login.mjs decrypts the stored credentials with THIS
  # deployment's armored JWT (the same key its own functions use) and signs in.
  # That exercises the whole chain: ciphertext, key hierarchy, decrypt, action
  # registration and the credential comparison. One attempt spends one of the
  # deployment's 5/minute login slots (per deployment, so dev and prod do not
  # compete); SKIP_LOGIN=1 opts out.
  if [ "${SKIP_LOGIN:-0}" = "1" ]; then
    info "4d. ${env_name} operator sign-in skipped (SKIP_LOGIN=1)"
  else
    login_out="$(CONVEX_DEPLOY_KEY="$key" OPERATOR_SITE="$site" bun scripts/operator-login.mjs 2>&1)"
    case "$login_out" in
      OK*) pass "4d. ${env_name} operator sign-in verified (${login_out#OK })" ;;
      UNAVAILABLE*)
        if is_plan_cap "$login_out"; then
          blocked "4d. ${env_name} sign-in not attemptable — the provider disabled function serving"
        else
          fail "4d. ${env_name} operator sign-in not attemptable: ${login_out#UNAVAILABLE }"
        fi ;;
      THROTTLED*) pass "4d. ${env_name} sign-in not re-proved this run (throttled, not a failure)"
        info "${login_out#THROTTLED } — use SKIP_LOGIN=1 to stop spending slots" ;;
      FAIL*)
        # The probe prints the deployment's own sentence (plan ceiling, 5xx or a
        # credential verdict) — report that instead of a generic "sign-in
        # failed" that hides a billing window behind a code-shaped word.
        reason="$(error_detail "$login_out")"
        [ -n "$reason" ] || reason="$(printf '%s' "${login_out#FAIL }" | sed 's/^[[:space:]]*//')"
        if is_plan_cap "$reason" || is_bare_provider_error "$reason"; then
          blocked "4d. ${env_name} sign-in not attemptable — provider error: ${reason:-see run log}"
        else
          fail "4d. ${env_name} operator sign-in failed: ${login_out#FAIL }"
        fi ;;
      *) fail "4d. ${env_name} sign-in probe error: $(printf %s "$login_out" | head -c 120)" ;;
    esac
  fi
done

# ── 5. Sites preview still serving ─────────────────────────────────────────
# A 200 alone proves nothing: an error page, a JSON stub or a broken asset
# bundle all answer 200. This asserts the HTML, an app anchor, a real static
# asset and an SPA deep route.
if ! command -v curl >/dev/null 2>&1; then
  fail "5. curl unavailable — cannot probe the preview"
elif [ "${SKIP_PREVIEW:-0}" = "1" ] || { [ "${PREVIEW_URL+set}" = "set" ] && [ -z "$PREVIEW_URL" ]; }; then
  info "5. preview check skipped (SKIP_PREVIEW=1 or PREVIEW_URL empty)"
else
  PREVIEW_URL="${PREVIEW_URL-https://site-09ea3529142e4b119d3b827e34b84856.freebuff.page}"
  PREVIEW_URL="${PREVIEW_URL%/}"
  fetch() { # url -> "code content_type" on stdout, body in /tmp/fbt-preview.body
    curl -sS -m 25 -o /tmp/fbt-preview.body -w '%{http_code} %{content_type}' "$1" 2>/dev/null || echo "000 -"
  }
  root="$(fetch "${PREVIEW_URL}/")"
  root_code="${root%% *}"; root_type="${root#* }"
  anchor=no
  grep -q 'id="root"' /tmp/fbt-preview.body 2>/dev/null && anchor=yes
  gate_code="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' "${PREVIEW_URL}/gate" 2>/dev/null || echo 000)"
  asset="$(fetch "${PREVIEW_URL}/logo.svg")"
  asset_code="${asset%% *}"; asset_type="${asset#* }"
  rm -f /tmp/fbt-preview.body

  problems=""
  [ "$root_code" = "200" ] || problems="$problems; / ${root_code:-no-response}"
  case "$root_type" in text/html*) ;; *) problems="$problems; / content-type '${root_type}'" ;; esac
  [ "$anchor" = "yes" ] || problems="$problems; / has no id=\"root\" mount"
  [ "$gate_code" = "200" ] || problems="$problems; /gate ${gate_code:-no-response}"
  [ "$asset_code" = "200" ] || problems="$problems; /logo.svg ${asset_code:-no-response}"
  case "$asset_type" in image/svg*) ;; *) problems="$problems; /logo.svg content-type '${asset_type}'" ;; esac

  if [ -z "$problems" ]; then
    pass "5. Sites preview serving app — / 200 text/html + mount, /gate 200, /logo.svg 200"
  else
    fail "5. Sites preview broken:${problems}"
    info "an unpublished environment answers 404: deploy with sites_deploy, then sites_set_published"
  fi
fi

# 5b. the backend the preview talks to must actually serve. A green front end
# and a disabled deployment look identical from the outside — this is that gap.
# Deliberately probed again rather than reused from 4c: check 5 must stand on its
# own when the login half is skipped.
dev_body="$(curl -sS -m 20 -X POST "https://${DEV_SITE}.convex.cloud/api/query" -H 'Content-Type: application/json' \
  -d '{"path":"gate:operatorStatus","args":{}}' 2>/dev/null)"
dev_seeded="$(printf '%s' "$dev_body" | grep -o 'seeded":[a-z]*' | cut -d: -f2)"
dev_detail="$(error_detail "$dev_body")"
if [ "$dev_seeded" = "true" ]; then
  pass "5b. dev backend serving (gate:operatorStatus seeded:true)"
elif is_plan_cap "$dev_body"; then
  blocked "5b. dev backend serving disabled by the provider: ${dev_detail:-no error text}"
  info "the preview can answer 200 while every call it makes fails — this is that state"
elif is_bare_provider_error "$dev_detail"; then
  blocked "5b. dev backend returned an infrastructure error: ${dev_detail}"
else
  fail "5b. dev backend gate:operatorStatus = '${dev_seeded:-unreachable}'${dev_detail:+ — $dev_detail}"
fi

# ── 6. protected deployment: healthy and on the fleet's backend build ──────
# /version is NOT a per-deployment build fingerprint. Measured 2026-11-24: dev,
# prod and the protected deployment all answered 20261123T234400Z-ab2c2501a060,
# while dev/prod took real CI deploys and the value never moved. It is Convex's
# platform build stamp. So "the stamp changed" means the backend fleet rolled,
# not that someone deployed this deployment — the old baseline comparison
# claimed a fact the probe cannot support, and the 2026-11-23 drift it flagged
# was exactly such a rollout.
#
# What the endpoint can support, and what this checks:
#   - the deployment answers /version with a build stamp and its seeded operator
#     still responds (healthy);
#   - it is on the SAME platform build as dev/prod (a divergence is a partial
#     rollout or a restore, and the only stamp signal worth failing on).
# The baseline names the platform build the fleet last agreed on. When the whole
# fleet moves, the reference advances by itself and the superseded value is
# appended as `history=`, so re-baselining never erases what it replaced.
write_baseline() { # new_stamp superseded_stamp superseded_recorded note
  local kept="" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -f "$PROTECTED_BASELINE" ] && kept="$(grep '^history=' "$PROTECTED_BASELINE" 2>/dev/null)"
  {
    printf 'url=%s\nstamp=%s\nrecorded=%s\n' "$PROTECTED_URL" "$1" "$now"
    [ -n "$kept" ] && printf '%s\n' "$kept"
    if [ -n "${2:-}" ]; then
      printf 'history=%s recorded=%s superseded=%s replaced_by=%s (%s)\n' \
        "$2" "${3:-unknown}" "$now" "$1" "${4:-re-baselined}"
    fi
  } > "$PROTECTED_BASELINE"
}

if [ "${SKIP_PROTECTED:-0}" = "1" ]; then
  info "6. protected-deployment check skipped (SKIP_PROTECTED=1)"
else
  PROTECTED_URL="${PROTECTED_URL-https://shiny-bulldog-311.convex.cloud}"
  PROTECTED_URL="${PROTECTED_URL%/}"
  stamp="$(curl -sS -m 15 "${PROTECTED_URL}/version" 2>/dev/null | tr -d '\n\r')"
  pcode="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${PROTECTED_URL}/version" 2>/dev/null || echo 000)"
  pseeded="$(curl -sS -m 15 -X POST "${PROTECTED_URL}/api/query" -H 'Content-Type: application/json' \
    -d '{"path":"gate:operatorStatus","args":{}}' 2>/dev/null | grep -o 'seeded":[a-z]*' | cut -d: -f2)"
  dev_stamp="$(curl -sS -m 15 "https://${DEV_SITE}.convex.cloud/version" 2>/dev/null | tr -d '\n\r')"
  prod_stamp="$(curl -sS -m 15 "https://${PROD_SITE}.convex.cloud/version" 2>/dev/null | tr -d '\n\r')"

  healthy=yes
  [ "$pcode" = "200" ] || { healthy=no; fail "6. protected deployment /version returned ${pcode:-no-response}"; }
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T*) ;;
    *) healthy=no; fail "6. protected deployment /version is not a build stamp ('$(printf %s "$stamp" | head -c 40)')" ;;
  esac
  [ "$pseeded" = "true" ] || { healthy=no; fail "6. protected deployment gate:operatorStatus = '${pseeded:-unreachable}'"; }

  if [ "$healthy" = "yes" ]; then
    previous="$(grep -m1 '^stamp=' "$PROTECTED_BASELINE" 2>/dev/null | cut -d= -f2-)"
    previous_recorded="$(grep -m1 '^recorded=' "$PROTECTED_BASELINE" 2>/dev/null | cut -d= -f2-)"
    fleet=""
    [ -n "$dev_stamp" ] && [ "$stamp" != "$dev_stamp" ] && fleet="dev ${dev_stamp}"
    [ -n "$prod_stamp" ] && [ "$stamp" != "$prod_stamp" ] && fleet="${fleet:+$fleet, }prod ${prod_stamp}"

    if [ -n "$fleet" ]; then
      fail "6. protected deployment is on platform build ${stamp} while ${fleet} — a partial rollout or a restore, not a deploy"
      info "a deploy to this deployment cannot change /version; the divergence itself is the finding"
    elif [ -z "$previous" ]; then
      write_baseline "$stamp" "" "" ""
      pass "6. protected deployment healthy on the fleet build ${stamp}; baseline recorded (future runs compare)"
    elif [ "$previous" = "$stamp" ]; then
      pass "6. protected deployment healthy on the fleet build ${stamp}; reference unchanged"
    elif [ "$FIX" = "1" ]; then
      write_baseline "$stamp" "$previous" "$previous_recorded" "re-recorded with --fix"
      pass "6. protected deployment healthy; reference re-recorded ${previous} -> ${stamp} (superseded value kept in history)"
    else
      write_baseline "$stamp" "$previous" "$previous_recorded" "platform rollout, fleet-wide"
      pass "6. protected deployment healthy; platform build rolled fleet-wide ${previous} -> ${stamp}"
      info "reference advanced; superseded value kept in history (a deploy cannot change this stamp)"
    fi
  fi
fi

# ── 7. dev/prod data parity ────────────────────────────────────────────────
# Row count: `convex data` prints a pipe table whose header also contains ' | ',
# so documents = pipe-lines minus one. Empty tables print a sentence instead;
# unreachable deployments return -1, which must FAIL rather than compare equal.
CLI_LIMIT=100
count_docs() {
  local key="$1" table="$2" raw pl
  raw="$(CONVEX_DEPLOY_KEY="$key" timeout "$CLI_TIMEOUT" "$CONVEX_BIN" data "$table" --limit "$CLI_LIMIT" 2>/dev/null)"
  if printf '%s' "$raw" | grep -q 'There are no documents'; then echo 0; return; fi
  if [ -z "$raw" ]; then echo -1; return; fi
  pl="$(printf '%s' "$raw" | grep -c ' | ')"
  [ "$pl" -gt 0 ] && echo $((pl - 1)) || echo 0
}
# Every user id must appear exactly once in authAccounts — an exact per-user
# check that does not depend on column layout (account ids differ from user
# ids, so counting occurrences of a user id in the accounts dump is precise).
# Ids print quoted (`"jx7e9h53…"`) under a header and a `---|----|---` separator
# line, so match the quoted first field and drop everything else.
user_ids() { CONVEX_DEPLOY_KEY="$1" timeout "$CLI_TIMEOUT" "$CONVEX_BIN" data users --limit "$CLI_LIMIT" 2>/dev/null | grep -oE '^"[a-z0-9]{20,40}"' | tr -d '"'; }
accounts_dump() { CONVEX_DEPLOY_KEY="$1" timeout "$CLI_TIMEOUT" "$CONVEX_BIN" data authAccounts --limit "$CLI_LIMIT" 2>/dev/null | tail -n +2; }
# A read that timed out or returned nothing proves nothing either way. When the
# provider is already known to be blocking serving, that is BLOCKED; otherwise it
# is a genuine failure to read the data.
unreadable() {
  if [ "$PROVIDER_BLOCKED" = "1" ]; then
    blocked "$1 — not readable while the provider blocks serving"
  else
    fail "$1"
  fi
}

if [ -z "$DEV_KEY" ] || [ -z "$PROD_KEY" ]; then
  fail "7. parity needs both deploy keys"
else
  d_oc=$(count_docs "$DEV_KEY" operatorConfig); p_oc=$(count_docs "$PROD_KEY" operatorConfig)
  d_u=$(count_docs "$DEV_KEY" users);             p_u=$(count_docs "$PROD_KEY" users)
  d_a=$(count_docs "$DEV_KEY" authAccounts);      p_a=$(count_docs "$PROD_KEY" authAccounts)

  if [ "$d_oc" = "-1" ] || [ "$p_oc" = "-1" ]; then
    unreadable "7a. operatorConfig unreadable (dev ${d_oc}, prod ${p_oc})"
  elif [ "$d_oc" = "1" ] && [ "$p_oc" = "1" ]; then
    pass "7a. operatorConfig present once on each side (dev ${d_oc}, prod ${p_oc})"
  else
    fail "7a. operatorConfig is not exactly one row per deployment (dev ${d_oc}, prod ${p_oc})"
  fi

  # Exact per-user account coverage, both sides.
  orphan_total=0; missing_total=0
  for pair in "dev:$DEV_KEY" "prod:$PROD_KEY"; do
    side="${pair%%:*}"; key="${pair#*:}"
    dump="$(accounts_dump "$key")"
    ids="$(user_ids "$key")"
    if [ -z "$ids" ]; then unreadable "7b. ${side} users unreadable"; orphan_total=-1; continue; fi
    missing=0; dup=0
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      n="$(printf '%s' "$dump" | grep -c -- "$id")"
      [ "$n" -eq 0 ] && missing=$((missing + 1))
      [ "$n" -gt 1 ] && dup=$((dup + 1))
    done <<< "$ids"
    uniq_ids="$(printf '%s\n' "$ids" | sort -u | wc -l | tr -d ' ')"
    missing_total=$((missing_total + missing))
    orphan_total=$((orphan_total + dup))
    if [ "$missing" -eq 0 ] && [ "$dup" -eq 0 ]; then
      pass "7b. ${side}: all ${uniq_ids} users have exactly one authAccount"
    else
      fail "7b. ${side}: ${missing} user(s) without an authAccount, ${dup} user(s) with duplicates"
    fi
  done

  if [ "$d_u" = "-1" ] || [ "$p_u" = "-1" ]; then
    unreadable "7c. users unreadable (dev ${d_u}, prod ${p_u})"
  elif [ "$d_u" -ge "$p_u" ] 2>/dev/null; then
    pass "7c. dev not behind prod on users (dev ${d_u}, prod ${p_u})"
    [ "$d_u" -ne "$p_u" ] && info "drift is expected: the published preview writes anonymous users to dev"
  else
    fail "7c. prod has more users than dev (dev ${d_u}, prod ${p_u})"
  fi

  for n in "$d_u" "$p_u" "$d_a" "$p_a"; do
    [ "$n" = "$CLI_LIMIT" ] && info "a table hit the CLI --limit ${CLI_LIMIT} cap, so its count is a floor"
  done
fi

echo
if [ "$FAIL" -eq 0 ] && [ "$BLOCKED" -eq 0 ]; then
  echo "RESULT all checks passed"
  exit 0
fi
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT no failures; ${BLOCKED} check(s) blocked by the provider"
  echo "hint   the provider disabled function serving on its own schedule — an upgrade or the next usage window lifts it"
  exit 2
fi
echo "RESULT ${FAIL} check(s) failed, ${BLOCKED} blocked"
[ "$FIX" = "0" ] && echo "hint   re-run with: bun run check:tasks --fix"
exit 1
