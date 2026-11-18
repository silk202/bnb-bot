/**
 * Client-side scan-bump throttle.
 *
 * Every bumpScan mutation is a WRITE to the shared terminal state: it
 * advances the freshness stamp, which invalidates every getTerminalState
 * subscription in the app (and re-delivers the state doc to each of them).
 * The stamp has the same value semantically for a whole window, so the
 * cadence timer (use-terminal), the Scanner page tick, and the SOL feed
 * hook must COALESCE through one shared gate instead of stacking writes.
 *
 * Module-level state is intentional: every bump source lives in the same
 * bundle, so they share one last-write timestamp per chain key.
 */

const lastBumpAt = new Map<string, number>();

/**
 * Minimum gap between client scan bumps per chain. The default scan cadence
 * is 15 s, so four ticks coalesce into one write — ~1,440 bumps per chain
 * per day per open tab instead of 5,760, and each write re-runs every
 * mounted getTerminalState subscription, so this gate is the single
 * largest client-side lever on the 30K/day function-call gauge. The
 * freshness stamp stays 5× inside the server's 300-second online window
 * (ENGINE_ONLINE_WINDOW_MS), so the single-driver rule is unaffected; the
 * SOL feed's openOpportunities stat simply refreshes once a minute.
 */
export const CLIENT_BUMP_GAP_MS = 60_000;

/**
 * Claim permission to send a bump for `key` at most once per `gapMs`.
 * Returns true when the caller should actually fire the mutation.
 */
export function claimBump(key: string, gapMs: number): boolean {
  const now = Date.now();
  if (now - (lastBumpAt.get(key) ?? 0) < gapMs) return false;
  lastBumpAt.set(key, now);
  return true;
}

/** Give the slot back after a failed bump so the next tick can retry. */
export function releaseBump(key: string): void {
  lastBumpAt.delete(key);
}
