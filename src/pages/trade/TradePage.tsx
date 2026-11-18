// FlashBolt Trade — Trade page (Instant Swap + Order Book).
//
// Instant Swap executes atomically against the live cached rate with a
// disclosed 0.1% fee. Order Book places real limit orders that lock funds
// immediately and fill by the cron scan when the live market crosses the
// limit. Both flows are wired to the same Convex ledger as the rest of the
// terminal.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradeMarket } from "@/components/trade/useTradeMarket";
import {
  TRADE_ASSETS,
  TRADE_PAIRS,
  currencySymbol,
  fmtTradeAmount,
  tradeCrossRate,
} from "@/convex/tradeAssets";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowDownUp, ChevronDown, Info } from "lucide-react";
import { toast } from "sonner";

type OverviewT = {
  balances: Array<{ kind: "crypto" | "cash"; asset: string; available: number; locked: number }>;
};
type OrderT = {
  _id: Id<'tradeOrders'>;
  side: "buy" | "sell";
  base: string;
  quote: string;
  price: number;
  amount: number;
  filled: number;
  status: "open" | "filled" | "canceled";
  ts: number;
};

const SWAP_FEE_PCT = 0.1;

export default function TradePage() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<"instant" | "order">("instant");
  const pairParam = params.get("pair") ?? "";

  const pair = useMemo(() => {
    const known = TRADE_PAIRS.find(([b, q]) => `${b}${q}` === pairParam);
    return known ? `${known[0]}/${known[1]}` : "BTC/USDT";
  }, [pairParam]);

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h1 className="text-xl font-extrabold tracking-tight">Trade</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Buy or sell instantly at the current market price — or set your own terms.
        </p>
      </div>

      {/* Mode selector */}
      <div className="grid gap-2">
        <ModeRow
          active={mode === "instant"}
          onClick={() => setMode("instant")}
          icon={<ArrowDownUp className="size-4" />}
          title="Instant Swap"
          body="Swap any two assets instantly (Cash and Crypto)"
        />
        <ModeRow
          active={mode === "order"}
          onClick={() => setMode("order")}
          icon={<span className="text-xs font-bold">◫</span>}
          title="Order Book"
          body="Buy or sell crypto on your terms"
        />
      </div>

      {mode === "instant" ? (
        <InstantSwap pair={pair} />
      ) : (
        <OrderBook pair={pair} />
      )}

      <button
        type="button"
        onClick={() => setParams({ pair })}
        className="mx-auto block text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        Working pair: {pair} (set from Markets)
      </button>
    </div>
  );
}

function ModeRow({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-4 py-4 text-left transition-colors " +
        (active ? "border-primary/60 bg-primary/5" : "border-border/60 bg-card/40 hover:border-primary/40")
      }
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
      {active && <Badge className="bg-primary/15 text-primary hover:bg-primary/15">Selected</Badge>}
    </button>
  );
}

// ── Instant Swap ───────────────────────────────────────────────────────────

