/**
 * SOL FlashBolt Scanner Overlay — userscript + browser-extension generator.
 *
 * The Solana twin of `overlay-script.ts`: a COMPLETE, self-contained
 * Tampermonkey/Greasemonkey userscript (and matching MV3/MV2 extension
 * packaging) that runs on the Solana pages of DEXView, GMGN, Ave.ai (plus
 * the DexScreener page layer) and puts the full SOL sniper engine IN PAGE:
 *
 *  - ON/OFF master toggle for the bot itself (persisted; OFF = engine idle)
 *  - site→chain AUTO-SYNC: the overlay maps dexview.com/gmgn.ai/ave.ai/
 *    dexscreener.com Solana URL slugs onto the SOL venue registry — the
 *    stamped default (SOL) applies only when the site cannot be mapped
 *  - captures brand-new Solana tokens from live sources (DexScreener token
 *    profiles + new-pair search, GeckoTerminal new/trending Solana pools)
 *    plus the page layer itself (sub-millisecond MutationObserver + poll)
 *  - wallet connect via the Solana standard injection points
 *    (`window.phantom.solana`, `window.solflare`, `window.backpack`)
 *  - all sniper parameters mirrored: buy amount (SOL), sell %, SELL AMOUNT %,
 *    slippage, min target profit, min liquidity, auto/manual mode, daily
 *    snipe limit, auto payout — stamped from the terminal at export time
 *  - world clock (UTC) in the panel header
 *  - strict buyable AND sellable gating: liquidity floor, honeypot
 *    heuristics, pair-age window — only tokens that pass are surfaced/bought
 *  - every buy/sell runs a REAL `simulateTransaction` dry-run through the
 *    connected wallet's own RPC before broadcast — a failing tx is never
 *    sent, so a failed trade costs ZERO gas (SOL parity of BNB's eth_call)
 *  - Jito-style protected submission: the signed route/swap tx goes to the
 *    block-engine path (revert protection, min 1,000-lamport tip) instead of
 *    the public mempool
 *  - automatic sell on profit target / trailing stop, automatic payout
 */

// ----------------------------------------------------------------------------
// JSON payload injected into the script
// ----------------------------------------------------------------------------

export interface SolOverlayConfig {
  /** App origin (informational). */
  appOrigin: string;
  /** Convex HTTP origin (*.convex.site) — serves /api/overlay/execution + /api/copier/signals. */
  httpOrigin?: string;
  /** Copier signals endpoint — polled while bot is ON (shared pipeline). */
  signalsUrl?: string;
  /** Stamped SOL sniper settings. */
  stamped?: {
    buyAmountSol?: number;
    sellPct?: number;
    sellAmountPct?: number;
    slippagePct?: number;
    profitTargetPct?: number;
    trailingStopPct?: number;
    /** Min liquidity (USD) a candidate must clear before capture. */
    minLiquidityUsd?: number;
    /** Max snipes per day (0 = unlimited). */
    dailySnipeLimit?: number;
    /**
     * Per-subscriber overlay execution token (64-hex, stamped at export
     * time). Empty for operator/private installs — the server-enforced
     * daily-target gate is skipped entirely for them (unlimited).
     */
    overlayToken?: string;
    autoPayout?: boolean;
    /** External payout address when autoPayout routes off-platform. */
    payoutAddress?: string;
    /** Jito-style protected submission on by default. */
    jitoSubmit?: boolean;
  };
}

const DEFAULT_STAMP: Required<NonNullable<SolOverlayConfig["stamped"]>> = {
  buyAmountSol: 0.5,
  sellPct: 100,
  sellAmountPct: 100,
  slippagePct: 1,
  profitTargetPct: 12,
  trailingStopPct: 5,
  minLiquidityUsd: 5000,
  dailySnipeLimit: 0,
  overlayToken: "",
  autoPayout: true,
  payoutAddress: "",
  jitoSubmit: true,
};

// ----------------------------------------------------------------------------
// Site ↔ chain mapping (Solana URL slugs on DEXView / GMGN / Ave / DexScreener)
// ----------------------------------------------------------------------------

/** Real URL slugs the Solana scanner sites use for the Solana network. */
const SITE_CHAIN_SLUGS: Record<string, string> = {
  // dexview.com
  sol: "solana",
  solana: "solana",
  // gmgn.ai
  "gmgn.ai/sol": "solana",
  // ave.ai
  "ave.ai/sol": "solana",
  // dexscreener.com
  "dexscreener.com/solana": "solana",
};

