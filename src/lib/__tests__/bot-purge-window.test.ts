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
  abandonedListLines,
  abandonedRowLine,
  BOT_MESSAGE_TTL_MS,
  CHANNEL_MESSAGE_TTL_MS,
  classifyPurgeFailure,
  purgeAbandonmentNotice,
  PURGE_ALERT_CAP,
  PURGE_ALERT_REPEAT_MS,
  PURGE_RETRY_CAP,
  purgeAlertPauseNote,
  purgeAlertPlan,
  purgeCutoff,
  purgeRetryExhausted,
  purgeFailureAlert,
  purgeFailureSummary,
  purgeSkipNote,
  purgeTelemetryLine,
  selectPurgeable,
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

  test("the retry backlog is visible, and a settled-only failure is not mislabelled", () => {
    expect(
      purgeTelemetryLine(
        { at: NOW - 60_000, deleted: 0, failed: 3, retrying: 2, skipped: null },
        NOW,
      ),
    ).toBe("1m ago · 0 deleted · 3 failed · 2 retrying");
    expect(
      purgeTelemetryLine(
        { at: NOW - 60_000, deleted: 0, failed: 3, retrying: 0, skipped: null },
        NOW,
      ),
    ).toBe("1m ago · 0 deleted · 3 failed");
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
    expect(purgeAlertPlan({ failed: 2 }).alert).toBe(false);
    expect(
      purgeAlertPlan({
        previous: { at: NOW - 600_000, deleted: 3, failed: 0, skipped: null },
        failed: 2,
      }).alert,
    ).toBe(false);
  });

  test("a second consecutive failing sweep alerts with the fault's start", () => {
    const previous = { at: NOW - 600_000, deleted: 1, failed: 2, skipped: null };
    expect(purgeAlertPlan({ previous, failed: 3, now: NOW })).toMatchObject({
      alert: true,
      kind: "first",
      number: 1,
      cap: PURGE_ALERT_CAP,
      since: previous.at,
    });
    expect(purgeAlertPlan({ previous, failed: 0, now: NOW }).alert).toBe(false);
    expect(
      purgeAlertPlan({
        previous: { at: NOW, deleted: 0, failed: 0, skipped: "auto-purge off" },
        failed: 3,
      }).alert,
    ).toBe(false);
  });

  test("a persisting fault re-alerts hourly, not every sweep", () => {
    const previous = { at: NOW - 600_000, deleted: 0, failed: 2, skipped: null };
    const repeat = (lastAlertedAt: number, alertsSent = 1) =>
      purgeAlertPlan({ previous, failed: 3, lastAlertedAt, alertsSent, now: NOW });
    expect(repeat(NOW - 60 * 60 * 1000)).toMatchObject({
      alert: true,
      kind: "repeat",
      number: 2,
    });
    expect(repeat(NOW - 10 * 60 * 1000).alert).toBe(false);
    expect(repeat(NOW - PURGE_ALERT_REPEAT_MS + 1).alert).toBe(false);
    // No stamp at all (first fault, or a clean sweep cleared it) alerts at once.
    expect(purgeAlertPlan({ previous, failed: 3, lastAlertedAt: null, now: NOW }).alert).toBe(true);
  });

  test("a fault is capped: the sixth alert is the last, then the sweep goes quiet", () => {
    const previous = { at: NOW - 600_000, deleted: 0, failed: 2, skipped: null };
    const last = purgeAlertPlan({
      previous,
      failed: 3,
      lastAlertedAt: NOW - 2 * 60 * 60 * 1000,
      alertsSent: PURGE_ALERT_CAP - 1,
      now: NOW,
    });
    expect(last).toMatchObject({ alert: true, kind: "repeat", number: PURGE_ALERT_CAP });
    expect(
      purgeAlertPlan({
        previous,
        failed: 3,
        lastAlertedAt: NOW - 2 * 60 * 60 * 1000,
        alertsSent: PURGE_ALERT_CAP,
        now: NOW,
      }),
    ).toMatchObject({ alert: false, kind: "capped", number: PURGE_ALERT_CAP });
    // A clean sweep clears the count, so a new fault gets its own six.
    expect(purgeAlertPlan({ previous, failed: 3, alertsSent: 0, now: NOW }).alert).toBe(true);
  });

  test("a round-31 row (stamp, no counter) counts as one alert already sent", () => {
    const previous = { at: NOW - 600_000, deleted: 0, failed: 2, skipped: null };
    expect(
      purgeAlertPlan({ previous, failed: 3, lastAlertedAt: NOW - 2 * 60 * 60 * 1000, now: NOW }),
    ).toMatchObject({ alert: true, kind: "repeat", number: 2 });
  });

  test("the latest tally shows how many refusals are retrying", () => {
    const current = { at: NOW - 60_000, deleted: 0, failed: 3, retrying: 2, skipped: null };
    const summary = purgeFailureSummary(undefined, current, NOW);
    expect(summary).toContain("0 deleted · 3 failed · 2 retrying");
    expect(summary).toContain("2 refused messages are still tracked");
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

describe("purge failure wording — a repeat never claims 'two sweeps in a row'", () => {
  const current = { at: NOW - 60_000, deleted: 0, failed: 3, retrying: 2, skipped: null };

  test("a first alert explains the trigger and the usual cause", () => {
    const first = purgeFailureSummary(undefined, current, NOW, {
      number: 1,
      cap: PURGE_ALERT_CAP,
      since: null,
    });
    expect(first).toContain("Two sweeps in a row");
    expect(first).toContain("Usual cause");
  });

  test("a repeat says which repeat it is and how long the fault has run", () => {
    const repeat = purgeFailureSummary(undefined, current, NOW, {
      number: 3,
      cap: PURGE_ALERT_CAP,
      since: NOW - 50 * 60 * 1000,
    });
    expect(repeat).not.toContain("Two sweeps in a row");
    expect(repeat).toContain("still failing");
    expect(repeat).toContain(`repeat alert 3 of ${PURGE_ALERT_CAP}`);
    expect(repeat).toContain("failing for 50m");
    expect(repeat).toContain("0 deleted · 3 failed · 2 retrying");
    expect(repeat).toContain("2 refused messages are still tracked");
    expect(repeat).not.toContain("Usual cause");
  });

  test("the capped alert says the repeats stop; the header follows the fault's age", () => {
    const last = purgeFailureSummary(undefined, current, NOW, {
      number: PURGE_ALERT_CAP,
      cap: PURGE_ALERT_CAP,
      since: NOW - 5 * 60 * 60 * 1000,
    });
    expect(last).toContain("last automatic alert");
    expect(last).toContain("failing for 5h");
    expect(
      purgeFailureAlert(undefined, current, NOW, { number: 1, cap: PURGE_ALERT_CAP, since: null }),
    ).toContain("**Message sweep is failing**");
    expect(
      purgeFailureAlert(undefined, current, NOW, {
        number: 2,
        cap: PURGE_ALERT_CAP,
        since: NOW - 70 * 60 * 1000,
      }),
    ).toContain("**Message sweep still failing**");
  });
});

describe("purge retry budget — a dead row stops costing calls", () => {
  test("a row retries until the cap, never past it", () => {
    expect(purgeRetryExhausted(undefined)).toBe(false);
    expect(purgeRetryExhausted(0)).toBe(false);
    expect(purgeRetryExhausted(PURGE_RETRY_CAP - 1)).toBe(false);
    expect(purgeRetryExhausted(PURGE_RETRY_CAP)).toBe(true);
    expect(purgeRetryExhausted(PURGE_RETRY_CAP + 10)).toBe(true);
  });

  test("the tally names abandoned rows instead of hiding them in `failed`", () => {
    const line = purgeTelemetryLine(
      { at: NOW - 60_000, deleted: 0, failed: 4, retrying: 1, abandoned: 3, skipped: null },
      NOW,
    );
    expect(line).toContain("4 failed");
    expect(line).toContain("1 retrying");
    expect(line).toContain("3 abandoned");
  });

  test("the fault body states the consequence of abandonment", () => {
    const current = {
      at: NOW - 60_000,
      deleted: 0,
      failed: 4,
      retrying: 1,
      abandoned: 3,
      skipped: null,
    };
    expect(purgeFailureSummary(undefined, current, NOW)).toContain(
      "3 messages are no longer retried automatically",
    );
    expect(purgeFailureSummary(undefined, current, NOW)).toContain(
      "/purge can still try them by hand",
    );
  });
});

describe("purgeAlertPauseNote — a capped fault is not a silent healthy one", () => {
  test("no note while alerts still flow", () => {
    expect(purgeAlertPauseNote(undefined)).toBe("");
    expect(purgeAlertPauseNote(0)).toBe("");
    expect(purgeAlertPauseNote(PURGE_ALERT_CAP - 1)).toBe("");
  });

  test("at the cap the line says alerting stopped, and how it resumes", () => {
    expect(purgeAlertPauseNote(PURGE_ALERT_CAP)).toContain(
      `alerts paused after ${PURGE_ALERT_CAP}`,
    );
    expect(purgeAlertPauseNote(PURGE_ALERT_CAP + 3)).toContain("a clean sweep resumes them");
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
    expect(classifyPurgeFailure("Too Many Requests: retry after 5")).toBe("transient");
    expect(classifyPurgeFailure("Internal Server Error")).toBe("transient");
    expect(classifyPurgeFailure("fetch failed")).toBe("transient");
  });

  test("an unreachable chat is hopeless, not retryable", () => {
    // No number of sweeps makes a deleted group answer, so these spend the
    // budget at once (the row is kept for /purge).
    expect(classifyPurgeFailure("Bad Request: chat not found")).toBe("hopeless");
    expect(classifyPurgeFailure("Bad Request: PEER_ID_INVALID")).toBe("hopeless");
    expect(classifyPurgeFailure("Bad Request: chat_id_invalid")).toBe("hopeless");
    // A kicked bot is different: re-adding it makes the deletes work again.
    expect(classifyPurgeFailure("Forbidden: bot was kicked from the group chat")).toBe(
      "transient",
    );
  });
});

describe("abandoned rows — a number becomes names", () => {
  const stuck = (over: Partial<Parameters<typeof abandonedRowLine>[0]> = {}) => ({
    chatId: "42",
    messageId: 7,
    source: "bot" as const,
    sentAt: NOW - 2 * 60 * 60 * 1000,
    attempts: PURGE_RETRY_CAP,
    abandonedReason: "exhausted" as const,
    ...over,
  });

  test("a spent budget is named with the chat, the message and the count", () => {
    const line = abandonedRowLine(stuck(), NOW);
    expect(line).toContain("chat `42`");
    expect(line).toContain("message 7");
    expect(line).toContain(`${PURGE_RETRY_CAP}/${PURGE_RETRY_CAP} attempts`);
    expect(line).toContain("2h ago");
  });

  test("a hopeless row says the chat is unreachable, not that attempts ran out", () => {
    const line = abandonedRowLine(
      stuck({ source: "channel", chatId: "-100123", attempts: 1, abandonedReason: "hopeless" }),
      NOW,
    );
    expect(line).toContain("channel `-100123`");
    expect(line).toContain("chat unreachable");
    expect(line).not.toContain("attempts");
  });

  test("a missing reason is stated, never invented", () => {
    const line = abandonedRowLine(stuck({ abandonedReason: null, attempts: 0 }), NOW);
    expect(line).toContain("no reason recorded");
  });

  test("the list is bounded and its truncation counts the standing total", () => {
    const rows = Array.from({ length: 5 }, (_, i) => stuck({ messageId: i + 1 }));
    const lines = abandonedListLines(rows, NOW, { limit: 3, total: 8 });
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("• …and 5 more");
    expect(abandonedListLines(rows, NOW, { limit: 10, total: 5 })).toHaveLength(5);
  });

  test("no abandoned rows is no section at all", () => {
    expect(abandonedListLines([], NOW)).toEqual([]);
  });
});

describe("purgeAbandonmentNotice — the gap the fault alert leaves", () => {
  test("it names the batch, lists the rows and says how to recover them", () => {
    const body = purgeAbandonmentNotice({
      total: 2,
      rows: [
        {
          chatId: "42",
          messageId: 7,
          source: "bot",
          sentAt: NOW - 60_000,
          attempts: PURGE_RETRY_CAP,
          abandonedReason: "exhausted",
        },
        {
          chatId: "-1009",
          messageId: 8,
          source: "channel",
          sentAt: NOW - 60_000,
          attempts: 1,
          abandonedReason: "hopeless",
        },
      ],
      now: NOW,
    });
    expect(body).toContain("2 tracked messages have just left the automatic retry");
    expect(body).toContain("message 7");
    expect(body).toContain("message 8");
    expect(body).toContain("/purge can still delete them by hand");
    expect(body).toContain("/alerts lists them until then");
  });

  test("one row is written in the singular", () => {
    const body = purgeAbandonmentNotice({
      total: 1,
      rows: [
        {
          chatId: "42",
          messageId: 7,
          source: "bot",
          sentAt: NOW - 60_000,
          attempts: PURGE_RETRY_CAP,
          abandonedReason: "exhausted",
        },
      ],
      now: NOW,
    });
    expect(body).toContain("1 tracked message has just left");
    expect(body).toContain("/purge can still delete it by hand");
    expect(body).not.toContain("…and");
  });

  test("a large batch is listed in full up to the limit and counted after it", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      chatId: "42",
      messageId: i + 1,
      source: "bot" as const,
      sentAt: NOW - 60_000,
      attempts: PURGE_RETRY_CAP,
      abandonedReason: "exhausted" as const,
    }));
    const body = purgeAbandonmentNotice({ total: 12, rows, now: NOW });
    expect(body).toContain("message 10");
    expect(body).toContain("• …and 2 more");
  });
});
