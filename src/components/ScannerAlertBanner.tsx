/**
 * ScannerAlertBanner — real-time automated status indicators for all
 * scanner processes and flash-loan events. Auto-updates with timers
 * and triggers sound notifications on state changes.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Loader2,
  Radio,
  Shield,
  Zap,
  XCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface ScannerEvent {
  id: string;
  ts: number;
  kind:
    | "scan_tick"
    | "arb_detected"
    | "flash_submitted"
    | "flash_confirmed"
    | "flash_failed"
    | "token_discovered"
    | "mev_blocked"
    | "profit_guard_blocked"
    | "guarantor_pass"
    | "cross_chain_spread"
    | "error";
  label: string;
  details?: string;
  symbol?: string;
  spreadPct?: number;
  method?: string;
  lender?: string;
  txHash?: string;
}

interface ScannerAlertBannerProps {
  events: ScannerEvent[];
  /** Whether the scanner bot is running. */
  running?: boolean;
  /** Current scan cadence in seconds. */
  cadence?: number;
  /** Timestamp of last scan. */
  lastScanAt?: number;
  /** Gas price in gwei. */
  gasPriceGwei?: number | null;
  /** Active flash-loan lender. */
  lender?: string;
  /** Mempool pending swap count. */
  mempoolCount?: number;
  /** Mempool last poll timestamp. */
  mempoolLastPoll?: number | null;
  /** Mempool error state. */
  mempoolError?: string | null;
}

function formatAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function eventIcon(kind: ScannerEvent["kind"]) {
  switch (kind) {
    case "scan_tick":
      return <Radio className="size-3.5 text-primary animate-pulse" />;
    case "arb_detected":
      return <ArrowRightLeft className="size-3.5 text-emerald-400" />;
    case "flash_submitted":
      return <Loader2 className="size-3.5 text-blue-400 animate-spin" />;
    case "flash_confirmed":
      return <CheckCircle2 className="size-3.5 text-emerald-400" />;
    case "flash_failed":
      return <XCircle className="size-3.5 text-red-400" />;
    case "token_discovered":
      return <Zap className="size-3.5 text-violet-400" />;
    case "cross_chain_spread":
      return <ArrowRightLeft className="size-3.5 text-cyan-400" />;
    case "mev_blocked":
      return <Shield className="size-3.5 text-amber-400" />;
    case "profit_guard_blocked":
      return <AlertTriangle className="size-3.5 text-amber-400" />;
    case "guarantor_pass":
      return <ShieldCheck className="size-3.5 text-emerald-400" />;
    case "error":
      return <XCircle className="size-3.5 text-red-400" />;
  }
}

function eventColor(kind: ScannerEvent["kind"]): string {
  switch (kind) {
    case "scan_tick":
      return "border-primary/25 bg-primary/8";
    case "arb_detected":
      return "border-emerald-500/25 bg-emerald-500/8";
    case "flash_submitted":
      return "border-blue-500/25 bg-blue-500/8";
    case "flash_confirmed":
    case "guarantor_pass":
      return "border-emerald-500/25 bg-emerald-500/10";
    case "flash_failed":
      return "border-red-500/25 bg-red-500/8";
    case "token_discovered":
      return "border-violet-500/25 bg-violet-500/8";
    case "cross_chain_spread":
      return "border-cyan-500/25 bg-cyan-500/8";
    case "mev_blocked":
    case "profit_guard_blocked":
      return "border-amber-500/25 bg-amber-500/8";
    case "error":
      return "border-red-500/25 bg-red-500/8";
  }
}

export function ScannerAlertBanner({
  events,
  running = true,
  cadence = 15,
  lastScanAt,
  gasPriceGwei,
  lender,
  mempoolCount = 0,
  mempoolLastPoll,
  mempoolError,
}: ScannerAlertBannerProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const recentEvents = useMemo(
    () =>
      events
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 12),
    [events],
  );

  const activeCount = useMemo(() => {
    let count = 0;
    // Flash-loan submitted = active
    if (recentEvents.some((e) => e.kind === "flash_submitted")) count++;
    // Arb detected in last 30s = active
    if (recentEvents.some((e) => e.kind === "arb_detected" && now - e.ts < 30000)) count++;
    return count;
  }, [recentEvents, now]);

  const nextScanIn = lastScanAt
    ? Math.max(0, cadence - Math.floor((now - lastScanAt) / 1000))
    : cadence;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      {/* Header bar with live status */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="relative flex size-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                running ? "bg-emerald-400" : "bg-muted-foreground",
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                running ? "bg-emerald-400" : "bg-muted-foreground",
              )}
            />
          </span>
          SCANNER & FLASH-LOAN STATUS
          {activeCount > 0 && (
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400 animate-pulse">
              {activeCount} active
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" />
            next scan {nextScanIn}s
          </span>
          {gasPriceGwei !== null && gasPriceGwei !== undefined && (
            <span className="font-mono">
              gas {gasPriceGwei.toFixed(2)} gwei
            </span>
          )}
          {lender && (
            <Badge variant="outline" className="border-border/50 text-[10px]">
              lender {lender}
            </Badge>
          )}
          {mempoolCount > 0 && (
            <Badge className="border-violet-500/25 bg-violet-500/10 text-violet-400 text-[10px]">
              🔄 {mempoolCount} mempool swaps
            </Badge>
          )}
          {mempoolError && (
            <Badge className="border-amber-500/25 bg-amber-500/10 text-amber-400 text-[10px]">
              ⚠ mempool offline
            </Badge>
          )}
        </div>
      </div>

      {/* Live event feed */}
      {recentEvents.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Activity className="size-3.5 animate-pulse text-primary" />
          Scanner initialising — events will appear here in real-time...
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {recentEvents.map((event) => (
            <div
              key={event.id}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-all",
                eventColor(event.kind),
              )}
            >
              {eventIcon(event.kind)}
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {event.label}
                {event.symbol && (
                  <span className="ml-1 font-mono font-semibold text-foreground">
                    {event.symbol}
                  </span>
                )}
                {event.spreadPct !== undefined && (
                  <span className="ml-1 font-mono text-emerald-400 font-semibold">
                    +{event.spreadPct.toFixed(2)}%
                  </span>
                )}
                {event.method && (
                  <Badge className="ml-1 border-border/50 text-[9px] px-1">
                    {event.method}
                  </Badge>
                )}
                {event.lender && (
                  <span className="ml-1 text-muted-foreground">
                    via {event.lender}
                  </span>
                )}
                {event.txHash && (
                  <span className="ml-1 font-mono text-muted-foreground/60">
                    {event.txHash.slice(0, 8)}…
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">
                {formatAgo(event.ts)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
