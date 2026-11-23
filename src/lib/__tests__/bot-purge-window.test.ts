/**
 * The bot purge window and its scope, pinned without a Convex runtime.
 *
 * `purgeBotMessages` (the every-10-minute cron), `/purge` and the app panel all decide
 * "which tracked message may I delete?" here, in `selectPurgeable`. These tests
 * hold the three properties that decision depends on:
 *
 *   1. the window is exactly `BOT_MESSAGE_TTL_MS`, measured against the sweep's
 *      own clock — nothing a millisecond younger is ever deleted;
 *   2. a chat purge only ever sees that chat's rows, and `/purge` only sees bot
 *      posts (the channel is a record, not a board to clear);
 *   3. an unreadable timestamp is never guessed at, and a row that has outlived
 *      Telegram's 48 h delete limit is still selected — the sweep must be able
 *      to take it out of the table even when the API refuses the delete.
 */
import { describe, expect, test } from "bun:test";
import {
  BOT_MESSAGE_TTL_MS,
  CHANNEL_MESSAGE_TTL_MS,
  classifyPurgeFailure,
  purgeCutoff,
  purgeFailureAlert,
  purgeFailureSummary,
  purgeSkipNote,
  purgeTelemetryLine,
  selectPurgeable,
  shouldAlertPurgeFailures,
  type TrackedMessageLite,
} from "../telegramBot";

const NOW = new Date("2026-11-23T12:00:00Z").getTime();
const OLD = NOW - BOT_MESSAGE_TTL_MS;

function msg(over: Partial<TrackedMessageLite> = {}): TrackedMessageLite {
  return { chatId: "42", messageId: 1, source: "bot", sentAt: OLD, ...over };
}

describe("purgeCutoff — the ten-minute window", () => {
  test("a sweep at now deletes rows at or before now minus ten minutes", () => {
    expect(purgeCutoff(NOW)).toBe(NOW - 10 * 60 * 1000);
  });

  test("the cutoff moves with the clock, so a sweep cannot age into a stale window", () => {
    expect(purgeCutoff(NOW) - purgeCutoff(NOW - 60_000)).toBe(60_000);
  });

  test("a custom TTL moves the cutoff, never the rule", () => {
    expect(purgeCutoff(NOW, 60_000)).toBe(NOW - 60_000);
    expect(selectPurgeable([msg({ sentAt: NOW - 60_000 })], { cutoff: purgeCutoff(NOW, 60_000) }))
      .toHaveLength(1);
  });
});

describe("selectPurgeable — what one sweep may delete", () => {
  test("exactly ten minutes old is due; one millisecond younger is not", () => {
    expect(selectPurgeable([msg()], { cutoff: OLD })).toHaveLength(1);
    expect(selectPurgeable([msg({ sentAt: OLD + 1 })], { cutoff: OLD })).toHaveLength(0);
  });

  test("a message posted now survives the sweep", () => {
    expect(selectPurgeable([msg({ sentAt: NOW })], { cutoff: OLD })).toHaveLength(0);
  });

  test("future timestamps from clock skew are never purged", () => {
    expect(selectPurgeable([msg({ sentAt: NOW + 5_000 })], { cutoff: OLD })).toHaveLength(0);
  });

  test("a non-finite timestamp is never deleted on a guess", () => {
    const rows = [msg({ sentAt: Number.NaN }), msg({ sentAt: Number.POSITIVE_INFINITY })];
    expect(selectPurgeable(rows, { cutoff: OLD })).toHaveLength(0);
  });

  test("a chat-scoped sweep takes that chat's rows and leaves the others", () => {
    const rows = [
      msg({ chatId: "42", messageId: 1 }),
      msg({ chatId: "42", messageId: 2 }),
      msg({ chatId: "99", messageId: 3 }),
    ];
    expect(selectPurgeable(rows, { cutoff: OLD, chatId: "42" }).map((r) => r.messageId)).toEqual([
      1, 2,
    ]);
  });

  test("surface scope: the channel sweep never touches a bot board", () => {
    const rows = [
      msg({ source: "bot", messageId: 1 }),
      msg({ source: "channel", chatId: "-100123", messageId: 2 }),
    ];
    expect(selectPurgeable(rows, { cutoff: OLD, source: "channel" }).map((r) => r.messageId)).toEqual([
      2,
    ]);
    expect(selectPurgeable(rows, { cutoff: OLD, source: "bot" }).map((r) => r.messageId)).toEqual([1]);
  });

  test("/purge's scope (one chat, bot posts) never returns a channel post", () => {
    // Even if the operator's chat id and the channel id were the same string,
    // the source scope keeps a chat purge from erasing channel history.
    const rows = [
      msg({ chatId: "42", source: "bot", messageId: 1 }),
      msg({ chatId: "42", source: "channel", messageId: 2 }),
    ];
    expect(
      selectPurgeable(rows, { cutoff: NOW, chatId: "42", source: "bot" }).map((r) => r.messageId),
    ).toEqual([1]);
  });

  test("a three-day-old row is still selected, so a refused delete cannot pin it forever", () => {
    // Telegram refuses deleteMessage after 48 h; the sweep still has to be able
    // to take the row out of the table, or a long auto-purge outage leaves rows
    // that every future sweep re-counts as failures.
    const ancient = NOW - 3 * 24 * 60 * 60 * 1000;
    expect(selectPurgeable([msg({ sentAt: ancient })], { cutoff: OLD })).toHaveLength(1);
  });
});

