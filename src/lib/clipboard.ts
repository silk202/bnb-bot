/**
 * The clipboard write path, without the UI.
 *
 * Every copy control in the app ultimately does the same thing: hand a string
 * to `navigator.clipboard.writeText` and find out whether the browser allowed
 * it. Keeping that answer as a boolean — instead of an exception the caller has
 * to catch — is what lets one toast say "blocked" while the button stays in its
 * uncopied state.
 */

/** The part of the browser clipboard this module uses. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Write `text`, reporting success instead of throwing.
 *
 * A blocked clipboard is a UI fact, not a program failure, and a tab without
 * `navigator.clipboard` (insecure context, some embeds) gets the same honest
 * `false` as a denial. The optional `clipboard` argument keeps the write path
 * testable without a DOM.
 */
export async function writeClipboard(
  text: string,
  clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
