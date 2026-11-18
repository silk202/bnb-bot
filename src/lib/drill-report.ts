/**
 * FlashBolt — live-drill release report, evaluated anywhere.
 *
 * This is the SAME pure evaluator the release gate uses
 * (scripts/check-drill-gate.ts re-exports from here), applied to the REAL
 * pinned artifact reports/drill-latest.txt — the verbatim output of the last
 * `bun run drill:report`. Nothing is simulated: the DrillStatusCard renders
 * the actual verdict text from that run, or says honestly that it cannot
 * parse the pinned artifact.
 *
 * No Node APIs — safe to import from the browser bundle.
 */

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DrillGateResult {
  ok: boolean;
  /** "2/2" style verdict as parsed from the report, "unknown" if absent. */
  verdict: string;
  /** Report age in hours, null when the timestamp is missing/unparseable. */
  ageHours: number | null;
  problems: string[];
  /** Concrete next steps (addresses to fund) when the verdict is below 2/2. */
  remediation: string[];
}

const VERDICT_RE = /COMBINED VERDICT:\s*(\d)\/2 subsystems fully passed in (\d+)ms/;
const TIMESTAMP_RE = /combined live drill — (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
const EVM_ADDR_RE = /drill address \(deterministic, testnet-only\): (0x[0-9a-fA-F]{40})/;
const SOL_ADDR_RE = /drill address \(deterministic, devnet-only\): ([1-9A-HJ-NP-Za-km-z]{32,44})/;

/** Pure evaluation of a drill report — no I/O, fully unit-testable. */
export function evaluateDrillReport(
  report: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): DrillGateResult {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const problems: string[] = [];
  const remediation: string[] = [];

  const trimmed = report.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      verdict: "unknown",
      ageHours: null,
      problems: ["report is empty — re-run: bun run drill:report"],
      remediation,
    };
  }

  const verdictMatch = VERDICT_RE.exec(trimmed);
  if (!verdictMatch) {
    return {
      ok: false,
      verdict: "unknown",
      ageHours: null,
      problems: [
        "no recognizable COMBINED VERDICT line — the report is truncated or from an older runner — re-run: bun run drill:report",
      ],
      remediation,
    };
  }
  const passed = Number(verdictMatch[1]);
  const verdict = `${passed}/2`;

  const tsMatch = TIMESTAMP_RE.exec(trimmed);
  let ageHours: number | null = null;
  if (!tsMatch) {
    problems.push("report has no timestamp header — re-run: bun run drill:report");
  } else {
    const ts = Date.parse(tsMatch[1]);
    if (!Number.isFinite(ts)) {
      problems.push("report timestamp is unparseable — re-run: bun run drill:report");
    } else {
      ageHours = (now - ts) / 3_600_000;
      if (now - ts > maxAgeMs) {
        problems.push(
          `report is stale (${ageHours.toFixed(1)}h old, limit ${Math.round(maxAgeMs / 3_600_000)}h) — releases need a recent combined run — re-run: bun run drill:report`,
        );
      }
    }
  }

  if (passed < 2) {
    problems.push(
      `combined drill verdict is ${verdict} — a release requires 2/2 subsystems fully passed on the live test networks (see DRILLS.md)`,
    );
    const evm = EVM_ADDR_RE.exec(trimmed)?.[1];
    const sol = SOL_ADDR_RE.exec(trimmed)?.[1];
    if (evm) remediation.push(`fund ${evm} (BSC testnet) — https://testnet.bnbchain.org/en/testnet-faucet`);
    if (sol) remediation.push(`fund ${sol} (Solana devnet) — https://faucet.solana.com`);
    remediation.push(
      remediation.length > 1
        ? "then re-run: bun run drill:report"
        : "see DRILLS.md — fund the drill addresses, then re-run: bun run drill:report",
    );
  }

  return { ok: problems.length === 0, verdict, ageHours, problems, remediation };
}

/** The deterministic drill addresses found in a report (for explorer links). */
export function extractDrillAddresses(report: string): { evm?: string; sol?: string } {
  return {
    evm: EVM_ADDR_RE.exec(report.trim())?.[1],
    sol: SOL_ADDR_RE.exec(report.trim())?.[1],
  };
}
