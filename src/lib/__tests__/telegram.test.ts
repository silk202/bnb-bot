import { describe, expect, test } from "bun:test";
import {
  buildSignalMessage,
  buildTelegramPayload,
  buildTradeAlert,
  isChannelAllowed,
  mergeSessionOverrides,
  SESSION_DEFS,
  sessionStateAt,
  sessionStateAtWith,
  TELEGRAM_CHANNEL_POLICY,
  type AiScore,
  type FleetMetrics,
  type SessionDef,
} from "../telegram";
import {
  enginesMessage,
  mainMenu,
  parseBotCommand,
  type EngineStamp,
} from "../telegramBot";

const NOON_UTC = new Date("2026-08-09T12:00:00Z").getTime();
const TEN_PM_UTC = new Date("2026-08-09T22:00:00Z").getTime();

const SCORE: AiScore = {
  score: 78,
  rating: "Hot",
  dispersion: 2.75,
  routeCount: 9,
  avgEdge: 0.85,
  totalLiq: 2_500_000,
  totalVol: 9_000_000,
  gasGwei: 3.2,
  components: {
    dispersionScore: 88,
    depthScore: 40,
    volumeScore: 60,
    routeScore: 54,
    edgeScore: 51,
    gasPenalty: 6,
  },
};

const METRICS: FleetMetrics = {
  activeTerminals: 3,
  runningBots: 2,
  executionsToday: 14,
  successesToday: 11,
  winRate: 79,
  pnlToday: 0.0421,
  onChainToday: 4,
  lifetimePnl: 1.2345,
  payoutsTotal: 0.5,
  openOpportunities: 6,
  scansToday: 88,
  liveCount: 1,
  networks: { mainnet: 2, testnet: 1 },
  chains: ["bsc", "ethereum", "arbitrum", "polygon"],
};

describe("telegram channel policy — what the channel is allowed to carry", () => {
  test("policy lists exactly trade/earnings and session dashboards", () => {
    expect(TELEGRAM_CHANNEL_POLICY.map((rule) => rule.kind)).toEqual([
      "trade_earnings",
      "session_dashboard",
    ]);
  });

  test("only policy kinds are allowed on the channel", () => {
    expect(isChannelAllowed("trade_earnings")).toBe(true);
    expect(isChannelAllowed("session_dashboard")).toBe(true);
    // Everything else stays in-app and/or goes to the operator's email.
    expect(isChannelAllowed("market_news")).toBe(false);
    expect(isChannelAllowed("honey_pot")).toBe(false);
    expect(isChannelAllowed("execution")).toBe(false);
    expect(isChannelAllowed("session_update")).toBe(false);
    expect(isChannelAllowed("support")).toBe(false);
  });
});

describe("buildTelegramPayload — exact Bot API body", () => {
  test("carries the chat id, FlashBolt prefix and preview disabled", () => {
    const payload = buildTelegramPayload(
      "-1001234567890",
      "Trade executed · operator · +0.1250 BNB",
      "route · lender Aave · +1.23% · mainnet · earnings +0.1250 BNB",
    );
    expect(payload.chat_id).toBe("-1001234567890");
    expect(payload.disable_web_page_preview).toBe(true);
    expect(payload.text).toBe(
      "⚡ FlashBolt — Trade executed · operator · +0.1250 BNB\nroute · lender Aave · +1.23% · mainnet · earnings +0.1250 BNB",
    );
  });
});

describe("buildTradeAlert — flash-loan trade + earnings message", () => {
  const base = {
    role: "operator",
    amountBnb: 0.125,
    symbol: "BNB",
    label: "USDT→BUSD→BNB route",
    lender: "Aave",
    profitPct: 1.23456,
    network: "mainnet",
    earnings: 0.125,
    txHash: null as string | null,
  };

  test("formats the operator trade alert with a truncated tx hash", () => {
    const alert = buildTradeAlert({
      ...base,
      txHash: "0xabcdef1234567890abcdef",
    });
    expect(alert.title).toBe("Trade executed · operator · +0.1250 BNB");
    expect(alert.body).toBe(
      "USDT→BUSD→BNB route · lender Aave · +1.23% · mainnet · earnings +0.1250 BNB · tx 0xabcdef12…",
    );
  });

  test("formats the earnings value it is given (payout vs amount decided at the call site)", () => {
    // The backend picks earnings = payout > 0 ? payout : amountBnb before
    // calling this builder; the builder formats exactly that number.
    const alert = buildTradeAlert({ ...base, earnings: 0 });
    expect(alert.body).toContain("earnings +0.0000 BNB");
  });

  test("renders a missing lender and missing tx hash honestly", () => {
    const alert = buildTradeAlert({ ...base, lender: null, txHash: null });
    expect(alert.body).toBe(
      "USDT→BUSD→BNB route · lender — · +1.23% · mainnet · earnings +0.1250 BNB",
    );
    expect(alert.body).not.toContain("tx ");
  });

  test("sub-millisecond signing latency renders in microseconds — real measurement only", () => {
    const alert = buildTradeAlert({ ...base, signingLatencyMs: 0.741 });
    expect(alert.title).toContain("· sign ≈741µs");
    expect(alert.body).toContain("· sign ≈741µs");
  });

  test("absent or unmeasurable signing latency renders nothing — never an estimate", () => {
    const omitted = buildTradeAlert({ ...base });
    expect(omitted.title).not.toContain("sign");
    const injectedWalletPath = buildTradeAlert({ ...base, signingLatencyMs: undefined });
    expect(injectedWalletPath.title).not.toContain("sign");
    const nan = buildTradeAlert({ ...base, signingLatencyMs: NaN });
    expect(nan.title).not.toContain("sign");
    expect(nan.body).not.toContain("sign");
  });

  test("subscriber trades use the subscriber role label", () => {
    const alert = buildTradeAlert({ ...base, role: "subscriber" });
    expect(alert.title).toBe("Trade executed · subscriber · +0.1250 BNB");
  });
});

