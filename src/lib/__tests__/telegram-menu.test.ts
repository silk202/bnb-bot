/**
 * The bot's menu contract: a click ALWAYS answers.
 *
 * Every inline button the presentation layer can emit is resolved here with the
 * same `resolveCallbackData` the webhook uses, and every /command named in the
 * help board is parsed here too. If a builder gains a button whose kind is not
 * in `HANDLED_COMMAND_KINDS`, or the help board advertises a command the parser
 * does not know, this file fails — instead of an operator tapping a control
 * that replies with the generic board.
 */
import { describe, expect, test } from "bun:test";
import {
  alertsMessage,
  amountMessage,
  balanceMessage,
  BOT_MESSAGE_TTL_MS,
  bnbMessage,
  bootMessage,
  dashboardMessage,
  deployMessage,
  earnMessage,
  enginesMessage,
  executionsMessage,
  HANDLED_COMMAND_KINDS,
  helpMessage,
  mainMenu,
  marketsMessage,
  ordersMessage,
  pairPrompt,
  pairedMessage,
  parseBotCommand,
  pnlMessage,
  pricesMessage,
  resolveCallbackData,
  routesMessage,
  settingsMessage,
  solMessage,
  startMessage,
  stoppedMessage,
  tradeMessage,
  txsMessage,
  unlinkedMessage,
  withdrawMessage,
  type EngineStamp,
  type PnlLite,
  type TerminalStateLite,
  type TgKeyboard,
} from "../telegramBot";

const NOW = new Date("2026-11-23T12:00:00Z").getTime();
const STAMP: EngineStamp = { at: NOW - 30_000, source: "server" };

const TERMINAL: TerminalStateLite = {
  botRunning: true,
  solBotRunning: true,
  mode: "paper",
  contractDeployed: false,
  liveReady: false,
  balance: 1,
  lifetimePnl: 0,
  executionsToday: 0,
  successesToday: 0,
  successRate: 0,
  scansToday: 0,
  openOpportunities: 0,
  minProfit: 1,
  maxLoan: 1,
  maxHops: 3,
  slippage: 1,
  gasPriority: "medium",
  autoPayout: false,
  mevGuard: true,
  privateSubmit: false,
  lenderBalancer: false,
  cadence: 60,
  network: "mainnet",
  chainKey: "bsc",
  dailyArbTarget: 0,
  connectedWallets: [],
  solNetwork: "devnet",
};

const PNL: PnlLite = {
  liveCount: 0,
  wins: 0,
  grossProfit: 0,
  gasBurned: 0,
  netPnl: 0,
  live24h: 0,
  wins24h: 0,
  net24h: 0,
  solLiveCount: 0,
  solWins: 0,
  solGrossProfit: 0,
  solGasBurned: 0,
  solNetPnl: 0,
  solLive24h: 0,
  solWins24h: 0,
  solNet24h: 0,
  simCount: 0,
  simWins: 0,
  simGross: 0,
  simCredited: 0,
  simNet: 0,
};

const SESSION = {
  primary: { label: "London", flag: "🇬🇧", windowLabel: "07:00–16:00 UTC" },
  regime: "London solo session",
  openKeys: ["london"],
  nextChangeLabel: "London",
  nextChangeKind: "close" as const,
  nextChangeAt: NOW + 3_600_000,
  now: NOW,
};

const SCORE = {
  score: 50,
  rating: "Warm",
  dispersion: 1,
  routeCount: 2,
  avgEdge: 0.5,
  totalLiq: 1_000_000,
  totalVol: 1_000_000,
  gasGwei: 3,
};

const METRICS = {
  activeTerminals: 1,
  runningBots: 1,
  executionsToday: 0,
  successesToday: 0,
  winRate: 0,
  pnlToday: 0,
  lifetimePnl: 0,
  openOpportunities: 0,
  scansToday: 0,
  liveCount: 0,
  networks: { mainnet: 1, testnet: 0 },
  chains: ["bsc"],
};

