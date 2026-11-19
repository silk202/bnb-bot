import { useEffect, useState } from "react";

/**
 * The terminal's shared wall clock for anything that displays an age.
 *
 * Each tick re-reads `Date.now()` instead of adding an interval to a stored
 * value, so a throttled or suspended timer (background tab, sleeping laptop)
 * lands on the true time on its first tick after waking rather than
 * accumulating drift. Returning to a hidden tab re-reads immediately instead
 * of waiting out the rest of an interval, so an age is never shown stale for a
 * whole cadence after the operator comes back.
 *
 * Arm ages change at minute granularity, hence the 30s default: a label is at
 * most half a minute behind, and only pages that already show second-level
 * activity pass their own cadence.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const read = () => setNow(Date.now());
    const timer = setInterval(read, Math.max(250, intervalMs));
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}
