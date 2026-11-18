/**
 * Blocked-execution counts.
 *
 * Answers "is policy refusing trades, and why?" without reading logs. The rows
 * come from `executionBlocks`, written by the execution gate's callers — they are
 * refusals, not losses: nothing was built, signed or broadcast.
 *
 * Read-only: there is no control here, and the query only returns the signed-in
 * user's own rows.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Ban } from "lucide-react";

function when(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function BlockedExecutionsPanel() {
  const summary = useQuery(api.executionBlocks.blockedExecutionSummary);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="size-4 text-primary" />
          Blocked executions
          <Badge variant="outline" className="text-[9px] uppercase">
            refusals, not losses
          </Badge>
        </CardTitle>
        <CardDescription>
          Trades the execution gate refused before building a transaction. Zero gas, no position, no loss
          counter — a high count means a target is unvalidated, not that the strategy is failing. Repeated
          refusals of the same target collapse into one record with an attempt count, so the totals are
          complete rather than one row per evaluation pass.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-[12px]">
        {summary === undefined && <p className="text-muted-foreground">Loading…</p>}
        {summary === null && (
          <p className="text-muted-foreground">Sign in to see your blocked-execution ledger.</p>
        )}
        {summary && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                <span className="font-semibold">{summary.attempts}</span>{" "}
                <span className="text-muted-foreground">attempts</span>
              </span>
              <span>
                <span className="font-semibold">{summary.rows}</span>{" "}
                <span className="text-muted-foreground">records</span>
              </span>
              <span>
                <span className="font-semibold">{summary.last24h}</span>{" "}
                <span className="text-muted-foreground">last 24h</span>
              </span>
              <span>
                <span className="font-semibold">{summary.last7d}</span>{" "}
                <span className="text-muted-foreground">last 7d</span>
              </span>
              {summary.capped && (
                <Badge variant="outline" className="text-[9px] text-amber-400">
                  scan budget reached — counts are a floor
                </Badge>
              )}
            </div>

            {Object.keys(summary.byCode).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.byCode).map(([code, count]) => (
                  <Badge key={code} variant="outline" className="text-[10px]">
                    {code}: {count}
                  </Badge>
                ))}
              </div>
            )}

            {summary.rows === 0 ? (
              <p className="text-muted-foreground">
                Nothing refused yet. If trades are being blocked you will see the code and reason here.
              </p>
            ) : (
              <ul className="space-y-1">
                {summary.recent.map((row, index) => (
                  <li key={`${row.ts}-${index}`} className="flex flex-wrap gap-2">
                    <span className="text-rose-400">{row.code}</span>
                    <span className="text-muted-foreground">
                      ×{row.hits} · chain {row.chainId} · {when(row.ts)}
                    </span>
                    <span className="min-w-0 break-words text-muted-foreground">{row.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
