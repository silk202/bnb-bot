import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTerminal } from "@/hooks/use-terminal";
import {
  BNB_NETWORKS,
  fetchTransactionReceipt,
  networkForChainId,
  type OnChainReceipt,
} from "@/lib/chain";
import { CHAIN_INFO, chainForChainId, effectiveRpc } from "@/lib/flashbolt";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  History as HistoryIcon,
  Loader2,
  Power,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getProbeHistory,
  summarizeProbeHistory,
  type RelayProbeSample,
} from "@/lib/relay-history";
import { cn } from "@/lib/utils";
import {
  buildHistoryCsv,
  signLatencyStats,
  signingLatencyFilter,
  type SignLatencyFilter,
} from "@/lib/history-analytics";
import { fmtSignLatency } from "@/lib/telegram";
import type { Hex } from "viem";

type StatusFilter = "all" | "success" | "blocked" | "below_floor";
/** Kind filter — LIVE = real on-chain txHash; SIM = paper (no broadcast). */
type KindFilter = "all" | "live" | "sim";

const STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
  success: { label: "Success", className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400" },
  blocked: { label: "MEV-blocked", className: "border-red-500/25 bg-red-500/10 text-red-400" },
  below_floor: { label: "Below floor", className: "border-amber-500/25 bg-amber-500/10 text-amber-400" },
  failed: { label: "Failed", className: "border-red-500/25 bg-red-500/10 text-red-400" },
};

/** Real receipt statuses read straight from the chain — never assumed. */
const RECEIPT_META: Record<
  OnChainReceipt["status"],
  { label: string; className: string }
