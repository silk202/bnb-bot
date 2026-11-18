// FlashBolt Trade — Home page (operator-only exchange terminal).
//
// Portfolio balance across ALL crypto assets + cash currencies valued at
// live rates, quick actions, and a market preview. Deposit flows use real
// receiving details managed by the operator; cash deposits file a claim
// that the operator verifies against the real bank statement.

import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
import { useNavigate } from "react-router";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useAuth } from "@/hooks/use-auth";
import { getGrant } from "@/lib/gate";
import {
  detectWallets,
  connectWallet,
  validateAddress,
  signMessageEvm,
  signMessageSolana,
  type WalletInfo,
} from "@/lib/trade-wallets";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  AtSign,
  Building2,
  CheckCircle2,
  Diamond,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Receipt,
  RefreshCw,
  Smartphone,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  TRADE_ASSETS,
  TRADE_CRYPTO_ASSETS,
  TRADE_CASH_ASSETS,
  TRADE_PAIRS,
  TRADE_NETWORKS,
  BANK_DEPOSIT_CURRENCIES,
  KORA_CURRENCIES,
  currencySymbol,
  fmtTradeAmount,
  fmtTradeUsd,
  tradeDetailKey,
} from "@/convex/tradeAssets";

type OverviewT = {
  balances: Array<{ kind: "crypto" | "cash"; asset: string; available: number; locked: number }>;
  recentTx: Array<{
    _id: string;
    direction: string;
    asset: string;
    amount: number;
    status: string;
    ts: number;
    note?: string;
  }>;
  earn: { activePlans: number; activeAccrued: number; interestEarned: number };
};

export default function TradeHome() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { prices, stale, refresh } = useTradeMarket();
  const overview = useQuery(api.trade.overview, {}) as OverviewT | undefined;
  // Operator-only: blocked only for gate-granted subscribers (guests and
  // operator sign-ins carry no "subscriber" grant).
  const isSubscriber = getGrant()?.role === "subscriber";
  // Kora return path: the hosted QUI-CHKOUT checkout redirects back to
  // /trade-terminal?reference=… — re-sync that reference immediately so a
  // webhook that hasn't landed yet never delays the ledger credit.
  const syncKoraReturn = useAction(api.kora.syncReference);
  useEffect(() => {
    const ref =
      new URLSearchParams(window.location.search).get("reference") ??
      new URLSearchParams(window.location.search).get("kora_reference");
    if (!ref || !ref.startsWith("FB-KORA-")) return;
    window.history.replaceState({}, "", window.location.pathname);
    syncKoraReturn({ reference: ref })
      .then((res) => {
        if (res.status === "success") toast.success("Kora deposit confirmed — your ledger is credited.");
        else if (res.status === "failed") toast.error("Kora reported the deposit failed — nothing was credited.");
        else toast.info("Deposit still pending — it credits automatically the moment Kora confirms the transfer.");
      })
      .catch(() =>
        toast.info("Deposit sync will retry — check your balance again in a minute."),
      );
  }, [syncKoraReturn]);

  const [hideBalances, setHideBalances] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  // ── Portfolio valuation (crypto + all cash currencies, live prices) ──
  const portfolio = useMemo(() => {
    const rows = overview?.balances ?? [];
    let usd = 0;
    const perAsset: Array<{ asset: string; kind: "crypto" | "cash"; total: number; usd: number }> = [];
    for (const b of rows) {
      const total = b.available + b.locked;
      if (total <= 0) continue;
      const assetUsd = (prices?.[b.asset]?.usd ?? 0) * total;
      usd += assetUsd;
      perAsset.push({ asset: b.asset, kind: b.kind, total, usd: assetUsd });
    }
    return { usd, perAsset };
  }, [overview, prices]);

  const cryptoRows = portfolio.perAsset.filter((r) => r.kind === "crypto");
  const cashRows = portfolio.perAsset.filter((r) => r.kind === "cash");

  const marketPreview = TRADE_PAIRS.filter(([, q]) => q === "USDT" || q === "NGN").slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Portfolio balance */}
      <section>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Portfolio Balance
          <button
            type="button"
            onClick={() => setHideBalances((v) => !v)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={hideBalances ? "Show balances" : "Hide balances"}
          >
            {hideBalances ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          {stale && (
            <button type="button" onClick={() => void refresh()} className="text-amber-500 underline-offset-2 hover:underline">
              prices stale — refresh
            </button>
          )}
        </div>
        <div className="mt-1 text-4xl font-extrabold tracking-tight">
          {hideBalances ? "••••" : fmtTradeUsd(portfolio.usd)}
          <span className="ml-2 text-sm font-bold text-muted-foreground">USD</span>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Live market prices {prices ? "· updated" : "· loading…"}
        </div>
      </section>

      {/* Quick actions */}
      <section className="grid grid-cols-4 gap-2">
        {[
          { label: "Deposit", icon: ArrowDownToLine, onClick: () => setDepositOpen(true) },
          { label: "Withdraw", icon: ArrowUpFromLine, onClick: () => setWithdrawOpen(true) },
          { label: "Swap", icon: ArrowLeftRight, onClick: () => navigate("/trade-terminal/trade") },
          { label: "Transaction", icon: Receipt, onClick: () => navigate("/trade-terminal/wallet") },
        ].map(({ label, icon: Icon, onClick }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-card/40 py-4 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <Icon className="size-5" />
            {label}
          </button>
        ))}
      </section>

      {/* Balances: Crypto / Cash */}
      <section className="rounded-xl border border-border/60 bg-card/40">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <span className="text-xs font-semibold text-muted-foreground">Balances</span>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={hideBalances} onCheckedChange={(v) => setHideBalances(v === true)} />
            Hide 0 Balances
          </label>
        </div>
        <BalanceTable cryptoRows={cryptoRows} cashRows={cashRows} hide={hideBalances} />
      </section>

      {/* Market preview */}
      <section className="rounded-xl border border-border/60 bg-card/40">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-primary/15 text-primary hover:bg-primary/15">Hot</Badge>
            <span className="text-xs text-muted-foreground">Live market</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => navigate("/trade-terminal/markets")}>
            View all
          </Button>
        </div>
        <div className="divide-y divide-border/40">
          {marketPreview.map(([base, quote]) => {
            const p = prices?.[base];
            const price = p && prices ? p.usd / (prices[quote]?.usd || 1) : 0;
            const up = (p?.change24hPct ?? 0) >= 0;
            return (
              <button
                key={`${base}${quote}`}
                type="button"
                onClick={() => navigate(`/trade-terminal/trade?pair=${base}${quote}`)}
                className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-accent/40"
              >
                <span className="text-sm font-semibold">
                  {base}
                  <span className="text-xs font-normal text-muted-foreground">/{quote}</span>
                </span>
                <span className="text-sm tabular-nums">
                  {price > 0
                    ? `${quote === "NGN" || quote !== "USDT" ? currencySymbol(quote) : "$"}${fmtTradeAmount(price, quote === "USDT" ? 4 : 2)}`
                    : "—"}
                </span>
                <span className={"flex w-20 items-center justify-end gap-1 text-xs font-semibold " + (up ? "text-emerald-500" : "text-red-500")}>
                  {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                  {up ? "+" : ""}
                  {(p?.change24hPct ?? 0).toFixed(2)}%
                </span>
              </button>
            );
          })}
          {!prices && <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading live prices…</div>}
        </div>
      </section>

      {/* Modals */}
      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        onOpenTransfers={() => setTransferOpen(true)}
        email={user?.email ?? ""}
      />
      <WithdrawModal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} />
      <InternalTransferModal open={transferOpen} onClose={() => setTransferOpen(false)} email={user?.email ?? ""} />
      {isSubscriber && (
        <p className="text-center text-[10px] text-amber-500">
          Subscriber session — FlashBolt Trade is reserved for operator sign-in and guest access.
        </p>
      )}
    </div>
  );
}

