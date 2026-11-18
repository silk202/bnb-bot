import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTerminal } from "@/hooks/use-terminal";
import { CHAIN_INFO, CHAIN_KEYS, isBscChain, type ChainKey } from "@/lib/flashbolt";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Globe } from "lucide-react";
import { toast } from "sonner";

/**
 * Multi-chain switcher — the "switch over" control at the top centre of the
 * terminal. Persists via the same setSettings({ chainKey }) mutation the
 * Scanner page uses, so every page follows the active chain.
 */
export function ChainSwitcher({ className }: { className?: string }) {
  const { state, setSettings } = useTerminal();
  const chainKey: ChainKey = state?.chainKey ?? "bsc";
  const chain = CHAIN_INFO[chainKey];

  const switchChain = async (next: ChainKey) => {
    if (next === chainKey) return;
    try {
      await setSettings({ chainKey: next });
      toast.success(`Scanning ${CHAIN_INFO[next].label}`, {
        description: `Real DexScreener pairs via ${CHAIN_INFO[next].quoteSymbol} — lenders and DEX whitelist scoped to ${CHAIN_INFO[next].label}.`,
      });
    } catch {
      toast.error(`Could not switch to ${CHAIN_INFO[next].label}`);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 text-xs font-bold text-foreground transition-colors hover:border-primary/60 hover:bg-primary/15",
            className,
          )}
          aria-label="Switch blockchain"
        >
          <Globe className="size-3.5 text-primary" />
          <span className="max-w-40 truncate">{chain.label}</span>
          {isBscChain(chainKey) && state?.network === "testnet" ? (
            <span className="rounded-full bg-amber-400/20 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-amber-500">
              testnet
            </span>
          ) : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Blockchain
        </div>
        {CHAIN_KEYS.map((key) => {
          const info = CHAIN_INFO[key];
          const active = key === chainKey;
          return (
            <DropdownMenuItem
              key={key}
              onSelect={() => void switchChain(key)}
              className={cn(active && "bg-accent text-accent-foreground")}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: info.dexes[0]?.color ?? "currentColor" }}
              />
              <span className="flex-1 truncate">{info.label}</span>
              {key === "bsc" && state?.network === "testnet" && (
                <span className="text-[10px] font-semibold text-amber-500">testnet</span>
              )}
              {active && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 pb-1.5 text-[10px] leading-4 text-muted-foreground">
          Each chain has its own DEX whitelist, lenders and armed deployment.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
