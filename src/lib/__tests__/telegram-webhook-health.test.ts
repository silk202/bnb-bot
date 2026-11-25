/**
 * Webhook health: when does registration need repairing?
 *
 * Production answered every update with 401 because `setWebhook` was called
 * without `secret_token` while the handler requires the matching header — and
 * the self-heal only compared the URL, so it called that healthy forever. These
 * tests pin the verdict that closes that hole: a matching URL with a delivery
 * error is NOT healthy.
 */
import { describe, expect, test } from "bun:test";
import { webhookNeedsRepair } from "../telegramBot";

const URL_ = "https://example.convex.site/api/telegram/webhook";

describe("webhookNeedsRepair", () => {
  test("no webhook at all needs registering", () => {
    expect(webhookNeedsRepair(null, URL_)).toBe(true);
    expect(webhookNeedsRepair(undefined, URL_)).toBe(true);
    expect(webhookNeedsRepair({ url: "" }, URL_)).toBe(true);
  });

  test("a webhook pointing at another host needs registering", () => {
    expect(webhookNeedsRepair({ url: "https://other.convex.site/api/telegram/webhook" }, URL_)).toBe(
      true,
    );
  });

  test("the right URL with no delivery error is healthy", () => {
    expect(webhookNeedsRepair({ url: URL_ }, URL_)).toBe(false);
    expect(webhookNeedsRepair({ url: URL_, last_error_message: "" }, URL_)).toBe(false);
    expect(webhookNeedsRepair({ url: URL_, last_error_message: "   " }, URL_)).toBe(false);
  });

  test("the production failure: right URL, Telegram still reporting 401", () => {
    expect(
      webhookNeedsRepair(
        {
          url: URL_,
          last_error_message: "Wrong response from the webhook: 401 Unauthorized",
        },
        URL_,
      ),
    ).toBe(true);
  });

  test("surrounding whitespace never changes the verdict", () => {
    expect(webhookNeedsRepair({ url: ` ${URL_} ` }, URL_)).toBe(false);
    expect(webhookNeedsRepair({ url: URL_ }, ` ${URL_} `)).toBe(false);
  });
});
