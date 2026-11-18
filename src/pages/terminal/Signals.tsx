import { SignalExplainer } from "@/components/SignalExplainer";
import { useLocation } from "react-router";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useAction, useQuery } from "convex/react";
import {
  Activity,
  CheckCircle2,
  Clock,
  Gauge,
  Network,
  Radio,
  Satellite,
  Send,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

function fmtUsd(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtAgo(ts: number | undefined): string {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  return new Date(ts).toLocaleString();
}

function fmtCountdown(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function ratingColor(rating: string | undefined): string {
  switch (rating) {
    case "Hot":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
    case "Active":
      return "border-sky-500/30 bg-sky-500/10 text-sky-400";
    case "Cool":
      return "border-amber-500/30 bg-amber-500/10 text-amber-400";
    default:
      return "border-border/60 bg-muted/40 text-muted-foreground";
  }
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-semibold text-foreground">{value}</span>
    </div>
  );
}

export default function Signals() {
  const location = useLocation();
  // The route is mounted under both terminals — narrate the end the operator
  // is actually on (each terminal's execution path to Telegram differs).
  const chainVariant: "bnb" | "sol" = location.pathname.startsWith("/sol-")
    ? "sol"
    : "bnb";
  const dashboard = useQuery(api.signals.getSignalDashboard);
  const isOperator = useQuery(api.gate.isOperatorUser);
  const fireSignal = useAction(api.signals.fireSessionSignal);
  const [sending, setSending] = useState(false);
  const [tick, setTick] = useState(Date.now());

  // Live countdown to the next session change.
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const session = dashboard?.session;
  const latest = dashboard?.latest;
  const history = dashboard?.history ?? [];
  const canSend = isOperator?.isOperator === true;

  const nextChangeMs = session ? Math.max(0, session.nextChangeAt - tick) : 0;

  const scoreBar = useMemo(() => {
    if (!latest) return 0;
    return Math.max(0, Math.min(100, latest.score));
  }, [latest]);

  const rating = latest
    ? latest.score >= 75
      ? "Hot"
      : latest.score >= 50
        ? "Active"
        : latest.score >= 25
          ? "Cool"
          : "Quiet"
    : "—";

  const handleSend = async () => {
    if (sending) return;
    setSending(true);
    try {
      const res = await fireSignal();
      toast(
        res.delivered
          ? `Signal delivered — ${res.session} · score ${res.score}/100 (${res.rating})`
          : `Signal computed but NOT delivered — ${res.session}`,
        {
          description: res.deliveryNote,
        },
      );
    } catch (error) {
      toast.error("Could not send signal", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Real-time signals
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
            Signals
          </h1>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            Live market-session dashboards delivered to the Telegram channel every 15
            minutes — session updates, core network, AI market score and operating
            metrics, all computed from real live data.
          </p>
        </div>
        {canSend && (
          <Button type="button" onClick={handleSend} disabled={sending} className="gap-2">
            <Send className="size-4" />
            {sending ? "Computing live signal…" : "Send signal now"}
          </Button>
        )}
      </header>

      {/* Short narrated explainer — same TTS + cache pipeline as the gate video,
          narrating THIS terminal's path to Telegram (SOL end differs from BNB) */}
      <SignalExplainer variant={chainVariant} />

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      {/* Market session update */}
      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Satellite className="size-4" />
            </div>
            <CardTitle className="text-sm font-semibold">Market session update</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {!session ? (
            <p className="py-8 text-center text-xs text-muted-foreground">Loading session clock…</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {session.sessions.map((s) => {
                  const isPrimary = session.primary?.key === s.key;
                  return (
                    <div
                      key={s.key}
                      className={cn(
                        "rounded-xl border px-4 py-3 transition-colors",
                        s.isOpen
                          ? "border-primary/30 bg-primary/8"
                          : "border-border/50 bg-background/30",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm font-bold text-foreground">
                          <span>{s.flag}</span>
                          {s.label}
                        </span>
                        <Badge
                          className={cn(
                            s.isOpen
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : "border-border/60 bg-muted/40 text-muted-foreground",
                          )}
                        >
                          {s.isOpen ? "OPEN" : "CLOSED"}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {s.windowLabel}
                      </p>
                      {isPrimary && (
                        <p className="mt-1.5 text-[11px] font-semibold text-primary">
                          Primary session — highest liquidity
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/50 bg-background/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex size-2.5 shrink-0">
                    <span
                      className={cn(
                        "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                        session.primary ? "bg-emerald-400" : "bg-muted-foreground",
                      )}
                    />
                    <span
                      className={cn(
                        "relative inline-flex size-2.5 rounded-full",
                        session.primary ? "bg-emerald-400" : "bg-muted-foreground",
                      )}
                    />
                  </span>
                  <p className="text-xs font-medium text-foreground">{session.regime}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="size-3.5 text-primary" />
                  {session.nextChangeFlag} {session.nextChangeLabel}{" "}
                  {session.nextChangeKind === "open" ? "opens" : "closes"} in{" "}
                  <span className="font-mono font-bold text-foreground">
                    {fmtCountdown(nextChangeMs)}
                  </span>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Sessions follow the standard UTC windows (Sydney 21:00–06:00, Tokyo 00:00–09:00,
                London 07:00–16:00, New York 12:00–21:00). Signals fire on every tick of the
                current window and call out the highest-liquidity overlap regimes.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* AI market score */}
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Gauge className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">AI market score</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {!latest ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No signal computed yet — the first one fires automatically within 15
                minutes{canSend ? " (or use Send signal now)" : ""}.
              </p>
            ) : (
              <>
                <div className="flex items-end gap-3">
                  <span className="text-5xl font-extrabold tracking-tight text-foreground">
                    {latest.score}
                  </span>
                  <Badge className={cn("mb-1.5", ratingColor(rating))}>{rating}</Badge>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${scoreBar}%` }}
                  />
                </div>
                <div className="mt-4 grid gap-2">
                  <StatRow label="Cross-DEX dispersion" value={`${latest.market.dispersionPct.toFixed(2)}%`} />
                  <StatRow label="Live routes found" value={String(latest.market.routeCount)} />
                  <StatRow label="Avg edge (top 8)" value={`+${latest.market.avgEdgePct.toFixed(2)}%`} />
                  <StatRow label="Liquidity depth" value={fmtUsd(latest.market.liquidityUsd)} />
                  <StatRow label="Volume 24h" value={fmtUsd(latest.market.volumeUsd)} />
                  <StatRow label="Core gas" value={`${latest.market.gasGwei.toFixed(1)} gwei`} />
                </div>
                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Radio className="size-3 shrink-0 text-primary" />
                  Computed from the live DexScreener feed + real RPC gas price — updated{" "}
                  {fmtAgo(latest.sentAt)}.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Core network */}
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Network className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">Core network</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {!latest ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Core network status appears after the first signal.
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <StatRow
                    label="Active chains"
                    value={
                      latest.metrics.chains.length > 0
                        ? latest.metrics.chains.join(", ").toUpperCase()
                        : "none yet"
                    }
                  />
                  <StatRow
                    label="Mainnet / testnet"
                    value={`${latest.metrics.networks.mainnet} / ${latest.metrics.networks.testnet}`}
                  />
                  <StatRow label="Active terminals" value={String(latest.metrics.activeTerminals)} />
                  <StatRow label="Bots running" value={String(latest.metrics.runningBots)} />
                  <StatRow label="Scans today" value={String(latest.metrics.scansToday)} />
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Network split and chain coverage are read from the persisted terminal
                  states at signal time — never simulated.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Operating metrics */}
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Activity className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">Operating metrics</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {!latest ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Fleet operating metrics appear after the first signal.
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <StatRow label="Executions today" value={String(latest.metrics.executionsToday)} />
                  <StatRow
                    label="Win rate today"
                    value={
                      latest.metrics.executionsToday > 0
                        ? `${Math.round((latest.metrics.successesToday / latest.metrics.executionsToday) * 100)}% (${latest.metrics.successesToday}/${latest.metrics.executionsToday})`
                        : "—"
                    }
                  />
                  <StatRow
                    label="Fleet PnL today"
                    value={`+${latest.metrics.lifetimePnl.toFixed(4)} BNB`}
                  />
                  <StatRow label="Open opportunities" value={String(latest.metrics.openOpportunities)} />
                  <StatRow label="Scans today" value={String(latest.metrics.scansToday)} />
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Fleet aggregates from the real execution trail and terminal states
                  (operator + subscribers) — the same numbers the channel receives.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Telegram signal feed */}
      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Send className="size-4" />
            </div>
            <CardTitle className="text-sm font-semibold">Telegram signal feed</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {history.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No signals delivered yet. The 15-minute schedule starts automatically; add{" "}
              <span className="font-mono">TELEGRAM_BOT_TOKEN</span> +{" "}
              <span className="font-mono">TELEGRAM_CHAT_ID</span> in Keys to enable delivery.
            </p>
          ) : (
            <ul className="space-y-2">
              {history.map((s) => (
                <li
                  key={s._id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        className={cn(
                          s.kind === "session_open"
                            ? "border-primary/25 bg-primary/10 text-primary"
                            : "border-border/60 bg-muted/40 text-muted-foreground",
                        )}
                      >
                        {s.kind === "session_open" ? "Session open" : "Session update"}
                      </Badge>
                      <span className="truncate text-xs font-semibold text-foreground/90">
                        {s.title}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground">
                      {s.body}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] text-muted-foreground">{fmtAgo(s.sentAt)}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-[11px] font-medium",
                        s.delivered ? "text-emerald-400" : "text-amber-400",
                      )}
                    >
                      {s.delivered ? (
                        <CheckCircle2 className="size-3" />
                      ) : (
                        <XCircle className="size-3" />
                      )}
                      {s.delivered ? "delivered" : s.deliveryNote ? "not delivered" : "not delivered"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
