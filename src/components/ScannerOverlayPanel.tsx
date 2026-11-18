import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildExtensionBundle, buildOverlayUserscript } from "@/lib/overlay-script";
import { buildZip } from "@/lib/zip";
import { CHAIN_INFO, type ChainKey } from "@/lib/chains";
import { resolveConvexUrl } from "@/lib/convex-url";
import { Check, Copy, Download, FileCode2, Globe, Puzzle, Target } from "lucide-react";
import { toast } from "sonner";

export interface ScannerOverlaySettings {
  /** Chain the overlay defaults to (operator's selected sniper chain). */
  chainKey: ChainKey;
  /** Buy amount in the chain's native token. */
  buyAmountNative: number;
  /** Sell slippage tolerance percent. */
  slippagePct: number;
  /** Auto-sell profit target percent. */
  profitTargetPct: number;
  /** Trailing stop percent. */
  trailingStopPct: number;
  /** Max gas price (gwei) the overlay will pay. */
  maxGasPriceGwei: number;
  /** Minimum liquidity (USD) a candidate must clear. */
  minLiquidityUsd: number;
  /** SELL AMOUNT: percent of the sell slice each exit disposes of (1-100). */
  sellAmountPct: number;
  /** Sell percent (position share each sell event disposes of). */
  sellPct: number;
  /** Auto payout mode: connected wallet (default) or optional external. */
  payoutMode: "connected" | "external";
  /** External payout address when payoutMode is "external". */
  payoutAddress: string;
  /** Operator's private RPC override for the selected chain, if set. */
  rpcOverride?: string;
}

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

