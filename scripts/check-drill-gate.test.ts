import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_AGE_MS, evaluateDrillReport } from "./check-drill-gate";

const SOL_ADDR = "CY8im5qWAzuD1oD3LnYuJsuAeUPrT1M6agudhJ93vN4K";
const EVM_ADDR = "0x329513F68b697e83a769800A45fB84C568B47901";
const T0 = Date.parse("2026-09-29T01:24:43.804Z");

/** Fixture shaped exactly like real drill:all output (subset the gate reads). */
function fixture(verdict: 0 | 1 | 2, iso: string, opts: { addresses?: boolean } = {}): string {
  const { addresses = true } = opts;
  const bar = "══════════════════════════════════════════════════════════════";
  const lines = [
    `[drill:all] FlashBolt combined live drill — ${iso}`,
    "",
    bar,
    "  FLASHBOLT COMBINED DRILL · SOL FlashBolt · Solana devnet",
    bar,
    "  ✓ Stage 1 · vault seal/lock/unlock (AES-256-GCM) (145ms) — CY8im5qW…",
    ...(addresses ? [`[devnet-drill] drill address (deterministic, devnet-only): ${SOL_ADDR}`] : []),
    ...(verdict < 2
      ? [`  ✗ Stage 3 · devnet funding (real SOL) FAILED (6700ms): both funding paths refused (daily faucet limit)`, ""]
      : ["  ✓ Stage 4 · sendTransaction → on-chain confirmation (3210ms) — https://explorer.solana.com/tx/abc?cluster=devnet", ""]),
    "",
    bar,
    "  FLASHBOLT COMBINED DRILL · BNB FlashBolt · BSC testnet",
    bar,
    ...(addresses ? [`[evm-drill] drill address (deterministic, testnet-only): ${EVM_ADDR}`] : []),
    ...(verdict < 2
      ? ["  ✗ Stage 3 · BSC testnet funding (real testBNB) FAILED (31498ms): every faucet refused or timed out", ""]
      : ["  ✓ Stage 5 · PancakeSwap swap via production buyToken (vault-signed) (8123ms) — 42.0000 tokens held", ""]),
    "",
    `[drill:all] ══ COMBINED VERDICT: ${verdict}/2 subsystems fully passed in 95000ms ══`,
  ];
  return lines.join("\n") + "\n";
}

describe("drill release gate", () => {
  test("fresh 2/2 report passes", () => {
    const r = evaluateDrillReport(fixture(2, "2026-09-29T01:24:43.804Z"), { now: T0 + 3_600_000 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("2/2");
    expect(r.problems).toEqual([]);
    expect(r.remediation).toEqual([]);
    expect(r.ageHours).toBeCloseTo(1, 5);
  });

  test("0/2 fresh report fails with both funding addresses", () => {
    const r = evaluateDrillReport(fixture(0, "2026-09-29T01:24:43.804Z"), { now: T0 + 60_000 });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("0/2");
    expect(r.problems.join(" ")).toContain("requires 2/2");
    expect(r.remediation.join("\n")).toContain(EVM_ADDR);
    expect(r.remediation.join("\n")).toContain(SOL_ADDR);
    expect(r.remediation.join("\n")).toContain("bun run drill:report");
  });

  test("1/2 fresh report fails too — one subsystem short is a hold", () => {
    const r = evaluateDrillReport(fixture(1, "2026-09-29T01:24:43.804Z"), { now: T0 + 60_000 });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("1/2");
  });

  test("stale 2/2 report fails — freshness is mandatory", () => {
    const r = evaluateDrillReport(fixture(2, "2026-09-29T01:24:43.804Z"), {
      now: T0 + DEFAULT_MAX_AGE_MS + 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("stale");
    expect(r.ageHours).toBeGreaterThan(24);
  });

  test("custom freshness window is honored", () => {
    const report = fixture(2, "2026-09-29T01:24:43.804Z");
    expect(evaluateDrillReport(report, { now: T0 + 2_000, maxAgeMs: 1_000 }).ok).toBe(false);
    expect(evaluateDrillReport(report, { now: T0 + 2_000, maxAgeMs: 3_600_000 }).ok).toBe(true);
  });

  test("empty report fails with the re-run hint", () => {
    const r = evaluateDrillReport("   \n  ");
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("unknown");
    expect(r.problems.join(" ")).toContain("report is empty");
  });

  test("truncated / malformed report fails instead of guessing", () => {
    const r = evaluateDrillReport("[drill:all] partial output, no verdict line\n");
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("unknown");
    expect(r.problems.join(" ")).toContain("no recognizable COMBINED VERDICT");
  });

  test("unparseable timestamp fails instead of trusting the verdict", () => {
    const r = evaluateDrillReport(fixture(2, "2026-99-99T99:99:99.999Z"), { now: T0 });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("unparseable");
  });

  test("below-2/2 without address lines still points at DRILLS.md", () => {
    const r = evaluateDrillReport(fixture(0, "2026-09-29T01:24:43.804Z", { addresses: false }), { now: T0 });
    expect(r.ok).toBe(false);
    expect(r.remediation.join(" ")).toContain("DRILLS.md");
  });
});