describe("market session clock — real UTC windows", () => {
  test("noon UTC: London + New York overlap, London primary, London closes in 4h", () => {
    const s = sessionStateAt(NOON_UTC);
    expect(s.openKeys).toEqual(["london", "new_york"]);
    expect(s.primary?.key).toBe("london");
    expect(s.primary?.windowLabel).toBe("07:00–16:00 UTC");
    expect(s.regime).toBe("London + New York overlap — highest-volume window");
    expect(s.nextChangeKind).toBe("close");
    expect(s.nextChangeLabel).toBe("London");
    expect(s.nextChangeFlag).toBe("🇬🇧");
    expect(s.nextChangeAt - s.now).toBe(4 * 3600000);
  });

  test("2am UTC: Sydney + Tokyo overlap, Tokyo primary (higher liquidity tier)", () => {
    const s = sessionStateAt(new Date("2026-08-09T02:00:00Z").getTime());
    expect(s.openKeys).toEqual(["sydney", "tokyo"]);
    expect(s.primary?.key).toBe("tokyo");
    expect(s.regime).toBe("Sydney + Tokyo overlap");
    expect(s.nextChangeKind).toBe("close");
    expect(s.nextChangeLabel).toBe("Sydney");
    expect(s.nextChangeAt - s.now).toBe(4 * 3600000);
  });

  test("10pm UTC: only Sydney is open; Tokyo reopening at midnight is the next change", () => {
    const s = sessionStateAt(TEN_PM_UTC);
    expect(s.openKeys).toEqual(["sydney"]);
    expect(s.primary?.key).toBe("sydney");
    expect(s.regime).toBe("Sydney solo session");
    expect(s.nextChangeKind).toBe("open");
    expect(s.nextChangeLabel).toBe("Tokyo");
    expect(s.nextChangeFlag).toBe("🇯🇵");
    expect(s.nextChangeAt - s.now).toBe(2 * 3600000);
  });

  test("all sessions closed reports the closed regime and next open", () => {
    const onlySolo: SessionDef[] = [
      {
        key: "solo",
        label: "Solo",
        flag: "🏝",
        openMin: 12 * 60,
        closeMin: 13 * 60,
        tier: 1,
        windowLabel: "12:00–13:00 UTC",
      },
    ];
    const s = sessionStateAtWith(new Date("2026-08-09T15:00:00Z").getTime(), onlySolo);
    expect(s.openKeys).toEqual([]);
    expect(s.primary).toBeNull();
    expect(s.regime).toBe("All sessions closed — lowest-liquidity window");
    expect(s.nextChangeKind).toBe("open");
    expect(s.nextChangeLabel).toBe("Solo");
    expect(s.nextChangeAt - s.now).toBe(21 * 3600000);
  });

  test("operator window overrides change the clock and are recomputed labels", () => {
    const merged = mergeSessionOverrides(SESSION_DEFS, {
      london: { openMin: 8 * 60, closeMin: 17 * 60 },
    });
    const london = merged.find((d) => d.key === "london")!;
    expect(london.openMin).toBe(480);
    expect(london.closeMin).toBe(1020);
    expect(london.windowLabel).toBe("08:00–17:00 UTC");
    const sydney = merged.find((d) => d.key === "sydney")!;
    expect(sydney.windowLabel).toBe("21:00–06:00 UTC"); // untouched
    const s = sessionStateAtWith(NOON_UTC, merged);
    expect(s.primary?.windowLabel).toBe("08:00–17:00 UTC");
  });
});

