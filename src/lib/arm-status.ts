import { ARM_MAX_AGE_MS } from "@/convex/pinGuard";

/**
 * Arm staleness, derived from the pin guard's own limit.
 *
 * The guard in `src/convex/pinGuard.ts` is the only authority on when an arm
 * stops authorizing a bytecode pin, so every page reads its limit instead of
 * keeping a second copy that can drift from the server's. `ARM_STALE_MS` is
 * derived from it too, not chosen separately.
 */
export const ARM_LIMIT_MS = ARM_MAX_AGE_MS;
export const ARM_LIMIT_DAYS = Math.round(ARM_MAX_AGE_MS / 86_400_000);
// Warn for the last week of the limit: pins will refuse the arm soon, and
// re-arming needs a save while the operator is paying attention. Derived, so a
// shorter limit shrinks the window instead of leaving it past the limit.
export const ARM_WARN_HEADROOM_MS = 7 * 86_400_000;
export const ARM_STALE_MS = Math.max(0, ARM_MAX_AGE_MS - ARM_WARN_HEADROOM_MS);

export type ArmTone = "ok" | "warn" | "danger";

/** "3d 4h ago" — and honest about a deployment saved before arm stamps existed. */
export function formatArmAge(stamp: number | null | undefined, now: number): string {
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) return "not recorded";
  const age = Math.max(0, now - stamp);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function armStampTitle(stamp?: number | null): string {
  return typeof stamp === "number" && Number.isFinite(stamp)
    ? new Date(stamp).toISOString()
    : "No timestamp: this deployment was armed before arm stamps were recorded.";
}

/**
 * Graded staleness for the arm a pin decision would rely on. The hard stop is
 * the backend guard's 30-day limit; a stale arm is flagged a week before it,
 * because an operator who learns about expiry from a refusal has already lost
 * the window. Nothing here claims a pin is available when it is not.
 */
export function armStatus(
  stamp: number | null | undefined,
  now: number,
): { tone: ArmTone; message: string } {
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) {
    return {
      tone: "danger",
      message:
        "No arm timestamp: bytecode pins refuse this deployment until it is saved here again, which records one. Re-saving an existing stamp does not refresh it.",
    };
  }
  const age = Math.max(0, now - stamp);
  const daysLeft = Math.ceil((ARM_LIMIT_MS - age) / 86_400_000);
  if (age > ARM_LIMIT_MS) {
    const days = Math.floor(age / 86_400_000);
    return {
      tone: "danger",
      message: `Stale arm: ${days} days old, past the ${ARM_LIMIT_DAYS}-day limit — bytecode pins are refused. Deploy or save another address to re-arm.`,
    };
  }
  if (age > ARM_STALE_MS) {
    const days = Math.floor(age / 86_400_000);
    // At exactly the limit the guard still accepts (`age > ARM_LIMIT_MS`
    // refuses), so "0 more days" would be both wrong and alarming: say what is
    // true — there is less than a day left.
    const remaining =
      daysLeft > 0
        ? `Pins accept it for ${daysLeft} more ${daysLeft === 1 ? "day" : "days"}, then refuse it until a new address is armed.`
        : "Pins accept it for less than a day, then refuse it until a new address is armed.";
    return {
      tone: "warn",
      message: `Stale arm: ${days} days old. ${remaining}`,
    };
  }
  const days = Math.floor(age / 86_400_000);
  return {
    tone: "ok",
    message: `Fresh arm: ${days === 0 ? "armed today" : `${days} ${days === 1 ? "day" : "days"} old`}, pins accept it for ${daysLeft} more ${daysLeft === 1 ? "day" : "days"}.`,
  };
}
