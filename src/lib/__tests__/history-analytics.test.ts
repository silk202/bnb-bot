import { describe, expect, test } from "bun:test";
import {
  buildHistoryCsv,
  signLatencyStats,
  signingLatencyFilter,
  timestampForCsv,
} from "../history-analytics";

const T0 = new Date("2026-09-29T12:00:00.000Z").getTime();

type Row = Parameters<typeof buildHistoryCsv>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    ts: T0,
    label: "USDC→WBNB→CAKE",
    status: "success",
    amountBnb: 0.5,
    profitPct: 0.42,
    ...overrides,
  };
}

describe("history-analytics", () => {
  test("signingLatencyFilter: measured keeps only finite positive latencies", () => {
    const rows = [
      { signingLatencyMs: 0.85 },
      { signingLatencyMs: undefined },
      {},
      { signingLatencyMs: NaN },
      { signingLatencyMs: 0 },
      { signingLatencyMs: -1 },
    ];
    expect(rows.filter(signingLatencyFilter("measured")).length).toBe(1);
  });

  test("signingLatencyFilter: unmeasured is the exact complement", () => {
    const rows: Array<{ signingLatencyMs?: number }> = [
      { signingLatencyMs: 0.85 },
      { signingLatencyMs: undefined },
      {},
      { signingLatencyMs: NaN },
      { signingLatencyMs: 0 },
      { signingLatencyMs: -1 },
    ];
    const measured = rows.filter(signingLatencyFilter("measured"));
    const unmeasured = rows.filter(signingLatencyFilter("unmeasured"));
    expect(measured.length + unmeasured.length).toBe(rows.length);
    expect(unmeasured.length).toBe(5);
  });

  test("signingLatencyFilter: all passes everything through", () => {
    const rows: Array<{ signingLatencyMs?: number }> = [
      { signingLatencyMs: 1 },
      { signingLatencyMs: undefined },
      {},
    ];
    expect(rows.filter(signingLatencyFilter("all")).length).toBe(3);
  });

  test("signLatencyStats: aggregates measured rows only", () => {
    const s = signLatencyStats([
      { signingLatencyMs: 0.85 },
      { signingLatencyMs: 0.95 },
      { signingLatencyMs: undefined },
      { signingLatencyMs: NaN },
      { signingLatencyMs: 0 },
    ]);
    expect(s.count).toBe(2);
    expect(s.avg).toBeCloseTo(0.9, 5);
    expect(s.min).toBeCloseTo(0.85, 5);
    expect(s.max).toBeCloseTo(0.95, 5);
  });

  test("signLatencyStats: empty / all-unmeasured → count 0, undefined stats", () => {
    const s = signLatencyStats([
      {},
      { signingLatencyMs: undefined },
      { signingLatencyMs: NaN },
    ]);
    expect(s.count).toBe(0);
    expect(s.avg).toBeUndefined();
    expect(s.min).toBeUndefined();
    expect(s.max).toBeUndefined();
  });

  test("timestampForCsv: ISO-8601 UTC with ms", () => {
    expect(timestampForCsv(T0)).toBe("2026-09-29T12:00:00.000Z");
  });

  test("buildHistoryCsv: header + measured row with raw ms and µs-precision human value", () => {
    const csv = buildHistoryCsv([
      row({ signingLatencyMs: 0.4213, lender: "venus", dexes: "PancakeSwap" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(3); // header + row + trailing CRLF
    expect(lines[0]).toContain("sign_latency_ms,sign_latency");
    expect(lines[1]).toContain(",0.4213,");
    expect(lines[1]).toContain("sign ≈421µs");
    expect(lines[1].startsWith("2026-09-29T12:00:00.000Z,")).toBe(true);
  });

  test("buildHistoryCsv: unmeasured row → empty latency cells, never 0", () => {
    const csv = buildHistoryCsv([row({})]);
    const cells = csv.split("\r\n")[1]!.split(",");
    const msIdx = 9; // sign_latency_ms
    expect(cells[msIdx]).toBe("");
    expect(csv).not.toContain("sign ≈0µs");
  });

  test("buildHistoryCsv: millisecond-range latency renders as ms", () => {
    const csv = buildHistoryCsv([row({ signingLatencyMs: 12.567 })]);
    expect(csv).toContain(",12.567,");
    expect(csv).toContain("sign 12.6ms");
  });

  test("buildHistoryCsv: quotes and commas in labels are escaped Excel-safely", () => {
    const csv = buildHistoryCsv([
      row({ label: 'Route "hot", BNB→USDT' }),
    ]);
    expect(csv).toContain('"Route ""hot"", BNB→USDT"');
  });
});