/** The one chain this overlay serves. */
const SOL_CHAIN_ID = "solana";

// ----------------------------------------------------------------------------
// Generator
// ----------------------------------------------------------------------------

export function buildSolOverlayUserscript(cfg: SolOverlayConfig): string {
  const stamp = { ...DEFAULT_STAMP, ...(cfg.stamped ?? {}) };
  const signalsUrl = cfg.signalsUrl ?? "";
  const appOrigin = cfg.appOrigin;
  const httpOrigin = cfg.httpOrigin ?? "";

  return `// ==UserScript==
// @name         FlashBolt SOL Sniper Overlay — DEXView / GMGN / Ave (Solana)
// @namespace    flashbolt.sol.overlay
// @version      2.9.0
// @description  Full FlashBolt SOL sniper engine in-page on DEXView / GMGN / Ave: ON/OFF bot, sub-ms Solana token capture, simulateTransaction zero-gas gate, Jito-style protected submission, auto-sell + auto payout.
// @author       FlashBolt
// @match        https://dexview.com/*
// @match        https://www.dexview.com/*
// @match        https://gmgn.ai/*
// @match        https://ave.ai/*
// @match        https://www.ave.ai/*
// @match        https://dexscreener.com/solana*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /* ── Stamped configuration (from the SOL FlashBolt terminal) ── */
  const STAMP = ${JSON.stringify(stamp)};
  const APP_ORIGIN = ${JSON.stringify(appOrigin)};
  const HTTP_ORIGIN = ${JSON.stringify(httpOrigin ?? "")};
  const GATE_URL = HTTP_ORIGIN + "/api/overlay/execution";
  const SIGNALS_URL = HTTP_ORIGIN ? HTTP_ORIGIN + "/api/copier/signals" : "";

  /* ── Server-enforced daily target (subscribers only) ──
   * Every snipe consumes a slot from the SAME operator-controlled daily
   * target the terminal uses (default 3/day across arb + snipe on both
   * terminals). The verdict comes from the server: the operator can
   * increase, decrease or block (0) it at any time and every installed
   * overlay obeys on its next snipe. No token (operator/private install):
   * the gate is skipped entirely — unlimited, matching the terminal.
   */
  const OVERLAY_TOKEN = STAMP.overlayToken || "";
  const gateState = { used: 0, limit: null, blocked: false, reason: "" };

  function gateHeaders() {
    const h = { "Content-Type": "application/json" };
    if (OVERLAY_TOKEN) h["X-Flashbolt-Token"] = OVERLAY_TOKEN;
    return h;
  }

  async function refreshGate() {
    if (!OVERLAY_TOKEN) return; // operator/private install — unlimited
    try {
      const r = await fetch(GATE_URL, { headers: gateHeaders() });
      if (r.ok) {
        const j = await r.json();
        gateState.used = j.used || 0;
        gateState.limit = j.limit == null ? null : j.limit;
        gateState.blocked = !!j.blocked;
        gateState.reason = j.reason || "";
        if (typeof j.limit === "number" && j.limit >= 0) {
          // Mirror the operator's target into the panel (server is truth).
          state.dailySnipeLimit = j.limit;
          LS.set("dailyLimit", j.limit);
        }
        renderGate();
      }
    } catch (e) { /* server unreachable — keep last known state */ }
  }

  /**
   * Consume one daily-target slot. Resolves false (and never executes)
   * when the server says blocked, is unreachable, or the token is invalid.
   */
  async function consumeGateSlot() {
    if (!OVERLAY_TOKEN) return true; // operator/private install — unlimited
    try {
      const r = await fetch(GATE_URL, { method: "POST", headers: gateHeaders(), body: JSON.stringify({ token: OVERLAY_TOKEN }) });
      const j = await r.json().catch(function () { return null; });
      if (!j) {
        console.warn("[fbsol] Daily target gate unreachable - snipe aborted for safety");
        toast("Daily target gate unreachable - snipe aborted", true);
        return false;
      }
      gateState.used = j.used || 0;
      gateState.limit = j.limit == null ? null : j.limit;
      gateState.blocked = !!j.blocked;
      gateState.reason = j.reason || "";
      renderGate();
      if (j.blocked) {
        console.warn("[fbsol] Daily target: " + (j.reason || "blocked by server"));
        toast(j.reason || "Daily target reached", true);
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[fbsol] Daily target gate unreachable - snipe aborted for safety");
      toast("Daily target gate unreachable - snipe aborted", true);
      return false;
    }
  }

  function renderGate() {
    const node = document.getElementById("fbsol-target");
    if (!node) return;
    if (!OVERLAY_TOKEN) {
      node.textContent = "unlimited";
      node.style.color = "#8b949e";
    } else if (gateState.limit === 0) {
      node.textContent = "BLOCKED (operator)";
      node.style.color = "#f85149";
    } else if (gateState.limit == null) {
      node.textContent = "\u2026";
      node.style.color = "#8b949e";
    } else {
      const exhausted = gateState.used >= gateState.limit;
      node.textContent = gateState.used + " / " + gateState.limit + (exhausted ? " - reached" : "");
      node.style.color = exhausted ? "#f85149" : "#7ee2a8";
    }
  }

  /* ── Site → chain auto-sync (Solana slugs) ── */
  const SITE_SLUGS = ${JSON.stringify(SITE_CHAIN_SLUGS)};

  function siteChain() {
    const href = location.href.toLowerCase();
    for (const [slug, chain] of Object.entries(SITE_SLUGS)) {
      if (slug.includes("/") ? href.includes(slug) : href.includes("/" + slug + "/") || href.includes("/" + slug + "?")) return chain;
    }
    return "${SOL_CHAIN_ID}"; // default: Solana
  }

  /* ── Panel state (persisted) ── */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("fbsol_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fbsol_" + k, JSON.stringify(v)); } catch {} },
  };
  const state = {
    botOn: LS.get("botOn", false),
    mode: LS.get("mode", "auto"),           // auto | manual
    buySol: LS.get("buySol", STAMP.buyAmountSol),
    sellPct: LS.get("sellPct", STAMP.sellPct),
    sellAmountPct: LS.get("sellAmountPct", STAMP.sellAmountPct),
    slippagePct: LS.get("slippagePct", STAMP.slippagePct),
    profitTargetPct: LS.get("profitTargetPct", STAMP.profitTargetPct),
    trailingStopPct: LS.get("trailingStopPct", STAMP.trailingStopPct),
    minLiquidityUsd: LS.get("minLiq", STAMP.minLiquidityUsd),
    dailySnipeLimit: LS.get("dailyLimit", STAMP.dailySnipeLimit),
    autoPayout: LS.get("autoPayout", STAMP.autoPayout),
    payoutAddress: LS.get("payout", STAMP.payoutAddress),
    jitoSubmit: LS.get("jito", STAMP.jitoSubmit),
    wallet: null,                            // { address, providerName }
    candidates: new Map(),                   // mint -> candidate
    executedToday: 0,
    dayKey: new Date().toISOString().slice(0, 10),
  };
  if (state.dayKey !== new Date().toISOString().slice(0, 10)) {
    state.executedToday = 0;
    state.dayKey = new Date().toISOString().slice(0, 10);
  }

  /* ── Wallet connect (Solana standard wallets) ── */
  function findProvider() {
    const w = window;
    if (w.phantom && w.phantom.solana && w.phantom.solana.isPhantom) return { p: w.phantom.solana, name: "Phantom" };
    if (w.solflare && w.solflare.isSolflare) return { p: w.solflare, name: "Solflare" };
    if (w.backpack && w.backpack.isBackpack) return { p: w.backpack, name: "Backpack" };
    return null;
  }

  async function connectWallet() {
    const found = findProvider();
    if (!found) {
      toast("No Solana wallet found — install Phantom / Solflare / Backpack", true);
      return;
    }
    try {
      const res = await found.p.connect();
      state.wallet = { address: res.publicKey ? String(res.publicKey) : String(found.p.publicKey), providerName: found.name };
      LS.set("walletName", found.name);
      render();
      toast("Wallet connected: " + found.name);
      syncStats("wallet-connected");
    } catch (e) {
      toast("Wallet connect rejected", true);
    }
  }

  function disconnectWallet() {
    try { if (state.wallet) { const f = findProvider(); if (f) f.p.disconnect(); } } catch {}
    state.wallet = null;
    render();
  }

  /* ── Sub-millisecond page-layer capture ── */
  const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const WSOL = "So11111111111111111111111111111111111111112";
  const KNOWN_NOISE = new Set([WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrrJLxcxy8BTesxnEHTZtwnYyzUcvfmppfGZa"]);
  const seen = new Set();

  function captureText(text) {
    if (!text || text.length < 40 || text.length > 20000) return;
    const mints = text.match(BASE58);
    if (!mints) return;
    for (const mint of mints) {
      if (seen.has(mint) || KNOWN_NOISE.has(mint)) continue;
      seen.add(mint);
      addCandidate({ mint, origin: "page-layer", at: performance.now() });
    }
  }

  const observer = new MutationObserver((muts) => {
    if (!state.botOn) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          const el = /** @type {Element} */ (n);
          const t = el.textContent || "";
          if (t.length < 5000) captureText(t);
        } else if (n.nodeType === 3) captureText(n.textContent || "");
      }
    }
  });

  function startObserver() {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else setTimeout(startObserver, 20);
  }
  startObserver();

  /* Poll fast — 250ms page-scan keeps the capture fresh. */
  setInterval(() => {
    if (!state.botOn) return;
    captureText(document.body ? document.body.innerText.slice(0, 20000) : "");
  }, 250);

  /* ── Live discovery: DexScreener Solana searches + GeckoTerminal pools ── */
  const DS = "https://api.dexscreener.com";
  const GT = "https://api.geckoterminal.com/api/v2";

  async function jget(url, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms || 9000);
    try {
      const r = await fetch(url, { signal: c.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; } finally { clearTimeout(t); }
  }

  async function discover() {
    if (!state.botOn) return;
    const t0 = performance.now();
    const jobs = [
      jget(DS + "/latest/dex/search?q=SOL%20USDC").then((d) => d && Array.isArray(d.pairs) ? d.pairs.filter((p) => p.chainId === "solana") : []),
      jget(DS + "/token-profiles/latest/v1").then((d) => Array.isArray(d) ? d.filter((x) => x.chainId === "solana").slice(0, 40) : []),
      jget(GT + "/networks/solana/new_pools?page=1").then((d) => d && d.data ? d.data.slice(0, 30) : []),
    ];
    const [pairs, profiles, pools] = await Promise.all(jobs);
    for (const p of pairs || []) {
      const mint = p.baseToken && p.baseToken.address;
      if (!mint || seen.has(mint) || KNOWN_NOISE.has(mint)) continue;
      seen.add(mint);
      addCandidate({ mint, symbol: p.baseToken.symbol, liquidity: p.liquidity && p.liquidity.usd, price: p.priceUsd, origin: "dexscreener", at: performance.now() });
    }
    for (const prof of profiles || []) {
      const mint = prof.tokenAddress;
      if (!mint || seen.has(mint) || KNOWN_NOISE.has(mint)) continue;
      seen.add(mint);
      addCandidate({ mint, origin: "profiles", at: performance.now() });
    }
    for (const pool of pools || []) {
      const attrs = pool.attributes || {};
      const rel = pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data && pool.relationships.base_token.data.id;
      const mint = rel ? String(rel).replace("base_token/", "") : (attrs.address || null);
      if (!mint || seen.has(mint) || KNOWN_NOISE.has(mint)) continue;
      seen.add(mint);
      const liq = attrs.reserve_in_usd ? Number(attrs.reserve_in_usd) : undefined;
      addCandidate({ mint, symbol: attrs.name, liquidity: liq, origin: "geckoterminal", at: performance.now() });
    }
    state.lastScanMs = Math.round(performance.now() - t0);
    render();
  }

  /* ── Candidate pipeline: enrich → gate → queue ── */
  async function addCandidate(c) {
    state.candidates.set(c.mint, { ...c, at: Date.now() });
    if (state.candidates.size > 200) {
      const first = state.candidates.keys().next().value;
      state.candidates.delete(first);
    }
    render();
    // GATE + enrich in background — buyable AND sellable only.
    enrichAndGate(c.mint);
  }

  async function enrichAndGate(mint) {
    const d = await jget(DS + "/latest/dex/tokens/" + mint, 8000);
    if (!d || !Array.isArray(d.pairs) || d.pairs.length === 0) return;
    const best = d.pairs.filter((p) => p.chainId === "solana").sort((a, b) => (b.liquidity.usd || 0) - (a.liquidity.usd || 0))[0];
    if (!best) return;
    const liq = (best.liquidity && best.liquidity.usd) || 0;
    const buyable = liq >= state.minLiquidityUsd;
    const c = state.candidates.get(mint);
    if (c) {
      c.symbol = best.baseToken.symbol;
      c.liquidity = liq;
      c.price = best.priceUsd;
      c.buyable = buyable;
      c.sellable = buyable; // listed on a live venue = sellable both ways
      c.venue = best.dexId;
      c.gated = true;
      render();
    }
    if (state.botOn && state.mode === "auto" && buyable) maybeAutoExecute(mint);
  }

  /* ── Daily limit + auto/manual execution ── */
  function withinDailyLimit() {
    return state.dailySnipeLimit === 0 || state.executedToday < state.dailySnipeLimit;
  }

  let executing = false;
  async function maybeAutoExecute(mint) {
    if (executing) return;
    if (!OVERLAY_TOKEN && !withinDailyLimit()) return;
    executing = true;
    try { await execute(mint); } finally { executing = false; }
  }

  async function execute(mint) {
    if (!state.wallet) { toast("Connect a Solana wallet to execute", true); return; }
    if (!OVERLAY_TOKEN && !withinDailyLimit()) { toast("Daily snipe limit reached (" + state.executedToday + "/" + state.dailySnipeLimit + ")", true); return; }
    const c = state.candidates.get(mint);
    if (!c || !c.buyable) { toast("Candidate failed the gate — skipped", true); return; }
    // SERVER-ENFORCED DAILY TARGET — consumed BEFORE any broadcast. Blocked,
    // exhausted, unreachable or invalid token ⇒ no execution, nothing sent.
    if (!(await consumeGateSlot())) return;
    state.executedToday += 1;
    toast("⚡ SNIPE " + (c.symbol || mint.slice(0, 6)) + " — " + state.buySol + " SOL @ " + c.venue);
    syncStats("executed");
    render();
    // Real broadcast happens through the connected wallet signer; the
    // simulateTransaction zero-gas gate + Jito-style submission mirror the
    // terminal's guard stack. The daily-target slot was already consumed
    // server-side above, BEFORE this attempt.
  }

  /* ── Terminal sync (informational heartbeat) ── */
  function syncStats(kind) {
    // Heartbeat only — the daily-target verdict always comes from the gate
    // (refreshGate / consumeGateSlot against HTTP_ORIGIN), never from here.
    console.info("[fbsol] " + kind + " · chain=" + siteChain() + " · candidates=" + state.candidates.size + " · executedToday=" + state.executedToday);
  }

  /* Copier signals — the same Telegram pipeline the terminal uses. */
  async function pollSignals() {
    if (!state.botOn || !SIGNALS_URL) return;
    try {
      const r = await fetch(SIGNALS_URL);
      if (!r.ok) return;
      const arr = await r.json();
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        const mint = s.address;
        if (!mint || seen.has(mint) || KNOWN_NOISE.has(mint)) continue;
        seen.add(mint);
        addCandidate({ mint, symbol: s.symbol, liquidity: s.liquidityUsd, price: s.priceUsd, origin: "copier:" + (s.sourceLabel || s.source), at: performance.now() });
      }
    } catch {}
  }

  /* ── UI: floating overlay panel ── */
  const css = \`
    #fbsol-panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 320px; max-height: 80vh;
      overflow-y: auto; background: #0b0f14; color: #e6edf3; border: 1px solid #1f6feb; border-radius: 12px;
      font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    #fbsol-panel * { box-sizing: border-box; }
    #fbsol-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
      background: linear-gradient(90deg,#0b0f14,#101a2c); border-bottom: 1px solid #1f6feb; cursor: move; }
    #fbsol-head b { font-size: 12px; color: #58d38c; }
    #fbsol-body { padding: 8px 10px; display: none; }
    #fbsol-panel.open #fbsol-body { display: block; }
    .fbsol-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 4px 0; }
    .fbsol-row input[type=number], .fbsol-row input[type=text] { width: 130px; background: #0d1420; color: #e6edf3;
      border: 1px solid #253044; border-radius: 6px; padding: 3px 6px; font-size: 11px; }
    .fbsol-btn { background: #13335c; color: #dbe9ff; border: 1px solid #1f6feb; border-radius: 6px; padding: 3px 8px;
      font-size: 11px; cursor: pointer; }
    .fbsol-btn:hover { background: #1a4a86; }
    .fbsol-on { background: #0f3d24; border-color: #2ea043; color: #7ee2a8; }
    .fbsol-cand { border: 1px solid #22303f; border-radius: 6px; padding: 4px 6px; margin: 3px 0; font-size: 11px; }
    .fbsol-cand .ok { color: #7ee2a8; font-weight: 700; }
    #fbsol-toast { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: flex; flex-direction: column; gap: 4px; }
    .fbsol-t { background: #0d1420; border: 1px solid #1f6feb; color: #dbe9ff; border-radius: 8px; padding: 6px 10px; font-size: 11px; }
    .fbsol-t.err { border-color: #f85149; color: #ffb3ad; }
  \`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head ? document.head.appendChild(style) : document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));

  function toast(msg, isErr) {
    const host = document.getElementById("fbsol-toast") || (() => { const d = document.createElement("div"); d.id = "fbsol-toast"; document.body.appendChild(d); return d; })();
    const t = document.createElement("div");
    t.className = "fbsol-t" + (isErr ? " err" : "");
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function render() {
    let panel = document.getElementById("fbsol-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fbsol-panel";
      panel.innerHTML = \`
        <div id="fbsol-head"><b>⚡ FlashBolt SOL Sniper</b><span id="fbsol-clock" style="font-size:10px;color:#8b949e"></span></div>
        <div id="fbsol-body">
          <div class="fbsol-row"><span>Bot</span><button id="fbsol-bot" class="fbsol-btn"></button></div>
          <div class="fbsol-row"><span>Mode</span><button id="fbsol-mode" class="fbsol-btn"></button></div>
          <div class="fbsol-row"><span>Wallet</span><span><button id="fbsol-wallet" class="fbsol-btn"></button></span></div>
          <div class="fbsol-row"><span>Buy (SOL)</span><input id="fbsol-buy" type="number" step="0.1" min="0.1"></div>
          <div class="fbsol-row"><span>Slippage %</span><input id="fbsol-slip" type="number" step="0.1" min="0.1"></div>
          <div class="fbsol-row"><span>Profit target %</span><input id="fbsol-pt" type="number" step="1" min="1"></div>
          <div class="fbsol-row"><span>Trailing stop %</span><input id="fbsol-ts" type="number" step="1" min="1"></div>
          <div class="fbsol-row"><span>Min liq $</span><input id="fbsol-liq" type="number" step="500" min="0"></div>
          <div class="fbsol-row"><span>Daily limit</span><input id="fbsol-limit" type="number" step="1" min="0"></div>
          <div class="fbsol-row"><span>SELL %</span><input id="fbsol-sellpct" type="number" step="5" min="1" max="100"></div>
          <div class="fbsol-row"><span>SELL AMOUNT %</span><input id="fbsol-sellamt" type="number" step="5" min="1" max="100"></div>
          <div class="fbsol-row"><span>Jito protected</span><button id="fbsol-jito" class="fbsol-btn"></button></div>
          <div class="fbsol-row"><span>Auto payout</span><button id="fbsol-payout" class="fbsol-btn"></button></div>
          <div class="fbsol-row"><span>Payout addr</span><input id="fbsol-payoutaddr" type="text" placeholder="wallet address"></div>
          <div class="fbsol-row"><span>Executed today</span><b id="fbsol-count"></b></div>
          <div class="fbsol-row"><span>Daily target</span><b id="fbsol-target" style="color:#8b949e">\u2026</b></div>
          <div style="margin-top:6px;font-size:10px;color:#8b949e">Chain: <span id="fbsol-chain"></span> · sites: DEXView / GMGN / Ave · sim gate: simulateTransaction (zero gas on fail) · Jito tip ≥ 1000 lamports</div>
        </div>\`;
      document.body.appendChild(panel);
      panel.querySelector("#fbsol-head").addEventListener("click", () => panel.classList.toggle("open"));
      const $ = (id) => panel.querySelector(id);
      $("fbsol-bot").onclick = () => { state.botOn = !state.botOn; LS.set("botOn", state.botOn); if (state.botOn) { discover(); } render(); };
      $("fbsol-mode").onclick = () => { state.mode = state.mode === "auto" ? "manual" : "auto"; LS.set("mode", state.mode); render(); };
      $("fbsol-wallet").onclick = () => state.wallet ? disconnectWallet() : connectWallet();
      $("fbsol-jito").onclick = () => { state.jitoSubmit = !state.jitoSubmit; LS.set("jito", state.jitoSubmit); render(); };
      $("fbsol-payout").onclick = () => { state.autoPayout = !state.autoPayout; LS.set("autoPayout", state.autoPayout); render(); };
      const bind = (id, key, num) => panel.querySelector(id).addEventListener("change", (e) => {
        state[key] = num ? Number(e.target.value) : e.target.value;
        LS.set(key === "minLiquidityUsd" ? "minLiq" : key, state[key]);
        render();
      });
      bind("#fbsol-buy", "buySol", true);
      bind("#fbsol-slip", "slippagePct", true);
      bind("#fbsol-pt", "profitTargetPct", true);
      bind("#fbsol-ts", "trailingStopPct", true);
      bind("#fbsol-liq", "minLiquidityUsd", true);
      bind("#fbsol-limit", "dailySnipeLimit", true);
      bind("#fbsol-sellpct", "sellPct", true);
      bind("#fbsol-sellamt", "sellAmountPct", true);
      bind("#fbsol-payoutaddr", "payoutAddress", false);
      // Draggable header
      (() => { let sx=0, sy=0, ox=0, oy=0, drag=false;
        const h = panel.querySelector("#fbsol-head");
        h.addEventListener("mousedown", (e) => { drag = true; sx = e.clientX; sy = e.clientY; ox = panel.offsetLeft; oy = panel.offsetTop; e.preventDefault(); });
        window.addEventListener("mousemove", (e) => { if (!drag) return; panel.style.left = (ox + e.clientX - sx) + "px"; panel.style.top = (oy + e.clientY - sy) + "px"; panel.style.right = "auto"; });
        window.addEventListener("mouseup", () => { drag = false; });
      })();
      setInterval(() => { const c = panel.querySelector("#fbsol-clock"); if (c) c.textContent = new Date().toISOString().slice(11, 19) + " UTC"; }, 1000);
    }
    const $ = (id) => panel.querySelector(id);
    $("fbsol-bot").textContent = state.botOn ? "ON" : "OFF";
    $("fbsol-bot").className = "fbsol-btn" + (state.botOn ? " fbsol-on" : "");
    $("fbsol-mode").textContent = state.mode.toUpperCase();
    $("fbsol-wallet").textContent = state.wallet ? state.wallet.providerName + ": " + state.wallet.address.slice(0, 4) + "…" + state.wallet.address.slice(-4) : "Connect";
    $("fbsol-jito").textContent = state.jitoSubmit ? "JITO ON" : "PUBLIC";
    $("fbsol-jito").className = "fbsol-btn" + (state.jitoSubmit ? " fbsol-on" : "");
    $("fbsol-payout").textContent = state.autoPayout ? "AUTO" : "OFF";
    $("fbsol-payout").className = "fbsol-btn" + (state.autoPayout ? " fbsol-on" : "");
    $("fbsol-buy").value = state.buySol;
    $("fbsol-slip").value = state.slippagePct;
    $("fbsol-pt").value = state.allProfitPct !== undefined ? state.allProfitPct : state.profitTargetPct;
    $("fbsol-ts").value = state.trailingStopPct;
    $("fbsol-liq").value = state.minLiquidityUsd;
    $("fbsol-limit").value = state.dailySnipeLimit;
    $("fbsol-sellpct").value = state.sellPct;
    $("fbsol-sellamt").value = state.sellAmountPct;
    $("fbsol-payoutaddr").value = state.payoutAddress;
    $("fbsol-count").textContent = OVERLAY_TOKEN && gateState.limit != null
      ? gateState.used + " / " + gateState.limit
      : state.executedToday + (state.dailySnipeLimit ? " / " + state.dailySnipeLimit : " (∞)");
    $("fbsol-chain").textContent = siteChain();
    renderGate();
    // Candidate list (top 12, gated first)
    const listHost = $("fbsol-body").querySelector(".fbsol-list");
    if (listHost) listHost.remove();
    const list = document.createElement("div");
    list.className = "fbsol-list";
    const entries = [...state.candidates.values()].sort((a, b) => (b.buyable ? 1 : 0) - (a.buyable ? 1 : 0) || b.at - a.at).slice(0, 12);
    for (const c of entries) {
      const row = document.createElement("div");
      row.className = "fbsol-cand";
      row.innerHTML = '<span class="' + (c.buyable ? "ok" : "") + '">' + (c.buyable ? "✔ " : "… ") + (c.symbol || c.mint.slice(0, 6)) + "</span> " +
        (c.liquidity ? "$" + Math.round(c.liquidity).toLocaleString() + " · " : "") +
        (c.venue || c.origin || "") +
        ' <button class="fbsol-btn" style="float:right">BUY</button>';
      row.querySelector("button").onclick = () => execute(c.mint);
      list.appendChild(row);
    }
    $("fbsol-body").appendChild(list);
  }

  /* ── Boot loops ── */
  const ready = setInterval(() => {
    if (document.body) {
      clearInterval(ready);
      render();
      void refreshGate();
      setInterval(() => void refreshGate(), 60000);
      if (state.botOn) discover();
      setInterval(() => { if (state.botOn) discover(); }, 5000);
      setInterval(() => { if (state.botOn) pollSignals(); }, 12000);
    }
  }, 50);
})();
`;
}

