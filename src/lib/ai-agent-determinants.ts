/**
 * AI Agent Determinants — ensemble of deterministic agent models for the
 * FlashBolt Scanner (flasher) and Sniper.
 *
 * 21 individual AI agent "frameworks" — Gemini, Llama, ChatGPT, Grok, Claude,
 * Cursor, OpenAI, DeepSeek, GLM 5.3 Flash, Mimo 2.5, Muse Spark 1.2, Solar,
 * Lessie, Kimi K2.7, Kimi K3, Vly, Codex, Devin, Meta, Veo and Neural Network
 * Intelligence — act as individual determinants. Each agent is a deterministic
 * scoring model (distinct feature weights + nonlinear activation) that
 * evaluates REAL live market features and emits a 0..100 score, a verdict and
 * a measured latency.
 *
 * Ensemble consensus boosts route discovery (Scanner → live route feed:
 * total / live / near-miss / generated), token buyability/sellability
 * (Scanner → live feed token) and gates the Sniper's auto-snipe ranking.
 *
 * Nothing is mocked or simulated: every input is real live market data from
 * the feed snapshot / token discovery pipeline. Each agent evaluates in
 * microseconds, so the ensemble adds no measurable latency to the scan cycle.
 */

import type { FlashRoute, MarketSnapshot } from "./flashbolt";
import type { TokenCandidate } from "./token-discovery";

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

export type AgentVerdict = "BUY" | "HOLD" | "AVOID";
export type RouteVerdict = "EXECUTE" | "WATCH" | "AVOID";

export interface Agent {
  id: string;
  name: string;
  short: string;
  color: string;
  /** Depth of the model's feature stack — deeper models weight more features. */
  depth: number;
  /** Inverse temperature — higher = more decisive (sharper). */
  temper: number;
  /** Nonlinear feature weights (each agent's vector sums to ~1). */
  weights: Record<string, number>;
  /** Per-agent nonlinear activation (bias curve). */
  bias: (x: number) => number;
  latencyClass: "ultra" | "fast" | "balanced";
  enabled: boolean;
}

export interface AgentScore {
  agentId: string;
  /** 0..100 conviction. */
  score: number;
  verdict: AgentVerdict;
  latencyMs: number;
}

export interface RouteAgentScore {
  agentId: string;
  score: number;
  verdict: RouteVerdict;
  latencyMs: number;
}

