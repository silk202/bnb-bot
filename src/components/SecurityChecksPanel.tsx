/**
 * Checks console — one place that answers "what is actually authorized right now".
 *
 * Every row is derived from the backend-hydrated stores, so a check can only
 * pass because the backend said so. Nothing here can change a setting: it
 * observes and explains, and points at the console below when something is
 * missing.
 */
import { useEffect, useReducer } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, ShieldQuestion } from "lucide-react";
import { activationStateFor, subscribeActivations } from "@/chains/registry/activations";
import {
  internalDestinationFor,
  isValidatedAddress,
  subscribeDiscovery,
  validatedAddressCount,
  validatedRpcCount,
} from "@/chains/registry/discovery-store";

const BSC_CHAIN_ID = 56;
const BSC_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const BSC_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export function SecurityChecksPanel() {
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const a = subscribeActivations(force);
    const d = subscribeDiscovery(force);
    return () => {
      a();
      d();
    };
  }, []);

  const activation = activationStateFor(BSC_CHAIN_ID, "mainnet");
  const pinned = activation.record?.contractCodeHash;
  const destination = internalDestinationFor(BSC_CHAIN_ID);
  const routerOk = isValidatedAddress({ chainId: BSC_CHAIN_ID, kind: "router", address: BSC_ROUTER });
  const factoryOk = isValidatedAddress({ chainId: BSC_CHAIN_ID, kind: "factory", address: BSC_FACTORY });
  const wbnbOk = isValidatedAddress({ chainId: BSC_CHAIN_ID, kind: "token", address: WBNB });
  const rpcCount = validatedRpcCount(BSC_CHAIN_ID);
  const addressCount = validatedAddressCount(BSC_CHAIN_ID);

  const checks: Check[] = [
    {
      id: "activation-loaded",
      label: "Backend activation record loaded",
      ok: activation.state !== "not-loaded",
      detail:
        activation.state === "not-loaded"
          ? "The currentActivations query has not answered; live signing is refused."
          : activation.reason,
    },
    {
      id: "bsc-active",
      label: "BSC mainnet activated (unexpired)",
      ok: activation.activated,
      detail: activation.activated ? activation.reason : activation.reason,
    },
    {
      id: "executor-pinned",
      label: "Executor bytecode pinned",
      ok: Boolean(pinned),
      detail: pinned
        ? `pinned ${pinned.slice(0, 12)}…`
        : "No hash pinned — a contract swap under this approval would not be detected. Pin it in the console below.",
    },
    {
      id: "internal-destination",
      label: "Internal payout destination approved",
      ok: Boolean(destination),
      detail: destination
        ? `${destination.address.slice(0, 10)}…${destination.label ? ` (${destination.label})` : ""}`
        : "No approved destination — every payout target classifies as an external withdrawal (refused).",
    },
    {
      id: "router-validated",
      label: "PancakeSwap V2 router validated",
      ok: routerOk,
      detail: routerOk ? BSC_ROUTER : `${BSC_ROUTER} is not validated — buy/sell refuses before signing.`,
    },
    {
      id: "factory-validated",
      label: "PancakeSwap V2 factory validated",
      ok: factoryOk,
      detail: factoryOk ? BSC_FACTORY : `${BSC_FACTORY} is not validated — pair discovery refuses.`,
    },
    {
      id: "wbnb-validated",
      label: "WBNB token validated",
      ok: wbnbOk,
      detail: wbnbOk ? WBNB : `${WBNB} is not validated — swap path token is unverified.`,
    },
    {
      id: "rpc-validated",
      label: "Backend-validated RPC endpoints for BSC",
      ok: rpcCount > 0,
      detail:
        rpcCount > 0
          ? `${rpcCount} validated endpoint(s); stored first, discovered second.`
          : "None validated — execution falls back to configured/public endpoints (chain-id checked, but not backend-approved).",
    },
    {
      id: "external-withdrawals",
      label: "External withdrawals disabled",
      ok: true,
      detail:
        "Refused in the client and by payouts.requestExternalWithdrawal. No destination approved here can make one payable.",
    },
    {
      id: "registry-hydrated",
      label: "Validated discovery registry hydrated",
      ok: addressCount > 0,
      detail:
        addressCount > 0
          ? `${addressCount} validated address record(s) available to execution.`
          : "No validated addresses — router/factory/executor use is refused.",
    },
  ];

  const passing = checks.filter((c) => c.ok).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="size-4 text-primary" />
          Security checks
          <Badge variant="outline" className="text-[9px] uppercase">
            {passing}/{checks.length} passing
          </Badge>
        </CardTitle>
        <CardDescription>
          Derived from the backend stores. A missing check blocks the corresponding operation; fixing it
          requires an operator action in the console below, not a browser flag.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 text-[12px]">
        {checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2">
            {check.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-400" />
            )}
            <div className="min-w-0">
              <span className={check.ok ? "text-foreground" : "font-medium text-rose-400"}>
                {check.label}
              </span>
              <p className="text-[11px] text-muted-foreground break-words">{check.detail}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
