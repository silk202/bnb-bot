import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { v } from "convex/values";
import { auth } from "./auth";
import { activateLicenseHttp } from "./licenses";
import { signalsHttp } from "./copier";
import { overlayGateStatusHttp, overlayGateExecutionHttp } from "./terminal";
import { internal } from "./_generated/api";

const http = httpRouter();

auth.addHttpRoutes(http);

// Desktop CLI activation — POST { email, os, password } to /activate. Same
// server-side verdict as the web form; never exposes any secret. The email
// must be the one the subscriber used on the first page (the backend only
// recognizes registered subscriber emails for licenses).
http.route({
  path: "/activate",
  method: "POST",
  handler: activateLicenseHttp,
});

// Copier bot — public signals feed for the DEXView/GMGN/Ave overlay
// userscript (the overlay page cannot call Convex directly). The overlay
// merges these into its LIVE CANDIDATES for sub-millisecond auto sniping.
http.route({
  path: "/api/copier/signals",
  method: "GET",
  handler: signalsHttp,
});

// Sniper overlay (userscript + browser extension, BNB and SOL) — the overlay
// runs on third-party DEX sites with no app session, so each export carries
// a per-subscriber token and the daily target is enforced HERE, server-side,
// against the same operator-controlled counter the terminals use.
//   GET  /api/overlay/execution  → live { used, limit } for the panel badge
//   POST /api/overlay/execution  → consume one slot (blocked ⇒ do NOT snipe)
http.route({
  path: "/api/overlay/execution",
  method: "GET",
  handler: overlayGateStatusHttp,
});
http.route({
  path: "/api/overlay/execution",
  method: "POST",
  handler: overlayGateExecutionHttp,
});

// FlashBolt Telegram Bot — the operator-only mirror of the app. Telegram
// posts every update here; the handler verifies the X-Telegram-Bot-Api-
// Secret-Token header against the stored webhook secret before anything is
// parsed, so only Telegram can drive the bot.
const telegramWebhook = httpAction(async (ctx, request) => {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = await ctx.runAction(internal.telegramBot.handleUpdate, {
    secret,
    update,
  });
  // 200 keeps Telegram happy even for handled refusals; 401/503 only for
  // real auth/config problems so Telegram surfaces them in setWebhook logs.
  const status = result.status ?? 200;
  return new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
});

http.route({
  path: "/api/telegram/webhook",
  method: "POST",
  handler: telegramWebhook,
});

// Kora Pay QUI-CHKOUT webhook — real-time deposit confirmation for the Trade
// terminal's instant local-currency deposits (NGN/GHS/KES/XAF). Kora POSTs
// charge.success here; the HMAC-SHA256 signature over the raw `data` JSON is
// verified against KORA_SECRET_KEY (x-korapay-signature header) BEFORE the
// ledger credit runs. Invalid/unknown references still get a 200 so Kora
// stops retrying; valid events settle idempotently through internal.kora.
const koraWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("x-korapay-signature") ?? "";
  let raw = "";
  let payload: {
    event?: string;
    data?: { reference?: string; amount?: number; fee?: number; status?: string };
  };
  try {
    raw = await request.text();
    payload = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const data = payload.data ?? {};
  const reference = typeof data.reference === "string" ? data.reference : "";
  if (!payload.event || !reference) {
    return new Response(JSON.stringify({ ok: false, error: "missing event/reference" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // HMAC is computed over the parsed data object re-serialized with
  // JSON.stringify — exactly Kora's documented verification
  // (crypto.createHmac('sha256', secret).update(JSON.stringify(req.body.data))).
  // Slicing raw bytes would include the outer payload's closing brace and
  // break the signature, so never verify against the raw body here.
  if (!payload.data || typeof payload.data !== "object") {
    return new Response(JSON.stringify({ ok: false, error: "missing data object" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const sigOk = await ctx.runQuery(internal.kora.verifyWebhookSignature, {
    raw: JSON.stringify(payload.data),
    signature,
  });
  if (!sigOk) {
    return new Response(JSON.stringify({ ok: false, error: "invalid signature" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const result = await ctx.runMutation(internal.kora.applyKoraResult, {
    reference,
    koraStatus: typeof data.status === "string" ? data.status : "unknown",
    amount: typeof data.amount === "number" ? data.amount : undefined,
    fee: typeof data.fee === "number" ? data.fee : undefined,
    reason: payload.event === "charge.failed" ? "Kora reported charge.failed" : undefined,
  });
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

http.route({
  path: "/api/kora/webhook",
  method: "POST",
  handler: koraWebhook,
});

export default http;
