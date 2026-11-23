/**
 * `writeClipboard` — the write path every copy control shares.
 *
 * The interesting cases are the failures: a denied permission, a synchronous
 * throw and a tab with no clipboard API at all must all come back as `false`
 * instead of an exception, because the control turns that boolean into a
 * "blocked" toast and leaves its copied state alone.
 */
import { describe, expect, test } from "bun:test";
import { writeClipboard } from "../clipboard";

describe("writeClipboard — reports the clipboard's answer", () => {
  test("writes the exact text and reports success", async () => {
    let written = "";
    const ok = await writeClipboard("solana airdrop 2 abc --url devnet", {
      writeText: async (text) => {
        written = text;
      },
    });
    expect(ok).toBe(true);
    expect(written).toBe("solana airdrop 2 abc --url devnet");
  });

  test("a permission denial reports failure instead of throwing", async () => {
    const ok = await writeClipboard("x", {
      writeText: async () => {
        throw new DOMException("Write permission denied.", "NotAllowedError");
      },
    });
    expect(ok).toBe(false);
  });

  test("a synchronous throw is reported, not raised", async () => {
    const ok = await writeClipboard("x", {
      writeText: () => {
        throw new Error("no clipboard");
      },
    });
    expect(ok).toBe(false);
  });

  test("no clipboard at all reports failure (insecure context, old embed)", async () => {
    expect(await writeClipboard("x", undefined)).toBe(false);
  });

  test("empty text is still a write the browser can accept", async () => {
    let calls = 0;
    const ok = await writeClipboard("", {
      writeText: async () => {
        calls += 1;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });
});
