/**
 * RPC diagnostics panel — read-only.
 *
 * Shows, per registered network, which endpoints exist and where each came from,
 * the chain id it reports, its latency and head block. It cannot change an
 * endpoint, sign anything, or turn execution on.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, RefreshCw } from "lucide-react";
import { diagnoseNetwork, isNetworkHealthy, type NetworkDiagnostics } from "@/chains/registry/rpc-diagnostics";
import { activationStateFor } from "@/chains/registry/activations";
import { NETWORKS } from "@/chains/registry/networks";

const CHAINS = ["bsc", "bsc-testnet", "base", "base-sepolia", "optimism", "optimism-sepolia", "polygon", "ethereum"];

export function RpcDiagnosticsPanel() {
  const [rows, setRows] = useState<NetworkDiagnostics[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        CHAINS.map((key) => diagnoseNetwork(key, { timeoutMs: 5_000 })),
      );
      setRows(results.filter((row): row is NetworkDiagnostics => Boolean(row)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Diagnostics failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          RPC diagnostics
          <Badge variant="outline" className="text-[9px] uppercase">read-only</Badge>
        </CardTitle>
        <CardDescription>
          Probes every configured endpoint once: origin, reported chain id, latency
          and head block. Nothing here changes configuration or enables execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant="outline" className="gap-2" onClick={run} disabled={busy}>
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
          {busy ? "Probing…" : "Run diagnostics"}
        </Button>

        {error && <p className="text-[12px] text-destructive">{error}</p>}

        {rows && (
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.networkKey} className="rounded-md border border-border/40 p-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-muted-foreground">chain {row.chainId}</span>
                  <span className="text-muted-foreground">
                    {row.healthy} healthy · {row.mismatched} wrong-chain · {row.unreachable} unreachable
                  </span>
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {isNetworkHealthy(row) ? "ok" : "problem"}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {`activation: ${activationStateFor(row.chainId, row.environment).state}`}
                  </Badge>
                </div>
                <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  {row.endpoints.map((endpoint) => (
                    <li key={endpoint.url} className="flex flex-wrap gap-2">
                      <span>{endpoint.ok ? "✔" : "✖"}</span>
                      <span className="font-mono">{hostOf(endpoint.url)}</span>
                      <span>[{endpoint.origin}]</span>
                      <span>
                        {endpoint.ok
                          ? `block ${endpoint.blockNumber} · ${endpoint.latencyMs}ms`
                          : endpoint.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Aggregate networks: {NETWORKS.length} registered · activation applies to live
              signing only, never to withdrawals.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
