/**
 * Pure Telegram channel alert layer — the exact messages and payloads that
 * the Convex backend delivers to the channel. Everything here is
 * deterministic formatting over real data (executions, live market
 * snapshots, persisted fleet metrics, the real UTC session clock); the only
 * non-deterministic part — the actual HTTPS POST to the Telegram Bot API —
 * lives in src/convex/notifications.ts and is never called from tests.
 *
 * Channel policy (documented and enforced at the call sites in the backend):
 * the Telegram channel carries ONLY
 *   1. flash-loan trades + earnings (operator and subscriber accounts), and
 *   2. the explicit session dashboards (market session update, core network,
 *      AI market score, current operating metrics).
 * Everything else stays in-app (the bell) and/or goes to the terminal
 * operator's email — never to Telegram.
 */

// ---------------------------------------------------------------------------
// Channel policy
// ---------------------------------------------------------------------------

export type TelegramChannelKind = "trade_earnings" | "session_dashboard";

export interface TelegramChannelRule {
  kind: TelegramChannelKind;
  label: string;
  description: string;
}

/** The complete documented list of what the channel is allowed to carry. */
export const TELEGRAM_CHANNEL_POLICY: TelegramChannelRule[] = [
  {
    kind: "trade_earnings",
    label: "Flash-loan trades + earnings",
    description:
      "Successful flash-loan executions and their earnings — operator and subscriber accounts alike.",
  },
  {
    kind: "session_dashboard",
    label: "Session dashboards",
    description:
      "Explicit market-session updates: session state, core network (mainnet/testnet), AI market score, current operating metrics.",
  },
];

/** Is this alert kind permitted on the Telegram channel per the policy? */
export function isChannelAllowed(kind: string): boolean {
  return TELEGRAM_CHANNEL_POLICY.some((rule) => rule.kind === kind);
}

// ---------------------------------------------------------------------------
// Bot API payload — the exact JSON posted to api.telegram.org
// ---------------------------------------------------------------------------

/** Build the exact JSON body the Bot API receives for a channel message. */
export function buildTelegramPayload(
  chatId: string,
  title: string,
  body: string,
): {
  chat_id: string;
  text: string;
  disable_web_page_preview: true;
} {
  return {
    chat_id: chatId,
    text: `⚡ FlashBolt — ${title}\n${body}`,
    disable_web_page_preview: true,
  };
}

// ---------------------------------------------------------------------------
// Flash-loan trade + earnings alert (kind: trade_earnings)
// ---------------------------------------------------------------------------

export interface TradeAlertInput {
  /** "operator" | "subscriber" — which account executed the trade. */
  role: string;
  amountBnb: number;
  symbol: string;
  label: string;
  lender: string | null | undefined;
  profitPct: number;
  network: string;
  /** Actual payout when paid out, otherwise the execution amount. */
  earnings: number;
  txHash: string | null | undefined;
  /**
   * REAL measured signing latency in ms (performance.now() around the actual
   * account.signTransaction call in the production executor). Optional: the
   * injected-wallet path cannot measure the extension's signing, and omitting
   * the field renders nothing — never an estimate, never a mock.
   */
  signingLatencyMs?: number;
}

export interface TradeAlert {
  title: string;
  body: string;
}

/**
 * Format the measured signing latency for an alert line: sub-ms values in
 * microseconds ("≈740µs"), ms values with one decimal ("2.4ms"). Receives a
 * real measurement or undefined — renders nothing when absent.
 */
export function fmtSignLatency(signingLatencyMs: number | undefined): string {
  if (signingLatencyMs === undefined || !Number.isFinite(signingLatencyMs) || signingLatencyMs < 0) {
    return "";
  }
  return signingLatencyMs < 1
    ? `sign ≈${Math.round(signingLatencyMs * 1000)}µs`
    : `sign ${signingLatencyMs.toFixed(1)}ms`;
}

/**
 * Format the ONLY trade alert the channel carries: a successful flash-loan
 * execution + its earnings. Mirrors the exact format the backend has always
 * delivered; the only addition is the measured signing latency when the
 * caller provides one.
 */
