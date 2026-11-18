// FlashBolt Trade — Earn page.
//
// Flexible Earn (4.5% APY, withdraw interest anytime) and Fixed Earn
// (7% APY, locked 60–365 days) over the real ledger. Interest accrues
// server-side by elapsed time; the UI projects the live figure between
// accrual passes.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradeMarket } from "@/components/trade/useTradeMarket";
import { TRADE_ASSETS, fmtTradeAmount } from "@/convex/tradeAssets";
import { Coins, Lock, Wallet2 } from "lucide-react";
import { toast } from "sonner";

import type { Id } from "@/convex/_generated/dataModel";

type PlanT = {
  _id: Id<'tradeEarnPlans'>;
  kind: "flexible" | "fixed";
  asset: string;
  principal: number;
  apyPct: number;
  startedAt: number;
  endsAt?: number;
  lastAccrualAt: number;
  accrued: number;
  status: "active" | "closed";
};
type OverviewT = {
  balances: Array<{ kind: "crypto" | "cash"; asset: string; available: number; locked: number }>;
};

const FLEXIBLE_APY = 4.5;
const FIXED_APY = 7;
const YEAR_MS = 365 * 24 * 3_600_000;

export default function TradeEarn() {
  const plans = useQuery(api.trade.listEarnPlans, {}) as PlanT[] | undefined;
  const overview = useQuery(api.trade.overview, {}) as OverviewT | undefined;
  const claim = useMutation(api.trade.claimInterest);
  const closePlan = useMutation(api.trade.closeEarnPlan);
  const { prices } = useTradeMarket();

  const [tab, setTab] = useState<"all" | "flexible" | "fixed" | "history">("all");
  const [subscribeOpen, setSubscribeOpen] = useState(false);

  const active = (plans ?? []).filter((p) => p.status === "active");
  const shown = tab === "all" || tab === "history" ? active : active.filter((p) => p.kind === tab);
  const totalAccrued = active.reduce((s, p) => s + liveAccrued(p), 0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Total Earn Balance
            <span className="text-[10px]">{active.length} active plan(s)</span>
          </div>
          <div className="mt-1 text-2xl font-extrabold tracking-tight">
            ≈ ${fmtTradeAmount(
              active.reduce(
                (s, p) => s + p.principal * (prices?.[p.asset]?.usd ?? 0),
                0,
              ),
              2,
            )}
          </div>
          <div className="text-xs text-emerald-500">
            +{fmtTradeAmount(totalAccrued, 6)} accrued interest (live)
          </div>
        </div>
        <Button onClick={() => setSubscribeOpen(true)} className="rounded-full">
          Create a plan
        </Button>
      </div>

      {/* Promo cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-violet-600 to-violet-900 p-4 text-white">
          <div className="text-sm font-bold leading-5">
            Earn up to <span className="text-amber-300">7% annual interest</span> on your USDT.
          </div>
          <Coins className="absolute -right-2 -top-2 size-20 opacity-30" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border/60 bg-card/50 p-3">
            <Wallet2 className="size-4 text-primary" />
            <div className="mt-1.5 text-xs font-bold">Flexible Earn</div>
            <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {FLEXIBLE_APY}% annual interest with daily payouts and the flexibility to withdraw anytime.
            </div>
          </div>
          <div className="relative rounded-xl border border-border/60 bg-card/50 p-3">
            <Badge variant="outline" className="absolute right-2 top-2 text-[9px]">Open now</Badge>
            <Lock className="size-4 text-primary" />
            <div className="mt-1.5 text-xs font-bold">Fixed Earn</div>
            <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Lock your assets for 60–365 days and earn up to {FIXED_APY}% annual interest.
            </div>
          </div>
        </div>
      </div>

      {/* Plans */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="w-full bg-muted/50">
          <TabsTrigger value="all" className="flex-1 text-xs">All</TabsTrigger>
          <TabsTrigger value="flexible" className="flex-1 text-xs">Flexible</TabsTrigger>
          <TabsTrigger value="fixed" className="flex-1 text-xs">Fixed</TabsTrigger>
          <TabsTrigger value="history" className="flex-1 text-xs">History</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2">
        {shown.length === 0 && (
          <div className="rounded-xl border border-border/60 bg-card/40 py-10 text-center text-xs text-muted-foreground">
            {tab === "history"
              ? "No closed plans yet."
              : "No active plans — create one to start earning."}
          </div>
        )}
        {shown.map((p) => {
          const accrued = liveAccrued(p);
          const matured = p.kind === "fixed" && p.endsAt && Date.now() >= p.endsAt;
          const daysLeft = p.endsAt ? Math.max(0, Math.ceil((p.endsAt - Date.now()) / 86_400_000)) : 0;
          return (
            <div key={p._id} className="rounded-xl border border-border/60 bg-card/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold">
                    {fmtTradeAmount(p.principal)} {p.asset}
                    <Badge variant="outline" className="text-[9px] uppercase">
                      {p.kind} · {p.apyPct}% APY
                    </Badge>
                    {matured && <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">Matured</Badge>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Started {new Date(p.startedAt).toLocaleDateString()}
                    {p.kind === "fixed" && ` · ${daysLeft} day(s) to maturity`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold tabular-nums text-emerald-500">
                    +{fmtTradeAmount(accrued, 6)} {p.asset}
                  </div>
                  <div className="text-[10px] text-muted-foreground">accrued interest</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                {p.kind === "flexible" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[10px]"
                    disabled={accrued <= 0}
                    onClick={() => void act(() => claim({ planId: p._id }), "Interest credited")}
                  >
                    Claim interest
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px]"
                  onClick={() =>
                    void act(() => closePlan({ planId: p._id }), "Plan closed — funds returned")
                  }
                >
                  {p.kind === "fixed" ? (matured ? "Close & withdraw" : "Close early (forfeit)") : "Close plan"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <SubscribeDialog open={subscribeOpen} onClose={() => setSubscribeOpen(false)} overview={overview} />
    </div>
  );
}

/** Live accrued projection between server accrual passes. */
function liveAccrued(p: PlanT): number {
  if (p.status !== "active") return p.accrued;
  if (p.kind === "fixed" && p.endsAt && Date.now() >= p.endsAt) {
    // Full-term interest for matured fixed plans.
    const full = ((p.principal * (p.apyPct / 100) * ((p.endsAt ?? 0) - p.startedAt)) / YEAR_MS);
    return p.accrued + Math.max(0, full - p.accrued);
  }
  const dt = Math.min(Date.now() - p.lastAccrualAt, YEAR_MS);
  return p.accrued + (p.principal * (p.apyPct / 100) * dt) / YEAR_MS;
}

function SubscribeDialog({
  open,
  onClose,
  overview,
}: {
  open: boolean;
  onClose: () => void;
  overview?: OverviewT;
}) {
  const [kind, setKind] = useState<"flexible" | "fixed">("flexible");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("60");
  const [busy, setBusy] = useState(false);
  const create = useMutation(api.trade.createEarnPlan);

  const avail = overview?.balances.find((b) => b.kind === "crypto" && b.asset === asset)?.available ?? 0;
  const apy = kind === "flexible" ? FLEXIBLE_APY : FIXED_APY;

  const submit = async () => {
    setBusy(true);
    try {
      await create({
        kind,
        asset,
        principal: Number(amount),
        days: kind === "fixed" ? Number(days) : undefined,
      });
      toast.success(`${kind === "flexible" ? "Flexible" : "Fixed"} Earn plan created`);
      setAmount("");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create plan");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an Earn plan</DialogTitle>
          <DialogDescription>
            Interest accrues by the minute and is credited to your ledger.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Tabs value={kind} onValueChange={(v) => setKind(v as "flexible" | "fixed")}>
            <TabsList className="w-full bg-muted/50">
              <TabsTrigger value="flexible" className="flex-1 text-xs">Flexible {FLEXIBLE_APY}%</TabsTrigger>
              <TabsTrigger value="fixed" className="flex-1 text-xs">Fixed {FIXED_APY}%</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap gap-1.5">
            {Object.values(TRADE_ASSETS)
              .filter((a) => a.kind === "crypto")
              .map((a) => (
                <button
                  key={a.symbol}
                  type="button"
                  onClick={() => setAsset(a.symbol)}
                  className={
                    "rounded-full border px-3 py-1 text-xs font-semibold transition-colors " +
                    (asset === a.symbol
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground")
                  }
                >
                  {a.symbol}
                </button>
              ))}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Amount ({asset}) — available {fmtTradeAmount(avail)}</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          {kind === "fixed" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Lock period (60–365 days)</Label>
              <Input type="number" min="60" max="365" value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          )}
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            Projected 1-year interest: {fmtTradeAmount(((Number(amount) || 0) * apy) / 100, 4)} {asset}
            {kind === "fixed" && " — paid at maturity"}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !(Number(amount) > 0) || (kind === "fixed" && !(Number(days) >= 60 && Number(days) <= 365))}>
            {busy ? "Creating…" : `Subscribe at ${apy}% APY`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
