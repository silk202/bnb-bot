/**
 * Solana execution panel for Operator Settings — the two engines side by side.
 *
 * The point of this card is separation of concerns: **Jupiter Swap** already
 * executes real swaps and must keep working regardless of where the flash
 * arbitrage work stands. So the card
 *
 *  • shows each engine's implementation steps and their real status,
 *  • lets the operator switch the ACTIVE engine without touching the other
 *    engine's settings (venue whitelist, slippage, loan bounds, authorization
 *    all persist — only `solExecutionRail` changes),
 *  • arms the arbitrage rail independently of which engine is active, and
 *  • reports the FlashboltSolana program exactly as the tracked IDL declares
 *    it, plus the verified Jupiter Lend deployment facts.
 *
 * No control here claims a deployment, a verification or a profit that has not
 * happened. The rail verdicts come from `solRailVerdict`, the same function the
 * scanner gates on.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useTerminal } from "@/hooks/use-terminal";
import { userSafeBackendError } from "@/lib/backend-outage";
import {
  FLASHBOLT_ERRORS,
  FLASHBOLT_IDL_META,
  FLASHBOLT_INSTRUCTIONS,
  FLASHBOLT_PROGRAM_ID,
  JUPITER_LEND,
  SOL_ENGINE_PLANS,
  flashboltInstructionLine,
  solPlanStatusLabel,
  solPlanTally,
  type SolPlanStatus,
} from "@/lib/solana-execution-plan";
import { solRailVerdict, type SolExecutionRail } from "@/lib/solana-policy";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileCode2,
  Landmark,
  Layers,
  Wallet,
} from "lucide-react";

const STATUS_STYLES: Record<SolPlanStatus, string> = {
  done: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  next: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  pending: "border-border/70 bg-muted/40 text-muted-foreground",
  blocked: "border-amber-500/30 bg-amber-500/10 text-amber-400",
};

function StatusIcon({ status }: { status: SolPlanStatus }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />;
  if (status === "blocked") return <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />;
  if (status === "next") return <Clock3 className="mt-0.5 size-3.5 shrink-0 text-sky-400" />;
  return <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

/** The only fields this card writes — everything else persists untouched. */
type SettingsPatch = {
  solExecutionRail?: SolExecutionRail;
  solContractAuthorized?: boolean;
  solContractProgramId?: string;
};

