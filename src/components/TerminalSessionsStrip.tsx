import { useQuery } from "convex/react";
import { Clock, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Market sessions strip — the real Sydney / Tokyo / London / New York UTC
 * session clock, computed from the actual current time (same engine that
 * drives the Telegram signals). Shows which sessions are open right now,
 * the primary (highest-liquidity) session, the overlap regime, and an amber
 * countdown to the next session change. Honest live clock math — nothing
 * simulated. Visible to operator and subscribers alike.
 */
export function TerminalSessionsStrip() {
  const ctx = useQuery(api.signals.getTerminalContext);
  const [now, setNow] = useState(() => Date.now());

  // Re-render the countdown every 30s so the strip stays live.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (ctx === undefined) {
    return (
      <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
        <div className="h-4 w-40 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 h-16 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }
  if (ctx === null) return null;

  const { session } = ctx;
  const nextIn = Math.max(0, session.nextChangeAt - now);
  const isClosed = session.openKeys.length === 0;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Clock className="size-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">
              Market sessions
            </div>
            <p className="text-[11px] text-muted-foreground">
              live UTC clock · {session.regime}
            </p>
          </div>
        </div>
        <Badge
          className={cn(
            "border-amber-500/30 bg-amber-500/10 text-amber-400",
            "font-mono text-[11px]",
          )}
        >
          <Timer className="mr-1 size-3" />
          {session.nextChangeFlag} {session.nextChangeLabel}{" "}
          {session.nextChangeKind === "open" ? "opens" : "closes"} in{" "}
          {fmtDuration(nextIn)}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {session.sessions.map((s) => {
          const isPrimary = session.primary?.key === s.key;
          return (
            <div
              key={s.key}
              className={cn(
                "rounded-xl border px-3.5 py-3 transition-colors",
                s.isOpen
                  ? "border-emerald-500/25 bg-emerald-500/5"
                  : "border-border/60 bg-background/40",
                isPrimary && "ring-1 ring-primary/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-foreground">
                  {s.flag} {s.label}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                    s.isOpen
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-muted/60 text-muted-foreground",
                  )}
                >
                  {s.isOpen ? "Open" : "Closed"}
                </span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                {s.windowLabel} UTC
              </div>
              {isPrimary && (
                <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                  Primary
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
        {isClosed
          ? "All sessions closed — the 06:00–07:00 UTC gap is the lowest-liquidity window."
          : session.openKeys.length > 1
            ? "Overlap regime active — multiple high-liquidity sessions are open simultaneously."
            : "Solo session active — liquidity is concentrated in one window."}{" "}
        Same real clock drives the Telegram session signals ({fmtClock(now)} UTC).
      </p>
    </div>
  );
}
