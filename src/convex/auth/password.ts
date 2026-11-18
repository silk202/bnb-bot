import { Password } from "@convex-dev/auth/providers/Password";
import { Email } from "@convex-dev/auth/providers/Email";
import { generateNumericCode, sendCodeEmail } from "./otpMail";

/**
 * Strong-password rules (mirrors src/lib/password.ts used by the auth UI):
 * at least 8 characters, one capital letter, one number and one symbol.
 * Inlined here so the Convex bundle stays self-contained.
 */
function checkStrongPassword(pw: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (pw.length < 8) errors.push("at least 8 characters");
  if (!/[A-Z]/.test(pw)) errors.push("one capital letter");
  if (!/[0-9]/.test(pw)) errors.push("one number");
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push("one symbol");
  return { ok: errors.length === 0, errors };
}

/**
 * Email-OTP wrapper shared by the `verify` (sign-up verification) and `reset`
 * (password reset) channels of the Password provider. Codes are 6 digits,
 * expire after 15 minutes and are delivered through the live OTP relay.
 */
function otpProvider(id: string, appName: string) {
  return Email({
    id,
    maxAge: 60 * 15, // 15 minutes
    async generateVerificationToken() {
      return generateNumericCode(6);
    },
    async sendVerificationRequest({
      identifier,
      token,
    }: {
      identifier: string;
      token: string;
    }) {
      await sendCodeEmail(identifier, token, appName);
    },
  });
}

/**
 * Email + password provider powering the new auth page:
 * - sign-up requires a strong password (≥8 chars, one capital, one number,
 *   one symbol) — enforced here server-side AND mirrored in the UI.
 * - email OTP verification is required before a new account can sign in
 *   (`verify` channel sends the code during registration).
 * - password resets are gated by an emailed OTP (`reset` channel).
 *
 * The profile stays synchronous (the framework calls it without await), so
 * the "sign up with the subscribed email" rule is enforced by the gate flow
 * on the client and documented in the README.
 */
export const password = Password({
  id: "password",
  validatePasswordRequirements(pw: string) {
    const check = checkStrongPassword(pw);
    if (!check.ok) {
      throw new Error(`Password must include: ${check.errors.join(", ")}.`);
    }
  },
  verify: otpProvider("password-verify", "FlashBolt sign-up verification"),
  reset: otpProvider("password-reset", "FlashBolt password reset"),
  profile(params) {
    const email = String(params.email ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("A valid email address is required.");
    }
    return { email, name: email.split("@")[0] };
  },
});
