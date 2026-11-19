#!/usr/bin/env bash
#
# FlashboltSolana — devnet deploy preflight (READ ONLY).
#
# Reports exactly what is and is not ready to build/deploy the program. It
# never deploys, never signs, never moves funds and never prints a secret: the
# only key material it touches is a PUBLIC program address.
#
# Usage: bash scripts/solana-program-preflight.sh
# Exit:  0 = ready for a devnet deploy, 1 = blocked (every blocker printed)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="$ROOT/solana"
SO="$PROGRAM_DIR/target/deploy/flashbolt_solana.so"
KEYPAIR="$PROGRAM_DIR/target/deploy/flashbolt_solana-keypair.json"

blocked=0
ok()   { printf '  OK    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; blocked=1; }

echo "FlashboltSolana devnet preflight — $ROOT"
echo

echo "1. Program artifact"
if [[ -f "$SO" ]]; then
  ok "program binary: ${SO#$ROOT/} ($(wc -c < "$SO" | tr -d ' ') bytes)"
else
  miss "no compiled program at ${SO#$ROOT/} (run: cd solana && anchor build)"
fi
if [[ -f "$KEYPAIR" ]]; then
  ok "program keypair: ${KEYPAIR#$ROOT/}"
else
  miss "no program keypair at ${KEYPAIR#$ROOT/} (Anchor writes it on build)"
fi
if [[ -f "$PROGRAM_DIR/Anchor.toml" ]]; then
  ok "Anchor project: solana/Anchor.toml"
else
  miss "no Anchor project at solana/Anchor.toml (source not present)"
fi

echo
echo "2. Toolchain"
for tool in rustc cargo solana cargo-build-sbf anchor; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool — $("$tool" --version 2>/dev/null | head -n 1)"
  else
    miss "$tool not installed (see reports/solana-program-handoff-2026-11-19.md)"
  fi
done

echo
echo "3. Deploy authority (public information only)"
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
if [[ "$blocked" -eq 0 ]]; then
  echo "READY — artifact, toolchain and devnet authority are present."
  echo "Deploy: solana program deploy --program-id ${KEYPAIR#$ROOT/} ${SO#$ROOT/}"
  exit 0
fi
echo "BLOCKED — fix the MISS lines above; nothing was deployed or signed."
exit 1
