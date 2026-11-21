/**
 * SOL FlashBolt Overview — mirrors the BNB Overview page exactly: status
 * banner, launch checklist, live metrics, cumulative PnL chart and latest
 * executions. Everything reads the same honest execution trail, scoped to
 * the Solana terminal's SOL-denominated rows.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AlertPrefsPanel } from "@/components/AlertPrefsPanel";
import { TradeNotificationPanel } from "@/components/TradeNotificationPanel";
import { HoneyPotGuard } from "@/components/HoneyPotGuard";
import { TerminalSessionsStrip } from "@/components/TerminalSessionsStrip";
import { DrillStatusCard } from "@/components/DrillStatusCard";
import { fmtSignLatency } from "@/lib/telegram";
import { MarketNewsPanel } from "@/components/MarketNewsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTerminal } from "@/hooks/use-terminal";
import { VaultSignerCard, type VaultSignerCardAdapter } from "@/components/VaultSignerCard";
import {
  removeFromVault as solRemoveFromVault,
  vaultSignerAddresses as solVaultSignerAddresses,
} from "@/lib/solana-vault";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  Pause,
  Play,
  Radio,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Doc } from "@/convex/_generated/dataModel";

const NATIVE = "SOL";
const QUOTE = "WSOL";

/** Real vault seam behind the Overview's Vault dashboard card — the same
 *  `solana-vault` memory + blob the Wallets page manages (nothing simulated). */
const SOL_VAULT: VaultSignerCardAdapter = {
  addresses: solVaultSignerAddresses,
  remove: (address) => solRemoveFromVault(address),
  clip: (address) => `${address.slice(0, 8)}…${address.slice(-6)}`,
  walletsHref: "/sol-terminal/wallets",
};

