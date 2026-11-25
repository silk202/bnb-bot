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
import { SCAN_COOLDOWN_MS, scanCooldown, scanCooldownMessage } from "../telegramBot";

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
