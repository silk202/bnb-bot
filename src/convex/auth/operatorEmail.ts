import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Email-only auth provider for the terminal operator ("operator-email").
 *
 * Unlike the regular "password" provider, this one has NO `verify` channel,
 * so sign-up and sign-in never require a one-time code / passcode. The
 * terminal operator can register with any different email address freely on
 * the auth page — the account password is generated server-side by
 * `operatorEmails.registerOperatorEmail` (stored encrypted in the backend)
 * and the app signs in with it in the background. The operator never types
 * or sees a passcode.
 *
 * The email used for sign-up is validated and normalized here; the profile
 * stays synchronous (the framework calls it without await).
 */
export const operatorEmail = Password({
  id: "operator-email",
  profile(params) {
    const email = String(params.email ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("A valid email address is required.");
    }
    return { email, name: email.split("@")[0] };
  },
});
