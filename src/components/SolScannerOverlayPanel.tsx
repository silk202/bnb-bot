/**
 * SOL Scanner Overlay panel — install generator for the SOL FlashBolt's
 * DEXView/GMGN/Ave overlay (Solana twin of ScannerOverlayPanel).
 *
 * Produces the self-contained userscript (Tampermonkey) and the MV3/MV2
 * extension zips from buildSolOverlayUserscript / buildSolExtensionBundle,
 * stamped with the terminal's live SOL sniper settings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildSolExtensionBundle, buildSolOverlayUserscript, type SolOverlayConfig } from "@/lib/sol-overlay-script";
import { Input } from "@/components/ui/input";
import { buildZip } from "@/lib/zip";
import { resolveConvexUrl } from "@/lib/convex-url";
import { Check, Copy, Download, FileCode2, Globe, Puzzle, Target } from "lucide-react";
import { toast } from "sonner";

export interface SolScannerOverlaySettings {
  /** Buy amount in SOL. */
  buyAmountSol: number;
  /** Sell slippage tolerance percent. */
  slippagePct: number;
  /** Auto-sell profit target percent. */
  profitTargetPct: number;
  /** Trailing stop percent. */
  trailingStopPct: number;
  /** Minimum liquidity (USD) a candidate must clear. */
  minLiquidityUsd: number;
  /** SELL AMOUNT: percent of the sell slice each exit disposes of (1-100). */
  sellAmountPct: number;
  /** Sell percent (position share each sell event disposes of). */
  sellPct: number;
  /** Max snipes per day (0 = unlimited). */
  dailySnipeLimit: number;
  /** Auto payout to the connected wallet by default. */
  autoPayout: boolean;
  /** Jito-style protected submission (default ON). */
  jitoSubmit: boolean;
}

export type SolScannerOverlaySettingsPatch = Partial<SolScannerOverlaySettings>;

/** Numeric field descriptors driving the adjustable dashboard grid. */
const ADJUSTABLE_FIELDS: Array<{
  key: keyof SolScannerOverlaySettings;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  parse?: (v: number) => number;
}> = [
  { key: "buyAmountSol", label: "Buy amount", min: 0.01, max: 100, step: 0.1, fmt: (v) => `${v} SOL` },
  { key: "sellAmountPct", label: "SELL AMOUNT", min: 1, max: 100, step: 1, fmt: (v) => `${v}% of sell slice` },
  { key: "slippagePct", label: "Slippage", min: 0.1, max: 50, step: 0.1, fmt: (v) => `${v}%` },
  { key: "profitTargetPct", label: "Profit target", min: 1, max: 500, step: 1, fmt: (v) => `+${v}%` },
  { key: "trailingStopPct", label: "Trailing stop", min: 0.5, max: 99, step: 0.5, fmt: (v) => `-${v}%` },
  { key: "minLiquidityUsd", label: "Min liquidity", min: 0, max: 1_000_000, step: 500, fmt: (v) => `$${v.toLocaleString()}` },
];
const SNIPES_PER_DAY_PRESETS = [1, 2, 3, 5, 10, 25, 50];

type InstallTab = "userscript" | "extension";

