import { useAction, useQuery } from "convex/react";
import { Clock, FlaskConical, Newspaper, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/hooks/use-terminal";

/** GLOBAL "Live only" toggle — on = 🧪 SIM (paper) rows are hidden across
 * the terminal (activity feed + both histories). Persisted per browser. */
function LiveOnlyToggle() {
  const { liveOnly, setLiveOnly } = useTerminal();
  return (
    <button
      type="button"
      onClick={() => setLiveOnly(!liveOnly)}
      aria-pressed={liveOnly}
      title={
        liveOnly
          ? "Live only — 🧪 SIM (paper) rows are hidden. Click to show them."
          : "Showing ⛓ live + 🧪 SIM rows. Click to hide SIM."
      }
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] font-semibold transition-colors",
        liveOnly
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {liveOnly ? "⛓ Live only" : "⛓ Live + 🧪 SIM"}
      <FlaskConical className={"size-3" + (liveOnly ? " opacity-30" : " text-amber-400")} />
    </button>
  );
}

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function fmtPubDate(pubDate: string): string {
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) return "";
  const diff = Date.now() - parsed.getTime();
  if (diff >= 0 && diff < 3600_000) {
    return `${Math.max(1, Math.floor(diff / 60000))}m`;
  }
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
  return parsed.toLocaleDateString();
}

function TileTitle({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

/**
 * Compact market-context strip — sessions clock, honey-pot guard and real
 * market news in one row. The same real data as the full Overview panels
 * (same queries, deduped by Convex), sized for the Scanner and Signals
 * pages. Nothing is simulated: the sessions are live UTC clock math, the
 * honey-pot tile reads the persisted scanner trail and the news tile shows
 * real RSS headlines fetched server-side.
 */
export function TerminalContextStrip() {
  const ctx = useQuery(api.signals.getTerminalContext);
  const terminalCfg = useQuery(api.terminalConfig.getTerminalConfig);
  const loadNews = useAction(api.news.getMarketNews);
  const [news, setNews] = useState<{
    items: { source: string; title: string; link: string; pubDate: string }[];
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshNews = useCallback(async () => {
    try {
      const result = await loadNews();
      setNews({ items: result.items });
    } catch {
      // Keep whatever the cache already holds — the strip never blocks on news.
    }
  }, [loadNews]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    void refreshNews();
    return () => window.clearInterval(timer);
  }, [refreshNews]);

  const session = ctx?.session ?? null;
  const honeyPots = ctx?.honeyPots ?? [];
  const nextIn = session ? Math.max(0, session.nextChangeAt - now) : 0;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-bold text-foreground">Market context</div>
        <div className="flex items-center gap-3">
          {/* GLOBAL "Live only" toggle — hides 🧪 SIM rows in the activity
              feed and both histories; persisted per browser. */}
          <LiveOnlyToggle />
          <span className="font-mono text-[11px] text-muted-foreground">
            {new Date(now).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}{" "}
            UTC
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {/* Sessions tile */}
        <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <TileTitle icon={<Clock className="size-3 text-primary" />}>
            Sessions
          </TileTitle>
          {!session ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Loading session clock…
            </p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {session.sessions.map((s) => (
                  <span
                    key={s.key}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      s.isOpen
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                        : "border-border/60 bg-muted/40 text-muted-foreground",
                    )}
                    title={`${s.label} ${s.windowLabel} UTC`}
                  >
                    {s.flag} {s.label}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
                {session.primary ? (
                  <>
                    <span className="font-semibold text-foreground">
                      {session.primary.flag} {session.primary.label}
                    </span>{" "}
                    primary · {session.regime}
                  </>
                ) : (
                  "All sessions closed (06:00–07:00 UTC gap)"
                )}
              </div>
              <div className="mt-1 text-[11px] font-semibold text-amber-400">
                {session.nextChangeFlag} {session.nextChangeLabel}{" "}
                {session.nextChangeKind === "open" ? "opens" : "closes"} in{" "}
                {fmtDuration(nextIn)}
              </div>
            </>
          )}
        </div>

        {/* Honey-pot guard tile */}
        <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <TileTitle icon={<ShieldAlert className="size-3 text-amber-400" />}>
            Honey-pot guard
          </TileTitle>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
              Armed
            </span>
            <span className="text-[11px] text-muted-foreground">
              ≥{terminalCfg?.honeyMinProfitPct ?? 0.5}% edge · ≥$
              {((terminalCfg?.honeyMinLiquidityUsd ?? 250_000) / 1000).toFixed(0)}k
              liq
            </span>
          </div>
          {honeyPots.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {honeyPots.slice(0, 3).map((spot, i) => (
                <li
                  key={`${spot.ts}-${i}`}
                  className="flex items-start gap-1.5 text-[11px] leading-4 text-foreground/85"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" />
                  <span className="line-clamp-1">{spot.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No honey pots in your recent scan trail.
            </p>
          )}
        </div>

        {/* Market news tile */}
        <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <TileTitle icon={<Newspaper className="size-3 text-primary" />}>
            Market news
          </TileTitle>
          {news === null ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Loading real headlines…
            </p>
          ) : news.items.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No headlines right now — real feeds only.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {news.items.slice(0, 3).map((item, i) => (
                <li key={`${item.link}-${i}`}>
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    className="group block text-[11px] leading-4 text-foreground/85 hover:text-primary"
                  >
                    <span className="line-clamp-2">{item.title}</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {item.source}
                      {fmtPubDate(item.pubDate) ? ` · ${fmtPubDate(item.pubDate)} ago` : ""}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
