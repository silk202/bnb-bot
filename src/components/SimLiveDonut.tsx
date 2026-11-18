// Live vs SIM split donut — pure SVG, no chart dependency.
//
// Honest by construction: the split is computed from the execution ledger's
// real classification (live = broadcast on-chain, SIM = paper). With no data
// it renders a neutral ring — it never invents a share.

import { cn } from "@/lib/utils";

export function SimLiveDonut({
  live,
  sim,
  size = 76,
  className,
}: {
  live: number;
  sim: number;
  size?: number;
  className?: string;
}) {
  const total = live + sim;
  const R = 15.9; // 42-unit viewBox → circumference ≈ 100 (easy math)
  const C = 2 * Math.PI * R;
  const livePct = total > 0 ? live / total : 0;
  // Emerald arc = live share; amber arc = the rest (SIM). When total is 0
  // both arcs collapse and only the neutral track shows.
  const liveDash = livePct * C;

  const centerLabel = total > 0 ? `${Math.round(livePct * 100)}%` : "—";
  const centerSub = total > 0 ? "on-chain" : "no data";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 42 42" className="size-full -rotate-90">
          <circle
            cx="21"
            cy="21"
            r={R}
            fill="none"
            strokeWidth="5"
            className="stroke-border/60"
          />
          {sim > 0 && (
            <circle
              cx="21"
              cy="21"
              r={R}
              fill="none"
              strokeWidth="5"
              strokeLinecap="butt"
              className="stroke-amber-400"
              strokeDasharray={`${C} ${C}`}
              strokeDashoffset={-liveDash}
            />
          )}
          {live > 0 && (
            <circle
              cx="21"
              cy="21"
              r={R}
              fill="none"
              strokeWidth="5"
              strokeLinecap="butt"
              className="stroke-emerald-400"
              strokeDasharray={`${liveDash} ${C}`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-extrabold leading-none tabular-nums">
            {centerLabel}
          </span>
          <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
            {centerSub}
          </span>
        </div>
      </div>
      <div className="min-w-0 space-y-1 text-[11px] leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
          <span className="font-semibold tabular-nums">⛓ {live} live</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full bg-amber-400" />
          <span className="font-semibold tabular-nums">🧪 {sim} SIM</span>
        </div>
        <div className="text-[10px] text-muted-foreground">
          {total} execution{total === 1 ? "" : "s"} total
        </div>
      </div>
    </div>
  );
}

/**
 * Split bar — the web twin of the bot's ▓/░ /pnl bar: emerald fill = live
 * on-chain share, muted track = SIM paper. Honest zero state: an empty track
 * labeled "no executions yet" — it never invents a share.
 */
export function SplitBar({ live, sim }: { live: number; sim: number }) {
  const total = live + sim;
  const pct = total > 0 ? Math.round((live / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        {live > 0 && (
          <div
            className="h-full rounded-full bg-emerald-400"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
        {total > 0
          ? `${pct}% ⛓ on-chain · ${live} live / ${sim} 🧪 SIM`
          : "no executions yet"}
      </div>
    </div>
  );
}
