// A new auth provider was correctly added in accordance with the vly auth
// documentation: the email-only "operator-email" provider lets the terminal
// operator sign up / sign in with any different email address freely (no
// pass codes). The account password is generated and stored server-side and
// used by the app in the background — the operator never types or sees it.

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { emailOtp } from "./auth/emailOtp";
import { password } from "./auth/password";
import { operatorEmail } from "./auth/operatorEmail";


export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Anonymous, password, operatorEmail],
});