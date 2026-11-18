/**
 * SOL Telecopier bot panel — Telegram signal copier under the SOL FlashBolt
 * terminal. Uses the SAME shared sources and backend pipeline as the BNB
 * Copier/Telecopier (t.me/AveSignalMonitor, t.me/BSCnewtokenspairs,
 * t.me/arbitjet_arbitrage + the two-venue listing channels), but converts
 * Solana signals (base58 mints) into cross-venue WSOL flash-loan routes via
 * buildSolTelecopierRoutes and hands them to the SOL Scanner's LIVE ROUTE
 * FEED for automatic arbitrage execution.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  claimPoll,
  coolDownPoll,
  copierPollTotalFailure,
  COPIER_POLL_KEY,
  COPIER_POLL_GAP_MS,
  COPIER_FAILURE_COOLDOWN_MS,
} from "@/lib/poller-gate";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Copy, Radio, RefreshCw, Route as RouteIcon, Zap } from "lucide-react";
import { toast } from "sonner";
import { COPIER_SOURCES } from "@/lib/copier-signals";
import {
  buildSolTelecopierRoutes,
  type SolTelecopierRoute,
  type SolTelecopierSignal,
} from "@/lib/solana-routes";
import { SOL_DEFAULT_WHITELIST, solLenderForRun } from "@/lib/solana";

/** Poll cadence while the SOL Telecopier is ON (ms) — same as the BNB bots. */
const POLL_MS = 30_000;

interface SolTelecopierBotPanelProps {
  /** Forward built routes into the SOL Scanner's LIVE ROUTE FEED. */
  onRoute: (route: SolTelecopierRoute) => void;
  /** Whitelisted venue keys (SOL_DEXES keys). */
  dexWhitelist: string[];
  /** Flash-loan lender for this scan run. */
  lender: string;
  /** Loan size in SOL for generated routes. */
  loanSizeSol: number;
  /** Scan run seed for route ids. */
  run: number;
}