function InstantSwap({ pair }: { pair: string }) {
  const { prices, refresh } = useTradeMarket();
  const overview = useQuery(api.trade.overview, {}) as OverviewT | undefined;
  const swap = useMutation(api.trade.swap);
  const [from, setFrom] = useState("USDT");
  const [to, setTo] = useState("BTC");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  // Preselect from the working pair when it changes.
  useEffect(() => {
    const [b, q] = pair.split("/");
    setFrom(b);
    setTo(q);
  }, [pair]);

  const rate = prices ? tradeCrossRate(prices, from, to) : 0;
  const amt = Number(amount) || 0;
  const grossTo = amt * rate;
  const fee = grossTo * (SWAP_FEE_PCT / 100);
  const netTo = grossTo - fee;

  const bal = overview?.balances.find(
    (b) => b.kind === (from === "USDT" ? "crypto" : TRADE_ASSETS[from]?.kind === "cash" ? "cash" : "crypto") &&
      b.asset === from,
  );

  const pctButtons = [10, 25, 50, 75, 100];
  const applyPct = (pct: number) => {
    const avail = bal?.available ?? 0;
    setAmount(String(Number((avail * pct) / 100).toFixed(6)));
  };

  const doSwap = async () => {
    setBusy(true);
    try {
      await refresh(); // freshest rate before executing
      const res = await swap({ from, to, amount: amt });
      toast.success(`Received ${fmtTradeAmount(res.received)} ${to} (rate ${fmtTradeAmount(res.rate, 4)})`);
      setAmount("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Swap failed");
    } finally {
      setBusy(false);
    }
  };

  const flip = () => {
    setFrom(to);
    setTo(from);
    setAmount("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        The displayed value is estimated based on current market prices. Your final swap rate may vary.
      </div>

      <div className="relative space-y-1">
        <SwapBox
          label="From"
          asset={from}
          onAsset={(a) => setFrom(a)}
          amount={amount}
          onAmount={setAmount}
          avail={bal?.available ?? 0}
          valueUsd={prices?.[from] ? amt * (prices[from].usd ?? 0) : 0}
        />
        <div className="relative z-10 mx-auto -my-3 w-fit">
          <button
            type="button"
            onClick={flip}
            className="flex size-10 items-center justify-center rounded-full border bg-background shadow-md transition-transform hover:scale-105"
            aria-label="Flip swap direction"
          >
            <ArrowDownUp className="size-4" />
          </button>
        </div>
        <SwapBox
          label="To"
          asset={to}
          onAsset={(a) => setTo(a)}
          amount={netTo > 0 ? netTo.toFixed(6) : ""}
          readOnly
          avail={undefined}
          valueUsd={prices?.[to] ? netTo * (prices[to].usd ?? 0) : 0}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {pctButtons.map((p) => (
          <Button key={p} variant="outline" size="sm" className="flex-1 text-xs" onClick={() => applyPct(p)}>
            {p === 100 ? "Max" : `${p}%`}
          </Button>
        ))}
      </div>

      {rate > 0 && (
        <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
          1 {from} ≈ {fmtTradeAmount(rate, 6)} {to} · fee {SWAP_FEE_PCT}% ({fmtTradeAmount(fee, 6)} {to})
        </div>
      )}

      <Button
        className="w-full"
        size="lg"
        disabled={busy || !(amt > 0) || from === to || rate <= 0}
        onClick={() => void doSwap()}
      >
        {busy ? "Swapping…" : "Confirm swap"}
      </Button>
      {!prices && <div className="text-center text-xs text-muted-foreground">Loading live prices…</div>}
    </div>
  );
}

function SwapBox({
  label,
  asset,
  onAsset,
  amount,
  onAmount,
  readOnly,
  avail,
  valueUsd,
}: {
  label: string;
  asset: string;
  onAsset: (a: string) => void;
  amount: string;
  onAmount?: (v: string) => void;
  readOnly?: boolean;
  avail?: number;
  valueUsd: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {typeof avail === "number" && <span>Available: {fmtTradeAmount(avail)} {asset}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded-lg bg-muted/60 px-3 py-2 text-sm font-bold"
        >
          {asset}
          <ChevronDown className="size-3.5" />
        </button>
        <Input
          className="border-0 bg-transparent text-right text-2xl font-bold tabular-nums focus-visible:ring-0"
          type="number"
          min="0"
          placeholder="0.00"
          value={amount}
          readOnly={readOnly}
          onChange={(e) => onAmount?.(e.target.value)}
        />
      </div>
      <div className="mt-1 text-right text-[10px] text-muted-foreground">
        ≈ ${fmtTradeAmount(valueUsd, 2)}
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {Object.values(TRADE_ASSETS).map((a) => (
            <button
              key={a.symbol}
              type="button"
              onClick={() => {
                onAsset(a.symbol);
                setOpen(false);
              }}
              className={
                "rounded-lg border px-2 py-1.5 text-xs font-semibold " +
                (a.symbol === asset
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border/60 hover:border-primary/40")
              }
            >
              {a.symbol}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Order Book ─────────────────────────────────────────────────────────────

function OrderBook({ pair }: { pair: string }) {
  const { prices } = useTradeMarket();
  const overview = useQuery(api.trade.overview, {}) as OverviewT | undefined;
  const orders = useQuery(api.trade.listOrders, { status: "open" }) as OrderT[] | undefined;
  const placeOrder = useMutation(api.trade.placeOrder);
  const cancelOrder = useMutation(api.trade.cancelOrder);

  const [base, quote] = pair.split("/");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const market = prices && prices[base] && prices[quote]
    ? prices[base].usd / prices[quote].usd
    : 0;

  useEffect(() => {
    if (market > 0 && !price) setPrice(market.toPrecision(6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  const p = Number(price) || 0;
  const amt = Number(amount) || 0;
  const total = p * amt;
  const lockedAsset = side === "buy" ? quote : base;
  const bal = overview?.balances.find(
    (b) =>
      b.kind === (lockedAsset === "USDT" ? "crypto" : TRADE_ASSETS[lockedAsset]?.kind === "cash" ? "cash" : "crypto") &&
      b.asset === lockedAsset,
  );

  const submit = async () => {
    setBusy(true);
    try {
      await placeOrder({ side, base, quote, price: p, amount: amt });
      toast.success(`${side === "buy" ? "Buy" : "Sell"} order placed — funds locked until it fills`);
      setAmount("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not place order");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: Id<'tradeOrders'>) => {
    try {
      await cancelOrder({ orderId: id });
      toast.success("Order canceled — funds released");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel");
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card/40 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold">{pair} · Limit</span>
          {market > 0 && (
            <span className="text-xs text-muted-foreground">
              Market: {currencySymbol(quote) || (quote === "USDT" ? "$" : "")}
              {fmtTradeAmount(market, quote === "USDT" ? 4 : 2)}
            </span>
          )}
        </div>
        <Tabs value={side} onValueChange={(v) => setSide(v as "buy" | "sell")} className="mt-3">
          <TabsList className="w-full bg-muted/50">
            <TabsTrigger value="buy" className="flex-1 text-xs text-emerald-500">Buy</TabsTrigger>
            <TabsTrigger value="sell" className="flex-1 text-xs text-red-500">Sell</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Limit price ({quote})</Label>
            <Input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Amount ({base})</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            <div className="text-[10px] text-muted-foreground">
              {side === "buy" ? "Total cost" : "You receive"}: {fmtTradeAmount(total, 4)} {quote}
              {bal && ` · Available ${lockedAsset}: ${fmtTradeAmount(bal.available)}`}
            </div>
          </div>
          <Button
            className={"w-full " + (side === "buy" ? "" : "")}
            variant={side === "buy" ? "default" : "destructive"}
            disabled={busy || !(p > 0) || !(amt > 0)}
            onClick={() => void submit()}
          >
            {busy ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${base}`}
          </Button>
        </div>
      </div>

      {/* Open orders */}
      <div className="rounded-xl border border-border/60 bg-card/40">
        <div className="border-b border-border/60 px-4 py-3 text-sm font-bold">Open orders</div>
        <div className="divide-y divide-border/40">
          {(orders ?? []).length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No open orders. Limit orders fill automatically when the market crosses your price.
            </div>
          )}
          {(orders ?? []).map((o) => (
            <div key={o._id} className="flex items-center justify-between px-4 py-3 text-xs">
              <div>
                <div className="font-semibold">
                  <span className={o.side === "buy" ? "text-emerald-500" : "text-red-500"}>
                    {o.side.toUpperCase()}
                  </span>{" "}
                  {o.base}/{o.quote}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtTradeAmount(o.amount - o.filled)} @ {fmtTradeAmount(o.price, 4)} {o.quote}
                </div>
              </div>
              <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => void cancel(o._id)}>
                Cancel
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
