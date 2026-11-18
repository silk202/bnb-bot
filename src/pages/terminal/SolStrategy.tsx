/**
 * SOL Strategy — execution-control settings for the Solana terminal.
 *
 * Mirrors the BNB Strategy page: every value persists through the shared
 * terminal settings mutation, scoped to the SOL venue registry. The venue
 * whitelist is chain-tagged (dexWhitelists.solana) exactly like each EVM
 * chain keeps its own list.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerminal } from "@/hooks/use-terminal";
import { userSafeBackendError } from "@/lib/backend-outage";
import {
  JITO_BLOCK_ENGINES,
  JITO_RELAY_LABEL,
  SOL_CLUSTER_LABEL,
  SOL_RPC_ENDPOINTS,
  resolveSolRpcUrl,
  solSubmissionPath,
  type SolCluster,
} from "@/lib/solana-jito";
import { SOL_DEXES } from "@/lib/solana";
import { SOL_MAX_LOAN_CAP, SOL_MIN_LOAN } from "@/lib/flashbolt";
import { cn } from "@/lib/utils";
import {
  Check,
  Landmark,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function SolStrategy() {
  const { state, setSettings } = useTerminal();

  const [minProfit, setMinProfit] = useState("0.2");
  const [cadence, setCadence] = useState("1");
  // Max SOL loan: strategy default 5 SOL (range 0.05–50 per the 5/50 cap —
  // the floor matches the wallet-fit minimum clip).
  const [maxLoan, setMaxLoan] = useState("5");
  const [slippage, setSlippage] = useState("0.5");
  const [dailyArbTarget, setDailyArbTarget] = useState(0);
  const [dexWhitelist, setDexWhitelist] = useState<string[]>(() =>
    state?.dexWhitelists?.solana ?? SOL_DEXES.map((d) => d.key),
  );
  /* ── Testnet / Mainnet setup ── */
  const [solNetwork, setSolNetwork] = useState<SolCluster>("mainnet");
  const [solRpcOverride, setSolRpcOverride] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync local state when the persisted settings arrive/update.
  useEffect(() => {
    if (state?.minProfit !== undefined) setMinProfit(String(state.minProfit));
    if (state?.cadence !== undefined) setCadence(String(state.cadence));
    if (state?.maxLoan !== undefined) setMaxLoan(String(state.maxLoan));
    if (state?.slippage !== undefined) setSlippage(String(state.slippage));
    if (state?.dailyArbTarget !== undefined) setDailyArbTarget(state.dailyArbTarget);
    const perChain = state?.dexWhitelists?.solana;
    if (perChain && perChain.length > 0) setDexWhitelist(perChain);
    if (state?.solNetwork) setSolNetwork(state.solNetwork);
    if (state?.solRpcOverrides) {
      setSolRpcOverride(
        state.solRpcOverrides[state.solNetwork ?? "mainnet"] ?? "",
      );
    }
  }, [state?.minProfit, state?.cadence, state?.maxLoan, state?.slippage, state?.dexWhitelists, state?.solNetwork, state?.solRpcOverrides]);

  const toggleVenue = (key: string) => {
    setDexWhitelist((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  /**
   * Blur normalization — clamps the typed value into the exact range the
   * save handler enforces, so the visible number is always the number that
   * persists (no silent fallback surprises). Garbage/NaN falls back to the
   * control's default.
   */
  const clampField = (raw: string, min: number, max: number, fallback: number, integer = false): string => {
    const n = Number(raw);
    const v = Number.isFinite(n) ? n : fallback;
    const clamped = Math.min(max, Math.max(min, integer ? Math.round(v) : v));
    return String(clamped);
  };

  /** Slider steps are step-aligned but float arithmetic can yield artifacts
   *  (0.05 × 7 = 0.35000000000000003) — snap to 4 decimals so the label and
   *  the persisted value are always the clean number the operator chose. */
  const stepStr = (v: number): string => String(Number(v.toFixed(4)));

  const handleSave = async () => {
    setSaving(true);
    try {
      await setSettings({
        minProfit: Math.min(5, Math.max(0, Number(minProfit) || 0)),
        // Sub-second cadence floor: 1s keeps the SOL sweep effectively
        // continuous (24/7 sub-second-class re-pricing), clamped to 1–300s.
        cadence: Math.max(1, Math.min(300, Math.round(Number(cadence) || 1))),
        // Loan bounds: min SOL loan 0.05 (wallet-fit floor), max clamped by
        // the 5/50 cap.
        maxLoan: Math.min(SOL_MAX_LOAN_CAP, Math.max(SOL_MIN_LOAN, Number(maxLoan) || 5)),
        slippage: Math.max(0.05, Math.min(5, Number(slippage) || 0.5)),
        dailyArbTarget: Math.max(0, Math.floor(dailyArbTarget || 0)),
        dexWhitelists: {
          ...(state?.dexWhitelists ?? {}),
          solana: dexWhitelist.length > 0 ? dexWhitelist : SOL_DEXES.map((d) => d.key),
        },
        // Testnet / Mainnet setup — cluster + per-cluster RPC override
        // (keyed by cluster: "mainnet" | "testnet").
        solNetwork,
        solRpcOverrides: {
          ...(state?.solRpcOverrides ?? {}),
          [solNetwork]: solRpcOverride.trim(),
        },
      });
      toast.success("SOL strategy saved", {
        description:
          `Cluster ${SOL_CLUSTER_LABEL[solNetwork]} · settings persist across reloads and drive the SOL Scanner's guard stack.`,
      });
    } catch (err) {
      // Honest failure surface — e.g. a paused backend must never vanish as
      // an unhandled rejection; the operator sees exactly what happened.
      toast.error("Could not save strategy settings", {
        description: userSafeBackendError(err, "The settings mutation failed — try again."),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Strategy
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Execution controls for the Solana terminal — venues, guards and lenders
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Venue whitelist */}
        <Card className="border-border/70 bg-card/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="size-4 text-primary" />
              Venue whitelist
              <Badge variant="outline" className="text-[10px]">
                {dexWhitelist.length}/{SOL_DEXES.length} active
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {SOL_DEXES.map((d) => {
              const on = dexWhitelist.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleVenue(d.key)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                    on
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-border/60 bg-background/40 hover:border-primary/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-md border",
                      on ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-400" : "border-border/70 bg-muted/40 text-transparent",
                    )}
                  >
                    <Check className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: d.color }}>
                        {d.key}
                      </span>
                      <span className="truncate text-xs text-foreground/80">{d.name}</span>
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      fee {d.feeLabel} · dexId {d.dexId}
                    </span>
                  </span>
                </button>
              );
            })}
            <p className="text-[10px] text-muted-foreground">
              Routes are priced ONLY on whitelisted venues — cross-venue spreads
              need at least two active venues.
            </p>
          </CardContent>
        </Card>

        {/* Guards + execution */}
        <div className="space-y-4">
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <SlidersHorizontal className="size-4 text-primary" />
                Guards & execution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5">
                  <span className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                    Profit floor (%)
                    <span className="font-mono text-foreground">{minProfit}%</span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    step={0.05}
                    value={minProfit}
                    onChange={(e) => setMinProfit(e.target.value)}
                    onBlur={() => setMinProfit(clampField(minProfit, 0, 5, 0.2))}
                    className="h-8 font-mono text-xs"
                    inputMode="decimal"
                  />
                  <Slider
                    value={[Number(minProfit) || 0]}
                    min={0}
                    max={5}
                    step={0.05}
                    onValueChange={([v]) => setMinProfit(stepStr(v))}
                  />
                  <span className="text-[10px] text-muted-foreground">routes netting less are skipped</span>
                </label>
                <label className="space-y-1.5">
                  <span className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                    Scan cadence (s)
                    <span className="font-mono text-foreground">{cadence}s</span>
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    step={1}
                    value={cadence}
                    onChange={(e) => setCadence(e.target.value)}
                    onBlur={() => setCadence(clampField(cadence, 1, 300, 1, true))}
                    className="h-8 font-mono text-xs"
                    inputMode="numeric"
                  />
                  <Slider
                    value={[Number(cadence) || 1]}
                    min={1}
                    max={300}
                    step={1}
                    onValueChange={([v]) => setCadence(String(Math.round(v)))}
                  />
                  <span className="text-[10px] text-muted-foreground">1s = continuous 24/7 sweep</span>
                </label>
                <label className="space-y-1.5">
                  <span className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                    Max loan (SOL)
                    <span className="font-mono text-foreground">{maxLoan} SOL</span>
                  </span>
                  <Input
                    type="number"
                    min={SOL_MIN_LOAN}
                    max={SOL_MAX_LOAN_CAP}
                    step={0.05}
                    value={maxLoan}
                    onChange={(e) => setMaxLoan(e.target.value)}
                    onBlur={() => setMaxLoan(clampField(maxLoan, SOL_MIN_LOAN, SOL_MAX_LOAN_CAP, 5))}
                    className="h-8 font-mono text-xs"
                    inputMode="decimal"
                  />
                  <Slider
                    value={[Number(maxLoan) || 5]}
                    min={SOL_MIN_LOAN}
                    max={SOL_MAX_LOAN_CAP}
                    step={0.05}
                    onValueChange={([v]) => setMaxLoan(stepStr(v))}
                  />
                  <span className="text-[10px] text-muted-foreground">min {SOL_MIN_LOAN} · cap {SOL_MAX_LOAN_CAP} — per-route borrow scales with liquidity</span>
                </label>
                <label className="space-y-1.5">
                  <span className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                    Slippage (%)
                    <span className="font-mono text-foreground">{slippage}%</span>
                  </span>
                  <Input
                    type="number"
                    min={0.05}
                    max={5}
                    step={0.05}
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value)}
                    onBlur={() => setSlippage(clampField(slippage, 0.05, 5, 0.5))}
                    className="h-8 font-mono text-xs"
                    inputMode="decimal"
                  />
                  <Slider
                    value={[Number(slippage) || 0.5]}
                    min={0.05}
                    max={5}
                    step={0.05}
                    onValueChange={([v]) => setSlippage(stepStr(v))}
                  />
                  <span className="text-[10px] text-muted-foreground">max price movement allowed per swap leg</span>
                </label>
              </div>

              {/* Daily arbitrage target — max flash routes per day (0 = ∞) */}
              <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-foreground">Daily arbitrage target</div>
                    <p className="text-[10px] text-muted-foreground">
                      Max flash-loan routes the SOL scanner executes per day (0 = unlimited) — enforced on auto and
                      manual paths.
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {dailyArbTarget === 0 ? "∞" : dailyArbTarget}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 5, 10, 25, 50].map((n) => (
                    <Button
                      key={n}
                      variant={dailyArbTarget === n ? "default" : "outline"}
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() => setDailyArbTarget(n)}
                    >
                      {n}
                    </Button>
                  ))}
                  <Button
                    variant={dailyArbTarget === 0 ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => setDailyArbTarget(0)}
                  >
                    ∞
                  </Button>
                  <Input
                    value={dailyArbTarget === 0 || [1, 2, 3, 5, 10, 25, 50].includes(dailyArbTarget) ? "" : String(dailyArbTarget)}
                    onChange={(e) => setDailyArbTarget(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    className="h-7 w-20 text-xs"
                    placeholder="X"
                    inputMode="numeric"
                  />
                </div>
              </div>

              {/* Testnet / Mainnet setup — cluster + RPC + submission path */}
              <div className="space-y-3 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-foreground">Network — Testnet / Mainnet</div>
                    <p className="text-[10px] text-muted-foreground">
                      Cluster for the simulation gate, protected submission and all SOL reads.
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {solNetwork === "mainnet" ? "Mainnet-Beta" : "Devnet"}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(["mainnet", "testnet"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setSolNetwork(c)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors",
                        solNetwork === c
                          ? "border-emerald-500/40 bg-emerald-500/5"
                          : "border-border/60 bg-background/40 hover:border-primary/40",
                      )}
                    >
                      <div className="text-xs font-semibold text-foreground">
                        {c === "mainnet" ? "Mainnet" : "Testnet"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {c === "mainnet" ? "mainnet-beta · real funds" : "devnet · airdrop SOL"}
                      </div>
                    </button>
                  ))}
                </div>
                <label className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    RPC override (optional — private / dedicated node)
                  </span>
                  <Input
                    value={solRpcOverride}
                    onChange={(e) => setSolRpcOverride(e.target.value)}
                    className="h-8 text-xs font-mono"
                    placeholder={SOL_RPC_ENDPOINTS[solNetwork]}
                    inputMode="url"
                  />
                  <span className="block text-[10px] text-muted-foreground">
                    Sim gate: <span className="font-mono">{resolveSolRpcUrl(solNetwork, { [solNetwork]: solRpcOverride })}</span>
                  </span>
                </label>
                <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Submission path</div>
                  {solSubmissionPath(solNetwork).relay === "jito" ? (
                    <p className="mt-0.5 text-[11px] text-foreground/90">
                      {JITO_RELAY_LABEL} — {JITO_BLOCK_ENGINES.mainnet.length} regional engines raced
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[11px] text-foreground/90">
                      Public RPC <span className="font-mono">sendTransaction</span> — no dependable devnet block-engine
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
                <div>
                  <div className="text-xs font-semibold text-foreground">Lender balancer</div>
                  <p className="text-[10px] text-muted-foreground">
                    Low-fee lenders first — MarginFi 0% → Kamino 0.05% → Solend 0.3%
                  </p>
                </div>
                <Switch
                  checked={state?.lenderBalancer ?? false}
                  onCheckedChange={(v) => void setSettings({ lenderBalancer: v })}
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
                <div>
                  <div className="text-xs font-semibold text-foreground">Protected submission</div>
                  <p className="text-[10px] text-muted-foreground">
                    {JITO_RELAY_LABEL} · revert protection
                  </p>
                </div>
                <Switch
                  checked={state?.privateSubmit ?? true}
                  onCheckedChange={(v) => void setSettings({ privateSubmit: v })}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Landmark className="size-4 text-primary" />
                Flash-loan lenders
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {[
                { name: "MarginFi", fee: "0%", note: "flash loans free" },
                { name: "Kamino", fee: "0.05%", note: "flash borrow fee" },
                { name: "Solend", fee: "0.3%", note: "flash-loan fee" },
              ].map((l) => (
                <div key={l.name} className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                  <span className="text-xs font-semibold text-foreground">{l.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {l.fee} · {l.note}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <Button
        type="button"
        className="w-full gap-2 sm:w-auto"
        onClick={() => void handleSave()}
        disabled={saving}
      >
        {saving ? <RefreshCw className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        Save SOL strategy
      </Button>
    </div>
  );
}
