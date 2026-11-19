/**
 * SOL Contract — the Solana terminal's on-chain execution status.
 *
 * Two rails exist, and this page says exactly which one is armed:
 *
 *  • Jupiter — real swaps from the armed wallet (vault or external). No
 *    program is involved, so nothing has to be deployed. The vault rail
 *    carries a 0.05 SOL minimum clip.
 *  • solcontract — the FlashboltSolana program. It needs a deployed program
 *    ID, an explicit operator authorization for the vault wallet and, on
 *    mainnet, the independent audit sign-off. Until all three exist the rail
 *    refuses; nothing is mocked to look deployed.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { useTerminal } from "@/hooks/use-terminal";
import { JITO_RELAY_LABEL } from "@/lib/solana-jito";
import { SOL_VAULT_MIN_SWAP_LAMPORTS, solRailVerdict } from "@/lib/solana-policy";
import {
  CheckCircle2,
  CircleDashed,
  FileCode2,
  ShieldCheck,
  Wallet,
} from "lucide-react";

export default function SolContract() {
  const { state, setMode } = useTerminal();
  const connected = (state?.connectedWallets?.length ?? 0) > 0;
  const cluster = state?.solNetwork === "testnet" ? "testnet" : "mainnet";
  const rail = state?.solExecutionRail ?? "jupiter";
  const programId = state?.solContractProgramId ?? "";
  const authorized = state?.solContractAuthorized ?? false;
  const auditApproved = state?.solAuditApproved ?? false;

  const jupiterRail = solRailVerdict({ rail: "jupiter", cluster });
  const contractRail = solRailVerdict({
    rail: "solcontract",
    cluster,
    programId,
    authorized,
    auditApproved,
  });
  const activeRail = rail === "jupiter" ? jupiterRail : contractRail;

  const requirements = [
    {
      label: "Jupiter rail",
      desc: `Real Jupiter swaps from the armed wallet — vault minimum ${(
        SOL_VAULT_MIN_SWAP_LAMPORTS / 1_000_000_000
      ).toFixed(2)} SOL. No program deployment involved.`,
      done: jupiterRail.ok,
      href: "/sol-terminal/strategy",
    },
    {
      label: "solcontract rail",
      desc:
        contractRail.blockers.length === 0
          ? `FlashboltSolana ${programId} is authorized for the vault wallet on ${cluster}.`
          : contractRail.blockers.join("; ") + ".",
      done: contractRail.ok,
      href: "/sol-terminal/strategy",
    },
    {
      label: "FlashboltSolana instruction builder",
      desc:
        "Pending — the rail can be configured and authorized, but the engine has no IDL-driven flash_arb builder yet, so it refuses instead of falling through to Jupiter.",
      done: false,
      href: "/sol-terminal/strategy",
    },
    {
      label: "Wallet signer",
      desc: "Vault wallet (in-app, no prompt) or a connected Phantom / Solflare / Backpack as the external wallet.",
      done: connected,
      href: "/sol-terminal/wallets",
    },
    {
      label: "Protected relay",
      desc:
        JITO_RELAY_LABEL +
        " — bundles + revert protection, with the tip attached before signing.",
      done: state?.privateSubmit ?? true,
      href: "/sol-terminal/strategy",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Contract
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          On-chain execution status — Jupiter rail or the FlashboltSolana program
        </p>
      </header>

      <TerminalContextStrip />

      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileCode2 className="size-4 text-primary" />
            Execution rails
            <Badge
              className={
                activeRail.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {activeRail.ok ? "ARMED" : "BLOCKED"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {rail === "jupiter" ? "Jupiter" : "solcontract"} · {cluster}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <p>
            Solana executes in two ways here. The <strong>Jupiter rail</strong>{" "}
            quotes both legs and the armed wallet signs ordinary swaps — no
            deployed contract is needed. The <strong>solcontract rail</strong>{" "}
            calls the FlashboltSolana program, so it stays blocked until the
            program is deployed, authorized for the vault wallet, and (on
            mainnet) audited. The scanner refuses on an unarmed rail before any
            wallet prompt.
          </p>
          <div className="space-y-2">
            {requirements.map((r) => (
              <div
                key={r.label}
                className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5"
              >
                {r.done ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                ) : (
                  <CircleDashed className="mt-0.5 size-4 shrink-0 text-amber-400" />
                )}
                <div>
                  <div className="text-xs font-semibold text-foreground">{r.label}</div>
                  <p className="mt-0.5 text-[11px] leading-4">{r.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-[11px]">
            <ShieldCheck className="size-3.5 shrink-0 text-primary" />
            {activeRail.message}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!connected}
              onClick={() => void setMode({ mode: connected ? "live" : "paper" })}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-[11px] font-semibold transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Wallet className="size-3" />
              {state?.mode === "live" ? "Live mode armed" : "Arm live mode"}
            </button>
            <span className="text-[10px]">
              Paper mode always available — no chain interaction.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
