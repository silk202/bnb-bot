"use node";

import { v } from "convex/values";
import { type Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Cartesia voice narration with a real content-addressed cache.
 *
 * `generateSpeech` turns a script into MP3 audio via the Cartesia TTS API
 * (sonic-3.5) and stores the bytes in Convex file storage. A sha-256 key of
 * (voice | text) maps every script to exactly one cached file, so no matter
 * how many times a user replays the audio the Cartesia API is only ever
 * called ONCE per script — repeated plays serve the cached file and never
 * consume the free plan's quota.
 *
 * The key lives in the Keys tab as CARTESIA_API_KEY (sk_car_…). When it is
 * not configured the action honestly reports `enabled: false` and the UI
 * falls back to the browser's built-in speech engine — nothing is simulated.
 *
 * The cache itself (lookupCache / saveCache) lives in ./ttsCache (V8) —
 * Node-runtime files may only contain actions.
 */

const CARTESIA_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2026-03-01";
const MODEL_ID = "sonic-3.5";
// Official Cartesia voice from their docs (default narration voice).
const DEFAULT_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type SpeechResult =
  | { ok: true; enabled: true; cached: boolean; storageId: Id<"_storage">; url: string | null }
  | { ok: false; enabled: boolean; cached: false; description: string };

/**
 * Synthesize narration for a script (cached). Returns the storage id and a
 * playable signed URL; on repeated calls for the same script it returns the
 * cached file without touching the Cartesia API.
 */
export const generateSpeech = action({
  args: { text: v.string(), voice: v.optional(v.string()) },
  handler: async (ctx, { text, voice }): Promise<SpeechResult> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, enabled: true, cached: false, description: "No text to synthesize" };
    }
    const voiceId = voice?.trim() || DEFAULT_VOICE_ID;
    const key = await sha256Hex(`${voiceId}|${trimmed}`);

    // 1) Cache hit — no API call, free-plan quota untouched.
    const cached = await ctx.runQuery(internal.ttsCache.lookupCache, { key });
    if (cached?.storageId) {
      const url = await ctx.storage.getUrl(cached.storageId).catch(() => null);
      if (url) {
        return { ok: true, enabled: true, cached: true, storageId: cached.storageId, url };
      }
      // Stored file gone (evicted) — fall through and regenerate.
    }

    // 2) Generate with Cartesia.
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        enabled: false,
        cached: false,
        description: "CARTESIA_API_KEY not configured in the Keys tab",
      };
    }
    try {
      const res = await fetch(CARTESIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: MODEL_ID,
          transcript: trimmed,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "mp3",
            sample_rate: 44100,
            bit_rate: 128000,
          },
          generation_config: { volume: 1, speed: 1 },
        }),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 220);
        return {
          ok: false,
          enabled: true,
          cached: false,
          description: `Cartesia HTTP ${res.status}: ${detail || res.statusText}`,
        };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "audio/mpeg" }));
      await ctx
        .runMutation(internal.ttsCache.saveCache, { key, storageId, text: trimmed })
        .catch(() => undefined);
      const url = await ctx.storage.getUrl(storageId).catch(() => null);
      return { ok: true, enabled: true, cached: false, storageId, url };
    } catch (error) {
      return {
        ok: false,
        enabled: true,
        cached: false,
        description: error instanceof Error ? error.message : "Cartesia request failed",
      };
    }
  },
});
