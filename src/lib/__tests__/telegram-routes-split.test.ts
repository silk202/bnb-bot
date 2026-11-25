/**
 * `/routes` covers BNB and SOL separately.
 *
 * The board carries one section per chain, each with its OWN freshness and its
 * OWN budget, because the two engines are independent: a BNB refresh must not
 * make the SOL section look unavailable. The tests pin the three honest states
 * a section can be in — read now (rows or counts), refused (real remaining
 * seconds), and not read by this tap (real last read, stated as such) — plus
 * the `/routes@bnb` / `/routes@sol` focus that spends only one chain's slot.
 */
import { describe, expect, test } from "bun:test";
import {
  HANDLED_COMMAND_KINDS,
  cooldownStateLabel,
  parseBotCommand,
  resolveCallbackData,
  routesMessage,
  type ChainRoutesView,
} from "../telegramBot";

const NOW = 5_000_000;

const view = (over: Partial<ChainRoutesView> = {}): ChainRoutesView => ({
  live: [],
  generated: [],
  opportunities: null,
  at: null,
  source: null,
  cooldown: { allowed: true, retryInMs: 0 },
  note: null,
  ...over,
});

const ROUTE = {
  id: "r1",
  legs: ["WBNB", "USDT", "BUSD"],
  profitPct: 0.41,
  lender: "Balancer",
  liquidityUsd: 1_200_000,
};

describe("/routes renders both chains", () => {
  test("each chain gets its own heading, freshness and budget", () => {
    const m = routesMessage(
      {
        bnb: view({ live: [ROUTE], at: NOW - 4_000, source: "server", opportunities: 3 }),
        sol: view({
          liveCount: 2,
          generatedCount: 1,
          at: NOW - 120_000,
          source: "client",
          cooldown: { allowed: false, retryInMs: 18_400 },
        }),
      },
      NOW,
    );
    expect(m.text).toContain(
      "**⚡ BNB FlashBolt** — read 4s ago (engine) · routes " + cooldownStateLabel({ allowed: true, retryInMs: 0 }),
    );
    expect(m.text).toContain("**☀️ SOL FlashBolt** — read 2m ago (app) · routes in 19s");
    // BNB rows are the feed's real routes, live and generated kept apart.
    expect(m.text).toContain("⛓ WBNB → USDT → BUSD — +0.41% Balancer · $1.20M");
    // SOL reports counts, because that is what its engine returns.
    expect(m.text).toContain("• 2 live routes this pass");
    expect(m.text).toContain("• 1 generated route this pass");
    // Each section states its own open-opportunity count, never the other's.
    expect(m.text).toContain("• Open opportunities 3");
  });

  test("net profit wins over gross on a generated route", () => {
    const m = routesMessage(
      {
        bnb: view({
          generated: [{ ...ROUTE, profitPct: 0.9, netProfitPct: 0.12 }],
          at: NOW,
        }),
        sol: view(),
      },
      NOW,
    );
    expect(m.text).toContain("🧮 WBNB → USDT → BUSD — +0.12% Balancer");
  });

  test("an empty read says so instead of showing a blank section", () => {
    const m = routesMessage({ bnb: view({ at: NOW }), sol: view() }, NOW);
    expect(m.text).toContain("• No live routes above the floor right now.");
    expect(m.text).toContain("• No generated routes this pass.");
    expect(m.text).toContain("**☀️ SOL FlashBolt** — not read yet · routes ready");
  });

  test("a refused chain shows its own wait, and the other chain still runs", () => {
    const m = routesMessage(
      {
        bnb: view({ at: NOW - 20_000, opportunities: 4 }),
        sol: view({
          liveCount: 1,
          at: NOW - 2_000,
          source: "server",
          cooldown: { allowed: false, retryInMs: 12_500 },
          note: "cooling down — its routes refresh is back in 13s.",
        }),
      },
      NOW,
    );
    expect(m.text).toContain("routes in 13s");
    expect(m.text).toContain("cooling down — its routes refresh is back in 13s.");
    // The BNB section is untouched by the SOL refusal.
    expect(m.text).toContain("read 20s ago");
  });

  test("a chain this tap skipped says it was not read", () => {
    const m = routesMessage(
      {
        bnb: view({ at: NOW }),
        sol: view({ at: NOW - 300_000, note: "not read by this tap — use its refresh button." }),
      },
      NOW,
    );
    expect(m.text).toContain("not read by this tap — use its refresh button.");
    expect(m.text).toContain("read 5m ago");
  });

  test("every button on the board is a live control", () => {
    const m = routesMessage({ bnb: view(), sol: view() }, NOW);
    const labels = m.keyboard.flat().map((b) => b.text);
    expect(labels).toContain("🔄 BNB routes");
    expect(labels).toContain("🔄 SOL routes");
    for (const button of m.keyboard.flat()) {
      const resolved = resolveCallbackData(button.callback_data ?? null);
      expect(HANDLED_COMMAND_KINDS).toContain(resolved.cmd.kind);
    }
  });
});

describe("/routes focuses one chain on request", () => {
  test("no suffix covers both chains", () => {
    expect(parseBotCommand("/routes")).toEqual({ kind: "routes", chain: "all" });
  });

  test("@bnb and @sol spend one chain's slot only", () => {
    expect(parseBotCommand("/routes@bnb")).toEqual({ kind: "routes", chain: "bnb" });
    expect(parseBotCommand("/routes@sol")).toEqual({ kind: "routes", chain: "sol" });
    // Case and spacing never change which chain is meant.
    expect(parseBotCommand("/ROUTES@SOL")).toEqual({ kind: "routes", chain: "sol" });
    expect(parseBotCommand("/routes @bnb")).toEqual({ kind: "routes", chain: "bnb" });
  });

  test("an unknown suffix stays the full board instead of erroring", () => {
    expect(parseBotCommand("/routes@junk")).toEqual({ kind: "routes", chain: "all" });
    expect(parseBotCommand("/routes@")).toEqual({ kind: "routes", chain: "all" });
  });
});
