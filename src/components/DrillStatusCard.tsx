/**
 * DrillStatusCard — the release drill hold, surfaced in the terminal UI.
 *
 * Renders the REAL pinned artifact `reports/drill-latest.txt` (the verbatim
 * output of the last `bun run drill:report`), evaluated by the SAME pure
 * logic the release gate uses (src/lib/drill-report.ts — scripts/
 * check-drill-gate.ts re-exports it). Nothing is simulated: the verdict text
 * shown here is parsed from that run, and an unparseable artifact is shown
 * as an honest parse failure, never as a fabricated state.
 */
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { evaluateDrillReport, extractDrillAddresses } from "@/lib/drill-report";
import { AlertTriangle, CheckCircle2, ExternalLink, Terminal } from "lucide-react";

// The verbatim pinned report — Vite inlines the real file contents at build.
import pinnedReport from "../../reports/drill-latest.txt?raw";

function hoursAgoLabel(ageHours: number | null): string {
  if (ageHours === null) return "unknown age";
  if (ageHours < 1) return `${Math.max(1, Math.round(ageHours * 60))}m ago`;
  return `${ageHours.toFixed(1)}h ago`;
}

export function DrillStatusCard({ className }: { className?: string }) {
  const result = useMemo(() => evaluateDrillReport(pinnedReport), []);
  const addresses = useMemo(() => extractDrillAddresses(pinnedReport), []);

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight">
          <Terminal className="size-4 text-primary" />
          Live-path drill report
        </CardTitle>
        <Badge variant={result.ok ? "default" : "outline"} className="cursor-default">
          {result.ok ? (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="size-3" /> {result.verdict}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <AlertTriangle className="size-3 text-amber-500" /> {result.verdict} — releases held
            </span>
          )}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {result.problems.length === 0 ? (
          <p className="text-muted-foreground">
            Fresh 2/2 combined verdict on the real test networks
            {result.ageHours !== null ? ` (${hoursAgoLabel(result.ageHours)})` : ""} — the release
            gate is satisfied.
          </p>
        ) : (
          <>
            {result.problems.map((p) => (
              <p key={p} className="text-destructive/90">
                {p}
              </p>
            ))}
            <ul className="space-y-1 text-muted-foreground">
              {addresses.evm && (
                <li className="flex flex-wrap items-center gap-1">
                  <span className="font-mono text-xs">{addresses.evm}</span>
                  <a
                    className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline"
                    href={`https://testnet.bscscan.com/address/${addresses.evm}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    explorer <ExternalLink className="size-3" />
                  </a>
                  <span className="text-xs">— BSC testnet faucet (CAPTCHA)</span>
                </li>
              )}
              {addresses.sol && (
                <li className="flex flex-wrap items-center gap-1">
                  <span className="font-mono text-xs">{addresses.sol}</span>
                  <a
                    className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline"
                    href={`https://explorer.solana.com/address/${addresses.sol}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    explorer <ExternalLink className="size-3" />
                  </a>
                  <span className="text-xs">— Solana devnet faucet</span>
                </li>
              )}
            </ul>
            <p className="text-xs text-muted-foreground">
              One-time manual drip, then{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">bun run drill:report</code>{" "}
              — the same run the CLI gate reads. Full runbook: DRILLS.md.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