export function SolExecutionPlanPanel() {
  const { state, setSettings } = useTerminal();
  const cluster = state?.solNetwork ?? "mainnet";
  const rail: SolExecutionRail = state?.solExecutionRail ?? "jupiter";
  const programId = (state?.solContractProgramId ?? "").trim();
  const authorized = state?.solContractAuthorized ?? false;
  const auditApproved = state?.solAuditApproved ?? false;

  const swapVerdict = solRailVerdict({ rail: "jupiter", cluster });
  const arbVerdict = solRailVerdict({
    rail: "solcontract",
    cluster,
    programId,
    authorized,
    auditApproved,
  });

  const programMatchesIdl = programId === FLASHBOLT_PROGRAM_ID;
  const activeVerdict = rail === "jupiter" ? swapVerdict : arbVerdict;

  // Every control here writes to the operator's terminal state. A rejected
  // mutation must never disappear into a `void` — the page would keep
  // showing a value the backend does not hold. Each save reports its failure
  // inline (and as a toast) and re-enables the control.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async (patch: SettingsPatch, what: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await setSettings(patch);
    } catch (err) {
      const message = userSafeBackendError(
        err,
        "The settings mutation failed — try again.",
      );
      setSaveError(`Could not save ${what} — ${message}`);
      toast.error(`Could not save ${what}`, { description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Layers className="size-4 text-primary" />
          Solana execution engines
          <Badge variant="outline" className="text-[9px] uppercase">
            Jupiter Swap · flash arbitrage
          </Badge>
        </CardTitle>
        <CardDescription>
          Two engines, one wallet and one cluster pin. Switching the active
          engine never changes the other engine's settings, and no arbitrage
          work can block the Jupiter Swap rail.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {saveError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] leading-4 text-amber-400"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{saveError}</span>
          </div>
        )}

        {/* Active engine — the only shared knob. */}
        <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-foreground">Active engine</div>
              <p className="text-[10px] text-muted-foreground">
                Only the rail selector changes. Venue whitelist, slippage, loan
                bounds and the arbitrage authorization stay as they are.
              </p>
            </div>
            <Badge variant="outline" className="text-[10px]">
              {cluster === "mainnet" ? "mainnet-beta" : "devnet"}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { key: "jupiter", title: "Jupiter Swap", sub: "real swaps", verdict: swapVerdict },
                { key: "solcontract", title: "Flash arbitrage", sub: "flash_arb", verdict: arbVerdict },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={!option.verdict.ok || saving}
                aria-disabled={!option.verdict.ok || saving}
                title={option.verdict.ok ? undefined : option.verdict.message}
                onClick={() =>
                  void save(
                    { solExecutionRail: option.key },
                    `active engine (${option.title})`,
                  )
                }
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  rail === option.key
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-border/60 bg-background/40 hover:border-primary/40",
                  !option.verdict.ok && "cursor-not-allowed opacity-60 hover:border-border/60",
                )}
              >
                <div className="text-xs font-semibold text-foreground">{option.title}</div>
                <div className="text-[10px] text-muted-foreground">
                  {option.verdict.ok ? `armed — ${option.sub}` : "blocked — cannot be activated"}
                </div>
              </button>
            ))}
          </div>
          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-[10px] leading-4",
              activeVerdict.ok
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                : "border-amber-500/30 bg-amber-500/5 text-amber-400",
            )}
          >
            <div>{activeVerdict.message}</div>
            {!activeVerdict.ok && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="text-amber-400/80">
                  This rail cannot be selected or signed on until every listed
                  requirement is met.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 border-amber-500/40 bg-amber-500/5 px-2 text-[10px] text-amber-400"
                  disabled={saving}
                  onClick={() => void save({ solExecutionRail: "jupiter" }, "active engine")}
                >
                  Switch to Jupiter Swap
                </Button>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2">
            <div>
              <div className="text-[11px] font-semibold text-foreground">
                Flash arbitrage authorized for the vault
              </div>
              <p className="text-[10px] text-muted-foreground">
                Persistent and independent — it can be armed while Jupiter Swap
                stays the active engine.
              </p>
            </div>
            <Switch
              checked={authorized}
              disabled={saving}
              onCheckedChange={(v) =>
                void save({ solContractAuthorized: v }, "flash arbitrage authorization")
              }
            />
          </div>
        </div>

        {/* Implementation steps per engine */}
        <div className="grid gap-3 lg:grid-cols-2">
          {SOL_ENGINE_PLANS.map((engine) => {
            const tally = solPlanTally(engine.steps);
            return (
              <div
                key={engine.id}
                className="space-y-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{engine.name}</div>
                    <p className="text-[10px] text-muted-foreground">{engine.summary}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {tally.done}/{tally.total} done
                    {tally.blocked > 0 ? ` · ${tally.blocked} blocked` : ""}
                  </Badge>
                </div>
                <ol className="space-y-2">
                  {engine.steps.map((step, index) => (
                    <li key={step.id} className="flex items-start gap-2">
                      <StatusIcon status={step.status} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-foreground">
                            {index + 1}. {step.title}
                          </span>
                          <span
                            className={cn(
                              "rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
                              STATUS_STYLES[step.status],
                            )}
                          >
                            {solPlanStatusLabel(step.status)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                          {step.detail}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-[9px] text-muted-foreground/70">
                          {step.evidence}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>

        {/* FlashboltSolana — read straight from the tracked IDL */}
        <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <FileCode2 className="size-3.5 text-primary" />
              FlashboltSolana program (IDL v{FLASHBOLT_IDL_META.version})
            </div>
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] uppercase",
                programMatchesIdl
                  ? "border-emerald-500/30 text-emerald-400"
                  : "border-amber-500/30 text-amber-400",
              )}
            >
              {programId ? (programMatchesIdl ? "matches IDL" : "differs from IDL") : "not configured"}
            </Badge>
          </div>
          <div className="space-y-1 font-mono text-[10px]">
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">IDL address</span>
              <span className="break-all text-right text-foreground/90">{FLASHBOLT_PROGRAM_ID}</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Configured</span>
              <span className="break-all text-right text-foreground/90">
                {programId || "— (empty on SOL Strategy)"}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Surface</span>
              <span className="text-right text-foreground/90">
                {FLASHBOLT_INSTRUCTIONS.length} instructions · {FLASHBOLT_ERRORS.length} error codes
              </span>
            </div>
          </div>
          <ul className="space-y-0.5">
            {FLASHBOLT_INSTRUCTIONS.map((ix) => (
              <li key={ix.name} className="break-all font-mono text-[10px] text-muted-foreground">
                {flashboltInstructionLine(ix)}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              disabled={programMatchesIdl || saving}
              onClick={() =>
                void save(
                  { solContractProgramId: FLASHBOLT_PROGRAM_ID },
                  "FlashboltSolana program ID",
                )
              }
            >
              Use the IDL address
            </Button>
            <span className="text-[10px] text-muted-foreground">
              The IDL address is the program's declared address — not proof it is
              deployed on this cluster.
            </span>
          </div>
        </div>

        {/* Jupiter Lend — the verification record */}
        <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Landmark className="size-3.5 text-primary" />
              Lender — {JUPITER_LEND.name}
            </div>
            <Badge variant="outline" className="text-[9px] uppercase">
              fee {JUPITER_LEND.feeLabel} · cap {JUPITER_LEND.feeCapPct}%
            </Badge>
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground">
            {JUPITER_LEND.feeSource}. Borrow and payback are top-level
            instructions around our CPI, so <span className="font-mono">flash_arb</span> stays the middle
            instruction in <span className="font-mono">[borrow, flash_arb, payback]</span> and verifies the
            loan by balance delta.
          </p>
          <div className="space-y-1 font-mono text-[10px]">
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Flashloan · mainnet</span>
              <span className="break-all text-right text-emerald-400">{JUPITER_LEND.mainnet.flashloan}</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Liquidity · mainnet</span>
              <span className="break-all text-right text-foreground/90">{JUPITER_LEND.mainnet.liquidity}</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Admin · fee word</span>
              <span className="break-all text-right text-foreground/90">
                {JUPITER_LEND.admin.pda} · fee word {JUPITER_LEND.admin.feeWord}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-muted-foreground">Devnet</span>
              <span className="break-all text-right text-amber-400">
                {JUPITER_LEND.devnet.deployed
                  ? "deployed"
                  : `not deployed — ${JUPITER_LEND.devnet.result}`}{` `}
                ({JUPITER_LEND.devnet.checkedOn})
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] leading-4 text-amber-400">
            <Wallet className="mt-0.5 size-3.5 shrink-0" />
            Because the lender has no devnet deployment, no devnet-armed
            flash-arbitrage run can borrow or repay. Jupiter Swap is unaffected
            and keeps executing on its own rail.
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default SolExecutionPlanPanel;
