/**
 * Live check: fetch both copier channels' public previews and run the real
 * parser. Verifies the t.me/s extraction + signal parsing pipeline end-to-end.
 */
import { COPIER_SOURCES, extractMessagesFromPreview, parseChannelMessages } from "../src/lib/copier-signals";

for (const src of COPIER_SOURCES) {
  try {
    const res = await fetch(src.url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(src.label + ": HTTP " + res.status);
      continue;
    }
    const html = await res.text();
    const messages = extractMessagesFromPreview(html);
    const signals = parseChannelMessages(messages);
    console.log(
      src.label + ": HTTP " + res.status + " | messages=" + messages.length + " | signals=" + signals.length,
    );
    for (const s of signals.slice(0, 3)) {
      console.log(
        "  " + s.symbol + " [" + s.chain + "] " + s.address.slice(0, 10) + "…  liq=" + s.liquidityUsd + " mc=" + s.marketCapUsd,
      );
    }
    if (messages.length > 0 && signals.length === 0) {
      console.log("  (messages found but no EVM addresses in the latest previews)");
    }
  } catch (e) {
    console.log(src.label + ": " + (e instanceof Error ? e.message : String(e)));
  }
}
