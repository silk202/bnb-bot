/**
 * Client-side poll gates for the continuous action pollers.
 *
 * The four hottest consumers of the Convex Free plan's 20 GB-h/month ACTION
 * compute allowance are all HTTP-fan-out actions (queries/mutations never
 * touch it — only actions do):
 *
 *   marketData.fetchAggregatedSnapshot   9+ parallel source fetches
 *   tokenDiscovery.discoverTokens        10+ API pipeline
 *   copier.pollChannels                  2 Telegram pulls (+ Bot API fallback)
 *   notifications.telegramTradeAlert     one short POST per REAL execution
 *                                       (event-driven, negligible — no gate)
 *
 * The Scanner/SOL feed ran the aggregator every 15 s (5,760 fan-outs/day
 * per open tab), discovery every 30 s and the copier every 30 s per panel —
 * enough, in a worst-case month of slow sources, to consume the whole
 * monthly allowance on their own. These gates coalesce every source within
 * a tab through ONE shared timestamp map (same proven pattern as
 * bump-throttle.ts) so a fan-out fires at most once per gap no matter how
 * many pages, panels or hooks ask — while every UI tick still updates its
 * own bookkeeping from the data it already has.
 *
 * Freshness trade-offs, stated honestly:
 *   • market feed: engine opportunity computation is SERVER-side and does
 *     not use this action — the gated consumer is the display feed only.
 *     60 s display staleness, worst case; the operator's manual rescan
 *     always bypasses the gate.
 *   • discovery: new-pool listings move on a minutes scale, so 120 s costs
 *     nothing real; manual refresh and filter changes bypass.
 *   • copier: the server cron (every 3 min) is the primary pumper of the
 *     feed and is never gated — client polls only add freshness while a
 *     panel is open. On a failed run (transport error, or every channel
 *     errored — a Telegram outage) the gate stretches to a 5-minute
 *     cooldown so a dead upstream cannot burn compute with 30 s retries.
 *
 * Module-level state is intentional: every consumer lives in the same
 * bundle, so all mounted panels/pages share one timestamp per key.
 */

import { claimBump, releaseBump } from "./bump-throttle";

/** Market snapshot fan-out — one real fetch per minute per chain per tab. */
export const MARKET_FEED_GAP_MS = 60_000;
/** Discovery pipeline — one real fetch per 2 minutes per tab. */
export const DISCOVERY_FEED_GAP_MS = 120_000;
/** Copier channel poll — one real poll per minute across all open panels. */
export const COPIER_POLL_GAP_MS = 60_000;
/** Shared gate key every copier consumer (panels + SOL sniper) claims. */
export const COPIER_POLL_KEY = "copier:poll";
/** After a failed copier poll, wait 5 minutes before trying again. */
export const COPIER_FAILURE_COOLDOWN_MS = 5 * 60_000;
/** After a failed discovery run, same 5-minute outage cooldown. */
export const DISCOVERY_FAILURE_COOLDOWN_MS = 5 * 60_000;

/** Claim a gated poll slot. True ⇒ caller should actually fire the action. */
export function claimPoll(key: string, gapMs: number): boolean {
  return claimBump(key, gapMs);
}

/** Give the slot back after a failed poll so the next tick can retry. */
export function releasePoll(key: string): void {
  releaseBump(key);
}

/**
 * Stretch the gate after a failed poll (exception, or every upstream
 * errored): release the current claim, then re-claim with the cooldown gap
 * so no consumer retries before it elapses. Idempotent.
 */
export function coolDownPoll(key: string, cooldownMs: number): void {
  releaseBump(key);
  claimBump(key, cooldownMs);
}

/**
 * True when a copier poll result represents a total upstream failure —
 * nothing fetched and every watched channel reported an error/HTTP failure.
 * The action itself succeeded (Convex billed the call), so only the RESULT
 * tells a Telegram outage apart from a quiet channel: a quiet channel
 * fetches messages (fetched > 0) with zero new signals, it does not error.
 */
export function copierPollTotalFailure(result: {
  fetched: number;
  notes: string[];
}): boolean {
  return result.fetched === 0 && result.notes.length > 0;
}
