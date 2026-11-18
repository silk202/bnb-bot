/**
 * Strong-password rules shared by the auth page (live strength meter) and the
 * Convex Password provider (server-side enforcement):
 * minimum 8 characters, at least one capital letter, one number and one symbol.
 */
export interface PasswordCheck {
  ok: boolean;
  errors: string[];
}

export function checkStrongPassword(pw: string): PasswordCheck {
  const errors: string[] = [];
  if (pw.length < 8) errors.push("at least 8 characters");
  if (!/[A-Z]/.test(pw)) errors.push("one capital letter");
  if (!/[0-9]/.test(pw)) errors.push("one number");
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push("one symbol");
  return { ok: errors.length === 0, errors };
}

/** Strength score 0..4 for the password meter. */
export function passwordStrength(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return score;
}
