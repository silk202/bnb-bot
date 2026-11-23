/**
 * Client-side data retention — the app's own ten-minute sweep.
 *
 * The backend already sweeps its tables every 10 minutes (convex/retention.ts).
 * This is the same contract on the browser side: every ten minutes the app
 * removes local data that is already useless, and touches nothing else.
 *
 * KEPT — never selected by either sweep:
 *   • identity:   flashbolt.gate.grant, flashbolt.deviceTrustToken,
 *                 fb.solVault.v1 / fb.evmVault.v1 (session-only ciphertext)
 *   • money:      fb.sol-positions.v2, flashbolt:payout-exposure:v1,
 *                 flashbolt:circuit-breaker:v1
 *   • reports:    flashbolt.relay-probe-history.v1 (relay latency history) and
 *                 TODAY's `tracker_*` rows (the day's wins/losses counters)
 *   • settings:   RPC discovery, UTC offset, terminal flavor, chart range,
 *                 relay auto-refresh, overlay settings, download gate
 *   • anything this module does not recognise: a key it has never heard of may
 *     belong to another feature, so it is never removed on a guess.
 *
 * REMOVED — both are already unreachable before the sweep runs:
 *   • `tracker_<key>` rows whose `date` is not today's UTC day: loadDailyTracker
 *     resets a date-mismatched tracker on read, so those numbers are already
 *     gone to the UI — removing the row only stops it occupying storage.
 *   • `flashbolt.botDialogReopen` in sessionStorage: a one-shot "reopen the bot
 *     dialog after navigation" flag, consumed by the first mount.
 */

/** Same window as the backend sweeps and the bot's message TTL. */
export const LOCAL_RETENTION_INTERVAL_MS = 10 * 60 * 1000;

/** Daily execution counters (`tracker_bnb`, `tracker_sol-sniper`, …). */
export const DAY_TRACKER_PREFIX = "tracker_";

/** One-shot navigation scratch — consumed by the first mount, never reused. */
export const ONE_SHOT_SESSION_KEYS: readonly string[] = ["flashbolt.botDialogReopen"];

/** The slice of the Web Storage API both sweeps need (so tests can fake it). */
export interface RetentionStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export interface LocalRetentionReport {
  /** When the sweep ran (epoch ms). */
  at: number;
  /** Keys actually removed, in the order they were found. */
  removed: string[];
  /** Local keys still present afterwards (a readable size signal). */
  remaining: number;
}

/** The UTC day key the daily trackers are written with. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Remove day counters that belong to a previous UTC day.
 *
 * Only `tracker_*` rows with a readable, non-today `date` are selected: a
 * malformed row is left alone (never delete on a guess), and today's counters
 * are the day's report, so they stay until the calendar moves.
 */
export function sweepDayTrackers(storage: RetentionStorage, now: number): string[] {
  const today = utcDay(now);
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(DAY_TRACKER_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let date: unknown;
    try {
      date = (JSON.parse(raw) as { date?: unknown }).date;
    } catch {
      continue; // unreadable value — leave it to its owner
    }
    if (typeof date === "string" && date !== today) doomed.push(key);
  }
  // Remove after the scan: removing mid-iteration shifts every later index.
  for (const key of doomed) storage.removeItem(key);
  return doomed;
}

/** Remove consumed one-shot navigation scratch. */
export function sweepSessionScratch(
  storage: RetentionStorage,
  keys: readonly string[] = ONE_SHOT_SESSION_KEYS,
): string[] {
  const removed: string[] = [];
  for (const key of keys) {
    if (storage.getItem(key) === null) continue;
    storage.removeItem(key);
    removed.push(key);
  }
  return removed;
}

/**
 * One sweep against the real browser storage. Safe to call anywhere: outside a
 * browser (tests, SSR) it reports an empty sweep, and a blocked storage
 * (private mode, quota) is a no-op rather than an error.
 */
export function runLocalRetention(now: number = Date.now()): LocalRetentionReport {
  const report: LocalRetentionReport = { at: now, removed: [], remaining: 0 };
  if (typeof window === "undefined") return report;
  try {
    report.removed.push(...sweepDayTrackers(window.localStorage, now));
    report.removed.push(...sweepSessionScratch(window.sessionStorage));
    report.remaining = window.localStorage.length;
  } catch {
    // Storage unavailable — nothing to sweep, and nothing to report.
  }
  return report;
}

/**
 * Run one sweep now and again every ten minutes. Returns a stop function; the
 * sweep itself never throws, so it can never disrupt the app it runs inside.
 */
export function startLocalRetention(): () => void {
  if (typeof window === "undefined") return () => {};
  const run = (): void => {
    try {
      runLocalRetention();
    } catch {
      // Never let housekeeping surface as a runtime error.
    }
  };
  run();
  const id = window.setInterval(run, LOCAL_RETENTION_INTERVAL_MS);
  return () => window.clearInterval(id);
}
