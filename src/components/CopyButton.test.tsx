/**
 * The copy control's rendered contract — a real React render, not a mock.
 *
 * The write path (success, denial, no clipboard API) lives in
 * `src/lib/__tests__/clipboard.test.ts`; the clicked state (check icon,
 * "Copied" label, toast) needs a DOM and was verified in a browser against
 * this component on a standalone page, not faked here.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton } from "./CopyButton";

describe("CopyButton — the rendered contract", () => {
  test("a labelled button has one accessible name and a real type", () => {
    const html = renderToStaticMarkup(<CopyButton text="abc" label="Copy CLI" />);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Copy CLI"');
    expect(html).toContain('title="Copy CLI"');
    expect(html).toContain(">Copy CLI</span>");
    expect(html).toContain("lucide-copy");
  });

  test("an icon-only button still announces itself", () => {
    const html = renderToStaticMarkup(<CopyButton text="abc" />);
    expect(html).toContain('aria-label="Copy to clipboard"');
    expect(html).toContain("lucide-copy");
    expect(html).not.toContain("<span>");
  });

  test("ariaLabel and title override without changing the visible label", () => {
    const html = renderToStaticMarkup(
      <CopyButton
        text="abc"
        label="Copy"
        ariaLabel="Copy the solana airdrop command"
        title="Copy command (without the comment)"
      />,
    );
    expect(html).toContain('aria-label="Copy the solana airdrop command"');
    expect(html).toContain('title="Copy command (without the comment)"');
    expect(html).toContain(">Copy</span>");
  });

  test("disabled and submit pass through to the underlying button", () => {
    const html = renderToStaticMarkup(<CopyButton text="abc" type="submit" disabled />);
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
  });

  test("the copied value never enters the markup — only the clipboard", () => {
    const html = renderToStaticMarkup(
      <CopyButton text="s3cret-airdrop-command" label="Copy" />,
    );
    expect(html).not.toContain("s3cret-airdrop-command");
  });
});