export function buildTradeAlert(input: TradeAlertInput): TradeAlert {
  const txPart = input.txHash ? ` · tx ${input.txHash.slice(0, 10)}…` : "";
  const latencyPart = fmtSignLatency(input.signingLatencyMs);
  return {
    title: `Trade executed · ${input.role} · +${input.amountBnb.toFixed(4)} ${input.symbol}${latencyPart ? ` · ${latencyPart}` : ""}`,
    body: `${input.label} · lender ${input.lender ?? "—"} · +${input.profitPct.toFixed(2)}% · ${input.network} · earnings +${input.earnings.toFixed(4)} ${input.symbol}${txPart}${latencyPart ? ` · ${latencyPart}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Session dashboard signal (kind: session_dashboard)
// ---------------------------------------------------------------------------

export interface SessionDef {
  key: string;
  label: string;
  flag: string;
  /** UTC minutes-of-day the session opens. */
  openMin: number;
  /** UTC minutes-of-day the session closes (may be < openMin — crosses midnight). */
  closeMin: number;
  /** Liquidity ranking used to pick the primary open session (highest wins). */
  tier: number;
  windowLabel: string;
}

export const SESSION_DEFS: SessionDef[] = [
  {
    key: "sydney",
    label: "Sydney",
    flag: "🇦🇺",
    openMin: 21 * 60,
    closeMin: 6 * 60,
    tier: 1,
    windowLabel: "21:00–06:00 UTC",
  },
  {
    key: "tokyo",
    label: "Tokyo",
    flag: "🇯🇵",
    openMin: 0,
    closeMin: 9 * 60,
    tier: 2,
    windowLabel: "00:00–09:00 UTC",
  },
  {
    key: "london",
    label: "London",
    flag: "🇬🇧",
    openMin: 7 * 60,
    closeMin: 16 * 60,
    tier: 4,
    windowLabel: "07:00–16:00 UTC",
  },
  {
    key: "new_york",
    label: "New York",
    flag: "🇺🇸",
    openMin: 12 * 60,
    closeMin: 21 * 60,
    tier: 3,
    windowLabel: "12:00–21:00 UTC",
  },
];

export interface SessionSnapshot {
  now: number;
  sessions: {
    key: string;
    label: string;
    flag: string;
    windowLabel: string;
    tier: number;
    isOpen: boolean;
    nextOpenAt: number;
    nextCloseAt: number;
  }[];
  openKeys: string[];
  primary: { key: string; label: string; flag: string; windowLabel: string } | null;
  regime: string;
  nextChangeAt: number;
  nextChangeKind: "open" | "close";
  nextChangeLabel: string;
  nextChangeFlag: string;
}

export interface AiScore {
  score: number;
  rating: string;
  dispersion: number;
  routeCount: number;
  avgEdge: number;
  totalLiq: number;
  totalVol: number;
  gasGwei: number | null;
  components: {
    dispersionScore: number;
    depthScore: number;
    volumeScore: number;
    routeScore: number;
    edgeScore: number;
    gasPenalty: number;
  };
}

export interface FleetMetrics {
  activeTerminals: number;
  runningBots: number;
  executionsToday: number;
  successesToday: number;
  winRate: number;
  pnlToday: number;
  onChainToday: number;
  lifetimePnl: number;
  payoutsTotal: number;
  openOpportunities: number;
  scansToday: number;
  liveCount: number;
  networks: { mainnet: number; testnet: number };
  chains: string[];
}

/** "HH:MM–HH:MM UTC" window label for a session definition. */
export function fmtWindowLabel(openMin: number, closeMin: number): string {
  const hh = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hh(openMin)}–${hh(closeMin)} UTC`;
}

/**
 * Apply operator window overrides (UTC minutes-of-day) onto the standard
 * session definitions. Unlisted sessions keep their defaults; window labels
 * are recomputed from the real numbers.
 */
export function mergeSessionOverrides(
  defs: SessionDef[],
  overrides: Record<string, { openMin: number; closeMin: number }>,
): SessionDef[] {
  return defs.map((def) => {
    const o = overrides[def.key];
    if (!o) return def;
    return {
      ...def,
      openMin: o.openMin,
      closeMin: o.closeMin,
      windowLabel: fmtWindowLabel(o.openMin, o.closeMin),
    };
  });
}

/** Session state at an absolute UTC instant — pure clock math, real time. */
export function sessionStateAt(now: number): SessionSnapshot {
  return sessionStateAtWith(now, SESSION_DEFS);
}

/** Session state against explicit definitions (defaults or operator overrides). */
export function sessionStateAtWith(
  now: number,
  defs: SessionDef[],
): SessionSnapshot {
  const d = new Date(now);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const nowMin = (now - dayStart) / 60000;

  const sessions = defs.map((s) => {
    const isOpen =
      s.openMin < s.closeMin
        ? nowMin >= s.openMin && nowMin < s.closeMin
        : nowMin >= s.openMin || nowMin < s.closeMin;
    let nextOpenAt = dayStart + s.openMin * 60000;
    if (nextOpenAt <= now) nextOpenAt += 86400000;
    let nextCloseAt = dayStart + s.closeMin * 60000;
    if (nextCloseAt <= now) nextCloseAt += 86400000;
    return {
      key: s.key,
      label: s.label,
      flag: s.flag,
      windowLabel: s.windowLabel,
      tier: s.tier,
      isOpen,
      nextOpenAt,
      nextCloseAt,
    };
  });

  const open = sessions.filter((s) => s.isOpen);
  const openKeys = open.map((s) => s.key);
  const primary = open.length
    ? open.reduce((a, b) => (b.tier > a.tier ? b : a))
    : null;

  let nextChangeAt = Infinity;
  let nextChangeKind: "open" | "close" = "open";
  let nextChangeSession: SessionSnapshot["sessions"][number] | null = null;
  for (const s of sessions) {
    const at = s.isOpen ? s.nextCloseAt : s.nextOpenAt;
    if (at < nextChangeAt) {
      nextChangeAt = at;
      nextChangeKind = s.isOpen ? "close" : "open";
      nextChangeSession = s;
    }
  }

  let regime = "All sessions closed — lowest-liquidity window";
  if (openKeys.includes("london") && openKeys.includes("new_york")) {
    regime = "London + New York overlap — highest-volume window";
  } else if (openKeys.includes("tokyo") && openKeys.includes("london")) {
    regime = "Tokyo + London overlap";
  } else if (openKeys.includes("sydney") && openKeys.includes("tokyo")) {
    regime = "Sydney + Tokyo overlap";
  } else if (primary) {
    regime = `${primary.label} solo session`;
  }

  return {
    now,
    sessions,
    openKeys,
    primary: primary
      ? {
          key: primary.key,
          label: primary.label,
          flag: primary.flag,
          windowLabel: primary.windowLabel,
        }
      : null,
    regime,
    nextChangeAt: Number.isFinite(nextChangeAt) ? nextChangeAt : now + 3600000,
    nextChangeKind,
    nextChangeLabel: nextChangeSession?.label ?? "—",
    nextChangeFlag: nextChangeSession?.flag ?? "🌙",
  };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** The full session dashboard message delivered to the channel. */
export function buildSignalMessage(
  session: SessionSnapshot,
  score: AiScore,
  metrics: FleetMetrics,
  kind: "session_open" | "session_update",
): { title: string; body: string } {
  const primary = session.primary;
  const primaryLine = primary
    ? `${primary.flag} ${primary.label} OPEN (${primary.windowLabel})`
    : "🌙 All market sessions closed (06:00–07:00 UTC gap)";

  const title =
    kind === "session_open" && primary
      ? `Session open — ${primary.label}`
      : "Market Session Update";

  const chainLabel =
    metrics.chains.length === 0
      ? "no chains scanned yet"
      : `${metrics.chains.length} chain${metrics.chains.length > 1 ? "s" : ""} scanned (${metrics.chains.join(", ")})`;

  const body = [
    primaryLine,
    `Regime: ${session.regime}`,
    ``,
    `📊 AI Market Score: ${score.score}/100 — ${score.rating}`,
    `  • Cross-DEX dispersion: ${score.dispersion.toFixed(2)}% · live routes: ${score.routeCount}`,
    `  • Avg edge (top 8): +${score.avgEdge.toFixed(2)}% · liq: ${fmtUsd(score.totalLiq)} · vol 24h: ${fmtUsd(score.totalVol)}`,
    `  • Core gas: ${score.gasGwei == null ? "—" : `${score.gasGwei.toFixed(1)} gwei`}`,
    ``,
    `🕸 Core network: BSC mainnet · ${chainLabel}`,
    `  • Terminals: ${metrics.activeTerminals} active · ${metrics.runningBots} bots running`,
    `  • Executions today: ${metrics.executionsToday} · wins ${metrics.successesToday} (${metrics.winRate}%)`,
    `  • Fleet PnL today: +${metrics.pnlToday.toFixed(4)} BNB · opportunities: ${metrics.openOpportunities}`,
    `  • Network split: ${metrics.networks.mainnet} mainnet / ${metrics.networks.testnet} testnet`,
    ``,
    `⏭ Next change: ${session.nextChangeFlag} ${session.nextChangeLabel} ${session.nextChangeKind === "open" ? "opens" : "closes"} in ${fmtDuration(session.nextChangeAt - session.now)}`,
  ].join("\n");

  return { title, body };
}