/** Every keyboard the webhook can put in front of the operator. */
function keyboards(): Array<{ label: string; keyboard: TgKeyboard }> {
  const cfg = { alertFanout: true, digestEnabled: true, soundAlerts: true, autoPurge: true };
  return [
    { label: "start", keyboard: startMessage().keyboard },
    { label: "help", keyboard: helpMessage().keyboard },
    { label: "unlinked", keyboard: unlinkedMessage().keyboard },
    { label: "pairPrompt", keyboard: pairPrompt().keyboard },
    { label: "paired", keyboard: pairedMessage("Operator").keyboard },
    { label: "boot", keyboard: bootMessage("paper", "bsc").keyboard },
    { label: "mainMenu", keyboard: mainMenu().keyboard },
    { label: "dashboard", keyboard: dashboardMessage(SESSION, SCORE, METRICS).keyboard },
    { label: "bnb", keyboard: bnbMessage(TERMINAL).keyboard },
    { label: "sol", keyboard: solMessage(TERMINAL).keyboard },
    {
      label: "engines",
      keyboard: enginesMessage(
        { bnb: true, sol: false },
        { bnbScan: STAMP, solScan: STAMP, bnbSniper: STAMP, solSniper: STAMP },
        NOW,
      ).keyboard,
    },
    { label: "routes", keyboard: routesMessage([], []).keyboard },
    { label: "execs:all", keyboard: executionsMessage([], NOW, "all").keyboard },
    { label: "execs:live", keyboard: executionsMessage([], NOW, "live").keyboard },
    { label: "execs:sim", keyboard: executionsMessage([], NOW, "sim").keyboard },
    { label: "pnl:all", keyboard: pnlMessage(PNL, "all").keyboard },
    { label: "pnl:live", keyboard: pnlMessage(PNL, "live").keyboard },
    { label: "pnl:sim", keyboard: pnlMessage(PNL, "sim").keyboard },
    {
      label: "trade",
      keyboard: tradeMessage([], { activePlans: 0, activeAccrued: 0, interestEarned: 0 }, null).keyboard,
    },
    { label: "prices", keyboard: pricesMessage(null).keyboard },
    { label: "markets", keyboard: marketsMessage(null).keyboard },
    { label: "orders", keyboard: ordersMessage([]).keyboard },
    { label: "earn", keyboard: earnMessage([], NOW).keyboard },
    { label: "txs", keyboard: txsMessage([], NOW).keyboard },
    { label: "alerts", keyboard: alertsMessage(cfg, { silent: false }).keyboard },
    {
      label: "deploy",
      keyboard: deployMessage({
        mode: "paper",
        network: "mainnet",
        chainKey: "bsc",
        contract: null,
        router: null,
        deployments: [],
        connectedWallets: 0,
        importedWallets: 0,
      }).keyboard,
    },
    {
      label: "settings",
      keyboard: settingsMessage({
        botRunning: true,
        solBotRunning: true,
        mode: "paper",
        network: "mainnet",
        chainKey: "bsc",
        cadence: 60,
        minProfit: 1,
        maxLoan: 1,
        maxHops: 3,
        slippage: 1,
        gasPriority: "medium",
        autoPayout: false,
        mevGuard: true,
        privateSubmit: false,
        lenderBalancer: false,
        dailyArbTarget: 0,
        dexWhitelist: [],
        loanAssets: [],
        sol: {
          network: "devnet",
          buy: 0.1,
          sellPct: 100,
          slippagePct: 1,
          targetPct: 5,
          trailingPct: 2,
          minLiq: 1000,
          rpcOverrides: 0,
          wallets: 0,
        },
      }).keyboard,
    },
    {
      label: "amount",
      keyboard: amountMessage({
        mode: "paper",
        maxLoan: 1,
        minProfit: 1,
        dailyArbTarget: 0,
        executionsToday: 0,
        solBuy: 0.1,
        solSellPct: 100,
        solTargetPct: 5,
        solTrailingPct: 2,
      }).keyboard,
    },
    { label: "balance", keyboard: balanceMessage([], null).keyboard },
    { label: "withdraw", keyboard: withdrawMessage([], [], NOW).keyboard },
    { label: "stopped", keyboard: stoppedMessage("stop", "paper").keyboard },
    { label: "panic", keyboard: stoppedMessage("panic", "live").keyboard },
  ];
}

const KNOWN_SETTINGS = new Set([
  "alerts_on",
  "alerts_off",
  "digest_on",
  "digest_off",
  "sound_on",
  "sound_off",
  "mute",
  "unmute",
  "purge_on",
  "purge_off",
  "channel_on",
  "channel_off",
]);

