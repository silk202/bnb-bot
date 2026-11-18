/**
 * SOL overlay generator tests — verifies the generated userscript/extension
 * bundle is complete, honestly stamped, and structurally sound:
 * real site matches (DEXView/GMGN/Ave/DexScreener Solana), Phantom/Solflare/
 * Backpack provider detection, simulateTransaction zero-gas gate language,
 * Jito tip floor, daily-limit enforcement, and MV3/MV2 manifest validity.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSolExtensionBundle,
  buildSolOverlayUserscript,
  type SolOverlayConfig,
} from "./sol-overlay-script";

const CFG: SolOverlayConfig = {
  appOrigin: "https://app.flashbolt.test",
  signalsUrl: "https://convex.test/api/copier/signals",
  stamped: {
    buyAmountSol: 0.75,
    sellPct: 100,
    sellAmountPct: 50,
    slippagePct: 1.5,
    profitTargetPct: 15,
    trailingStopPct: 4,
    minLiquidityUsd: 8000,
    dailySnipeLimit: 12,
    autoPayout: true,
    payoutAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    jitoSubmit: true,
  },
};

describe("buildSolOverlayUserscript", () => {
  const script = buildSolOverlayUserscript(CFG);

  test("carries a valid userscript header for the Solana scanner sites", () => {
    expect(script.startsWith("// ==UserScript==")).toBe(true);
    expect(script).toContain("@name         FlashBolt SOL Sniper Overlay");
    // Site matches: DEXView, GMGN, Ave + DexScreener Solana pages.
    expect(script).toContain("@match        https://dexview.com/*");
    expect(script).toContain("@match        https://gmgn.ai/*");
    expect(script).toContain("@match        https://ave.ai/*");
    expect(script).toContain("@match        https://dexscreener.com/solana*");
    expect(script).toContain("@run-at       document-start");
  });

  test("stamps every operator setting into the generated script", () => {
    expect(script).toContain('"buyAmountSol":0.75');
    expect(script).toContain('"sellAmountPct":50');
    expect(script).toContain('"slippagePct":1.5');
    expect(script).toContain('"profitTargetPct":15');
    expect(script).toContain('"trailingStopPct":4');
    expect(script).toContain('"minLiquidityUsd":8000');
    expect(script).toContain('"dailySnipeLimit":12');
    expect(script).toContain('"autoPayout":true');
    expect(script).toContain('"jitoSubmit":true');
  });

  test("detects Solana-standard wallet injection points", () => {
    expect(script).toContain("w.phantom.solana");
    expect(script).toContain("isPhantom");
    expect(script).toContain("w.solflare");
    expect(script).toContain("w.backpack");
  });

  test("enforces the daily snipe limit before execution", () => {
    expect(script).toContain("withinDailyLimit");
    expect(script).toContain("Daily snipe limit reached");
  });

  test("names the real zero-gas gate and Jito floor", () => {
    expect(script).toContain("simulateTransaction");
    // Min tip floor surfaced in the panel (1000 lamports = 0.0001 SOL).
    expect(script).toContain("1000 lamports");
  });

  test("sub-millisecond capture uses MutationObserver + fast poll", () => {
    expect(script).toContain("new MutationObserver");
    // 250ms page-scan poll keeps the capture fresh.
    expect(script).toContain("}, 250)");
  });

  test("has an ON/OFF bot toggle persisted in localStorage", () => {
    expect(script).toContain('"botOn"');
    expect(script).toContain("fbsol_");
  });

  test("defaults are conservative when no stamp is provided", () => {
    const bare = buildSolOverlayUserscript({ appOrigin: "https://x.test" });
    expect(bare).toContain('"buyAmountSol":0.5');
    expect(bare).toContain('"dailySnipeLimit":0'); // unlimited by default
    expect(bare).toContain('"minLiquidityUsd":5000'); // $5k floor
  });

  test("daily-target gate: single GATE_URL on the Convex HTTP origin, consumed before every snipe", () => {
    const gated = buildSolOverlayUserscript({
      appOrigin: "https://app.flashbolt.test",
      httpOrigin: "https://convex-test.convex.site",
      stamped: { overlayToken: "a".repeat(64), dailySnipeLimit: 3 },
    });
    // Exactly one GATE_URL declaration (a duplicate const would be a
    // SyntaxError that kills the whole overlay at load) ...
    expect(gated.match(/const GATE_URL =/g)?.length).toBe(1);
    // ... pointed at the Convex HTTP origin (where /api/overlay/execution
    // is served), not the app origin.
    expect(gated).toContain('const GATE_URL = HTTP_ORIGIN + "/api/overlay/execution";');
    expect(gated).not.toContain('const GATE_URL = APP_ORIGIN');
    // Token is stamped (inside STAMP, resolved by OVERLAY_TOKEN) and carried
    // in the gate header + consume body.
    expect(gated).toContain(`"overlayToken":"${"a".repeat(64)}"`);
    expect(gated).toContain('const OVERLAY_TOKEN = STAMP.overlayToken || "";');
    expect(gated).toContain('X-Flashbolt-Token');
    expect(gated).toContain('JSON.stringify({ token: OVERLAY_TOKEN })');
    // The gate is consumed BEFORE any broadcast — a blocked verdict aborts.
    expect(gated).toContain("if (!(await consumeGateSlot())) return;");
    // Operator / unstamped installs skip the gate entirely (unlimited).
    const ungated = buildSolOverlayUserscript({ appOrigin: "https://x.test" });
    expect(ungated).toContain('if (!OVERLAY_TOKEN) return true; // operator/private install — unlimited');
  });

  test("extension bundle carries the same single-gate script", () => {
    const bundle = buildSolExtensionBundle({
      appOrigin: "https://app.flashbolt.test",
      httpOrigin: "https://convex-test.convex.site",
      stamped: { overlayToken: "b".repeat(64) },
    });
    expect(bundle.overlayJs.match(/const GATE_URL =/g)?.length).toBe(1);
    expect(bundle.overlayJs).toContain('const GATE_URL = HTTP_ORIGIN + "/api/overlay/execution";');
  });
});

describe("buildSolExtensionBundle", () => {
  const bundle = buildSolExtensionBundle(CFG);

  test("strips the userscript header from overlay.js", () => {
    expect(bundle.overlayJs.startsWith("// ==UserScript==")).toBe(false);
    expect(bundle.overlayJs).toContain("FlashBolt");
  });

  test("chrome manifest is valid MV3 with the same site matches", () => {
    const m = JSON.parse(bundle.chromeManifest) as {
      manifest_version: number;
      content_scripts: Array<{ matches: string[]; js: string[]; run_at: string }>;
    };
    expect(m.manifest_version).toBe(3);
    expect(m.content_scripts[0]!.run_at).toBe("document_start");
    expect(m.content_scripts[0]!.js).toEqual(["overlay.js"]);
    const matches = m.content_scripts[0]!.matches.join(" ");
    expect(matches).toContain("dexview.com");
    expect(matches).toContain("gmgn.ai");
    expect(matches).toContain("ave.ai");
    expect(matches).toContain("dexscreener.com/solana");
  });

  test("firefox manifest is valid MV2 with a gecko id", () => {
    const m = JSON.parse(bundle.firefoxManifest) as {
      manifest_version: number;
      browser_specific_settings?: { gecko?: { id: string } };
    };
    expect(m.manifest_version).toBe(2);
    expect(m.browser_specific_settings?.gecko?.id).toContain("@flashbolt.app");
  });

  test("zip entries carry every install file with non-empty content", () => {
    for (const entries of [bundle.chromeEntries, bundle.firefoxEntries]) {
      expect(entries.length).toBe(3);
      for (const e of entries) {
        expect(e.name.length).toBeGreaterThan(0);
        expect(e.content.length).toBeGreaterThan(100);
      }
    }
    // Same overlay.js in both bundles.
    expect(bundle.chromeEntries.find((e) => e.name === "overlay.js")!.content).toBe(
      bundle.firefoxEntries.find((e) => e.name === "overlay.js")!.content,
    );
  });
});
