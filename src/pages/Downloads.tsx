import { useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  Code,
  Download,
  ExternalLink,
  FileArchive,
  FileCode2,
  Loader2,
  LockKeyhole,
  Monitor,
  Puzzle,
  RefreshCw,
  Send,
  ShieldCheck,
  Terminal,
  Timer,
  UserRound,
  XCircle,
} from "lucide-react";
import { resolveConvexUrl } from "@/lib/convex-url";
import { useState } from "react";
import { Link } from "react-router";
import logo from "@/assets/logo.svg";
import { ShcsCredit } from "@/components/ShcsCredit";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { WhatsAppMessageButton } from "@/components/WhatsAppMessageButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import { getGrant } from "@/lib/gate";

/**
 * Public desktop downloads page — Linux / macOS / Windows setups with
 * activation. Anyone can reach it (the setups ship with the app releases on
 * GitHub); the activation password itself is generated, encrypted and emailed
 * ONLY to the terminal operator, who delivers it to subscribers. The email
 * entered here must be the same one used for subscribing on the first page —
 * the backend only recognizes registered subscriber emails for licenses.
 * The web form and the CLI hit the exact same server-side activation verdict.
 */

/**
 * Full-source archives served from this app's own origin (public/downloads/,
 * built by `bun run source:package`). Deliberately independent of GitHub —
 * the archive is the working tree, folder-wrapped, ready for `bun install`.
 */
const SOURCE_ARCHIVE_ZIP = "/downloads/flashbolt-source.zip";
const SOURCE_ARCHIVE_TAR = "/downloads/flashbolt-source.tar.gz";
/** Explicit saved filenames — versioned and self-describing in Downloads. */
const SOURCE_ARCHIVE_ZIP_NAME = `flashbolt-v${__APP_VERSION__}-source.zip`;
const SOURCE_ARCHIVE_TAR_NAME = `flashbolt-v${__APP_VERSION__}-source.tar.gz`;

const OS_CARDS = [
  {
    os: "linux",
    name: "Linux",
    tagline: "Debian / Ubuntu · x86_64 & arm64",
    href: "https://github.com/silk202/bnb-bot/releases",
    steps: [
      "Download the Linux setup package from the app releases.",
      "Run the setup and start the desktop app.",
      "Enter the email you subscribed with + the activation password you received.",
      "Once activated, the app stays licensed for re-use / re-run.",
    ],
    command:
      'curl -X POST "{CONVEX_URL}/activate" -H "Content-Type: application/json" -d \'{"email":"you@example.com","os":"linux","password":"FB-XXXX-XXXX-XXXX"}\'',
  },
  {
    os: "macos",
    name: "macOS",
    tagline: "Apple Silicon & Intel · .dmg",
    href: "https://github.com/silk202/bnb-bot/releases",
    steps: [
      "Download the macOS setup package from the app releases.",
      "Open the .dmg and drag the app into Applications.",
      "Launch it and enter your email + activation password when prompted.",
      "Once activated, the app stays licensed for re-use / re-run.",
    ],
    command:
      'curl -X POST "{CONVEX_URL}/activate" -H "Content-Type: application/json" -d \'{"email":"you@example.com","os":"macos","password":"FB-XXXX-XXXX-XXXX"}\'',
  },
  {
    os: "windows",
    name: "Windows",
    tagline: "Windows 10 / 11 · x64",
    href: "https://github.com/silk202/bnb-bot/releases",
    steps: [
      "Download the Windows setup package from the app releases.",
      "Open PowerShell and run the activation script (below), or run the installer and launch the app.",
      "Enter the email you subscribed with + the activation password you received.",
      "Once activated, the app runs from PowerShell and stays licensed for re-use / re-run.",
    ],
    command:
      '.\\flashbolt-windows.ps1 -Email "you@example.com" -Password "FB-XXXX-XXXX-XXXX" -AppUrl "{CONVEX_URL}"',
  },
];

