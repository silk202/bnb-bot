import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import axios from "axios";

/**
 * FlashBolt OTP mail relay.
 *
 * Reused by every code-sending provider in the app:
 * - `email-otp` (magic sign-in codes)
 * - `password` sign-up / sign-in verification codes
 * - `password` reset codes
 *
 * Delivery goes through the Freebuff OTP relay (the same live path the auth
 * page has always used) — real email, never simulated.
 */
const RELAY_URL = "https://auth.freebuff.app/send_otp";
const RELAY_API_KEY = "fb_email_2crN1hqIArZP2bEfvjp5Qik4";

/** Cryptographically random numeric code (default 6 digits). */
export function generateNumericCode(length = 6): string {
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes);
    },
  };
  return generateRandomString(random, "0123456789", length);
}

/** Send a one-time code by real email through the Freebuff OTP relay. The
 *  sender label is neutral — never the product brand (email-policy safe). */
export async function sendCodeEmail(
  identifier: string,
  code: string,
  appName = "Terminal Alert",
): Promise<void> {
  await axios.post(
    RELAY_URL,
    {
      to: identifier,
      otp: code,
      appName,
    },
    {
      headers: {
        "x-api-key": RELAY_API_KEY,
      },
      timeout: 15_000,
    },
  );
}
