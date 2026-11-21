#!/usr/bin/env bash
#
# FlashboltSolana — build/deploy preflight (READ ONLY).
#
# Reports exactly what is and is not ready to build/deploy the program. It
# never deploys, never signs, never moves funds and never prints a secret: the
# only key material it touches is a PUBLIC program address.
#
# Usage: bash scripts/solana-program-preflight.sh
#        FLASHBOLT_PROGRAM_KEYPAIR=/path/to/keypair.json bash scripts/...
# Exit:  0 = ready for a devnet deploy, 1 = blocked (every blocker printed)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="$ROOT/solana"
PROGRAM_SRC="$PROGRAM_DIR/programs/flashbolt_solana/src/lib.rs"
SO="$PROGRAM_DIR/target/deploy/flashbolt_solana.so"
KEYPAIR="$PROGRAM_DIR/target/deploy/flashbolt_solana-keypair.json"
IDL="$PROGRAM_DIR/target/idl/flashbolt_solana.json"
IDL_TRACKED="$PROGRAM_DIR/idl/flashbolt_solana.json"

# Confirmed program address (2026-11-21). It is the public key of the retained
# deployment keypair; the whole point of this gate is that a build can never be
# deployed at an address the operator did not confirm.
EXPECTED_ID="82BPo27Cg6em3CqhZxsxX4F8ER6d5auu2vqWYeTXRSVd"

# The Anchor template's example ID — never a real program address.
PLACEHOLDER_ID="Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

# Where the retained program keypair is materialised (outside the repository).
RETAINED_KEYPAIR="${FLASHBOLT_PROGRAM_KEYPAIR:-$HOME/.config/solana/flashbolt-deployer.json}"

