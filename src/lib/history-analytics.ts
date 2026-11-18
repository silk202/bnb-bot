/**
 * History analytics — pure, browser-safe signing-latency helpers.
 *
 * Every execution row in the terminal may carry an optional, REAL measured
 * `signingLatencyMs` (performance.now() around the actual
 * `account.signTransaction` call in the production executor). Browser
 * extension-signed and Solana wallet-signed paths honestly report no
 * latency — the extension does the signing, not FlashBolt — so those rows
 * carry `undefined` and MUST stay invisible to latency aggregates: an
 * average over unmeasured rows would be fabricated precision.
 *
 * Contracts (mirrored by tests in src/lib/__tests__/history-analytics.test.ts):
 *   • `signingLatencyFilter(all|measured|unmeasured)` — returns a pure row
 *     predicate; "measured" keeps only rows with a finite latency > 0.
 *   • `signLatencyStats(rows)` — aggregate over MEASURED rows only:
 *     {count, avg, min, max} with avg/min/max = undefined at count 0, and
 *     one decimal of ms precision (µs-scale values stay sub-ms).
 *   • `buildHistoryCsv(rows)` — CSV of the trail incl. latency columns:
 *     `sign_latency_ms` numeric or empty when unmeasured, `sign_latency`
 *     human format (µs precision) via fmtSignLatency. Excel-safe: ISO
 *     timestamps, CRLF newlines, quoted fields with escaped quotes.
 *   • `timestampForCsv(ts)` — ISO-8601 with ms precision, UTC.
 *
 * No React, no Convex, no DOM — testable with bun:test as-is.
 */

import { fmtSignLatency } from "@/lib/telegram";

/** Filter identity for the signing-latency dimension of the History trail. */
export type SignLatencyFilter = "all" | "measured" | "unmeasured";

/** The subset of an execution row the helpers actually read. */
export interface HistoryRow {
  ts: number;
  label: string;
  status: string;
  amountBnb: number;
  profitPct: number;
  relay?: string | null;
  txHash?: string | null;
  dexes?: string;
  lender?: string;
  /** REAL measured signing latency (ms) — absent when not measured. */
  signingLatencyMs?: number;
}

/** Measured = finite, positive latency. NaN/0/negative count as unmeasured. */
function isMeasured(e: { signingLatencyMs?: number }): boolean {
  return (
    e.signingLatencyMs !== undefined &&
    Number.isFinite(e.signingLatencyMs) &&
    e.signingLatencyMs > 0
  );
}

/**
 * Pure predicate for the latency filter chip. Exported so the UI and the
 * tests share one definition of "measured" — never a divergent inline copy.
 */
export function signingLatencyFilter(
  f: SignLatencyFilter,
): (e: { signingLatencyMs?: number }) => boolean {
  if (f === "measured") return isMeasured;
  if (f === "unmeasured") return (e) => !isMeasured(e);
  return () => true;
}

/**
 * Aggregate over MEASURED rows only — unmeasured rows are excluded, not
 * zero-filled. `avg/min/max` are undefined at count 0.
 */
export function signLatencyStats(
  rows: ReadonlyArray<{ signingLatencyMs?: number }>,
): { count: number; avg?: number; min?: number; max?: number } {
  const measured = rows
    .map((e) => e.signingLatencyMs)
    .filter(
      (ms): ms is number =>
        ms !== undefined && Number.isFinite(ms) && ms > 0,
    );
  if (measured.length === 0) return { count: 0 };
  const sum = measured.reduce((a, b) => a + b, 0);
  return {
    count: measured.length,
    avg: Math.round((sum / measured.length) * 100) / 100,
    min: Math.round(Math.min(...measured) * 100) / 100,
    max: Math.round(Math.max(...measured) * 100) / 100,
  };
}

/** ISO-8601 with ms precision, UTC — Excel-safe in every locale. */
export function timestampForCsv(ts: number): string {
  return new Date(ts).toISOString();
}

/** Escape a CSV cell: quotes doubled, then wrapped in quotes if needed. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the execution trail including signing latency. Column `sign_latency_ms`
 * is the raw number, or empty when the row was not measured (extension- or
 * wallet-signed) — never 0, never guessed. Human column `sign_latency` uses
 * fmtSignLatency (µs precision below 1ms, empty when unmeasured).
 */
export function buildHistoryCsv(
  rows: ReadonlyArray<HistoryRow>,
): string {
  const header = [
    "timestamp_utc",
    "label",
    "status",
    "lender",
    "dexes",
    "amount_bnb",
    "profit_pct",
    "relay",
    "tx_hash",
    "sign_latency_ms",
    "sign_latency",
  ];
  const lines = rows.map((e) =>
    [
      timestampForCsv(e.ts),
      e.label,
      e.status,
      e.lender ?? "",
      e.dexes ?? "",
      e.amountBnb.toFixed(6),
      e.profitPct.toFixed(4),
      e.relay ?? "",
      e.txHash ?? "",
      e.signingLatencyMs !== undefined &&
      Number.isFinite(e.signingLatencyMs) &&
      e.signingLatencyMs > 0
        ? String(e.signingLatencyMs)
        : "",
      fmtSignLatency(e.signingLatencyMs),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
