import { useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  Monitor,
  Send,
  ShieldCheck,
  Terminal,
  UserRoundCog,
  UserX,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { getGrant } from "@/lib/gate";
import { WhatsAppMessageButton } from "@/components/WhatsAppMessageButton";
import { copyText } from "@/components/copy-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

/**
 * "Desktop apps" window — split by role:
 * - SUBSCRIBERS see per-OS download + activation (email + activation password).
 * - OPERATORS see:
 *   FIELD 1 — ANY EMAIL ADDRESS — freely, no activation password.
 *   FIELD 2 — CONTINUE AS GUEST — no activation password (guest passphrase gate).
 */

const OS_LIST = [
  { os: "linux", name: "Linux", icon: ">_", tagline: "Debian / Ubuntu · x86_64 & arm64" },
  { os: "macos", name: "macOS", icon: "\u2318", tagline: "Apple Silicon & Intel · .dmg" },
  { os: "windows", name: "Windows", icon: "\u25A0", tagline: "Windows 10 / 11 · x64 · PowerShell" },
];

/* -------------------------------------------------------------------------- */
/*  Subscriber Activation                                                     */
/* -------------------------------------------------------------------------- */

function SubscriberActivation({ os }: { os: string }) {
  const grant = getGrant();
  const [email, setEmail] = useState(grant?.role === "subscriber" ? grant.email : "");
  const status = useQuery(api.licenses.licenseStatus, {
    email: email.trim().toLowerCase(),
    os,
  });
  const activate = useMutation(api.licenses.activateLicense);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!validEmail || !password.trim()) return;
    setBusy(true);
    try {
      const res = await activate({
        email: email.trim().toLowerCase(),
        os,
        password: password.trim(),
      });
      setResult({ ok: res.ok, message: res.message });
      if (res.ok) setPassword("");
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Activation failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <Input
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setResult(null);
        }}
        placeholder="Email you subscribed with"
        className="h-8 font-mono text-xs"
        disabled={busy}
      />
      <div className="flex items-center gap-1.5">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Activation password"
          className="h-8 font-mono text-xs"
          disabled={busy}
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          onClick={submit}
          disabled={busy || !validEmail || !password.trim()}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Activate
        </Button>
      </div>
      {validEmail && status?.exists === false && (
        <p className="text-[11px] text-muted-foreground">
          No license for this email + OS yet — ask the operator to generate one.
        </p>
      )}
      {result && (
        <p className={`flex items-start gap-1.5 text-xs ${result.ok ? "text-emerald-500" : "text-red-500"}`}>
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </p>
      )}
    </div>
  );
}

