/**
 * SOL Multi-Signal Monitor — the Solana twin of the BNB MultiSignalMonitor.
 *
 * Live buyable/sellable Solana token feed from the real market sweep
 * (DexScreener pair search + token profiles + GeckoTerminal new pools — the
 * exact sweep the SOL Scanner's route feed runs), refreshed continuously
 * while visible. Ranks by signal strength (liquidity × freshness), flags
 * brand-new listings, and hands snipe actions to the parent Sniper page,
 * which enforces the /settings daily snipe limit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { sweepSolMarket, type SolFeedCandidate } from "@/hooks/use-sol-live-feed";
import { cn } from "@/lib/utils";
import {
  Bot,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Target,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

const REFRESH_MS = 15_000;

/** Solana-capable discovery sources surfaced as chips (same registry concept
 * as the BNB monitor's 20+ sources, scoped to real Solana coverage). */
const SOL_SOURCES = [
  { id: "dexscreener", label: "DexScreener", on: true },
  { id: "geckoterminal", label: "GeckoTerminal", on: true },
  { id: "raydium", label: "Raydium", on: true },
  { id: "pumpfun", label: "Pump.fun", on: true },
  { id: "gmgn", label: "GMGN", on: true },
  { id: "dexview", label: "DexView", on: true },
  { id: "aveai", label: "Ave.ai", on: true },
  { id: "birdeye", label: "Birdeye", on: false },
  { id: "dexpaprika", label: "DexPaprika", on: false },
] as const;

interface SolMultiSignalMonitorProps {
  visible: boolean;
  /** AUTO approve — new buyable listings snipe on capture without a click. */
  autoApprove?: boolean;
  /** Buy clip in SOL shown on the buttons. */
  buyAmountSol?: number;
  /** Minimum liquidity (USD) for a candidate to be snipeable. */
  minLiquidityUsd?: number;
  /** Parent executor — already guard-stacked + daily-limit-checked. */
  onSnipe: (token: { id: string; symbol: string; address: string; priceUsd: number; liquidityUsd: number }) => void;
}

export default function SolMultiSignalMonitor({
  visible,
  autoApprove = false,
  buyAmountSol = 0.5,
  minLiquidityUsd = 5_000,
  onSnipe,
}: SolMultiSignalMonitorProps) {
  const [tokens, setTokens] = useState<SolFeedCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sound, setSound] = useState(true);
  const [hideScam, setHideScam] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [lastScan, setLastScan] = useState<number | null>(null);
  const knownRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);

  const refresh = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const swept = await sweepSolMarket();
      // Flag brand-new listings for the NEW badge + detection chime.
      const fresh: string[] = [];
      for (const t of swept) {
        if (!knownRef.current.has(t.address)) fresh.push(t.address);
        knownRef.current.add(t.address);
      }
      setTokens(swept);
      setLastScan(Date.now());
      setError(null);
      if (!firstLoadRef.current && fresh.length > 0 && sound) {
        const best = swept.find((t) => fresh.includes(t.address) && t.liquidityUsd >= minLiquidityUsd);
        if (best) {
          toast.success(`New Solana listing: ${best.symbol}`, {
            description: `$${Math.round(best.liquidityUsd).toLocaleString()} liquidity · ${best.priceUsd > 0 ? `$${best.priceUsd.toPrecision(4)}` : "price pending"}`,
          });
        }
      }
      firstLoadRef.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Solana sweep unreachable");
    } finally {
      setLoading(false);
    }
  }, [loading, sound, minLiquidityUsd]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const gated = useMemo(
    () =>
      tokens
        .filter((t) => !hidden.has(t.address))
        .filter((t) => (hideScam ? t.liquidityUsd >= Math.min(1_000, minLiquidityUsd) : true))
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd),
    [tokens, hidden, hideScam, minLiquidityUsd],
  );

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return gated;
    return gated.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.address.toLowerCase().includes(q),
    );
  }, [gated, search]);

  const buyableCount = gated.filter((t) => t.liquidityUsd >= minLiquidityUsd).length;

  const snipe = (t: SolFeedCandidate) => {
    onSnipe({
      id: t.address,
      symbol: t.symbol,
      address: t.address,
      priceUsd: t.priceUsd,
      liquidityUsd: t.liquidityUsd,
    });
  };

  if (!visible) return null;

  return (
    <Card className="border-border/70 bg-card/40">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold">
            <Bot className="size-4 text-primary" />
            Multi-Signal Monitor — Solana
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-500">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              LIVE
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {gated.length} tracked · {buyableCount} buyable
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[10px]"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Real-time buyable/sellable Solana tokens ranked by liquidity and freshness — Raydium, Orca, Meteora,
          PumpSwap listings. Detection runs continuously; snipes pass the daily limit guard in /settings.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Controls bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[140px] flex-1">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tokens or mints..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button
            variant={sound ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => setSound(!sound)}
          >
            {sound ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
            Sound
          </Button>
          <Button
            variant={hideScam ? "destructive" : "outline"}
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => setHideScam(!hideScam)}
          >
            <ShieldAlert className="size-3" />
            {hideScam ? "Hide low-liq" : "Show all"}
          </Button>
        </div>

        {/* Source chips */}
        <div className="flex flex-wrap gap-1">
          {SOL_SOURCES.map((s) => (
            <span
              key={s.id}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px]",
                s.on
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/50 bg-background/30 text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          ))}
        </div>

        {error && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-400">
            {error}
          </p>
        )}

        {/* Token feed */}
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {searched.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              {loading ? "Sweeping Solana markets…" : "No tokens match — adjust search or show all."}
            </p>
          ) : (
            searched.slice(0, 40).map((t) => {
              const snipeable = t.liquidityUsd >= minLiquidityUsd;
              const isNew = lastScan !== null && Date.now() - lastScan < REFRESH_MS && knownRef.current.has(t.address) === false;
              return (
                <div
                  key={t.address}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold">${t.symbol}</span>
                      {isNew && (
                        <span className="rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-bold text-fuchsia-400">
                          NEW
                        </span>
                      )}
                      {snipeable ? (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-500">
                          BUY/SELL
                        </span>
                      ) : (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                          &lt; ${minLiquidityUsd.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{t.address}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.priceUsd > 0 && (
                      <span className="text-[10px] text-muted-foreground">${t.priceUsd.toPrecision(4)}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      ${Math.round(t.liquidityUsd).toLocaleString()}
                    </span>
                    <Button
                      variant={snipeable ? "default" : "outline"}
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={!snipeable}
                      onClick={() => snipe(t)}
                    >
                      <Zap className="size-3" />
                      {buyAmountSol} SOL
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {autoApprove && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-400">
            <Radio className="size-3.5" />
            AUTO approve armed — fresh buyable listings snipe on capture via the parent guard stack
            (liquidity floor → daily limit).
          </div>
        )}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Target className="size-3" />
          {lastScan && `Last sweep ${new Date(lastScan).toLocaleTimeString()} · `}every {REFRESH_MS / 1000}s · 24/7
        </div>
      </CardContent>
    </Card>
  );
}
