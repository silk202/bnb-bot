/**
 * Vault dashboard card — surfaced on BOTH Overview pages (BNB `/terminal`
 * and SOL `/sol-terminal`) so an unwanted or wrongly generated wallet
 * address can be cleared right where the operator lands, without hunting
 * for the Wallets page.
 *
 * Reads the REAL in-memory vault — the exact source the Wallets pages list
 * (`vaultSignerAddresses`), nothing simulated. Removal runs through the
 * shared `describeVaultRemoval` flow both Wallets pages already use: the
 * key leaves memory AND the tab's encrypted blob, and clearing the LAST
 * signer destroys the blob entirely (a clean slate, no Lock needed).
 *
 * Each Overview wires its own vault through the adapter, so this component
 * never imports both vault libraries into one bundle.
 */
import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { describeVaultRemoval } from "@/lib/vault-remove-flow";
import { cn } from "@/lib/utils";

export interface VaultSignerCardAdapter {
  /** Live signer addresses held in THIS tab's vault memory. */
  addresses: () => string[];
  /** Remove one address from memory + the encrypted blob (false = unknown). */
  remove: (address: string) => boolean;
  /** Short display form of the address (0x1234…abcd / AbCd12…wXyZ). */
  clip: (address: string) => string;
  /** Route to this terminal's Wallets page (import / unlock / recovery). */
  walletsHref: string;
}

export function VaultSignerCard({ adapter }: { adapter: VaultSignerCardAdapter }) {
  const [signers, setSigners] = useState<string[]>(() => adapter.addresses());
  // Two-step remove — clearing the LAST signer destroys the whole encrypted
  // blob (no undo), so the first press arms, the second press commits.
  const [confirming, setConfirming] = useState<string | null>(null);

  const handleRemove = (address: string) => {
    if (confirming !== address) {
      setConfirming(address);
      return;
    }
    setConfirming(null);
    const outcome = describeVaultRemoval({
      remove: () => adapter.remove(address),
      remaining: adapter.addresses,
    });
    if (!outcome.removed) return;
    setSigners(outcome.remaining);
    toast.success(outcome.cleanSlate ? "Vault cleared — clean slate" : "Signer removed from vault", {
      description:
        `${adapter.clip(address)} no longer signs for live execution. ` +
        (outcome.cleanSlate
          ? outcome.message
          : "The remaining signers are untouched — regenerate the recovery sheet for them."),
    });
  };

  return (
    <Card className="border-emerald-500/25 bg-emerald-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex items-center gap-2 text-emerald-400">
            <ShieldCheck className="size-4" />
            Vault dashboard — clear unwanted signers
          </span>
          <Link
            to={adapter.walletsHref}
            className="group flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-emerald-400"
          >
            Manage vault
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The live in-memory signers of this tab — the same list the Wallets page holds. Remove an address
          that was imported or derived by mistake: it stops signing immediately, and clearing the last one
          destroys the encrypted blob too (clean slate). Nothing here is simulated.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {signers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/60 bg-background/30 px-4 py-6 text-center">
            <ShieldCheck className="size-5 text-muted-foreground/60" />
            <p className="text-xs font-semibold text-foreground">No live signers in this tab</p>
            <p className="max-w-md text-[11px] leading-4 text-muted-foreground">
              The vault is empty or locked. Open Wallets to import a secret or unlock it — once signers
              are live they appear here for one-click removal.
            </p>
            <Link
              to={adapter.walletsHref}
              className="group flex items-center gap-1 text-[11px] font-semibold text-primary"
            >
              Open Wallets
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                {signers.length} live signer{signers.length === 1 ? "" : "s"}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                balances, import and the recovery sheet live on the Wallets page
              </span>
            </div>
            {signers.map((address) => {
              const armed = confirming === address;
              return (
                <div
                  key={address}
                  className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-background/50 px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs font-semibold text-emerald-300">
                    {adapter.clip(address)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={armed ? `Confirm removal of ${address}` : `Remove ${address}`}
                    className={cn(
                      "h-7 shrink-0 gap-1 text-[10px]",
                      armed
                        ? "border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                        : "text-red-400 hover:text-red-300",
                    )}
                    onClick={() => handleRemove(address)}
                  >
                    {armed ? (
                      signers.length === 1 ? "Confirm — clears vault" : "Confirm remove"
                    ) : (
                      <>
                        <Trash2 className="size-3" />
                        Remove
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}
