/**
 * RelayLatencyChart — full latency trend for every registered private relay
 * of the selected chain/network, plotted from the persistent probe history
 * (relay-history.ts ring buffer, recorded by the RelayStatusCard).
 *
 * One line per relay: healthy probes are latency points, probe failures
 * appear as gaps (the tooltip reports the recorded error). Purely read-only
 * — renders whatever samples exist and says honestly when there are none.
 */
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { privateRpcSet } from "@/lib/private-rpc";
import { getProbeHistory } from "@/lib/relay-history";
import type { NetworkKey } from "@/lib/chains";
import { networkInfoFor } from "@/lib/chains";

/** Line colors per relay index (theme-adjacent, distinguishable). */
const LINE_COLORS = ["#38bdf8", "#34d399", "#f59e0b", "#a78bfa"];

/** Selectable chart windows. `all` renders the whole ring buffer. */
type TimeRange = "15m" | "30m" | "1h" | "24h" | "all";

/** Selected window persists across reloads (per browser, like probe history). */
const RANGE_STORAGE_KEY = "flashbolt.relayChartRange";

function loadStoredRange(): TimeRange {
  try {
    const stored = localStorage.getItem(RANGE_STORAGE_KEY);
    if (stored === "15m" || stored === "30m" || stored === "1h" || stored === "24h" || stored === "all") {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode) — fall back to the default.
  }
  return "1h";
}

const TIME_RANGES: Array<{ key: TimeRange; label: string; ms: number | null }> = [
  { key: "15m", label: "15m", ms: 15 * 60_000 },
  { key: "30m", label: "30m", ms: 30 * 60_000 },
  { key: "1h", label: "1h", ms: 60 * 60_000 },
  { key: "24h", label: "24h", ms: 24 * 60 * 60_000 },
  { key: "all", label: "All", ms: null },
];