function downloadBlob(data: Uint8Array | string, filename: string, mime: string) {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: `${mime};charset=utf-8` })
      : new Blob([data.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SolScannerOverlayPanel({
  settings,
  onSettingsChange,
}: {
  settings: SolScannerOverlaySettings;
  /** Live edits from the overlay dashboard — the terminal persists them and
   * both /settings and the next stamped install reflect them instantly. */
  onSettingsChange?: (patch: SolScannerOverlaySettingsPatch) => void;
}) {
  const [tab, setTab] = useState<InstallTab>("userscript");
  const [copied, setCopied] = useState<string | null>(null);
  const [utcNow, setUtcNow] = useState(() => new Date());
  const autoCopiedRef = useRef(false);

  // Live daily-target status for the signed-in account (server truth).
  const myLimit = useQuery(api.terminal.myExecutionLimit);

  // Mint the per-subscriber overlay execution token ONCE per signed-in
  // session (same get-or-create value the BNB overlay uses). The operator's
  // account receives an error and stays token-less → its overlay exports
  // are unlimited, matching the terminal's policy for operators.
  const issueOverlayToken = useMutation(api.terminal.issueOverlayToken);
  const [overlayToken, setOverlayToken] = useState("");
  useEffect(() => {
    let cancelled = false;
    issueOverlayToken()
      .then((r: { token: string }) => {
        if (!cancelled && r?.token) setOverlayToken(r.token);
      })
      .catch(() => {
        /* operator / non-subscriber — export proceeds without a token */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Adjust one numeric field through the shared terminal settings. */
  const adjust = (key: keyof SolScannerOverlaySettings, value: number) => {
    if (!onSettingsChange) return;
    onSettingsChange({ [key]: value } as SolScannerOverlaySettingsPatch);
  };

  const overlayConfig: SolOverlayConfig = useMemo(
    () => ({
      appOrigin: typeof window !== "undefined" ? window.location.origin : "https://localhost",
      // Convex HTTP origin — the .convex.site domain that actually serves
      // /api/overlay/execution (daily-target gate) and /api/copier/signals.
      httpOrigin: (() => {
        const base = resolveConvexUrl(import.meta.env.VITE_CONVEX_URL);
        if (!base) return undefined;
        const clean = base.endsWith("/") ? base.slice(0, -1) : base;
        return clean.replace(/\.convex\.cloud$/, ".convex.site");
      })(),
      stamped: {
        buyAmountSol: settings.buyAmountSol,
        sellPct: settings.sellPct,
        sellAmountPct: settings.sellAmountPct,
        slippagePct: settings.slippagePct,
        profitTargetPct: settings.profitTargetPct,
        trailingStopPct: settings.trailingStopPct,
        minLiquidityUsd: settings.minLiquidityUsd,
        dailySnipeLimit: settings.dailySnipeLimit,
        autoPayout: settings.autoPayout,
        jitoSubmit: settings.jitoSubmit,
        // Server-enforced daily-target identity (subscribers only; empty for
        // operator/private installs which stay unlimited).
        overlayToken,
      },
    }),
    [settings, overlayToken],
  );

  const userscript = useMemo(() => buildSolOverlayUserscript(overlayConfig), [overlayConfig]);
  const bundle = useMemo(() => buildSolExtensionBundle(overlayConfig), [overlayConfig]);
  const chromeZip = useMemo(() => buildZip(bundle.chromeEntries), [bundle.chromeEntries]);
  const firefoxZip = useMemo(() => buildZip(bundle.firefoxEntries), [bundle.firefoxEntries]);

  // Auto-copy the userscript the first time the panel opens.
  useEffect(() => {
    if (autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    void navigator.clipboard
      .writeText(userscript)
      .then(() => {
        setCopied("userscript");
        toast.success("SOL userscript auto-copied — paste into Tampermonkey");
      })
      .catch(() => {
        /* clipboard denied — user can click Copy */
      });
  }, [userscript]);

  // UTC world clock — mirrors the overlay's own clock.
  useEffect(() => {
    const id = window.setInterval(() => setUtcNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const copy = async (text: string, which: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success(message);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Clipboard blocked — use the Download buttons instead");
    }
  };

  const utcLabel = `${utcNow.toISOString().slice(0, 10)} · ${utcNow.toISOString().slice(11, 19)} UTC`;

  return (
    <Card className="border-emerald-500/25 bg-emerald-500/5">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="size-5 text-emerald-400" />
            <CardTitle className="text-sm font-bold text-emerald-400">
              DEXView / GMGN / Ave Scanner Overlay — Solana
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="border-emerald-500/30 bg-emerald-500/10 font-mono text-emerald-400">{utcLabel}</Badge>
            <Badge className="border-border/60 bg-background/60 gap-1 font-mono">
              <Target className="size-3" />
              {myLimit === undefined
                ? "Daily target …"
                : (myLimit as { unlimited?: boolean }).unlimited ||
                  (myLimit as { operator?: boolean }).operator ||
                  (myLimit as { guest?: boolean }).guest
                  ? "Daily target: unlimited"
                  : ((myLimit as { limit?: number | null }).limit ?? 0) === 0
                    ? "Daily target: BLOCKED"
                    : `Daily target: ${(myLimit as { used?: number }).used ?? 0}/${(myLimit as { limit?: number | null }).limit ?? 0}`}
            </Badge>
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">LIVE</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Floating Solana overlay that runs the full FlashBolt sniper engine{" "}
          <span className="font-semibold text-foreground">inside DEXView, GMGN, Ave.ai and DexScreener /solana</span>{" "}
          pages: ON/OFF bot toggle, site→chain auto-sync on Solana, sub-millisecond page-layer capture (MutationObserver +
          fast poll), live discovery from DexScreener + GeckoTerminal new pools, the shared Telegram copier feed,
          Phantom/Solflare/Backpack connect, real{" "}
          <span className="font-mono text-[11px]">simulateTransaction</span> zero-gas gate before every broadcast,
          Jito-style protected submission (≥ 1,000-lamport tip), auto-sell with trailing stop and automatic payout.
        </p>

        {/* Adjustable dashboard — every stamped param is live-editable here;
            edits persist through the terminal settings and /settings on the
            SOL sniper reflects them instantly (and vice versa). */}
        <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">Overlay dashboard — adjustable</div>
            <Badge variant="outline" className="text-[10px]">synced with /settings</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ADJUSTABLE_FIELDS.map((f) => {
              const value = settings[f.key] as number;
              return (
                <label key={f.key} className="rounded-lg border border-border/60 bg-background/40 p-2">
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">{f.label}</span>
                  <Input
                    value={String(value)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) adjust(f.key, Math.max(f.min, Math.min(f.max, n)));
                    }}
                    className="mt-1 h-7 text-xs font-mono"
                    inputMode="decimal"
                  />
                  <span className="mt-0.5 block text-[10px] font-semibold text-emerald-300">{f.fmt(value)}</span>
                </label>
              );
            })}
            {/* Snipes/day — presets + ∞ like /settings */}
            <div className="rounded-lg border border-border/60 bg-background/40 p-2 sm:col-span-2">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Snipes/day</span>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {SNIPES_PER_DAY_PRESETS.map((n) => (
                  <Button
                    key={n}
                    variant={settings.dailySnipeLimit === n ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => adjust("dailySnipeLimit", n)}
                  >
                    {n}
                  </Button>
                ))}
                <Button
                  variant={settings.dailySnipeLimit === 0 ? "default" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => adjust("dailySnipeLimit", 0)}
                >
                  ∞
                </Button>
                <Input
                  value={settings.dailySnipeLimit === 0 || SNIPES_PER_DAY_PRESETS.includes(settings.dailySnipeLimit) ? "" : String(settings.dailySnipeLimit)}
                  onChange={(e) => {
                    const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    adjust("dailySnipeLimit", n);
                  }}
                  className="h-6 w-16 text-[11px]"
                  placeholder="X"
                  inputMode="numeric"
                />
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Chain Solana (SOL) · Submission {settings.jitoSubmit ? "Jito protected" : "Public RPC"} · Wallets Phantom /
            Solflare / Backpack · Sites DEXView / GMGN / Ave · Bot ON/OFF in panel. Re-copy the userscript after edits —
            the new values are stamped into the generated script.
          </p>
        </div>

        {/* Install tabs */}
        <div className="flex gap-1 rounded-lg border border-border/60 bg-background/60 p-1">
          {(
            [
              { id: "userscript" as const, label: "Userscript (all browsers)", icon: <FileCode2 className="size-3.5" /> },
              { id: "extension" as const, label: "Browser extension", icon: <Puzzle className="size-3.5" /> },
            ]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors " +
                (tab === t.id ? "bg-emerald-500/15 text-emerald-300" : "text-muted-foreground hover:text-foreground")
              }
            >
              {t.icon}
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>

        {tab === "userscript" && (
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                Userscript — Tampermonkey / Violentmonkey / Greasemonkey
              </div>
              <Badge variant="outline" className="text-[10px]">{(userscript.length / 1024).toFixed(1)} KB</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="gap-2" onClick={() => void copy(userscript, "userscript", "SOL userscript copied — paste into Tampermonkey")}>
                {copied === "userscript" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied === "userscript" ? "Copied" : "Copy userscript"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  downloadBlob(userscript, "flashbolt-sol-sniper-overlay.user.js", "text/javascript");
                  toast.success("flashbolt-sol-sniper-overlay.user.js downloading");
                }}
              >
                <Download className="size-3.5" />
                Download .user.js
              </Button>
            </div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
              <li>Install Tampermonkey (Chrome / Edge / Firefox / Safari via Userscripts) — desktop and Android.</li>
              <li>
                Click <span className="font-semibold text-foreground">Copy userscript</span> (auto-copied when this panel
                opened) → Tampermonkey → <span className="font-mono">Create a new script</span> → paste over everything →{" "}
                <span className="font-mono">Ctrl+S</span>.
              </li>
              <li>
                Open the Solana pages of <span className="font-mono">dexview.com</span>,{" "}
                <span className="font-mono">gmgn.ai</span> or <span className="font-mono">ave.ai</span> — the FlashBolt SOL
                overlay appears top-right with the BOT ON/OFF toggle.
              </li>
            </ol>
          </div>
        )}

        {tab === "extension" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {/* Chrome family */}
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs font-bold text-emerald-400">Chrome / Edge / Brave / Opera</div>
                  <Badge variant="outline" className="text-[10px]">MV3</Badge>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">One-click zip, then Load unpacked.</p>
                <Button
                  size="sm"
                  className="w-full gap-2"
                  onClick={() => {
                    downloadBlob(chromeZip, "chrome-flashbolt-sol-overlay.zip", "application/zip");
                    toast.success("chrome-flashbolt-sol-overlay.zip downloading");
                  }}
                >
                  <Download className="size-3.5" />
                  Download Chrome zip ({(chromeZip.length / 1024).toFixed(1)} KB)
                </Button>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>Unzip the download into a folder.</li>
                  <li>
                    Open <span className="font-mono">chrome://extensions</span> → enable Developer mode →{" "}
                    <span className="font-mono">Load unpacked</span> → select the folder.
                  </li>
                </ol>
              </div>

              {/* Firefox */}
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs font-bold text-emerald-400">Firefox</div>
                  <Badge variant="outline" className="text-[10px]">MV2 (Gecko)</Badge>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">Same engine, Gecko manifest + content script.</p>
                <Button
                  size="sm"
                  className="w-full gap-2"
                  onClick={() => {
                    downloadBlob(firefoxZip, "firefox-flashbolt-sol-overlay.zip", "application/zip");
                    toast.success("firefox-flashbolt-sol-overlay.zip downloading");
                  }}
                >
                  <Download className="size-3.5" />
                  Download Firefox zip ({(firefoxZip.length / 1024).toFixed(1)} KB)
                </Button>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>Unzip the download into a folder.</li>
                  <li>
                    Open <span className="font-mono">about:debugging#/runtime/this-firefox</span> →{" "}
                    <span className="font-mono">Load Temporary Add-on</span> → select manifest.json.
                  </li>
                  <li>For a permanent install, sign the folder on addons.mozilla.org (web-ext build) — the README in the zip has the steps.</li>
                </ol>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-2" onClick={() => void copy(bundle.chromeManifest, "manifest", "Chrome manifest.json copied")}>
                {copied === "manifest" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Copy Chrome manifest
              </Button>
              <Button size="sm" variant="outline" className="gap-2" onClick={() => void copy(bundle.firefoxManifest, "ffmanifest", "Firefox manifest.json copied")}>
                {copied === "ffmanifest" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Copy Firefox manifest
              </Button>
              <Button size="sm" variant="outline" className="gap-2" onClick={() => void copy(bundle.overlayJs, "js", "overlay.js copied")}>
                {copied === "js" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Copy overlay.js
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Inside the overlay (both flavors): flip the BOT ON/OFF toggle, connect Phantom / Solflare / Backpack → it
              uses the stamped settings above (including SELL AMOUNT % and the daily snipe limit), captures brand-new
              Solana tokens instantly from the page layer plus DexScreener/GeckoTerminal, filters to buyable + sellable
              only, dry-runs every buy and sell with a real{" "}
              <span className="font-mono text-[11px]">simulateTransaction</span> before broadcasting (zero gas on
              failure), submits through the Jito block-engine path, auto-sells on profit target or trailing stop, and
              pays out automatically.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
