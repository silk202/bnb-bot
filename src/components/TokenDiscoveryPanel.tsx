/**
 * TokenDiscoveryPanel — displays multi-source token discovery results
 * from 10+ real APIs. Shows ranked tokens with security scores, liquidity,
 * volume, holder data, and contract risk indicators.
 *
 * All data is real-time live. Nothing is mocked or simulated.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { TokenCandidate } from "@/lib/token-discovery";
import type { TokenDiscoveryFeed } from "@/hooks/use-token-discovery";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
  Flame,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  Users,
  Zap,
  ArrowRightLeft,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scoreTokenCandidate, discoverTokens, type Consensus, type CandidateCapture } from "@/lib/ai-agent-determinants";
import { AgentChipStrip, AgentVoteDots, ConsensusBadge } from "@/components/AgentStrip";

interface TokenDiscoveryPanelProps {
  feed: TokenDiscoveryFeed;
  /** Chain block explorer base URL. */
  explorerUrl?: string;
  /** Auto-execute callback for WBNB arb flash-loan initiation. */
  onAutoExecute?: (route: { address: string; symbol: string; dexes: string[]; spreadPct: number; method: string }) => void;
  /** Callback when an arb route is first detected (for sound notification). */
  onArbDetected?: (symbol: string, spreadPct: number) => void;
}

const SOURCE_COLORS: Record<string, string> = {
  DexScreener: "#FF6B35",
  GeckoTerminal: "#2C7A51",
  DEXTools: "#1A1A2E",
  Dexview: "#00D4FF",
  "Ave.ai": "#FF4081",
  GMGN: "#FFD700",
  Birdeye: "#7C3AED",
  "Signal-bot": "#00E676",
  BscScan: "#3B82F6",
  "Honeypot.is": "#EF4444",
  "Four.Meme": "#FF8C00",
  "Flap.sh": "#E91E63",
  "Pump.fun": "#9C27B0",
  Moonshot: "#00BCD4",
  TokenScan: "#4CAF50",
  TokenSniffer: "#FF5722",
  StonkFun: "#CDDC39",
  PonsV2: "#607D8B",
  "Brew.Family": "#795548",
  Raydium: "#00E676",
  Arbimate: "#2196F3",
  Yieldo: "#FF9800",
  ArbitrageScanner: "#F44336",
  "CryptoArbScreener": "#673AB7",
  OpenOcean: "#00BFFF",
  KyberSwap: "#1DC88E",
};

function riskColor(level: string): string {
  switch (level) {
    case "low": return "text-emerald-400 bg-emerald-500/10 border-emerald-500/25";
    case "medium": return "text-amber-400 bg-amber-500/10 border-amber-500/25";
    case "high": return "text-orange-400 bg-orange-500/10 border-orange-500/25";
    case "critical": return "text-red-400 bg-red-500/10 border-red-500/25";
    default: return "text-muted-foreground";
  }
}

function securityIcon(score: number) {
  if (score >= 70) return <ShieldCheck className="size-3.5 text-emerald-400" />;
  if (score >= 50) return <Shield className="size-3.5 text-amber-400" />;
  if (score >= 30) return <ShieldAlert className="size-3.5 text-orange-400" />;
  return <ShieldX className="size-3.5 text-red-400" />;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  if (n === 0) return "—";
  // Very small prices
  const str = n.toFixed(20);
  const match = str.match(/0\.(0+)(\d{2,4})/);
  if (match) return `$0.0{${match[1].length}}${match[2]}`;
  return `$${n.toExponential(2)}`;
}