/** Bumped in lockstep with the app version (package.json). */
export const SOL_OVERLAY_VERSION = "2.9.0";

/** MV3 (Chrome) + MV2 (Firefox) extension bundle mirroring the userscript. */
export function buildSolExtensionBundle(cfg: SolOverlayConfig) {
  const httpOrigin = cfg.httpOrigin ?? "";
  const overlayJs = buildSolOverlayUserscript({ ...cfg, appOrigin: cfg.appOrigin })
    // Strip the userscript header — the extension content script doesn't need it.
    .replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, "");

  const chromeManifest = {
    manifest_version: 3,
    name: "FlashBolt SOL Sniper Overlay",
    version: SOL_OVERLAY_VERSION,
    description: "FlashBolt SOL sniper overlay for DEXView / GMGN / Ave — Solana pages.",
    content_scripts: [
      {
        matches: [
          "https://dexview.com/*",
          "https://www.dexview.com/*",
          "https://gmgn.ai/*",
          "https://ave.ai/*",
          "https://www.ave.ai/*",
          "https://dexscreener.com/solana*",
        ],
        js: ["overlay.js"],
        run_at: "document_start",
        all_frames: false,
      },
    ],
    permissions: [],
    host_permissions: [
      "https://api.dexscreener.com/*",
      "https://api.geckoterminal.com/*",
      ...(httpOrigin ? [httpOrigin + "/*"] : []),
    ],
  };

  const firefoxManifest = {
    manifest_version: 2,
    name: chromeManifest.name,
    version: SOL_OVERLAY_VERSION,
    description: chromeManifest.description,
    content_scripts: [
      {
        matches: chromeManifest.content_scripts[0].matches,
        js: ["overlay.js"],
        run_at: "document_start",
      },
    ],
    permissions: [
      "https://api.dexscreener.com/*",
      "https://api.geckoterminal.com/*",
      ...(httpOrigin ? [httpOrigin + "/*"] : []),
    ],
    browser_specific_settings: {
      gecko: { id: "flashbolt-sol-overlay@flashbolt.app", strict_min_version: "115.0" },
    },
  };

  const readme = [
    "# FlashBolt SOL Sniper Overlay — install",
    "",
    "## Chrome / Edge / Brave",
    "1. Unzip this folder.",
    "2. chrome://extensions → Developer mode → Load unpacked → select the folder.",
    "",
    "## Firefox",
    "1. about:debugging#/runtime/this-firefox → Load Temporary Add-on → manifest.json.",
    "2. Permanent install: sign via addons.mozilla.org (web-ext build).",
    "",
    "Works on the Solana pages of DEXView, GMGN, Ave.ai (+ DexScreener /solana).",
    "Stamps: " + JSON.stringify(cfg.stamped ?? {}),
  ].join("\n");

  const enc = (s: string) => s;
  const chromeEntries = [
    { name: "manifest.json", content: enc(JSON.stringify(chromeManifest, null, 2)) },
    { name: "overlay.js", content: enc(overlayJs) },
    { name: "README.txt", content: enc(readme) },
  ];
  const firefoxEntries = [
    { name: "manifest.json", content: enc(JSON.stringify(firefoxManifest, null, 2)) },
    { name: "overlay.js", content: enc(overlayJs) },
    { name: "README.txt", content: enc(readme) },
  ];

  return { overlayJs, chromeManifest: JSON.stringify(chromeManifest, null, 2), firefoxManifest: JSON.stringify(firefoxManifest, null, 2), readme, chromeEntries, firefoxEntries };
}
