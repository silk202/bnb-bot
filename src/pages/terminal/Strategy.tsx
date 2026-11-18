import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerminal } from "@/hooks/use-terminal";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  balancerQueueFor,
  CHAIN_INFO,
  LOAN_ASSET_MIN_LIQUIDITY_USD,
  EXCHANGES,
  FLASH_LENDER_INFO,
  isBscChain,
  lenderFeeLabel,
  lenderForRun,
  type ChainKey,
  type LoanCandidate,
} from "@/lib/flashbolt";
import { cn } from "@/lib/utils";
import {
  Coins,
  Landmark,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Preset = "conservative" | "balanced" | "aggressive";
type GasPriority = "standard" | "fast" | "turbo";

const PRESETS: Record<
  Preset,
  { label: string; minProfit: number; mevGuard: boolean; cadence: number; gas: GasPriority }
> = {
  conservative: { label: "Conservative", minProfit: 0.5, mevGuard: true, cadence: 30, gas: "standard" },
  balanced: { label: "Balanced", minProfit: 0.2, mevGuard: true, cadence: 15, gas: "standard" },
  aggressive: { label: "Aggressive", minProfit: 0.08, mevGuard: false, cadence: 15, gas: "turbo" },
};

const GAS_PRIORITIES: { value: GasPriority; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast" },
  { value: "turbo", label: "Turbo" },
];

export default function Strategy() {
  const { state, setSettings } = useTerminal();
  // Active chain — drives the lender set, DEX whitelist and loan discovery.
  const chainKey: ChainKey = state?.chainKey ?? "bsc";
  const [minProfit, setMinProfit] = useState(() => String(state?.minProfit ?? 0.2));
  // Max BNB loan: strategy default 10 BNB (range 0.1–10 per the 5/10 cap).
  const [maxLoan, setMaxLoan] = useState(() => state?.maxLoan ?? 10);
  const [maxHops, setMaxHops] = useState(() => (state?.maxHops ?? 3) === 2 ? 2 : 3);
  const [ttlWindow, setTtlWindow] = useState(90);
  const [slippage, setSlippage] = useState(() => String(state?.slippage ?? 0.5));
  const [gasPriority, setGasPriority] = useState<GasPriority>(
    () => state?.gasPriority ?? "standard",
  );
  const [mevGuard, setMevGuard] = useState(() => state?.mevGuard ?? true);
  const [autoPayout, setAutoPayout] = useState(() => state?.autoPayout ?? true);
  const [cadence, setCadence] = useState(() => state?.cadence ?? 15);
  // Per-chain DEX whitelist: each chain keeps its own list of AMMs.
  const [dexWhitelist, setDexWhitelist] = useState<string[]>(() => {
    const perChain = state?.dexWhitelists?.[state?.chainKey ?? "bsc"];
    if (perChain && perChain.length > 0) return perChain;
    if (isBscChain(state?.chainKey)) {
      return state?.dexWhitelist ?? EXCHANGES.map((e) => e.key);
    }
    return CHAIN_INFO[state?.chainKey ?? "bsc"].dexes.map((d) => d.key);
  });
  const [lenderBalancer, setLenderBalancer] = useState(
    () => state?.lenderBalancer ?? false,
  );
  const [privateSubmit, setPrivateSubmit] = useState(
    () => state?.privateSubmit ?? true,
  );
  // Multi-asset flash loans: which DISCOVERED quote assets may denominate
  // loans beyond the wrapped native. Persisted with the strategy.
  const [loanAssetsEnabled, setLoanAssetsEnabled] = useState<string[]>(
    () => state?.loanAssets ?? [],
  );

  // One-shot live discovery fetch — which deep quote assets the market
  // currently offers for loan denomination. Runs once per mount (the
  // scanner's continuous feed refreshes it during live scanning).
  const fetchAggregatedSnapshot = useAction(api.marketData.fetchAggregatedSnapshot);
  const [discovered, setDiscovered] = useState<LoanCandidate[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAggregatedSnapshot({ chainKey })
      .then((snap) => {
        if (!cancelled) setDiscovered(snap.loanAssets ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fetchAggregatedSnapshot, chainKey]);

  // Manual re-discovery: the enriched aggregator sources (GeckoTerminal /
  // DexPaprika / …) surface new deep quote assets continuously — one click
  // pulls the freshly discovered list without remounting. Real action call,
  // real market data — nothing cached, nothing mocked.
  const [rediscovering, setRediscovering] = useState(false);
  const rediscoverLoanAssets = async () => {
    setRediscovering(true);
    try {
      const snap = await fetchAggregatedSnapshot({ chainKey });
      setDiscovered(snap.loanAssets ?? []);
    } catch {
      // keep the previous list — the scanner feed refreshes continuously
    } finally {
      setRediscovering(false);
    }
  };

  const chain = CHAIN_INFO[chainKey];
  const chainLenders = chain.lenders;
  const nextLender = lenderForRun(
    state?.scansToday ?? 0,
    lenderBalancer,
    chainLenders,
  );

  // Load the active chain's whitelist whenever the chain switches — the ref
  // guard means it never clobbers the local toggles while editing.
  const lastSyncedChain = useRef<string>("");
  useEffect(() => {
    const current = state?.chainKey ?? "bsc";
    if (lastSyncedChain.current === current) return;
    lastSyncedChain.current = current;
    const perChain = state?.dexWhitelists?.[current];
    if (perChain && perChain.length > 0) setDexWhitelist(perChain);
    else if (isBscChain(current))
      setDexWhitelist(state?.dexWhitelist ?? EXCHANGES.map((e) => e.key));
    else setDexWhitelist(CHAIN_INFO[current].dexes.map((d) => d.key));
  }, [state?.chainKey, state?.dexWhitelists, state?.dexWhitelist]);

  const toggleBalancer = async (on: boolean) => {
    setLenderBalancer(on);
    await setSettings({ lenderBalancer: on }).catch(() => undefined);
    toast(on ? "Lender balancer v enabled" : "Lender balancer v disabled", {
      description: on
        ? "Low-fee lenders now get priority in the rotation before high-fee ones."
        : "Rotation returned to the legacy lender order.",
    });
  };

  const togglePrivateSubmit = async (on: boolean) => {
    setPrivateSubmit(on);
    await setSettings({ privateSubmit: on }).catch(() => undefined);
    toast(on ? "Private submission enabled" : "Private submission disabled", {
      description: on
        ? "Hot-wallet txs go to Flashbots Protect / bloXroute — hidden from the public mempool until inclusion."
        : "Txs return to the standard public RPC broadcast.",
    });
  };

  const applyPreset = (preset: Preset) => {
    const p = PRESETS[preset];
    setMinProfit(String(p.minProfit));
    setMevGuard(p.mevGuard);
    setCadence(p.cadence);
    setGasPriority(p.gas);
    toast(`Applied ${p.label} preset`, {
      description: "Review and save to persist it.",
    });
  };

  const toggleDex = (key: string) => {
    setDexWhitelist((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  // Multi-asset flash loans: the wrapped native is always the base
  // denomination; the toggles add DISCOVERED deep assets (USDT / USDC /
  // BTCB / …) reported by the live feed on ≥2 venues with real depth.
  // Nothing is hard-coded — the list IS the market's own answer.
  const toggleLoanAsset = (symbol: string) => {
    setLoanAssetsEnabled((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol],
    );
  };
  const nativeQuote = chain.quoteSymbol;
  const discoveredExtras = discovered.filter((a) => a.symbol !== nativeQuote);

  const handleSave = async () => {
    // Only symbols the live feed actually discovered can be persisted —
    // unknown/stale entries are dropped so the engine never fabricates a
    // route from a symbol the market does not currently quote.
    const persistableLoanAssets = loanAssetsEnabled.filter((s) =>
      discovered.some((a) => a.symbol === s),
    );
    await setSettings({
      minProfit: Number(minProfit) || 0,
      mevGuard,
      cadence,
      maxLoan,
      maxHops,
      slippage: Number(slippage) || 0,
      gasPriority,
      autoPayout,
      dexWhitelist,
      loanAssets: persistableLoanAssets,
      // Persist the active chain's whitelist (each chain keeps its own).
      dexWhitelists: { ...(state?.dexWhitelists ?? {}), [chainKey]: dexWhitelist },
    });
    toast.success("Strategy saved", {
      description: `Floor ${Number(minProfit) || 0}% · max loan ${maxLoan} ${chain.quoteSymbol} · ${persistableLoanAssets.length > 0 ? `${persistableLoanAssets.length} extra loan asset(s): ${persistableLoanAssets.join(", ")} · ` : "wrapped-native loans only · "}auto-payout ${autoPayout ? "on" : "off"}.`,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Strategy
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Profitability floor, loan sizing, routing constraints and automatic
          payouts. Every setting persists to your account and applies to the
          live feed on the next scan.
        </p>
      </header>

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      {/* Presets */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(PRESETS) as Preset[]).map((preset) => (
          <Button
            key={preset}
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => applyPreset(preset)}
          >
            <Sparkles className="size-4 text-primary" />
            {PRESETS[preset].label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <SlidersHorizontal className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Execution parameters
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                Min profit floor
                <span className="font-mono text-foreground">{minProfit || 0}%</span>
              </label>
              <Input
                type="number"
                min={0}
                max={5}
                step={0.05}
                value={minProfit}
                onChange={(e) => setMinProfit(e.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Routes below this are skipped — the profit gate reverts them.
              </p>
            </div>

            <div className="space-y-3">
              <label className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                Max flash loan
                <span className="font-mono text-foreground">
                  {maxLoan} {chain.quoteSymbol} <span className="text-muted-foreground">(min 0.1 · cap 10)</span>
                </span>
              </label>
              <Slider
                value={[maxLoan]}
                min={0.1}
                max={10}
                step={0.1}
                onValueChange={([v]) => setMaxLoan(v)}
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Each route borrows between the min loan (0.1) and {maxLoan} {chain.quoteSymbol}{" "}
                based on the weakest leg&apos;s liquidity depth, hard-capped at 10.
              </p>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">
                Max routing hops
              </span>
              <div className="grid grid-cols-2 gap-2">
                {([2, 3] as const).map((n) => (
                  <Button
                    key={n}
                    type="button"
                    variant={maxHops === n ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMaxHops(n)}
                  >
                    {n} hops
                  </Button>
                ))}
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                2 hops: {nativeQuote}→token→{nativeQuote} · 3 hops: {nativeQuote}→A→B→{nativeQuote} across different
                DEXs.
              </p>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">
                Opportunity TTL window
              </span>
              <div className="grid grid-cols-3 gap-2">
                {[60, 90, 120].map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant={ttlWindow === s ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTtlWindow(s)}
                  >
                    {s}s
                  </Button>
                ))}
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                Routes auto-expire after this window — no stale fills.
              </p>
            </div>

            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                Slippage tolerance
                <span className="font-mono text-foreground">
                  {slippage || 0}%
                </span>
              </label>
              <Input
                type="number"
                min={0.1}
                max={3}
                step={0.1}
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Max price impact accepted per leg before the route is skipped.
              </p>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">
                Gas priority
              </span>
              <div className="grid grid-cols-3 gap-2">
                {GAS_PRIORITIES.map((g) => (
                  <Button
                    key={g.value}
                    type="button"
                    variant={gasPriority === g.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setGasPriority(g.value)}
                  >
                    {g.label}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                Standard ~1 gwei · Fast ~2 gwei · Turbo prioritizes inclusion
                over cost.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 p-3.5">
              <div>
                <div className="text-sm font-semibold text-foreground">MEV guard</div>
                <div className="text-[11px] leading-4 text-muted-foreground">
                  Blocks routes scoring MEV ≥ 70
                </div>
              </div>
              <Switch checked={mevGuard} onCheckedChange={setMevGuard} />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-sky-500/25 bg-sky-500/10 p-3.5">
              <div>
                <div className="text-sm font-semibold text-foreground">Private submission (anti-MEV)</div>
                <div className="text-[11px] leading-4 text-muted-foreground">
                  Hot-wallet txs go to Flashbots Protect / bloXroute — hidden
                  from the public mempool until inclusion; reverted txs never
                  land on chain (zero gas). Chains without a relay fall back
                  to the public RPC honestly.
                </div>
              </div>
              <Switch checked={privateSubmit} onCheckedChange={togglePrivateSubmit} />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3.5">
              <div className="flex items-start gap-2.5">
                <Wallet className="mt-0.5 size-4 text-emerald-400" />
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Automatic payout
                  </div>
                  <div className="text-[11px] leading-4 text-muted-foreground">
                    Every successful flash-loan execution immediately pays the
                    profit out to your connected wallet.
                  </div>
                </div>
              </div>
              <Switch checked={autoPayout} onCheckedChange={setAutoPayout} />
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="border-border/70 bg-card/40 shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">
                Scan cadence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {[15, 30, 60].map((c) => (
                  <Button
                    key={c}
                    type="button"
                    variant={cadence === c ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCadence(c)}
                  >
                    {c}s
                  </Button>
                ))}
              </div>
              <Button type="button" className="w-full" onClick={() => void handleSave()}>
                Save strategy
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/40 shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Landmark className="size-4" />
                </div>
                <CardTitle className="text-sm font-semibold">
                  Flash-loan lender rotation
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] leading-4 text-muted-foreground">
                The borrower switches with every scan run so no single lender
                pool is drained — scoped to lenders that actually deploy on{" "}
                {chain.label}. Next run borrows from:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {chainLenders.map((lender) => (
                  <span
                    key={lender}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                      lender === nextLender
                        ? "bg-primary text-primary-foreground"
                        : "border border-border/60 text-muted-foreground",
                    )}
                  >
                    {lender}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Run #{state?.scansToday ?? 0} →{" "}
                <span className="font-mono text-foreground">{nextLender}</span>
                {lenderBalancer && (
                  <>
                    {" "}· balancer v{" "}
                    <span className="font-mono text-primary">
                      {lenderFeeLabel(nextLender)}
                    </span>{" "}
                    fee
                  </>
                )}
              </p>
            </CardContent>
          </Card>

          <Card
            className={cn(
              "shadow-none transition-colors",
              lenderBalancer
                ? "border-emerald-500/30 bg-emerald-500/8"
                : "border-border/70 bg-card/40",
            )}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Scale className="size-4" />
                </div>
                <CardTitle className="text-sm font-semibold">
                  Lender balancer v
                </CardTitle>
                <Badge className="ml-1 border-amber-500/30 bg-amber-500/10 text-amber-400">
                  LOW-FEE PRIORITY
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[11px] leading-4 text-muted-foreground">
                Prioritizes flash-loan lenders with the lowest documented fees
                before those with high fees, so more of each edge survives the
                loan fee. Fees are the protocols&apos; real documented rates —
                nothing estimated:
              </p>
              <div className="space-y-1.5">
                {[...FLASH_LENDER_INFO]
                  .sort((a, b) => a.feePct - b.feePct)
                  .map((info) => (
                    <div
                      key={info.name}
                      className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-1.5"
                    >
                      <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <span className="size-1.5 rounded-full bg-primary" />
                        {info.name}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {info.feeLabel}
                      </span>
                    </div>
                  ))}
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 p-3.5">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Balancer v
                  </div>
                  <div className="text-[11px] leading-4 text-muted-foreground">
                    {lenderBalancer
                      ? "Active — priority queue: " + balancerQueueFor(chainLenders).join(" → ")
                      : "Off — rotation uses the legacy lender order."}
                  </div>
                </div>
                <Switch
                  checked={lenderBalancer}
                  onCheckedChange={(checked) => void toggleBalancer(checked)}
                  aria-label="Toggle lender balancer v"
                />
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              "shadow-none transition-colors",
              loanAssetsEnabled.length > 0
                ? "border-primary/30 bg-primary/8"
                : "border-border/70 bg-card/40",
            )}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Coins className="size-4" />
                </div>
                <CardTitle className="text-sm font-semibold">
                  Flash-loan denomination
                </CardTitle>
                {loanAssetsEnabled.length > 0 && (
                  <Badge className="ml-1 border-primary/30 bg-primary/10 text-primary">
                    {loanAssetsEnabled.length + 1} ASSET
                    {loanAssetsEnabled.length + 1 === 1 ? "" : "S"}
                  </Badge>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto gap-1.5 px-2.5 text-[11px]"
                  disabled={rediscovering}
                  onClick={() => void rediscoverLoanAssets()}
                  aria-label="Rediscover loan assets from live market data"
                >
                  <RefreshCw className={cn("size-3", rediscovering && "animate-spin")} />
                  {rediscovering ? "Scanning" : "Rediscover"}
                </Button>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                Flash loans settle in {nativeQuote} by default. Discovered quote
                assets with deep {nativeQuote} pairs on ≥2 whitelisted venues
                (V2 pairs flash-swap either side) can also denominate loans —
                unlocking more arbitrage pairs. Nothing hard-coded: the list is
                what the live market currently reports.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {discovered.length === 0 ? (
                <p className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
                  Discovering loan assets from live pool data…
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <span className="size-2.5 rounded-full bg-primary" />
                      <span className="text-sm font-medium text-foreground">
                        {nativeQuote}
                      </span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        settlement asset
                      </Badge>
                    </span>
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-400"
                    >
                      ALWAYS ON
                    </Badge>
                  </div>
                  {discoveredExtras.map((asset) => {
                    const enabled = loanAssetsEnabled.includes(asset.symbol);
                    return (
                      <button
                        key={asset.symbol}
                        type="button"
                        onClick={() => toggleLoanAsset(asset.symbol)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                          enabled
                            ? "border-primary/40 bg-primary/8 hover:border-primary/60"
                            : "border-border/60 bg-background/40 hover:border-primary/40",
                        )}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              "size-2.5 rounded-full",
                              enabled ? "bg-primary" : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="text-sm font-medium text-foreground">
                            {asset.symbol}
                          </span>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {asset.venues} venue{asset.venues === 1 ? "" : "s"}
                          </Badge>
                        </span>
                        <Switch
                          checked={enabled}
                          onCheckedChange={() => toggleLoanAsset(asset.symbol)}
                          aria-label={`Toggle ${asset.symbol} loan denomination`}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="pt-1 text-[11px] text-muted-foreground">
                {discoveredExtras.length > 0
                  ? `Deepest-first · ${nativeQuote}-pair liquidity must exceed the $${LOAN_ASSET_MIN_LIQUIDITY_USD.toLocaleString()} discovery floor. Changes apply on the next scan after saving.`
                  : "No qualifying deep quote assets right now — wrapped-native loans continue meanwhile."}
              </p>
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/40 shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">
                DEX whitelist
              </CardTitle>
              <p className="text-[11px] leading-4 text-muted-foreground">
                Which {chain.label} AMMs the scanner may route through. Routes
                always cross at least two different DEXs, and each chain keeps
                its own whitelist.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {chain.dexes.map((dex) => {
                const enabled = dexWhitelist.includes(dex.key);
                return (
                  <button
                    key={dex.key}
                    type="button"
                    onClick={() => toggleDex(dex.key)}
                    className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5 text-left transition-colors hover:border-primary/40"
                  >
                    <span className="flex items-center gap-2.5">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ background: dex.color }}
                      />
                      <span className="text-sm font-medium text-foreground">
                        {dex.name}
                      </span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {(dex.fee * 100).toFixed(2)}% fee
                      </Badge>
                    </span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={() => toggleDex(dex.key)}
                      aria-label={`Toggle ${dex.name}`}
                    />
                  </button>
                );
              })}
              <p className="pt-1 text-[11px] text-muted-foreground">
                Changes apply on the next scan — the Scanner reads{" "}
                <span className="font-mono">dexWhitelists[{chainKey}]</span>.
              </p>
            </CardContent>
          </Card>

          <Card className="border-primary/25 bg-primary/8 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-primary">
                Active strategy
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <span>Floor</span>
                <span className="font-mono text-foreground">{minProfit || 0}%</span>
              </div>
              <div className="flex justify-between">
                <span>Max loan</span>
                <span className="font-mono text-foreground">
                  {maxLoan} {chain.quoteSymbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span>MEV guard</span>
                <span className="font-mono text-foreground">
                  {mevGuard ? "on" : "off"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Auto-payout</span>
                <span className="font-mono text-foreground">
                  {autoPayout ? "on" : "off"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Cadence</span>
                <span className="font-mono text-foreground">{cadence}s</span>
              </div>
              <div className="flex justify-between">
                <span>Gas</span>
                <span className="font-mono text-foreground">{gasPriority}</span>
              </div>
              <div className="flex justify-between">
                <span>Max hops</span>
                <span className="font-mono text-foreground">{maxHops}</span>
              </div>
              <div className="flex justify-between">
                <span>Chain</span>
                <span className="font-mono text-foreground">{chain.label}</span>
              </div>
              <div className="flex justify-between">
                <span>DEXs</span>
                <span className="font-mono text-foreground">
                  {dexWhitelist.length} of {chain.dexes.length} whitelisted
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3.5 py-2.5 text-[11px] text-muted-foreground">
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
              REAL DATA
            </Badge>
            Feed prices are live — nothing here is simulated.
          </div>
        </div>
      </div>
    </div>
  );
}
