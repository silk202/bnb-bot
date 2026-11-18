/**
 * SOL Flasher — the bot control page for the Solana terminal.
 *
 * Mirrors the BNB Flasher (Bot.tsx): bot running toggle, emergency stop,
 * paper/live mode switch, flash-loan lender rotation with documented fees,
 * recent activity trail and the cumulative net-PnL summary (gross profit −
 * real gas burned across live executions).
 */
import { SimLiveDonut, SplitBar } from "@/components/SimLiveDonut";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTerminal } from "@/hooks/use-terminal";
import { JITO_RELAY_LABEL } from "@/lib/solana-jito";
import { SOL_FLASH_LENDERS, solLenderForRun, solLenderInfo } from "@/lib/solana";
import {
  Activity,
  Bot as BotIcon,
  Eraser,
  Flame,
  FlaskConical,
  Landmark,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

function formatAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

export default function SolBot() {
  const { state, executions, pnlSummary, setBotRunning, setMode, setSettings: setTerminalSettings, liveOnly } = useTerminal();
  const privateSubmit = state?.privateSubmit ?? true;
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const running = state?.botRunning ?? true;
  const cadence = state?.cadence ?? 15;
  const balanced = state?.lenderBalancer ?? false;

  const activity = useMemo(() => {
    type ActivityEvent = {
      id: string;
      ts: number;
      kind: "success" | "blocked" | "below_floor" | "failed" | "scan";
      text: string;
    };
    const events: ActivityEvent[] = (executions ?? [])
      .filter((e) => (e.chain ?? "solana") === "solana")
      .filter((e) => {
        // GLOBAL "Live only" mode: hide 🧪 SIM (paper) rows.
        if (liveOnly && (!e.txHash || e.txHash.startsWith("sim-"))) return false;
        return true;
      })
      .slice(0, 8)
      .map((e) => ({
        id: e._id,
        ts: e.ts,
        kind: e.status,
        text:
          e.status === "success"
            ? `Executed +${e.amountBnb.toFixed(4)} SOL (${e.profitPct.toFixed(2)}%)${e.lender ? ` · ${e.lender}` : ""}${e.payoutBnb ? ` · payout ${e.payoutBnb.toFixed(4)} SOL auto-sent` : ""}`
            : e.status === "blocked"
              ? `Route blocked by guard${e.lender ? ` · ${e.lender}` : ""}`
              : e.status === "failed"
                ? `On-chain transaction reverted${e.txHash ? ` · ${e.txHash.slice(0, 10)}…` : ""}${e.lender ? ` · ${e.lender}` : ""}`
                : `Route skipped — below profit floor${e.lender ? ` · ${e.lender}` : ""}`,
      }));
    if (state?.lastScanAt) {
      events.push({
        id: "scan",
        ts: state.lastScanAt,
        kind: "scan",
        text: `Scanner ticked — ${state.scansToday} scans today`,
      });
    }
    return events.sort((a, b) => b.ts - a.ts).slice(0, 8);
  }, [executions, state, liveOnly]);

  const handleToggle = async () => {
    await setBotRunning({ running: !running });
    toast(running ? "Flasher paused" : "Flasher resumed", {
      description: running
        ? "Flasher on hold — paper account untouched."
        : "Flasher resuming on the next scan cadence.",
    });
  };

  const handleEmergencyStop = async () => {
    await setBotRunning({ running: false });
    toast.error("Emergency stop engaged", {
      description: "Flasher halted. Resume from the Flasher page when ready.",
    });
  };

  const handleMode = async (m: "paper" | "live") => {
    await setMode({ mode: m });
  };

  // Ledger self-heal: deletes the phantom paper credits minted by the
  // DexScreener stale-mark incident (thin memecoins quoting six-figure
  // "spreads") and reverses them from the practice balance. Live rows —
  // every success that carries a real sell signature — are never touched.
  const purgeCorrupted = useMutation(api.terminal.purgeCorruptedSolPaper);
  const [purging, setPurging] = useState(false);
  const handlePurgeCorrupted = async () => {
    setPurging(true);
    try {
      const res = await purgeCorrupted({});
      if (res && res.removed > 0) {
        toast.success(`Purged ${res.removed} corrupted paper row${res.removed === 1 ? "" : "s"}`, {
          description: `Reversed ${res.reversedSol.toFixed(4)} SOL of phantom credits from the practice ledger.`,
        });
      } else {
        toast.info("Ledger already clean", {
          description: "No corrupted SOL paper rows found — nothing to purge.",
        });
      }
    } catch (err) {
      toast.error("Purge failed", {
        description: err instanceof Error ? err.message : "Convex rejected the cleanup — try again.",
      });
    } finally {
      setPurging(false);
    }
  };

  const activeLender = solLenderForRun(state?.scansToday ?? 0, balanced);

  // SOL-scoped session stats — computed ONLY from the persisted execution
  // trail rows tagged chain === "solana" (never mixed with BNB numbers).
  const solStats = useMemo(() => {
    const list = (executions ?? []).filter((e) => (e.chain ?? "solana") === "solana");
    let pnl = 0;
    let tradesToday = 0;
    let payouts = 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const e of list) {
      if (e.status === "success") {
        // Paper rows (no txHash) carry the exact credited amount; live rows
        // are net of the real gas deducted on-chain.
        pnl += e.txHash ? e.amountBnb - (e.gasUsedBnb ?? 0) : e.amountBnb;
        if (e.ts >= dayAgo) tradesToday += 1;
        payouts += e.payoutBnb ?? 0;
      }
    }
    return { pnl, tradesToday, payouts };
  }, [executions]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          🔥 Flasher
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Bot for Flashing on Solana
        </p>
      </header>

      {/* Bot status + controls */}
      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <BotIcon className="size-4 text-primary" />
            Bot control
            <Badge
              className={
                running
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {running ? "RUNNING" : "PAUSED"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
              <div>
                <div className="text-xs font-semibold text-foreground">Flasher running</div>
                <p className="text-[11px] text-muted-foreground">
                  Scan cadence every {cadence}s while running.
                </p>
              </div>
              <Switch
                checked={running}
                onCheckedChange={() => void handleToggle()}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
              <div>
                <div className="text-xs font-semibold text-foreground">Execution mode</div>
                <p className="text-[11px] text-muted-foreground">
                  {modeLabel(state?.mode)}
                </p>
              </div>
              <div className="flex rounded-full border border-border/70 bg-background/50 p-1">
                {(["paper", "live"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => void handleMode(m)}
                    className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
                      (state?.mode ?? "paper") === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "paper" ? "Paper" : "Live"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Button
                variant="destructive"
                className="w-full gap-2 bg-destructive font-semibold text-white shadow-lg shadow-destructive/25 hover:bg-destructive/90 dark:bg-destructive dark:text-white"
                onClick={() => void handleEmergencyStop()}
              >
                <Power className="size-4" />
                Emergency stop
              </Button>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Halts every route instantly — live mode never fires while this is engaged.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <ShieldCheck className="size-3.5 text-primary" />
                  Jito-style protected submission
                </div>
                <Switch
                  checked={privateSubmit}
                  onCheckedChange={(v) => void setTerminalSettings({ privateSubmit: v })}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {privateSubmit
                  ? JITO_RELAY_LABEL + " — signed route txs bypass the public mempool with revert protection."
                  : "OFF — txs go through the public RPC path (sandwich-exposed)."}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Landmark className="size-3.5 text-primary" />
                Flash-loan lenders (Solana)
              </div>
              <div className="mt-2 space-y-1.5">
                {SOL_FLASH_LENDERS.map((l) => (
                  <div
                    key={l.name}
                    className="flex items-center justify-between text-[11px]"
                  >
                    <span className={cnLender(l.name, activeLender)}>
                      {l.name}
                      {l.name === activeLender && (
                        <Badge variant="outline" className="ml-1.5 text-[9px] uppercase">
                          this run
                        </Badge>
                      )}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {l.feeLabel}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {solLenderInfo(activeLender).source}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Scans today
              </div>
              <div className="mt-1 font-mono text-lg font-bold text-foreground">
                {state?.scansToday ?? 0}
              </div>
              <div className="text-[10px] text-muted-foreground">
                last {state?.lastScanAt ? formatAgo(state.lastScanAt) : "—"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Session stats — scans, open routes, PnL, trades today, payouts (SOL) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          {
            icon: <RefreshCw className="size-4" />,
            value: String(state?.scansToday ?? 0),
            label: "scans today",
          },
          {
            icon: <Radio className="size-4" />,
            value: String(state?.openOpportunities ?? 0),
            label: "open routes",
          },
          {
            icon: <TrendingUp className="size-4" />,
            value: `${solStats.pnl >= 0 ? "+" : ""}${solStats.pnl.toFixed(4)}`,
            label: "PnL SOL",
          },
          {
            icon: <Activity className="size-4" />,
            value: String(solStats.tradesToday),
            label: "trades today",
          },
          {
            icon: <Wallet className="size-4" />,
            value: solStats.payouts.toFixed(4),
            label: "payouts SOL",
          },
        ].map((s) => (
          <Card key={s.label} className="border-border/70 bg-card/40 shadow-none">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-primary">{s.icon}</div>
              <div
                className={`mt-2 font-mono text-xl font-extrabold tabular-nums ${
                  s.label === "PnL SOL" && solStats.pnl < 0 ? "text-red-400" : "text-foreground"
                }`}
              >
                {s.value}
              </div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                {s.label}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Cumulative live P&L — SOL rows only: gross profit minus real gas
          burned on-chain. Same card as the BNB Flasher, same honest rules:
          reverted txs still burn gas; paper trades and blocked routes are
          excluded (they have no on-chain footprint). */}
      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <span>Cumulative P&amp;L — live executions</span>
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                {pnlSummary?.solLiveCount ?? 0} live txs
              </Badge>
            </CardTitle>
            {/* Live vs SIM share — straight from the ledger's real split. */}
            <SimLiveDonut
              live={pnlSummary?.solLiveCount ?? 0}
              sim={pnlSummary?.simCount ?? 0}
              size={64}
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <div
                className={`font-mono text-3xl font-extrabold tabular-nums ${
                  (pnlSummary?.solNetPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {(pnlSummary?.solNetPnl ?? 0) >= 0 ? "+" : ""}
                {(pnlSummary?.solNetPnl ?? 0).toFixed(6)} SOL
              </div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                net = gross profit − gas burned
              </div>
            </div>
            <div className="flex gap-6">
              <div>
                <div className="text-sm font-bold tabular-nums text-emerald-400">
                  +{(pnlSummary?.solGrossProfit ?? 0).toFixed(6)}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  gross profit
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1 text-sm font-bold tabular-nums text-red-400">
                  <Flame className="size-3.5" />
                  −{(pnlSummary?.solGasBurned ?? 0).toFixed(6)}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  gas burned
                </div>
              </div>
              <div>
                <div className="text-sm font-bold tabular-nums text-foreground">
                  {pnlSummary?.solWins ?? 0}/{pnlSummary?.solLiveCount ?? 0}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  win rate
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1 text-sm font-bold tabular-nums text-amber-400">
                  <FlaskConical className="size-3.5" />
                  +{(pnlSummary?.simNet ?? 0).toFixed(6)}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  🧪 SIM net · {pnlSummary?.simCount ?? 0} paper
                </div>
              </div>
            </div>
          </div>
          {/* Split bar — same ▓/░ taxonomy as the bot's /pnl and /execs. */}
          <SplitBar live={pnlSummary?.solLiveCount ?? 0} sim={pnlSummary?.simCount ?? 0} />
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
            <span>
              Last 24h:{" "}
              <span
                className={`font-semibold tabular-nums ${
                  (pnlSummary?.solNet24h ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {(pnlSummary?.solNet24h ?? 0) >= 0 ? "+" : ""}
                {(pnlSummary?.solNet24h ?? 0).toFixed(6)} SOL
              </span>{" "}
              ({pnlSummary?.solWins24h ?? 0}/{pnlSummary?.solLive24h ?? 0} wins)
            </span>
            <span>
              🧪 SIM net is paper-only (never broadcast on-chain, no gas) — kept
              strictly separate from live net. Reverted txs still burn gas;
              blocked routes cost nothing and are excluded.
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
            <div className="text-[11px] text-muted-foreground">
              Paper ledger self-check — one click deletes phantom credits from
              the stale-mark incident and reverses them from the practice
              balance. Live rows are never touched.
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={purging}
              onClick={() => void handlePurgeCorrupted()}
            >
              <Eraser className="size-3.5" />
              {purging ? "Purging…" : "Purge corrupted paper rows"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Activity trail */}
      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-primary" />
            Recent activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No activity yet — start the Flasher and let the Scanner tick.
            </p>
          ) : (
            <ul className="space-y-2">
              {activity.map((ev) => (
                <li
                  key={ev.id}
                  className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5"
                >
                  {ev.kind === "success" ? (
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                  ) : ev.kind === "scan" ? (
                    <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-foreground/90">{ev.text}</p>
                    <p className="text-[10px] text-muted-foreground">{formatAgo(ev.ts)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <Flame className="size-3.5 shrink-0 text-primary" />
        The SOL Flasher shares the terminal's paper account and execution trail
        — every route priced from live DexScreener Solana venue data, lender
        rotating per run ({balanced ? "balancer on: low-fee first" : "plain rotation"}).
      </div>
    </div>
  );
}

function modeLabel(mode: string | undefined): string {
  return mode === "live"
    ? "Live on chain — routes settle on Solana mainnet."
    : "Paper — credits the practice account, no chain interaction.";
}

function cnLender(name: string, active: string): string {
  return "font-semibold " + (name === active ? "text-foreground" : "text-muted-foreground");
}
