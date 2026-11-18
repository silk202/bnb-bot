import { v } from "convex/values";
import { getCurrentUser } from "./users";
import { action, mutation, query } from "./_generated/server";

/**
 * FlashBolt support chat.
 *
 * - `support_messages` persists the real conversation per user, so questions
 *   and answers survive refreshes.
 * - `chatWithAi` is a real call to SambaNova Cloud (free tier, Llama model)
 *   used only when the local knowledge base is not confident. When
 *   SAMBANOVA_API_KEY is not configured it honestly reports disabled — the
 *   knowledge base stays the only answerer. Nothing is ever simulated.
 */

export const AI_PROVIDER = "SambaNova";
export const AI_MODEL = "Meta-Llama-3.3-70B-Instruct";
export const AI_MODEL_LABEL = "Llama 3.3 70B";
const AI_ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";

/** App facts embedded in every AI request so answers stay in scope. */
const SYSTEM_PROMPT = `You are the built-in support assistant for FlashBolt, a flash-loan triangular arbitrage terminal.
How it actually works:
- Scans real DEX liquidity (DexScreener) on BNB Smart Chain, Ethereum, Arbitrum and Polygon and computes triangular routes profitable after lender fee, slippage and the chain's live gas price.
- Scanner page: real pair stream, honey-pot flagging (real liquidity + profit thresholds), one-click execute when live mode is armed. No simulated values.
- Flash-loan lenders are scoped per chain (Venus/PancakeSwap on BNB, Aave V3/dForce/Radiant on EVM chains); the lender rotates every scan, low-fee lenders first (Balancer queue on Strategy).
- Gas prices are live from each chain's public RPC, with an optional private RPC override on the Contract page (must be http(s), CORS-open).
- Live mode needs a connected wallet (EIP-1193) and an armed deployed contract. The Contract page auto-compiles (real solc), one-click deploys (wallet-signed, mainnet/testnet switch for BNB) and can Verify & Publish the flattened source on BscScan with a BSCSCAN_API_KEY.
- History shows real receipts from the chain RPC (confirmed/reverted/pending, gas used, explorer links). Overview computes PnL net of the real gas paid.
- The bell records real events; optional Telegram alerts via TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
- Each chain has its own DEX whitelist, lenders and armed deployment.
- The world clock is the real device clock in a selectable UTC offset (UTC-12..UTC+14).
Rules: answer only about FlashBolt; be concise and practical; never invent features, numbers, addresses, tokens or transaction results; if unsure, say so and point to the terminal's own pages; keep answers under 120 words.`;

/** Newest-last transcript for the current user (oldest first). */
export const listSupportMessages = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 50 }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("support_messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(-limit);
  },
});

/** Persist one message from the chat. */
export const saveSupportMessage = mutation({
  args: {
    role: v.union(v.literal("user"), v.literal("bot")),
    text: v.string(),
    source: v.union(
      v.literal("user"),
      v.literal("greeting"),
      v.literal("kb"),
      v.literal("ai"),
      v.literal("fallback"),
    ),
  },
  handler: async (ctx, { role, text, source }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    await ctx.db.insert("support_messages", {
      userId: user._id,
      role,
      text,
      source,
    });
    return true;
  },
});

/** Wipe the operator's support transcript. */
export const clearSupportHistory = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const rows = await ctx.db
      .query("support_messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return true;
  },
});

/** Whether the AI channel is configured — drives the footer badge. */
export const aiSupportStatus = action({
  args: {},
  handler: async () => ({
    enabled: Boolean(process.env.SAMBANOVA_API_KEY),
    provider: AI_PROVIDER,
    model: AI_MODEL,
    modelLabel: AI_MODEL_LABEL,
  }),
});

/** Open support tickets for the current user (newest first). */
export const listSupportTickets = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 10 }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("support_tickets")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
});

/**
 * Escalate the support conversation into a real ticket. Stores the actual
 * transcript so the support side has full context; returns the ticket's
 * reference so the operator can see it confirmed in chat.
 */
export const createSupportTicket = mutation({
  args: {
    summary: v.string(),
    transcript: v.array(
      v.object({ role: v.string(), text: v.string() }),
    ),
  },
  handler: async (ctx, { summary, transcript }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const id = await ctx.db.insert("support_tickets", {
      userId: user._id,
      summary,
      transcript,
      status: "open",
      createdAt: Date.now(),
    });
    // Short human-friendly reference from the real document id.
    const reference = `FB-${String(id).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}`;
    return { ticketId: id, reference };
  },
});

/**
 * Ask the free SambaNova model for an open-ended answer. Real API call —
 * the model only ever receives the operator's query plus the recent chat,
 * and its reply is returned verbatim.
 */
export const chatWithAi = action({
  args: {
    query: v.string(),
    history: v.array(
      v.object({ role: v.string(), text: v.string() }),
    ),
  },
  handler: async (_ctx, { query, history }) => {
    const apiKey = process.env.SAMBANOVA_API_KEY;
    if (!apiKey) {
      return {
        enabled: false,
        ok: false,
        model: AI_MODEL_LABEL,
        text: "",
        description: "SAMBANOVA_API_KEY not configured in Keys",
      };
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history
        .slice(-10)
        .map((m) => ({
          role: m.role === "bot" ? "assistant" : "user",
          content: m.text,
        })),
      { role: "user", content: query },
    ];

    try {
      const res = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages,
          temperature: 0.3,
          max_tokens: 600,
        }),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 160);
        return {
          enabled: true,
          ok: false,
          model: AI_MODEL_LABEL,
          text: "",
          description: `SambaNova API error ${res.status}: ${detail || res.statusText}`,
        };
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        return {
          enabled: true,
          ok: false,
          model: AI_MODEL_LABEL,
          text: "",
          description: "The model returned an empty response",
        };
      }
      return { enabled: true, ok: true, model: AI_MODEL_LABEL, text, description: "" };
    } catch (error) {
      return {
        enabled: true,
        ok: false,
        model: AI_MODEL_LABEL,
        text: "",
        description:
          error instanceof Error ? error.message : "Network error talking to SambaNova",
      };
    }
  },
});
