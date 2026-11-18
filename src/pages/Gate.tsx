import { api } from "@/convex/_generated/api";
import { isFunctionKindSkew, VERSION_SKEW_MESSAGE } from "@/lib/version-skew";
import { clearGrant, getGrant, setGrant } from "@/lib/gate";
import {
  isBackendPausedError,
  markBackendOutage,
  userSafeBackendError,
} from "@/lib/backend-outage";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ArrowRight,
  KeyRound,
  Loader2,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import logo from "@/assets/logo.svg";
import { AvatarExplainer } from "@/components/AvatarExplainer";
import { ShcsCredit } from "@/components/ShcsCredit";
import { SubscribeBanner } from "@/components/SubscribeBanner";
import { SubscribeDialog } from "@/components/SubscribeDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { WorldClock } from "@/components/WorldClock";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function GatePage() {
  const navigate = useNavigate();
  const seedOperator = useMutation(api.gate.seedOperator);
  const operatorLogin = useAction(api.gate.operatorLogin);
  const subscriberLogin = useMutation(api.gate.subscriberLogin);
  const operatorStatus = useQuery(api.gate.operatorStatus);

  // operator session (this device, after operator login)
  const [operatorSession, setOperatorSession] = useState<string | null>(() =>
    getGrant()?.role === "operator" ? getGrant()?.email ?? null : null,
  );

  // operator login form
  const [opEmail, setOpEmail] = useState("");
  const [opPassphrase, setOpPassphrase] = useState("");
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // subscriber login form
  const [subEmail, setSubEmail] = useState("");
  const [subPasscode, setSubPasscode] = useState("");
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [grant, setGrantState] = useState(getGrant());

  // Forgot passphrase flow
  const sendForgotOtp = useMutation(api.gate.sendForgotPasscodeOtp);
  const verifyForgotOtp = useMutation(api.gate.verifyForgotPasscodeOtp);
  const resetPassphrase = useMutation(api.gate.resetOperatorPassphrase);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState<0 | 1 | 2>(0); // 0=send, 1=otp+newPp, 2=confirm
  const [forgotOtp, setForgotOtp] = useState("");
  const [forgotNewPp, setForgotNewPp] = useState("");
  const [forgotConfirmPp, setForgotConfirmPp] = useState("");
  const [forgotGuestPp, setForgotGuestPp] = useState("");
  const [forgotSessionToken, setForgotSessionToken] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  // Idempotently seed the operator profile (encrypted default credentials).
  useEffect(() => {
    seedOperator().catch((err) => {
      // Transient network errors are fine — the profile persists server-side.
      // A paused backend (plan-limit disable) is expected too: flip the global
      // outage flag so auth-gated routes can show the standby state.
      if (isBackendPausedError(err)) markBackendOutage();
    });
  }, [seedOperator]);

  const handleOperatorLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOpBusy(true);
    setOpError(null);
    try {
      await operatorLogin({ email: opEmail, passphrase: opPassphrase });
      const grantData = {
        role: "operator" as const,
        email: opEmail.trim().toLowerCase(),
        grantedAt: Date.now(),
      };
      setGrant(grantData);
      setGrantState(grantData);
      setOperatorSession(grantData.email);
      toast.success("Terminal operator verified — opening the landing page.");
      navigate("/home");
    } catch (err) {
      // A stale bundle calls this Action as a Mutation; retrying cannot fix it.
      setOpError(
        isFunctionKindSkew(err)
          ? VERSION_SKEW_MESSAGE
          : userSafeBackendError(err, "Operator login failed."),
      );
    } finally {
      setOpBusy(false);
    }
  };

  const handleSubscriberLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubBusy(true);
    setSubError(null);
    try {
      const res = await subscriberLogin({ email: subEmail, passcode: subPasscode });
      setGrant({ role: "subscriber", email: res.email, grantedAt: Date.now() });
      toast.success("Access granted — opening the landing page.");
      navigate("/home");
    } catch (err) {
      setSubError(userSafeBackendError(err, "Invalid credentials."));
    } finally {
      setSubBusy(false);
    }
  };

  const handleSignOut = () => {
    clearGrant();
    setGrantState(null);
    setOperatorSession(null);
    toast.info("Signed out of the gate.");
  };

  // Forgot passphrase handlers
  const handleSendForgotOtp = async () => {
    setForgotBusy(true);
    setForgotError(null);
    try {
      await sendForgotOtp();
      setForgotStep(1);
      toast.success("Verification code sent to your default delivery.");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Failed to send code.");
    } finally {
      setForgotBusy(false);
    }
  };

  const handleVerifyForgotOtp = async () => {
    setForgotBusy(true);
    setForgotError(null);
    try {
      const res = await verifyForgotOtp({ code: forgotOtp });
      setForgotSessionToken(res.sessionToken);
      setForgotStep(2);
      toast.success("Code verified. Now set your new passphrase.");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setForgotBusy(false);
    }
  };

  const handleResetPassphrase = async () => {
    if (forgotNewPp !== forgotConfirmPp) {
      setForgotError("New passphrase and confirmation do not match.");
      return;
    }
    setForgotBusy(true);
    setForgotError(null);
    try {
      await resetPassphrase({
        sessionToken: forgotSessionToken,
        newPassphrase: forgotNewPp,
        guestPassphrase: forgotGuestPp,
      });
      toast.success("Passphrase reset successfully! Use your new passphrase to sign in.");
      setForgotOpen(false);
      setForgotStep(0);
      setForgotOtp("");
      setForgotNewPp("");
      setForgotConfirmPp("");
      setForgotGuestPp("");
      setForgotSessionToken("");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setForgotBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-3">
        <WorldClock className="hidden sm:flex" />
        <WhatsAppChannelButton />
        <ThemeToggle />
      </div>

      {/* FlashBolt logo — extreme top center */}
      <header className="flex flex-col items-center pt-6">
        <img
          src={logo}
          alt="FlashBolt"
          width={64}
          height={64}
          className="rounded-full glow-amber"
        />
        <div className="mt-2 text-3xl font-extrabold tracking-tight">
          Flash<span className="text-primary">Bolt</span>
        </div>
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
          BNB Chain arbitrage terminal · access gate
        </p>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
        {/* Dashboards */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Terminal operator dashboard */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UserRound className="size-5 text-primary" />
                Terminal Operator
              </CardTitle>
              <CardDescription>
                Default credentials are stored encrypted in the backend — never
                shown here. Sign in with the operator email + passphrase to
                open the landing page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {operatorSession ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Verified as terminal operator — the operator console lives
                    on the terminal page.
                  </div>
                  <Button className="w-full" onClick={() => navigate("/home")}>
                    <ArrowRight className="mr-2 size-4" />
                    Open the landing page
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full" onClick={handleSignOut}>
                    <LogOut className="mr-1.5 size-4" />
                    Sign out
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleOperatorLogin} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="op-email">Operator email address</Label>
                    <Input
                      id="op-email"
                      type="email"
                      value={opEmail}
                      onChange={(e) => setOpEmail(e.target.value)}
                      placeholder="operator@example.com"
                      required
                      disabled={opBusy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="op-passphrase">Passphrase</Label>
                    <Input
                      id="op-passphrase"
                      type="password"
                      value={opPassphrase}
                      onChange={(e) => setOpPassphrase(e.target.value)}
                      placeholder="••••••••••••••••"
                      required
                      disabled={opBusy}
                    />
                  </div>
                  {opError && <p className="text-sm text-red-500">{opError}</p>}
                  <Button type="submit" className="w-full" disabled={opBusy}>
                    {opBusy ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 size-4" />
                    )}
                    Enter operator dashboard
                  </Button>
                  <button
                    type="button"
                    className="mt-1 w-full text-center text-xs text-primary/80 hover:text-primary underline-offset-2 hover:underline"
                    onClick={() => {
                      setForgotOpen(true);
                      setForgotStep(0);
                      setForgotOtp("");
                      setForgotNewPp("");
                      setForgotConfirmPp("");
                      setForgotGuestPp("");
                      setForgotSessionToken("");
                      setForgotError(null);
                    }}
                  >
                    Forgot Passphrase? Get a dynamic passcode
                  </button>
                  {operatorStatus?.seeded === false && (
                    <p className="text-xs text-muted-foreground">Seeding operator profile…</p>
                  )}
                </form>
              )}
            </CardContent>
          </Card>

          {/* Subscriber dashboard */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <KeyRound className="size-5 text-primary" />
                Subscriber
              </CardTitle>
              <CardDescription>
                Already subscribed? Use the email address you subscribed with and
                the unique passcode emailed to you after the operator confirmed
                your request (valid for the window set by the terminal operator —
                72 hours by default).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubscriberLogin} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sub-email-login">Email address used for subscribing</Label>
                  <Input
                    id="sub-email-login"
                    type="email"
                    value={subEmail}
                    onChange={(e) => setSubEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    disabled={subBusy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sub-passcode">Valid passcode</Label>
                  <Input
                    id="sub-passcode"
                    value={subPasscode}
                    onChange={(e) => setSubPasscode(e.target.value)}
                    placeholder="FB-XXXX-XXXX"
                    className="font-mono uppercase"
                    required
                    disabled={subBusy}
                  />
                </div>
                {subError && <p className="text-sm text-red-500">{subError}</p>}
                <Button type="submit" className="w-full" disabled={subBusy}>
                  {subBusy ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="mr-2 size-4" />
                  )}
                  Enter the terminal
                </Button>
                <p className="text-xs text-muted-foreground">
                  No passcode yet? Use SUBSCRIBE NOW below — the operator
                  confirms your request before your passcode is emailed to you.
                </p>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Thumbnail + subscribe */}
        <section className="space-y-2">
          <SubscribeBanner onSubscribe={() => setDialogOpen(true)} />
          <p className="text-center text-xs text-muted-foreground">
            Subscribing sends your details to the terminal operator. Your unique
            passcode is generated and stored encrypted in the backend — it is
            never shown here and is emailed to you only after the operator
            confirms your request.
          </p>
        </section>

        {/* Short video explainer with a humanistic avatar (replaces the old
            operator console on this page) */}
        <AvatarExplainer />
      </main>

      <footer className="border-t border-border/60 py-3">
        <ShcsCredit />
      </footer>

      {/* Forgot Passphrase Dialog */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Operator Passphrase</DialogTitle>
            <DialogDescription>
              {forgotStep === 0 && "Request a verification code to your default delivery."}
              {forgotStep === 1 && "Enter the code you received, then set your new passphrase."}
              {forgotStep === 2 && "Confirm with the guest passphrase to finalize the change."}
            </DialogDescription>
          </DialogHeader>

          {forgotStep === 0 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                A one-time verification code will be sent to your operator default
                delivery method (email + WhatsApp). The code expires in 5 minutes.
              </p>
              {forgotError && <p className="text-sm text-red-500">{forgotError}</p>}
              <Button onClick={handleSendForgotOtp} disabled={forgotBusy} className="w-full">
                {forgotBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <KeyRound className="mr-2 size-4" />}
                Send verification code
              </Button>
            </div>
          )}

          {forgotStep === 1 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="forgot-otp">Verification code</Label>
                <Input
                  id="forgot-otp"
                  value={forgotOtp}
                  onChange={(e) => setForgotOtp(e.target.value)}
                  placeholder="Enter 6-digit code"
                  className="font-mono"
                  disabled={forgotBusy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="forgot-new-pp">New passphrase</Label>
                <Input
                  id="forgot-new-pp"
                  type="password"
                  value={forgotNewPp}
                  onChange={(e) => setForgotNewPp(e.target.value)}
                  placeholder="Enter new passphrase"
                  disabled={forgotBusy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="forgot-confirm-pp">Confirm new passphrase</Label>
                <Input
                  id="forgot-confirm-pp"
                  type="password"
                  value={forgotConfirmPp}
                  onChange={(e) => setForgotConfirmPp(e.target.value)}
                  placeholder="Re-enter new passphrase"
                  disabled={forgotBusy}
                />
              </div>
              {forgotError && <p className="text-sm text-red-500">{forgotError}</p>}
              <Button
                onClick={handleVerifyForgotOtp}
                disabled={forgotBusy || !forgotOtp.trim() || !forgotNewPp || !forgotConfirmPp}
                className="w-full"
              >
                {forgotBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                Verify code & continue
              </Button>
            </div>
          )}

          {forgotStep === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the guest passphrase (second default passphrase stored in the backend) to confirm this change.
                The new passphrase becomes effective only after this confirmation.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="forgot-guest-pp">Guest passphrase (confirmation)</Label>
                <Input
                  id="forgot-guest-pp"
                  type="password"
                  value={forgotGuestPp}
                  onChange={(e) => setForgotGuestPp(e.target.value)}
                  placeholder="Enter guest passphrase"
                  disabled={forgotBusy}
                />
              </div>
              {forgotError && <p className="text-sm text-red-500">{forgotError}</p>}
              <Button
                onClick={handleResetPassphrase}
                disabled={forgotBusy || !forgotGuestPp}
                className="w-full"
              >
                {forgotBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                Confirm & set new passphrase
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <SubscribeDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