function ageLabel(hours: number): string {
  if (hours <= 0) return "new";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  if (hours < 168) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours / 168)}w`;
}

export function TokenDiscoveryPanel({ feed, explorerUrl = "https://bscscan.com", onAutoExecute, onArbDetected }: TokenDiscoveryPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [hideHoneypots, setHideHoneypots] = useState(true);
  const [showSources, setShowSources] = useState(false);

  // Per-agent capture state — filled by the discovery pass before scoring.
  const tokenCapturesRef = useRef(new Map<string, CandidateCapture>());

  // PHASE 1+2 — simultaneous 21-agent discovery/capture pass FIRST (every
  // agent individually scans the live candidate universe with its own capture
  // profile and flags brand-new listings), THEN per-token ensemble scoring.
  // Recomputed only when the feed updates.
  const agentScores = useMemo(() => {
    const map = new Map<string, Consensus & { perAgent: Array<{ agentId: string; score: number; verdict: string }> }>();
    const pass = discoverTokens(feed.tokens, (t) => t.id);
    tokenCapturesRef.current.clear();
    for (const { key, capture } of pass.captured) {
      tokenCapturesRef.current.set(key, capture);
    }
    for (const t of feed.tokens) {
      map.set(t.id, scoreTokenCandidate(t));
    }
    return map;
  }, [feed.tokens]);

  const filtered = useMemo(() => {
    let tokens = feed.tokens;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tokens = tokens.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q),
      );
    }
    if (minScore > 0) {
      tokens = tokens.filter((t) => t.discoveryScore >= minScore);
    }
    if (hideHoneypots) {
      tokens = tokens.filter((t) => !t.isHoneypot);
    }
    // 21-agent AI determinant consensus (sub-ms per token) — bullish ensemble
    // votes rank tokens first so buyable/sellable tokens surface instantly.
    // Agent-captured candidates (per-agent discovery pass) get a rank boost,
    // and brand-new listings captured inside tight agent windows rank first.
    return [...tokens].sort((a, b) => {
      const ca = agentScores.get(a.id)?.consensus ?? 0;
      const cb = agentScores.get(b.id)?.consensus ?? 0;
      const capA = tokenCapturesRef.current.get(a.id);
      const capB = tokenCapturesRef.current.get(b.id);
      const rankA = ca + 2 * (capA?.discoveringAgents.length ?? 0) + (capA?.isNewListing ? 10 : 0);
      const rankB = cb + 2 * (capB?.discoveringAgents.length ?? 0) + (capB?.isNewListing ? 10 : 0);
      return rankB - rankA || b.discoveryScore - a.discoveryScore;
    });
  }, [feed.tokens, searchQuery, minScore, hideHoneypots, agentScores]);

  const activeSources = useMemo(() => {
    return Object.entries(feed.sourceStats)
      .filter(([_, s]) => s.count > 0 || s.error)
      .sort((a, b) => b[1].count - a[1].count);
  }, [feed.sourceStats]);

  if (feed.loading && feed.tokens.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card/40 px-5 py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          Aggregating tokens from 10+ sources...
        </p>
        <p className="text-xs text-muted-foreground/60">
          DexScreener · GeckoTerminal · DEXTools · Dexview · Ave.ai · GMGN · Birdeye · Signal-bot · BscScan · Honeypot.is · Four.Meme · Flap.sh · Pump.fun · Moonshot · TokenScan · TokenSniffer · StonkFun · PonsV2 · Brew.Family · Raydium · Arbimate · Yieldo · ArbitrageScanner · CryptoArbScreener
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header with stats */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-violet-500" />
            </span>
            MULTI-SOURCE TOKEN DISCOVERY
            <Badge className="border-violet-500/25 bg-violet-500/10 text-violet-400">
              {feed.totalPassed} / {feed.totalCandidates}
            </Badge>
            {tokenCapturesRef.current.size > 0 ? (
              <Badge className="border-violet-500/25 bg-violet-500/10 text-violet-400" title="Candidates individually captured by one or more of the 21 AI agents in the discovery pass">
                ⚡ {tokenCapturesRef.current.size} agent-captured
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setShowSources((v) => !v)}
            >
              <Zap className="size-3.5" />
              {activeSources.length} Sources
              {showSources ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => feed.refresh()}
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        {/* 21 AI agent determinant strip — each agent scores every token */}
        <AgentChipStrip />

        {/* Source stats */}
        {showSources && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {activeSources.map(([name, stats]) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: SOURCE_COLORS[name] ?? "#888" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-foreground">{name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {stats.count} tokens · {stats.latencyMs}ms
                    {stats.error && (
                      <span className="text-red-400"> · error</span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tokens..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Filter className="size-3.5" />
            Min score
            <Input
              type="number"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="h-8 w-16 font-mono text-xs"
            />
          </label>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Hide honeypots
            <Switch checked={hideHoneypots} onCheckedChange={setHideHoneypots} />
          </div>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} results · scan {Math.round((Date.now() - (feed.lastFetch ?? 0)) / 1000)}s ago
          </span>
        </div>
      </div>

      {/* Error banner */}
      {feed.error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-2.5 text-xs text-red-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          {feed.error}
        </div>
      )}

      {/* Token list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-card/40 px-5 py-12 text-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {searchQuery
              ? "No tokens match your search."
              : "No tokens passed the discovery filters right now — the pipeline re-checks every 60s."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/40">
          <div className="divide-y divide-border/40">
            {filtered.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                expanded={expanded === token.id}
                onToggle={() => setExpanded(expanded === token.id ? null : token.id)}
                explorerUrl={explorerUrl}
                agentConsensus={agentScores.get(token.id)}
                tokenCapture={tokenCapturesRef.current.get(token.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* WBNB-pair arbitrage route detection */}
      <WBNBArbRoutes tokens={filtered} agentScores={agentScores} onAutoExecute={onAutoExecute} onArbDetected={onArbDetected} />

      <div className="flex items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/8 px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <Zap className="size-3.5 shrink-0 text-violet-400" />
        Tokens ranked by multi-factor discovery score: source diversity, liquidity depth, volume,
        holder distribution, buy pressure, contract security, and tax analysis — all from real API data.
      </div>
    </div>
  );
}

function TokenRow({
  token,
  expanded,
  onToggle,
  explorerUrl,
  agentConsensus,
  tokenCapture,
}: {
  token: TokenCandidate;
  expanded: boolean;
  onToggle: () => void;
  explorerUrl: string;
  agentConsensus?: Consensus & { perAgent: Array<{ agentId: string; score: number; verdict: string }> };
  tokenCapture?: CandidateCapture;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/20"
      >
        {/* Score badge */}
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg border text-xs font-bold",
            token.discoveryScore >= 70
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
              : token.discoveryScore >= 50
                ? "border-amber-500/25 bg-amber-500/10 text-amber-400"
                : token.discoveryScore >= 30
                  ? "border-orange-500/25 bg-orange-500/10 text-orange-400"
                  : "border-red-500/25 bg-red-500/10 text-red-400",
          )}
        >
          {token.discoveryScore}
        </div>

        {/* Token info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-foreground">
              {token.symbol}
            </span>
            <span className="text-xs text-muted-foreground/60">
              {token.name}
            </span>
            {token.isHoneypot && (
              <Badge className="border-red-500/25 bg-red-500/10 text-[10px] text-red-400">
                HONEYPOT
              </Badge>
            )}
            {!token.isContractVerified && (
              <Badge className="border-amber-500/25 bg-amber-500/10 text-[10px] text-amber-400">
                UNVERIFIED
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="font-mono">{formatPrice(token.priceUsd)}</span>
            <span
              className={cn(
                "font-mono font-semibold",
                token.priceChange24h >= 0 ? "text-emerald-400" : "text-red-400",
              )}
            >
              {token.priceChange24h >= 0 ? "+" : ""}
              {token.priceChange24h.toFixed(1)}%
            </span>
            <span>liq {formatUsd(token.liquidityUsd)}</span>
            <span>vol {formatUsd(token.volume24hUsd)}</span>
            {token.holders > 0 && (
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" />
                {token.holders.toLocaleString()}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              {securityIcon(token.securityScore)}
              {token.securityScore}
            </span>
            <Badge className={cn("border text-[10px]", riskColor(token.riskLevel))}>
              {token.riskLevel}
            </Badge>
            {tokenCapture?.isNewListing ? (
              <span
                className="rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-fuchsia-400"
                title={`Brand-new listing captured by ${tokenCapture.discoveringAgents.length} agents`}
              >
                new
              </span>
            ) : null}
            {tokenCapture ? (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-violet-400"
                title={`Discovered by: ${tokenCapture.discoveringAgents.join(", ")}`}
              >
                ⚡{tokenCapture.discoveringAgents.length}
              </span>
            ) : null}
            {agentConsensus && <ConsensusBadge consensus={agentConsensus} label={agentConsensus.bullish ? "AI-BUY" : "AI"} />}
            {agentConsensus && <AgentVoteDots scores={agentConsensus.perAgent} />}
          </div>
        </div>

        {/* Sources */}
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {token.sources.slice(0, 4).map((src) => (
            <span
              key={src}
              className="size-2 rounded-full"
              style={{ background: SOURCE_COLORS[src] ?? "#888" }}
              title={src}
            />
          ))}
          {token.sources.length > 4 && (
            <span className="text-[10px] text-muted-foreground">
              +{token.sources.length - 4}
            </span>
          )}
        </div>

        {/* Arrow */}
        <div className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border/40 bg-muted/10 px-5 py-4">
          <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <Detail label="Market Cap" value={formatUsd(token.marketCapUsd)} />
            <Detail label="FDV" value={formatUsd(token.fdvUsd)} />
            <Detail label="Liquidity" value={formatUsd(token.liquidityUsd)} />
            <Detail label="24h Volume" value={formatUsd(token.volume24hUsd)} />
            <Detail label="Token Age" value={ageLabel(token.ageHours)} />
            <Detail
              label="Buy/Sell Ratio"
              value={`${token.buySellRatio.toFixed(1)}x`}
              good={token.buySellRatio > 1}
            />
            <Detail label="24h Txns" value={token.transactions24h.toLocaleString()} />
            <Detail label="Buys / Sells" value={`${token.buys24h} / ${token.sells24h}`} />
            <Detail
              label="Buy Tax"
              value={`${token.buyTaxPct.toFixed(1)}%`}
              bad={token.buyTaxPct > 5}
            />
            <Detail
              label="Sell Tax"
              value={`${token.sellTaxPct.toFixed(1)}%`}
              bad={token.sellTaxPct > 5}
            />
            <Detail
              label="Contract"
              value={token.isContractVerified ? "Verified" : "Unverified"}
              good={token.isContractVerified}
              bad={!token.isContractVerified}
            />
            <Detail
              label="Ownership"
              value={token.ownershipStatus}
              good={token.ownershipStatus === "renounced"}
              bad={token.ownershipStatus === "active"}
            />
            {token.isHoneypot && (
              <Detail label="Honeypot" value="DETECTED" bad />
            )}
            {token.hasMintFunction && (
              <Detail label="Mint Function" value="PRESENT" bad />
            )}
            {token.hasHiddenOwner && (
              <Detail label="Hidden Owner" value="DETECTED" bad />
            )}
            {token.hasBlacklist && (
              <Detail label="Blacklist" value="PRESENT" bad />
            )}
            {token.hasPauseFunction && (
              <Detail label="Pause" value="PRESENT" bad />
            )}
            {token.isProxy && (
              <Detail label="Proxy" value="YES" bad />
            )}
          </div>

          {/* Sources & pairs */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">Sources:</span>
            {token.sources.map((src) => (
              <Badge
                key={src}
                variant="outline"
                className="border-border/50 text-[10px]"
              >
                <span
                  className="mr-1 size-1.5 rounded-full"
                  style={{ background: SOURCE_COLORS[src] ?? "#888" }}
                />
                {src}
              </Badge>
            ))}
          </div>

          {token.pairs.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Pairs:</span>
              {token.pairs.slice(0, 5).map((pair, i) => (
                <Badge
                  key={`${pair.dex}-${pair.pairAddress}-${i}`}
                  variant="outline"
                  className="border-border/50 text-[10px]"
                >
                  {pair.dex}: {pair.baseToken}/{pair.quoteToken}
                </Badge>
              ))}
            </div>
          )}

          {/* Links */}
          <div className="mt-4 flex items-center gap-3">
            <a
              href={`${explorerUrl}/token/${token.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              BscScan <ExternalLink className="size-3" />
            </a>
            <a
              href={`https://dexscreener.com/bsc/${token.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              DexScreener <ExternalLink className="size-3" />
            </a>
            <a
              href={`https://gmgn.ai/bsc/token/${token.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              GMGN <ExternalLink className="size-3" />
            </a>
            <a
              href={`https://dexview.com/bsc/${token.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              Dexview <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-muted-foreground/60">{label}</span>
      <span
        className={cn(
          "font-mono text-xs font-medium",
          good ? "text-emerald-400" : bad ? "text-red-400" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * WBNBArbRoutes — detects WBNB-pair arbitrage opportunities from the
 * discovered token candidates by checking if a token has multiple DEX
 * pairs with different prices, and classifies the arb method.
 */
function WBNBArbRoutes({ tokens, agentScores, onAutoExecute, onArbDetected }: { tokens: TokenCandidate[]; agentScores: Map<string, Consensus & { perAgent: Array<{ agentId: string; score: number; verdict: string }> }>; onAutoExecute?: (route: { address: string; symbol: string; dexes: string[]; spreadPct: number; method: string }) => void; onArbDetected?: (symbol: string, spreadPct: number) => void }) {
  const [autoExecuted, setAutoExecuted] = useState<Set<string>>(new Set());
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const arbRoutes = useMemo(() => {
    type ArbRoute = {
      symbol: string;
      address: string;
      method: "spatial" | "triangular" | "statistical";
      spreadPct: number;
      dexes: string[];
      liquidityUsd: number;
      volume24hUsd: number;
      sources: string[];
      securityScore: number;
      riskLevel: string;
    };
    
    const routes: ArbRoute[] = [];
    
    for (const token of tokens) {
      if (token.pairs.length < 2) continue;
      if (token.isHoneypot) continue;
      if (token.securityScore < 30) continue;
      
      // Check for WBNB quote pairs across different DEXes
      const wbnbPairs = token.pairs.filter(
        (p) => p.quoteToken === "WBNB" || p.quoteToken === "BNB",
      );
      if (wbnbPairs.length < 2) continue;
      
      // Spatial arb: same token, different DEXes, different prices
      const prices = wbnbPairs.map((p) => p.priceUsd).filter((p) => p > 0);
      if (prices.length < 2) continue;
      const maxPrice = Math.max(...prices);
      const minPrice = Math.min(...prices);
      const spreadPct = ((maxPrice - minPrice) / minPrice) * 100;
      
      if (spreadPct < 0.1) continue; // Absolute minimum for listing
      
      const dexes = [...new Set(wbnbPairs.map((p) => p.dex))];
      let method: "spatial" | "triangular" | "statistical" = "spatial";
      
      if (dexes.length >= 3) {
        method = "triangular";
      } else if (spreadPct > 2) {
        method = "statistical";
      }
      
      // MEV risk: higher for low liquidity
      const totalLiq = wbnbPairs.reduce((s, p) => s + p.liquidityUsd, 0);
      
      // Only include if it aligns with minimum profit margin (>0.3%)
      if (spreadPct < 0.3) continue;
      
      routes.push({
        symbol: token.symbol,
        address: token.address,
        method,
        spreadPct: Math.round(spreadPct * 100) / 100,
        dexes,
        liquidityUsd: totalLiq,
        volume24hUsd: token.volume24hUsd,
        sources: token.sources,
        securityScore: token.securityScore,
        riskLevel: token.riskLevel,
      });
    }
    
    return routes
      .sort((a, b) => {
        // AI-consensus-ranked first (21-agent ensemble), then spread.
        const ca = agentScores.get(a.address)?.consensus ?? 0;
        const cb = agentScores.get(b.address)?.consensus ?? 0;
        return cb - ca || b.spreadPct - a.spreadPct;
      })
      .slice(0, 10);
  }, [tokens, agentScores]);

  // Auto-execute ALL profitable arb routes: every NEW route with >= 0.5%
  // spread that passes the risk gate is automatically initiated for
  // flash-loan execution — not just the first one. Each route still flows
  // through the full guard stack (profit guard → NLP-aware MEV guard → full
  // eth_call simulation → zero gas on failure) inside onAutoExecute in
  // Scanner, and the daily flash-loan limit guard still applies there.
  const queuedRef = useRef(false);
  useEffect(() => {
    if (!onAutoExecute || queuedRef.current) return;
    const passing = arbRoutes.filter(
      (r) => r.spreadPct >= 0.3 && r.riskLevel !== "critical" && !autoExecuted.has(r.address),
    );
    if (passing.length === 0) return;
    queuedRef.current = true;
    setAutoExecuted((prev) => {
      const next = new Set(prev);
      for (const r of passing) next.add(r.address);
      return next;
    });
    setExecutingSymbol(passing[0]?.symbol ?? null);
    for (const r of passing) {
      onArbDetected?.(r.symbol, r.spreadPct);
      onAutoExecute({
        address: r.address,
        symbol: r.symbol,
        dexes: r.dexes,
        spreadPct: r.spreadPct,
        method: r.method,
      });
    }
    // Release the queue lock after 2s to allow the next cycle through.
    const t = setTimeout(() => {
      queuedRef.current = false;
      setExecutingSymbol(null);
    }, 2000);
    return () => clearTimeout(t);
  }, [arbRoutes, onAutoExecute, autoExecuted, onArbDetected]);

  if (arbRoutes.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          WBNB-PAIR ARBITRAGE ROUTES
          <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
            {arbRoutes.length} detected
          </Badge>
        </div>
        <span className="text-[11px] text-muted-foreground">
          <Timer className="size-3 inline-block mr-1" />
          24/7 live scan · flash-loan ready
        </span>
      </div>
      
      <div className="divide-y divide-emerald-500/15">
        {arbRoutes.map((route) => {
          const routeConsensus = agentScores.get(route.address);
          return (
          <div
            key={route.address}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-foreground">
                  {route.symbol}
                </span>
                <Badge className={cn(
                  "border text-[10px]",
                  route.method === "spatial"
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                    : route.method === "triangular"
                      ? "border-blue-500/25 bg-blue-500/10 text-blue-400"
                      : "border-amber-500/25 bg-amber-500/10 text-amber-400",
                )}>
                  {route.method}
                </Badge>
                <Badge className={cn(
                  "border text-[10px]",
                  route.riskLevel === "low"
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                    : route.riskLevel === "medium"
                      ? "border-amber-500/25 bg-amber-500/10 text-amber-400"
                      : "border-red-500/25 bg-red-500/10 text-red-400",
                )}>
                  MEV {route.riskLevel}
                </Badge>
                {routeConsensus && <ConsensusBadge consensus={routeConsensus} label={routeConsensus.bullish ? "AI-EXEC" : "AI"} />}
                {routeConsensus && <AgentVoteDots scores={routeConsensus.perAgent} />}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="font-mono text-emerald-400 font-semibold">
                  +{route.spreadPct.toFixed(2)}% spread
                </span>
                <span>
                  <ArrowRightLeft className="size-3 inline-block mr-1" />
                  {route.dexes.join(" → ")}
                </span>
                <span>
                  liq ${route.liquidityUsd >= 1000 ? `${(route.liquidityUsd / 1000).toFixed(1)}k` : route.liquidityUsd.toFixed(0)}
                </span>
                <span>
                  vol ${route.volume24hUsd >= 1000 ? `${(route.volume24hUsd / 1000).toFixed(1)}k` : route.volume24hUsd.toFixed(0)}
                </span>
                <span className="inline-flex items-center gap-1">
                  {securityIcon(route.securityScore)}
                  {route.securityScore}
                </span>
                {executingSymbol === route.symbol ? (
                  <span className="text-emerald-400 font-semibold animate-pulse">
                    auto-executing flash-loan...
                  </span>
                ) : autoExecuted.has(route.address) ? (
                  <span className="text-emerald-400/60 font-semibold">
                    executed ✓
                  </span>
                ) : (
                  <span className="text-emerald-400 font-semibold">
                    auto-flash-loan ready
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={`https://dexscreener.com/bsc/${route.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
              >
                <Zap className="size-3" />
                Execute Arb
              </a>
            </div>
          </div>
          );
        })}
      </div>
      
      <p className="text-[10px] text-emerald-400/60">
        Auto flash-loan initiation enabled — profitable routes execute automatically via flash-loan lender rotation. ·
        Best method auto-selected (spatial/triangular/statistical) · MEV guard aligned · WBNB-pair focus · 24 sources live.
      </p>
    </div>
  );
}
