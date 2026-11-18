import { useQuery } from "convex/react";
import { ShieldAlert } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { HONEY_POT_MIN_LIQUIDITY_USD, HONEY_POT_MIN_PROFIT_PCT } from "@/lib/flashbolt";
import { cn } from "@/lib/utils";

function formatAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * Honey-pot guard — the scanner's real honey-pot filter, surfaced on the
 * terminal for operator and subscriber alike. Honey pots are live routes
 * that clear the documented thresholds (≥0.5% net edge AND ≥$250k
 * liquidity); they are flagged so they can be executed separately from the
 * ordinary rotation. The amber styling marks the guard state: armed (green)
 * when the filter is on, amber warnings for every real detection from the
 * persisted scanner trail. Nothing here is simulated.
 */
export function HoneyPotGuard({ className }: { className?: string }) {
  const ctx = useQuery(api.signals.getTerminalContext);
  const terminalCfg = useQuery(api.terminalConfig.getTerminalConfig);
  const honeyProfitPct = terminalCfg?.honeyMinProfitPct ?? HONEY_POT_MIN_PROFIT_PCT;
  const honeyLiquidityUsd =
    terminalCfg?.honeyMinLiquidityUsd ?? HONEY_POT_MIN_LIQUIDITY_USD;

  if (ctx === undefined) {
    return (
      <div className={cn("rounded-2xl border border-border/70 bg-card/40 px-5 py-4", className)}>
        <div className="h-4 w-44 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 h-14 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }
  if (ctx === null) return null;

  const spots = ctx.honeyPots;

  return (
    <div className={cn("rounded-2xl border border-border/70 bg-card/40 px-5 py-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
            <ShieldAlert className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              Honey-pot guard
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
                Armed
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              real scanner filter · ≥{honeyProfitPct}% net edge and ≥$
              {(honeyLiquidityUsd / 1000).toFixed(0)}k liquidity — operator-tuned
            </p>
          </div>
        </div>
        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-400">
          {spots.length === 0
            ? "No honey pots in your recent scan trail"
            : `${spots.length} recent honey pot${spots.length > 1 ? "s" : ""}`}
        </span>
      </div>

      {spots.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {spots.map((spot, i) => (
            <li
              key={`${spot.ts}-${i}`}
              className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3.5 py-2.5"
            >
              <span className="mt-0.5 size-2 shrink-0 rounded-full bg-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-foreground">
                  {spot.title}
                </div>
                {spot.body && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {spot.body}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatAgo(spot.ts)}
                {spot.chainKey ? ` · ${spot.chainKey}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5 text-[11px] leading-4 text-muted-foreground">
          The scanner watches the live multi-DEX feed for routes clearing the
          honey-pot thresholds. When one is found it is flagged here and in
          the notification bell — real detections only, straight from the
          persisted scanner trail.
        </p>
      )}
    </div>
  );
}