blocked=0
ok()   { printf '  OK    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; blocked=1; }

solana_address_of() {
  command -v solana >/dev/null 2>&1 || return 1
  [[ -f "$1" ]] || return 1
  solana address -k "$1" 2>/dev/null
}

echo "FlashboltSolana preflight — $ROOT"
echo

echo "1. Program source"
if [[ -f "$PROGRAM_DIR/Anchor.toml" ]]; then
  ok "Anchor project: solana/Anchor.toml"
else
  miss "no Anchor project at solana/Anchor.toml"
fi
if [[ -f "$PROGRAM_SRC" ]]; then
  ok "program source: ${PROGRAM_SRC#$ROOT/} (configuration + authority foundation)"
else
  miss "no program source at ${PROGRAM_SRC#$ROOT/}"
fi

declared_id=""
if [[ -f "$PROGRAM_SRC" ]]; then
  declared_id="$(sed -nE 's/.*declare_id!\("([^"]+)"\).*/\1/p' "$PROGRAM_SRC" | head -n 1)"
fi
if [[ "$declared_id" == "$PLACEHOLDER_ID" ]]; then
  miss "declare_id! in lib.rs is still the Anchor template placeholder ($PLACEHOLDER_ID)"
elif [[ -z "$declared_id" ]]; then
  miss "could not read declare_id! from ${PROGRAM_SRC#$ROOT/}"
elif [[ "$declared_id" != "$EXPECTED_ID" ]]; then
  miss "declare_id! is $declared_id but the confirmed program address is $EXPECTED_ID"
else
  ok "declare_id! = $declared_id (confirmed address)"
fi

if [[ -f "$PROGRAM_DIR/Anchor.toml" ]]; then
  anchor_toml_ids="$(sed -nE 's/^flashbolt_solana = "([^"]+)".*/\1/p' "$PROGRAM_DIR/Anchor.toml" | sort -u)"
  if grep -q "$PLACEHOLDER_ID" "$PROGRAM_DIR/Anchor.toml"; then
    miss "Anchor.toml still carries the Anchor template placeholder program ID"
  elif [[ -z "$anchor_toml_ids" ]]; then
    miss "Anchor.toml declares no flashbolt_solana program entry"
  elif [[ "$anchor_toml_ids" == "$EXPECTED_ID" ]]; then
    ok "Anchor.toml program entries = $EXPECTED_ID (localnet, devnet)"
  else
    miss "Anchor.toml program entries disagree with the confirmed address: $(echo "$anchor_toml_ids" | tr '\n' ' ')"
  fi
  if grep -q '^\[programs\.mainnet\]' "$PROGRAM_DIR/Anchor.toml"; then
    miss "Anchor.toml has a mainnet program entry — mainnet stays off until the audit"
  else
    ok "no mainnet program entry (audit not done)"
  fi
fi

echo
echo "2. Build artifact and program keypair"
if [[ -f "$SO" ]]; then
  ok "program binary: ${SO#$ROOT/} ($(wc -c < "$SO" | tr -d ' ') bytes)"
else
  miss "no compiled program at ${SO#$ROOT/} (run: cd solana && anchor build)"
fi

# The keypair whose public key is the program ID is the only one that may
# deploy to that address. Prefer the build output, then the retained keypair.
program_keypair=""
program_keypair_id=""
if keypair_id="$(solana_address_of "$KEYPAIR")"; then
  program_keypair="$KEYPAIR"
  program_keypair_id="$keypair_id"
elif keypair_id="$(solana_address_of "$RETAINED_KEYPAIR")"; then
  program_keypair="$RETAINED_KEYPAIR"
  program_keypair_id="$keypair_id"
fi

if [[ -z "$program_keypair" ]]; then
  miss "no program keypair at ${KEYPAIR#$ROOT/} or ${RETAINED_KEYPAIR/#$HOME/~} (the keypair whose pubkey is the program ID)"
elif [[ "$program_keypair_id" == "$EXPECTED_ID" ]]; then
  ok "program keypair = $program_keypair_id (matches the confirmed address)"
else
  miss "program keypair is $program_keypair_id but the confirmed program address is $EXPECTED_ID — deploying it would run elsewhere"
fi

idl_path=""
[[ -f "$IDL" ]] && idl_path="$IDL"
[[ -z "$idl_path" && -f "$IDL_TRACKED" ]] && idl_path="$IDL_TRACKED"
if [[ -n "$idl_path" ]]; then
  idl_address="$(sed -nE 's/^[[:space:]]*"address":[[:space:]]*"([^"]+)".*/\1/p' "$idl_path" | head -n 1)"
  if [[ "$idl_address" == "$EXPECTED_ID" ]]; then
    ok "IDL: ${idl_path#$ROOT/} (address $idl_address)"
  elif [[ -z "$idl_address" ]]; then
    miss "IDL ${idl_path#$ROOT/} has no address field — regenerate it with anchor idl build"
  else
    miss "IDL address is $idl_address but the confirmed program address is $EXPECTED_ID"
  fi
else
  miss "no IDL at ${IDL#$ROOT/} or ${IDL_TRACKED#$ROOT/} (run: cd solana && anchor idl build -o idl/flashbolt_solana.json)"
fi

echo
echo "3. Toolchain"
for tool in rustc cargo solana cargo-build-sbf anchor; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool — $("$tool" --version 2>/dev/null | head -n 1)"
  else
    miss "$tool not installed (see reports/solana-program-handoff-2026-11-19.md)"
  fi
done

echo
echo "4. Deploy authority (public information only)"
if command -v solana >/dev/null 2>&1; then
  cfg_url="$(solana config get 2>/dev/null | awk -F': ' '/RPC URL/ {print $2}')"
  echo "  cluster: ${cfg_url:-unknown}"
  if addr="$(solana address 2>/dev/null)"; then
    ok "deployer address: $addr"
    if bal="$(solana balance 2>/dev/null)"; then
      ok "deployer balance: $bal (program rent is ~2–4 SOL)"
    else
      miss "could not read the deployer balance"
    fi
  else
    miss "no default deployer keypair (solana-keygen new --outfile ~/.config/solana/devnet-deployer.json)"
  fi
  case "${cfg_url:-}" in
    *devnet*) ok "configured for devnet — the only cluster to arm first" ;;
    *mainnet*) miss "configured for MAINNET — switch to devnet; mainnet stays off until the audit" ;;
    *) miss "cluster not clearly devnet (solana config set --url https://api.devnet.solana.com)" ;;
  esac
else
  miss "solana CLI missing — authority, cluster and balance cannot be checked"
fi

echo
echo "5. Deploy command this script would use (NOT run here)"
if [[ -n "$program_keypair" ]]; then
  echo "  solana program deploy --program-id \"$program_keypair\" \"${SO#$ROOT/}\""
else
  echo "  (unavailable until a program keypair matching $EXPECTED_ID exists)"
fi

echo
if [[ "$blocked" -eq 0 ]]; then
  echo "READY — source, address, keypair, IDL, toolchain and devnet authority are present."
  exit 0
fi
echo "BLOCKED — fix the MISS lines above; nothing was deployed or signed."
exit 1