describe("purgeTelemetryLine — the sweep reports honestly", () => {
  test("no report yet is never rendered as a healthy zero", () => {
    expect(purgeTelemetryLine(undefined, NOW)).toContain("not reported yet");
    expect(purgeTelemetryLine(null, NOW)).toContain("not reported yet");
    expect(
      purgeTelemetryLine({ at: Number.NaN, deleted: 3, failed: 0, skipped: null }, NOW),
    ).toContain("not reported yet");
    expect(purgeTelemetryLine(undefined, NOW)).not.toContain("0 deleted");
  });

  test("a real sweep says when it ran, what it deleted and what failed", () => {
    expect(
      purgeTelemetryLine({ at: NOW - 120_000, deleted: 3, failed: 1, skipped: null }, NOW),
    ).toBe("2m ago · 3 deleted · 1 failed");
  });

  test("a clean sweep omits the failed segment instead of printing zero", () => {
    expect(
      purgeTelemetryLine({ at: NOW - 60_000, deleted: 0, failed: 0, skipped: null }, NOW),
    ).toBe("1m ago · 0 deleted");
  });

  test("a sweep that stood down says why", () => {
    expect(
      purgeTelemetryLine({ at: NOW - 60_000, deleted: 0, failed: 0, skipped: "auto-purge off" }, NOW),
    ).toBe("1m ago — skipped (auto-purge off)");
  });

  test("a stand-down note never hides a real tally", () => {
    // Round 28 stamped the channel scope being off as a skipped sweep, so an
    // operator with the channel off saw "skipped" and lost the chat sweep's
    // counts. Counts now stay in front; the note is only appended.
    expect(
      purgeTelemetryLine({ at: NOW - 60_000, deleted: 4, failed: 0, skipped: "channel purge off" }, NOW),
    ).toBe("1m ago · 4 deleted · channel purge off");
  });
});

describe("CHANNEL_MESSAGE_TTL_MS — the channel window covers one board cycle", () => {
  test("channel posts outlive chat posts", () => {
    expect(CHANNEL_MESSAGE_TTL_MS).toBeGreaterThan(BOT_MESSAGE_TTL_MS);
  });

  test("a 12-minute-old channel post outlives the 10-minute chat window", () => {
    const rows = [
      msg({ chatId: "-100123", source: "channel", sentAt: NOW - 12 * 60_000 }),
    ];
    // The chat window would already delete it; the channel window keeps it,
    // which is what stops the 15-minute session board blanking the channel.
    expect(selectPurgeable(rows, { cutoff: purgeCutoff(NOW) })).toHaveLength(1);
    expect(
      selectPurgeable(rows, { cutoff: purgeCutoff(NOW, CHANNEL_MESSAGE_TTL_MS) }),
    ).toHaveLength(0);
  });

  test("a channel post past the channel window is due", () => {
    const rows = [
      msg({ chatId: "-100123", source: "channel", sentAt: NOW - CHANNEL_MESSAGE_TTL_MS }),
    ];
    expect(
      selectPurgeable(rows, { cutoff: purgeCutoff(NOW, CHANNEL_MESSAGE_TTL_MS) }),
    ).toHaveLength(1);
  });
});