export default function SolTelecopierBotPanel({
  onRoute,
  dexWhitelist,
  lender,
  loanSizeSol,
  run,
}: SolTelecopierBotPanelProps) {
  const [botOn, setBotOn] = useState(true);
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  // Auto Approve — ON by default: every copied Solana signal with a live
  // two-venue spread routes into LIVE ROUTE FEED and executes automatically.
  const [autoApprove, setAutoApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{
    fetched: number;
    parsed: number;
    stored: number;
    notes: string[];
  } | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [routes, setRoutes] = useState<SolTelecopierRoute[]>([]);

  // Reactive signal feed — the same shared copierSignals table every bot reads.
  const signals = useQuery(api.copierStore.listSignals, { limit: 60 }) as
    | SolTelecopierSignal[]
    | undefined;
  const poll = useAction(api.copier.pollChannels);
  const ingest = useMutation(api.copier.ingestManualSignals);

  const runPoll = useCallback(
    async (silent: boolean) => {
      if (busy) return;
      // COMPUTE GATE — silent interval ticks coalesce across every copier
      // panel in this tab through one shared gate; manual button runs
      // bypass. A total upstream failure (Telegram outage) stretches the
      // gate to a 5-minute cooldown so 30 s retries can't burn action
      // compute while the upstream is dead.
      if (silent && !claimPoll(COPIER_POLL_KEY, COPIER_POLL_GAP_MS)) return;
      setBusy(true);
      try {
        const result = await poll({});
        setLastRun(result);
        // Every channel errored and nothing was fetched — back off instead
        // of hammering a dead upstream on every 30 s tick.
        if (copierPollTotalFailure(result)) {
          coolDownPoll(COPIER_POLL_KEY, COPIER_FAILURE_COOLDOWN_MS);
        }
        if (!silent && result.notes.length > 0) {
          console.log("SOL Telecopier: " + result.notes.join("; "));
        }
      } catch (err) {
        // Transient transport failures (dev reloads, dropped WebSocket —
        // "Connection lost while action was in flight") must not surface as
        // unhandled rejections. The 30s loop retries after the outage
        // cooldown, not at full rate.
        coolDownPoll(COPIER_POLL_KEY, COPIER_FAILURE_COOLDOWN_MS);
        console.warn("SOL Telecopier: poll failed, retrying next cycle:", err instanceof Error ? err.message : err);
        if (!silent) {
          toast.error("SOL Telecopier poll failed — the next cycle retries automatically.");
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, poll],
  );

  // Poll loop while ON — every 30s, plus one immediate run when switched on.
  useEffect(() => {
    if (!botOn) return;
    void runPoll(true);
    const t = setInterval(() => void runPoll(true), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botOn]);

  // SIGNAL → ROUTE conversion: every fresh SOLANA signal gets priced across
  // the whitelisted Solana venues; real spreads become flash-loan routes.
  const convertedRef = useRef(new Set<string>());
  const convertingRef = useRef(false);
  useEffect(() => {
    if (!botOn || !signals || convertingRef.current) return;
    const fresh = signals.filter(
      (s) => !convertedRef.current.has(s.id) && s.chain === "solana" && s.buyable,
    );
    if (fresh.length === 0) return;
    convertingRef.current = true;
    void buildSolTelecopierRoutes(
      fresh,
      {
        dexWhitelist: dexWhitelist.length > 0 ? dexWhitelist : SOL_DEFAULT_WHITELIST,
        lender,
        loanSizeSol,
        run,
      },
      6,
    )
      .then((built) => {
        for (const s of fresh) convertedRef.current.add(s.id);
        if (convertedRef.current.size > 500) {
          const arr = [...convertedRef.current];
          convertedRef.current = new Set(arr.slice(-200));
        }
        if (built.length === 0) return;
        setRoutes((prev) => [...built, ...prev].slice(0, 20));
        if (botOn && autoApprove && mode === "auto") {
          for (const r of built) onRoute(r);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        convertingRef.current = false;
      });
  }, [botOn, signals, dexWhitelist, lender, loanSizeSol, run, autoApprove, mode, onRoute]);

  const manualPaste = async () => {
    if (!manualUrl.trim()) return;
    setBusy(true);
    try {
      const res = await ingest({ raw: manualUrl.trim() });
      setLastRun(res);
      setManualUrl("");
    } catch (err) {
      console.warn("SOL Telecopier: manual paste failed:", err instanceof Error ? err.message : err);
      toast.error("Couldn't ingest that paste — check the URL and try again.");
    } finally {
      setBusy(false);
    }
  };

  const liveCount = (signals ?? []).filter((s) => s.buyable && s.chain === "solana").length;
  const autoLive = botOn && autoApprove && mode === "auto";

  const statusLine = !botOn
    ? "SOL Telecopier OFF — channels not polled."
    : mode === "auto"
      ? autoApprove
        ? "AUTO — every copied Solana signal with a live two-venue spread routes into LIVE ROUTE FEED and executes, fitted to your wallet's real balance (an oversized clip shrinks to what the wallet can front; min 0.05 SOL)."
        : "Auto Approve OFF — routes paste into the feed for manual Execute."
      : "MANUAL — routes paste into LIVE ROUTE FEED; click Execute to flash.";

  return (
    <Card className="border-border/70 bg-card/40">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Copy className="size-4 text-primary" />
            Telecopier — Telegram Signal Copier
            <span
              className={
                "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold " +
                (!botOn ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-500")
              }
            >
              <span className={"size-1.5 rounded-full " + (botOn ? "animate-pulse bg-emerald-500" : "bg-muted-foreground")} />
              {botOn ? "ACTIVE" : "OFF"}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {liveCount} SOL signals
            </Badge>
            <Badge className="border-primary/25 bg-primary/10 text-primary text-[10px]">
              {routes.length} routes
            </Badge>
            <Button
              variant={botOn ? "default" : "outline"}
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => setBotOn(!botOn)}
            >
              <Zap className="size-3" />
              {botOn ? "ON" : "OFF"}
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Copies Solana token signals from {COPIER_SOURCES.map((s) => s.label).join(" + ")}, prices each mint's
          real cross-venue spread on live DexScreener data (Raydium · Orca · Meteora · PumpSwap) and injects
          WSOL flash-loan routes into LIVE ROUTE FEED for automatic arbitrage execution.
        </p>
        <p className={cnStatus(autoLive)}>
          {autoLive ? "⚡ " : "○ "}{statusLine}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={mode === "auto" ? "default" : "outline"}
            size="sm"
            className="h-7 text-[10px]"
            onClick={() => setMode(mode === "auto" ? "manual" : "auto")}
          >
            <Radio className="size-3" />
            Mode: {mode === "auto" ? "AUTO" : "MANUAL"}
          </Button>
          <label className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            <Switch checked={autoApprove} onCheckedChange={setAutoApprove} className="scale-90" />
            Auto Approve
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[10px]"
            disabled={busy}
            onClick={() => void runPoll(false)}
          >
            <RefreshCw className={"size-3" + (busy ? " animate-spin" : "")} />
            Poll now
          </Button>
          {lastRun && (
            <span className="text-[10px] text-muted-foreground">
              last poll: {lastRun.fetched} msgs → {lastRun.parsed} signals → {lastRun.stored} new
            </span>
          )}
        </div>

        {/* Manual paste — works for preview-disabled channels too */}
        <div className="flex items-center gap-2">
          <Input
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="Paste a t.me post URL or raw Solana signal text…"
            className="h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[10px]"
            disabled={busy || !manualUrl.trim()}
            onClick={() => void manualPaste()}
          >
            Paste
          </Button>
        </div>

        {/* Built routes */}
        {routes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-[11px] text-muted-foreground">
            {botOn
              ? "Waiting for the next channel poll — Solana signals with a live two-venue spread appear here as WSOL flash-loan routes."
              : "Switch the SOL Telecopier ON to start copying channels."}
          </p>
        ) : (
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/50">
            {routes.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px] text-foreground/90">
                    {r.legs.join(" → ")}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <RouteIcon className="size-3 text-primary" />
                    {r.signalSource} · venue spread +{r.venueSpreadPct.toFixed(2)}% · liq ${Math.round(r.liquidityUsd / 1000)}k
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={"font-mono text-sm font-bold " + (r.profitPct > 0 ? "text-emerald-400" : "text-red-400")}>
                    {r.profitPct > 0 ? "+" : ""}{r.profitPct.toFixed(2)}%
                  </div>
                  <div className="text-[10px] text-muted-foreground">net after fees</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function cnStatus(autoLive: boolean): string {
  return "text-[11px] font-medium " + (autoLive ? "text-emerald-500" : "text-muted-foreground");
}