function ActivationPanel({ os }: { os: string }) {
  const grant = getGrant();
  const [email, setEmail] = useState(grant?.role === "subscriber" ? grant.email : "");
  const status = useQuery(api.licenses.licenseStatus, { email: email.trim().toLowerCase(), os });
  const activate = useMutation(api.licenses.activateLicense);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    activationCount?: number;
  } | null>(null);

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
      setResult({
        ok: res.ok,
        message: res.message,
        activationCount: res.activationCount,
      });
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
    <div className="mt-4 space-y-3">
      <div className="space-y-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setResult(null);
          }}
          placeholder="Email you subscribed with"
          className="h-9 font-mono text-xs"
          disabled={busy}
        />
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Activation password (from your email)"
            className="h-9 font-mono text-xs"
            disabled={busy}
          />
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || !validEmail || !password.trim()}
            className="shrink-0 gap-1.5"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Activate
          </Button>
        </div>
      </div>
      {validEmail && status?.exists && (
        <p className="text-[11px] text-muted-foreground">
          License status for {email.trim()}:{" "}
          <span
            className={
              status.status === "blocked"
                ? "font-semibold text-red-500"
                : status.status === "expired"
                  ? "font-semibold text-amber-500"
                  : "font-semibold text-emerald-500"
            }
          >
            {status.status === "blocked"
              ? "Blocked by the operator"
              : status.status === "expired"
                ? "Expired — ask the operator for a fresh password"
                : "Active"}
          </span>
        </p>
      )}
      {validEmail && status?.exists === false && (
        <p className="text-[11px] text-muted-foreground">
          No activation license has been issued for this email + operating system yet — ask the
          operator to generate one for your subscriber email.
        </p>
      )}
      {result && (
        <p
          className={`flex items-start gap-1.5 text-xs ${
            result.ok ? "text-emerald-500" : "text-red-500"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>
            {result.message}
            {result.ok && typeof result.activationCount === "number" && (
              <span className="text-muted-foreground">
                {" "}
                (activation #{result.activationCount})
              </span>
            )}
          </span>
        </p>
      )}
      {result?.ok && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          <span>
            After activation the desktop app runs exactly like the browser app, step by step:
            first page (landing) → auth page → terminal — with the same Telegram alerts and
            operator emails tied to your subscriber account.
          </span>
        </p>
      )}
    </div>
  );
}

const DOWNLOAD_GATE_KEY = "flashbolt.download.gate";

function isDownloadGateValid(): boolean {
  try {
    const raw = window.localStorage.getItem(DOWNLOAD_GATE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as { verified: boolean; ts: number };
    if (!data.verified) return false;
    // Gate expires after 24 hours
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) {
      window.localStorage.removeItem(DOWNLOAD_GATE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function DownloadGate({ children }: { children: React.ReactNode }) {
  const [verified, setVerified] = useState(() => isDownloadGateValid());
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verifyGuestPassphrase = useMutation(api.gate.verifyGuestPassphrase);

  if (verified) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await verifyGuestPassphrase({ passphrase: passphrase.trim() });
      window.localStorage.setItem(
        DOWNLOAD_GATE_KEY,
        JSON.stringify({ verified: true, ts: Date.now() }),
      );
      setVerified(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid passphrase.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center gap-2">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="FlashBolt" width={48} height={48} className="rounded-full" />
            <span className="text-xl font-extrabold tracking-tight">
              Flash<span className="text-primary">Bolt</span>
            </span>
          </Link>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Desktop downloads — passphrase required
          </p>
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-lg">Access Downloads</CardTitle>
            <CardDescription>
              Enter the operator passphrase to access the desktop downloads page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="dl-passphrase">Passphrase</Label>
                <Input
                  id="dl-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    setError(null);
                  }}
                  placeholder="••••••••••••••••"
                  className="font-mono"
                  disabled={busy}
                  autoFocus
                  required
                />
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy || !passphrase.trim()}>
                {busy ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-2 size-4" />
                )}
                Unlock Downloads
              </Button>
            </form>
          </CardContent>
        </Card>
        <div className="flex justify-center">
          <Link
            to="/"
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to Gate
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function Downloads() {
  const grant = getGrant();
  const convexUrl =
    resolveConvexUrl(import.meta.env.VITE_CONVEX_URL) ?? "https://<your-deployment>.convex.cloud";

  return (
    <DownloadGate>
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-4 py-3.5 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="FlashBolt" width={28} height={28} className="rounded-full" />
            <span className="text-sm font-bold tracking-tight">
              Flash<span className="text-primary">Bolt</span>
              <span className="ml-2 hidden text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground sm:inline">
                Desktop downloads
              </span>
            </span>
          </Link>
          <span className="ml-auto flex items-center gap-2">
            <Link
              to="/"
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Gate
            </Link>
            <WhatsAppChannelButton />
            <ThemeToggle />
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Hero */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Desktop app · Linux / macOS / Windows
          </p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-4xl">
            Download the setup, activate it, run it
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Each operating system has its own encrypted activation password for your subscriber
            email, generated in the backend and delivered to the operator's email. Enter the same
            email you used to subscribe + your password below (or via the CLI / PowerShell) and the
            app stays licensed for re-use / re-run — no subscription, no re-activation.
          </p>
          <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            v{__APP_VERSION__} · userscript + Chrome/Edge/Brave MV3 + Firefox MV2 overlay included
          </p>
        </div>

        {/* OS cards */}
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {OS_CARDS.map((card) => (
            <div
              key={card.os}
              className="flex flex-col rounded-2xl border border-border/70 bg-card/40 p-5 backdrop-blur-sm transition-colors hover:border-primary/40"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Monitor className="size-5" />
                </span>
                <div>
                  <div className="text-sm font-bold">{card.name}</div>
                  <div className="text-[11px] text-muted-foreground">{card.tagline}</div>
                </div>
              </div>
              <ol className="mt-4 space-y-2">
                {card.steps.map((step, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-5 text-muted-foreground">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-4 rounded-lg border border-border/60 bg-background/70 p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                  <Terminal className="size-3.5" />
                  {card.os === "windows" ? "CLI activation (PowerShell)" : "CLI activation"}
                </div>
                <code className="mt-2 block overflow-x-auto whitespace-pre text-[10px] leading-4 text-foreground/80">
                  {card.command.replace("{CONVEX_URL}", convexUrl)}
                </code>
              </div>
              <a
                href={card.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2.5 text-xs font-semibold transition-colors hover:bg-primary/20"
              >
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <Download className="size-4 shrink-0" />
                  Download {card.name} setup
                </span>
                <ExternalLink className="size-3.5 shrink-0 opacity-70" />
              </a>
              <div className="mt-4 border-t border-border/50 pt-4">
                <ActivationPanel os={card.os} />
              </div>
            </div>
          ))}
        </div>

        {/* Scanner Overlay — userscript + cross-browser extension downloads.
            Both flavors are generated from the same engine the Sniper's
            "Scanner Overlay" panel stamps with live settings; the repo files
            below always build the artifacts with `bun run overlay`. */}
        <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-border/70 bg-card/40 p-5 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Puzzle className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold">DEXView / GMGN / Ave Scanner Overlay</h2>
              <p className="text-xs text-muted-foreground">
                Runs on DEXView, GMGN and Ave.ai. Two install paths — pick either. The userscript runs in every browser via Tampermonkey;
                the extension gives one-click installs for Chrome/Edge/Brave (MV3) and Firefox (MV2).
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <a
              href="/overlay/flashbolt-sniper-overlay.user.js"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileCode2 className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Userscript (.user.js)</div>
                <div className="text-[11px] text-muted-foreground">Tampermonkey / Violentmonkey — all browsers</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </a>
            <a
              href="/overlay/chrome-flashbolt-overlay.zip"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileArchive className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Chrome / Edge / Brave (MV3)</div>
                <div className="text-[11px] text-muted-foreground">chrome-flashbolt-overlay.zip</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </a>
            <a
              href="/overlay/firefox-flashbolt-overlay.zip"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileArchive className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Firefox (MV2)</div>
                <div className="text-[11px] text-muted-foreground">firefox-flashbolt-overlay.zip</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </a>
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3">
              <Terminal className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Build locally (CLI)</div>
                <div className="text-[11px] text-muted-foreground">bun run overlay → public/overlay/</div>
              </div>
            </div>
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <RefreshCw className="mt-0.5 size-3 shrink-0 text-primary" />
            <span>
              Serving your own deployment? Rebuild the artifacts with <code className="font-mono">bun run overlay</code> so
              the daily-target gate endpoint (your Convex <code className="font-mono">.convex.site</code> origin) and the
              current chain registry are stamped in — set <code className="font-mono">VITE_CONVEX_URL</code> in the
              environment before building.
            </span>
          </p>
          <p className="mt-3 text-[11px] text-muted-foreground">
            After installing, open <code className="font-mono">dexview.com</code>, <code className="font-mono">gmgn.ai</code> or <code className="font-mono">ave.ai</code> — the floating FlashBolt
            panel injects with a BOT ON/OFF toggle, site-chain auto-sync (BNB Smart Chain, Ethereum, Arbitrum One, Polygon), instant page-layer capture, wallet connect, buyable + sellable token capture, simulated (zero-gas-on-fail) auto buy/sell and automatic payout.
            Prefer stamped live settings? Use the <span className="font-semibold text-foreground">Sniper → Scanner Overlay</span> panel inside the
            terminal, which exports the same artifacts with your current parameters.
          </p>
        </div>

        {/* SOL FlashBolt overlay — per-user generated (token + settings stamped at export),
            so instead of static files we point to the SOL terminal's overlay panel. */}
        <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-border/70 bg-card/40 p-5 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Puzzle className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold">SOL FlashBolt — Solana Sniper Overlay</h2>
              <p className="text-xs text-muted-foreground">
                The Solana twin: runs on the Solana pages of DEXView, GMGN and Ave.ai (plus DexScreener /solana)
                with sub-millisecond token capture, simulateTransaction zero-gas gating, Jito-style protected
                submission, auto-sell and auto payout.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              to="/sol-terminal/scanner"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileCode2 className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Generate your SOL overlay</div>
                <div className="text-[11px] text-muted-foreground">SOL FlashBolt → Scanner → Overlay panel</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </Link>
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3">
              <ShieldCheck className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">Userscript + MV3 + MV2 zips</div>
                <div className="text-[11px] text-muted-foreground">Generated per-user — your access token & live settings are stamped at export</div>
              </div>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Sign in and open the SOL Scanner&apos;s <span className="font-semibold text-foreground">Scanner Overlay</span> panel to download
            <code className="mx-1 font-mono">flashbolt-sol-sniper-overlay.user.js</code> or the Chrome/Firefox extension zips — each build carries
            the same server-enforced daily-target gate as the terminal.
          </p>
        </div>

        {/* Source code download — visible only to operator and guest, hidden from subscribers */}
        {grant?.role !== "subscriber" && (
        <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-border/70 bg-card/40 p-5 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Code className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold">Source code</h2>
              <p className="text-xs text-muted-foreground">
                Download the full FlashBolt source code to run locally or deploy your own instance.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <a
              href={SOURCE_ARCHIVE_ZIP}
              download={SOURCE_ARCHIVE_ZIP_NAME}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileArchive className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">ZIP archive</div>
                <div className="text-[11px] text-muted-foreground">flashbolt-source.zip</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </a>
            <a
              href={SOURCE_ARCHIVE_TAR}
              download={SOURCE_ARCHIVE_TAR_NAME}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <FileArchive className="size-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">TAR.GZ archive</div>
                <div className="text-[11px] text-muted-foreground">flashbolt-source.tar.gz</div>
              </div>
              <Download className="ml-auto size-3.5 text-muted-foreground" />
            </a>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            After download, run <code className="font-mono">bun run setup</code> to install dependencies
            and provision a Convex backend. See <code className="font-mono">DEPLOYMENT.md</code> for
            full deployment instructions (Vercel, Netlify, Render, Cloudflare).
          </p>
        </div>
        )}

        {/* Operator inbox — WhatsApp is the second default channel for sending
            pass codes / activation-password requests, besides email. The
            button appears only when the operator configured their number. */}
        <div className="mt-10 flex justify-center">
          <WhatsAppMessageButton
            prefill="Hi FlashBolt — I'm a subscriber. I need my desktop activation password / passcode."
          />
        </div>

        {/* PowerShell note for Windows */}
        <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-border/70 bg-card/40 p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Terminal className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold">Running the Windows desktop app from PowerShell</h2>
              <p className="text-xs text-muted-foreground">
                The Windows setup runs and stays licensed through a real PowerShell script shipped
                with the release (<code className="font-mono">scripts/flashbolt-windows.ps1</code>).
                It calls the same activation endpoint as the web form and then launches the desktop
                app, which opens the browser-style flow: first page (landing) → auth page →
                terminal.
              </p>
            </div>
          </div>
          <code className="mt-3 block overflow-x-auto whitespace-pre rounded-lg border border-border/60 bg-background/70 p-3 font-mono text-[10px] leading-4 text-foreground/80">
            {`Set-ExecutionPolicy -Scope Process Bypass
.\\flashbolt-windows.ps1 -Email "you@example.com" -Password "FB-XXXX-XXXX-XXXX" -AppUrl "${convexUrl}"`}
          </code>
          <p className="mt-2 text-[11px] text-muted-foreground">
            On success the script prints the server verdict and launches the app; on failure it
            prints the exact reason (blocked, expired, invalid password or no license for that
            email + OS). Nothing is simulated — the same backend verdict powers the web form, curl
            and PowerShell.
          </p>
        </div>

        {/* Policy strip */}
        <div className="mx-auto mt-10 grid max-w-3xl gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div className="flex items-start gap-2 rounded-xl border border-border/60 p-3">
            <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              Passwords are AES-256 encrypted in the backend and never shown in any interface —
              they reach you only through the operator's email.
            </span>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-border/60 p-3">
            <Timer className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              A brand-new password expires after 72 hours if the app is never activated with it. One
              activation makes it permanently active.
            </span>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-border/60 p-3">
            <UserRound className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              Only the email used for subscribing on the first page is recognized for activation —
              the backend issues licenses to registered subscriber emails only.
            </span>
          </div>
        </div>
      </main>

      <footer className="border-t border-border/60 px-5 py-3">
        <ShcsCredit />
      </footer>
    </div>
    </DownloadGate>
  );
}
