/**
 * The two Telegram cron ticks, pinned to the schedule they must keep.
 *
 * Round 27 moved the digest onto the purge's 10-minute window; both still fired
 * on the same offsets, and Convex does not order crons that share one — so a
 * tick could delete a 10-minute-old digest seconds before its replacement
 * posted. The fix is a schedule property, not a race: the digest owns minute 0
 * of every ten, the purge minute 1. These tests read the real `crons.ts` (the
 * schedule lives there, not in a duplicated constant) and hold that apart.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BOT_MESSAGE_TTL_MS } from "../telegramBot";

const SOURCE = readFileSync(new URL("../../convex/crons.ts", import.meta.url), "utf8");

/** The minute field of a 5-field cron expression, expanded to minutes 0-59. */
function minuteField(spec: string): number[] {
  const field = spec.trim().split(/\s+/)[0];
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${spec}`);
    const [startRaw, endRaw] = range.split("-");
    const start = startRaw === "*" ? 0 : Number(startRaw);
    const end = range === "*" ? 59 : endRaw === undefined ? start : Number(endRaw);
    for (let m = start; m <= end; m += step) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

/** The cron expression registered for a job name in crons.ts. */
function cronSpec(name: string): string {
  const m = SOURCE.match(new RegExp(`crons\\.cron\\(\\s*"${name}",\\s*"([^"]+)"`));
  if (!m) throw new Error(`cron ${name} is not registered in crons.ts`);
  return m[1];
}

describe("Telegram cron tick ordering — replace, then delete", () => {
  test("the digest runs on minute 0 of every ten", () => {
    expect(minuteField(cronSpec("telegram-bot-digest"))).toEqual([0, 10, 20, 30, 40, 50]);
  });

  test("the purge runs one minute after the digest, never beside it", () => {
    const digest = new Set(minuteField(cronSpec("telegram-bot-digest")));
    const purge = minuteField(cronSpec("telegram-bot-purge"));
    expect(purge).toEqual([1, 11, 21, 31, 41, 51]);
    for (const m of purge) expect(digest.has(m)).toBe(false);
  });

  test("every purge has a fresh digest posted exactly one minute earlier", () => {
    const digest = new Set(minuteField(cronSpec("telegram-bot-digest")));
    for (const purgeMinute of minuteField(cronSpec("telegram-bot-purge"))) {
      expect(digest.has(purgeMinute - 1)).toBe(true);
    }
  });

  test("the digest the purge deletes is older than the TTL, the one it keeps is not", () => {
    // Purge at :01 deletes messages at or before :01 minus the TTL, i.e. posted
    // at :51 of the previous cycle (10 minutes before the sweep) or earlier —
    // while the digest posted at :00 is one minute old and stays.
    const freshAgeMinutes = 1;
    const deletedAgeMinutes = 10 + freshAgeMinutes;
    expect(freshAgeMinutes * 60_000).toBeLessThan(BOT_MESSAGE_TTL_MS);
    expect(deletedAgeMinutes * 60_000).toBeGreaterThan(BOT_MESSAGE_TTL_MS);
  });
});
