/**
 * The manual-scan cooldown: one budget per chat and chain, stated honestly.
 *
 * The dispatch gate claims the slot before any feed work, so these tests pin the
 * rule the claim mutation applies: a first scan passes, a second inside the
 * window is refused with the REAL remaining time, the boundary opens exactly at
 * the window, a clock that moved backwards fails closed, and a disabled window
 * never blocks. The reply must name both the wait and the window.
 */
import { describe, expect, test } from "bun:test";
import {
  SCAN_COOLDOWN_MS,
  cooldownStateLabel,
  enginesMessage,
  feedCooldownMessage,
  scanCooldown,
  scanCooldownMessage,
  type EngineStamp,
} from "../telegramBot";

describe("manual scan cooldown", () => {
  test("the window is thirty seconds", () => {
    expect(SCAN_COOLDOWN_MS).toBe(30_000);
  });

  test("a chat that never scanned is always allowed", () => {
    expect(scanCooldown(undefined, 1_000).allowed).toBe(true);
    expect(scanCooldown(null, 1_000).allowed).toBe(true);
    expect(scanCooldown(0, 1_000).allowed).toBe(true);
  });

  test("a scan inside the window is refused with the exact remainder", () => {
    const status = scanCooldown(1_000, 13_000);
    expect(status.allowed).toBe(false);
    expect(status.retryInMs).toBe(SCAN_COOLDOWN_MS - 12_000);
  });

  test("the boundary opens exactly at the window, not a millisecond early", () => {
    const lastAt = 5_000;
    expect(scanCooldown(lastAt, lastAt + SCAN_COOLDOWN_MS - 1).allowed).toBe(false);
    expect(scanCooldown(lastAt, lastAt + SCAN_COOLDOWN_MS).allowed).toBe(true);
  });

  test("a stamp in the future fails closed instead of opening the gate", () => {
    const status = scanCooldown(60_000, 1_000);
    expect(status.allowed).toBe(false);
    expect(status.retryInMs).toBe(SCAN_COOLDOWN_MS);
  });

  test("a disabled window never blocks", () => {
    expect(scanCooldown(1_000, 1_000, 0).allowed).toBe(true);
    expect(scanCooldown(1_000, 1_000, -5).allowed).toBe(true);
  });

  test("the reply names the real wait and the window, per chain", () => {
    const bnb = scanCooldownMessage("bnb", 12_000);
    expect(bnb).toContain("BNB scan is cooling down");
    expect(bnb).toContain("12s");
    expect(bnb).toContain("30s");

    // Rounded up: 17.4s of remaining budget is never reported as 17s.
    const sol = scanCooldownMessage("sol", 17_400);
    expect(sol).toContain("SOL scan is cooling down");
    expect(sol).toContain("try again in 18s");
    expect(sol).toContain("every 30s");
  });
});

describe("cooldown on the boards", () => {
  const NOW = 1_000_000;
  const stamp = (at: number | null, source: "client" | "server" | null): EngineStamp => ({
    at,
    source,
  });
  const stamps = {
    bnbScan: stamp(NOW - 30_000, "server"),
    solScan: stamp(NOW - 90_000, "client"),
    bnbSniper: stamp(null, null),
    solSniper: stamp(NOW - 3_600_000, "server"),
  };

  test("the engines board shows each scanner's manual-scan readiness", () => {
    const m = enginesMessage({ bnb: true, sol: true }, stamps, NOW, {
      bnb: { allowed: false, retryInMs: 18_400 },
      sol: { allowed: true, retryInMs: 0 },
    });
    expect(m.text).toContain(
      "BNB scanner: 🟢 ON · last pass 30s ago (engine) · manual scan in 19s",
    );
    expect(m.text).toContain(
      "SOL scanner: 🟢 ON · last pass 2m ago (app) · manual scan ready",
    );
    expect(m.text).toContain("share a 30s budget per chat");
    // Snipers are not manual-scan engines and carry no cooldown text.
    expect(m.text).toContain("SOL sniper: 🟢 ON · last pass 1h ago (engine)\n");
  });

  test("without a cooldown the board reads exactly as before", () => {
    const m = enginesMessage({ bnb: true, sol: true }, stamps, NOW);
    expect(m.text).not.toContain("manual scan");
    expect(m.text).not.toContain("budget per chat");
  });

  test("one label phrasing for every board", () => {
    expect(cooldownStateLabel({ allowed: true, retryInMs: 0 })).toBe("ready");
    expect(cooldownStateLabel({ allowed: false, retryInMs: 1 })).toBe("in 1s");
    expect(cooldownStateLabel({ allowed: false, retryInMs: 18_400 })).toBe("in 19s");
  });

  test("/routes refuses on the shared feed budget and says so", () => {
    const msg = feedCooldownMessage("bnb", 12_000);
    expect(msg).toContain("BNB live feed is cooling down");
    expect(msg).toContain("try again in 12s");
    expect(msg).toContain("shared with /bnb_scan");
  });
});