> = {
  success: { label: "Confirmed", className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400" },
  reverted: { label: "Reverted", className: "border-red-500/25 bg-red-500/10 text-red-400" },
  pending: { label: "Pending", className: "border-amber-500/25 bg-amber-500/10 text-amber-400" },
};

/**
 * Resolve the correct explorer + RPC for an execution: non-BNB chains via
 * their chain id (1 / 42161 / 137), BNB via its mainnet/testnet network.
 */
function executionChainMeta(
  e: { chainId?: number; network?: string },
  rpcOverrides?: Record<string, string>,
) {
  const chainKey = chainForChainId(e.chainId ?? 0);
  if (chainKey && chainKey !== "bsc") {
    const info = CHAIN_INFO[chainKey];
    return {
      explorerUrl: info.explorerUrl,
      explorer: info.explorer,
      rpc: effectiveRpc(chainKey, rpcOverrides?.[chainKey]),
    };
  }
  const net =
    networkForChainId(e.chainId ?? 0) ??
    (e.network === "testnet" ? "testnet" : "mainnet");
  const info = BNB_NETWORKS[net];
  return {
    explorerUrl: info.explorerUrl,
    explorer: info.explorer,
    rpc:
      net === "testnet"
        ? info.rpc
        : effectiveRpc("bsc", rpcOverrides?.bsc),
  };
}

/**
 * Per-relay latency sparkline — the last relay-probe samples (oldest →
 * newest, left → right) from the persistent probe history. Healthy probes
 * plot as sky dots sized by nothing but positioned by latency; failures
 * plot as red marks at the bottom rail. Pure SVG, no chart dependency.
 */
function RelaySparkline({ endpoint }: { endpoint: string }) {
  const samples: RelayProbeSample[] = getProbeHistory(endpoint).slice(-30);
  if (samples.length === 0) return null;
  const W = 120;
  const H = 28;
  const ok = samples.filter((s) => s.ok);
  const maxLat = Math.max(...ok.map((s) => s.latencyMs), 1);
  const minLat = Math.min(...ok.map((s) => s.latencyMs), maxLat);
  const span = Math.max(maxLat - minLat, 1);
  const x = (i: number) => 4 + (i / Math.max(samples.length - 1, 1)) * (W - 8);
  const y = (lat: number) => H - 6 - ((lat - minLat) / span) * (H - 14);
  return (
    <div className="flex flex-col">
      <svg width={W} height={H} className="overflow-visible">
        {samples.map((s, i) =>
          s.ok ? (
            <circle
              key={s.t}
              cx={x(i)}
              cy={y(s.latencyMs)}
              r={1.8}
              className="fill-sky-400"
            >
              <title>{`${new Date(s.t).toLocaleTimeString()} · ${s.latencyMs.toFixed(0)} ms`}</title>
            </circle>
          ) : (
            <rect
              key={s.t}
              x={x(i) - 1.5}
              y={H - 5}
              width={3}
              height={3}
              rx={0.5}
              className="fill-red-400"
            >
              <title>{`${new Date(s.t).toLocaleTimeString()} · ${s.error ?? "down"}`}</title>
            </rect>
          ),
        )}
      </svg>
      {(() => {
        const sum = summarizeProbeHistory(endpoint);
        return (
          <div className="font-mono text-[9px] text-muted-foreground">
            avg {sum.avgLatencyMs.toFixed(0)}ms · p95 {sum.p95.toFixed(0)}ms · up {sum.uptimePct}%
          </div>
        );
      })()}
    </div>
  );
}

export default function History() {
  const { executions, resetAccount, state, liveOnly } = useTerminal();
  const [filter, setFilter] = useState<StatusFilter>("all");
  // Signing-latency dimension: all rows, only really-measured ones, or only
  // the unmeasured (extension/wallet-signed) ones.
  const [signFilter, setSignFilter] = useState<SignLatencyFilter>("all");
  // The kind filter starts from the GLOBAL "Live only" mode (Market context
  // strip) but stays locally overridable.
  const [kindOverride, setKind] = useState<KindFilter | null>(null);
  const kind: KindFilter = kindOverride ?? (liveOnly ? "live" : "all");
  // Real on-chain receipts keyed by tx hash (fetched from the BNB RPC).
  const [receipts, setReceipts] = useState<Record<string, OnChainReceipt>>({});
  const [openTx, setOpenTx] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const fetchedRef = useRef(new Set<string>());

  // Fetch the real receipt for every execution that carries a tx hash.
  // Capped concurrency; each hash is probed once per session, so the trail
  // never hammers the RPC.
  useEffect(() => {
    let cancelled = false;
    const unique = (executions ?? [])
      .filter((e) => e.txHash && !fetchedRef.current.has(e.txHash))
      .map((e) => ({
        txHash: e.txHash as string,
        rpc: executionChainMeta(e, state?.rpcOverrides).rpc,
      }));
    if (unique.length === 0) return;
    const CONCURRENCY = 6;
    let index = 0;
    const worker = async () => {
      while (index < unique.length) {
        const item = unique[index++];
        if (cancelled) return;
        const receipt = await fetchTransactionReceipt(item.rpc, item.txHash as Hex);
        if (cancelled) return;
        fetchedRef.current.add(item.txHash);
        if (receipt) {
          setReceipts((r) => ({ ...r, [item.txHash]: receipt }));
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, unique.length) },
      () => worker(),
    );
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [executions, state?.rpcOverrides]);

  // LIVE vs SIM, honestly: a `sim-` prefixed hash is a paper trail marker,
  // never a broadcast — it counts as SIM, same as no hash at all.
  const isLiveExec = (e: { txHash?: string | null }) =>
    Boolean(e.txHash) && !e.txHash!.startsWith("sim-");

  const filtered = useMemo(
    () =>
      (executions ?? []).filter((e) => {
        if (filter !== "all" && e.status !== filter) return false;
        if (kind === "live" && !isLiveExec(e)) return false;
        if (kind === "sim" && isLiveExec(e)) return false;
        if (!signingLatencyFilter(signFilter)(e)) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [executions, filter, kind, signFilter],
  );

  // Aggregate over MEASURED rows only — wallet/extension-signed rows carry
  // no latency and are excluded, never zero-filled.
  const signStats = useMemo(() => signLatencyStats(filtered), [filtered]);

  const summary = useMemo(() => {
    const list = executions ?? [];
    return {
      total: list.length,
      success: list.filter((e) => e.status === "success").length,
      blocked: list.filter((e) => e.status === "blocked").length,
      below: list.filter((e) => e.status === "below_floor").length,
      onChain: list.filter((e) => e.txHash && !e.txHash.startsWith("sim-")).length,
      sim: list.filter((e) => !e.txHash || e.txHash.startsWith("sim-")).length,
      measured: list.filter(signingLatencyFilter("measured")).length,
    };
  }, [executions]);

  // Submission-channel performance: groups REAL broadcasts by the private
  // relay that carried them (undefined relay = wallet/public RPC channel).
  // Guard-blocked attempts and paper "sim-" trail entries never went out on
  // any channel, so they are excluded — these stats stay honest.
  const relayStats = useMemo(() => {
    const list = (executions ?? []).filter(
      (e) => e.txHash && !e.txHash.startsWith("sim-"),
    );
    const groups = new Map<
      string,
      { total: number; success: number; profitBnb: number; relay?: string }
    >();
    for (const e of list) {
      const key = e.relay ?? "public";
      const g =
        groups.get(key) ?? { total: 0, success: 0, profitBnb: 0, relay: e.relay };
      g.total += 1;
      if (e.status === "success") {
        g.success += 1;
        g.profitBnb += e.amountBnb;
      }
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([key, g]) => ({
        key,
        relay: g.relay,
        host: g.relay ? g.relay.replace(/^https:\/\//, "").split("/")[0] : null,
        total: g.total,
        success: g.success,
        winRate: g.total > 0 ? Math.round((g.success / g.total) * 100) : 0,
        profitBnb: g.profitBnb,
      }))
      .sort((a, b) => b.total - a.total);
  }, [executions]);

  // Real CSV of the FILTERED trail — ISO/UTC timestamps, latency cells
  // empty for extension/wallet-signed rows (unmeasured is not zero).
  const exportCsv = () => {
    const csv = buildHistoryCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashbolt-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(
      `Exported ${filtered.length} execution${filtered.length === 1 ? "" : "s"} to CSV`,
    );
  };

  const handleReset = async () => {
    await resetAccount();
    toast("Paper account reset", {
      description: "Balance restored to 10 BNB — the execution trail stays for reference.",
    });
  };

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      toast.success("Tx hash copied");
      setTimeout(() => setCopiedHash(null), 2000);
    } catch {
      toast.error("Copy failed", {
        description: "Your browser blocked clipboard access.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            FlashBolt Terminal
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
            History
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every paper execution is persisted to your account — it survives
            reloads. On-chain trades show their real receipts (status, block and
            gas) fetched straight from the BNB RPC. Feed prices are live; no
            execution is fabricated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={exportCsv}
            disabled={filtered.length === 0}
          >
            <Download className="size-4" />
            Export CSV
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void handleReset()}>
            <Power className="size-4" />
            Reset paper account
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Total", value: summary.total },
          { label: "Success", value: summary.success },
          { label: "MEV-blocked", value: summary.blocked },
          { label: "Below floor", value: summary.below },
          { label: "On-chain", value: summary.onChain },
          {
            label: "Measured sign avg",
            value:
              signStats.avg !== undefined
                ? signStats.avg < 1
                  ? `${(signStats.avg * 1000).toFixed(0)}µs`
                  : `${signStats.avg.toFixed(1)}ms`
                : "—",
          },
        ].map((s) => (
          <Card key={s.label} className="border-border/70 bg-card/40 shadow-none">
            <CardContent className="py-4">
              <div className="text-2xl font-extrabold text-foreground">{s.value}</div>
              <div className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                {s.label}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {relayStats.length > 0 && (
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-sky-500/12 text-sky-400">
                  <ShieldCheck className="size-4" />
                </div>
                <CardTitle className="text-sm font-semibold">
                  Relay performance
                </CardTitle>
              </div>
              <Badge variant="outline" className="font-mono text-[10px]">
                {relayStats.length} channel{relayStats.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-[11px] leading-4 text-muted-foreground">
              Which submission channel actually carried each broadcast. Private
              relays (Flashbots Protect / bloXroute) hide signed hot-wallet txs
              from the public mempool; scanner flash-loans route through the
              injected wallet's own RPC and are recorded under the wallet
              channel.
            </p>
            {relayStats.map((r) => (
              <div
                key={r.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 p-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {r.relay ? (
                    <span className="relative flex size-2.5 shrink-0">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
                      <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
                    </span>
                  ) : (
                    <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  )}
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "truncate font-mono text-xs font-semibold",
                        r.relay ? "text-sky-400" : "text-foreground/80",
                      )}
                      title={r.relay ?? "injected wallet RPC (eth_sendTransaction)"}
                    >
                      {r.host ?? "wallet / public RPC"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {r.relay ? "private relay — anti-frontrun" : "injected wallet RPC"}
                    </div>
                  </div>
                  {r.relay && <RelaySparkline endpoint={r.relay} />}
                </div>
                <div className="flex items-center gap-4 text-right">
                  <div>
                    <div className="font-mono text-xs font-bold text-foreground">{r.total}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">txs</div>
                  </div>
                  <div>
                    <div
                      className={cn(
                        "font-mono text-xs font-bold",
                        r.winRate >= 50 ? "text-emerald-400" : r.winRate > 0 ? "text-amber-400" : "text-muted-foreground",
                      )}
                    >
                      {r.winRate}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">success rate</div>
                  </div>
                  <div>
                    <div
                      className={cn(
                        "font-mono text-xs font-bold",
                        r.profitBnb > 0 ? "text-emerald-400" : "text-muted-foreground",
                      )}
                    >
                      {r.profitBnb > 0 ? `+${r.profitBnb.toFixed(4)}` : "0.0000"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">profit (BNB)</div>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <ScrollText className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Execution trail
              </CardTitle>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <div className="flex w-full flex-wrap gap-1.5">
                {([
                  ["all", `All (${summary.total})`],
                  ["live", `⛓ Live (${summary.onChain})`],
                  ["sim", `🧪 SIM (${summary.sim})`],
                ] as Array<[KindFilter, string]>).map(([f, label]) => (
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
              <div className="flex w-full flex-wrap gap-1.5">
                {(["all", "success", "blocked", "below_floor", "failed"] as StatusFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                      filter === f
                        ? "bg-primary text-primary-foreground"
                        : "border border-border/70 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f === "all" ? "Any status" : STATUS_META[f].label}
                  </button>
                ))}
              </div>
              <div className="flex w-full flex-wrap gap-1.5">
                {([
                  ["all", "Any latency"],
                  ["measured", `Measured (${summary.measured})`],
                  ["unmeasured", "Unmeasured"],
                ] as Array<[SignLatencyFilter, string]>).map(([f, label]) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setSignFilter(f)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                      signFilter === f
                        ? "bg-violet-500 text-white"
                        : "border border-border/70 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <HistoryIcon className="size-5 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">
                {kind === "sim"
                  ? "No SIM executions yet — run the scanner in paper mode."
                  : kind === "live"
                    ? "No on-chain executions yet — execute a live route from the Scanner."
                    : "No executions yet — open the Scanner and execute a live route."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2.5 pr-4 font-semibold">Time</th>
                    <th className="py-2.5 pr-4 font-semibold">Route</th>
                    <th className="py-2.5 pr-4 font-semibold">Lender</th>
                    <th className="py-2.5 pr-4 font-semibold">Status</th>
                    <th className="py-2.5 pr-4 font-semibold">Submitted via</th>
                    <th className="py-2.5 pr-4 text-right font-semibold">Profit</th>
                    <th className="py-2.5 pr-4 text-right font-semibold">Amount (BNB)</th>
                    <th className="py-2.5 pr-4 text-right font-semibold">Payout</th>
                    <th className="py-2.5 pr-4 text-right font-semibold">Sign</th>
                    <th className="py-2.5 text-right font-semibold">Tx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filtered.map((e) => {
                    const receipt = e.txHash ? receipts[e.txHash] : undefined;
                    const chainMeta = executionChainMeta(e, state?.rpcOverrides);
                    const explorerUrl = chainMeta.explorerUrl;
                    const explorerName = chainMeta.explorer;
                    return (
                      <Fragment key={e._id}>
                        <tr className="hover:bg-background/40">
                          <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                            {new Date(e.ts).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </td>
                          <td className="max-w-[360px] truncate py-3 pr-4 font-mono text-xs text-foreground/90">
                            {e.label}
                            {e.dexes && (
                              <div className="mt-0.5 text-[10px] text-muted-foreground">
                                {e.dexes}
                              </div>
                            )}
                            {e.signingLatencyMs !== undefined && (
                              <div className="mt-0.5 font-mono text-[10px] text-violet-400">
                                {fmtSignLatency(e.signingLatencyMs)}
                              </div>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {e.lender ?? "—"}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <Badge className={STATUS_META[e.status].className}>
                              {STATUS_META[e.status].label}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <span
                              className="max-w-[150px] truncate font-mono text-[10px]"
                              title={e.relay ?? "wallet/public RPC"}
                            >
                              {e.relay ? (
                                <span className="text-sky-400">{e.relay.replace(/^https:\/\//, "").split("/")[0]}</span>
                              ) : (
                                <span className="text-muted-foreground">public</span>
                              )}
                            </span>
                          </td>
                          <td
                            className={cn(
                              "py-3 pr-4 text-right font-mono text-xs font-bold",
                              e.status === "success" ? "text-emerald-400" : "text-muted-foreground",
                            )}
                          >
                            {e.status === "success" ? "+" : ""}
                            {e.profitPct.toFixed(2)}%
                          </td>
                          <td className="py-3 pr-4 text-right font-mono text-xs text-muted-foreground">
                            {e.amountBnb.toFixed(4)}
                          </td>
                          <td className="py-3 text-right font-mono text-xs">
                            {e.payoutBnb ? (
                              <span className="font-bold text-emerald-400">
                                +{e.payoutBnb.toFixed(4)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-right font-mono text-xs">
                            {e.signingLatencyMs !== undefined ? (
                              <span className="text-violet-400">
                                {fmtSignLatency(e.signingLatencyMs)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-3 text-right">
                            {e.txHash ? (
                              <div className="flex flex-col items-end gap-1">
                                <div className="flex items-center gap-1.5">
                                  <a
                                    href={`${explorerUrl}/tx/${e.txHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 font-mono text-[10px] text-primary transition-colors hover:underline"
                                  >
                                    {e.txHash.slice(0, 8)}…
                                    <ExternalLink className="size-3" />
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setOpenTx(openTx === e.txHash ? null : (e.txHash as string))
                                    }
                                    className="rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                                    aria-label="Toggle on-chain receipt"
                                  >
                                    {openTx === e.txHash ? (
                                      <ChevronUp className="size-3.5" />
                                    ) : (
                                      <ChevronDown className="size-3.5" />
                                    )}
                                  </button>
                                </div>
                                {receipt && (
                                  <Badge className={RECEIPT_META[receipt.status].className}>
                                    {RECEIPT_META[receipt.status].label}
                                  </Badge>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                        {e.txHash && openTx === e.txHash && (
                          <tr key={`${e._id}-receipt`} className="bg-background/30">
                            <td colSpan={9} className="px-5 py-3">
                              <div className="rounded-xl border border-border/60 bg-background/50 px-4 py-3">
                                {receipt ? (
                                  <>
                                    <div className="grid gap-x-6 gap-y-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
                                      <div>
                                        <div className="uppercase tracking-wider text-muted-foreground">
                                          Receipt status
                                        </div>
                                        <div className="mt-1">
                                          <Badge className={RECEIPT_META[receipt.status].className}>
                                            {RECEIPT_META[receipt.status].label}
                                          </Badge>
                                        </div>
                                      </div>
                                      <div>
                                        <div className="uppercase tracking-wider text-muted-foreground">
                                          Block
                                        </div>
                                        <div className="mt-1 font-mono text-foreground/90">
                                          {receipt.blockNumber > 0 ? receipt.blockNumber : "—"}
                                        </div>
                                      </div>
                                      <div>
                                        <div className="uppercase tracking-wider text-muted-foreground">
                                          Gas used
                                        </div>
                                        <div className="mt-1 font-mono text-foreground/90">
                                          {receipt.gasUsedBnb !== undefined
                                            ? `${receipt.gasUsedBnb.toFixed(6)} BNB`
                                            : receipt.gasUsed}
                                        </div>
                                      </div>
                                      <div>
                                        <div className="uppercase tracking-wider text-muted-foreground">
                                          Tx hash
                                        </div>
                                        <div className="mt-1 flex items-center gap-1.5">
                                          <code className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                                            {e.txHash}
                                          </code>
                                          <button
                                            type="button"
                                            onClick={() => void copyHash(e.txHash as string)}
                                            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                                            aria-label="Copy full tx hash"
                                          >
                                            {copiedHash === e.txHash ? (
                                              <Check className="size-3.5 text-emerald-400" />
                                            ) : (
                                              <Copy className="size-3.5" />
                                            )}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="mt-2.5">
                                      <a
                                        href={`${explorerUrl}/tx/${e.txHash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary transition-colors hover:underline"
                                      >
                                        View on {explorerName}
                                        <ExternalLink className="size-3" />
                                      </a>
                                    </div>
                                  </>
                                ) : (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin text-primary" />
                                    Fetching the real receipt from the BNB RPC…
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