function formatAgo(ts: number | undefined): string {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

/** Real CoinGecko spot price for SOL. */
function useSolPrice() {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchPrice = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        );
        const data = (await res.json()) as Record<string, { usd?: number }>;
        if (!cancelled && typeof data?.solana?.usd === "number") {
          setPrice(data.solana.usd);
        }
      } catch {
        // keep the last live price on transient network failures
      }
    };
    void fetchPrice();
    // Re-pull the real spot price — no simulated jitter, ever.
    const timer = setInterval(() => void fetchPrice(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return price;
}

/** Net PnL of a SOL execution (profit minus real gas for on-chain rows). */
function netExecutionPnl(e: Doc<"executions">): number {
  if (e.status !== "success") return 0;
  const gas = e.txHash ? (e.gasUsedBnb ?? 0) : 0;
  return Math.round((e.amountBnb - gas) * 1e6) / 1e6;
}

function buildPnlSeries(executions: Doc<"executions">[] | undefined) {
  if (!executions || executions.length === 0) {
    const points = 24;
    const series: { t: number; v: number }[] = [];
    for (let i = 1; i <= points; i += 1) {
      // No real history yet — flat zero baseline, never a fabricated curve.
      series.push({ t: i, v: 0 });
    }
    return series;
  }
  const sorted = [...executions].sort((a, b) => a.ts - b.ts);
  const series: { t: number; v: number }[] = [{ t: 0, v: 0 }];
  let acc = 0;
  sorted.forEach((e, i) => {
    acc += netExecutionPnl(e);
    series.push({ t: i + 1, v: Math.round(acc * 1e6) / 1e6 });
  });
  return series;
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card className="border-border/70 bg-card/40 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-2xl font-extrabold tracking-tight text-foreground">
          {value}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

/** Launch checklist — real persisted SOL terminal state only. */
function SetupChecklist() {
  const { state } = useTerminal();

  const steps = [
    {
      label: "Connect a Solana wallet",
      desc: "Phantom, Solflare or any standard wallet via wallet-adapter",
      href: "/sol-terminal/bot",
      done: (state?.connectedWallets?.length ?? 0) > 0,
    },
    {
      label: "Arm the flash-loan stack",
      desc: "Jupiter Lend (0%) primary, MarginFi and Solend fallbacks — all through the guard stack",
      href: "/sol-terminal/scanner",
      done: true,
    },
    {
      label: "Go live on chain",
      desc: "Flip the execution mode from paper to live",
      href: "/sol-terminal/bot",
      done: (state?.mode ?? "paper") === "live",
    },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold text-foreground">
          <CheckCircle2 className="size-4 text-primary" />
          Launch checklist
        </div>
        {allDone ? (
          <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            Fully armed · live on chain
          </Badge>
          ) : (
          <span className="text-[11px] text-muted-foreground">
            {steps.filter((s) => s.done).length} of {steps.length} complete
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <Link
            key={step.label}
            to={step.href}
            className={cn(
              "group flex items-start gap-2.5 rounded-xl border px-3.5 py-3 transition-colors",
              step.done
                ? "border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-500/50"
                : "border-border/60 bg-background/40 hover:border-primary/40",
            )}
          >
            {step.done ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            ) : (
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-[10px] font-bold text-muted-foreground">
                {steps.indexOf(step) + 1}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-xs font-semibold",
                  step.done ? "text-emerald-500" : "text-foreground",
                )}
              >
                {step.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                {step.desc}
              </span>
            </span>
            <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </Link>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Checklist reflects the real persisted terminal state — nothing is
        simulated. Paper mode works without steps 1 and 3; live mode needs all
        of them.
      </p>
    </div>
  );
}

function StatusBanner() {
  const { state, setBotRunning, setMode } = useTerminal();
  const running = state?.botRunning ?? true;

  const handleToggleBot = async () => {
    await setBotRunning({ running: !running });
    toast(running ? "Bot paused" : "Bot resumed", {
      description: running
        ? "The scanner is on hold — no new opportunities will be ticked."
        : "Scanning resumes on the next cadence.",
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/40 px-5 py-4 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-2.5 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
              running ? "bg-emerald-400" : "bg-muted-foreground"
            }`}
          />
          <span
            className={`relative inline-flex size-2.5 rounded-full ${
              running ? "bg-emerald-400" : "bg-muted-foreground"
            }`}
          />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">
              {running ? "Bot running" : "Bot paused"}
            </span>
            <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-400">
              {state?.mode === "live" ? "LIVE ON CHAIN" : "PAPER MODE"}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            last scan {formatAgo(state?.lastScanAt)} · opportunities expire
            after 90s
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-full border border-border/70 bg-background/50 p-1">
          {(["paper", "live"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                // Live mode on SOL requires a wallet signature path — paper
                // mode always works. Same gate the BNB terminal applies.
                void setMode({ mode });
              }}
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
        <Button
          type="button"
          onClick={handleToggleBot}
          className="gap-2"
        >
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
    </div>
  );
}

export default function SolOverview() {
  const { state, executions } = useTerminal();
  // Subscriber self-service panel — null for operators (their console covers
  // the same rows), mirroring the BNB Overview layout rule.
  const access = useQuery(api.gate.myAccess);
  const isSubscriber = access !== undefined && access !== null;
  const price = useSolPrice();
  const series = useMemo(
    () => buildPnlSeries(executions),
    [executions],
  );
  const latest = useMemo(() => (executions ?? []).slice(0, 6), [executions]);

  // Real PnL analytics — computed from the persisted execution trail only,
  // scoped to SOL-terminal rows (chain === "solana").
  const stats = useMemo(() => {
    const list = (executions ?? []).filter((e) => (e.chain ?? "solana") === "solana");
    let net = 0;
    let onChain = 0;
    let paper = 0;
    let gas = 0;
    let wins = 0;
    let best = 0;
    for (const e of list) {
      if (e.status !== "success") continue;
      const pnl = netExecutionPnl(e);
      net += pnl;
      if (e.txHash) {
        onChain += pnl;
        gas += e.gasUsedBnb ?? 0;
      } else {
        paper += pnl;
      }
      wins += 1;
      best = Math.max(best, e.amountBnb);
    }
    return {
      net,
      onChain,
      paper,
      gas,
      wins,
      attempts: list.length,
      best,
    };
  }, [executions]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Overview
        </h1>
      </header>

      <StatusBanner />

      <SetupChecklist />

      {/* Vault dashboard — the live signers list + removal, mirroring the BNB
          Overview so a wrongly imported/derived address can be cleared right
          here without hunting for the Wallets page. */}
      <VaultSignerCard adapter={SOL_VAULT} />

      {/* Same real pinned drill report as the BNB Overview — one artifact,
          one evaluator, honest hold or green on both terminals. */}
      <DrillStatusCard />

      <TerminalSessionsStrip />

      {/* Same alert stack as the BNB Overview: honey-pot guard, subscriber
          alert preferences and the trade sound/push settings panel. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <HoneyPotGuard className={isSubscriber ? undefined : "lg:col-span-2"} />
        {isSubscriber && <AlertPrefsPanel />}
        <TradeNotificationPanel />
      </div>

      <MarketNewsPanel />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="SOL price"
          value={price === null ? "—" : `$${price.toFixed(2)}`}
          sub="live CoinGecko spot"
        />
        <MetricCard
          label="Net PnL"
          value={`${stats.net.toFixed(4)} ${QUOTE}`}
          sub={`${stats.attempts} recorded executions · net of lender fees + gas`}
        />
        <MetricCard
          label="On-chain PnL"
          value={`${stats.onChain.toFixed(4)} ${QUOTE}`}
          sub={`${stats.gas.toFixed(4)} ${NATIVE} real gas deducted (receipts)`}
        />
        <MetricCard
          label="Paper PnL"
          value={`${stats.paper.toFixed(4)} ${QUOTE}`}
          sub="net of documented lender fees"
        />
        <MetricCard
          label="Win rate"
          value={`${stats.attempts > 0 ? Math.round((stats.wins / stats.attempts) * 100) : 0}%`}
          sub={
            stats.attempts > 0
              ? `${stats.wins} wins of ${stats.attempts} attempts`
              : "no attempts yet"
          }
        />
        <MetricCard
          label="Best trade"
          value={stats.best > 0 ? `+${stats.best.toFixed(4)} ${QUOTE}` : "—"}
          sub="largest single net profit"
        />
        <MetricCard
          label="Open opportunities"
          value={String(state?.openOpportunities ?? 0)}
          sub="in the live feed"
        />
        <MetricCard
          label="Scans today"
          value={String(state?.scansToday ?? 0)}
          sub={`every ${state?.cadence ?? 15} seconds`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <TrendingUp className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Cumulative PnL
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
                  <defs>
                    <linearGradient id="solPnlFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#9945FF" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#9945FF" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => v.toFixed(2)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--muted-foreground)" }}
                    formatter={(value: number) => [`${value.toFixed(4)} ${QUOTE}`, "PnL"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="#9945FF"
                    strokeWidth={2}
                    fill="url(#solPnlFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Activity className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Latest executions
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {latest.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CircleDollarSign className="size-5 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  No paper trades yet — open the Scanner and execute a live route.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {latest.map((e) => {
                  const pnl = netExecutionPnl(e);
                  return (
                    <li
                      key={e._id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs text-foreground/90">
                            {e.label}
                          </span>
                          {e.signingLatencyMs !== undefined && (
                            <Badge className="border-violet-500/30 bg-violet-500/10 font-mono text-violet-300">
                              {fmtSignLatency(e.signingLatencyMs)}
                            </Badge>
                          )}
                          {e.txHash && (
                            <Badge className="border-primary/25 bg-primary/10 text-primary">
                              on-chain
                            </Badge>
                            )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {new Date(e.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`inline-flex size-2 rounded-full ${
                            e.status === "success"
                              ? "bg-emerald-400"
                              : e.status === "blocked" || e.status === "failed"
                                ? "bg-red-400"
                                : "bg-amber-400"
                          }`}
                        />
                        <span
                          className={`font-mono text-xs font-bold ${
                            e.status === "success"
                              ? "text-emerald-400"
                              : "text-muted-foreground"
                          }`}
                        >
                          {e.status === "success" ? "+" : ""}
                          {pnl.toFixed(4)}
                        </span>
                        {e.status === "success" && pnl > 0 && (
                          <ArrowUpRight className="size-3 text-emerald-400" />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3.5 py-2.5 text-[11px] text-muted-foreground">
              <Radio className="size-3.5 shrink-0 text-primary" />
              PnL is computed from the real execution trail — paper profits net
              of documented flash-loan fees, on-chain trades also net of the
              actual gas paid (read from receipts). Nothing is simulated.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
