// ==UserScript==
// @name         FlashBolt Sniper Overlay — DEXView / GMGN / Ave
// @namespace    flashbolt.overlay
// @version      2.9.0
// @description  Full FlashBolt sniper engine inside DEXView, GMGN and Ave.ai: ON/OFF bot toggle, site-chain auto-sync, instant page-layer capture, buyable AND sellable new-token sniping, real simulated auto buy/sell, automatic payout, UTC world clock.
// @author       FlashBolt
// @match        https://dexscreener.com/*
// @match        https://dexview.com/*
// @match        https://gmgn.ai/*
// @match        https://ave.ai/*
// @match        https://*.dexview.com/*
// @match        https://*.gmgn.ai/*
// @match        https://*.ave.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  if (window.__FLASHBOLT_OVERLOAD__) return;
  window.__FLASHBOLT_OVERLOAD__ = true;

  // Runtime config (stamped by the terminal at export time)
  const APP_ORIGIN = "https://flashbolt.app";
  const HTTP_ORIGIN = "https://flexible-frog-776.convex.site";
  const GATE_URL = HTTP_ORIGIN + "/api/overlay/execution";
  const SIGNALS_URL = HTTP_ORIGIN ? HTTP_ORIGIN + "/api/copier/signals" : "";
  const STAMPED = {};

  /* ── Server-enforced daily target (subscribers only) ──
   * Every snipe consumes a slot from the SAME operator-controlled daily
   * target the terminal uses (default 3/day across arb + snipe on both
   * terminals). The verdict comes from the server — the operator can
   * increase, decrease or block (0) it at any time and every installed
   * overlay obeys on its next snipe. No token (operator/private install):
   * the gate is skipped entirely, matching the terminal's unlimited policy.
   */
  const OVERLAY_TOKEN = STAMPED.overlayToken || "";
  const gateState = { used: 0, limit: null, blocked: false, reason: "" };

  function gateHeaders() {
    const h = { "Content-Type": "application/json" };
    if (OVERLAY_TOKEN) h["X-Flashbolt-Token"] = OVERLAY_TOKEN;
    return h;
  }

  async function refreshGate() {
    if (!OVERLAY_TOKEN) return; // operator/unstamped install — unlimited
    try {
      const r = await fetch(GATE_URL, { headers: gateHeaders() });
      if (r.ok) {
        const j = await r.json();
        gateState.used = j.used || 0;
        gateState.limit = j.limit == null ? null : j.limit;
        gateState.blocked = !!j.blocked;
        gateState.reason = j.reason || "";
        renderGate();
      }
    } catch { /* server unreachable — keep last known state */ }
  }

  /**
   * Consume one daily-target slot. Resolves false (and never executes)
   * when the server says blocked, is unreachable, or the token is invalid.
   */
  async function consumeGateSlot() {
    if (!OVERLAY_TOKEN) return true; // operator/unstamped install — unlimited
    try {
      const r = await fetch(GATE_URL, {
        method: "POST",
        headers: gateHeaders(),
        body: JSON.stringify({ token: OVERLAY_TOKEN }),
      });
      const j = await r.json().catch(() => null);
      if (!j) {
        log("Daily target gate unreachable - snipe aborted for safety", "warn");
        toast("Daily target gate unreachable - snipe aborted", "error");
        return false;
      }
      gateState.used = j.used || 0;
      gateState.limit = j.limit == null ? null : j.limit;
      gateState.blocked = !!j.blocked;
      gateState.reason = j.reason || "";
      renderGate();
      if (j.blocked) {
        log("Daily target: " + (j.reason || "blocked by server"), "warn");
        toast(j.reason || "Daily target reached", "error");
        return false;
      }
      return true;
    } catch {
      log("Daily target gate unreachable - snipe aborted for safety", "warn");
      toast("Daily target gate unreachable - snipe aborted", "error");
      return false;
    }
  }

  function renderGate() {
    const node = $("#fb-target");
    if (!node) return;
    if (!OVERLAY_TOKEN) {
      node.textContent = "Daily target: unlimited";
      node.style.color = "#94a3b8";
    } else if (gateState.limit === 0) {
      node.textContent = "Daily target: BLOCKED (operator)";
      node.style.color = "#f87171";
    } else if (gateState.limit == null) {
      node.textContent = "Daily target: …";
      node.style.color = "#94a3b8";
    } else {
      const exhausted = gateState.used >= gateState.limit;
      node.textContent = "Daily target: " + gateState.used + "/" + gateState.limit + (exhausted ? " — reached" : "");
      node.style.color = exhausted ? "#f87171" : "#94a3b8";
    }
  }

  // ------------------------------- helpers ---------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const fmt = (n, d) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d == null ? 4 : d });

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  }

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("fb_overlay_" + key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem("fb_overlay_" + key, JSON.stringify(value)); } catch {} },
  };

  // ---------------------------- chain registry -----------------------------
  const CHAINS = [
  {
    "key": "bsc",
    "chainId": 56,
    "label": "BNB Smart Chain",
    "router": "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    "wrapped": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    "nativeSymbol": "BNB",
    "rpc": "https://bsc-dataseed.binance.org"
  },
  {
    "key": "ethereum",
    "chainId": 1,
    "label": "Ethereum",
    "router": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    "wrapped": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "nativeSymbol": "ETH",
    "rpc": "https://1rpc.io/eth"
  },
  {
    "key": "arbitrum",
    "chainId": 42161,
    "label": "Arbitrum One",
    "router": "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    "wrapped": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "nativeSymbol": "ETH",
    "rpc": "https://arb1.arbitrum.io/rpc"
  },
  {
    "key": "polygon",
    "chainId": 137,
    "label": "Polygon",
    "router": "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
    "wrapped": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    "nativeSymbol": "POL",
    "rpc": "https://polygon-bor-rpc.publicnode.com"
  }
];
  const byChainId = new Map(CHAINS.map((c) => [c.chainId, c]));
  const byKey = new Map(CHAINS.map((c) => [c.key, c]));

  // ------------- site -> chain auto-sync (DEXView/GMGN/Ave) ----------------
  // Real URL slugs each site uses. The overlay follows the site's chain page
  // - the stamped default applies only when nothing in the URL maps.
  const SITE_SLUGS = {
    bsc: "bsc", eth: "ethereum", ethereum: "ethereum", arb: "arbitrum",
    arbitrum: "arbitrum", polygon: "polygon", poly: "polygon",
    matic: "polygon", polygon_pos: "polygon",
  };
  const SITE_HOSTS = ["dexscreener.com", "dexview.com", "gmgn.ai", "ave.ai"];
  // ave.ai nests its chain at /chain/<slug>; everything else uses /<slug>.
  function chainFromSite() {
    const host = location.hostname.replace(/^www\./, "");
    if (!SITE_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
    const parts = location.pathname.split("/").filter(Boolean);
    const chainSeg = parts[0] === "chain" ? parts[1] : parts[0];
    if (!chainSeg) return null;
    const key = SITE_SLUGS[chainSeg.toLowerCase()];
    return key ? byKey.get(key) || null : null;
  }

  // -------------------------------- settings -------------------------------
  const SETTINGS_KEY = "settings_v2";
  const DEFAULT_SETTINGS = {
    botOn: true,
    chainKey: STAMPED.chainKey || "bsc",
    mode: "auto",
    buyAmount: STAMPED.buyAmountNative != null ? STAMPED.buyAmountNative : 0.01,
    sellPct: STAMPED.sellPct != null ? STAMPED.sellPct : 100,
    sellAmountPct: STAMPED.sellAmountPct != null ? STAMPED.sellAmountPct : 100,
    slippagePct: STAMPED.slippagePct != null ? STAMPED.slippagePct : 3,
    minTargetProfit: STAMPED.profitTargetPct != null ? STAMPED.profitTargetPct : 10,
    trailingStopPct: STAMPED.trailingStopPct != null ? STAMPED.trailingStopPct : 5,
    maxGasPrice: STAMPED.maxGasPriceGwei != null ? STAMPED.maxGasPriceGwei : 5,
    minLiquidityUsd: STAMPED.minLiquidityUsd != null ? STAMPED.minLiquidityUsd : 250,
    maxPairAgeHours: 24,
    minSecurityScore: 60,
    dailySnipeLimit: 3,
    autoPayout: STAMPED.autoPayout != null ? STAMPED.autoPayout : true,
    payoutAddress: STAMPED.payoutAddress || "",
  };
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get(SETTINGS_KEY, {}));
  // First-run: apply the terminal's stamped settings exactly, then the user
  // owns them (panel edits persist; re-export from the terminal re-stamps).
  if (!store.get("stamped_v2", false)) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
    store.set("stamped_v2", true);
    saveSettings();
  }

  // ------------------------------ stats/state ------------------------------
  const stats = store.get("stats_v1", { wins: 0, losses: 0, realizedPct: 0, lastDay: new Date().toDateString(), snipesToday: 0 });
  if (stats.lastDay !== new Date().toDateString()) {
    stats.lastDay = new Date().toDateString();
    stats.snipesToday = 0;
  }
  const persistStats = () => store.set("stats_v1", stats);
  const busy = new Set();
  const seen = new Map();
  const positions = [];
  const positionsKey = "positions_v1";
  (store.get(positionsKey, [])).forEach((p) => p.status === "holding" && positions.push(p));
  const persistPositions = () => store.set(positionsKey, positions.filter((p) => p.status === "holding"));

  // ---------------------------- wallet connect -----------------------------
  let account = null;

  async function connectWallet() {
    if (!window.ethereum) { toast("No injected wallet found - install MetaMask/OKX/Trust.", "error"); return; }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = accounts && accounts[0];
      if (account) {
        log("Wallet connected: " + account);
        toast("Wallet connected: " + short(account), "success");
        renderWallet();
      }
    } catch (e) { toast("Wallet connect rejected.", "error"); }
  }

  async function ensureChain(chain) {
    const target = "0x" + chain.chainId.toString(16);
    const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
    if (current === chain.chainId) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
    } catch (e) {
      if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized"))) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: target,
            chainName: chain.label,
            nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
            rpcUrls: [chain.rpc],
            blockExplorerUrls: [],
          }],
        });
      } else { throw e; }
    }
  }

  const short = (a) => a && a.length > 12 ? a.slice(0, 6) + "..." + a.slice(-4) : a || "-";

  // --------------------------- engine: sources -----------------------------
  // SAME live sources the terminal's multi-signal monitor uses - real APIs,
  // real tokens; each hit is a genuine new-listing candidate.

  async function jget(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  async function sourceDexScreenerSearch(chain) {
    const queries = { bsc: ["bsc meme", "bsc new", "WBNB USDT"], ethereum: ["ETH USDT", "ethereum new"], polygon: ["WMATIC USDT", "polygon new"], arbitrum: ["WETH USDC", "arbitrum new"] }[chain.key] || ["new"];
    const out = [];
    const results = await Promise.allSettled(queries.map((q) =>
      jget("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q)).then((d) => (d && d.pairs) || []),
    ));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const p of r.value) {
        if (p.chainId !== chain.key || !p.baseToken || !p.baseToken.address) continue;
        out.push({
          address: p.baseToken.address.toLowerCase(),
          symbol: p.baseToken.symbol || "???",
          name: p.baseToken.name || "Unknown",
          pairAddress: p.pairAddress,
          dexId: p.dexId,
          priceUsd: Number(p.priceUsd) || 0,
          liquidityUsd: (p.liquidity && p.liquidity.usd) || 0,
          volume24h: (p.volume && p.volume.h24) || 0,
          pairCreatedAt: p.pairCreatedAt || 0,
          buys: p.txns && p.txns.m5 ? (p.txns.m5.buys || 0) : 0,
          sells: p.txns && p.txns.m5 ? (p.txns.m5.sells || 0) : 0,
          source: "dexscreener",
        });
      }
    }
    return out;
  }

  async function sourceDexScreenerProfiles(chain) {
    try {
      const profiles = await jget("https://api.dexscreener.com/token-profiles/latest/v1");
      if (!Array.isArray(profiles)) return [];
      const addresses = profiles.filter((p) => p.chainId === chain.key && p.tokenAddress).slice(0, 30).map((p) => p.tokenAddress);
      if (!addresses.length) return [];
      const tokens = [];
      for (let i = 0; i < addresses.length; i += 30) {
        const d = await jget("https://api.dexscreener.com/tokens/v1/" + chain.key + "/" + addresses.slice(i, i + 30).join(","));
        (d && d.pairs ? d.pairs : []).forEach((p) => {
          if (!p.baseToken || !p.baseToken.address) return;
          tokens.push({
            address: p.baseToken.address.toLowerCase(),
            symbol: p.baseToken.symbol || "???",
            name: p.baseToken.name || "Unknown",
            pairAddress: p.pairAddress,
            dexId: p.dexId,
            priceUsd: Number(p.priceUsd) || 0,
            liquidityUsd: (p.liquidity && p.liquidity.usd) || 0,
            volume24h: (p.volume && p.volume.h24) || 0,
            pairCreatedAt: p.pairCreatedAt || 0,
            buys: p.txns && p.txns.m5 ? (p.txns.m5.buys || 0) : 0,
            sells: p.txns && p.txns.m5 ? (p.txns.m5.sells || 0) : 0,
            source: "ds-profiles",
          });
        });
      }
      return tokens;
    } catch { return []; }
  }

  const GECKO_NETWORKS = { bsc: "bsc", ethereum: "eth", polygon: "polygon_pos", arbitrum: "arbitrum" };

  async function sourceGeckoTerminal(chain) {
    const net = GECKO_NETWORKS[chain.key];
    const pages = await Promise.allSettled([
      jget("https://api.geckoterminal.com/api/v2/networks/" + net + "/new_pools?page=1&include=base_token%2Cquote_token"),
      jget("https://api.geckoterminal.com/api/v2/networks/" + net + "/trending_pools?page=1&include=base_token%2Cquote_token"),
    ]);
    const out = [];
    for (const pr of pages) {
      if (pr.status !== "fulfilled" || !pr.value || !pr.value.data) continue;
      const attrsById = new Map((pr.value.included || []).map((inc) => [inc.id, inc.attributes]));
      for (const pool of pr.value.data) {
        const rel = pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data;
        if (!rel) continue;
        const tok = attrsById.get(rel.id);
        if (!tok || !tok.address) continue;
        out.push({
          address: tok.address.toLowerCase(),
          symbol: tok.symbol || "???",
          name: tok.name || "Unknown",
          pairAddress: pool.attributes && pool.attributes.address,
          dexId: pool.attributes && pool.attributes.dex,
          priceUsd: Number((pool.attributes && pool.attributes.base_token_price_usd) || 0) || 0,
          liquidityUsd: Number((pool.attributes && pool.attributes.reserve_in_usd) || 0) || 0,
          volume24h: Number((pool.attributes && pool.attributes.volume_usd && pool.attributes.volume_usd.h24) || 0) || 0,
          pairCreatedAt: pool.attributes ? Date.parse(pool.attributes.pool_created_at || "") || 0 : 0,
          buys: 0, sells: 0,
          source: "geckoterminal",
        });
      }
    }
    return out;
  }

  const ALL_SOURCES = [sourceDexScreenerSearch, sourceDexScreenerProfiles, sourceGeckoTerminal];

  // ------------- instant page-layer capture (sub-ms first hook) ------------
  // Brand-new tokens often appear on the SITE before any indexer API knows
  // about them. Two layers:
  //   1. MutationObserver - fires the instant a node carrying an 0x address
  //      is inserted (sub-millisecond from render; catches streaming rows).
  //   2. 1.5s poll of anchors/data-attrs - safety net for SPA swaps.
  // Addresses are enriched via the DexScreener tokens API on the SITE chain.

  const DOM_ADDR_RE = /0x[a-fA-F0-9]{40}/g;
  const pendingDom = new Set();
  const enrichedRecently = new Set();

  function harvestFromNode(node) {
    try {
      if (!node || node.nodeType !== 1) return;
      const roots = [node];
      if (node.matches && node.matches('a[href*="0x"], [data-address], [data-token-address], [data-contract]')) roots.push(node);
      for (const root of roots) {
        const links = root.querySelectorAll('a[href*="0x"], [data-address], [data-token-address], [data-contract]');
        links.forEach((a) => {
          const href = a.getAttribute("href") || "";
          const data = a.getAttribute("data-address") || a.getAttribute("data-token-address") || a.getAttribute("data-contract");
          const text = a.textContent || "";
          const m = href.match(DOM_ADDR_RE);
          if (m) m.forEach((x) => pendingDom.add(x.toLowerCase()));
          if (data && DOM_ADDR_RE.test(data)) pendingDom.add(data.toLowerCase());
          const tm = text.match(DOM_ADDR_RE);
          if (tm) tm.forEach((x) => pendingDom.add(x.toLowerCase()));
        });
      }
    } catch {}
  }

  function startObserver() {
    try {
      const obs = new MutationObserver((muts) => {
        if (!settings.botOn) return;
        let hit = false;
        for (const m of muts) {
          if (m.type === "childList" && m.addedNodes && m.addedNodes.length) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) { harvestFromNode(n); hit = true; }
            }
          }
        }
        if (hit) scheduleDomFlush();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  let domFlushTimer = null;
  function scheduleDomFlush() {
    if (domFlushTimer) return;
    domFlushTimer = setTimeout(() => { domFlushTimer = null; void flushDomQueue(); }, 120);
  }

  async function flushDomQueue() {
    if (!settings.botOn || pendingDom.size === 0) return;
    const fresh = [...pendingDom].filter((a) => !seen.has(a) && !enrichedRecently.has(a)).slice(0, 60);
    fresh.forEach((a) => enrichedRecently.add(a));
    if (enrichedRecently.size > 2000) enrichedRecently.clear();
    if (!fresh.length) return;
    const chain = activeChain();
    for (let i = 0; i < fresh.length; i += 30) {
      const chunk = fresh.slice(i, i + 30);
      const d = await jget("https://api.dexscreener.com/tokens/v1/" + chain.key + "/" + chunk.join(","));
      (d && d.pairs ? d.pairs : []).forEach((p) => {
        if (!p.baseToken || !p.baseToken.address) return;
        const t = {
          address: p.baseToken.address.toLowerCase(),
          symbol: p.baseToken.symbol || "???",
          name: p.baseToken.name || "Unknown",
          pairAddress: p.pairAddress,
          dexId: p.dexId,
          priceUsd: Number(p.priceUsd) || 0,
          liquidityUsd: (p.liquidity && p.liquidity.usd) || 0,
          volume24h: (p.volume && p.volume.h24) || 0,
          pairCreatedAt: p.pairCreatedAt || 0,
          buys: p.txns && p.txns.m5 ? (p.txns.m5.buys || 0) : 0,
          sells: p.txns && p.txns.m5 ? (p.txns.m5.sells || 0) : 0,
          source: "page-harvest",
        };
        if (!seen.has(t.address)) admitCandidate(t);
      });
    }
  }

  // ------------------------- engine: capture + gates -----------------------
  // (Gates live in passesGates; copier signals enter through admitCandidate
  // below and skip the indexer gates on purpose — their verdict comes from
  // the pre-broadcast simulation.)
  // Gates mirror the terminal's sniper: liquidity floor, brand-new window,
  // buy pressure, honeypot heuristics, consensus score. Only tokens that
  // pass ALL gates are surfaced (manual) or auto-bought (auto mode).

  function ageHours(pairCreatedAt) {
    if (!pairCreatedAt) return 999;
    return (now() - pairCreatedAt) / 3600000;
  }

  function securityScore(t) {
    let score = 50;
    if (t.liquidityUsd >= settings.minLiquidityUsd * 4) score += 20;
    else if (t.liquidityUsd >= settings.minLiquidityUsd) score += 10;
    else score -= 40;
    if (t.buys > t.sells * 1.5) score += 15;
    if (t.volume24h > 10000) score += 10;
    if (t.source === "geckoterminal") score += 5;
    if (t.source === "page-harvest") score += 8;
    if (ageHours(t.pairCreatedAt) < 1) score += 5;
    return Math.max(0, Math.min(100, score));
  }

  function passesGates(t) {
    if (!t.address || seen.has(t.address)) return false;
    // Copier signals come straight from the watched Telegram channels —
    // they bypass the indexer-data gates (the channels post listings BEFORE
    // any pool data exists) and are gated by the real check: the full
    // eth_estimateGas + eth_call simulation before any broadcast.
    if (t.source !== "copier") {
      if (t.liquidityUsd < settings.minLiquidityUsd) return false;
      if (ageHours(t.pairCreatedAt) > settings.maxPairAgeHours) return false;
      if (t.buys > 0 && t.sells > t.buys * 3) return false;
      if (securityScore(t) < settings.minSecurityScore) return false;
      // Honeypot heuristics (the REAL sell check is the pre-broadcast
      // simulation): zero-buy tokens and missing pair data.
      if (t.volume24h === 0 && t.buys === 0) return false;
    }
    return true;
  }

  let latestCandidates = [];
  let lastCaptureAt = 0;

  // Admit a gated candidate to LIVE CANDIDATES instantly (capture + render).
  function admitCandidate(t) {
    if (!passesGates(t)) return;
    seen.set(t.address, now());
    lastCaptureAt = now();
    latestCandidates = [t, ...latestCandidates.filter((c) => c.address !== t.address)].slice(0, 25);
    renderCandidates();
    setIndicator("ACTIVE");
    maybeAutoBuy();
  }

  // ------------------- copier signals (Telegram channels) -------------------
  // The FlashBolt Copier bot copies t.me/AveSignalMonitor +
  // t.me/BSCnewtokenspairs posts server-side; the overlay polls the public
  // feed and pastes every buyable signal into LIVE CANDIDATES through the
  // normal capture path — same gates, same auto/manual execution, same
  // payout flow.
  let lastSignalsFetch = 0;
  async function pollSignals() {
    if (!SIGNALS_URL) return;
    if (now() - lastSignalsFetch < 25000) return;
    lastSignalsFetch = now();
    try {
      const d = await jget(SIGNALS_URL);
      const list = (d && d.signals) || [];
      for (const s of list) {
        if (!s.address || seen.has(s.address)) continue;
        const chain = byKey.get(s.chain);
        if (!chain) continue;
        admitCandidate({
          address: s.address.toLowerCase(),
          symbol: s.symbol || "???",
          name: s.name || s.symbol || "Copier signal",
          pairAddress: "",
          dexId: "copier",
          priceUsd: s.priceUsd || 0,
          liquidityUsd: s.liquidityUsd || 0,
          volume24h: 0,
          pairCreatedAt: s.capturedAt || now(),
          buys: 1, sells: 0,
          source: "copier",
        });
      }
      if (list.length) log("Copier: " + list.length + " signal(s) checked, pasted new ones into LIVE CANDIDATES");
    } catch (e) {
      // Feed unreachable — the site-layer capture still runs; retry next cycle.
    }
  }

  function activeChain() {
    // Site auto-sync first: the chain page the operator browses wins.
    const site = chainFromSite();
    if (site) {
      if (settings.chainKey !== site.key) {
        settings.chainKey = site.key;
        saveSettings();
        const sel = $("#fb-chain");
        if (sel) sel.value = site.key;
        log("Site auto-sync: chain -> " + site.label + " (" + location.hostname + ")");
      }
      return site;
    }
    return byKey.get(settings.chainKey) || CHAINS[0];
  }

  async function scanCycle() {
    const chain = activeChain();
    const results = await Promise.allSettled(ALL_SOURCES.map((fn) => fn(chain)));
    const merged = new Map();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const t of r.value) {
        const prev = merged.get(t.address);
        if (!prev || t.liquidityUsd > prev.liquidityUsd) merged.set(t.address, t);
      }
    }
    for (const t of merged.values()) {
      if (!seen.has(t.address)) admitCandidate(t);
    }
    renderPositions();
  }

  // --------------------- engine: simulated execution -----------------------
  // Router calldata (UniV2 Router02 - identical selectors on every chain).

  const SWAP_SELECTORS = {
    swapETHForTokens: "0xb6f9de95",
    swapTokensForETH: "0x791ac947",
    quote: "0xd06ca61f",
    approve: "0x095ea7b3",
  };

  // ABI encoding
  function pad32(hexNo0x) { return hexNo0x.padStart(64, "0"); }
  function encodeAddress(addr) { return pad32(addr.toLowerCase().replace(/^0x/, "")); }
  function encodeUint(v) { return pad32(BigInt(v).toString(16)); }
  function encodeAddressArray(arr) {
    const head = encodeUint(32) + encodeUint(arr.length);
    return head + arr.map(encodeAddress).join("");
  }

  // keccak-256 (flat, standalone - passes standard vectors)
  const KECCAK_RC = [0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,0x8000000080008081n,0x8000000080008080n,0x0000000080000001n,0x8000000080008008n];
  const KECCAK_ROT = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];

  const rotl64 = (x, n) => {
    const mask = (1n << 64n) - 1n;
    n %= 64n;
    return ((x << n) | (x >> (64n - n))) & mask;
  };

  function keccakF(state) {
    for (let round = 0; round < 24; round++) {
      const C = new Array(5).fill(0n);
      for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      for (let x = 0; x < 5; x++) {
        const d = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n);
        for (let y = 0; y < 25; y += 5) state[y + x] ^= d;
      }
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const idx = x + 5 * y;
          const nx = y, ny = (2 * x + 3 * y) % 5;
          B[nx + 5 * ny] = rotl64(state[idx], BigInt(KECCAK_ROT[x][y]));
        }
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) state[y + x] = B[y + x] ^ ((~B[y + ((x + 1) % 5)]) & B[y + ((x + 2) % 5)]);
      }
      state[0] ^= KECCAK_RC[round];
    }
  }

  function keccak256(inputBytes) {
    const state = new Array(25).fill(0n);
    const rate = 136;
    const bytes = Array.from(inputBytes);
    const q = rate - (bytes.length % rate);
    const pad = new Array(q).fill(0);
    pad[0] = 0x01;
    pad[q - 1] |= 0x80;
    const padded = bytes.concat(pad);
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let b = 0; b < 8; b++) lane |= BigInt(padded[off + i * 8 + b]) << BigInt(8 * b);
        state[i] ^= lane;
      }
      keccakF(state);
    }
    const out = [];
    for (let b = 0; b < 32; b++) out.push(Number((state[Math.floor(b / 8)] >> BigInt(8 * (b % 8))) & 0xffn));
    return "0x" + out.map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------- engine: on-chain primitives ----------------------

  async function rpc(rpcUrl, method, params) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  }

  // FULL pre-flight simulation: eth_estimateGas then eth_call of the exact
  // calldata. Nothing is broadcast when either fails -> ZERO gas spent on a
  // failed buy/sell. Same dual gate the terminal uses.
  async function simulateAndSend(chain, tx) {
    const from = account;
    const simTx = { from, to: tx.to, data: tx.data };
    if (tx.value && tx.value !== "0x0") simTx.value = tx.value;
    try {
      await rpc(chain.rpc, "eth_estimateGas", [Object.assign({ gas: "0x1e8480" }, simTx)]);
    } catch (e) {
      const reason = (e && e.message) || "simulation failed";
      log("SIM FAILED (zero gas spent): " + reason, "error");
      return { ok: false, reason };
    }
    try {
      await rpc(chain.rpc, "eth_call", [simTx, "latest"]);
    } catch (e) {
      const reason = (e && e.message) || "eth_call failed";
      log("SIM FAILED (zero gas spent): " + reason, "error");
      return { ok: false, reason };
    }
    try {
      const hash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from, to: tx.to, data: tx.data, value: tx.value || "0x0" }],
      });
      return { ok: true, hash };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || "wallet rejected" };
    }
  }

  async function gasPriceGwei(chain) {
    try {
      const wei = await rpc(chain.rpc, "eth_gasPrice", []);
      return Number(BigInt(wei)) / 1e9;
    } catch { return null; }
  }

  async function getQuote(chain, amountInWei, path) {
    const data = SWAP_SELECTORS.quote + encodeUint(amountInWei) + pad32(64 + 32) + pad32(path.length) + path.map(encodeAddress).join("");
    const out = await rpc(chain.rpc, "eth_call", [{ to: chain.router, data }, "latest"]);
    const hex = out.slice(2);
    const count = parseInt(hex.slice(0, 64), 16);
    const lastOffset = 64 * (count);
    return BigInt("0x" + hex.slice(lastOffset, lastOffset + 64));
  }

  async function getTokenDecimals(chain, token) {
    const out = await rpc(chain.rpc, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
    return parseInt(out.slice(2), 16);
  }

  async function getTokenBalance(chain, token, owner) {
    const data = "0x70a08231" + encodeAddress(owner);
    const out = await rpc(chain.rpc, "eth_call", [{ to: token, data }, "latest"]);
    return BigInt(out);
  }

  async function getAllowance(chain, token, owner, spender) {
    const data = "0xdd62ed3e" + encodeAddress(owner) + encodeAddress(spender);
    const out = await rpc(chain.rpc, "eth_call", [{ to: token, data }, "latest"]);
    return BigInt(out);
  }

  async function sendTx(chain, to, data, value) {
    try {
      return await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: value || "0x0" }] });
    } catch (e) { throw e; }
  }

  async function waitForReceipt(chain, hash, timeoutMs) {
    const start = now();
    while (now() - start < (timeoutMs || 180000)) {
      try {
        const r = await rpc(chain.rpc, "eth_getTransactionReceipt", [hash]);
        if (r) return { status: r.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(r.gasUsed || "0x0") };
      } catch {}
      await sleep(2000);
    }
    return { status: "timeout" };
  }

  // ---------------------- engine: buy / sell / payout ----------------------

  async function buyToken(t) {
    const chain = byKey.get(t.chainKey || settings.chainKey) || CHAINS[0];
    if (!account) { toast("Connect the wallet first.", "error"); return false; }
    if (busy.has(t.address)) return false;
    busy.add(t.address);
    try {
      // SERVER-ENFORCED DAILY TARGET — consumed BEFORE any quote/sim/gas
      // work. Blocked, exhausted or unreachable ⇒ no execution, zero gas.
      if (!(await consumeGateSlot())) return false;
      if (settings.dailySnipeLimit > 0 && stats.snipesToday >= settings.dailySnipeLimit) {
        log("Daily snipe limit reached (" + stats.snipesToday + "/" + settings.dailySnipeLimit + ")", "warn");
        return false;
      }
      const gwei = await gasPriceGwei(chain);
      if (gwei !== null && gwei > settings.maxGasPrice) {
        log("Gas " + gwei.toFixed(1) + " > max " + settings.maxGasPrice + " gwei - skipped " + t.symbol, "warn");
        return false;
      }
      await ensureChain(chain);
      const amountInWei = BigInt(Math.round(settings.buyAmount * 1e9)) * 1000000000n;
      const path = [chain.wrapped, t.address];
      const quoted = await getQuote(chain, amountInWei, path);
      const minOut = (quoted * BigInt(10000 - Math.round(settings.slippagePct * 100))) / 10000n;
      const properData = buildSwapETHData(minOut, path, account, Math.floor(now() / 1000) + 180);
      const sim = await simulateAndSend(chain, { to: chain.router, data: properData, value: "0x" + amountInWei.toString(16) });
      if (!sim.ok) { fail(t, sim.reason); return false; }
      const receipt = await waitForReceipt(chain, sim.hash);
      if (receipt.status !== "success") { fail(t, "reverted on-chain"); return false; }
      const decimals = await getTokenDecimals(chain, t.address);
      const bal = await getTokenBalance(chain, t.address, account);
      positions.push({
        id: "pos-" + now(),
        symbol: t.symbol, address: t.address, chain: chain.key,
        buyPriceUsd: t.priceUsd, buyAmountNative: settings.buyAmount,
        tokensWei: bal.toString(), decimals,
        buyTs: now(), sellPct: settings.sellPct, sellAmountPct: settings.sellAmountPct,
        peakUsd: t.priceUsd,
        status: "holding",
      });
      persistPositions();
      stats.snipesToday += 1; stats.wins += 1; persistStats();
      log("BOUGHT " + t.symbol + " - tx " + short(sim.hash) + " - auto-sell armed at +" + settings.minTargetProfit + "%", "success");
      toast("Sniped " + t.symbol, "success");
      renderWallet();
      return true;
    } catch (e) {
      fail(t, (e && e.message) || "buy error");
      return false;
    } finally { busy.delete(t.address); }
  }

  function buildSwapETHData(minOut, path, to, deadlineSecs) {
    const head0 = encodeUint(minOut);
    const arrOffset = encodeUint(4 * 32);
    const head2 = encodeAddress(to);
    const head3 = encodeUint(deadlineSecs);
    const arr = encodeAddressArray(path);
    return SWAP_SELECTORS.swapETHForTokens + head0 + arrOffset + head2 + head3 + arr;
  }

  function buildSwapTokensData(amountIn, minOut, path, to, deadlineSecs) {
    const head0 = encodeUint(amountIn);
    const head1 = encodeUint(minOut);
    const arrOffset = encodeUint(6 * 32);
    const head3 = encodeAddress(to);
    const head4 = encodeUint(deadlineSecs);
    const arr = encodeAddressArray(path);
    return SWAP_SELECTORS.swapTokensForETH + head0 + head1 + arrOffset + head3 + head4 + arr;
  }

  function fail(t, reason) {
    stats.losses += 1; persistStats();
    log(t.symbol + " - " + reason + " (zero gas spent on sim-fail)", "error");
    renderWallet();
  }

  async function sellPosition(pos, livePriceUsd) {
    const chain = byKey.get(pos.chain) || CHAINS[0];
    if (!account) return;
    try {
      const bal = BigInt(pos.tokensWei || "0");
      if (bal <= 0n) { pos.status = "sold"; persistPositions(); return; }
      // Effective disposal: sell % (position share) x SELL AMOUNT % (share of
      // that slice), clamped to 1-100% so a partial exit can never overdraw.
      const basePct = Math.max(1, Math.min(100, pos.sellPct));
      const amtPct = Math.max(1, Math.min(100, pos.sellAmountPct == null ? 100 : pos.sellAmountPct));
      const pct = (basePct * amtPct) / 100;
      const amountIn = (bal * BigInt(Math.floor(pct))) / 100n;
      const path = [pos.address, chain.wrapped];
      const quoted = await getQuote(chain, amountIn, path);
      const minOut = (quoted * BigInt(10000 - Math.round(settings.slippagePct * 100))) / 10000n;
      const deadline = Math.floor(now() / 1000) + 180;
      const allowance = await getAllowance(chain, pos.address, account, chain.router);
      if (allowance < amountIn) {
        const approveData = SWAP_SELECTORS.approve + encodeAddress(chain.router) + encodeUint(amountIn);
        const aSim = await simulateAndSend(chain, { to: pos.address, data: approveData });
        if (!aSim.ok) { log("Approve sim failed - sell aborted (zero gas): " + pos.symbol, "error"); return; }
        await sendTx(chain, pos.address, approveData);
        await sleep(2500);
      }
      const data = buildSwapTokensData(amountIn, minOut, path, account, deadline);
      const sim = await simulateAndSend(chain, { to: chain.router, data });
      if (!sim.ok) { fail(pos, sim.reason); return; }
      const receipt = await waitForReceipt(chain, sim.hash);
      if (receipt.status !== "success") { fail(pos, "sell reverted"); return; }
      const pnl = pos.buyPriceUsd > 0 ? ((livePriceUsd - pos.buyPriceUsd) / pos.buyPriceUsd) * 100 : 0;
      pos.status = "sold";
      stats.realizedPct += pnl;
      stats.wins += 1; persistStats();
      persistPositions();
      log("SOLD " + pos.symbol + " - PnL " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%", "success");
      // Automatic payout
      if (settings.autoPayout && settings.payoutAddress && pnl > 0) {
        const profitNative = pos.buyAmountNative * (pnl / 100) * 0.95;
        if (profitNative > 0.0002) {
          await payoutNative(chain, settings.payoutAddress, profitNative);
        }
      }
      renderWallet();
      renderPositions();
    } catch (e) {
      fail(pos, (e && e.message) || "sell error");
    }
  }

  async function payoutNative(chain, to, amountNative) {
    const value = "0x" + (BigInt(Math.round(amountNative * 1e9)) * 1000000000n).toString(16);
    const sim = await simulateAndSend(chain, { to, data: "0x", value });
    if (!sim.ok) { log("Payout sim failed - zero gas spent.", "error"); return; }
    const hash = await sendTx(chain, to, "0x", value);
    log("Payout sent: " + amountNative.toFixed(4) + " " + chain.nativeSymbol + " -> " + short(to), "success");
    await waitForReceipt(chain, hash);
  }

  // -------------------- auto-sell monitor (live prices) --------------------

  async function livePrice(address) {
    try {
      const d = await jget("https://api.dexscreener.com/latest/dex/tokens/" + address);
      if (!d || !d.pairs) return null;
      let best = null;
      for (const p of d.pairs) {
        const price = Number(p.priceUsd);
        if (!Number.isFinite(price) || price <= 0) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        if (!best || liq > best.liq) best = { price, liq };
      }
      return best ? best.price : null;
    } catch { return null; }
  }

  setInterval(async () => {
    if (!settings.botOn) return;
    for (const pos of positions.slice()) {
      if (pos.status !== "holding") continue;
      const live = await livePrice(pos.address);
      if (!live) continue;
      const pnl = pos.buyPriceUsd > 0 ? ((live - pos.buyPriceUsd) / pos.buyPriceUsd) * 100 : 0;
      pos.peakUsd = Math.max(pos.peakUsd || live, live);
      const peakDrop = pos.peakUsd > 0 ? ((pos.peakUsd - live) / pos.peakUsd) * 100 : 0;
      if (pnl >= settings.minTargetProfit) void sellPosition(pos, live);
      else if (pos.peakUsd > pos.buyPriceUsd && peakDrop >= settings.trailingStopPct) void sellPosition(pos, live);
      else if (now() - pos.buyTs > 30 * 60000 && pnl < 0) void sellPosition(pos, live);
    }
    renderPositions();
  }, 3000);

  // ------------------------------- UI panel --------------------------------

  const PANEL_ID = "flashbolt-overlay-panel";

  function panel() { return document.getElementById(PANEL_ID); }

  function toast(msg, kind) {
    const t = el("div", {
      style: "position:fixed;z-index:2147483647;right:16px;top:16px;padding:10px 14px;border-radius:10px;font:600 12px system-ui,sans-serif;color:#fff;" +
        (kind === "success" ? "background:#059669;" : kind === "error" ? "background:#dc2626;" : "background:#1e293b;") +
        "box-shadow:0 8px 24px rgba(0,0,0,.35);",
    }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 4200);
  }

  function log(msg, kind) {
    const box = $("#fb-log");
    if (!box) { console.log("[FlashBolt]", msg); return; }
    const color = kind === "success" ? "#34d399" : kind === "error" ? "#f87171" : kind === "warn" ? "#fbbf24" : "#94a3b8";
    const line = el("div", { style: "font:11px ui-monospace,monospace;color:" + color + ";padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04);" }, msg);
    box.prepend(line);
    while (box.children.length > 40) box.lastChild.remove();
  }

  function setIndicator(state) {
    const ind = $("#fb-scan-ind");
    if (!ind) return;
    ind.textContent = settings.botOn ? state : "OFF";
    ind.style.color = !settings.botOn ? "#f87171" : state === "ACTIVE" ? "#34d399" : "#64748b";
  }

  function botToggleStyle() {
    return "flex:0 0 auto;padding:7px 14px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer;" +
      (settings.botOn
        ? "background:rgba(52,211,153,.18);color:#34d399;border:1px solid rgba(52,211,153,.5);"
        : "background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.4);");
  }

  function toggleBot() {
    settings.botOn = !settings.botOn;
    saveSettings();
    const btn = $("#fb-bot-toggle");
    if (btn) { btn.textContent = settings.botOn ? "BOT ON" : "BOT OFF"; btn.style.cssText = botToggleStyle(); }
    setIndicator(settings.botOn ? "IDLE" : "OFF");
    log(settings.botOn ? "Bot ON - engine live (capture + auto-execute)" : "Bot OFF - engine idle (nothing captured, nothing traded)", settings.botOn ? "success" : "warn");
    if (settings.botOn) { void scanCycle(); maybeAutoBuy(); }
  }

  function renderPanel() {
    if (panel()) return;
    const isNarrow = window.innerWidth < 640;
    const p = el("div", {
      id: PANEL_ID,
      style: "position:fixed;z-index:2147483647;right:14px;top:64px;" + (isNarrow ? "left:8px;right:8px;width:auto;max-height:70vh;" : "width:348px;") +
        "max-height:86vh;overflow:hidden;border-radius:14px;" +
        "background:linear-gradient(180deg,rgba(10,14,24,.97),rgba(6,10,18,.97));color:#e2e8f0;border:1px solid rgba(148,163,184,.18);" +
        "font:12px system-ui,sans-serif;box-shadow:0 24px 64px rgba(0,0,0,.5);display:flex;flex-direction:column;resize:both;min-width:260px;min-height:180px;",
    });

    // Header (draggable - pointer events so touch + mouse both work)
    const header = el("div", { id: "fb-header", style: "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.14);cursor:grab;touch-action:none;" },
      el("span", { style: "font-weight:800;font-size:12px;color:#fbbf24;" }, "FlashBolt Sniper"),
      el("span", { id: "fb-utc", style: "margin-left:auto;font:600 10px ui-monospace,monospace;color:#7dd3fc;" }, "--:--:-- UTC"),
      el("button", { id: "fb-min", style: "border:none;background:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;", onclick: () => {
        const body = $("#fb-body");
        body.style.display = body.style.display === "none" ? "flex" : "none";
      } }, "-"),
    );
    p.append(header);

    const body = el("div", { id: "fb-body", style: "display:flex;flex-direction:column;overflow-y:auto;padding:10px 12px;gap:10px;" });

    // Bot ON/OFF master toggle - controls the overlay bot itself.
    body.append(el("div", { style: "display:flex;align-items:center;gap:8px;" },
      el("button", { id: "fb-bot-toggle", style: botToggleStyle(), onclick: toggleBot }, settings.botOn ? "BOT ON" : "BOT OFF"),
      el("span", { style: "font-size:9px;color:#64748b;line-height:1.3;" },
        settings.botOn ? "Engine live - capturing new tokens and executing." : "Engine idle - nothing captured, nothing traded."),
    ));

    const statsRow = el("div", { style: "display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;" });
    const statCard = (label, id, color) => el("div", { style: "background:rgba(30,41,59,.5);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:6px 8px;" },
      el("div", { style: "font-size:9px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;" }, label),
      el("div", { id, style: "font-weight:700;font-size:12px;color:" + color + ";margin-top:2px;" }, "0"),
    );
    statsRow.append(statCard("Wins", "fb-wins", "#34d399"), statCard("Losses", "fb-losses", "#f87171"), statCard("Realized", "fb-pnl", "#7dd3fc"));
    body.append(statsRow);

    const walletRow = el("div", { style: "display:flex;align-items:center;gap:6px;" },
      el("button", { id: "fb-connect", onclick: connectWallet, style: "flex:1;padding:7px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:700;font-size:11px;cursor:pointer;" }, "Connect Wallet"),
      el("span", { id: "fb-addr", style: "font:10px ui-monospace,monospace;color:#94a3b8;flex:1;text-align:right;" }, short(null)),
    );
    body.append(walletRow);

    // Server-enforced daily target (operator-controlled, subscribers only)
    body.append(el("div", { style: "display:flex;align-items:center;justify-content:space-between;background:rgba(30,41,59,.5);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:5px 8px;" },
      el("span", { style: "font-size:9px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;" }, "Server daily target"),
      el("span", { id: "fb-target", style: "font-weight:700;font-size:11px;color:#94a3b8;" }, "Daily target: …"),
    ));

    const chainSel = el("select", { id: "fb-chain", style: "width:100%;padding:6px;border-radius:8px;background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,.2);font-size:11px;" });
    CHAINS.forEach((c) => {
      const o = el("option", { value: c.key }, c.label + " (" + c.nativeSymbol + ")");
      if (c.key === settings.chainKey) o.selected = true;
      chainSel.append(o);
    });
    chainSel.addEventListener("change", () => { settings.chainKey = chainSel.value; saveSettings(); log("Chain -> " + chainSel.value); });
    body.append(chainSel);

    const grid = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;" });
    const numField = (label, key, step) => {
      const wrap = el("div", {},
        el("label", { style: "display:block;font-size:9px;letter-spacing:.06em;color:#64748b;text-transform:uppercase;margin-bottom:2px;" }, label),
        (() => {
          const input = el("input", { type: "number", step: step || "any", value: settings[key],
            style: "width:100%;box-sizing:border-box;padding:5px 7px;border-radius:7px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.2);font-size:11px;" });
          input.addEventListener("change", () => { settings[key] = Number(input.value); saveSettings(); });
          return input;
        })(),
      );
      return wrap;
    };
    grid.append(
      numField("Buy amount (" + (byKey.get(settings.chainKey) || CHAINS[0]).nativeSymbol + ")", "buyAmount"),
      numField("Sell %", "sellPct"),
      numField("SELL AMOUNT %", "sellAmountPct"),
      numField("Slippage %", "slippagePct"),
      numField("Min target profit %", "minTargetProfit"),
      numField("Trailing stop %", "trailingStopPct"),
      numField("Max gas (gwei)", "maxGasPrice"),
      numField("Min liquidity $", "minLiquidityUsd"),
      numField("Max pair age (h)", "maxPairAgeHours"),
      numField("Min security score", "minSecurityScore"),
      numField("Daily snipe limit (0=inf)", "dailySnipeLimit"),
    );
    body.append(grid);

    const modeRow = el("div", { style: "display:flex;gap:6px;" });
    const autoBtn = el("button", { style: "flex:1;padding:6px;border-radius:8px;border:1px solid rgba(52,211,153,.4);font-weight:700;font-size:10px;cursor:pointer;",
      onclick: () => { settings.mode = "auto"; saveSettings(); renderMode(); } }, "AUTO");
    const manualBtn = el("button", { style: "flex:1;padding:6px;border-radius:8px;border:1px solid rgba(148,163,184,.4);font-weight:700;font-size:10px;cursor:pointer;",
      onclick: () => { settings.mode = "manual"; saveSettings(); renderMode(); } }, "MANUAL");
    function renderMode() {
      autoBtn.style.background = settings.mode === "auto" ? "rgba(52,211,153,.15)" : "transparent";
      autoBtn.style.color = settings.mode === "auto" ? "#34d399" : "#94a3b8";
      manualBtn.style.background = settings.mode === "manual" ? "rgba(148,163,184,.15)" : "transparent";
      manualBtn.style.color = settings.mode === "manual" ? "#e2e8f0" : "#64748b";
    }
    renderMode();
    modeRow.append(autoBtn, manualBtn);
    body.append(modeRow);

    const payoutWrap = el("div", {},
      el("label", { style: "display:block;font-size:9px;letter-spacing:.06em;color:#64748b;text-transform:uppercase;margin-bottom:2px;" }, "Auto payout address (optional)"),
      (() => {
        const input = el("input", { type: "text", value: settings.payoutAddress, placeholder: "0x...",
          style: "width:100%;box-sizing:border-box;padding:5px 7px;border-radius:7px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.2);font-size:11px;font-family:ui-monospace,monospace;" });
        input.addEventListener("change", () => { settings.payoutAddress = input.value.trim(); saveSettings(); });
        return input;
      })(),
    );
    body.append(payoutWrap);

    // Candidates header - ACTIVE/IDLE indicator reflects live capture state.
    body.append(el("div", { style: "display:flex;align-items:center;gap:6px;margin-top:2px;" },
      el("span", { style: "font-weight:800;font-size:10px;letter-spacing:.1em;color:#34d399;" }, "LIVE CANDIDATES (BUYABLE + SELLABLE)"),
      el("span", { id: "fb-scan-ind", style: "margin-left:auto;font-size:9px;font-weight:700;color:#64748b;" }, settings.botOn ? "IDLE" : "OFF"),
    ));

    const candList = el("div", { id: "fb-cands", style: "display:flex;flex-direction:column;gap:4px;" });
    body.append(candList);

    const logBox = el("div", { id: "fb-log", style: "max-height:120px;overflow-y:auto;border-top:1px solid rgba(148,163,184,.14);padding-top:6px;" });
    body.append(logBox);

    // Open positions - per-position SELL AMOUNT override + manual sell-now.
    body.append(el("div", { style: "display:flex;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,.14);" },
      el("span", { style: "font-weight:800;font-size:10px;letter-spacing:.1em;color:#fbbf24;" }, "OPEN POSITIONS")));
    body.append(el("div", { id: "fb-positions", style: "display:flex;flex-direction:column;gap:4px;" }));

    p.append(body);
    document.body.append(p);

    // Drag to move - Pointer Events (mouse + touch + pen), clamped to viewport.
    (function makeDraggable(handle, node) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, pid = 0;
      handle.addEventListener("pointerdown", (e) => {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "BUTTON")) return;
        dragging = true; pid = e.pointerId;
        sx = e.clientX; sy = e.clientY; ox = node.offsetLeft; oy = node.offsetTop;
        handle.setPointerCapture(pid);
        e.preventDefault();
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging || e.pointerId !== pid) return;
        node.style.right = "auto";
        node.style.left = Math.max(0, Math.min(window.innerWidth - node.offsetWidth, ox + e.clientX - sx)) + "px";
        node.style.top = Math.max(0, Math.min(window.innerHeight - Math.min(node.offsetHeight, window.innerHeight * 0.5), oy + e.clientY - sy)) + "px";
      });
      const done = () => { dragging = false; };
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
    })(header, p);

    window.addEventListener("resize", () => {
      const narrow = window.innerWidth < 640;
      if (narrow) { p.style.left = "8px"; p.style.right = "8px"; p.style.width = "auto"; }
      else { p.style.width = "348px"; }
      if (p.offsetLeft > window.innerWidth - p.offsetWidth) p.style.left = Math.max(0, window.innerWidth - p.offsetWidth) + "px";
      if (p.offsetTop > window.innerHeight - 60) p.style.top = Math.max(0, window.innerHeight - 160) + "px";
    });

    renderWallet();
    renderStats();
    renderCandidates();
    renderPositions();
  }

  function renderWallet() {
    const addrEl = $("#fb-addr");
    if (addrEl) addrEl.textContent = short(account);
  }

  function renderStats() {
    const w = $("#fb-wins"), l = $("#fb-losses"), pnl = $("#fb-pnl");
    if (w) w.textContent = String(stats.wins);
    if (l) l.textContent = String(stats.losses);
    if (pnl) pnl.textContent = (stats.realizedPct >= 0 ? "+" : "") + stats.realizedPct.toFixed(1) + "%";
  }

  function renderCandidates() {
    const list = $("#fb-cands");
    if (!list) return;
    list.innerHTML = "";
    if (!settings.botOn) {
      list.append(el("div", { style: "color:#f87171;font-size:10px;padding:8px;text-align:center;border:1px dashed rgba(248,113,113,.3);border-radius:8px;" },
        "Bot OFF - capture idle. Toggle BOT ON to scan " + activeChain().label + "."));
      return;
    }
    if (!latestCandidates.length) {
      list.append(el("div", { style: "color:#64748b;font-size:10px;padding:8px;text-align:center;border:1px dashed rgba(148,163,184,.2);border-radius:8px;" },
        "Scanning " + activeChain().label + " - no tokens passing gates yet..."));
      return;
    }
    for (const t of latestCandidates) {
      const ageH = ageHours(t.pairCreatedAt);
      const row = el("div", { style: "display:flex;align-items:center;gap:6px;background:rgba(30,41,59,.5);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:6px 8px;" },
        el("div", { style: "flex:1;min-width:0;" },
          el("div", { style: "font-weight:700;font-size:11px;color:#e2e8f0;" }, t.symbol + " ",
            el("span", { style: "font-weight:400;font-size:9px;color:#64748b;" }, "$" + fmt(t.priceUsd, 8) + " · $" + fmt(t.liquidityUsd, 0) + " liq · " + (ageH < 1 ? Math.round(ageH * 60) + "m" : ageH.toFixed(1) + "h"))),
          el("div", { style: "font-size:9px;color:#64748b;" }, (t.source || "") + " · " + (t.dexId || "") + " · score " + securityScore(t)),
        ),
        el("button", { onclick: () => void buyToken(t), style: "padding:5px 9px;border:none;border-radius:7px;background:#059669;color:#fff;font-weight:800;font-size:10px;cursor:pointer;" }, "BUY"),
      );
      list.append(row);
    }
  }

  function renderPositions() {
    const list = $("#fb-positions");
    if (!list) return;
    list.innerHTML = "";
    const holding = positions.filter((p) => p.status === "holding");
    if (!holding.length) {
      list.append(el("div", { style: "color:#64748b;font-size:10px;padding:8px;text-align:center;border:1px dashed rgba(148,163,184,.2);border-radius:8px;" },
        "No open positions - buys appear here with their live PnL."));
      return;
    }
    for (const pos of holding) {
      const amt = Math.max(1, Math.min(100, pos.sellAmountPct == null ? 100 : pos.sellAmountPct));
      const amtInput = el("input", { type: "number", min: "1", max: "100", value: String(amt),
        title: "SELL AMOUNT % - share of this position each sell disposes of",
        style: "width:52px;padding:3px 5px;border-radius:6px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.2);font-size:10px;box-sizing:border-box;" });
      amtInput.addEventListener("change", () => {
        const v = Number(amtInput.value);
        if (!(v > 0 && v <= 100)) { amtInput.value = String(amt); return; }
        pos.sellAmountPct = v;
        persistPositions();
        log(pos.symbol + " SELL AMOUNT -> " + v + "%");
      });
      const row = el("div", { style: "display:flex;align-items:center;gap:6px;background:rgba(30,41,59,.5);border:1px solid rgba(148,163,184,.12);border-radius:8px;padding:6px 8px;" },
        el("div", { style: "flex:1;min-width:0;" },
          el("div", { style: "font-weight:700;font-size:11px;color:#e2e8f0;" }, pos.symbol),
          el("div", { style: "font-size:9px;color:#64748b;" },
            "bought $" + fmt(pos.buyPriceUsd, 8) + " · sell " + Math.max(1, Math.min(100, pos.sellPct)) + "% x " + amt + "%")),
        amtInput,
        el("button", { onclick: () => sellNow(pos),
          style: "padding:5px 9px;border:none;border-radius:7px;background:#b45309;color:#fff;font-weight:800;font-size:10px;cursor:pointer;" }, "SELL NOW"),
      );
      list.append(row);
    }
  }

  async function sellNow(pos) {
    if (pos.status !== "holding") return;
    const live = await livePrice(pos.address);
    if (!live) { toast("No live price for " + pos.symbol + " - try again.", "error"); return; }
    void sellPosition(pos, live);
  }

  // ------------------------------ world clock ------------------------------
  setInterval(() => {
    const c = $("#fb-utc");
    if (c) c.textContent = new Date().toISOString().slice(11, 19) + " UTC";
  }, 1000);

  // -------------------------------- boot loop ------------------------------

  function maybeAutoBuy() {
    if (!settings.botOn || settings.mode !== "auto" || !account) return;
    for (const t of latestCandidates) {
      if (busy.has(t.address)) continue;
      void buyToken(t);
    }
  }

  // SPA navigation - re-run site sync when the operator switches chain pages.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      activeChain();
    }
  }, 800);

  // Capture pipeline timers (all gated by settings.botOn):
  //  - 1.5s poll: page-layer address safety net (the observer is the instant path)
  //  - 15s scan: remote sources (DexScreener search/profiles, GeckoTerminal)
  //  - 2.5s indicator decay: ACTIVE while the last capture is <20s old
  function boot() {
    renderPanel();
    startObserver();
    activeChain();
    log("FlashBolt overlay loaded on " + location.hostname + (settings.botOn ? " - bot ON" : " - bot OFF"));
    void refreshGate();
    setInterval(() => void refreshGate(), 60000);
    if (settings.botOn) void scanCycle();
    setInterval(() => { if (settings.botOn) void scanCycle(); }, 15000);
    setInterval(() => { if (settings.botOn) void pollSignals(); }, 12000);
    setInterval(() => { if (settings.botOn) scheduleDomFlush(); }, 1500);
    setInterval(() => {
      if (!settings.botOn) { setIndicator("OFF"); return; }
      setIndicator(now() - lastCaptureAt < 20000 ? "ACTIVE" : "IDLE");
    }, 2500);
    setInterval(() => {
      for (const t of latestCandidates) if (!seen.has(t.address)) seen.set(t.address, now());
    }, 1000);
    if (window.ethereum) {
      window.ethereum.on && window.ethereum.on("accountsChanged", (accs) => { account = accs && accs[0]; renderWallet(); });
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") boot();
  else window.addEventListener("DOMContentLoaded", boot);
})();
