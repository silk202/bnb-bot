/**
 * FlashBolt — COMBINED live drill: SOL devnet + EVM (BSC testnet), back to
 * back, streaming each subsystem's stages live and reporting ONE honest
 * combined verdict.
 *
 * Run:  bun run drill:all
 * Exit: 0 = both drills fully passed on the real networks; 1 = at least one
 *       stage failed anywhere (the output shows exactly which stage of which
 *       subsystem and why — never a faked green check).
 *
 * Funding note (honest): both drills broadcast only to TEST networks and
 * generate their own throwaway keys. When a faucet refuses (daily limits,
 * CAPTCHA-only UIs), the drill prints the exact address to fund manually and
 * re-run — it never substitutes a mock for the missing broadcast.
 */

import { spawnSync } from "node:child_process";

function runDrill(label: string, script: string): boolean {
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  FLASHBOLT COMBINED DRILL · ${label}`);
  console.log(`${"═".repeat(62)}`);
  // Stream the child's output through untouched (real output, no rewriting),
  // with stdio inherited so progress appears live.
  const res = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    env: process.env,
  });
  if (res.status === 0) {
    console.log(`\n[drill:all] ${label}: ALL STAGES PASSED`);
    return true;
  }
  console.error(`\n[drill:all] ${label}: FAILED (exit ${res.status} ${res.error ? String(res.error) : ""})`);
  return false;
}

async function main(): Promise<number> {
  const t0 = Date.now();
  console.log(`\n[drill:all] FlashBolt combined live drill — ${new Date().toISOString()}`);

  const sol = runDrill("SOL FlashBolt · Solana devnet", "scripts/devnet-drill.ts");
  const evm = runDrill("BNB FlashBolt · BSC testnet", "scripts/evm-drill.ts");

  const passed = [sol, evm].filter(Boolean).length;
  console.log(`\n${"═".repeat(62)}`);
  console.log(`[drill:all] ══ COMBINED VERDICT: ${passed}/2 subsystems fully passed in ${Date.now() - t0}ms ══`);
  console.log("═".repeat(62));
  return passed === 2 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[drill:all] FATAL:", err);
    process.exit(1);
  });
