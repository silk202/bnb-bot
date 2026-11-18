/**
 * SOL History — the Solana terminal's execution trail.
 *
 * Mirrors the BNB History page: the full execution record (paper + live,
 * success/blocked/below-floor/failed) scoped to chain === "solana", with
 * Solscan links for on-chain tx hashes and the real gas/profit numbers.
 * Nothing is simulated — rows come from the shared honest trail.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTerminal } from "@/hooks/use-terminal";
import { cn } from "@/lib/utils";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ArrowUpRight,
  CircleDollarSign,
  ExternalLink,
  History as HistoryIcon,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

function fmtAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

export default function SolHistory() {
  const { state, executions, resetAccount, liveOnly } = useTerminal();
  const reset = useMutation(api.terminal.resetAccount);
  // Kind filter — LIVE = real on-chain txHash; SIM = paper (no broadcast,
  // including `sim-` pseudo-hash trail markers). Starts from the GLOBAL
  // "Live only" mode (Market context strip), locally overridable.
  const [kindOverride, setKind] = useState<"all" | "live" | "sim" | null>(null);
  const kind: "all" | "live" | "sim" = kindOverride ?? (liveOnly ? "live" : "all");

  // Only this terminal's rows — EVM executions stay on the BNB terminal.
  const allRows = useMemo(
    () => (executions ?? []).filter((e) => (e.chain ?? "solana") === "solana"),
    [executions],
  );
  const isLiveExec = (e: { txHash?: string | null }) =>
    Boolean(e.txHash) && !e.txHash!.startsWith("sim-");
  const rows = useMemo(
    () =>
      allRows.filter((e) => {
        if (kind === "live" && !isLiveExec(e)) return false;
        if (kind === "sim" && isLiveExec(e)) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, kind],
  );

  const stats = useMemo(() => {
    let wins = 0;
    let profit = 0;
    let gas = 0;
    for (const r of rows) {
      if (r.status !== "success") continue;
      wins += 1;
      profit += r.amountBnb;
      if (r.txHash && !r.txHash.startsWith("sim-")) gas += r.gasUsedBnb ?? 0;
    }
    return { wins, profit, gas, net: profit - gas };
  }, [rows]);

  const handleReset = async () => {
    await reset({});
    toast("Paper account reset", {
      description: "Balance restored to 10 SOL-equivalent — the execution trail stays for reference.",
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            SOL FlashBolt Terminal
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
            History
          </h1>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            Every Solana-terminal execution — paper fills, guard rejections and
            on-chain routes with Solscan links. Nothing is simulated.
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => void handleReset()}>
          <RotateCcw className="size-4" />
          Reset paper account
        </Button>
      </header>

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Records
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-extrabold">{rows.length}</div>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Wins
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-extrabold">{stats.wins}</div>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Gross profit
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="font-mono text-2xl font-extrabold text-emerald-400">
              +{stats.profit.toFixed(4)}
            </div>
            <div className="text-xs text-muted-foreground">SOL</div>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Net (gas deducted)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="font-mono text-2xl font-extrabold">{stats.net.toFixed(4)}</div>
            <div className="text-xs text-muted-foreground">
              {stats.gas.toFixed(6)} SOL gas burned
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Trail */}
      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <HistoryIcon className="size-4 text-primary" />
              Execution trail
            </CardTitle>
            <div className="flex flex-wrap gap-1.5">
              {([
                ["all", `All (${allRows.length})`],
                ["live", `⛓ Live (${allRows.filter(isLiveExec).length})`],
                ["sim", `🧪 SIM (${allRows.filter((e) => !isLiveExec(e)).length})`],
              ] as Array<[(typeof kind), string]>).map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setKind(f)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    kind === f
                      ? "bg-primary text-primary-foreground"
                      : "border border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <CircleDollarSign className="size-5 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">
                No Solana executions yet — run a route from the SOL Scanner or
                snipe a signal on the SOL Sniper.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((e) => (
                <li
                  key={e._id}
                  className="flex flex-col gap-2 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-xs text-foreground/90">
                        {e.label}
                      </span>
                      <Badge
                        className={cn(
                          e.status === "success"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                            : e.status === "failed"
                              ? "border-red-500/30 bg-red-500/10 text-red-400"
                              : e.status === "blocked"
                                ? "border-red-500/30 bg-red-500/10 text-red-400"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-400",
                        )}
                      >
                        {e.status === "success"
                          ? "success"
                          : e.status === "failed"
                            ? "failed"
                            : e.status === "blocked"
                              ? "blocked"
                              : "below floor"}
                      </Badge>
                      {e.txHash && (
                        <Badge className="border-primary/25 bg-primary/10 text-primary">
                          on-chain
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span>{fmtAgo(e.ts)}</span>
                      {e.lender && <span>lender {e.lender}</span>}
                      {e.dexes && <span>venues {e.dexes}</span>}
                      {e.relay && <span>relay {e.relay}</span>}
                      {e.txHash && (
                        <a
                          href={`https://solscan.io/tx/${e.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Solscan
                          <ExternalLink className="size-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <div
                        className={cn(
                          "font-mono text-sm font-bold",
                          e.status === "success" ? "text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        {e.status === "success" ? "+" : ""}
                        {e.amountBnb.toFixed(4)} SOL
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {e.profitPct > 0 ? "+" : ""}
                        {e.profitPct.toFixed(2)}%
                      </div>
                    </div>
                    {e.status === "success" && (
                      <ArrowUpRight className="size-3.5 text-emerald-400" />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state && (
            <p className="mt-4 text-[11px] text-muted-foreground">
              Paper balance {state.balance.toFixed(4)} · lifetime PnL{" "}
              {state.lifetimePnl.toFixed(4)} SOL-equivalent · the trail is the
              same honest record the BNB terminal keeps, scoped per chain.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
