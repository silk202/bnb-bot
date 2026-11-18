/**
 * Overlay generator unit tests — the userscript/extension source of truth.
 *
 * Verifies the v2 feature set for the DEXView/GMGN/Ave overlay: ave.ai
 * matching, ON/OFF bot toggle, instant page-layer capture, ACTIVE/IDLE
 * indicator, site→chain auto-sync, SELL AMOUNT wiring and the stamped
 * settings contract.
 */
import { describe, expect, test } from "bun:test";
import {
  buildExtensionBundle,
  buildOverlayUserscript,
  SCANNER_SITES,
  SITE_CHAIN_SLUGS,
  OVERLAY_VERSION,
  toExtensionContentScript,
  type OverlayConfig,
} from "../overlay-script";
import { CHAIN_INFO } from "../chains";

const config: OverlayConfig = {
  appOrigin: "https://flashbolt.test",
  chains: Object.values(CHAIN_INFO).map((c) => ({
    key: c.key,
    chainId: c.chainId,
    label: c.label,
    router: c.router,
    wrapped: c.quoteAddress,
    nativeSymbol: c.nativeSymbol,
    rpc: c.rpc,
  })),
  stamped: {
    chainKey: "bsc",
    buyAmountNative: 0.05,
    sellPct: 50,
    sellAmountPct: 75,
    slippagePct: 4,
    profitTargetPct: 12,
    trailingStopPct: 6,
    maxGasPriceGwei: 7,
    minLiquidityUsd: 500,
    autoPayout: true,
    payoutAddress: "0x000000000000000000000000000000000000dEaD",
  },
};

const script = buildOverlayUserscript(config);

