/**
 * Multi-Signal Monitor — real-time token feed from 20+ sources.
 *
 * Sources: four.meme, flap.sh, pump.fun, tokenscan.io, tokensniffer.com,
 * stonkfun.xyz, ponsv2, brew.family, raydium, moonshot, dextools, ave.ai,
 * dexscreener, gecko terminal, birdeye, arbimate.co, yieldo.me,
 * arbitragescanner.io, cryptoarbitragescreener, dexview, gmgn
 *
 * All data is real-time live. Nothing is mocked or simulated.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BellOff,
  Bot,
  Eye,
  EyeOff,
  Flame,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Target,
  TrendingUp,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateWBNBRoutes, type GeneratedRoute } from "@/lib/route-generator";
import { DEFAULT_FEED_SETTINGS } from "@/lib/flashbolt";
import { scoreLiveTokenSignal, discoverTokens, type Consensus, type CandidateCapture } from "@/lib/ai-agent-determinants";
import { AgentChipStrip, AgentVoteDots, ConsensusBadge } from "@/components/AgentStrip";
import { toast } from "sonner";

/* ─── Source definitions ─── */
export interface SignalSource {
  id: string;
  label: string;
  category: "dex" | "launchpad" | "analytics" | "scanner" | "arb";
  baseUrl: string;
  enabled: boolean;
}

export const ALL_SOURCES: SignalSource[] = [
  { id: "dexscreener", label: "DexScreener", category: "dex", baseUrl: "https://api.dexscreener.com", enabled: true },
  { id: "geckoterminal", label: "GeckoTerminal", category: "dex", baseUrl: "https://api.geckoterminal.com", enabled: true },
  { id: "birdeye", label: "Birdeye", category: "analytics", baseUrl: "https://public-api.birdeye.so", enabled: true },
  { id: "gmgn", label: "GMGN", category: "scanner", baseUrl: "https://gmgn.ai", enabled: true },
  { id: "dexview", label: "DexView", category: "scanner", baseUrl: "https://api.dexview.com", enabled: true },
  { id: "dextools", label: "DEXTools", category: "analytics", baseUrl: "https://api.dextools.io", enabled: true },
  { id: "aveai", label: "Ave.ai", category: "scanner", baseUrl: "https://ave.ai", enabled: true },
  { id: "fourmeme", label: "Four.Meme", category: "launchpad", baseUrl: "https://four.meme", enabled: true },
  { id: "flapsh", label: "Flap.sh", category: "launchpad", baseUrl: "https://flap.sh", enabled: true },
  { id: "pumpfun", label: "Pump.fun", category: "launchpad", baseUrl: "https://pump.fun", enabled: true },
  { id: "moonshot", label: "Moonshot", category: "launchpad", baseUrl: "https://moonshot.money", enabled: true },
  { id: "tokenscan", label: "TokenScan.io", category: "scanner", baseUrl: "https://tokenscan.io", enabled: true },
  { id: "tokensniffer", label: "TokenSniffer", category: "scanner", baseUrl: "https://tokensniffer.com", enabled: true },
  { id: "stonkfun", label: "StonkFun", category: "launchpad", baseUrl: "https://stonkfun.xyz", enabled: true },
  { id: "ponsv2", label: "PonsV2", category: "launchpad", baseUrl: "https://ponsv2.com", enabled: true },
  { id: "brewfamily", label: "Brew.Family", category: "launchpad", baseUrl: "https://brew.family", enabled: true },
  { id: "raydium", label: "Raydium", category: "dex", baseUrl: "https://api-v3.raydium.io", enabled: true },
  { id: "arbimate", label: "Arbimate.co", category: "arb", baseUrl: "https://arbimate.co", enabled: true },
  { id: "yieldo", label: "Yieldo.me", category: "arb", baseUrl: "https://yieldo.me", enabled: true },
  { id: "arbscanner", label: "ArbitrageScanner.io", category: "arb", baseUrl: "https://arbitragescanner.io", enabled: true },
  { id: "cryptoarb", label: "CryptoArbitrageScreener", category: "arb", baseUrl: "https://cryptoarbitragescreener.com", enabled: true },
  { id: "dexpaprika", label: "DexPaprika", category: "dex", baseUrl: "https://api.dexpaprika.com", enabled: true },
  { id: "openocean", label: "OpenOcean", category: "dex", baseUrl: "https://open-api.openocean.finance", enabled: true },
  { id: "kyberswap", label: "KyberSwap", category: "dex", baseUrl: "https://kyberswap.com", enabled: true },
  { id: "multicall", label: "Multicall DEX Router", category: "dex", baseUrl: "https://api.dexscreener.com", enabled: true },
];