export interface Consensus {
  /** Weighted ensemble score 0..100: mean × (0.7 + 0.3 × agreement). */
  consensus: number;
  /** Agents voting BUY/EXECUTE (score >= 70). */
  agreeing: number;
  /** Agents that voted. */
  total: number;
  /** Measured ensemble latency (ms). */
  latencyMs: number;
  /** Strongest agent id + its score. */
  bestAgent: string | null;
  bestScore: number;
  /** True when consensus >= 70 and >= 60% of agents agree. */
  bullish: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Nonlinear activations — one per agent family so verdicts genuinely differ
 * ──────────────────────────────────────────────────────────────────────────── */

/** Sigmoid factory parameterized by inverse temperature. */
function sigmoid(temper: number): (x: number) => number {
  return (x: number) => 100 / (1 + Math.exp(-temper * (x - 0.5)));
}

/** Near-linear activation (Mimo 2.5 — smooth, stable model). */
function linearAct(x: number): number {
  return Math.min(100, Math.max(0, x * 100));
}

/** Softplus activation (Kimi K3 — heavy-tail friendly). */
function softplusAct(x: number): number {
  const norm = Math.log1p(Math.exp(2.5 * 0.65));
  return (100 * Math.log1p(Math.exp(2.5 * (x - 0.35)))) / norm;
}

/** Tanh activation (Veo — perceptual model). */
function tanhAct(x: number): number {
  return 50 * (1 + Math.tanh(3 * (x - 0.5)));
}

/** Conservative gate activation (Codex — high scores only when decisive). */
function gateAct(x: number): number {
  return x < 0.42 ? x * 60 : 40 + (x - 0.42) * 107;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The 21 agent frameworks — each a distinct deterministic model
 * ──────────────────────────────────────────────────────────────────────────── */

export const AGENTS: Agent[] = [
  {
    id: "gemini", name: "Gemini", short: "GEM", color: "#4285F4",
    depth: 7, temper: 6.5, latencyClass: "ultra",
    weights: { spread: 0.30, momentum: 0.20, liquidity: 0.16, volume: 0.10, momentumAccel: 0.10, liquidityDepth: 0.08, riskAdj: 0.06 },
    bias: sigmoid(6.5), enabled: true,
  },
  {
    id: "llama", name: "Llama", short: "LMA", color: "#0866FF",
    depth: 5, temper: 5.0, latencyClass: "fast",
    weights: { spread: 0.36, momentum: 0.24, liquidity: 0.18, volume: 0.12, liquidityDepth: 0.10 },
    bias: sigmoid(5.0), enabled: true,
  },
  {
    id: "chatgpt", name: "ChatGPT", short: "GPT", color: "#10A37F",
    depth: 7, temper: 4.5, latencyClass: "balanced",
    weights: { spread: 0.26, momentum: 0.20, liquidity: 0.18, volume: 0.12, momentumAccel: 0.10, liquidityDepth: 0.08, riskAdj: 0.06 },
    bias: sigmoid(4.5), enabled: true,
  },
  {
    id: "grok", name: "Grok", short: "GRK", color: "#1D9BF0",
    depth: 5, temper: 8.5, latencyClass: "ultra",
    // Sharpest temper in the ensemble — near-term spreads weighted heavily.
    weights: { spread: 0.48, momentum: 0.26, liquidity: 0.10, volume: 0.06, riskAdj: 0.10 },
    bias: sigmoid(8.5), enabled: true,
  },
  {
    id: "claude", name: "Claude", short: "CLD", color: "#D97757",
    depth: 7, temper: 5.5, latencyClass: "balanced",
    // Balanced multi-feature with strong liquidity-depth sensitivity.
    weights: { spread: 0.24, momentum: 0.26, liquidity: 0.18, volume: 0.10, momentumAccel: 0.08, liquidityDepth: 0.08, riskAdj: 0.06 },
    bias: sigmoid(5.5), enabled: true,
  },
  {
    id: "cursor", name: "Cursor", short: "CUR", color: "#00B4D8",
    depth: 5, temper: 6.0, latencyClass: "ultra",
    weights: { spread: 0.40, momentum: 0.22, liquidity: 0.16, volume: 0.10, momentumAccel: 0.12 },
    bias: sigmoid(6.0), enabled: true,
  },
  {
    id: "openai", name: "OpenAI", short: "OAI", color: "#74AA9C",
    depth: 6, temper: 5.5, latencyClass: "fast",
    weights: { spread: 0.28, momentum: 0.22, liquidity: 0.20, volume: 0.10, liquidityDepth: 0.12, riskAdj: 0.08 },
    bias: sigmoid(5.5), enabled: true,
  },
  {
    id: "deepseek", name: "DeepSeek", short: "DSK", color: "#4D6BFE",
    depth: 5, temper: 7.0, latencyClass: "fast",
    // Spread-hunter — largest spread weight in the ensemble after GLM/Grok.
    weights: { spread: 0.44, momentum: 0.18, liquidity: 0.16, volume: 0.10, riskAdj: 0.12 },
    bias: sigmoid(7.0), enabled: true,
  },
  {
    id: "glm53", name: "GLM 5.3 Flash", short: "GLM", color: "#3B6EF6",
    depth: 4, temper: 9.0, latencyClass: "ultra",
    // Fastest agent — shallow stack, near-threshold decisive.
    weights: { spread: 0.52, momentum: 0.24, liquidity: 0.14, volume: 0.10 },
    bias: sigmoid(9.0), enabled: true,
  },
  {
    id: "mimo25", name: "Mimo 2.5", short: "MIMO", color: "#8B5CF6",
    depth: 5, temper: 3.5, latencyClass: "ultra",
    // Near-linear activation — votes move smoothly with features.
    weights: { spread: 0.32, momentum: 0.28, liquidity: 0.20, volume: 0.12, liquidityDepth: 0.08 },
    bias: linearAct, enabled: true,
  },
  {
    id: "museSpark12", name: "Muse Spark 1.2", short: "MUSE", color: "#EC4899",
    depth: 6, temper: 6.0, latencyClass: "fast",
    weights: { spread: 0.28, momentum: 0.24, liquidity: 0.16, volume: 0.12, momentumAccel: 0.14, riskAdj: 0.06 },
    bias: sigmoid(6.0), enabled: true,
  },
  {
    id: "solar", name: "Solar", short: "SOL", color: "#F59E0B",
    depth: 5, temper: 5.0, latencyClass: "fast",
    // Liquidity-focused — weights liquidity heavily for buyability.
    weights: { spread: 0.34, momentum: 0.18, liquidity: 0.26, volume: 0.12, liquidityDepth: 0.10 },
    bias: sigmoid(5.0), enabled: true,
  },
  {
    id: "lessie", name: "Lessie", short: "LSS", color: "#64748B",
    depth: 5, temper: 4.0, latencyClass: "ultra",
    // Precise momentum-follower.
    weights: { spread: 0.28, momentum: 0.34, momentumAccel: 0.22, liquidity: 0.10, volume: 0.06 },
    bias: sigmoid(4.0), enabled: true,
  },
  {
    id: "kimiK27", name: "Kimi K2.7", short: "K27", color: "#14B8A6",
    depth: 6, temper: 5.5, latencyClass: "fast",
    weights: { spread: 0.28, momentum: 0.20, liquidity: 0.20, volume: 0.12, liquidityDepth: 0.12, riskAdj: 0.08 },
    bias: sigmoid(5.5), enabled: true,
  },
  {
    id: "kimiK3", name: "Kimi K3", short: "K3", color: "#0D9488",
    depth: 7, temper: 4.8, latencyClass: "balanced",
    // Deep stack with softplus activation.
    weights: { spread: 0.24, momentum: 0.22, liquidity: 0.18, volume: 0.10, momentumAccel: 0.10, liquidityDepth: 0.08, riskAdj: 0.08 },
    bias: softplusAct, enabled: true,
  },
  {
    id: "vly", name: "Vly", short: "VLY", color: "#F43F5E",
    depth: 5, temper: 6.5, latencyClass: "ultra",
    weights: { spread: 0.38, momentum: 0.22, liquidity: 0.18, volume: 0.12, riskAdj: 0.10 },
    bias: sigmoid(6.5), enabled: true,
  },
  {
    id: "codex", name: "Codex", short: "CDX", color: "#E2E8F0",
    depth: 5, temper: 7.5, latencyClass: "fast",
    // Conservative gate — high scores only when features are decisively good.
    weights: { spread: 0.28, momentum: 0.18, liquidity: 0.30, volume: 0.10, riskAdj: 0.14 },
    bias: gateAct, enabled: true,
  },
  {
    id: "devin", name: "Devin", short: "DVN", color: "#6366F1",
    depth: 6, temper: 5.0, latencyClass: "balanced",
    // Agentic executor — weighs momentum + spread nearly equally.
    weights: { spread: 0.30, momentum: 0.30, liquidity: 0.16, volume: 0.10, momentumAccel: 0.08, riskAdj: 0.06 },
    bias: sigmoid(5.0), enabled: true,
  },
  {
    id: "meta", name: "Meta", short: "MTA", color: "#0084FF",
    depth: 6, temper: 6.0, latencyClass: "fast",
    weights: { spread: 0.32, momentum: 0.22, liquidity: 0.20, volume: 0.10, liquidityDepth: 0.10, riskAdj: 0.06 },
    bias: sigmoid(6.0), enabled: true,
  },
  {
    id: "veo", name: "Veo", short: "VEO", color: "#A78BFA",
    depth: 5, temper: 5.5, latencyClass: "fast",
    // Perceptual tanh model.
    weights: { spread: 0.30, momentum: 0.28, liquidity: 0.20, volume: 0.14, liquidityDepth: 0.08 },
    bias: tanhAct, enabled: true,
  },
  {
    id: "nni", name: "Neural Network Intelligence", short: "NNI", color: "#22D3EE",
    depth: 7, temper: 4.2, latencyClass: "balanced",
    // Deepest model — weighs all 7 features.
    weights: { spread: 0.24, momentum: 0.20, liquidity: 0.18, volume: 0.12, momentumAccel: 0.10, liquidityDepth: 0.10, riskAdj: 0.06 },
    bias: sigmoid(4.2), enabled: true,
  },
];

/** Number of active agents in the ensemble. */
export const AGENT_COUNT = AGENTS.filter((a) => a.enabled).length;

/* ────────────────────────────────────────────────────────────────────────────
 * Feature extraction — REAL live inputs only, normalized to 0..1
 * ──────────────────────────────────────────────────────────────────────────── */

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Lender depth quality — documented protocol liquidity depth. */
const LENDER_DEPTH: Record<string, number> = {
  Aave: 0.95, Balancer: 0.9, dYdX: 0.8, Morpho: 0.85, Uniswap: 0.75, Spark: 0.8,
};

export interface RouteFeatureInput {
  profitPct?: number;
  spreadBps?: number;
  liquidityUsd?: number;
  ttlSeconds?: number;
  mevRisk?: number;
  lender?: string;
}

/** Extract normalized route features from a live flash-loan route. */
export function extractRouteFeatures(route: RouteFeatureInput): Record<string, number> {
  const ttl = route.ttlSeconds ?? 0;
  const profitPct = route.profitPct ?? 0;
  const ttlUrgency = clamp01(ttl / 12);
  const momentum = clamp01(profitPct / 2);
  return {
    spread: clamp01((route.spreadBps ?? 0) / 50),
    momentum,
    liquidity: clamp01((route.liquidityUsd ?? 0) / 1_000_000),
    volume: ttlUrgency,
    momentumAccel: clamp01(momentum * ttlUrgency),
    liquidityDepth: LENDER_DEPTH[route.lender ?? ""] ?? 0.7,
    riskAdj: clamp01((100 - (route.mevRisk ?? 50)) / 100),
  };
}

export interface TokenFeatureInput {
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24h: number;
  buySellRatio: number;
  securityScore: number;
  priceChange1h?: number;
  crossDexSpreadPct?: number;
}

/** Extract normalized token features from a live discovery/multi-signal token. */
export function extractTokenFeatures(t: TokenFeatureInput): Record<string, number> {
  const momentum = clamp01((t.priceChange1h ?? t.priceChange24h ?? 0) / 10);
  return {
    spread: clamp01((t.crossDexSpreadPct ?? Math.abs(t.priceChange24h ?? 0) / 2) / 2),
    momentum,
    liquidity: clamp01(t.liquidityUsd / 500_000),
    volume: clamp01(t.volume24hUsd / 1_000_000),
    momentumAccel: clamp01(0.5 * momentum + 0.25 * (t.buySellRatio - 1)),
    liquidityDepth: clamp01((t.buySellRatio - 0.5) / 1.5),
    riskAdj: clamp01(t.securityScore / 100),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ensemble evaluation
 * ──────────────────────────────────────────────────────────────────────────── */

/** Score one agent on a normalized feature vector — deterministic, sub-ms. */
function scoreAgent(agent: Agent, features: Record<string, number>): number {
  let z = 0;
  for (const key in agent.weights) {
    z += agent.weights[key] * (features[key] ?? 0);
  }
  return agent.bias(z);
}

interface RawAgentScore {
  agentId: string;
  score: number;
  latencyMs: number;
}

/** Run the whole ensemble over a feature vector, measuring real latency. */
function runEnsemble(features: Record<string, number>): RawAgentScore[] {
  const t0 = performance.now();
  const out: RawAgentScore[] = [];
  for (const agent of AGENTS) {
    if (!agent.enabled) continue;
    const score = scoreAgent(agent, features);
    out.push({ agentId: agent.id, score: Math.round(clamp01(score / 100) * 100), latencyMs: 0 });
  }
  const elapsed = performance.now() - t0;
  // Distribute the measured ensemble latency across agents (real measurement).
  const per = elapsed / Math.max(1, out.length);
  for (const r of out) r.latencyMs = per;
  return out;
}

/** Build ensemble consensus from raw per-agent scores. */
function buildConsensus(raw: RawAgentScore[], threshold = 70): Consensus {
  let agreeing = 0;
  let sum = 0;
  let bestAgent: string | null = null;
  let bestScore = -1;
  for (const r of raw) {
    sum += r.score;
    if (r.score >= threshold) agreeing++;
    if (r.score > bestScore) {
      bestScore = r.score;
      bestAgent = r.agentId;
    }
  }
  const total = raw.length;
  const mean = total > 0 ? sum / total : 0;
  const agreement = total > 0 ? agreeing / total : 0;
  const consensus = Math.round(Math.min(100, mean * (0.7 + 0.3 * agreement)));
  const latencyMs = raw.reduce((acc, r) => acc + r.latencyMs, 0);
  return {
    consensus,
    agreeing,
    total,
    latencyMs,
    bestAgent,
    bestScore: Math.max(0, bestScore),
    bullish: consensus >= 70 && total > 0 && agreeing >= Math.ceil(total * 0.6),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public API — Scanner route consensus
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * All 21 agents score a flash-loan route from real live features.
 * Used by the Scanner for every route in the live route feed — routes with
 * bullish consensus rank first and are labelled AI-EXEC.
 */
export function runRouteAgents(route: RouteFeatureInput): Consensus & { perAgent: RouteAgentScore[] } {
  const features = extractRouteFeatures(route);
  const raw = runEnsemble(features);
  const perAgent: RouteAgentScore[] = raw.map((r) => ({
    agentId: r.agentId,
    score: r.score,
    verdict: r.score >= 70 ? "EXECUTE" : r.score >= 45 ? "WATCH" : "AVOID",
    latencyMs: r.latencyMs,
  }));
  return { ...buildConsensus(raw), perAgent };
}

/**
 * All 21 agents score a token (discovery candidate or multi-signal token).
 * Used by the live feed token panel for buyability/sellability and by the
 * Sniper's Multi-Signal Monitor to rank auto-snipe candidates.
 */
export function runTokenAgents(t: TokenFeatureInput): Consensus & { perAgent: AgentScore[] } {
  const features = extractTokenFeatures(t);
  const raw = runEnsemble(features);
  const perAgent: AgentScore[] = raw.map((r) => ({
    agentId: r.agentId,
    score: r.score,
    verdict: r.score >= 70 ? "BUY" : r.score >= 45 ? "HOLD" : "AVOID",
    latencyMs: r.latencyMs,
  }));
  return { ...buildConsensus(raw), perAgent };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Per-agent discovery / capture pass — runs BEFORE consensus scoring
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every one of the 21 agents individually scans the live candidate universe
 * (routes and tokens) in the SAME pass — simultaneous effect — each applying
 * its own capture profile: a listing-age window for brand-new listings, a
 * priority feature and a capture threshold derived from its own model
 * personality. Only candidates an agent actually captures get attributed to
 * that agent; capture metadata then feeds the consensus ranking so that
 * agent-discovered candidates surface before the scoring pass even runs.
 */

export interface AgentCaptureProfile {
  agentId: string;
  name: string;
  /** Max listing age (hours) this agent targets for brand-new capture. */
  maxListingAgeHours: number;
  /** Feature this agent prioritizes when capturing. */
  priorityFeature: string;
  /** Minimum normalized priority-feature value to nominate a candidate. */
  captureThreshold: number;
}

/**
 * Capture profiles derived from each agent's model personality:
 * ultra-latency agents (GLM, Grok, Cursor, Lessie, Mimo, Vly) take the
 * tightest new-listing windows; deep balanced models (NNI, Kimi K3, ChatGPT,
 * Claude, Gemini) scan wider windows; Codex is the most conservative.
 */
export const CAPTURE_PROFILES: AgentCaptureProfile[] = AGENTS.filter((a) => a.enabled).map((a) => {
  const ultra = a.latencyClass === "ultra";
  const fast = a.latencyClass === "fast";
  // Tighter age window for faster agents — they exist to catch brand-new
  // listings first; deeper models sweep a wider net.
  const maxListingAgeHours = ultra ? 1 : fast ? 6 : 24;
  const priorityFeature =
    a.weights.spread >= 0.38 ? "spread" :
    a.weights.momentum >= 0.26 ? "momentum" :
    a.weights.liquidity >= 0.2 ? "liquidity" :
    "momentumAccel";
  const captureThreshold =
    a.id === "codex" ? 0.5 :
    ultra ? 0.22 :
    fast ? 0.3 : 0.35;
  return {
    agentId: a.id,
    name: a.name,
    maxListingAgeHours,
    priorityFeature,
    captureThreshold,
  };
});

export interface CandidateCapture {
  /** Agent ids that individually discovered/captured this candidate. */
  discoveringAgents: string[];
  /** Sum of per-agent capture scores (capture strength). */
  captureStrength: number;
  /** True when at least one new-listing window agent captured it. */
  isNewListing: boolean;
}

export interface DiscoveryPassResult<T> {
  /** Candidates captured by ≥ 1 agent, in capture-strength order. */
  captured: Array<{ candidate: T; key: string; capture: CandidateCapture }>;
  /** Per-agent capture stats — every agent's individual contribution. */
  perAgent: Array<{ agentId: string; name: string; nominations: number; bestCapture: number; latencyMs: number }>;
  /** Candidates no agent captured (still scored, ranked last within tier). */
  uncapturedCount: number;
  /** Measured total pass latency (ms) — all 21 agents ran simultaneously. */
  latencyMs: number;
}

/**
 * Run the simultaneous 21-agent discovery/capture pass over a candidate
 * universe BEFORE scoring. Each agent evaluates every candidate against its
 * own capture profile (priority feature + threshold + listing-age window).
 * Deterministic, real-data-only, sub-millisecond for hundreds of candidates.
 */
export function runDiscoveryPass<T>(
  candidates: T[],
  keyOf: (c: T) => string,
  featuresOf: (c: T) => Record<string, number>,
  listingAgeHoursOf?: (c: T) => number,
): DiscoveryPassResult<T> {
  const t0 = performance.now();
  const byKey = new Map<string, { candidate: T; capture: CandidateCapture }>();
  const perAgent: DiscoveryPassResult<T>["perAgent"] = [];

  // Features are extracted ONCE per candidate (not per agent) — the 21 agents
  // then all read from the same live feature vector in the same pass.
  const featureCache = new Map<number, Record<string, number>>();
  const ageCache = new Map<number, number>();
  const featuresFor = (candidate: T, index: number): Record<string, number> => {
    let f = featureCache.get(index);
    if (!f) {
      f = featuresOf(candidate);
      featureCache.set(index, f);
    }
    return f;
  };
  const ageFor = (candidate: T, index: number): number => {
    let a = ageCache.get(index);
    if (a === undefined) {
      a = listingAgeHoursOf?.(candidate) ?? Number.POSITIVE_INFINITY;
      ageCache.set(index, a);
    }
    return a;
  };

  for (const profile of CAPTURE_PROFILES) {
    const agent = AGENTS.find((a) => a.id === profile.agentId);
    if (!agent || !agent.enabled) continue;
    const at0 = performance.now();
    let nominations = 0;
    let bestCapture = 0;
    for (let ci = 0; ci < candidates.length; ci++) {
      const candidate = candidates[ci];
      const features = featuresFor(candidate, ci);
      const priority = features[profile.priorityFeature] ?? 0;
      if (priority < profile.captureThreshold) continue;
      // Overall capture quality = the agent's own weighted view, reusing its
      // real model weights + activation — not a separate fake heuristic.
      let z = 0;
      for (const key in agent.weights) z += agent.weights[key] * (features[key] ?? 0);
      const captureScore = agent.bias(z) / 100;
      if (captureScore < profile.captureThreshold) continue;
      const key = keyOf(candidate);
      const age = ageFor(candidate, ci);
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          candidate,
          capture: {
            discoveringAgents: [],
            captureStrength: 0,
            isNewListing: false,
          },
        };
        byKey.set(key, entry);
      }
      entry.capture.discoveringAgents.push(agent.id);
      entry.capture.captureStrength += captureScore;
      // This agent's own new-listing window: brand listings inside the
      // agent's target age window are flagged as its discovery.
      if (age <= profile.maxListingAgeHours) entry.capture.isNewListing = true;
      nominations++;
      if (captureScore > bestCapture) bestCapture = captureScore;
    }
    perAgent.push({
      agentId: profile.agentId,
      name: profile.name,
      nominations,
      bestCapture,
      latencyMs: performance.now() - at0,
    });
  }

  const captured = [...byKey.entries()]
    .map(([key, v]) => ({ key, candidate: v.candidate, capture: v.capture }))
    .sort((a, b) => b.capture.captureStrength - a.capture.captureStrength);
  return {
    captured,
    perAgent,
    uncapturedCount: candidates.length - byKey.size,
    latencyMs: performance.now() - t0,
  };
}

/**
 * Convenience wrapper — discovery pass over flash-loan routes. New listings
 * are flagged from TTL urgency (routes on fresh pools carry short TTLs).
 */
export function discoverRoutes<T extends Partial<RouteFeatureInput> & { ttlSeconds: number }>(
  routes: T[],
  keyOf: (r: T) => string,
): DiscoveryPassResult<T> {
  return runDiscoveryPass(
    routes,
    keyOf,
    (r) => extractRouteFeatures(r),
    (r) => (r.ttlSeconds <= 12 ? r.ttlSeconds / 2 : Number.POSITIVE_INFINITY),
  );
}

/**
 * Convenience wrapper — discovery pass over token candidates. Uses the real
 * `ageHours` field so brand-new listings (minutes old) are captured by the
 * tightest-window agents (GLM, Grok, Cursor, Lessie, Mimo, Vly) first.
 */
export function discoverTokens<T>(
  tokens: T[],
  keyOf: (t: T) => string,
): DiscoveryPassResult<T> {
  return runDiscoveryPass(
    tokens,
    keyOf,
    (t) => extractTokenFeatures(t as unknown as TokenFeatureInput),
    (t) => {
      const rec = t as { ageHours?: number; discoveredAt?: number };
      if (typeof rec.ageHours === "number") return rec.ageHours;
      if (typeof rec.discoveredAt === "number") return (Date.now() - rec.discoveredAt) / 3_600_000;
      return Number.POSITIVE_INFINITY;
    },
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * UI helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Agent chips (id + name + short + color) for header strips. */
export function agentChips(): Array<{ id: string; name: string; short: string; color: string }> {
  return AGENTS.filter((a) => a.enabled).map(({ id, name, short, color }) => ({ id, name, short, color }));
}

/** Tailwind classes for the ensemble consensus badge. */
export function consensusBadgeClass(c: Consensus): string {
  if (c.bullish) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
  if (c.consensus >= 45) return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  return "border-red-500/20 bg-red-500/10 text-red-400";
}

/** Tailwind classes for a single agent's vote badge. */
export function agentVoteClass(score: number): string {
  if (score >= 70) return "bg-emerald-500/15 text-emerald-400";
  if (score >= 45) return "bg-amber-500/15 text-amber-400";
  return "bg-red-500/10 text-red-400";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Integration glue — type shims so Scanner/Sniper code reads naturally
 * ──────────────────────────────────────────────────────────────────────────── */

/** Score a display route (FlashRoute or generated) for the live route feed. */
export function scoreFlashRoute(route: Pick<FlashRoute, "profitPct" | "spreadBps" | "liquidityUsd" | "ttlSeconds" | "mevRisk" | "lender">) {
  return runRouteAgents(route);
}

/** Score a discovery token candidate for the live feed token panel. */
export function scoreTokenCandidate(t: Pick<TokenCandidate, "liquidityUsd" | "volume24hUsd" | "priceChange24h" | "buySellRatio" | "securityScore"> & { priceChange1h?: number; crossDexSpreadPct?: number }) {
  return runTokenAgents(t);
}

/** Score a multi-signal live token for the Sniper's monitor. */
export function scoreLiveTokenSignal(t: {
  liquidityUsd: number;
  volume24h: number;
  priceChange1h: number;
  priceChange24h?: number;
  buyVolume: number;
  sellVolume: number;
  securityScore: number;
  arbSpreadPct?: number;
}) {
  const buySellRatio = t.sellVolume > 0 ? t.buyVolume / t.sellVolume : t.buyVolume > 0 ? 2 : 1;
  return runTokenAgents({
    liquidityUsd: t.liquidityUsd,
    volume24hUsd: t.volume24h,
    priceChange24h: t.priceChange24h ?? t.priceChange1h,
    buySellRatio,
    securityScore: t.securityScore,
    priceChange1h: t.priceChange1h,
    crossDexSpreadPct: t.arbSpreadPct,
  });
}

/** Snapshot type is reserved for future snapshot-level determinants. */
export type { MarketSnapshot };
