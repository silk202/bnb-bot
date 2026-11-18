import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { SimLiveDonut, SplitBar } from "@/components/SimLiveDonut";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useGasPrice } from "@/hooks/use-gas-price";
import { useTerminal } from "@/hooks/use-terminal";
import { BNB_NETWORKS, type NetworkKey } from "@/lib/chain";
import {
  CHAIN_INFO,
  effectiveRpc,
  FLASH_LENDER_INFO,
  gasCostBnb,
  isBscChain,
  lenderFeeLabel,
  lenderForRun,
} from "@/lib/flashbolt";
import {
  Activity,
  Bot as BotIcon,
  Flame,
  FlaskConical,
  Landmark,
  Pause,
  Play,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

function formatAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

export default function Bot() {
  const { state, executions, pnlSummary, setBotRunning, setMode, setSettings, liveOnly } =
    useTerminal();
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const running = state?.botRunning ?? true;
  const cadence = state?.cadence ?? 15;
  const chainKey = state?.chainKey ?? "bsc";
  const chain = CHAIN_INFO[chainKey];
  const networkKey: NetworkKey =
    state?.network === "testnet" ? "testnet" : "mainnet";
  // Private RPC overrides (set on the Contract page) win over public RPCs;
  // BNB testnet always uses the public testnet endpoint.
  const rpcUrl =
    networkKey === "testnet"
      ? BNB_NETWORKS.testnet.rpc
      : effectiveRpc(chainKey, state?.rpcOverrides?.[chainKey]);
  const { gasPriceGwei } = useGasPrice(rpcUrl);

  const activity = useMemo(() => {
    type ActivityEvent = {
      id: string;
      ts: number;
      kind: "success" | "blocked" | "below_floor" | "failed" | "scan";
      text: string;
    };
    const base = (executions ?? []).filter((e) => {
      // GLOBAL "Live only" mode: hide 🧪 SIM (paper) rows — same honest rule
      // as the histories (no txHash, or a `sim-` trail marker = paper).
      if (liveOnly && (!e.txHash || e.txHash.startsWith("sim-"))) return false;
      return true;
    });
    const events: ActivityEvent[] = base
      .slice(0, 8)
      .map((e) => ({
        id: e._id,
        ts: e.ts,
        kind: e.status,
        text:
          e.status === "success"
            ? `Executed +${e.amountBnb.toFixed(4)} BNB (${e.profitPct.toFixed(2)}%)${e.lender ? ` · ${e.lender}` : ""}${e.payoutBnb ? ` · payout ${e.payoutBnb.toFixed(4)} BNB auto-sent` : ""}`
            : e.status === "blocked"
              ? `Route blocked by MEV guard${e.lender ? ` · ${e.lender}` : ""}`
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
    toast(running ? "Flasher paused" : "Flasher resumed", {        description: running
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

  const handleMode = async (mode: "paper" | "live") => {
    const armedAddress =
      state?.deployments?.[chainKey]?.contractAddress ??
      state?.deployedContractAddress;
    if (mode === "live" && !armedAddress) {
      toast.info("Live mode requires your deployed contract", {
        description:
          "Arm FlashBoltArbitrage.sol on the Contract page, then flip this switch.",
      });
      return;
    }
    await setMode({ mode });
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          🔥 Flasher
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Bot for Flashing
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          The engine that scans live {chain.label} prices, routes across DEXs
          and executes. The flash-loan lender rotates every run and profitable
          trades pay out automatically. Paper mode never moves real funds
          until you deploy your own contract.
        </p>
      </header>

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="border-border/70 bg-card/40 shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <BotIcon className="size-4" />
                </div>                  <CardTitle className="text-sm font-semibold">
                  Flasher control
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="relative flex size-3">
                    <span
                      className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
                        running ? "bg-emerald-400" : "bg-muted-foreground"
                      }`}
                    />
                    <span
                      className={`relative inline-flex size-3 rounded-full ${
                        running ? "bg-emerald-400" : "bg-muted-foreground"
                      }`}
                    />
                  </span>
                  <div>
                    <div className="text-base font-bold text-foreground">
                      {running ? "Flasher running" : "Flasher paused"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      last scan {state?.lastScanAt ? formatAgo(state.lastScanAt) : "—"} ·
                      expires after 90s
                    </div>
                  </div>
                </div>
                <Button type="button" onClick={() => void handleToggle()} className="gap-2">
                  {running ? (
                    <>
                      <Pause className="size-4" />
                      Pause bot
                    </>
                  ) : (
                    <>
                      <Play className="size-4" />
                      Resume bot
                    </>
                  )}
                </Button>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Execution mode
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    Paper keeps funds off-chain; live needs your deployed contract.
                  </div>
                </div>
                <div className="flex rounded-full border border-border/70 bg-background/50 p-1">
                  {(["paper", "live"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void handleMode(mode)}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                        (state?.mode ?? "paper") === mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {mode === "paper" ? "Paper" : "Live on chain"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Scan cadence
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    How often the live BNB Chain market feed re-scans.
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[15, 30, 60].map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant={cadence === c ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        void setSettings({
                          minProfit: state?.minProfit ?? 0.2,
                          mevGuard: state?.mevGuard ?? true,
                          cadence: c,
                        });
                        toast(`Scan cadence set to ${c}s`);
                      }}
                    >
                      {c}s
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <Landmark className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      Lender this run
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      Rotates every scan: {chain.lenders.join(" → ")}
                      {state?.lenderBalancer && " · balancer v priority (low fee first)"}
                    </div>
                  </div>
                </div>
                <Badge className="border-primary/30 bg-primary/10 text-primary">
                  {lenderForRun(
                    state?.scansToday ?? 0,
                    !!state?.lenderBalancer,
                    chain.lenders,
                  )}
                </Badge>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                      Profit guard
                      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                        ALWAYS ON
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      The bot only ever executes flash-loan arbitrage that stays
                      profitable after the documented lender fee and the
                      configured slippage — any route with net ≤ 0 is refused,
                      in paper AND live mode. Fees are the protocols&apos; real
                      documented rates:
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {FLASH_LENDER_INFO.filter((info) =>
                        chain.lenders.includes(info.name),
                      ).map((info) => (
                        <span
                          key={info.name}
                          title={info.source}
                          className="rounded-full border border-border/50 bg-background/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {info.name}{" "}
                          <span className="font-mono text-foreground/80">
                            {info.feeLabel}
                          </span>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      Current lender:{" "}
                      <span className="font-mono text-emerald-400">
                        {lenderForRun(
                          state?.scansToday ?? 0,
                          !!state?.lenderBalancer,
                          chain.lenders,
                        )}
                      </span>{" "}
                      — {lenderFeeLabel(lenderForRun(state?.scansToday ?? 0, !!state?.lenderBalancer, chain.lenders))}{" "}
                      documented fee · live gas{" "}
                      <span className="font-mono text-foreground/80">
                        {gasPriceGwei !== null
                          ? `${gasPriceGwei.toFixed(3)} gwei (~${gasCostBnb(gasPriceGwei).toFixed(6)} ${chain.nativeSymbol} per execution)`
                          : "—"}
                      </span>{" "}
                      from {chain.label}&apos;s real RPC.
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Automatic payout
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    Sweep each execution&apos;s profit straight to your wallet.
                  </div>
                </div>
                <Switch
                  checked={state?.autoPayout ?? true}
                  onCheckedChange={(checked) => {
                    void setSettings({ autoPayout: checked }).catch(() => undefined);
                    toast(checked ? "Auto-payout on" : "Auto-payout off", {
                      description: checked
                        ? "Profits are paid out after every successful flash-loan trade."
                        : "Profits accumulate in the account until you re-enable payouts.",
                    });
                  }}
                />
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full gap-2 text-destructive"
                onClick={() => void handleEmergencyStop()}
              >
                <Power className="size-4" />
                Emergency stop Flasher
              </Button>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { icon: <RefreshCw className="size-4" />, value: String(state?.scansToday ?? 0), label: "scans today" },
              { icon: <Radio className="size-4" />, value: String(state?.openOpportunities ?? 0), label: "open routes" },
              { icon: <TrendingUp className="size-4" />, value: (state?.lifetimePnl ?? 0).toFixed(2), label: "lifetime PnL" },
              { icon: <Activity className="size-4" />, value: String(state?.executionsToday ?? 0), label: "trades today" },
              { icon: <Wallet className="size-4" />, value: (state?.payoutsTotal ?? 0).toFixed(2), label: "payouts BNB" },
            ].map((s) => (
              <Card key={s.label} className="border-border/70 bg-card/40 shadow-none">
                <CardContent className="py-4">
                  <div className="flex items-center gap-2 text-primary">{s.icon}</div>
                  <div className="mt-2 text-xl font-extrabold text-foreground">{s.value}</div>
                  <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Cumulative live P&L — gross profit minus real gas burned. */}
          <Card className="border-border/70 bg-card/40 shadow-none">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
                  <span>Cumulative P&amp;L — live executions</span>
                  <Badge
                    variant="outline"
                    className="text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {pnlSummary?.liveCount ?? 0} live txs
                  </Badge>
                </CardTitle>
                {/* Live vs SIM share — straight from the ledger's real split. */}
                <SimLiveDonut
                  live={pnlSummary?.liveCount ?? 0}
                  sim={pnlSummary?.simCount ?? 0}
                  size={64}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div>
                  <div
                    className={`text-3xl font-extrabold tabular-nums ${
                      (pnlSummary?.netPnl ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {(pnlSummary?.netPnl ?? 0) >= 0 ? "+" : ""}
                    {(pnlSummary?.netPnl ?? 0).toFixed(6)} {chain.nativeSymbol}
                  </div>
                  <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                    net = gross profit − gas burned
                  </div>
                </div>
                <div className="flex gap-6">
                  <div>
                    <div className="text-sm font-bold tabular-nums text-emerald-400">
                      +{(pnlSummary?.grossProfit ?? 0).toFixed(6)}
                    </div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      gross profit
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-sm font-bold tabular-nums text-red-400">
                      <Flame className="size-3.5" />
                      −{(pnlSummary?.gasBurned ?? 0).toFixed(6)}
                    </div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      gas burned
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-bold tabular-nums text-foreground">
                      {pnlSummary?.wins ?? 0}/{pnlSummary?.liveCount ?? 0}
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
              <SplitBar live={pnlSummary?.liveCount ?? 0} sim={pnlSummary?.simCount ?? 0} />
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                <span>
                  Last 24h:{" "}
                  <span
                    className={`font-semibold tabular-nums ${
                      (pnlSummary?.net24h ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {(pnlSummary?.net24h ?? 0) >= 0 ? "+" : ""}
                    {(pnlSummary?.net24h ?? 0).toFixed(6)} {chain.nativeSymbol}
                  </span>{" "}
                  ({pnlSummary?.wins24h ?? 0}/{pnlSummary?.live24h ?? 0} wins)
                </span>
                <span>
                  🧪 SIM net is paper-only (never broadcast on-chain, no gas) —
                  kept strictly separate from live net. Reverted txs still burn
                  gas; blocked routes cost nothing and are excluded.
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Activity feed</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <ShieldAlert className="size-5 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  No activity yet — the scanner logs events here.
                </p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                    <span
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${
                        event.kind === "success"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : event.kind === "blocked" || event.kind === "failed"
                            ? "bg-red-500/15 text-red-400"
                            : event.kind === "below_floor"
                              ? "bg-amber-500/15 text-amber-400"
                              : "bg-primary/12 text-primary"
                      }`}
                    >
                      <Activity className="size-2.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground/90">{event.text}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Date(event.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}{" "}
                        · {formatAgo(event.ts)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3.5 py-2.5 text-[11px] text-muted-foreground">
              <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-400">
                PAPER MODE
              </Badge>
              No real BNB is ever moved by the terminal.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
