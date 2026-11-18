/**
 * Copier bot panel — Telegram signal copier under the Sniper terminal.
 *
 * Watches t.me/AveSignalMonitor and t.me/BSCnewtokenspairs (public web previews
 * when available, Telegram Bot API getUpdates fallback for preview-disabled
 * channels), parses profitable token signals server-side, and displays them
 * live. Signals are converted to the same LiveTokenSignal shape the
 * Multi-Signal Monitor uses, so the terminal (and the DEXView/GMGN/Ave
 * overlay's LIVE CANDIDATES) can execute them with zero extra wiring —
 * manual BUY or automatic execution per mode.
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
import { Copy, Radio, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import type { LiveTokenSignal } from "@/components/MultiSignalMonitor";
import { COPIER_SOURCES } from "@/lib/copier-signals";

/** Poll cadence while the copier is ON (ms). */
const POLL_MS = 30_000;

/** Convert a stored copier signal into the terminal's LiveTokenSignal shape. */
export function copierSignalToLive(
  s: {
    id: string;
    source: string;
    sourceLabel: string;
    address: string;
    symbol: string;
    name: string;
    chain: string;
    priceUsd: number;
    liquidityUsd: number;
    marketCapUsd: number;
    capturedAt: number;
    buyable: boolean;
  },
  now = Date.now(),
): LiveTokenSignal {
  const ageMin = Math.max(0, (now - s.capturedAt) / 60_000);
  return {
    id: s.id,
    symbol: s.symbol,
    name: s.name,
    address: s.address,
    chain: s.chain,
    priceUsd: s.priceUsd,
    priceChange1m: 0,
    priceChange5m: 0,
    priceChange1h: 0,
    volume1m: 0,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    liquidityUsd: s.liquidityUsd,
    marketCapUsd: s.marketCapUsd,
    buyCount: 0,
    sellCount: 0,
    buyVolume: 0,
    sellVolume: 0,
    holderCount: 0,
    pairAddress: "",
    dexId: "",
    dexName: "",
    sourceId: s.source,
    sourceLabel: s.sourceLabel,
    discoveredAt: s.capturedAt,
    isHoneypot: false,
    riskLevel: "medium",
    securityScore: 70,
    buyable: s.buyable,
    sellable: true,
    arbOpportunity: false,
    signalStrength: Math.max(35, Math.round(100 - ageMin * 2)),
    sources: ["copier:" + s.source],
  };
}

interface CopierBotPanelProps {
  /** Forward copied signals into the terminal's snipe executor. */
  onSignal: (token: LiveTokenSignal) => void;
  /** Whether the terminal's own snipe executor is available. */
  canExecute: boolean;
  /** /my_settings Auto Approve — ON (default) executes every new buyable
      signal automatically in auto mode and pre-clears manual ones. */
  autoApprove: boolean;
  /** Whether a signer exists (hot wallet generated or direct wallet imported) —
      required before any execution can fire. */
  walletReady: boolean;
}