describe("overlay userscript generation", () => {
  test("targets DEXView, GMGN and Ave.ai (plus the DexScreener page layer)", () => {
    for (const host of ["dexscreener.com", "dexview.com", "gmgn.ai", "ave.ai"]) {
      expect(script).toContain(`https://${host}/*`);
    }
  });

  test("carries the renamed DEXView / GMGN / Ave title and version", () => {
    expect(script).toContain("DEXView / GMGN / Ave");
    expect(script).toContain("@version      2.9.0");
    expect(OVERLAY_VERSION).toBe("2.9.0");
  });

  test("includes the ON/OFF bot toggle wiring", () => {
    expect(script).toContain("botOn: true");
    expect(script).toContain('"BOT ON" : "BOT OFF"');
    expect(script).toContain("function toggleBot");
    // Engine paths must all be gated by the toggle
    expect(script).toContain("if (!settings.botOn) return;");
    expect(script).toContain("if (!settings.botOn || pendingDom.size === 0) return;");
  });

  test("includes the ACTIVE/IDLE indicator bound to live capture", () => {
    expect(script).toContain("LIVE CANDIDATES (BUYABLE + SELLABLE)");
    expect(script).toContain('setIndicator("ACTIVE")');
    expect(script).toContain('setIndicator(now() - lastCaptureAt < 20000 ? "ACTIVE" : "IDLE")');
  });

  test("includes instant sub-millisecond page-layer capture", () => {
    expect(script).toContain("new MutationObserver(");
    expect(script).toContain('obs.observe(document.documentElement, { childList: true, subtree: true })');
    expect(script).toContain("function scheduleDomFlush()");
    expect(script).toContain("page-harvest");
  });

  test("includes site→chain auto-sync with real URL slugs", () => {
    expect(script).toContain("function chainFromSite()");
    for (const slug of ["bsc", "eth", "arb", "polygon", "polygon_pos", "matic"]) {
      expect(SITE_CHAIN_SLUGS[slug]).toBeTruthy();
    }
    for (const site of ["dexscreener.com", "dexview.com", "gmgn.ai", "ave.ai"]) {
      expect(SCANNER_SITES).toContain(site);
    }
    // ave.ai nests the chain under /chain/<slug>
    expect(script).toContain('parts[0] === "chain" ? parts[1] : parts[0]');
    expect(script).toContain("Site auto-sync: chain -> ");
  });

  test("stamps SELL AMOUNT and every sniper setting from the terminal", () => {
    // The generator embeds the terminal settings as a JSON STAMPED block.
    const stampMatch = script.match(/const STAMPED = (\{[\s\S]*?\});/);
    expect(stampMatch).toBeTruthy();
    const stamped = JSON.parse(stampMatch![1]) as Record<string, unknown>;
    expect(stamped["sellAmountPct"]).toBe(75);
    expect(stamped["buyAmountNative"]).toBe(0.05);
    expect(stamped["sellPct"]).toBe(50);
    expect(stamped["slippagePct"]).toBe(4);
    expect(stamped["profitTargetPct"]).toBe(12);
    expect(stamped["trailingStopPct"]).toBe(6);
    expect(stamped["maxGasPriceGwei"]).toBe(7);
    expect(stamped["minLiquidityUsd"]).toBe(500);
    expect(stamped["payoutAddress"]).toBe("0x000000000000000000000000000000000000dEaD");
    // STAMPED values flow into the runtime defaults
    expect(script).toContain("sellAmountPct: STAMPED.sellAmountPct != null ? STAMPED.sellAmountPct : 100");
    // SELL AMOUNT appears in the panel UI and the per-position override
    expect(script).toContain('numField("SELL AMOUNT %", "sellAmountPct")');
    expect(script).toContain("SELL AMOUNT % - share of this position each sell disposes of");
  });

  test("applies effective-disposal math (sell % × SELL AMOUNT %) in sells", () => {
    expect(script).toContain("const pct = (basePct * amtPct) / 100;");
    expect(script).toContain("const amountIn = (bal * BigInt(Math.floor(pct))) / 100n;");
  });

  test("keeps the zero-gas simulation gate before every broadcast", () => {
    expect(script).toContain("eth_estimateGas");
    expect(script).toContain("SIM FAILED (zero gas spent)");
    expect(script).toContain("eth_sendTransaction");
  });

  test("dedupes with a seen-map so candidates never double-fire", () => {
    expect(script).toContain("const seen = new Map();");
    expect(script).toContain("if (!passesGates(t)) return;");
  });

  test("runs at document-start for the earliest possible capture hook", () => {
    expect(script).toContain("// @run-at       document-start");
    expect(script).toContain("window.__FLASHBOLT_OVERLOAD__");
  });

  test("displays the genuine Arbitrum One chain symbol (ETH, not the ARB token)", () => {
    // The stamped chain registry must carry Arbitrum One's real native symbol.
    const arb = JSON.parse(script.match(/const CHAINS = ([\s\S]*?);\n/)?.[1] ?? "[]")
      .find((c: { key: string }) => c.key === "arbitrum");
    expect(arb).toBeTruthy();
    expect(arb.label).toBe("Arbitrum One");
    expect(arb.nativeSymbol).toBe("ETH");
    // Runtime UI renders label + nativeSymbol — never a hardcoded ARB ticker.
    expect(script).toContain('c.label + " (" + c.nativeSymbol + ")"');
    expect(script).toContain('numField("Buy amount (" + (byKey.get(settings.chainKey) || CHAINS[0]).nativeSymbol + ")"');
    // No display string presents ARB as the chain's currency symbol.
    expect(script).not.toContain('"ARB"');
  });
});

describe("overlay extension bundle", () => {
  const bundle = buildExtensionBundle(config);

  test("manifests cover all scanner sites including ave.ai", () => {
    for (const manifest of [bundle.manifest, bundle.firefoxManifest]) {
      for (const host of ["dexscreener.com", "dexview.com", "gmgn.ai", "ave.ai"]) {
        expect(manifest).toContain(host);
      }
    }
  });

  test("extension content script equals the userscript minus its header", () => {
    expect(bundle.overlayJs).not.toContain("// ==UserScript==");
    expect(bundle.overlayJs).toContain("window.__FLASHBOLT_OVERLOAD__");
    expect(bundle.overlayJs.length).toBeGreaterThan(10_000);
    expect(toExtensionContentScript(script)).toBe(bundle.overlayJs);
  });

  test("ships a README documenting the new feature set", () => {
    expect(bundle.readme).toContain("Ave.ai");
    expect(bundle.readme).toContain("ON/OFF");
    expect(bundle.readme).toContain("site-chain auto-sync");
  });

  test("zip entries are complete for both browser flavors", () => {
    for (const entries of [bundle.chromeEntries, bundle.firefoxEntries]) {
      const names = entries.map((e) => e.name);
      expect(names).toContain("manifest.json");
      expect(names).toContain("overlay.js");
      expect(names).toContain("background.js");
      expect(names).toContain("README.md");
    }
  });
});
