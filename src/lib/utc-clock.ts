/**
 * Real-time UTC clock helpers.
 *
 * The world clock always renders the *real* device clock shifted into the
 * selected UTC offset — never a simulated value. These pure functions keep
 * the formatting testable without a browser.
 */

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/** Selectable UTC offsets: UTC-12 … UTC+14 (27 options, 0 = UTC). */
export const UTC_OFFSETS: number[] = Array.from({ length: 27 }, (_, i) => i - 12);

const pad = (n: number): string => String(n).padStart(2, "0");

export interface UtcClockParts {
  /** "00:00:00" — hour:minute:second in the selected offset. */
  time: string;
  /** "AUG:09:2026" — MMM:DD:YYYY in the selected offset. */
  date: string;
}

/**
 * Shift a real Date into a fixed UTC offset and split it into display parts.
 * Math is exact (ms + offset hours) so every offset is a true wall-clock time.
 */
export function utcShifted(now: Date, offsetHours: number): UtcClockParts {
  const shifted = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
  return {
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
    date: `${MONTHS[shifted.getUTCMonth()]}:${pad(shifted.getUTCDate())}:${shifted.getUTCFullYear()}`,
  };
}

/** "UTC", "UTC+1", "UTC-5", … — the label shown next to the dropdown arrow. */
export function offsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return "UTC";
  return offsetHours > 0 ? `UTC+${offsetHours}` : `UTC${offsetHours}`;
}

/** Persisted offset key (shared across every page). */
export const UTC_OFFSET_STORAGE_KEY = "flashbolt-utc-offset";

export function readStoredOffset(): number {
  if (typeof localStorage === "undefined") return 0;
  const stored = localStorage.getItem(UTC_OFFSET_STORAGE_KEY);
  const parsed = stored === null ? Number.NaN : Number(stored);
  return UTC_OFFSETS.includes(parsed) ? parsed : 0;
}