export default function CopierBotPanel({ onSignal, canExecute, autoApprove, walletReady }: CopierBotPanelProps) {
  const [botOn, setBotOn] = useState(true);
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{ fetched: number; parsed: number; stored: number; notes: string[] } | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Reactive signal feed (live-updates from the backend table).
  const signals = useQuery(api.copierStore.listSignals, { limit: 60 });
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
        if (!silent) {
          if (result.stored > 0) {
            console.log(`Copier: +${result.stored} new signals from ${COPIER_SOURCES.map((s) => s.label).join(" + ")}`);
          } else if (result.notes.length > 0) {
            console.log("Copier: " + result.notes.join("; "));
          }
        }
      } catch (err) {
        // Transient transport failures (dev reloads, dropped WebSocket —
        // "Connection lost while action was in flight") must not surface as
        // unhandled rejections. The 30s loop simply retries on the next tick
        // — after the outage cooldown below, so a dead upstream is not
        // retried at full rate.
        coolDownPoll(COPIER_POLL_KEY, COPIER_FAILURE_COOLDOWN_MS);
        console.warn("Copier: poll failed, retrying next cycle:", err instanceof Error ? err.message : err);
        if (!silent) {
          toast.error("Copier poll failed — the next cycle retries automatically.");
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

  // AUTO EXECUTION — fires when the copier bot is ON, /my_settings Auto
  // Approve is ON (default) and a signer exists. Auto mode executes every new
  // buyable signal the moment it appears; manual mode only pastes it into the
  // feed for a click (Auto Approve pre-clears the guard either way).
  const executedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!botOn || !autoApprove || !walletReady || !canExecute || !signals) return;
    for (const s of signals) {
      if (executedRef.current.has(s.id)) continue;
      executedRef.current.add(s.id);
      // The BNB sniper is EVM-only — Solana signals stay on the SOL terminal.
      if (!s.buyable || s.chain === "solana") continue;
      onSignal(copierSignalToLive(s));
    }
  }, [botOn, autoApprove, walletReady, canExecute, signals, onSignal, mode]);

  const manualPaste = async () => {
    if (!manualUrl.trim()) return;
    setBusy(true);
    try {
      const res = await ingest({ raw: manualUrl.trim() });
      setLastRun(res);
      setManualUrl("");
    } catch (err) {
      console.warn("Copier: manual paste failed:", err instanceof Error ? err.message : err);
      toast.error("Couldn't ingest that paste — check the URL and try again.");
    } finally {
      setBusy(false);
    }
  };

  const activeCount = (signals ?? []).filter(
    (s) => s.buyable && s.chain !== "solana",
  ).length;
  const autoLive = botOn && autoApprove && walletReady && canExecute && mode === "auto";

  const statusLine = !botOn
    ? "Copier OFF — channels not polled."
    : !walletReady
      ? "Generate a hot wallet or import the direct wallet to arm executions."
      : !autoApprove
        ? "Auto Approve OFF — signals queue for manual review."
        : mode === "auto"
          ? "AUTO — every new buyable signal executes on capture."
          : "MANUAL — signals paste into the feed; click BUY to execute.";

  return (
    <Card className="border-border/70 bg-card/40">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Copy className="size-4 text-primary" />
            Copier — Telegram Signal Copier
            <span
              className={
                "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold " +
                (!botOn
                  ? "bg-muted text-muted-foreground"
                  : "bg-emerald-500/15 text-emerald-500")
              }
            >
              <span className={"size-1.5 rounded-full " + (botOn ? "animate-pulse bg-emerald-500" : "bg-muted-foreground")} />
              {botOn ? "ACTIVE" : "OFF"}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {activeCount} live
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
          Copies profitable token signals from {COPIER_SOURCES.map((s) => s.label).join(" + ")} for sub-millisecond
          snipe/arbitrage execution in Sniper and the DEXView/GMGN/Ave overlay's LIVE CANDIDATES.
        </p>
        <p className={"text-[11px] font-medium " + (autoLive ? "text-emerald-500" : "text-muted-foreground")}>
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
            placeholder="Paste a t.me post URL (https://t.me/AveSignalMonitor/12345)…"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="h-7 text-xs"
          />
          <Button variant="outline" size="sm" className="h-7 text-[10px]" disabled={busy || !manualUrl.trim()} onClick={() => void manualPaste()}>
            Paste signal
          </Button>
        </div>

        {/* Signal feed */}
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {(signals ?? []).length === 0 && (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              No signals yet — switch ON to start copying from the channels.
            </p>
          )}
          {(signals ?? []).map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold">${s.symbol}</span>
                  {autoLive && s.buyable && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-500">
                      ⚡ AUTO
                    </span>
                  )}
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {s.chain}
                  </Badge>
                  <span className="truncate text-[10px] text-muted-foreground">{s.sourceLabel}</span>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">{s.excerpt}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {s.liquidityUsd > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    liq ${Math.round(s.liquidityUsd).toLocaleString()}
                  </span>
                )}
                <Button
                  variant={s.buyable ? "default" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  disabled={!canExecute || s.chain === "solana"}
                  onClick={() => onSignal(copierSignalToLive(s))}
                >
                  BUY
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
