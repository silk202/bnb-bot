/**
 * TAEngine deep-link builder — pins the exact URL contracts the account
 * menu's "Telegram Bot" row navigates to, per platform and pairing state.
 * The desktop +code form must be the `tgaddr` route (payload preserved by
 * Web K's internal link handler) and must NEVER be the `#@<bot>?start=`
 * form, whose `@`-branch silently drops the start payload.
 */
import { describe, expect, test } from "bun:test";
import { buildTelegramBotLink } from "../telegram-deep-link";

describe("TAEngine deep link — account menu Telegram Bot row", () => {
  test("mobile with code → official t.me universal link carrying the payload", () => {
    expect(
      buildTelegramBotLink({ username: "TAEngine_bot", code: "Ab12Cd", mobile: true }),
    ).toBe("https://t.me/TAEngine_bot?start=Ab12Cd");
  });

  test("mobile without code → plain t.me bot link (no dangling ?start=)", () => {
    expect(
      buildTelegramBotLink({ username: "TAEngine_bot", code: null, mobile: true }),
    ).toBe("https://t.me/TAEngine_bot");
  });

  test("desktop without code → Web K hash resolves the bot chat directly", () => {
    expect(
      buildTelegramBotLink({ username: "TAEngine_bot", code: null, mobile: false }),
    ).toBe("https://web.telegram.org/k/#@TAEngine_bot");
  });

  test("desktop with code → tgaddr route with the full t.me link URL-encoded", () => {
    const url = buildTelegramBotLink({
      username: "TAEngine_bot",
      code: "Ab12Cd",
      mobile: false,
    });
    const prefix = "https://web.telegram.org/k/#?tgaddr=";
    expect(url.startsWith(prefix)).toBe(true);
    // Everything after the hash-query is ONE encoded param — a raw "?" or
    // "&" inside it would split Web K's router the wrong way.
    const encoded = url.slice(prefix.length);
    expect(encoded).not.toContain("?");
    expect(encoded).not.toContain("&");
    // Web K decodes it back to the exact t.me deep link (its `im` handler
    // reads ?start= from the query and keeps it as the chat's start param).
    expect(decodeURIComponent(encoded)).toBe(
      "https://t.me/TAEngine_bot?start=Ab12Cd",
    );
  });

  test("never emits the payload-dropping #@<bot>?start= form on desktop", () => {
    const withCode = buildTelegramBotLink({
      username: "TAEngine_bot",
      code: "Ab12Cd",
      mobile: false,
    });
    expect(withCode).not.toContain("#@TAEngine_bot?start=");
  });
});