describe("purgeSkipNote — a scope being off is not a skipped sweep", () => {
  test("only a full stand-down is a skip", () => {
    expect(purgeSkipNote({ autoPurge: false, tokenConfigured: true })).toBe("auto-purge off");
    expect(purgeSkipNote({ autoPurge: true, tokenConfigured: false })).toBe(
      "bot token not configured",
    );
    expect(purgeSkipNote({ autoPurge: true, tokenConfigured: true })).toBeNull();
  });

  test("the channel switch being off leaves a real chat sweep behind", () => {
    // The reason this function accepts `channelPurge` at all: it must ignore it.
    expect(
      purgeSkipNote({ autoPurge: true, tokenConfigured: true, channelPurge: false }),
    ).toBeNull();
  });
});

describe("purge failure alert — two sweeps in a row, real numbers", () => {
  test("one failing sweep is not yet an alert", () => {
    expect(shouldAlertPurgeFailures(undefined, 2)).toBe(false);
    expect(
      shouldAlertPurgeFailures({ at: NOW - 600_000, deleted: 3, failed: 0, skipped: null }, 2),
    ).toBe(false);
  });

  test("a second consecutive failing sweep alerts, a clean one clears it", () => {
    const previous = { at: NOW - 600_000, deleted: 1, failed: 2, skipped: null };
    expect(shouldAlertPurgeFailures(previous, 3)).toBe(true);
    expect(shouldAlertPurgeFailures(previous, 0)).toBe(false);
    expect(shouldAlertPurgeFailures({ at: NOW, deleted: 0, failed: 0, skipped: "auto-purge off" }, 3)).toBe(
      false,
    );
  });

  test("the alert carries both tallies and the honest consequence", () => {
    const previous = { at: NOW - 600_000, deleted: 1, failed: 2, skipped: null };
    const current = { at: NOW - 60_000, deleted: 0, failed: 3, skipped: null };
    const text = purgeFailureAlert(previous, current, NOW);
    expect(text).toContain("Previous: 10m ago · 1 deleted · 2 failed");
    expect(text).toContain("Latest: 1m ago · 0 deleted · 3 failed");
    expect(text).toContain("stay tracked");
    expect(purgeFailureAlert(undefined, current, NOW)).not.toContain("Previous:");
  });

  test("the bell entry and the Telegram alert share one plain-text body", () => {
    const previous = { at: NOW - 600_000, deleted: 1, failed: 2, skipped: null };
    const current = { at: NOW - 60_000, deleted: 0, failed: 3, skipped: null };
    const summary = purgeFailureSummary(previous, current, NOW);
    expect(summary).not.toContain("**");
    expect(summary).toContain("Previous: 10m ago · 1 deleted · 2 failed");
    expect(purgeFailureAlert(previous, current, NOW)).toContain(summary);
  });
});

describe("classifyPurgeFailure — retry only what can heal", () => {
  test("a message that is gone or too old can never be deleted again", () => {
    expect(classifyPurgeFailure("Bad Request: message to delete not found")).toBe("permanent");
    expect(classifyPurgeFailure("Bad Request: message can't be deleted for everyone")).toBe(
      "permanent",
    );
    expect(classifyPurgeFailure("Bad Request: message cannot be deleted")).toBe("permanent");
    expect(classifyPurgeFailure("Bad Request: message is too old to be deleted")).toBe(
      "permanent",
    );
    expect(classifyPurgeFailure("Bad Request: MESSAGE_ID_INVALID")).toBe("permanent");
  });

  test("rights, removal, rate limits and outages stay retryable", () => {
    expect(classifyPurgeFailure("Forbidden: bot was kicked from the group chat")).toBe(
      "transient",
    );
    expect(classifyPurgeFailure("Forbidden: not enough rights to delete this message")).toBe(
      "transient",
    );
    expect(classifyPurgeFailure("Bad Request: chat not found")).toBe("transient");
    expect(classifyPurgeFailure("Too Many Requests: retry after 5")).toBe("transient");
    expect(classifyPurgeFailure("Internal Server Error")).toBe("transient");
    expect(classifyPurgeFailure("fetch failed")).toBe("transient");
  });
});
