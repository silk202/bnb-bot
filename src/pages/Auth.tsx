import { api } from "@/convex/_generated/api";
import { userSafeBackendError } from "@/lib/backend-outage";
import { useAction, useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  TerminalChooserDialog,
  FLAVOR_META,
  setStoredFlavor,
  type TerminalFlavor,
} from "@/components/TerminalChooserDialog";
import { ShcsCredit } from "@/components/ShcsCredit";
import { copyText } from "@/components/copy-text";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { WorldClock } from "@/components/WorldClock";
import { useAuth } from "@/hooks/use-auth";
import { getGrant, getDeviceToken, setDeviceToken } from "@/lib/gate";
import { checkStrongPassword, passwordStrength } from "@/lib/password";
import logo from "@/assets/logo.svg";
import {
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  UserRoundCog,
  UserX,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/terminal",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

type OtpView =
  | { kind: "verify"; email: string }
  | { kind: "reset"; email: string };

function EmailInput({
  value,
  onChange,
  placeholder = "name@example.com",
  disabled,
  locked,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled: boolean;
  locked: boolean;
}) {
  return (
    <div className="relative flex-1">
      <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
      <Input
        type="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
        disabled={disabled || locked}
        readOnly={locked}
        required
      />
    </div>
  );
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const registerDesktop = useMutation(
    api.operatorEmails.registerOperatorDesktopEmail,
  );
  // SEAMLESS TELEGRAM AUTO-CONNECT — fired right after operator email
  // verification; warms the webhook + pairing code in the background.
  const autoConnectBot = useAction(api.telegramBot.autoConnectBot);
  const sendGuestCode = useMutation(api.gate.sendOperatorGuestCode);
  const verifyGuestCode = useMutation(api.gate.verifyOperatorGuestCode);
  const generateGuestPopupCode = useMutation(api.gate.generateGuestPopupCode);
  const verifyGuestPopupCode = useMutation(api.gate.verifyGuestPopupCode);
  const getGuestPasscodeMode = useQuery(api.gate.getGuestPasscodeMode);
  const requestGuestPasscodeReset = useMutation(api.gate.requestGuestPasscodeReset);
  const validateGuestPasscodeReset = useMutation(api.gate.validateGuestPasscodeReset);
  const verifyGuestPassphrase = useMutation(api.gate.verifyGuestPassphrase);
  // Stamps the anonymous session's user row after the guest code verifies so
  // operator-only backend surfaces (the Telegram bot mirror) accept it.
  const activateGuestOperatorSession = useMutation(api.gate.activateGuestOperatorSession);
  // Server-issued device trust — minted ONLY after a real verification below.
  const issueDeviceTrust = useMutation(api.operatorEmails.issueDeviceTrustToken);
  const sendSignInOtp = useMutation(api.gate.sendSignInOtp);
  const verifySignInOtp = useMutation(api.gate.verifySignInOtp);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  // Gate role drives auth rules: guest is operator-only, subscribers are
  // locked to the email address they subscribed with.
  const grant = getGrant();
  const subscriberEmail = grant?.role === "subscriber" ? grant.email : null;
  // Operator flow is passcode-free: the terminal operator signs up / signs in
  // with ANY different email address — no password field, no one-time code.
  const operatorMode = grant?.role === "operator";
  const canGuest = operatorMode;
  const lockedEmail = Boolean(subscriberEmail);

  // login
  const [loginEmail, setLoginEmail] = useState(subscriberEmail ?? "");
  const [loginPassword, setLoginPassword] = useState("");
  // registration
  const [regEmail, setRegEmail] = useState(subscriberEmail ?? "");
  const [regPassword, setRegPassword] = useState("");
  const [showRegPassword, setShowRegPassword] = useState(false);
  // forgot password
  const [forgotEmail, setForgotEmail] = useState(subscriberEmail ?? "");
  const [forgotPanel, setForgotPanel] = useState(false);
  // verification
  const [otpView, setOtpView] = useState<OtpView | null>(null);
  const [otp, setOtp] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // guest access popup (operator "Continue as Guest" → enter the emailed code)
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestCode, setGuestCode] = useState("");
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  // Popup mode: the generated code to display in the popup
  const [popupDisplayedCode, setPopupDisplayedCode] = useState<string | null>(null);
  // Forgot passcode state
  const [forgotPasscodeBusy, setForgotPasscodeBusy] = useState(false);
  const [forgotPasscodeMsg, setForgotPasscodeMsg] = useState<string | null>(null);
  // Hidden gate passphrase above "Continue as Guest"
  const [guestGatePassphrase, setGuestGatePassphrase] = useState("");
  const [guestGateVerified, setGuestGateVerified] = useState(false);
  const [guestGateBusy, setGuestGateBusy] = useState(false);
  const [guestGateError, setGuestGateError] = useState<string | null>(null);
  // Track whether OTP was sent by Convex auth or by our custom sendSignInOtp
  const [otpIsCustom, setOtpIsCustom] = useState(false);

  // Terminal chooser — after any successful entry (sign-in OTP, reset,
  // guest passcode) the operator/subscriber picks BNB FlashBolt or SOL
  // FlashBolt. The choice is persisted per browser and navigates to the
  // selected terminal.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserBusy, setChooserBusy] = useState(false);

  const openTerminalFor = useCallback((flavor: TerminalFlavor) => {
    setStoredFlavor(flavor);
    navigate(FLAVOR_META[flavor].path);
  }, [navigate]);

  const handleChooseTerminal = useCallback(
    (flavor: TerminalFlavor) => {
      setChooserBusy(true);
      openTerminalFor(flavor);
    },
    [openTerminalFor],
  );

  /**
   * Entry after successful auth: an explicit returnTo (a deep link into a
   * specific terminal) goes straight there; the default entry shows the
   * terminal-chooser popup (BNB FlashBolt vs SOL FlashBolt).
   */
  const enterTerminalAfterAuth = useCallback(() => {
    if (redirect && redirect !== "/terminal") {
      navigate(redirect);
      return;
    }
    setChooserOpen(true);
  }, [redirect, navigate]);

  // Handle guest passcode reset link validation
  const guestResetToken = searchParams.get("guestReset");
  const [resetValidating, setResetValidating] = useState(false);
  useEffect(() => {
    if (guestResetToken && !resetValidating) {
      setResetValidating(true);
      validateGuestPasscodeReset({ token: guestResetToken })
        .then(() => {
          toast.success("Guest passcode reset successfully. Please sign in again.");
          navigate("/");
        })
        .catch((err) => {
          setError(
            userSafeBackendError(err, "Invalid or expired reset link."),
          );
        });
    }
  }, [guestResetToken, resetValidating, validateGuestPasscodeReset, navigate]);

  // "Re-verify session" shortcut (from the Telegram bot dialog's amber
  // banner): the user is already signed in but the session lacks the
  // server-side operator stamp — they came here to re-confirm the guest code,
  // not to be bounced back out.
  const reverifyMode = searchParams.get("reverify") === "1";

  // One-time hint so the re-visit isn't confusing.
  useEffect(() => {
    if (reverifyMode) {
      toast.info("Confirm your guest access code to re-verify this session.");
    }
  }, [reverifyMode]);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      // A fresh session for an unverified page state must not double-open the
      // chooser over the OTP / guest-passcode views — let those flows route
      // through enterTerminalAfterAuth instead.
      if (otpView || guestOpen) return;
      // Re-verify mode: stay on /auth so the guest code flow can run and
      // stamp THIS session — bouncing an already-authenticated user back to
      // the terminal would skip the re-verification entirely.
      if (reverifyMode) return;
      enterTerminalAfterAuth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, reverifyMode]);

  const strength = passwordStrength(regPassword);
  const regCheck = checkStrongPassword(regPassword);
  const strengthLabel = ["Weak", "Weak", "Fair", "Good", "Strong"][strength];

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const result = await signIn("password", {
        flow: "signIn",
        email: loginEmail,
        password: loginPassword,
      });
      // EmailOTP is always required before terminal access.
      if (
        result &&
        typeof result === "object" &&
        "verify" in (result as Record<string, unknown>)
      ) {
        // Convex auth already sent the OTP — use it
        setOtpIsCustom(false);
        setOtpView({ kind: "verify", email: loginEmail });
      } else {
        // Email already verified — send our own OTP
        setOtpIsCustom(true);
        await sendSignInOtp({ email: loginEmail });
        setOtpView({ kind: "verify", email: loginEmail });
      }
    } catch (err) {
      setError(
        userSafeBackendError(err, "Sign-in failed. Please try again."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!regCheck.ok) {
      setError(`Password must include: ${regCheck.errors.join(", ")}.`);
      return;
    }
    setIsLoading(true);
    try {
      await signIn("password", {
        flow: "signUp",
        email: regEmail,
        password: regPassword,
      });
      // Email OTP verification is required for new accounts.
      setOtpView({ kind: "verify", email: regEmail });
    } catch (err) {
      setError(
        userSafeBackendError(err, "Registration failed. Please try again."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendReset = async () => {
    setError(null);
    setIsLoading(true);
    try {
      await signIn("password", { flow: "reset", email: forgotEmail });
      setOtpView({ kind: "reset", email: forgotEmail });
    } catch (err) {
      setError(
        userSafeBackendError(err, "Could not send a reset code."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      if (otpView?.kind === "verify") {
        if (otpIsCustom) {
          // Custom sign-in OTP — verify against our backend
          await verifySignInOtp({ email: otpView.email, code: otp });
        } else {
          // Convex auth OTP — verify through the auth provider
          await signIn("password", {
            flow: "email-verification",
            email: otpView.email,
            code: otp,
          });
        }
        // The operator's registered email is the one that unlocks the desktop
        // setups (Linux / macOS / Windows) without any activation password —
        // link it in the backend the moment the account is verified.
        if (operatorMode) {
          try {
            await registerDesktop({ email: otpView.email });
          } catch {
            // Non-fatal: the account is verified; the desktop link can be
            // retried on the next sign-in.
          }
          // SEAMLESS TELEGRAM AUTO-CONNECT: warm the bot up in the background
          // (idempotent webhook self-heal + live pairing code) so it is ready
          // the moment the operator opens the bot dialog or the deep link.
          // Fire-and-forget — never blocks entry into the terminal.
          autoConnectBot({ deviceToken: getDeviceToken() ?? undefined })
            .then((res) => {
              // Silent device upgrade — persist the freshly minted token.
              if (res.deviceToken) setDeviceToken(res.deviceToken);
            })
            .catch(() => {
              /* the cron sweep self-heals every 10 minutes */
            });
          // Server-issued device trust: this browser completed a REAL operator
          // OTP verification — mint the bearer token (only its hash is stored
          // server-side) so every future session here is recognized without
          // re-verification.
          issueDeviceTrust({ verifiedKind: "operator-otp", email: otpView.email })
            .then((r) => {
              if (r.ok && r.token) setDeviceToken(r.token);
            })
            .catch(() => {
              // Non-fatal — the session itself is fully signed in.
            });
        }
        enterTerminalAfterAuth();
      }
    } catch (err) {
      setError(
        userSafeBackendError(err, "The verification code is incorrect."),
      );
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const check = checkStrongPassword(newPassword);
    if (!check.ok) {
      setError(`New password must include: ${check.errors.join(", ")}.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setIsLoading(true);
    try {
      await signIn("password", {
        flow: "reset-verification",
        email: otpView?.kind === "reset" ? otpView.email : forgotEmail,
        code: resetCode,
        newPassword,
      });
      enterTerminalAfterAuth();
    } catch (err) {
      setError(
        userSafeBackendError(err, "Reset failed — check the code and try again."),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyGatePassphrase = async () => {
    setGuestGateBusy(true);
    setGuestGateError(null);
    try {
      await verifyGuestPassphrase({ passphrase: guestGatePassphrase });
      setGuestGateVerified(true);
      setGuestGateError(null);
    } catch (err) {
      setGuestGateVerified(false);
      setGuestGateError(
        err instanceof Error ? err.message : "Invalid passphrase.",
      );
    } finally {
      setGuestGateBusy(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      if (operatorMode) {
        const mode = getGuestPasscodeMode?.mode ?? "popup";
        if (mode === "popup") {
          // Popup mode: generate a one-time code and DISPLAY it in the popup.
          // No email required — the operator sees the code directly.
          const result = await generateGuestPopupCode();
          setPopupDisplayedCode(result.code);
          setGuestCode("");
          setGuestError(null);
          setForgotPasscodeMsg(null);
          setGuestOpen(true);
          return;
        }
        // Email mode (old method): code is emailed, operator enters from email.
        await sendGuestCode();
        setPopupDisplayedCode(null);
        setGuestCode("");
        setGuestError(null);
        setForgotPasscodeMsg(null);
        setGuestOpen(true);
        return;
      }
      await signIn("anonymous");
      enterTerminalAfterAuth();
    } catch (err) {
      setError(
        `Failed to sign in as guest: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestResend = async () => {
    setGuestBusy(true);
    setGuestError(null);
    try {
      const mode = getGuestPasscodeMode?.mode ?? "popup";
      if (mode === "popup") {
        const result = await generateGuestPopupCode();
        setPopupDisplayedCode(result.code);
        setGuestCode("");
      } else {
        await sendGuestCode();
        setGuestCode("");
      }
    } catch (err) {
      setGuestError(
        err instanceof Error ? err.message : "Could not generate a fresh guest code.",
      );
    } finally {
      setGuestBusy(false);
    }
  };

  const handleGuestCodeSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGuestBusy(true);
    setGuestError(null);
    try {
      const mode = getGuestPasscodeMode?.mode ?? "popup";
      if (mode === "popup" && popupDisplayedCode) {
        // Popup mode: verify the code displayed in the popup window.
        await verifyGuestPopupCode({ code: guestCode });
      } else {
        // Email mode: verify the emailed code.
        await verifyGuestCode({ code: guestCode });
      }
      const verifiedCode = guestCode.trim();
      setGuestOpen(false);
      setGuestCode("");
      setPopupDisplayedCode(null);
      try {
        await signIn("anonymous");
      } catch {
        // Already in a guest session — the verified code already unlocked it.
      }
      // Tie the just-verified guest code to THIS anonymous session so the
      // Telegram bot mirror (and other operator-only surfaces) accept it.
      // Retry once: the fresh anonymous token may not be attached to the
      // Convex client on the very first call.
      try {
        await activateGuestOperatorSession({ code: verifiedCode });
      } catch {
        await new Promise((r) => setTimeout(r, 800));
        try {
          await activateGuestOperatorSession({ code: verifiedCode });
        } catch {
          // Non-blocking: the terminal itself is already unlocked via the gate.
          toast.warning("Guest session could not be linked to the Telegram bot — re-enter the guest code to retry.");
        }
      }
      // Server-issued device trust: a real guest code was just verified —
      // mint the bearer token so this DEVICE is recognized on every future
      // session, even when the per-session stamp misses (the old amber-banner
      // case). Server-gated: passes only with a fresh verified code or the
      // session stamp.
      try {
        const trust = await issueDeviceTrust({ verifiedKind: "guest-code" });
        if (trust.ok && trust.token) setDeviceToken(trust.token);
      } catch {
        // Non-fatal — the session still works; a later verification re-issues.
      }
      enterTerminalAfterAuth();
    } catch (err) {
      setGuestError(
        err instanceof Error ? err.message : "The guest code is incorrect.",
      );
      setGuestCode("");
    } finally {
      setGuestBusy(false);
    }
  };


  const handleForgotPasscode = async () => {
    setForgotPasscodeBusy(true);
    setForgotPasscodeMsg(null);
    setGuestError(null);
    try {
      await requestGuestPasscodeReset();
      setForgotPasscodeMsg("Reset link sent to your default delivery. Check your email and WhatsApp.");
    } catch (err) {
      setGuestError(
        err instanceof Error ? err.message : "Could not send reset link.",
      );
    } finally {
      setForgotPasscodeBusy(false);
    }
  };
  return (
    <div className="relative min-h-screen flex flex-col">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-3">
        <WorldClock className="hidden sm:flex" />
        <WhatsAppChannelButton />
        <ThemeToggle />
      </div>

      {/* Auth Content */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mb-6 flex cursor-pointer flex-col items-center gap-2.5"
          >
            <img
              src={logo}
              alt="FlashBolt"
              width={56}
              height={56}
              className="rounded-full glow-amber"
            />
            <div className="text-2xl font-extrabold tracking-tight">
              Flash<span className="text-primary">Bolt</span>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
              BNB Chain arbitrage terminal
            </p>
          </button>

          {otpView ? (
            otpView.kind === "verify" ? (
              <Card className="w-full max-w-full pb-0 border">
                <CardHeader className="text-center">
                  <CardTitle>Verify your email</CardTitle>
                  <CardDescription>
                    We sent a one-time verification code to {otpView.email}
                  </CardDescription>
                </CardHeader>
                <form onSubmit={handleOtpSubmit}>
                  <CardContent className="pb-4">
                    <div className="flex justify-center">
                      <InputOTP
                        value={otp}
                        onChange={setOtp}
                        maxLength={6}
                        disabled={isLoading}
                      >
                        <InputOTPGroup>
                          {Array.from({ length: 6 }).map((_, index) => (
                            <InputOTPSlot key={index} index={index} />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                    {error && (
                      <p className="mt-2 text-center text-sm text-red-500">{error}</p>
                    )}
                  </CardContent>
                  <CardFooter className="flex-col gap-2">
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isLoading || otp.length !== 6}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Verifying…
                        </>
                      ) : (
                        <>
                          Verify code
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
                      onClick={() => {
                        setOtpView(null);
                        setOtp("");
                      }}
                      disabled={isLoading}
                    >
                      Use a different email
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            ) : (
              <Card className="w-full max-w-full pb-0 border">
                <CardHeader className="text-center">
                  <CardTitle>Reset your password</CardTitle>
                  <CardDescription>
                    Enter the reset code sent to {otpView.email} and choose a
                    strong new password
                  </CardDescription>
                </CardHeader>
                <form onSubmit={handleResetPassword}>
                  <CardContent className="space-y-3 pb-4">
                    <div className="flex justify-center">
                      <InputOTP
                        value={resetCode}
                        onChange={setResetCode}
                        maxLength={6}
                        disabled={isLoading}
                      >
                        <InputOTPGroup>
                          {Array.from({ length: 6 }).map((_, index) => (
                            <InputOTPSlot key={index} index={index} />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="New strong password"
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    {error && <p className="text-sm text-red-500">{error}</p>}
                  </CardContent>
                  <CardFooter className="flex-col gap-2">
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isLoading || resetCode.length !== 6}
                    >
                      {isLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="mr-2 h-4 w-4" />
                      )}
                      Reset password
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            )
          ) : operatorMode ? (
            <Card className="w-full max-w-full pb-0 border">
              <CardHeader className="text-center">
                <CardTitle className="text-xl">Terminal operator access</CardTitle>
                <CardDescription>
                  Sign up with any valid email + a strong password — an emailed OTP completes
                  registration. Or sign in with your registered email.
                </CardDescription>
              </CardHeader>

              {/* Sign up */}
              <form onSubmit={handleRegister}>
                <CardContent className="space-y-3 pb-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Sign up
                  </p>
                  <EmailInput
                    value={regEmail}
                    onChange={setRegEmail}
                    placeholder="Any valid email address"
                    disabled={isLoading}
                    locked={false}
                  />
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      type={showRegPassword ? "text" : "password"}
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Strong password (min 8 chars)"
                      className="pl-9 pr-9"
                      disabled={isLoading}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowRegPassword((v) => !v)}
                      className="absolute right-2.5 top-3 text-muted-foreground hover:text-foreground"
                      aria-label="Toggle password visibility"
                      tabIndex={-1}
                    >
                      {showRegPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  {regPassword && (
                    <div className="space-y-1">
                      <div className="flex gap-1">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className={`h-1 flex-1 rounded-full ${
                              i < strength ? "bg-primary" : "bg-muted"
                            }`}
                          />
                        ))}
                        <span className="ml-2 text-[10px] font-semibold uppercase text-muted-foreground">
                          {strengthLabel}
                        </span>
                      </div>
                      {!regCheck.ok && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                          Requires: {regCheck.errors.join(", ")}.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
                <CardFooter className="pb-3 pt-0">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoading || !regEmail.trim() || !regCheck.ok}
                  >
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <UserRoundCog className="mr-2 h-4 w-4" />
                    )}
                    Sign up
                  </Button>
                </CardFooter>
              </form>

              {/* Sign in */}
              <form onSubmit={handleLogin}>
                <CardContent className="space-y-3 pt-0 pb-3">
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">Sign in</span>
                    </div>
                  </div>

                  <EmailInput
                    value={loginEmail}
                    onChange={setLoginEmail}
                    placeholder="Registered email address"
                    disabled={isLoading}
                    locked={false}
                  />

                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Valid password"
                      className="pl-9"
                      disabled={isLoading}
                      required
                    />
                  </div>

                  {forgotPanel && (
                    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                      <p className="text-xs text-muted-foreground">
                        Enter your registered email to receive a reset code.
                      </p>
                      <div className="flex items-center gap-2">
                        <EmailInput
                          value={forgotEmail}
                          onChange={setForgotEmail}
                          placeholder="Registered email address"
                          disabled={isLoading}
                          locked={false}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleSendReset}
                          disabled={isLoading}
                          aria-label="Send reset code"
                        >
                          {isLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <KeyRound className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {error && <p className="text-sm text-red-500">{error}</p>}
                </CardContent>
                <CardFooter className="flex-col gap-2 pb-4 pt-0">
                  {/* Under the Sign in fields: Forgot Password · Reset · Sign in.
                      Stacked full-width on phones (the nowrap labels cannot
                      fit 3-across below ~500px), 3-up from sm. */}
                  <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="text-xs"
                      disabled={isLoading}
                      onClick={() => setForgotPanel((v) => !v)}
                    >
                      Forgot Password
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="text-xs"
                      disabled={isLoading}
                      onClick={() => {
                        setLoginEmail("");
                        setLoginPassword("");
                        setRegEmail("");
                        setRegPassword("");
                        setForgotEmail("");
                        setForgotPanel(false);
                        setError(null);
                      }}
                    >
                      Reset
                    </Button>
                    <Button
                      type="submit"
                      className="text-xs"
                      disabled={isLoading || !loginEmail.trim() || !loginPassword.trim()}
                    >
                      {isLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                      Sign in
                    </Button>
                  </div>

                  <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Access passphrase
                    </p>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        type="password"
                        value={guestGatePassphrase}
                        onChange={(e) => {
                          setGuestGatePassphrase(e.target.value);
                          setGuestGateVerified(false);
                          setGuestGateError(null);
                        }}
                        placeholder="Enter access passphrase"
                        className="pl-9"
                        disabled={isLoading || guestGateVerified}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !guestGateVerified && guestGatePassphrase.trim()) {
                            e.preventDefault();
                            handleVerifyGatePassphrase();
                          }
                        }}
                      />
                    </div>
                    {!guestGateVerified && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full text-xs"
                        disabled={isLoading || guestGateBusy || !guestGatePassphrase.trim()}
                        onClick={handleVerifyGatePassphrase}
                      >
                        {guestGateBusy ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                        )}
                        Verify passphrase
                      </Button>
                    )}
                    {guestGateVerified && (
                      <p className="text-center text-[11px] text-emerald-500">✓ Passphrase verified</p>
                    )}
                    {guestGateError && (
                      <p className="text-center text-[11px] text-red-500">{guestGateError}</p>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleGuestLogin}
                    disabled={isLoading || !guestGateVerified}
                  >
                    <UserX className="mr-2 h-4 w-4" />
                    Continue as Guest
                  </Button>
                </CardFooter>
              </form>
              <p className="px-6 pb-4 text-[11px] leading-4 text-muted-foreground">
                Your registered email is the one that unlocks the desktop setups (Linux / macOS /
                Windows) with no activation password. Every “Continue as Guest” click emails a
                fresh periodic code to the operator's default address in the backend.
              </p>
            </Card>
          ) : (
            <Card className="w-full max-w-full pb-0 border">
              <CardHeader className="text-center">
                <CardTitle className="text-xl">Launch the FlashBolt terminal</CardTitle>
                <CardDescription>
                  {subscriberEmail
                    ? `Subscriber access — locked to ${subscriberEmail}`
                    : "Login with your registered email, or sign up with a strong password"}
                </CardDescription>
              </CardHeader>

              {/* Login */}
              <form onSubmit={handleLogin}>
                <CardContent className="space-y-3 pb-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Login
                  </p>
                  <div className="flex items-center gap-2">
                    <EmailInput
                      value={loginEmail}
                      onChange={setLoginEmail}
                      placeholder="Registered email address"
                      disabled={isLoading}
                      locked={lockedEmail}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="icon"
                      disabled={isLoading}
                      aria-label="Login"
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowRight className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Valid password"
                      className="pl-9"
                      disabled={isLoading}
                      required
                    />
                  </div>
                  {error && <p className="text-sm text-red-500">{error}</p>}
                </CardContent>
              </form>

              {/* Register */}
              <form onSubmit={handleRegister}>
                <CardContent className="space-y-3 pt-0">
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">
                        Register
                      </span>
                    </div>
                  </div>

                  <EmailInput
                    value={regEmail}
                    onChange={setRegEmail}
                    placeholder="Preferred email address"
                    disabled={isLoading}
                    locked={lockedEmail}
                  />

                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      type={showRegPassword ? "text" : "password"}
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Strong password (min 8 chars)"
                      className="pl-9 pr-9"
                      disabled={isLoading}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowRegPassword((v) => !v)}
                      className="absolute right-2.5 top-3 text-muted-foreground hover:text-foreground"
                      aria-label="Toggle password visibility"
                      tabIndex={-1}
                    >
                      {showRegPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>

                  {regPassword && (
                    <div className="space-y-1">
                      <div className="flex gap-1">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className={`h-1 flex-1 rounded-full ${
                              i < strength ? "bg-primary" : "bg-muted"
                            }`}
                          />
                        ))}
                        <span className="ml-2 text-[10px] font-semibold uppercase text-muted-foreground">
                          {strengthLabel}
                        </span>
                      </div>
                      {!regCheck.ok && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                          Requires: {regCheck.errors.join(", ")}.
                        </p>
                      )}
                    </div>
                  )}

                  {forgotPanel && (
                    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                      <p className="text-xs text-muted-foreground">
                        Enter your registered email to receive a reset code.
                      </p>
                      <div className="flex items-center gap-2">
                        <EmailInput
                          value={forgotEmail}
                          onChange={setForgotEmail}
                          placeholder="Registered email address"
                          disabled={isLoading}
                          locked={lockedEmail}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleSendReset}
                          disabled={isLoading}
                          aria-label="Send reset code"
                        >
                          {isLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <KeyRound className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex-col gap-3 pt-0">
                  {/* Three active buttons under the registration fields —
                      stacked on phones, 3-across from sm (see sign-in footer). */}
                  <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="text-xs"
                      disabled={isLoading}
                      onClick={() => setForgotPanel((v) => !v)}
                    >
                      Forgot Password
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="text-xs"
                      disabled={isLoading}
                      onClick={() => {
                        setLoginEmail(subscriberEmail ?? "");
                        setLoginPassword("");
                        setRegEmail(subscriberEmail ?? "");
                        setRegPassword("");
                        setForgotEmail(subscriberEmail ?? "");
                        setForgotPanel(false);
                        setError(null);
                      }}
                    >
                      Reset
                    </Button>
                    <Button
                      type="submit"
                      className="text-xs"
                      disabled={isLoading}
                    >
                      Sign up
                    </Button>
                  </div>

                  {canGuest && (
                    <>
                      <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Access passphrase
                        </p>
                        <div className="relative">
                          <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                          <Input
                            type="password"
                            value={guestGatePassphrase}
                            onChange={(e) => {
                              setGuestGatePassphrase(e.target.value);
                              setGuestGateVerified(false);
                              setGuestGateError(null);
                            }}
                            placeholder="Enter access passphrase"
                            className="pl-9"
                            disabled={isLoading || guestGateVerified}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !guestGateVerified && guestGatePassphrase.trim()) {
                                e.preventDefault();
                                handleVerifyGatePassphrase();
                              }
                            }}
                          />
                        </div>
                        {!guestGateVerified && (
                          <Button
                            type="button"
                            variant="outline"
                            className="w-full text-xs"
                            disabled={isLoading || guestGateBusy || !guestGatePassphrase.trim()}
                            onClick={handleVerifyGatePassphrase}
                          >
                            {guestGateBusy ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                            )}
                            Verify passphrase
                          </Button>
                        )}
                        {guestGateVerified && (
                          <p className="text-center text-[11px] text-emerald-500">✓ Passphrase verified</p>
                        )}
                        {guestGateError && (
                          <p className="text-center text-[11px] text-red-500">{guestGateError}</p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={handleGuestLogin}
                        disabled={isLoading || !guestGateVerified}
                      >
                        <UserX className="mr-2 h-4 w-4" />
                        Continue as Guest
                      </Button>
                    </>
                  )}
                </CardFooter>
              </form>
            </Card>
          )}

          <div className="mt-4 flex items-center justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 px-3.5 py-1.5 text-[11px] font-extrabold tracking-[0.12em]">
              <ShieldCheck className="size-4 text-amber-500" />
              <span className="bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 bg-clip-text text-transparent">
                Secured by VPS
              </span>
            </span>
          </div>
        </div>
      </div>
      <footer className="border-t border-border/60 py-3">
        <ShcsCredit />
      </footer>

      {/* Terminal chooser — BNB FlashBolt vs SOL FlashBolt */}
      <TerminalChooserDialog
        open={chooserOpen}
        onChoose={handleChooseTerminal}
        onDismiss={() => {
          if (chooserBusy) return;
          setChooserOpen(false);
          // Dismissing without a choice lands on the default (BNB) terminal.
          navigate("/terminal");
        }}
      />

      {/* Guest access popup — default (popup) mode displays the code directly
          in the window; email mode sends the code to the operator's inbox. */}
      <Dialog
        open={guestOpen}
        onOpenChange={(open) => {
          if (!open && !guestBusy) {
            setGuestOpen(false);
            setPopupDisplayedCode(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-center">
            <DialogTitle className="flex items-center justify-center gap-2">
              <KeyRound className="size-4 text-primary" />
              Guest access passcode
            </DialogTitle>
            <DialogDescription>
              {popupDisplayedCode
                ? "Your one-time guest passcode is displayed below. Enter it to open the terminal."
                : "A fresh code was emailed to the operator's default address. Enter it below to open the terminal as guest."}
            </DialogDescription>
          </DialogHeader>

          {/* In popup mode, show the generated code prominently */}
          {popupDisplayedCode && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Your one-time passcode
              </p>
              <div className="flex items-center gap-3">
                <span className="font-mono text-3xl font-extrabold tracking-[0.2em] text-primary">
                  {popupDisplayedCode}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-border/60 p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    void copyText(popupDisplayedCode, { message: "Passcode copied to clipboard" });
                  }}
                  title="Copy passcode"
                >
                  <Copy className="size-4" />
                </button>
              </div>
              <p className="text-center text-[11px] leading-4 text-muted-foreground">
                This code expires in 15 minutes. Each "Continue as Guest" click generates a fresh code.
              </p>
            </div>
          )}

          <form onSubmit={handleGuestCodeSubmit} className="space-y-4">
            <div className="flex justify-center">
              <InputOTP
                value={guestCode}
                onChange={setGuestCode}
                maxLength={6}
                disabled={guestBusy}
              >
                <InputOTPGroup>
                  {Array.from({ length: 6 }).map((_, index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            {guestError && (
              <p className="text-center text-sm text-red-500">{guestError}</p>
            )}
            {forgotPasscodeMsg && (
              <p className="text-center text-sm text-emerald-500">{forgotPasscodeMsg}</p>
            )}
            {!popupDisplayedCode && (
              <p className="text-center text-[11px] leading-4 text-muted-foreground">
                The code expires in 15 minutes. Use "Resend code" to receive a fresh one — each
                click dispatches a new code to the operator's default email.
              </p>
            )}
            <div className="flex flex-col gap-2">
              <Button
                type="submit"
                className="w-full"
                disabled={guestBusy || guestCode.length !== 6}
              >
                {guestBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                Verify & open terminal
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={guestBusy}
                onClick={handleGuestResend}
              >
                {popupDisplayedCode ? "Generate new code" : "Resend code"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                disabled={guestBusy || forgotPasscodeBusy}
                onClick={handleForgotPasscode}
              >
                {forgotPasscodeBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                Forgot passcode
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={guestBusy}
                onClick={() => {
                  setGuestOpen(false);
                  setPopupDisplayedCode(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
