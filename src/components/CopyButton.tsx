/**
 * One copy-to-clipboard control for the whole app.
 *
 * Every surface used to hand-roll the same three things: `writeText`, a copied
 * flag with a 2s timer, and a toast — with three different failure behaviours.
 * This module keeps the shared behaviour in one place:
 *
 *   · success → the control swaps to a check for a moment
 *   · denial  → a toast that says the clipboard was blocked, never silence
 *   · timers  → cleared on unmount, so no setState after a dialog closes
 *
 * `useCopy` is exported for the places that need their own markup (a message
 * bubble, a raw table cell); `CopyButton` is the button-shaped default. The
 * write itself lives in `copy-text.ts` so both share one path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText, type CopyOptions } from "./copy-text";
import { cn } from "@/lib/utils";

export function useCopy(durationMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string, opts: CopyOptions = {}) => {
      if (!(await copyText(text, opts))) return false;
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), durationMs);
      return true;
    },
    [durationMs],
  );

  return { copied, copy };
}

type ButtonProps = React.ComponentProps<typeof Button>;

export interface CopyButtonProps {
  /** The exact text written to the clipboard. */
  text: string;
  /** Visible label; omit for an icon-only button. */
  label?: string;
  copiedLabel?: string;
  message?: string;
  description?: string;
  title?: string;
  ariaLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  iconClassName?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  message,
  description,
  title,
  ariaLabel,
  variant,
  size,
  className,
  iconClassName,
  disabled,
  type = "button",
}: CopyButtonProps) {
  const { copied, copy } = useCopy();
  const accessible = ariaLabel ?? label ?? "Copy to clipboard";

  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      className={className}
      disabled={disabled}
      title={title ?? accessible}
      aria-label={accessible}
      onClick={() => void copy(text, { message, description })}
    >
      {copied ? (
        // The success colour is the control's own state, so it survives a
        // caller-supplied size (the card used to lose its green check here).
        <Check className={cn(iconClassName ?? "size-3.5", "text-emerald-400")} />
      ) : (
        <Copy className={iconClassName ?? "size-3.5"} />
      )}
      {label ? <span>{copied ? (copiedLabel ?? "Copied") : label}</span> : null}
    </Button>
  );
}

export default CopyButton;