/** X-axis label format by window span: sub-hour shows time only. */
function tickLabel(t: number, range: TimeRange): string {
  if (range === "24h" || range === "all") {
    return new Date(t).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface RelayLatencyChartProps {
  chainId: number;
  network: NetworkKey;
  /** Bumped by parents after a fresh probe round so the chart re-reads history. */
  refreshKey?: number;
}

export function RelayLatencyChart({ chainId, network, refreshKey = 0 }: RelayLatencyChartProps) {
  const relays = privateRpcSet(chainId, network);
  const [range, setRange] = useState<TimeRange>(loadStoredRange);

  const selectRange = (key: TimeRange) => {
    setRange(key);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, key);
    } catch {
      // Storage unavailable — the in-session selection still applies.
    }
  };

  const series = useMemo(() => {
    // Window cutoff — `all` keeps the entire ring buffer.
    const cutoff =
      TIME_RANGES.find((r) => r.key === range)?.ms ?? null;
    const cutoffMs = cutoff !== null ? Date.now() - cutoff : null;

    // Merge every relay's samples onto one shared time axis: collect all
    // timestamps, then read each relay's latency at (or just before) each
    // tick so lines align for comparison. A relay without a sample near a
    // tick gets null → a visible gap, never a fabricated value.
    const allTimes = new Set<number>();
    const perRelay = relays.map((endpoint) => {
      const samples = getProbeHistory(endpoint).filter(
        (s) => cutoffMs === null || s.t >= cutoffMs,
      );
      for (const s of samples) allTimes.add(s.t);
      return { endpoint, samples };
    });
    const times = [...allTimes].sort((a, b) => a - b).slice(-40);
    const rows = times.map((t) => {
      const row: Record<string, number | null | string> = { t };
      for (const { endpoint, samples } of perRelay) {
        // Nearest sample at or before this tick — anything older is a real
        // gap (relay down or outside the window).
        let best: { t: number; latencyMs: number; ok: boolean; error?: string } | null = null;
        for (const s of samples) {
          if (s.t <= t && (!best || s.t > best.t)) best = s;
        }
        row.label = tickLabel(t, range);
        row[endpoint] = best && best.ok ? Math.round(best.latencyMs * 10) / 10 : null;
        if (best && !best.ok) row[`${endpoint}__err`] = best.error ?? "down";
      }
      return row;
    });
    // Per-relay aggregates over the SAME window the chart plots — this is
    // what the ranking card ranks by. Unprobed relays (no samples) sort last
    // and are surfaced as "no probes yet", never fabricated as fast.
    const ranking = perRelay.map(({ endpoint, samples }) => {
      const ok = samples.filter((s) => s.ok);
      const avg =
        ok.length > 0
          ? ok.reduce((sum, s) => sum + s.latencyMs, 0) / ok.length
          : Number.POSITIVE_INFINITY;
      return {
        endpoint,
        avgMs: avg,
        probes: samples.length,
        okProbes: ok.length,
        uptimePct: samples.length > 0 ? Math.round((ok.length / samples.length) * 100) : 0,
      };
    });
    ranking.sort((a, b) => a.avgMs - b.avgMs);
    return { rows, relays: perRelay.map((r) => r.endpoint), ranking };
    // refreshKey re-reads history after probe rounds; relays rarely change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, network, refreshKey, range]);

  if (relays.length === 0) return null;

  const hasSamples = series.rows.length > 0;

  return (
    <Card className="border-border/70 bg-card/40 shadow-none">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-sky-500/12 text-sky-400">
              <Activity className="size-4" />
            </div>
            <CardTitle className="text-sm font-semibold">
              Relay latency trend
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {series.relays.map((endpoint, i) => (
              <Badge
                key={endpoint}
                variant="outline"
                className="gap-1.5 font-mono text-[10px]"
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: LINE_COLORS[i % LINE_COLORS.length] }}
                />
                {endpoint.replace(/^https:\/\//, "").split("/")[0]}
              </Badge>
            ))}
            <div className="flex rounded-full border border-border/70 bg-background/50 p-0.5">
              {TIME_RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => selectRange(r.key)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors",
                    range === r.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
          eth_chainId round-trips recorded by the status card (persistent per
          browser). Gaps mean the relay failed that probe — hover for the error.
        </p>
        {hasSamples ? (
          <>
            {/* Ranking card — broadcast priority, ranked by measured avg
                latency over the selected window. */}
            <div className="mb-3 space-y-1.5">
              {series.ranking.map((r, i) => {
                const unprobed = r.probes === 0;
                const unhealthy = !unprobed && r.okProbes === 0;
                const isPrimary = i === 0 && !unprobed && !unhealthy;
                return (
                  <div
                    key={r.endpoint}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isPrimary && (
                        <Trophy className="size-3.5 shrink-0 text-amber-400" />
                      )}
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background:
                            LINE_COLORS[series.relays.indexOf(r.endpoint) % LINE_COLORS.length],
                        }}
                      />
                      <span className="truncate font-mono text-[11px] text-foreground/90">
                        {r.endpoint.replace(/^https:\/\//, "").split("/")[0]}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        #{i + 1}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {unprobed ? (
                        <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                          no probes yet
                        </Badge>
                      ) : unhealthy ? (
                        <Badge className="border-red-500/30 bg-red-500/10 px-1.5 py-0 text-[9px] text-red-400">
                          0% uptime
                        </Badge>
                      ) : (
                        <>
                          {isPrimary && (
                            <Badge className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[9px] text-emerald-400">
                              fastest
                            </Badge>
                          )}
                          <Badge className="border-sky-500/25 bg-sky-500/10 px-1.5 py-0 text-[9px] text-sky-400">
                            used first
                          </Badge>
                        </>
                      )}
                      <span className="w-14 text-right font-mono text-[11px] font-semibold text-foreground/90">
                        {Number.isFinite(r.avgMs) ? `${r.avgMs.toFixed(0)} ms` : "—"}
                      </span>
                      <span className="w-12 text-right font-mono text-[10px] text-muted-foreground">
                        {r.probes > 0 ? `${r.uptimePct}% up` : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
              <p className="text-[10px] leading-4 text-muted-foreground">
                Ranked by average latency over the selected window — matches
                the order the broadcast hot path uses (fastest first).
              </p>
            </div>
            <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series.rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={48}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}ms`}
                  width={52}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--muted-foreground)" }}
                  formatter={(value, name) => {
                    if (typeof value !== "number") return [value, String(name)];
                    return [`${value.toFixed(0)} ms`, String(name).replace(/^https:\/\//, "").split("/")[0]];
                  }}
                />
                {series.relays.map((endpoint, i) => (
                  <Line
                    key={endpoint}
                    type="monotone"
                    dataKey={endpoint}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 2.5, strokeWidth: 0, fill: LINE_COLORS[i % LINE_COLORS.length] }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          </>
        ) : (
          <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border/60 text-xs text-muted-foreground">
            No probe samples yet — open the relay status card and run a probe,
            then samples appear here.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