export function ScannerOverlayPanel({ settings }: { settings: ScannerOverlaySettings }) {
  const [tab, setTab] = useState<InstallTab>("userscript");
  const [copied, setCopied] = useState<string | null>(null);
  const [utcNow, setUtcNow] = useState(() => new Date());
  const autoCopiedRef = useRef(false);

  // Live daily-target status for the signed-in account (server truth).
  const myLimit = useQuery(api.terminal.myExecutionLimit, {});

  // Mint the per-subscriber overlay execution token ONCE per signed-in
  // session. Subscribers get a gated token; the operator's account receives
  // an error and stays token-less (the overlay is then unlimited, exactly
  // like the terminal). The token is stamped into every exported artifact.
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

  const chains = useMemo(
    () =>
      Object.values(CHAIN_INFO).map((c) => ({
        key: c.key,
        chainId: c.chainId,
        label: c.label,
        router: c.router,
        wrapped: c.quoteAddress,
        nativeSymbol: c.nativeSymbol,
        rpc: c.key === settings.chainKey && settings.rpcOverride ? settings.rpcOverride : c.rpc,
      })),
    [settings.chainKey, settings.rpcOverride],
  );

  const overlayConfig = useMemo(
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
      chains,
      stamped: {
        chainKey: settings.chainKey,
        buyAmountNative: settings.buyAmountNative,
        sellPct: settings.sellPct,
        sellAmountPct: settings.sellAmountPct,
        slippagePct: settings.slippagePct,
        profitTargetPct: settings.profitTargetPct,
        trailingStopPct: settings.trailingStopPct,
        maxGasPriceGwei: settings.maxGasPriceGwei,
        minLiquidityUsd: settings.minLiquidityUsd,
        autoPayout: true,
        payoutAddress: settings.payoutMode === "external" ? settings.payoutAddress : "",
        // Server-enforced daily-target identity (subscribers only; empty for
        // operator/private installs which stay unlimited).
        overlayToken,
      },
    }),
    [chains, settings, overlayToken],
  );

  const userscript = useMemo(() => buildOverlayUserscript(overlayConfig), [overlayConfig]);
  const bundle = useMemo(() => buildExtensionBundle(overlayConfig), [overlayConfig]);

  const chromeZip = useMemo(
    () => buildZip(bundle.chromeEntries),
    [bundle.chromeEntries],
  );
  const firefoxZip = useMemo(
    () => buildZip(bundle.firefoxEntries),
    [bundle.firefoxEntries],
  );

  // Auto-copy the userscript the first time the panel opens (the "auto-copy"
  // part of copy/auto-copy). Clipboard permission may be denied — the manual
  // buttons below always remain available.
  useEffect(() => {
    if (autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    void navigator.clipboard
      .writeText(userscript)
      .then(() => {
        setCopied("userscript");
        toast.success("Userscript auto-copied — paste into Tampermonkey");
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
            <CardTitle className="text-sm font-bold text-emerald-400">DEXView / GMGN / Ave Scanner Overlay</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="border-emerald-500/30 bg-emerald-500/10 font-mono text-emerald-400">{utcLabel}</Badge>
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">LIVE</Badge>
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
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Floating overlay that runs the full sniper engine{" "}
          <span className="font-semibold text-foreground">inside DEXView, GMGN, Ave.ai and DexScreener</span>: ON/OFF bot toggle, automatic site→chain sync (the overlay
          follows the chain page you browse on each site — BNB Smart Chain (BNB), Ethereum (ETH), Arbitrum One (ETH), Polygon (POL)), instant sub-millisecond page-layer capture, multi-source brand-new-token discovery from the
          same sources as the multi-signal monitor (buyable AND sellable tokens only), direct wallet connect, real router buy/sell gated by full
          eth_call simulation, auto-sell with trailing stop, and automatic payout. Pick one of the two install paths below — the userscript works in
          every desktop browser via Tampermonkey; the extension adds one-click installs for Chrome/Edge/Brave and Firefox.
        </p>

        {/* Stamped settings — exactly what the generated overlay will use */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { k: "Default chain", v: CHAIN_INFO[settings.chainKey].label },
            { k: "Buy amount", v: `${settings.buyAmountNative} ${CHAIN_INFO[settings.chainKey].nativeSymbol}` },
            { k: "SELL AMOUNT", v: `${settings.sellAmountPct}% of sell slice` },
            { k: "Slippage", v: `${settings.slippagePct}%` },
            { k: "Profit target", v: `+${settings.profitTargetPct}%` },
            { k: "Trailing stop", v: `-${settings.trailingStopPct}%` },
            { k: "Max gas", v: `${settings.maxGasPriceGwei} gwei` },
            { k: "Min liquidity", v: `$${settings.minLiquidityUsd}` },
            {
              k: "Payout",
              v:
                settings.payoutMode === "external" && settings.payoutAddress
                  ? `External · ${settings.payoutAddress.slice(0, 6)}…${settings.payoutAddress.slice(-4)}`
                  : "Connected wallet",
            },
            { k: "Sites", v: "DEXView / GMGN / Ave" },
            { k: "Site-chain sync", v: "Auto (BSC/ETH/Arbitrum One/POL)" },
            { k: "Bot toggle", v: "ON/OFF in panel" },
          ].map((row) => (
            <div key={row.k} className="rounded-lg border border-border/60 bg-background/40 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.k}</div>
              <div className="mt-0.5 truncate text-xs font-semibold text-emerald-300">{row.v}</div>
            </div>
          ))}
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
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">Userscript — Tampermonkey / Violentmonkey / Greasemonkey</div>
              <Badge variant="outline" className="text-[10px]">{(userscript.length / 1024).toFixed(1)} KB</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="gap-2" onClick={() => void copy(userscript, "userscript", "Userscript copied — paste into Tampermonkey")}>
                {copied === "userscript" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied === "userscript" ? "Copied" : "Copy userscript"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  downloadBlob(userscript, "flashbolt-sniper-overlay.user.js", "text/javascript");
                  toast.success("flashbolt-sniper-overlay.user.js downloading");
                }}
              >
                <Download className="size-3.5" />
                Download .user.js
              </Button>
            </div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
              <li>Install Tampermonkey (Chrome / Edge / Firefox / Safari via Userscripts) — works on desktop and Android (Firefox + Tampermonkey).</li>
              <li>
                Click <span className="font-semibold text-foreground">Copy userscript</span> (auto-copied when this panel opened) → Tampermonkey →{" "}
                <span className="font-mono">Create a new script</span> → paste over everything → <span className="font-mono">Ctrl+S</span>.
              </li>
              <li>
                Open <span className="font-mono">dexview.com</span>, <span className="font-mono">gmgn.ai</span> or <span className="font-mono">ave.ai</span> — the FlashBolt overlay
                panel appears top-right (full-width card on phones) with the BOT ON/OFF toggle.
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
                    downloadBlob(chromeZip, "chrome-flashbolt-overlay.zip", "application/zip");
                    toast.success("chrome-flashbolt-overlay.zip downloading");
                  }}
                >
                  <Download className="size-3.5" />
                  Download Chrome zip ({(chromeZip.length / 1024).toFixed(1)} KB)
                </Button>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>Unzip the download into a folder.</li>
                  <li>
                    Open <span className="font-mono">chrome://extensions</span> → enable Developer mode → <span className="font-mono">Load unpacked</span>{" "}
                    → select the folder.
                  </li>
                </ol>
              </div>

              {/* Firefox */}
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs font-bold text-emerald-400">Firefox</div>
                  <Badge variant="outline" className="text-[10px]">MV2 (Gecko)</Badge>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">Same engine, Gecko manifest + background page.</p>
                <Button
                  size="sm"
                  className="w-full gap-2"
                  onClick={() => {
                    downloadBlob(firefoxZip, "firefox-flashbolt-overlay.zip", "application/zip");
                    toast.success("firefox-flashbolt-overlay.zip downloading");
                  }}
                >
                  <Download className="size-3.5" />
                  Download Firefox zip ({(firefoxZip.length / 1024).toFixed(1)} KB)
                </Button>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>Unzip the download into a folder.</li>
                  <li>
                    Open <span className="font-mono">about:debugging#/runtime/this-firefox</span> → <span className="font-mono">Load Temporary Add-on</span>{" "}
                    → select manifest.json.
                  </li>
                  <li>For a permanent install, sign the folder on addons.mozilla.org (web-ext build) — the README in the zip has the steps.</li>
                </ol>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-2" onClick={() => void copy(bundle.manifest, "manifest", "Chrome manifest.json copied")}>
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
              Inside the overlay (both flavors): flip the BOT ON/OFF toggle, connect MetaMask (or any injected wallet) → it uses the stamped settings above
              (including SELL AMOUNT %), auto-syncs its chain to the site page you browse (BSC/ETH/Arbitrum One/POL), captures brand-new tokens instantly from the
              page layer plus DexScreener/GeckoTerminal, filters to buyable + sellable only, simulates every buy and sell with a full eth_call before
              broadcasting (zero gas on failure), auto-sells on profit target or trailing stop, and pays out automatically.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
