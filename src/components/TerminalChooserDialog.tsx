/**
 * Terminal chooser popup — shown when an operator or subscriber finishes
 * auth (or enters the terminal without a prior choice) and must pick which
 * terminal to enter: BNB FlashBolt (the original EVM terminal) or SOL
 * FlashBolt (the Solana terminal mirroring it).
 *
 * The choice is persisted per browser (localStorage) AND per account (Convex
 * terminalState.terminalFlavor) so the next visit opens the same terminal
 * without asking again. Both options always remain reachable from the
 * account menu.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getGrant } from "@/lib/gate";
import { Flame, Zap, ArrowLeftRight } from "lucide-react";

export type TerminalFlavor = "bnb" | "sol" | "trade";

/**
 * Terminal visibility: FlashBolt Trade is OPERATOR-ONLY — it appears for
 * operator sign-in and "continue as guest" sessions (which authenticate at
 * /auth and carry no subscriber grant) and is hidden from gate-granted
 * subscriber sessions.
 */
export function visibleFlavors(): TerminalFlavor[] {
  const all: TerminalFlavor[] = ["bnb", "sol", "trade"];
  return getGrant()?.role === "subscriber"
    ? all.filter((f) => f !== "trade")
    : all;
}

const STORAGE_KEY = "flashbolt.terminalFlavor";

/** Persisted flavor for this browser (null = not chosen yet). */
export function getStoredFlavor(): TerminalFlavor | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "bnb" || v === "sol" || v === "trade" ? v : null;
  } catch {
    return null;
  }
}

/** Persist the flavor for this browser. */
export function setStoredFlavor(flavor: TerminalFlavor): void {
  try {
    localStorage.setItem(STORAGE_KEY, flavor);
  } catch {
    // storage unavailable — the choice just won't persist
  }
}

export const FLAVOR_META: Record<
  TerminalFlavor,
  { title: string; subtitle: string; chainLabel: string; icon: typeof Flame; path: string; accent: string }
> = {
  bnb: {
    title: "BNB FlashBolt",
    subtitle: "EVM flash-loan arbitrage across BSC, Ethereum, Arbitrum & Polygon",
    chainLabel: "BNB Smart Chain · EVM",
    icon: Flame,
    path: "/terminal",
    accent: "text-amber-500",
  },
  sol: {
    title: "SOL FlashBolt",
    subtitle: "Solana flash-loan arbitrage across Raydium, Orca, Meteora & PumpSwap",
    chainLabel: "Solana · SVM",
    icon: Zap,
    path: "/sol-terminal",
    accent: "text-violet-400",
  },
  trade: {
    title: "FlashBolt Trade",
    subtitle: "Exchange terminal — swaps, order book, earn & multi-currency wallet (operator only)",
    chainLabel: "Multi-asset · CeDeFi",
    icon: ArrowLeftRight,
    path: "/trade-terminal",
    accent: "text-emerald-500",
  },
};

interface TerminalChooserDialogProps {
  open: boolean;
  onChoose: (flavor: TerminalFlavor) => void;
  /** Rendered when the user dismisses without choosing. */
  onDismiss?: () => void;
}

export function TerminalChooserDialog({
  open,
  onChoose,
  onDismiss,
}: TerminalChooserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss?.()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader className="text-center">
          <DialogTitle className="flex items-center justify-center gap-2 text-lg">
            <Zap className="size-4 text-primary" />
            Choose your terminal
          </DialogTitle>
          <DialogDescription>
            Pick which FlashBolt terminal to enter. You can switch anytime from
            the account menu.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 pb-1">
          {visibleFlavors().map((flavor) => {
            const meta = FLAVOR_META[flavor];
            const Icon = meta.icon;
            return (
              <button
                key={flavor}
                type="button"
                onClick={() => onChoose(flavor)}
                className="group flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
              >
                <span
                  className={
                    "flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 " +
                    meta.accent
                  }
                >
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-bold tracking-tight">{meta.title}</span>
                    <Badge variant="outline" className="text-[9px] uppercase">
                      {meta.chainLabel}
                    </Badge>
                  </span>
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                    {meta.subtitle}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
