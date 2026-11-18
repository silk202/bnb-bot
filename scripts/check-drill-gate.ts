/**
 * FlashBolt — live-path drill release gate.
 *
 * Reads reports/drill-latest.txt (written verbatim by `bun run drill:report`)
 * and enforces, in order:
 *   1. The artifact exists and is parseable.
 *   2. Its COMBINED VERDICT is 2/2 subsystems fully passed — real network
 *      proof from both drills, not simulated anywhere.
 *   3. The report is FRESH (default: younger than 24 hours) so a release
 *      always carries a recent combined run, never a stale artifact.
 *
 * There is deliberately NO bypass flag: a release ships only with a fresh,
 * fully-passing live drill. If the verdict is below 2/2 the gate prints the
 * exact drill addresses to fund (see DRILLS.md) and the re-run command.
 *
 * Usage:  bun run check:drill   (wired into `bun run verify` as step 4/4)
 * Exit:   0 = fresh 2/2 report; 1 = anything else (never faked green).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The evaluator lives in src/lib so the browser renders the SAME pure logic
// against the pinned artifact (DrillStatusCard) — the CLI and the UI can
// never disagree about what a report means.
import { evaluateDrillReport } from "../src/lib/drill-report";

export const REPORT_PATH = join(import.meta.dir, "..", "reports", "drill-latest.txt");
export { evaluateDrillReport, DEFAULT_MAX_AGE_MS } from "../src/lib/drill-report";
export type { DrillGateResult } from "../src/lib/drill-report";

function main(): number {
  // Default report; an alternative path may be passed for tooling and tests
  // (e.g. scripts/report-drill-status.sh) — never to pass a fake run off as
  // the real release artifact.
  const reportPath = process.argv[2] ?? REPORT_PATH;
  if (!existsSync(reportPath)) {
    console.error("✗ drill gate: reports/drill-latest.txt not found — run: bun run drill:report");
    console.error("  (drill:report = drill:all with the untouched output pinned as the release artifact)");
    return 1;
  }
  const result = evaluateDrillReport(readFileSync(reportPath, "utf8"));
  if (result.ok) {
    console.log(
      `✓ drill gate: combined verdict ${result.verdict}, report ${result.ageHours!.toFixed(1)}h old — live-path proof is fresh and complete.`,
    );
    return 0;
  }
  for (const p of result.problems) console.error(`✗ drill gate: ${p}`);
  for (const r of result.remediation) console.error(`  → ${r}`);
  return 1;
}

// CLI entry only when run directly; importing for tests stays side-effect free.
if (import.meta.main) {
  process.exit(main());
}