function BalanceTable({
  cryptoRows,
  cashRows,
  hide,
}: {
  cryptoRows: Array<{ asset: string; total: number; usd: number }>;
  cashRows: Array<{ asset: string; total: number; usd: number }>;
  hide: boolean;
}) {
  const [tab, setTab] = useState<"crypto" | "cash">("crypto");
  const shown = tab === "crypto" ? cryptoRows : cashRows;
  return (
    <div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as "crypto" | "cash")}>
        <TabsList className="mx-4 mt-3 bg-muted/50">
          <TabsTrigger value="crypto" className="text-xs">Crypto</TabsTrigger>
          <TabsTrigger value="cash" className="text-xs">Cash</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="divide-y divide-border/40 px-4 pb-2 pt-2">
        {shown.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No balances yet — make your first deposit to get started.
          </div>
        )}
        {shown.map((r) => (
          <div key={r.asset} className="flex items-center justify-between py-2.5">
            <div>
              <div className="text-sm font-semibold">{r.asset}</div>
              <div className="text-[10px] text-muted-foreground">{TRADE_ASSETS[r.asset]?.name}</div>
            </div>
            <div className="text-right">
              <div className="text-sm tabular-nums">
                {hide ? "••••" : `${currencySymbol(r.asset)}${fmtTradeAmount(r.total)}`}
              </div>
              <div className="text-[10px] tabular-nums text-muted-foreground">
                {hide ? "••••" : fmtTradeUsd(r.usd)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Deposit modal (real receiving details + claim flow for cash) ───────────

function DepositModal({
  open,
  onClose,
  onOpenTransfers,
  email,
}: {
  open: boolean;
  onClose: () => void;
  onOpenTransfers: () => void;
  email: string;
}) {
  const [view, setView] = useState<"choose" | "crypto" | "cash" | "kora" | "internal">("choose");
  const [asset, setAsset] = useState("USDT");
  const [cashAsset, setCashAsset] = useState("NGN");
  const [amount, setAmount] = useState("");
  const [senderName, setSenderName] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  // Network selection for multi-network assets (USDT/USDC).
  const nets = TRADE_NETWORKS[asset] ?? [];
  const [netId, setNetId] = useState<string>(nets[0]?.id ?? "");
  // Wallet connection state (address-only, real injected providers).
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [connected, setConnected] = useState<{ wallet: WalletInfo["id"]; addr: string } | null>(null);
  // Auto-detection: personal-binding flow state.
  const [bindAddress, setBindAddress] = useState("");
  const [bindingMsg, setBindingMsg] = useState("");
  const [txid, setTxid] = useState("");
  // Cash: my filed deposit claims (history under the account details).
  const myClaims = useQuery(api.trade.listMyDepositClaims, {}) as
    | Array<{ _id: string; asset: string; amount: number; method: string; reference: string; status: string; ts: number }>
    | undefined;
  // Kora instant deposits: my history (tap a reference to re-check it).
  const koraMine = useQuery(api.kora.listMyKoraDeposits, open ? {} : "skip") as
    | Array<{ _id: string; reference: string; asset: string; amount: number; status: string; checkoutUrl: string; failureReason?: string; ts: number }>
    | undefined;

  useEffect(() => {
    if (open) setWallets(detectWallets());
  }, [open]);
  useEffect(() => {
    // Keep the selected network valid when the asset changes.
    const n = TRADE_NETWORKS[asset] ?? [];
    if (!n.some((x) => x.id === netId)) setNetId(n[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  const details = useQuery(api.trade.getDepositDetails, {}) as Record<string, string> | undefined;
  const cryptoDeposit = useMutation(api.trade.requestCryptoDeposit);
  const claimCashDeposit = useMutation(api.trade.claimCashDeposit);
  // Kora instant-deposit rail (QUI-CHKOUT one-time virtual accounts).
  const startKora = useMutation(api.kora.createCheckoutIntent);
  const syncKora = useAction(api.kora.syncReference);
  const [koraStarted, setKoraStarted] = useState<{ reference: string } | null>(null);
  const [koraSyncingRef, setKoraSyncingRef] = useState<string | null>(null);
  // Auto-detection: address, binding, txid fallback and detection history.
  const myAddr = useQuery(
    api.tradeAutoDetection.getMyDepositAddress,
    view === "crypto" ? { asset, netId } : "skip",
  ) as { address: string | null; mode: string | null; canDerive?: boolean; net: { id: string; label: string; explorer: string | null } } | undefined;
  const chainDeposits = useQuery(api.tradeAutoDetection.listMyChainDeposits, {}) as
    | Array<{ _id: string; asset: string; netId: string; txHash: string; amount: number; confirmations: number; credited: boolean; ts: number }>
    | undefined;
  // Dynamic cash receiving account for the selected currency (bank rails).
  const activeAcct = useQuery(
    api.trade.getActiveCashAccount,
    view === "cash" ? { asset: cashAsset } : "skip",
  ) as
    | { _id: string; asset: string; details: string; method: "bank_transfer" | "mobile_money"; ts: number }
    | null
    | undefined;
  const deriveAddr = useMutation(api.tradeAutoDetection.deriveDepositAddress);
  const prepareBinding = useMutation(api.tradeAutoDetection.prepareBinding);
  const confirmBinding = useMutation(api.tradeAutoDetection.confirmBinding);
  const submitTxid = useMutation(api.tradeAutoDetection.submitDepositTxid);

  const close = () => {
    setView("choose");
    setAmount("");
    setSenderName("");
    setReference("");
    setBindAddress("");
    setBindingMsg("");
    setTxid("");
    setKoraStarted(null);
    onClose();
  };

  const submitCrypto = async () => {
    setBusy(true);
    try {
      await cryptoDeposit({ asset, amount: Number(amount) });
      toast.success(`Deposited ${fmtTradeAmount(Number(amount))} ${asset} to your ledger`);
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setBusy(false);
    }
  };

  // Kora QUI-CHKOUT: create the checkout intent, then show the redirect step.
  const startKoraCheckout = async () => {
    setBusy(true);
    try {
      const res = await startKora({ asset: cashAsset, amount: Number(amount) });
      setKoraStarted(res);
      toast.success("Checkout created — complete the transfer in the Korapay window");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the Kora checkout");
    } finally {
      setBusy(false);
    }
  };

  const submitCashClaim = async () => {
    setBusy(true);
    try {
      // The live rotating account's rail is the real custody path — when no
      // account is active yet, fall back to the registry default.
      const method: "bank_transfer" | "mobile_money" =
        activeAcct?.method ??
        (TRADE_CASH_ASSETS.find((a) => a.symbol === cashAsset)?.depositMethod === "mobile_money"
          ? "mobile_money"
          : "bank_transfer");
      const res = await claimCashDeposit({
        asset: cashAsset,
        amount: Number(amount),
        method,
        senderName,
        reference,
      });
      toast.success(`Deposit claim ${res.ref} filed — the operator verifies it against the bank statement`);
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not file deposit claim");
    } finally {
      setBusy(false);
    }
  };

  const detailKey = tradeDetailKey(asset, netId || undefined);
  const cryptoDetail = details?.[detailKey] ?? details?.[asset];
  const cashDetail = details?.[cashAsset];
  // Bank-rail currencies (NGN/GHS/KES/XAF) use dynamic rotating accounts;
  // other cash currencies keep the operator's static published details.
  const isBankRail = (BANK_DEPOSIT_CURRENCIES as readonly string[]).includes(cashAsset);
  const net = nets.find((n) => n.id === netId);
  const connectedMatches =
    connected && net
      ? (net.chainKind === "evm" && ["metamask", "trust", "okx", "bitget"].includes(connected.wallet)) ||
        (net.chainKind === "solana" && ["phantom", "solflare", "backpack"].includes(connected.wallet))
      : false;

  // ── Auto-detection actions ────────────────────────────────────────────

  const derive = async () => {
    setBusy(true);
    try {
      await deriveAddr({ asset });
      toast.success(`Derived a fresh watch-only ${asset} address for this account`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Derivation failed");
    } finally {
      setBusy(false);
    }
  };

  const bind = async () => {
    const addr = (bindAddress || connected?.addr || "").trim();
    if (!net || !addr) {
      toast.error(net ? "Enter or connect the address to bind." : "Pick a network first.");
      return;
    }
    setBusy(true);
    try {
      const { message } = await prepareBinding({ asset, netId, address: addr });
      setBindingMsg(message);
      const sig =
        net.chainKind === "evm"
          ? await signMessageEvm(message)
          : await signMessageSolana(connected?.wallet ?? "phantom", message);
      await confirmBinding({ asset, netId, address: addr, signature: sig });
      toast.success("Address bound — deposits to it are detected automatically");
      setBindingMsg("");
      setBindAddress("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Binding failed");
    } finally {
      setBusy(false);
    }
  };

  const submitTx = async () => {
    if (!txid.trim()) return;
    setBusy(true);
    try {
      await submitTxid({ asset, netId, txHash: txid.trim() });
      toast.success("Transaction submitted — the server verifies it against the chain and credits your ledger");
      setTxid("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit transaction");
    } finally {
      setBusy(false);
    }
  };

  const connect = async (id: WalletInfo["id"]) => {
    try {
      const addr = await connectWallet(id);
      if (addr === null) {
        toast.info("Exchange apps can't be connected — copy the receiving address and withdraw to it from the exchange.");
        return;
      }
      setConnected({ wallet: id, addr });
      toast.success(`${id} connected — your address is filled below`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not connect wallet");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        {view === "choose" ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-center text-lg">Deposit</DialogTitle>
            </DialogHeader>
            <div className="space-y-1">
              <ChoiceRow
                icon={<Diamond className="size-4" />}
                title="Deposit Crypto"
                body="Send on-chain to the operator's receiving address — credits your crypto ledger."
                onClick={() => setView("crypto")}
              />
              <ChoiceRow
                icon={<Zap className="size-4" />}
                title="Instant Bank Deposit"
                body="NGN · GHS · KES · XAF — pay to a one-time Korapay account. Credits your ledger automatically the moment the transfer lands."
                onClick={() => setView("kora")}
              />
              <ChoiceRow
                icon={<Building2 className="size-4" />}
                title="Deposit Cash"
                body="Bank transfer or mobile app to the operator's account — verified & credited by the operator."
                onClick={() => setView("cash")}
              />
              <ChoiceRow
                icon={<AtSign className="size-4" />}
                title="Internal Transfer"
                body="Receive funds from another FlashBolt account by email — instant."
                onClick={() => setView("internal")}
              />
            </div>
          </>
        ) : view === "crypto" ? (
          <>
            <DialogHeader>
              <DialogTitle>Deposit Crypto</DialogTitle>
              <DialogDescription>
                Send to the receiving address below. Credits are applied to your ledger on confirmation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {TRADE_CRYPTO_ASSETS.map((a) => (
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
              {nets.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Network — must match when you send</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {nets.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => setNetId(n.id)}
                        className={
                          "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors " +
                          (netId === n.id
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border/60 text-muted-foreground hover:text-foreground")
                        }
                      >
                        {n.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {asset} · {net?.label ?? "receiving address"}
                </div>
                {cryptoDetail ? (
                  <>
                    <div className="mt-1 break-all font-mono text-xs">{cryptoDetail}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          void navigator.clipboard.writeText(cryptoDetail);
                          toast.success("Address copied");
                        }}
                      >
                        Copy address
                      </Button>
                      {net?.explorer && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => window.open(net.explorer!.replace("{addr}", cryptoDetail), "_blank")}
                        >
                          View on explorer
                        </Button>
                      )}
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      Send from: {net?.wallets.join(", ")}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-xs text-amber-500">
                    The operator has not published a {asset} {net ? net.label : ""} address yet — check back soon.
                  </div>
                )}
              </div>
              {/* Real wallet connection (address-only) */}
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Connect your wallet (address only — never keys)
                  </span>
                  {connected && (
                    <button
                      type="button"
                      className="text-[10px] text-red-400 hover:underline"
                      onClick={() => setConnected(null)}
                    >
                      disconnect
                    </button>
                  )}
                </div>
                {connected ? (
                  <div className="mt-1.5 break-all font-mono text-xs text-emerald-500">
                    {connected.addr}
                    {net && !connectedMatches && (
                      <div className="mt-1 text-[10px] text-amber-500">
                        This wallet family doesn't match {net.label} — use a {net.chainKind} wallet or copy the address above instead.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {wallets.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => void connect(w.id)}
                        className={
                          "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors " +
                          (w.injected
                            ? "border-emerald-500/50 text-emerald-500 hover:bg-emerald-500/10"
                            : "border-border/60 text-muted-foreground hover:text-foreground")
                        }
                        title={w.injected ? "Installed — click to connect" : "Not installed — opens install page flow"}
                      >
                        {w.name}
                        {w.injected ? " ●" : ""}
                      </button>
                    ))}
                  </div>
                )}
                {connected && (
                  <Input
                    className="mt-2 h-9 font-mono text-xs"
                    value={amount === "" && connected ? "" : amount}
                    onChange={(e) => setAmount(e.target.value)}
                    type="number"
                    min="0"
                    placeholder={`Amount of ${asset} you are sending`}
                  />
                )}
              </div>
              {/* Auto-detection: your own verified deposit address */}
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-primary">
                    Auto-detection · deposits credited without manual claims
                  </span>
                  {myAddr?.address && myAddr.net.explorer && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => window.open(myAddr.net.explorer!.replace("{addr}", myAddr.address!), "_blank")}
                    >
                      explorer ↗
                    </button>
                  )}
                </div>
                {myAddr === undefined ? (
                  <div className="mt-1.5 text-xs text-muted-foreground">Checking…</div>
                ) : myAddr.address ? (
                  <>
                    <div className="mt-1 break-all font-mono text-xs text-foreground">{myAddr.address}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-emerald-500">
                        {myAddr.mode === "derived" ? "watch-only derived" : "signature-verified"}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          void navigator.clipboard.writeText(myAddr.address!);
                          toast.success("Deposit address copied");
                        }}
                      >
                        Copy
                      </Button>
                      {myAddr.mode === "personal" && (
                        <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => void bind()} disabled={busy}>
                          Re-bind
                        </Button>
                      )}
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      Watcher scans ~every 2 min · credited at 3 confirmations · idempotent per tx.
                    </div>
                  </>
                ) : (
                  <div className="mt-2 space-y-2">
                    {myAddr.canDerive ? (
                      <Button size="sm" className="h-8 text-xs" onClick={() => void derive()} disabled={busy}>
                        {busy ? "Deriving…" : `Generate ${asset} address (watch-only)`}
                      </Button>
                    ) : (
                      <>
                        <div className="text-[11px] leading-4 text-muted-foreground">
                          Use my own wallet — sign a one-time challenge to prove ownership. The server verifies the
                          signature before storing the binding; keys never leave the wallet.
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Input
                            className="h-8 w-full font-mono text-[11px] sm:w-auto sm:flex-1"
                            value={bindAddress || connected?.addr || ""}
                            onChange={(e) => setBindAddress(e.target.value)}
                            placeholder={`${asset} ${net?.label ?? ""} address`.trim()}
                          />
                          <Button
                            size="sm"
                            className="h-8 text-xs"
                            disabled={
                              busy ||
                              !net ||
                              (net.chainKind !== "evm" && net.chainKind !== "solana") ||
                              !(bindAddress || connected?.addr || "").trim()
                            }
                            onClick={() => void bind()}
                          >
                            {busy ? "Signing…" : "Sign challenge & bind"}
                          </Button>
                        </div>
                        {(bindingMsg || busy) && (
                          <div className="rounded border border-border/60 bg-card/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">
                            {bindingMsg || "Waiting for your wallet…"}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              {!connected && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount received ({asset})</Label>
                  <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
              )}
              {amount !== "" && net && !validateAddress(connected?.addr ?? "1".repeat(40), net) && connected && (
                <div className="text-[10px] text-amber-500">Connected address doesn't look valid for {net.label}.</div>
              )}
              {chainDeposits && chainDeposits.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Detected deposits</div>
                  <div className="mt-1.5 divide-y divide-border/40">
                    {chainDeposits.slice(0, 5).map((d) => (
                      <div key={d._id} className="flex items-center justify-between py-1.5 text-[11px]">
                        <span className="font-mono text-muted-foreground">{d.txHash.slice(0, 10)}…</span>
                        <span className={"font-semibold " + (d.credited ? "text-emerald-500" : "text-amber-500")}>
                          {d.credited
                            ? `+${fmtTradeAmount(d.amount)} ${d.asset}`
                            : d.amount > 0
                              ? "verifying"
                              : "awaiting scan"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Universal fallback: submit a txid for server-side verification */}
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Sent but not detected? Submit the transaction hash
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Input
                    className="h-8 w-full font-mono text-[11px] sm:w-auto sm:flex-1"
                    value={txid}
                    onChange={(e) => setTxid(e.target.value)}
                    placeholder="Transaction hash"
                  />
                  <Button size="sm" className="h-8 text-xs" disabled={busy || txid.trim().length < 10} onClick={() => void submitTx()}>
                    {busy ? "Submitting…" : "Submit"}
                  </Button>
                </div>
                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  The server re-verifies the transfer against the public chain before crediting — requires an active
                  deposit address or binding above.
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={() => void submitCrypto()} disabled={busy || !(Number(amount) > 0)}>
                {busy ? "Working…" : "I've sent — credit my ledger"}
              </Button>
            </DialogFooter>
          </>
        ) : view === "kora" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Zap className="size-4 text-primary" />
                Instant Bank Deposit
              </DialogTitle>
              <DialogDescription>
                Kora Pay issues a ONE-TIME virtual account (e.g. Korapay-QUI-CHKOUT ·
                Sterling Bank) for exactly this amount. Transfer once from your banking
                app — your ledger is credited automatically, no claim needed.
              </DialogDescription>
            </DialogHeader>
            {!koraStarted ? (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {(KORA_CURRENCIES as readonly string[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCashAsset(c)}
                      className={
                        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors " +
                        (cashAsset === c
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border/60 text-muted-foreground hover:text-foreground")
                      }
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount to deposit ({currencySymbol(cashAsset) || cashAsset})</Label>
                  <Input
                    type="number"
                    min="0"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                  />
                  <div className="flex gap-1.5">
                    {[1000, 2000, 5000, 10000, 29000].map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => setAmount(String(v))}
                      >
                        {v.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] leading-4 text-amber-600 dark:text-amber-400">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Info className="size-3.5" />
                    Before you make this transfer
                  </div>
                  <ul className="mt-1.5 list-inside space-y-1">
                    <li>Transfer only the EXACT amount shown at checkout.</li>
                    <li>Do not save or reuse the account — it accepts a single transfer.</li>
                    <li>The one-time account expires after a fixed time.</li>
                    <li>Always send from an account in your own name.</li>
                  </ul>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {(() => {
                  const koraRow = koraMine?.find((r) => r.reference === koraStarted.reference);
                  return (
                    <>
                      <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Checkout created</div>
                        <div className="mt-1 text-lg font-bold">
                          Pay {currencySymbol(cashAsset) || cashAsset} {fmtTradeAmount(Number(amount))}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">ref {koraStarted.reference}</div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        The Korapay checkout shows a one-time account number (e.g. Korapay-QUI-CHKOUT ·
                        Sterling Bank). Transfer the EXACT amount from your banking app — this deposit
                        credits automatically once the transfer is received.
                      </p>
                      <Button
                        className="w-full"
                        disabled={!koraRow?.checkoutUrl}
                        onClick={() => {
                          if (koraRow?.checkoutUrl) window.location.href = koraRow.checkoutUrl;
                        }}
                      >
                        <ExternalLink className="mr-2 size-4" />
                        {koraRow?.checkoutUrl ? "Continue to Korapay checkout" : "Preparing checkout…"}
                      </Button>
                      {koraRow?.status === "failed" && (
                        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] text-red-500">
                          {koraRow.failureReason ?? "Kora could not create this checkout"} — adjust and try again.
                        </div>
                      )}
                    </>
                  );
                })()}
                <Button variant="outline" className="w-full" onClick={close}>
                  I'll pay later — keep the reference
                </Button>
                <p className="text-center text-[10px] text-muted-foreground">
                  Pending deposits appear in your Wallet transactions and settle
                  automatically — or use "Check status now" below.
                </p>
              </div>
            )}
            {koraMine && koraMine.length > 0 && (
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">My instant deposits</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={koraSyncingRef === null}
                    onClick={() => {
                      const ref = koraSyncingRef;
                      if (!ref) return;
                      setKoraSyncingRef(ref);
                      syncKora({ reference: ref })
                        .then((r) => {
                          if (r.status === "success") toast.success("Deposit confirmed — ledger credited.");
                          else if (r.status === "failed") toast.error("Kora reported this deposit failed.");
                          else toast.info("Still pending — Kora hasn't received the transfer yet.");
                        })
                        .catch((e) => toast.error(e instanceof Error ? e.message : "Sync failed"))
                        .finally(() => setKoraSyncingRef(null));
                    }}
                  >
                    <RefreshCw className="mr-1 size-3" />
                    Check status now
                  </Button>
                </div>
                <div className="mt-1.5 divide-y divide-border/40">
                  {koraMine.slice(0, 5).map((d) => (
                    <div key={d._id} className="flex items-center justify-between py-1.5 text-[11px]">
                      <button
                        type="button"
                        className="min-w-0 text-left text-muted-foreground hover:text-foreground"
                        onClick={() => setKoraSyncingRef(d.reference)}
                      >
                        {currencySymbol(d.asset)}{fmtTradeAmount(d.amount)} · {new Date(d.ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                        <span className="ml-1 font-mono text-[9px] opacity-70">{d.reference.slice(8, 20)}</span>
                      </button>
                      <span
                        className={
                          "flex items-center gap-1 font-semibold " +
                          (d.status === "success"
                            ? "text-emerald-500"
                            : d.status === "pending"
                              ? "text-amber-500"
                              : "text-red-500")
                        }
                      >
                        {d.status === "success" && <CheckCircle2 className="size-3" />}
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              {!koraStarted && (
                <Button
                  onClick={() => void startKoraCheckout()}
                  disabled={busy || !(Number(amount) > 0)}
                >
                  {busy ? "Creating checkout…" : `Pay with Kora — ${currencySymbol(cashAsset) || cashAsset}${fmtTradeAmount(Number(amount) || 0)}`}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : view === "cash" ? (
          <>
            <DialogHeader>
              <DialogTitle>Deposit Cash</DialogTitle>
              <DialogDescription>
                Send via {TRADE_CASH_ASSETS.find((a) => a.symbol === cashAsset)?.depositMethod === "mobile_money" ? "mobile money" : "bank transfer"}, then file the reference. The operator verifies it against the real statement before your ledger is credited.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {TRADE_CASH_ASSETS.map((a) => (
                  <button
                    key={a.symbol}
                    type="button"
                    onClick={() => setCashAsset(a.symbol)}
                    className={
                      "rounded-full border px-3 py-1 text-xs font-semibold transition-colors " +
                      (cashAsset === a.symbol
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border/60 text-muted-foreground hover:text-foreground")
                    }
                  >
                    {a.symbol}
                  </button>
                ))}
              </div>
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {cashAsset} {isBankRail ? "receiving account (live)" : TRADE_CASH_ASSETS.find((a) => a.symbol === cashAsset)?.depositMethod === "mobile_money" ? "mobile-money details" : "bank account"}
                </div>
                {isBankRail ? (
                  activeAcct === undefined ? (
                    <div className="mt-1 text-xs text-muted-foreground">Loading account…</div>
                  ) : activeAcct === null ? (
                    <div className="mt-1 text-xs text-amber-500">
                      No {cashAsset} receiving account is active right now — the operator rotates accounts regularly. Check back shortly.
                    </div>
                  ) : (
                    <>
                      <div className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5">{activeAcct.details}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {activeAcct.method === "mobile_money" ? "Mobile money" : "Bank transfer"} · always copy the details from here right before sending
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 h-7 text-xs"
                        onClick={() => {
                          void navigator.clipboard.writeText(activeAcct.details);
                          toast.success("Account details copied");
                        }}
                      >
                        Copy details
                      </Button>
                    </>
                  )
                ) : cashDetail ? (
                  <>
                    <div className="mt-1 whitespace-pre-wrap text-xs leading-5">{cashDetail}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 text-xs"
                      onClick={() => {
                        void navigator.clipboard.writeText(cashDetail);
                        toast.success("Account details copied");
                      }}
                    >
                      Copy details
                    </Button>
                  </>
                ) : (
                  <div className="mt-1 text-xs text-amber-500">
                    The operator has not published {cashAsset} receiving details yet — check back soon.
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Amount sent ({currencySymbol(cashAsset) || cashAsset})</Label>
                <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Sender name on the transfer</Label>
                <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="As it appears on the receipt" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Transfer reference / transaction ID</Label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. TRF-84213…" />
              </div>
              {myClaims && myClaims.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">My deposit claims</div>
                  <div className="mt-1.5 divide-y divide-border/40">
                    {myClaims.slice(0, 5).map((c) => (
                      <div key={c._id} className="flex items-center justify-between py-1.5 text-[11px]">
                        <span className="text-muted-foreground">
                          {currencySymbol(c.asset)}{fmtTradeAmount(c.amount)} · {new Date(c.ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · ref {c.reference.slice(0, 12)}…
                        </span>
                        <span className={"font-semibold " + (c.status === "verified" ? "text-emerald-500" : c.status === "pending" ? "text-amber-500" : "text-red-500")}>
                          {c.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                onClick={() => void submitCashClaim()}
                disabled={busy || !(Number(amount) > 0) || !senderName.trim() || !reference.trim()}
              >
                {busy ? "Filing…" : "File deposit claim"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Internal Transfer</DialogTitle>
              <DialogDescription>The sender needs your registered email — nothing else.</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-border/60 bg-card/50 p-4 text-sm">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Your FlashBolt ID</div>
              <div className="mt-1 break-all font-mono text-sm">{email || "—"}</div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 h-7 text-xs"
                disabled={!email}
                onClick={() => {
                  void navigator.clipboard.writeText(email);
                  toast.success("Email copied");
                }}
              >
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Close</Button>
              <Button
                onClick={() => {
                  close();
                  onOpenTransfers();
                }}
              >
                Send a transfer
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WithdrawModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<"cash" | "crypto">("crypto");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const withdraw = useMutation(api.trade.requestWithdrawal);
  const details = useQuery(api.trade.getDepositDetails, {}) as Record<string, string> | undefined;
  const overview = useQuery(api.trade.overview, {}) as OverviewT | undefined;
  // Wallet connection fills the destination with the real public address.
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [connectedFrom, setConnectedFrom] = useState<string | null>(null);
  const nets = TRADE_NETWORKS[asset] ?? [];
  const [netId, setNetId] = useState<string>(nets[0]?.id ?? "");

  useEffect(() => {
    if (open) setWallets(detectWallets());
  }, [open]);
  useEffect(() => {
    const n = TRADE_NETWORKS[asset] ?? [];
    if (!n.some((x) => x.id === netId)) setNetId(n[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  // Cash payouts go to the user's own bank/mobile-money account; crypto
  // payouts go to their own wallet address. Cash withdrawals ALSO settle
  // through the operator queue (funds debited immediately).
  const avail = overview?.balances.find((b) => b.kind === kind && b.asset === asset);

  const close = () => {
    setAmount("");
    setDestination("");
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await withdraw({ kind, asset, amount: Number(amount) });
      toast.success(
        res.pending
          ? "Withdrawal debited and queued for operator processing"
          : `Withdrew ${fmtTradeAmount(Number(amount))} ${asset}`,
      );
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setBusy(false);
    }
  };

  const isCash = kind === "cash";
  const def = TRADE_ASSETS[asset];
  const net = nets.find((n) => n.id === netId);
  const destLabel = isCash
    ? def?.depositMethod === "mobile_money"
      ? "Mobile-money number (e.g. +254…) — your own account"
      : "Bank account (number · bank · name) — your own account"
    : `Your ${asset} ${net?.label ?? ""} address`.trim();
  const destValid = isCash
    ? destination.trim().length >= 6
    : net
      ? validateAddress(destination, net)
      : destination.trim().length >= 20;

  const connectForWithdraw = async (id: WalletInfo["id"]) => {
    try {
      const addr = await connectWallet(id);
      if (addr === null) {
        toast.info("Exchange apps can't be connected — paste your exchange deposit address instead.");
        return;
      }
      setDestination(addr);
      setConnectedFrom(id);
      toast.success(`${id} connected — destination filled`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not connect wallet");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>
            Funds are debited immediately. Cash payouts and large crypto payouts are processed by the operator to the account you provide.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Tabs value={kind} onValueChange={(v) => setKind(v as "cash" | "crypto")}>
            <TabsList className="w-full bg-muted/50">
              <TabsTrigger value="crypto" className="flex-1 text-xs">Crypto</TabsTrigger>
              <TabsTrigger value="cash" className="flex-1 text-xs">Cash</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap gap-1.5">
            {(isCash ? TRADE_CASH_ASSETS : TRADE_CRYPTO_ASSETS).map((a) => (
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
          {!isCash && nets.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Network — must match the receiving platform</Label>
              <div className="flex flex-wrap gap-1.5">
                {nets.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setNetId(n.id)}
                    className={
                      "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors " +
                      (netId === n.id
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border/60 text-muted-foreground hover:text-foreground")
                    }
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Amount ({asset})</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            <div className="text-[10px] text-muted-foreground">
              Available: {avail ? fmtTradeAmount(avail.available) : "0"} {asset}
            </div>
          </div>
          {!isCash && (
            <div className="rounded-lg border border-border/60 bg-card/50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Connect a wallet to fill the address (or paste it)
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {wallets.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => void connectForWithdraw(w.id)}
                    className={
                      "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors " +
                      (w.injected
                        ? "border-emerald-500/50 text-emerald-500 hover:bg-emerald-500/10"
                        : "border-border/60 text-muted-foreground hover:text-foreground")
                    }
                  >
                    {w.name}
                    {w.injected ? " ●" : ""}
                  </button>
                ))}
              </div>
              {connectedFrom && destination && (
                <div className="mt-1.5 text-[10px] text-emerald-500">
                  Filled from {connectedFrom} — verify it matches {net?.label ?? asset} before submitting.
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">{destLabel}</Label>
            <Input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder={isCash ? "Account details" : "Address"}
              className={!isCash && destination && !destValid ? "border-amber-500/50" : ""}
            />
            {!isCash && destination && !destValid && net && (
              <div className="text-[10px] text-amber-500">
                Doesn't look like a valid {net.label} address — double-check the network.
              </div>
            )}
          </div>
          {isCash && (
            <div className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              Payouts are sent by {def?.depositMethod === "mobile_money" ? "mobile money" : "direct bank transfer"} to the details
              above — typically same-day. You'll see the status move from Pending to Completed in Transactions.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !(Number(amount) > 0) || !destValid}>
            {busy ? "Working…" : "Confirm withdrawal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InternalTransferModal({
  open,
  onClose,
  email,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
}) {
  const [tab, setTab] = useState<"receive" | "send">("send");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const transfer = useMutation(api.trade.internalTransfer);

  const submit = async () => {
    setBusy(true);
    try {
      await transfer({ recipientEmail: recipient, asset, amount: Number(amount), note: note || undefined });
      toast.success(`Sent ${fmtTradeAmount(Number(amount))} ${asset} to ${recipient}`);
      setAmount("");
      setRecipient("");
      setNote("");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Internal Transfer</DialogTitle>
          <DialogDescription>Send or receive funds using a FlashBolt email.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "receive" | "send")}>
          <TabsList className="w-full bg-muted/50">
            <TabsTrigger value="receive" className="flex-1 text-xs">Receive</TabsTrigger>
            <TabsTrigger value="send" className="flex-1 text-xs">Send</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "receive" ? (
          <div className="rounded-lg border border-border/60 bg-card/50 p-4 text-sm">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Your FlashBolt ID</div>
            <div className="mt-1 break-all font-mono text-sm">{email || "—"}</div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => {
                void navigator.clipboard.writeText(email);
                toast.success("Email copied");
              }}
              disabled={!email}
            >
              Copy
            </Button>
          </div>
        ) : (
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
            <div className="space-y-1.5">
              <Label className="text-xs">Note (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For lunch 🍜" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {tab === "send" && (
            <Button onClick={() => void submit()} disabled={busy || !recipient.includes("@") || !(Number(amount) > 0)}>
              {busy ? "Sending…" : "Send transfer"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceRow({
  icon,
  title,
  body,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 border-b border-border/40 px-1 py-4 text-left last:border-0 hover:bg-accent/30"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{title}</span>
        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{body}</span>
      </span>
      <span className="mt-3 text-muted-foreground">›</span>
    </button>
  );
}