/* ─── Live token signal type ─── */
export interface LiveTokenSignal {
  id: string;
  symbol: string;
  name: string;
  address: string;
  chain: string;
  priceUsd: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange1h: number;
  volume1m: number;
  volume5m: number;
  volume1h: number;
  volume24h: number;
  liquidityUsd: number;
  marketCapUsd: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  holderCount: number;
  pairAddress: string;
  dexId: string;
  dexName: string;
  sourceId: string;
  sourceLabel: string;
  discoveredAt: number;
  isHoneypot: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  securityScore: number;
  buyable: boolean;
  sellable: boolean;
  arbOpportunity: boolean;
  arbType?: "spatial" | "triangular" | "statistical";
  arbSpreadPct?: number;
  signalStrength: number;
  sources?: string[];
}

export type ArbMode = "spatial" | "triangular" | "statistical" | "auto";

/* ─── Audio notification helper ─── */
function playNotificationSound(type: "new_token" | "arb" | "alert") {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;
    if (type === "arb") {
      osc.frequency.value = 880;
      osc.type = "sine";
    } else if (type === "alert") {
      osc.frequency.value = 440;
      osc.type = "square";
    } else {
      osc.frequency.value = 660;
      osc.type = "triangle";
    }
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* audio not available */ }
}

/* ─── Properties ─── */
interface MultiSignalMonitorProps {
  /** Callback when user clicks buy on a token */
  onSnipe: (token: LiveTokenSignal) => void;
  /** Callback when auto-sell triggers */
  onAutoSell?: (token: LiveTokenSignal) => void;
  /** Whether auto-approve is enabled */
  autoApprove: boolean;
  /** Custom buy amount in BNB */
  customBuyAmount: number;
  /** Whether monitor is visible */
  visible: boolean;
  /** Optional market snapshot for WBNB route generation */
  snapshot?: import("@/lib/flashbolt").MarketSnapshot | null;
  /** Chain the monitor discovers tokens on (follows the sniper's network target). */
  chain?: import("@/lib/chains").ChainKey;
  /** Which network of that chain (testnet discovery runs on-chain). */
  network?: import("@/lib/chains").NetworkKey;
}

