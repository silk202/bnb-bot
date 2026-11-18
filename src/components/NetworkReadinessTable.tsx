/**
 * Read-only network readiness table.
 *
 * Display only: there is no control here that can enable execution, by design.
 * "Pending" means the validators have not been run — it is not a success state,
 * and nothing green is shown for a network that merely answers on RPC.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { deploymentManifest, NETWORKS, type ReadinessState } from "@/chains";

const STATE_STYLE: Record<ReadinessState, string> = {
  UNCONFIGURED: "text-muted-foreground",
  REGISTERED: "text-muted-foreground",
  RPC_VERIFIED: "text-sky-400",
  CONTRACTS_VERIFIED: "text-sky-400",
  INTEGRATIONS_VERIFIED: "text-amber-400",
  SIMULATION_PASSED: "text-amber-400",
  SECURITY_APPROVED: "text-amber-400",
  READY_FOR_REVIEW: "text-amber-300",
  ACTIVE: "text-emerald-400",
  SUSPENDED: "text-destructive",
};

const LABEL: Record<string, string> = {
  UNCONFIGURED: "Unconfigured",
  REGISTERED: "Pending",
  RPC_VERIFIED: "RPC verified",
  CONTRACTS_VERIFIED: "Contracts verified",
  INTEGRATIONS_VERIFIED: "Integrations verified",
  SIMULATION_PASSED: "Simulation passed",
  SECURITY_APPROVED: "Security approved",
  READY_FOR_REVIEW: "Ready for review",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

export function NetworkReadinessTable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          Network readiness
          <Badge variant="outline" className="text-[9px] uppercase">
            read-only
          </Badge>
        </CardTitle>
        <CardDescription>
          Every registered network, its chain identity and RPC count. Execution is
          disabled on every network until validation passes <em>and</em> a separate
          backend authorization is issued; nothing on this page can enable it.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Network</th>
              <th className="py-1 pr-3 font-medium">Env</th>
              <th className="py-1 pr-3 font-medium">Chain</th>
              <th className="py-1 pr-3 font-medium">RPCs</th>
              <th className="py-1 pr-3 font-medium">Readiness</th>
              <th className="py-1 font-medium">Execution</th>
            </tr>
          </thead>
          <tbody>
            {NETWORKS.map((network) => {
              const manifest = deploymentManifest(network.deploymentRegistry);
              // No validator has run in this render, so the honest state is the
              // registered floor — never a green "verified".
              const state: ReadinessState = "REGISTERED";
              return (
                <tr key={network.key} className="border-t border-border/40">
                  <td className="py-1.5 pr-3">{network.name}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{network.environment}</td>
                  <td className="py-1.5 pr-3 font-mono">{network.chainId}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {network.rpc.http.length}
                    {network.rpc.http.length === 0 ? " · none configured" : ""}
                  </td>
                  <td className={`py-1.5 pr-3 ${STATE_STYLE[state]}`}>
                    {LABEL[state] ?? state}
                    {manifest?.status === "unavailable" && (
                      <span className="ml-1 text-[10px] text-muted-foreground">· no deployment</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <Badge variant="outline" className="text-[9px] uppercase">
                      OFF
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
          “Pending” means not yet validated — not a pass. Activation requires a
          backend record with an operator identity, a reason and (on mainnet) a
          production-level attestation.
        </p>
      </CardContent>
    </Card>
  );
}