function SubscriberWindow() {
  const [selectedOS, setSelectedOS] = useState("linux");

  return (
    <div className="space-y-4">
      {/* OS Tabs */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Operating system
        </p>
        <div className="flex gap-1.5">
          {OS_LIST.map((os) => (
            <Button
              key={os.os}
              type="button"
              variant={selectedOS === os.os ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs"
              onClick={() => setSelectedOS(os.os)}
            >
              <Monitor className="mr-1.5 size-3" />
              {os.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Activation form for selected OS */}
      <div className="rounded-xl border border-border/70 bg-card/40 p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Monitor className="size-4" />
          </span>
          <div>
            <div className="text-sm font-bold">{OS_LIST.find((o) => o.os === selectedOS)?.name}</div>
            <div className="text-[10px] text-muted-foreground">
              {OS_LIST.find((o) => o.os === selectedOS)?.tagline}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          Download the setup from the releases, then activate it with your subscriber email +
          password. One activation keeps the app licensed for re-use / re-run.
        </p>
        <SubscriberActivation os={selectedOS} />
      </div>

      <p className="mt-2 flex flex-wrap items-center justify-center gap-2 text-center">
        <span className="text-xs text-muted-foreground">
          Missing your activation password? Message the operator on WhatsApp:
        </span>
        <WhatsAppMessageButton prefill="Hi FlashBolt — I'm a subscriber. I need my desktop activation password." />
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Operator Window — matching template layout                                */
/* -------------------------------------------------------------------------- */

function OperatorDownloads({ email }: { email: string }) {
  const [selectedOS, setSelectedOS] = useState("linux");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-xs leading-5 text-emerald-400">
        <b>{email}</b> is registered — the desktop setups below run without any activation password.
      </div>

      {/* OS Tabs */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Operating system
        </p>
        <div className="flex gap-1.5">
          {OS_LIST.map((os) => (
            <Button
              key={os.os}
              type="button"
              variant={selectedOS === os.os ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs"
              onClick={() => setSelectedOS(os.os)}
            >
              <Monitor className="mr-1.5 size-3" />
              {os.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Download card for selected OS */}
      <div className="rounded-xl border border-border/70 bg-card/40 p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Monitor className="size-4" />
          </span>
          <div>
            <div className="text-sm font-bold">{OS_LIST.find((o) => o.os === selectedOS)?.name}</div>
            <div className="text-[10px] text-muted-foreground">
              {OS_LIST.find((o) => o.os === selectedOS)?.tagline}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          Download the setup from the releases and run it — no activation password required for
          the operator.
        </p>
        <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
          <Terminal className="size-3.5 shrink-0" />
          {selectedOS === "windows"
            ? "Run from PowerShell (flashbolt-windows.ps1)"
            : `Launch ${OS_LIST.find((o) => o.os === selectedOS)?.name} setup`}
        </div>
      </div>
    </div>
  );
}

function OperatorWindow() {
  const grant = getGrant();
  const sendGuestCode = useMutation(api.gate.sendOperatorGuestCode);
  const verifyGuestCode = useMutation(api.gate.verifyOperatorGuestCode);
  const generateGuestPopupCode = useMutation(api.gate.generateGuestPopupCode);
  const verifyGuestPopupCode = useMutation(api.gate.verifyGuestPopupCode);
  const getGuestPasscodeMode = useQuery(api.gate.getGuestPasscodeMode);
  const verifyGuestPassphrase = useMutation(api.gate.verifyGuestPassphrase);

  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Field 1 status: email verified → show downloads
  const [emailDone, setEmailDone] = useState(false);

  // Field 2 status: guest flow
  const [guestStep, setGuestStep] = useState<"idle" | "passphrase" | "code" | "done">("idle");
  const [guestPassphrase, setGuestPassphrase] = useState("");
  const [guestPassphraseVerified, setGuestPassphraseVerified] = useState(false);
  const [guestPassphraseBusy, setGuestPassphraseBusy] = useState(false);
  const [guestPassphraseError, setGuestPassphraseError] = useState<string | null>(null);

  // Guest code popup
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestCode, setGuestCode] = useState("");
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  const [popupDisplayedCode, setPopupDisplayedCode] = useState<string | null>(null);

  const [guestDone, setGuestDone] = useState(false);

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const status = useQuery(api.operatorEmails.operatorDesktopStatus, {
    email: validEmail ? email.trim().toLowerCase() : "",
  });
  const registered = Boolean(status?.isOperator);

  // --- Field 1: email + download ---
  const continueWithEmail = async () => {
    if (!validEmail) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!status?.isOperator) {
        setError(
          "This email is not registered as an operator email yet — sign up on the operator auth page first.",
        );
        return;
      }
      setEmailDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the email.");
    } finally {
      setBusy(false);
    }
  };

  // --- Field 2: Continue as Guest → passphrase gate → code popup → downloads ---
  const handleVerifyGuestPassphrase = async () => {
    setGuestPassphraseBusy(true);
    setGuestPassphraseError(null);
    try {
      await verifyGuestPassphrase({ passphrase: guestPassphrase });
      setGuestPassphraseVerified(true);
      // After passphrase verified, open the code popup
      await openGuestCodePopup();
    } catch (err) {
      setGuestPassphraseVerified(false);
      setGuestPassphraseError(
        err instanceof Error ? err.message : "Invalid passphrase.",
      );
    } finally {
      setGuestPassphraseBusy(false);
    }
  };

  const openGuestCodePopup = async () => {
    setBusy(true);
    setError(null);
    try {
      const mode = getGuestPasscodeMode?.mode ?? "popup";
      if (mode === "popup") {
        const result = await generateGuestPopupCode();
        setPopupDisplayedCode(result.code);
      } else {
        await sendGuestCode();
        setPopupDisplayedCode(null);
      }
      setGuestCode("");
      setGuestError(null);
      setGuestOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a guest code.");
    } finally {
      setBusy(false);
    }
  };

  const resendGuestCode = async () => {
    setGuestBusy(true);
    setGuestError(null);
    try {
      const mode = getGuestPasscodeMode?.mode ?? "popup";
      if (mode === "popup") {
        const result = await generateGuestPopupCode();
        setPopupDisplayedCode(result.code);
      } else {
        await sendGuestCode();
        setPopupDisplayedCode(null);
      }
      setGuestCode("");
    } catch (err) {
      setGuestError(
        err instanceof Error ? err.message : "Could not generate a fresh guest code.",
      );
    } finally {
      setGuestBusy(false);
    }
  };

  const submitGuestCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGuestBusy(true);
    setGuestError(null);
    try {
      const mode = getGuestPasscodeMode?.mode ?? "popup";
      if (mode === "popup" && popupDisplayedCode) {
        await verifyGuestPopupCode({ code: guestCode });
      } else {
        await verifyGuestCode({ code: guestCode });
      }
      setGuestOpen(false);
      setGuestCode("");
      setPopupDisplayedCode(null);
      setGuestDone(true);
    } catch (err) {
      setGuestError(
        err instanceof Error ? err.message : "The guest code is incorrect.",
      );
      setGuestCode("");
    } finally {
      setGuestBusy(false);
    }
  };

  // --- Final state: either email or guest verified → show downloads ---
  if (emailDone) {
    return <OperatorDownloads email={status?.email ?? email.trim()} />;
  }

  if (guestDone) {
    return <OperatorDownloads email="guest" />;
  }

  return (
    <>
      <div className="space-y-4">
        {/* FIELD 1 — Any email address — freely, no activation password */}
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            <span className="mr-1 inline-flex items-center justify-center rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-extrabold text-primary">
              1
            </span>
            Any email address — freely, no activation password
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void continueWithEmail();
            }}
            className="flex items-center gap-2"
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="name@example.com"
              className="h-9 font-mono text-xs"
              disabled={busy}
            />
            <Button
              type="submit"
              className="h-9 shrink-0"
              disabled={busy || !validEmail || !registered}
              title={registered ? "Open the desktop setups" : "Register this email on the operator auth page first"}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {status?.isOperator ? "Download" : "Continue"}
            </Button>
          </form>
          {validEmail && !registered && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Not a registered operator email yet — sign up with it on the operator auth page
              (email + strong password + emailed OTP) first.
            </p>
          )}
          <p className="text-[11px] leading-4 text-muted-foreground">
            The email is registered in the backend so it can also be used for sign up on the auth
            page — then it appears in the operator console's Sign-up emails (block / unblock /
            delete / change / update).
          </p>
        </div>

        {/* OR divider */}
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border/60" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            or
          </span>
          <span className="h-px flex-1 bg-border/60" />
        </div>

        {/* FIELD 2 — Continue as Guest — no activation password */}
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            <span className="mr-1 inline-flex items-center justify-center rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-extrabold text-primary">
              2
            </span>
            Continue as guest — no activation password
          </p>

          {guestStep === "idle" && (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => setGuestStep("passphrase")}
              >
                <UserX className="mr-2 size-4" />
                Continue as Guest
              </Button>
              <p className="text-[11px] leading-4 text-muted-foreground">
                A fresh code is emailed to the operator on every click — the code popup must be
                verified first, then the guest launcher (bound to no email, no activation password)
                is issued below.
              </p>
            </>
          )}

          {guestStep === "passphrase" && (
            <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Access passphrase
              </p>
              <div className="relative">
                <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  type="password"
                  value={guestPassphrase}
                  onChange={(e) => {
                    setGuestPassphrase(e.target.value);
                    setGuestPassphraseVerified(false);
                    setGuestPassphraseError(null);
                  }}
                  placeholder="Enter access passphrase"
                  className="pl-9"
                  disabled={guestPassphraseVerified}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !guestPassphraseVerified && guestPassphrase.trim()) {
                      e.preventDefault();
                      handleVerifyGuestPassphrase();
                    }
                  }}
                />
              </div>
              {!guestPassphraseVerified && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-xs"
                  disabled={guestPassphraseBusy || !guestPassphrase.trim()}
                  onClick={handleVerifyGuestPassphrase}
                >
                  {guestPassphraseBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                  )}
                  Verify passphrase
                </Button>
              )}
              {guestPassphraseVerified && (
                <p className="text-center text-[11px] text-emerald-500">
                  ✓ Passphrase verified — opening code popup…
                </p>
              )}
              {guestPassphraseError && (
                <p className="text-center text-[11px] text-red-500">{guestPassphraseError}</p>
              )}
              <Button
                type="button"
                variant="ghost"
                className="w-full text-xs"
                onClick={() => {
                  setGuestStep("idle");
                  setGuestPassphrase("");
                  setGuestPassphraseVerified(false);
                  setGuestPassphraseError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <p className="text-[11px] leading-4 text-muted-foreground">
          Generated per request · stored in the backend · visible in Desktop downloads.
        </p>
      </div>

      {/* Guest code popup — must be completed before the downloadable setups appear */}
      <Dialog
        open={guestOpen}
        onOpenChange={(open) => {
          if (!open && !guestBusy) setGuestOpen(false);
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
                ? "Your one-time guest passcode is displayed below. Enter it to unlock the downloadable setups."
                : "A fresh code was emailed to the operator's default address. Enter it below to unlock the downloadable setups."}
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

          <form onSubmit={submitGuestCode} className="space-y-4">
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
            {guestError && <p className="text-center text-sm text-red-500">{guestError}</p>}
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
                Verify & show downloads
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={guestBusy}
                onClick={resendGuestCode}
              >
                {popupDisplayedCode ? "Generate new code" : "Resend code"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={guestBusy}
                onClick={() => setGuestOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main Export                                                                */
/* -------------------------------------------------------------------------- */

export function DesktopAppsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const grant = getGrant();
  const isOperator = grant?.role === "operator";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-4 text-primary" />
            Desktop apps — {isOperator ? "operator" : "subscriber"}
          </DialogTitle>
          <DialogDescription>
            {isOperator
              ? "Pick your operating system, then choose one of the two fields below. No activation password is ever needed in this window — the launcher opens the app directly, exactly like the browser version: Landing page \u2192 Sign-in \u2192 Terminal."
              : "Download the setup for your operating system and activate it with the same email you used to subscribe + your activation password."}
          </DialogDescription>
        </DialogHeader>
        {isOperator ? <OperatorWindow /> : <SubscriberWindow />}
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0 text-primary" />
            Passwords are encrypted server-side; after activation the desktop app runs like the
            browser app step by step.
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
        <p className="text-center text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Powered by SHCS
        </p>
      </DialogContent>
    </Dialog>
  );
}