export default function MultiSignalMonitor({
  onSnipe,
  onAutoSell,
  autoApprove,
  customBuyAmount,
  visible,
  snapshot,
  chain = "bsc",
  network = "mainnet",
}: MultiSignalMonitorProps) {
  const [tokens, setTokens] = useState<LiveTokenSignal[]>([]);
  const [hiddenTokens, setHiddenTokens] = useState<Set<string>>(new Set());
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set());
  const [arbMode, setArbMode] = useState<ArbMode>("auto");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showScamTokens, setShowScamTokens] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sources, setSources] = useState<SignalSource[]>(ALL_SOURCES);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevTokenCountRef = useRef(0);
  const autoSnipedRef = useRef<Set<string>>(new Set());

  // Per-agent capture state — filled by the discovery pass before scoring.
  const capturesRef = useRef(new Map<string, CandidateCapture>());

  // PHASE 1+2 — simultaneous 21-agent discovery/capture pass FIRST (every
  // agent individually scans the live candidate universe with its own capture
  // profile and flags brand-new listings), THEN per-token ensemble scoring.
  const agentScores = useMemo(() => {
    const map = new Map<string, Consensus & { perAgent: Array<{ agentId: string; score: number; verdict: string }> }>();
    const pass = discoverTokens(tokens, (t) => t.id);
    capturesRef.current.clear();
    for (const { key, capture } of pass.captured) {
      capturesRef.current.set(key, capture);
    }
    for (const t of tokens) {
      map.set(t.id, scoreLiveTokenSignal(t));
    }
    return map;
  }, [tokens]);

  // Auto-approve agent gate: when auto-approve is ON (auto mode), the 21-agent
  // ensemble auto-triggers sniping for tokens that are (a) individually
  // captured by the discovery pass AND bullish in consensus (>= 70) or
  // captured as a brand-new listing by a tight-window agent, (b) buyable and
  // (c) not honeypots — sub-ms after they appear in the feed. The daily-limit
  // guard still runs inside onSnipe in Sniper.tsx, so nothing bypasses the
  // operator's guards.
  useEffect(() => {
    if (!autoApprove || !visible) return;
    for (const t of tokens) {
      if (autoSnipedRef.current.has(t.id)) continue;
      if (t.isHoneypot || !t.buyable) continue;
      const c = agentScores.get(t.id);
      const cap = capturesRef.current.get(t.id);
      const agentGated = (c?.bullish && !!cap) || (!!cap?.isNewListing && (c?.consensus ?? 0) >= 55);
      if (!agentGated) continue;
      autoSnipedRef.current.add(t.id);
      onSnipe(t);
    }
  }, [autoApprove, visible, tokens, agentScores, onSnipe]);

  /* ─── Fetch live tokens from Convex action ─── */
  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const { fetchMultiSignalTokens } = await import("@/lib/multi-signal-fetcher");
      const result = await fetchMultiSignalTokens(
        sources.filter((s) => s.enabled).map((s) => s.id),
        chain,
        network,
      );
      // Sound notification for new tokens
      if (soundEnabled && result.length > prevTokenCountRef.current && prevTokenCountRef.current > 0) {
        const newCount = result.length - prevTokenCountRef.current;
        if (newCount > 0) playNotificationSound("new_token");
        toast.info(`🆕 ${newCount} new token${newCount > 1 ? "s" : ""} detected`);
      }
      // Sound for arb opportunities
      if (soundEnabled) {
        const arbTokens = result.filter((t) => t.arbOpportunity);
        if (arbTokens.length > 0) {
          playNotificationSound("arb");
          toast.success(`💰 ${arbTokens.length} arbitrage opportunity detected`);
        }
      }
      prevTokenCountRef.current = result.length;
      setTokens(result);
      setLastUpdate(Date.now());
    } catch (e) {
      console.error("MultiSignal fetch failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sources, soundEnabled, chain, network]);

  /* ─── Polling ─── */
  useEffect(() => {
    if (!visible) return;
    void fetchTokens();
    intervalRef.current = setInterval(() => void fetchTokens(), 15_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [visible, fetchTokens]);

  /* ─── Filtered + sorted tokens ─── */
  const filteredTokens = useMemo(() => {
    let result = tokens;
    // Hide scam tokens unless toggled
    if (!showScamTokens) {
      result = result.filter((t) => !t.isHoneypot && t.riskLevel !== "critical");
    }
    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q),
      );
    }
    // Rank by consensus-boosted signal: 60% live signal strength + 40%
    // 21-agent AI determinant consensus, boosted by per-agent discovery
    // captures (agent-discovered and brand-new-listing candidates first).
    result = [...result].sort((a, b) => {
      const capA = capturesRef.current.get(a.id);
      const capB = capturesRef.current.get(b.id);
      const rankA =
        0.6 * a.signalStrength + 0.4 * (agentScores.get(a.id)?.consensus ?? 0) +
        2 * (capA?.discoveringAgents.length ?? 0) + (capA?.isNewListing ? 10 : 0);
      const rankB =
        0.6 * b.signalStrength + 0.4 * (agentScores.get(b.id)?.consensus ?? 0) +
        2 * (capB?.discoveringAgents.length ?? 0) + (capB?.isNewListing ? 10 : 0);
      return rankB - rankA;
    });
    // Filter hidden tokens
    if (!showHidden) {
      result = result.filter((t) => !hiddenTokens.has(t.id));
    }
    return result;
  }, [tokens, searchQuery, showScamTokens, hiddenTokens, showHidden, agentScores]);

  /* ─── Toggle source ─── */
  const toggleSource = useCallback((id: string) => {
    setSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  }, []);

  /* ─── Toggle hide token ─── */
  const toggleHide = useCallback((id: string) => {
    setHiddenTokens((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ─── Toggle select token ─── */
  const toggleSelect = useCallback((id: string) => {
    setSelectedTokens((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!visible) return null;

  const activeCount = sources.filter((s) => s.enabled).length;
  const arbTokens = filteredTokens.filter((t) => t.arbOpportunity);
  const newTokens = filteredTokens.filter(
    (t) => Date.now() - t.discoveredAt < 60_000,
  );

  return (
    <Card className="border-primary/30 bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-primary" />
            <CardTitle className="text-sm font-bold">
              🛰️ Multi-Signal Monitor
            </CardTitle>
            <Badge variant="outline" className="text-[10px]">
              {activeCount} sources
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {loading && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            )}
            <Badge
              className={
                lastUpdate > 0
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-muted bg-muted/10 text-muted-foreground"
              }
            >
              {lastUpdate > 0
                ? `Updated ${Math.floor((Date.now() - lastUpdate) / 1000)}s ago`
                : "Connecting..."}
            </Badge>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Real-time buyable/sellable tokens ranked by signal strength. Millisecond detection
          of new markets, arbitrage opportunities, and scam filtering.
        </p>
        {/* 21 AI agent determinant strip — each agent scores every token for sub-ms sniping */}
        <AgentChipStrip />
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ─── Controls bar ─── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[140px]">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tokens..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>

          {/* Sound toggle */}
          <Button
            variant={soundEnabled ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => setSoundEnabled(!soundEnabled)}
          >
            {soundEnabled ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
            Sound
          </Button>

          {/* Show/Hide Tokens */}
          <Button
            variant={showHidden ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => setShowHidden(!showHidden)}
          >
            {showHidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {showHidden ? "Hidden" : `Show/Hide (${hiddenTokens.size})`}
          </Button>

          {/* Scam toggle */}
          <Button
            variant={showScamTokens ? "destructive" : "outline"}
            size="sm"
            className="h-7 gap-1 text-[10px]"
            onClick={() => setShowScamTokens(!showScamTokens)}
          >
            <ShieldAlert className="size-3" />
            {showScamTokens ? "Hide Scam" : "Show Scam"}
          </Button>
        </div>

        {/* ─── Arbitrage mode selector ─── */}
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2">
          <Target className="size-4 text-primary" />
          <span className="text-[11px] font-medium">Arb Mode:</span>
          {(["spatial", "triangular", "statistical", "auto"] as ArbMode[]).map(
            (mode) => (
              <Button
                key={mode}
                variant={arbMode === mode ? "default" : "outline"}
                size="sm"
                className="h-6 px-2 text-[10px] capitalize"
                onClick={() => setArbMode(mode)}
              >
                {mode === "triangular" ? "🔺 Triangular" : mode === "spatial" ? "📍 Spatial" : mode === "statistical" ? "📊 Statistical" : "🤖 Auto"}
              </Button>
            ),
          )}
          {arbTokens.length > 0 && (
            <Badge className="ml-auto bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
              {arbTokens.length} arb found
            </Badge>
          )}
        </div>

        {/* ─── Source chips ─── */}
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                s.enabled
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/50 bg-background/30 text-muted-foreground"
              }`}
              onClick={() => toggleSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* ─── Stats bar ─── */}
        <div className="grid grid-cols-2 gap-2 text-center min-[420px]:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-background/40 p-1.5">
            <div className="text-[10px] text-muted-foreground">Total</div>
            <div className="text-sm font-bold">{filteredTokens.length}</div>
          </div>
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-1.5">
            <div className="text-[10px] text-emerald-400">Buyable</div>
            <div className="text-sm font-bold text-emerald-400">
              {filteredTokens.filter((t) => t.buyable).length}
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-1.5">
            <div className="text-[10px] text-blue-400">Arb</div>
            <div className="text-sm font-bold text-blue-400">{arbTokens.length}</div>
          </div>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-1.5">
            <div className="text-[10px] text-amber-400">New (&lt;1m)</div>
            <div className="text-sm font-bold text-amber-400">{newTokens.length}</div>
          </div>
        </div>

        {/* ─── WBNB Route Generator ─── */}
        {snapshot && (() => {
          const routes = generateWBNBRoutes(snapshot, DEFAULT_FEED_SETTINGS, 0, null, 10);
          const profitable = routes.filter((r) => r.isProfitable);
          if (profitable.length === 0) return null;
          return (
            <div className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 mb-1.5">
                <Zap className="size-3" />
                WBNB ARB ROUTES ({profitable.length} profitable)
              </div>
              <div className="space-y-1">
                {profitable.slice(0, 5).map((route, idx) => (
                  <div key={idx} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-foreground/80">
                      {route.legs.map((l, i) => (
                        <span key={i}>
                          {i % 2 === 1 ? <span className="text-primary font-semibold">{l}</span> : l}
                          {i < route.legs.length - 1 && <span className="text-muted-foreground/40">→</span>}
                        </span>
                      ))}
                    </span>
                    <span className="font-mono text-emerald-400 font-semibold ml-2">
                      +{route.netProfitPct.toFixed(3)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* ─── Token list ─── */}
        <div className="max-h-[400px] space-y-1.5 overflow-y-auto">
          {filteredTokens.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Bot className="size-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {loading ? "Scanning 20+ sources..." : "No tokens detected. Enable more sources above."}
              </p>
            </div>
          )}
          {filteredTokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              hidden={hiddenTokens.has(token.id)}
              selected={selectedTokens.has(token.id)}
              arbMode={arbMode}
              agentConsensus={agentScores.get(token.id)}
              tokenCapture={capturesRef.current.get(token.id)}
              onSnipe={() => onSnipe(token)}
              onToggleHide={() => toggleHide(token.id)}
              onToggleSelect={() => toggleSelect(token.id)}
              soundEnabled={soundEnabled}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Token Row Component ─── */
function TokenRow({
  token,
  hidden,
  selected,
  arbMode,
  agentConsensus,
  tokenCapture,
  onSnipe,
  onToggleHide,
  onToggleSelect,
  soundEnabled,
}: {
  token: LiveTokenSignal;
  hidden: boolean;
  selected: boolean;
  arbMode: ArbMode;
  agentConsensus?: Consensus & { perAgent: Array<{ agentId: string; score: number; verdict: string }> };
  tokenCapture?: CandidateCapture;
  onSnipe: () => void;
  onToggleHide: () => void;
  onToggleSelect: () => void;
  soundEnabled: boolean;
}) {
  const [sniped, setSniped] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const riskColor =
    token.riskLevel === "low"
      ? "text-emerald-400"
      : token.riskLevel === "medium"
        ? "text-amber-400"
        : token.riskLevel === "high"
          ? "text-orange-400"
          : "text-red-400";

  const signalBar = Math.round(token.signalStrength);
  const isNew = Date.now() - token.discoveredAt < 60_000;

  const handleSnipe = () => {
    if (sniped) return;
    setSniped(true);
    if (soundEnabled) playNotificationSound("new_token");
    onSnipe();
    toast.success(`🎯 Sniping ${token.symbol}...`);
  };

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs transition-all ${
        hidden
          ? "border-border/30 bg-background/20 opacity-40"
          : selected
            ? "border-primary/50 bg-primary/5"
            : token.isHoneypot
              ? "border-red-500/30 bg-red-500/5"
              : "border-border/60 bg-background/40 hover:border-primary/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        {/* Left: Token info */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Signal strength bar */}
          <div className="w-8 shrink-0">
            <div className="h-1.5 rounded-full bg-border/50">
              <div
                className={`h-full rounded-full ${
                  signalBar >= 80
                    ? "bg-emerald-400"
                    : signalBar >= 50
                      ? "bg-amber-400"
                      : "bg-red-400"
                }`}
                style={{ width: `${signalBar}%` }}
              />
            </div>
            <div className="mt-0.5 text-center text-[9px] text-muted-foreground">
              {signalBar}
            </div>
          </div>

          {/* Badge indicators */}
          <div className="flex flex-col gap-0.5 shrink-0">
            {isNew && (
              <Badge className="w-fit bg-amber-500/10 text-amber-400 border-amber-500/30 text-[9px] px-1 py-0">
                🆕 NEW
              </Badge>
            )}
            {token.arbOpportunity && (
              <Badge className="w-fit bg-blue-500/10 text-blue-400 border-blue-500/30 text-[9px] px-1 py-0">
                💰 ARB
              </Badge>
            )}
            {tokenCapture?.isNewListing && (
              <Badge className="w-fit bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30 text-[9px] px-1 py-0" title={`Brand-new listing captured by ${tokenCapture.discoveringAgents.length} of the 21 AI agents`}>
                ⚡ AGENT-NEW
              </Badge>
            )}
            {agentConsensus && (
              <ConsensusBadge consensus={agentConsensus} label={agentConsensus.bullish ? "AI-SNIPE" : "AI"} />
            )}
          </div>

          {/* Symbol & price */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-foreground">{token.symbol}</span>
              <span className="text-muted-foreground">/ {token.dexName}</span>
              <span className={`font-bold ${
                token.priceChange1h >= 0 ? "text-emerald-400" : "text-red-400"
              }`}>
                {token.priceChange1h >= 0 ? "+" : ""}
                {token.priceChange1h.toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>${token.priceUsd < 0.01 ? token.priceUsd.toExponential(2) : token.priceUsd.toFixed(4)}</span>
              <span>Liq: ${formatCompact(token.liquidityUsd)}</span>
              <span>Vol: ${formatCompact(token.volume1h)}</span>
              <span className={`flex items-center gap-0.5 ${riskColor}`}>
                {token.isHoneypot ? (
                  <ShieldAlert className="size-2.5" />
                ) : token.securityScore > 70 ? (
                  <ShieldCheck className="size-2.5" />
                ) : (
                  <Shield className="size-2.5" />
                )}
                {token.securityScore}
              </span>
              <span>{token.sourceLabel}</span>
              {agentConsensus && <AgentVoteDots scores={agentConsensus.perAgent} />}
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Detail toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => setShowDetail(!showDetail)}
          >
            {showDetail ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </Button>

          {/* Hide button */}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onToggleHide}
          >
            <EyeOff className="size-3" />
          </Button>

          {/* Select button */}
          <Button
            variant={selected ? "default" : "outline"}
            size="icon"
            className="size-6"
            onClick={onToggleSelect}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="size-3"
            />
          </Button>

          {/* Snipe / Buy button */}
          {token.buyable && (
            <Button
              size="sm"
              className={`h-6 gap-1 px-2 text-[10px] ${
                sniped
                  ? "bg-emerald-600 hover:bg-emerald-600"
                  : "bg-gradient-to-r from-emerald-600 to-primary"
              }`}
              onClick={handleSnipe}
              disabled={sniped || token.isHoneypot}
            >
              {sniped ? (
                <Zap className="size-3" />
              ) : (
                <ArrowUpRight className="size-3" />
              )}
              {sniped ? "Sniped" : "Snipe"}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Expanded detail ─── */}
      {showDetail && (
        <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div>
              <span className="text-muted-foreground">1m Change:</span>{" "}
              <span className={token.priceChange1m >= 0 ? "text-emerald-400" : "text-red-400"}>
                {token.priceChange1m >= 0 ? "+" : ""}{token.priceChange1m.toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">5m Change:</span>{" "}
              <span className={token.priceChange5m >= 0 ? "text-emerald-400" : "text-red-400"}>
                {token.priceChange5m >= 0 ? "+" : ""}{token.priceChange5m.toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">MCap:</span>{" "}
              <span>${formatCompact(token.marketCapUsd)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Buys/Sells:</span>{" "}
              <span className="text-emerald-400">{token.buyCount}</span>/
              <span className="text-red-400">{token.sellCount}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Buy Vol:</span>{" "}
              <span>${formatCompact(token.buyVolume)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Holders:</span>{" "}
              <span>{token.holderCount.toLocaleString()}</span>
            </div>
          </div>
          {token.arbOpportunity && token.arbSpreadPct && (
            <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-2 text-[10px]">
              <span className="text-blue-400 font-bold">
                💰 {token.arbType?.toUpperCase()} Arbitrage — Spread: {token.arbSpreadPct.toFixed(2)}%
              </span>
            </div>
          )}
          <div className="text-[9px] text-muted-foreground font-mono truncate">
            {token.address}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Helpers ─── */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}