describe("every inline button answers", () => {
  const all = keyboards();

  test("no keyboard is empty, every button has text and callback data", () => {
    for (const { keyboard } of all) {
      expect(keyboard.length).toBeGreaterThan(0);
      for (const row of keyboard) {
        expect(row.length).toBeGreaterThan(0);
        for (const button of row) {
          expect(button.text.length).toBeGreaterThan(0);
          expect(typeof button.callback_data).toBe("string");
          // Telegram caps callback_data at 64 bytes.
          expect(Buffer.byteLength(button.callback_data ?? "")).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  test("every callback resolves to a command the dispatcher handles", () => {
    for (const { label, keyboard } of all) {
      for (const button of keyboard.flat()) {
        const data = button.callback_data ?? "";
        const resolved = resolveCallbackData(data);
        expect({ label, data, kind: resolved.cmd.kind }).toEqual({
          label,
          data,
          kind: expect.stringMatching(
            new RegExp(`^(${HANDLED_COMMAND_KINDS.join("|")})$`),
          ),
        });
        if (data.startsWith("set:")) {
          expect(KNOWN_SETTINGS.has(resolved.setting ?? "")).toBe(true);
          // A toggle is still the alerts board, so the reply is always real.
          expect(resolved.cmd.kind).toBe("alerts");
        } else {
          expect(resolved.setting).toBeNull();
        }
      }
    }
  });

  test("an unknown payload still answers (never a dead click)", () => {
    const resolved = resolveCallbackData("something:else");
    expect(resolved.cmd.kind).toBe("unknown");
    expect(HANDLED_COMMAND_KINDS).toContain("unknown");
  });
});

describe("the help board only advertises commands that work", () => {
  test("every /command named in /help parses to a handled kind", () => {
    const text = helpMessage().text;
    // Only a token that starts a line or follows whitespace/· is a command;
    // prose like "paper/live" or "(sniper/flasher)" is not.
    const advertised = Array.from(
      new Set((text.match(/(?:^|[\s·])(\/[a-z_]+)/gm) ?? []).map((m) => m.trim().replace(/^·\s*/, ""))),
    );
    expect(advertised.length).toBeGreaterThan(20);
    for (const command of advertised) {
      const parsed = parseBotCommand(command);
      expect({ command, kind: parsed.kind }).toEqual({
        command,
        kind: expect.stringMatching(
          new RegExp(`^(${HANDLED_COMMAND_KINDS.join("|")})$`),
        ),
      });
      expect(parsed.kind).not.toBe("unknown");
    }
  });

  test("/purge is a real command and is documented", () => {
    expect(parseBotCommand("/purge")).toEqual({ kind: "purge" });
    expect(helpMessage().text).toContain("/purge");
  });
});

describe("alerts board — auto-purge is visible and toggleable", () => {
  test("ON says messages older than ten minutes are deleted and offers OFF", () => {
    const board = alertsMessage(
      { alertFanout: true, digestEnabled: true, soundAlerts: true, autoPurge: true },
      { silent: false },
    );
    expect(board.text).toContain("older than 10 min are deleted");
    const flat = board.keyboard.flat();
    expect(flat.find((b) => b.callback_data === "set:purge_off")).toBeDefined();
    expect(flat.find((b) => b.callback_data === "cmd:/purge")?.text).toContain("Purge");
  });

  test("OFF says messages stay and offers ON", () => {
    const board = alertsMessage(
      { alertFanout: true, digestEnabled: true, soundAlerts: true, autoPurge: false },
      { silent: true },
    );
    expect(board.text).toContain("every message stays");
    expect(board.keyboard.flat().find((b) => b.callback_data === "set:purge_on")).toBeDefined();
  });

  test("the purge window is exactly ten minutes", () => {
    expect(BOT_MESSAGE_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("channel purge has its own scope and switch", () => {
    const on = alertsMessage(
      { alertFanout: true, digestEnabled: true, soundAlerts: true, autoPurge: true },
      { silent: false },
    );
    // Omitted means ON, the same `!== false` default the table uses.
    expect(on.text).toContain("channel posts older than 10 min are deleted");
    expect(on.keyboard.flat().find((b) => b.callback_data === "set:channel_off")).toBeDefined();

    const off = alertsMessage(
      {
        alertFanout: true,
        digestEnabled: true,
        soundAlerts: true,
        autoPurge: true,
        channelPurge: false,
      },
      { silent: false },
    );
    expect(off.text).toContain("channel posts stay");
    // The chat sweep is untouched by the channel switch.
    expect(off.text).toContain("bot messages older than 10 min are deleted");
    expect(off.keyboard.flat().find((b) => b.callback_data === "set:channel_on")).toBeDefined();
  });
});