describe("buildSignalMessage — the session dashboard delivered to the channel", () => {
  test("session_open names the new primary session", () => {
    const session = sessionStateAt(NOON_UTC);
    const msg = buildSignalMessage(session, SCORE, METRICS, "session_open");
    expect(msg.title).toBe("Session open — London");
  });

  test("session_update uses the periodic title", () => {
    const session = sessionStateAt(NOON_UTC);
    const msg = buildSignalMessage(session, SCORE, METRICS, "session_update");
    expect(msg.title).toBe("Market Session Update");
  });

  test("body carries the full real dashboard — session, score, network, metrics, countdown", () => {
    const session = sessionStateAt(NOON_UTC);
    const msg = buildSignalMessage(session, SCORE, METRICS, "session_update");
    expect(msg.body).toBe(
      [
        "🇬🇧 London OPEN (07:00–16:00 UTC)",
        "Regime: London + New York overlap — highest-volume window",
        "",
        "📊 AI Market Score: 78/100 — Hot",
        "  • Cross-DEX dispersion: 2.75% · live routes: 9",
        "  • Avg edge (top 8): +0.85% · liq: $2.50M · vol 24h: $9.00M",
        "  • Core gas: 3.2 gwei",
        "",
        "🕸 Core network: BSC mainnet · 4 chains scanned (bsc, ethereum, arbitrum, polygon)",
        "  • Terminals: 3 active · 2 bots running",
        "  • Executions today: 14 · wins 11 (79%)",
        "  • Fleet PnL today: +0.0421 BNB · opportunities: 6",
        "  • Network split: 2 mainnet / 1 testnet",
        "",
        "⏭ Next change: 🇬🇧 London closes in 4h",
      ].join("\n"),
    );
  });

  test("unknown gas renders a dash, no chains renders an honest placeholder", () => {
    const session = sessionStateAt(NOON_UTC);
    const msg = buildSignalMessage(
      session,
      { ...SCORE, gasGwei: null },
      { ...METRICS, chains: [] },
      "session_update",
    );
    expect(msg.body).toContain("• Core gas: —");
    expect(msg.body).toContain("🕸 Core network: BSC mainnet · no chains scanned yet");
  });

  test("all-closed sessions use the closed primary line", () => {
    const onlySolo: SessionDef[] = [
      {
        key: "solo",
        label: "Solo",
        flag: "🏝",
        openMin: 12 * 60,
        closeMin: 13 * 60,
        tier: 1,
        windowLabel: "12:00–13:00 UTC",
      },
    ];
    const session = sessionStateAtWith(
      new Date("2026-08-09T15:00:00Z").getTime(),
      onlySolo,
    );
    const msg = buildSignalMessage(session, SCORE, METRICS, "session_update");
    expect(msg.title).toBe("Market Session Update");
    expect(msg.body).toContain("🌙 All market sessions closed (06:00–07:00 UTC gap)");
  });
})

describe("TAEngine console — 24/7 engine board", () => {
  const NOW = new Date("2026-09-29T12:00:00Z").getTime();
  const stamp = (at: number | null, source: "client" | "server" | null): EngineStamp => ({ at, source });

  test("enginesMessage renders ON engines with honest freshness + driver", () => {
    const m = enginesMessage(
      { bnb: true, sol: true },
      {
        bnbScan: stamp(NOW - 30_000, "server"),
        solScan: stamp(NOW - 90_000, "client"),
        bnbSniper: stamp(null, null),
        solSniper: stamp(NOW - 3_600_000, "server"),
      },
      NOW,
    );
    expect(m.text).toContain("BNB scanner: 🟢 ON · last pass 30s ago (engine)");
    expect(m.text).toContain("SOL scanner: 🟢 ON · last pass 2m ago (app)");
    expect(m.text).toContain("BNB sniper: 🟢 ON · starting…");
    expect(m.text).toContain("SOL sniper: 🟢 ON · last pass 1h ago (engine)");
  });

  test("enginesMessage shows OFF engines without pretending they run", () => {
    const m = enginesMessage(
      { bnb: false, sol: false },
      {
        bnbScan: stamp(null, null),
        solScan: stamp(null, null),
        bnbSniper: stamp(null, null),
        solSniper: stamp(null, null),
      },
      NOW,
    );
    expect(m.text).toContain("BNB scanner: 🔴 OFF · starting…");
    expect(m.text).toContain("SOL sniper: 🔴 OFF · starting…");
    // Both stop AND start affordances exist (per-chain switches).
    const flat = m.keyboard.flat().map((b) => b.text);
    expect(flat).toContain("▶️ Start BNB");
    expect(flat).toContain("▶️ Start SOL");
  });

  test("parseBotCommand maps /engines", () => {
    expect(parseBotCommand("/engines")).toEqual({ kind: "engines" });
    expect(parseBotCommand("/engines@TAEngine_bot")).toEqual({ kind: "engines" });
  });

  test("main menu wires per-chain START/STOP and the Engines board", () => {
    const m = mainMenu();
    const flat = m.keyboard.flat().map((b) => b.text);
    expect(flat).toContain("🚀 START BNB");
    expect(flat).toContain("⏹ STOP BNB");
    expect(flat).toContain("☀️ START SOL");
    expect(flat).toContain("⏹ STOP SOL");
    expect(flat).toContain("⚙️ Engines");
    const eng = m.keyboard.flat().find((b) => b.callback_data === "cmd:/engines");
    expect(eng).toBeDefined();
    const solStart = m.keyboard.flat().find((b) => b.callback_data === "cmd:/sol_on");
    expect(solStart).toBeDefined();
  });
});
