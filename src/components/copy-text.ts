/**
 * Copy with feedback, without the control.
 *
 * The same write path as `CopyButton`, for call sites that need their own
 * markup (a message bubble, a row button with its own icon swap, a dialog
 * passcode). Keeping it out of the component module means fast refresh still
 * works there, and every copy in the app now reports a blocked clipboard
 * instead of the hand-rolled mix of silence, success-on-failure and catches.
 */
import { toast } from "sonner";
import { writeClipboard } from "@/lib/clipboard";

export interface CopyOptions {
  /** Toast headline; defaults to "Copied". */
  message?: string;
  /** Second toast line — the copied value, or what to do with it. */
  description?: string;
  /** Suppress the success toast (failure is always reported). */
  silent?: boolean;
}

/** Write `text` and report the outcome through the toast layer. */
export async function copyText(text: string, opts: CopyOptions = {}): Promise<boolean> {
  const written = await writeClipboard(text);
  if (!written) {
    toast.error("Copy failed", {
      description:
        "Your browser blocked clipboard access — select the text and copy it manually.",
    });
    return false;
  }
  if (!opts.silent) {
    toast.success(
      opts.message ?? "Copied",
      opts.description ? { description: opts.description } : undefined,
    );
  }
  return true;
}
