/**
 * Local persistence for the two pieces of guard state that must survive a
 * reload: how much a wallet has paid out today (transaction limits) and whether
 * the circuit breaker is open.
 *
 * Kept deliberately small and browser-only — the authoritative audit trail is
 * the server-side log; this is the state the client needs to refuse the next
 * movement before it signs anything.
 */
import type { BreakerState } from "./wallet-guard";

const EXPOSURE_KEY = "flashbolt:payout-exposure:v1";
const BREAKER_KEY = "flashbolt:circuit-breaker:v1";

export interface ExposureRecord {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  wallet: string;
  spent: number;
  /** First balance seen today — the out-flow baseline. */
  baseline?: number;
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Pure: total already paid out to `wallet` on `now`'s UTC day. */
export function exposureFor(
  records: readonly ExposureRecord[],
  wallet: string,
  now: number,
): number {
  const day = utcDay(now);
  const target = wallet.trim().toLowerCase();
  return records
    .filter((r) => r.day === day && r.wallet === target)
    .reduce((sum, r) => sum + r.spent, 0);
}

/** Pure: append a movement and drop every other day (nothing else is needed). */
export function recordExposure(
  records: readonly ExposureRecord[],
  wallet: string,
  amountNative: number,
  now: number,
): ExposureRecord[] {
  const day = utcDay(now);
  const target = wallet.trim().toLowerCase();
  const kept = records.filter((r) => r.day === day && r.wallet !== target);
  const prior = exposureFor(records, target, now);
  const baseline = records.find((r) => r.day === day && r.wallet === target)?.baseline;
  return [
    ...kept,
    {
      day,
      wallet: target,
      spent: prior + Math.max(0, amountNative),
      ...(typeof baseline === "number" ? { baseline } : {}),
    },
  ];
}


const read = <T,>(key: string, fallback: T): T => {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — the guard still runs, it just cannot accumulate */
  }
};

export const loadExposure = (wallet: string, now: number): number =>
  exposureFor(read<ExposureRecord[]>(EXPOSURE_KEY, []), wallet, now);

export function addExposure(wallet: string, amountNative: number, now: number): void {
  write(EXPOSURE_KEY, recordExposure(read<ExposureRecord[]>(EXPOSURE_KEY, []), wallet, amountNative, now));
}

/** Balance the operational wallet had when this session first looked at it. */
export function loadBaseline(wallet: string, now: number): number | undefined {
  const records = read<ExposureRecord[]>(EXPOSURE_KEY, []);
  const day = utcDay(now);
  const target = wallet.trim().toLowerCase();
  return records.find((r) => r.day === day && r.wallet === target)?.baseline;
}

/** Record the first-seen balance for the day; never overwrites an existing one. */
export function recordBaseline(wallet: string, nativeBalance: number, now: number): void {
  const records = read<ExposureRecord[]>(EXPOSURE_KEY, []);
  const day = utcDay(now);
  const target = wallet.trim().toLowerCase();
  if (records.some((r) => r.day === day && r.wallet === target && typeof r.baseline === "number")) return;
  write(EXPOSURE_KEY, [...records, { day, wallet: target, spent: 0, baseline: nativeBalance }]);
}

export const loadBreaker = (): BreakerState | null => read<BreakerState | null>(BREAKER_KEY, null);

export const saveBreaker = (state: BreakerState): void => write(BREAKER_KEY, state);

/** Deliberate resume after investigating — never automatic. */
export const resetBreaker = (): void => write(BREAKER_KEY, { trippedAt: null });
