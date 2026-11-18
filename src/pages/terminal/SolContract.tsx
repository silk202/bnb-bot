/**
 * SOL Contract — the Solana terminal's on-chain execution status.
 *
 * Solana has no V2-router-style contract to deploy: flash borrows route
 * through the lender programs (Solend / MarginFi / Kamino) and atomic
 * multi-hop routes settle via Jito bundles or a single atomic transaction.
 * This page states the real requirements honestly — no fake contract
 * wizard — and arms live mode once a wallet signer is connected.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { useTerminal } from "@/hooks/use-terminal";
import { JITO_RELAY_LABEL } from "@/lib/solana-jito";
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

  const requirements = [
    {
      label: "Solana wallet signer",
      desc: "Phantom / Solflare / Backpack connected on the Wallets page — it signs the route transactions.",
      done: connected,
      href: "/sol-terminal/wallets",
    },
    {
      label: "Flash-loan stack",
      desc: "Solend 0.3% · MarginFi 0% · Kamino 0.05% — lender programs are live on mainnet, nothing to deploy.",
      done: true,
      href: "/sol-terminal/strategy",
    },
    {
      label: "Protected relay",
      desc: JITO_RELAY_LABEL + " — bundles + revert protection, live at mainnet.block-engine.jito.wtf.",
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
          On-chain execution status — what live mode really requires on Solana
        </p>
      </header>

      <TerminalContextStrip />

      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileCode2 className="size-4 text-primary" />
            No contract deployment needed
            <Badge
              className={
                connected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {connected ? "LIVE READY" : "WALLET REQUIRED"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <p>
            Unlike EVM chains, Solana needs <strong>no user-deployed arbitrage
            contract</strong>. The BNB terminal arms a FlashBoltArbitrage
            contract; the SOL terminal's atomicity comes from the runtime
            itself — a multi-hop route is one atomic transaction, and bundles
            (via the Jito block-engine) are all-or-nothing across up to five
            transactions in one slot.
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
            Live mode {connected ? "is armed — flip it on the Flasher page." : "needs the wallet signer first — connect one on the Wallets page."}
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
