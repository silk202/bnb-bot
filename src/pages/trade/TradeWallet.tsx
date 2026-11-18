// FlashBolt Trade — Wallet page (balances + Transactions).
//
// The Transactions view mirrors the reference design: Cash / Crypto /
// Internal Transfer tabs, Deposit | Withdrawal filter, status per row and a
// real CSV download. Data comes straight from the tradeTx ledger.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradeMarket } from "@/components/trade/useTradeMarket";
import { TRADE_ASSETS, currencySymbol, fmtTradeAmount } from "@/convex/tradeAssets";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowLeft, Download, Filter } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

type Kind = "cash" | "crypto" | "internal";
type TxT = {
  _id: Id<'tradeTx'>;
  kind: Kind;
  direction: "deposit" | "withdrawal" | "swap" | "interest" | "transfer_in" | "transfer_out";
  asset: string;
  amount: number;
  status: "pending" | "completed" | "failed";
  ts: number;
  ref: string;
  note?: string;
};

export default function TradeWallet() {
  const navigate = useNavigate();
  const { prices } = useTradeMarket();
  const [kind, setKind] = useState<Kind>("cash");
  const [direction, setDirection] = useState<"deposit" | "withdrawal" | "all">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed" | "failed">("all");
  const [transferOpen, setTransferOpen] = useState(false);

  const overview = useQuery(api.trade.overview, {}) as
    | { balances: Array<{ kind: "crypto" | "cash"; asset: string; available: number; locked: number }> }
    | undefined;
  const txs = useQuery(api.trade.listTx, {
    kind,
    direction: direction === "all" ? undefined : direction,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  }) as TxT[] | undefined;

  const transfer = useMutation(api.trade.internalTransfer);
  const [recipient, setRecipient] = useState("");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const downloadCsv = () => {
    const rows = txs ?? [];
    if (rows.length === 0) {
      toast.info("Nothing to download yet.");
      return;
    }
    const header = "ref,date,direction,asset,amount,status,note";
    const body = rows
      .map((t) =>
        [
          t.ref,
          new Date(t.ts).toISOString(),
          t.direction,
          t.asset,
          t.amount,
          t.status,
          (t.note ?? "").replace(/"/g, "'"),
        ].join(","),
      )
      .join("\n");
    const blob = new Blob([header + "\n" + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashbolt-transactions-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${rows.length} transaction(s)`);
  };

  const sendTransfer = async () => {
    setBusy(true);
    try {
      await transfer({ recipientEmail: recipient, asset, amount: Number(amount) });
      toast.success(`Sent ${fmtTradeAmount(Number(amount))} ${asset} to ${recipient}`);
      setRecipient("");
      setAmount("");
      setTransferOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setBusy(false);
    }
  };

  const cryptoBalances = (overview?.balances ?? []).filter((b) => b.kind === "crypto");
  const cashBalances = (overview?.balances ?? []).filter((b) => b.kind === "cash");

  return (
    <div className="space-y-4">
      {/* Balances summary */}
      <div className="rounded-xl border border-border/60 bg-card/40 p-4">
        <div className="text-xs font-semibold text-muted-foreground">Wallet balances</div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Crypto</div>
            {cryptoBalances.length === 0 && <div className="mt-1 text-xs text-muted-foreground">No balances yet.</div>}
            {cryptoBalances.map((b) => (
              <div key={b.asset} className="mt-1 flex items-center justify-between text-sm">
                <span className="font-semibold">{b.asset}</span>
                <span className="tabular-nums text-muted-foreground">
                  {currencySymbol(b.asset)}{fmtTradeAmount(b.available)}
                  {b.locked > 0 && <span className="text-[10px]"> · {fmtTradeAmount(b.locked)} locked</span>}
                </span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cash</div>
            {cashBalances.length === 0 && <div className="mt-1 text-xs text-muted-foreground">No balances yet.</div>}
            {cashBalances.map((b) => (
              <div key={b.asset} className="mt-1 flex items-center justify-between text-sm">
                <span className="font-semibold">{b.asset}</span>
                <span className="tabular-nums text-muted-foreground">
                  {currencySymbol(b.asset)}{fmtTradeAmount(b.available, 2)}
                  {b.locked > 0 && <span className="text-[10px]"> · {currencySymbol(b.asset)}{fmtTradeAmount(b.locked, 2)} locked</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Transactions */}
      <div className="rounded-xl border border-border/60 bg-card/40">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <button
            type="button"
            onClick={() => navigate("/trade-terminal")}
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="text-sm font-bold">Transactions</span>
          <button
            type="button"
            onClick={downloadCsv}
            className="flex items-center gap-1 text-sm font-semibold text-primary transition-opacity hover:opacity-80"
          >
            <Download className="size-4" />
            Download
          </button>
        </div>

        {/* Kind tabs */}
        <div className="flex justify-center border-b border-border/60 px-4 py-3">
          <Tabs value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <TabsList className="bg-muted/50">
              <TabsTrigger value="cash" className="text-xs">Cash</TabsTrigger>
              <TabsTrigger value="crypto" className="text-xs">Crypto</TabsTrigger>
              <TabsTrigger value="internal" className="text-xs">Internal Transfer</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Direction filter + transfer action */}
        <div className="flex items-center justify-between px-4 py-3">
          <Tabs value={direction} onValueChange={(v) => setDirection(v as typeof direction)}>
            <TabsList className="bg-muted/50">
              <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
              <TabsTrigger value="deposit" className="text-xs">Deposit</TabsTrigger>
              <TabsTrigger value="withdrawal" className="text-xs">Withdrawal</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            {kind === "internal" && (
              <Button size="sm" className="h-7 text-[10px]" onClick={() => setTransferOpen(true)}>
                Send
              </Button>
            )}
            <button
              type="button"
              onClick={() => setFilterOpen(true)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Filter by status"
            >
              <Filter className="size-4" />
            </button>
          </div>
        </div>

        {/* Rows */}
        <div className="space-y-2 px-3 pb-4">
          {(txs ?? []).length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No {kind === "internal" ? "internal transfers" : kind} transactions yet.
            </div>
          )}
          {(txs ?? []).map((t) => {
            const positive =
              t.direction === "deposit" || t.direction === "interest" || t.direction === "transfer_in";
            return (
              <div key={t._id} className="rounded-xl border border-border/50 bg-background/40 px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{t.asset}</span>
                  <span className={"text-sm font-bold tabular-nums " + (positive ? "text-emerald-500" : "text-foreground")}>
                    {positive ? "+" : "−"}
                    {currencySymbol(t.asset)}
                    {fmtTradeAmount(t.amount)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {new Date(t.ts).toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" })}
                    {" | "}
                    {new Date(t.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span
                    className={
                      t.status === "completed"
                        ? "text-emerald-500"
                        : t.status === "pending"
                          ? "text-amber-500"
                          : "text-red-500"
                    }
                  >
                    {t.status === "completed" ? "Completed" : t.status === "pending" ? "Pending" : "Failed"}
                  </span>
                </div>
                {t.note && <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{t.note}</div>}
                <div className="mt-1 font-mono text-[9px] text-muted-foreground/70">{t.ref}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status filter dialog */}
      <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Filter by status</DialogTitle>
            <DialogDescription>Show only transactions in the selected state.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            {(["all", "pending", "completed", "failed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-semibold capitalize " +
                  (statusFilter === s
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border/60 text-muted-foreground")
                }
              >
                {s}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setFilterOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Internal transfer (send) */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send internal transfer</DialogTitle>
            <DialogDescription>Delivers instantly to any FlashBolt email.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Recipient email</Label>
              <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="friend@example.com" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.values(TRADE_ASSETS).map((a) => (
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
              <Label className="text-xs">Amount ({asset})</Label>
              <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOpen(false)}>Cancel</Button>
            <Button onClick={() => void sendTransfer()} disabled={busy || !recipient.includes("@") || !(Number(amount) > 0)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
