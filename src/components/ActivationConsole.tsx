/**
 * Operator console for the authorization + discovery registry.
 *
 * Three sections, all backend-authoritative:
 *   - chain activations (create → approve → suspend/revoke, plus bytecode pin),
 *   - validated RPC endpoints (server-side probe; stored first, discovered second),
 *   - validated addresses (router / factory / token / pool / executor).
 *
 * Every action calls an operator-gated mutation; if the signed-in user is not
 * the operator the backend refuses and the panel shows the error. This UI has
 * no local override: nothing here can activate a chain or approve an address
 * without the server accepting the call.
 */
import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { chainForChainId } from "@/lib/chains";
import { useTerminal } from "@/hooks/use-terminal";
import { activationStateFor } from "@/chains/registry/activations";
import {
  INSPECTION_TTL_MS,
  inspectionExpired,
  inspectionLabel,
  inspectionRemainingMs,
} from "@/convex/pinGuard";
import { ShieldAlert } from "lucide-react";

const DAY_MS = 86_400_000;
const KINDS = ["router", "factory", "token", "pool", "executor"] as const;

function statusTone(status: string): string {
  if (status === "ACTIVE" || status === "VALIDATED") return "text-emerald-400";
  if (status === "PENDING") return "text-amber-400";
  return "text-rose-400";
}

function fmt(ts?: number): string {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—";
}

export function ActivationConsole() {
  const { state } = useTerminal();
  const activations = useQuery(api.chainActivations.activationHistory, {});
  const records = useQuery(api.discovery.discoveryRecordAudit, {});
  const endpoints = useQuery(api.discovery.rpcEndpointAudit, {});

  const createActivation = useMutation(api.chainActivations.createActivation);
  const recordSnapshot = useMutation(api.chainActivations.recordValidationSnapshot);
  const approveActivation = useMutation(api.chainActivations.approveActivation);
  const suspendActivation = useMutation(api.chainActivations.suspendActivation);
  const revokeActivation = useMutation(api.chainActivations.revokeActivation);
  const pinCodeHash = useMutation(api.chainActivations.pinContractCodeHash);
  const pinExecutorContract = useMutation(api.chainActivations.pinExecutorContract);
  const inspectCode = useAction(api.chainActivations.inspectExecutorCode);
  const backfillArmStamps = useMutation(api.terminal.backfillArmStamps);

  const registerRecord = useMutation(api.discovery.registerDiscoveryRecord);
  const validateRecord = useMutation(api.discovery.validateDiscoveryRecord);
  const revokeRecord = useMutation(api.discovery.revokeDiscoveryRecord);
  const validateRpc = useAction(api.discovery.validateRpcEndpoint);
  const seedTargets = useAction(api.discovery.seedBscTargets);

  const destinations = useQuery(api.destinations.internalDestinationAudit, {});
  const approveDestination = useMutation(api.destinations.approveInternalDestination);
  const disableDestination = useMutation(api.destinations.disableInternalDestination);

  const [busy, setBusy] = useState<string>("");
  const [reason, setReason] = useState("operator review");
  const [chainId, setChainId] = useState("56");
  const [evidence, setEvidence] = useState("reports/incident-2026-11-13-bnb-drain.md");
  const [contract, setContract] = useState("");
  const [termDays, setTermDays] = useState("90");

  /**
   * The executor this terminal armed ON THE CHAIN IN THE FIELD. Resolved from
   * that chain's deployment record only — a single global
   * `deployedContractAddress` fallback would compare a BSC address against a
   * different chain's entry and either block a correct pin or wave a wrong one
   * through. The backend enforces the same rule; this is the readable preview.
   */
  const armedChainKey = chainForChainId(Number(chainId));
  const armedExecutor = (armedChainKey ? (state?.deployments?.[armedChainKey]?.contractAddress ?? "") : "").trim();

  const [rpcUrl, setRpcUrl] = useState("");
  const [rpcChain, setRpcChain] = useState("56");
  const [rpcOrigin, setRpcOrigin] = useState("stored");

  const [kind, setKind] = useState<(typeof KINDS)[number]>("router");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [executorAddress, setExecutorAddress] = useState("");
  const [executorPreview, setExecutorPreview] = useState<{
    address: string;
    hash: string;
    bytes: number;
    rpcHost: string;
    /** Server-issued expiry for this observation. */
    expiresAt: number;
    /** Server clock at the moment the action answered. */
    serverNow: number;
  } | null>(null);
  /**
   * Countdown anchored to the SERVER's expiry and measured with a monotonic
   * clock — a wrong, changed or timezone-shifted browser clock cannot make the
   * evidence look fresher (or staler) than the backend says it is.
   */
  const [elapsedSinceInspect, setElapsedSinceInspect] = useState(0);
  useEffect(() => {
    if (!executorPreview) return;
    const started = performance.now();
    setElapsedSinceInspect(0);
    const id = setInterval(() => setElapsedSinceInspect(performance.now() - started), 1000);
    return () => clearInterval(id);
  }, [executorPreview]);
  const inspectionRemaining = executorPreview
    ? inspectionRemainingMs({
        expiresAt: executorPreview.expiresAt,
        serverNow: executorPreview.serverNow,
        elapsedSinceResponse: elapsedSinceInspect,
      })
    : Number.NaN;
  const inspectionFresh = executorPreview !== null && !inspectionExpired(inspectionRemaining);
  const [destAddress, setDestAddress] = useState("");
  const [destLabel, setDestLabel] = useState("BSC profit vault");

  const activationRows = useMemo(() => activations ?? [], [activations]);
  const recordRows = useMemo(() => records ?? [], [records]);
  const endpointRows = useMemo(() => endpoints ?? [], [endpoints]);
  const destinationRows = useMemo(() => destinations ?? [], [destinations]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy("");
    }
  };

  const attestChecks = (detail: string) => [
    { id: "operator-review", ok: true, detail },
    { id: "chain-id", ok: true, detail: `chain ${chainId} asserted by the operator for this approval` },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-primary" />
          Authorization console
          <Badge variant="outline" className="text-[9px] uppercase">
            operator only
          </Badge>
        </CardTitle>
        <CardDescription>
          Activation is an approval with a term, not a switch. Every action here is an operator-gated
          backend mutation; the execution gate reads the result and fails closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-[12px]">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Reason (used by every action below)
            </label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-xs" />
          </div>
        </div>

        {/* ── Activations ─────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Chain activations
          </div>
          {activationRows.length === 0 && (
            <p className="text-muted-foreground">No records (or this account is not the operator).</p>
          )}
          {activationRows.map((row) => {
            const live = activationStateFor(row.chainId, row.environment as "mainnet" | "testnet");
            return (
              <div key={row._id} className="rounded-md border border-border/40 p-2 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    chain {row.chainId} · {row.environment}
                  </span>
                  <span className={statusTone(live.state === "active" ? "ACTIVE" : row.effectiveStatus)}>
                    {row.effectiveStatus}
                  </span>
                  <span className="text-muted-foreground">expires {fmt(row.expiresAt)}</span>
                  {row.contractCodeInspectedAt ? (
                    <span className="text-muted-foreground">
                      · code evidence read {fmt(row.contractCodeInspectedAt)}
                      {row.contractCodeRpcHost ? ` via ${row.contractCodeRpcHost}` : ""}
                    </span>
                  ) : null}
                  {row.contractCodeHash ? (
                    <Badge variant="outline" className="text-[9px]">
                      bytecode pinned
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] text-amber-400">
                      bytecode unpinned
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground">
                  evidence: {row.evidenceRefs.join(", ") || "none"} · approved by {row.approvedBy ?? "—"}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy === row._id}
                    onClick={() =>
                      void run(`s-${row._id}`, () => suspendActivation({ activationId: row._id, reason }), "Suspended")
                    }
                  >
                    Suspend
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                    disabled={busy === row._id}
                    onClick={() =>
                      void run(`r-${row._id}`, () => revokeActivation({ activationId: row._id, reason }), "Revoked")
                    }
                  >
                    Revoke
                  </Button>
                  {/* The backend refuses a hash-only pin for an activation with no
                      pinned address, so offer the flow that can actually approve
                      one instead of a button whose only outcome is an error. */}
                  {/^0x[0-9a-fA-F]{40}$/.test(row.contractAddress ?? "") ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs"
                      disabled={busy === row._id}
                      onClick={() =>
                        void run(
                          `p-${row._id}`,
                          async () => {
                            // The hash comes from the backend's own read of the
                            // chain; typing a hash by hand no longer pins.
                            const inspected = await inspectCode({
                              activationId: row._id,
                              address: row.contractAddress!,
                            });
                            await pinCodeHash({
                              activationId: row._id,
                              codeHash: inspected.hash,
                              reason: `${reason} (${inspected.bytes} bytes read by the server via ${inspected.rpcHost})`,
                            });
                          },
                          "Bytecode pinned",
                        )
                      }
                    >
                      Pin current bytecode
                    </Button>
                  ) : (
                    <span className="self-center text-[10px] text-muted-foreground">
                      No pinned executor — use Inspect code → Confirm &amp; pin executor above
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          <div className="grid gap-2 rounded-md border border-border/40 p-2 sm:grid-cols-4">
            <Input value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="chain id" className="h-8 text-xs" />
            <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="evidence refs" className="h-8 text-xs sm:col-span-2" />
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={busy === "create"}
              onClick={() =>
                void run(
                  "create",
                  () =>
                    createActivation({
                      chainId: Number(chainId),
                      environment: "mainnet",
                      evidenceRefs: evidence.split(",").map((r) => r.trim()).filter(Boolean),
                      reason,
                    }),
                  "PENDING activation created",
                )
              }
            >
              Request activation
            </Button>
          </div>

          {activationRows.filter((row) => row.effectiveStatus !== "ACTIVE").length > 0 && (
            <div className="grid gap-2 rounded-md border border-border/40 p-2 sm:grid-cols-4">
              <Input value={contract} onChange={(e) => setContract(e.target.value)} placeholder="executor 0x…" className="h-8 text-xs sm:col-span-2" />
              <Input value={termDays} onChange={(e) => setTermDays(e.target.value)} placeholder="term days" className="h-8 text-xs" />
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={busy === "approve"}
                onClick={() => {
                  const target = activationRows.find((row) => row.effectiveStatus !== "ACTIVE");
                  if (!target) return;
                  void run(
                    "approve",
                    async () => {
                      const days = Math.min(Math.max(Number(termDays) || 90, 1), 180);
                      const snapshotId = await recordSnapshot({
                        chainId: target.chainId,
                        environment: target.environment as "mainnet" | "testnet",
                        softwareVersion: "operator-console",
                        checks: attestChecks(reason),
                        unverified: [],
                        contractAddress: contract,
                        rpcEndpoints: [],
                      });
                      await approveActivation({
                        activationId: target._id,
                        validationSnapshotId: snapshotId,
                        contractAddress: contract,
                        expiresAt: Date.now() + days * DAY_MS,
                        reason,
                      });
                    },
                    "Activation approved",
                  );
                }}
              >
                Approve pending
              </Button>
              <p className="sm:col-span-4 text-[10px] text-muted-foreground">
                Approval pins the executor address and a term (≤180 days). The snapshot records an
                operator attestation — it is evidence of review, not proof of correctness.
              </p>
            </div>
          )}
        </div>

        {/* ── RPC endpoints ───────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            RPC endpoints (server-probed)
          </div>
          <div className="grid gap-2 sm:grid-cols-5">
            <Input value={rpcChain} onChange={(e) => setRpcChain(e.target.value)} placeholder="chain" className="h-8 text-xs" />
            <Input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder="https://…" className="h-8 text-xs sm:col-span-2" />
            <select
              value={rpcOrigin}
              onChange={(e) => setRpcOrigin(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="stored">stored</option>
              <option value="discovered">discovered</option>
              <option value="operator">operator</option>
            </select>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={busy === "rpc"}
              onClick={() =>
                void run(
                  "rpc",
                  () => validateRpc({ chainId: Number(rpcChain), url: rpcUrl, origin: rpcOrigin }),
                  "Probe recorded",
                )
              }
            >
              Validate
            </Button>
          </div>
          <div className="space-y-1">
            {endpointRows.slice(0, 12).map((row) => (
              <div key={row._id} className="flex flex-wrap items-center gap-2">
                <span className={statusTone(row.status)}>{row.status}</span>
                <span className="font-mono text-[11px]">{row.url}</span>
                <span className="text-muted-foreground">
                  chain {row.chainId} · {row.origin} · {row.latencyMs ?? "—"}ms · {fmt(row.checkedAt)}
                  {row.lastError ? ` · ${row.lastError}` : ""}
                </span>
              </div>
            ))}
            {endpointRows.length === 0 && (
              <p className="text-muted-foreground">
                No endpoints validated yet — execution keeps using the configured/public fallbacks until a
                row passes.
              </p>
            )}
          </div>
        </div>

        {/* ── Executor registration ────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Executor (register, validate, pin)
          </div>
          <p className="text-[10px] text-muted-foreground">
            One step per deployment: read the executor's deployed code, register it in the validated
            registry, approve it with the observed hash, and pin that hash on the active activation. After
            this, internal payouts pass the executor check.
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 p-2">
            <span className="text-[11px] text-muted-foreground">
              Armed in this terminal{armedChainKey ? ` (${armedChainKey})` : ""}:{" "}
              <span className="font-mono">
                {armedExecutor || (armedChainKey ? "none armed for this chain" : "unknown chain id")}
              </span>
            </span>
            {armedExecutor && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px]"
                onClick={() => setExecutorAddress(armedExecutor)}
              >
                Use armed executor
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px]"
              disabled={busy === "backfill-arms"}
              onClick={() => {
                setBusy("backfill-arms");
                void backfillArmStamps({ reason: `${reason} (arm stamp backfill)` })
                  .then((result) => {
                    if (result.stamped.length === 0) {
                      toast.info("Every armed deployment already has a timestamp.");
                      return;
                    }
                    toast.success(
                      `Backfilled ${result.stamped.length} arm stamp${result.stamped.length === 1 ? "" : "s"} — inspect before pinning`,
                    );
                  })
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Action failed"))
                  .finally(() => setBusy(""));
              }}
            >
              Backfill arm stamps
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-6">
            <Input value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="chain" className="h-8 text-xs" />
            <Input
              value={executorAddress}
              onChange={(e) => setExecutorAddress(e.target.value)}
              placeholder="executor 0x…"
              className="h-8 text-xs sm:col-span-3"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs sm:col-span-2"
              disabled={busy === "executor-inspect"}
              onClick={() =>
                void run(
                  "executor-inspect",
                  async () => {
                    const numericChain = Number(chainId);
                    const active = activationRows.find(
                      (row) => row.effectiveStatus === "ACTIVE" && row.chainId === numericChain,
                    );
                    if (!active) {
                      throw new Error(`No ACTIVE activation for chain ${numericChain} — approve the activation first.`);
                    }
                    if (armedExecutor && executorAddress.trim().toLowerCase() !== armedExecutor.toLowerCase()) {
                      throw new Error(
                        `This address is not the executor armed in this terminal (${armedExecutor}). Register the armed contract, or arm this one first.`,
                      );
                    }
                    // The backend reads eth_getCode itself and records what it saw;
                    // the browser never supplies the hash it is approving.
                    const inspected = await inspectCode({
                      activationId: active._id,
                      address: executorAddress.trim(),
                    });
                    setExecutorPreview({
                      address: inspected.address,
                      hash: inspected.hash,
                      bytes: inspected.bytes,
                      rpcHost: inspected.rpcHost,
                      expiresAt: inspected.expiresAt,
                      serverNow: inspected.serverNow,
                    });
                  },
                  "Executor code read — confirm below",
                )
              }
            >
              Inspect code
            </Button>
          </div>
          {executorPreview && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]">
              <p className="text-amber-300">Confirm what will be approved</p>
              <p className="mt-1 font-mono">{executorPreview.address}</p>
              <p className="text-muted-foreground">
                {executorPreview.bytes} bytes · keccak256 {executorPreview.hash}
              </p>
              <p className="mt-1 text-muted-foreground">
                Read by the backend from {executorPreview.rpcHost}. Confirming is refused unless the server observed
                this exact hash in the last {INSPECTION_TTL_MS / 60_000} minutes.
              </p>
              <p className={inspectionFresh ? "mt-1 text-emerald-400" : "mt-1 text-rose-400"}>
                {inspectionLabel(inspectionRemaining)}
                {inspectionFresh ? "" : " — inspect again before confirming"}
              </p>
              <p className="mt-1 text-muted-foreground">
                Approving binds this exact address and this exact runtime code to chain {chainId}. If either
                changes, payouts refuse until you repeat this flow.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy === "executor-confirm" || !inspectionFresh}
                  onClick={() =>
                    void run(
                      "executor-confirm",
                      async () => {
                        const numericChain = Number(chainId);
                        // Match the chain the inspected address belongs to: the
                        // previous lookup took ANY ACTIVE row, so a multi-chain
                        // operator could pin a BSC executor into another
                        // chain's approval (the mutation would catch it, but as
                        // a confusing refusal after registering the record).
                        const active = activationRows.find(
                          (row) => row.effectiveStatus === "ACTIVE" && row.chainId === numericChain,
                        );
                        // Fail loudly instead of "registering" without pinning:
                        // an unapproved activation cannot authorize an executor.
                        if (!active) throw new Error(`No ACTIVE activation for chain ${numericChain} — approve the activation first.`);
                        const recordId = await registerRecord({
                          chainId: numericChain,
                          kind: "executor",
                          address: executorPreview.address,
                          label: "armed executor",
                          evidenceRefs: [reason, "eth_getCode"],
                        });
                        await validateRecord({
                          recordId,
                          checks: [
                            {
                              id: "code-present",
                              ok: true,
                              detail: `${executorPreview.bytes} bytes of runtime code at this address`,
                            },
                            {
                              id: "operator-review",
                              ok: true,
                              detail: `${reason} — confirmed by operator after inspection`,
                            },
                          ],
                          codeHash: executorPreview.hash,
                          reason,
                        });
                        await pinExecutorContract({
                          activationId: active._id,
                          contractAddress: executorPreview.address,
                          codeHash: executorPreview.hash,
                          reason: `${reason} (executor registration)`,
                        });
                        setExecutorPreview(null);
                      },
                      "Executor registered, validated and pinned",
                    )
                  }
                >
                  Confirm &amp; pin executor
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={busy === "executor-confirm"}
                  onClick={() => setExecutorPreview(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            Two steps on purpose: inspection shows the address and hash that will be approved, so a wrong
            address is caught before it is pinned. Re-registering an existing executor is idempotent.
          </p>
        </div>

        {/* ── Internal payout destinations ─────────────────────────────── */}
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Internal payout destinations (server-classified)
          </div>
          <p className="text-[10px] text-muted-foreground">
            A destination is internal only because a row here says so. Connected wallets, card entries and
            the signer's own address are never enough — anything not listed is an external withdrawal and is
            refused.
          </p>
          <div className="grid gap-2 sm:grid-cols-6">
            <Input value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="chain" className="h-8 text-xs" />
            <Input value={destAddress} onChange={(e) => setDestAddress(e.target.value)} placeholder="vault 0x…" className="h-8 text-xs sm:col-span-2" />
            <Input value={destLabel} onChange={(e) => setDestLabel(e.target.value)} placeholder="label" className="h-8 text-xs" />
            <Button
              size="sm"
              className="h-8 text-xs sm:col-span-2"
              disabled={busy === "dest"}
              onClick={() =>
                void run(
                  "dest",
                  () =>
                    approveDestination({
                      chainId: Number(chainId),
                      address: destAddress,
                      label: destLabel,
                      reason,
                    }),
                  "Internal destination approved",
                )
              }
            >
              Approve internal destination
            </Button>
          </div>
          <div className="space-y-1">
            {destinationRows.slice(0, 8).map((row) => (
              <div key={row._id} className="flex flex-wrap items-center gap-2">
                <span className={row.enabled ? "text-emerald-400" : "text-rose-400"}>
                  {row.enabled ? "ENABLED" : "DISABLED"}
                </span>
                <span className="text-muted-foreground">chain {row.chainId}</span>
                <span className="font-mono text-[11px]">{row.address}</span>
                <span className="text-muted-foreground">{row.label ?? "—"}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 text-[10px]"
                  disabled={!row.enabled || busy === `d-${row._id}`}
                  onClick={() =>
                    void run(
                      `d-${row._id}`,
                      () => disableDestination({ destinationId: row._id, reason }),
                      "Destination disabled",
                    )
                  }
                >
                  Disable
                </Button>
              </div>
            ))}
            {destinationRows.length === 0 && (
              <p className="text-muted-foreground">
                No destinations approved — every payout target is classified as an external withdrawal.
              </p>
            )}
          </div>
        </div>

        {/* ── Addresses ───────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Validated addresses
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-[10px]"
              disabled={busy === "seed"}
              onClick={() =>
                void run("seed", () => seedTargets({}), "BSC targets seeded (server-checked)")
              }
            >
              Seed BSC targets
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-6">
            <Input value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="chain" className="h-8 text-xs" />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" className="h-8 text-xs sm:col-span-2" />
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" className="h-8 text-xs" />
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={busy === "register"}
              onClick={() =>
                void run(
                  "register",
                  () =>
                    registerRecord({
                      chainId: Number(chainId),
                      kind,
                      address,
                      label,
                      evidenceRefs: [reason],
                    }),
                  "Registered as PENDING",
                )
              }
            >
              Register
            </Button>
          </div>
          <div className="space-y-1">
            {recordRows.slice(0, 15).map((row) => (
              <div key={row._id} className="flex flex-wrap items-center gap-2">
                <span className={statusTone(row.status)}>{row.status}</span>
                <span className="text-muted-foreground">
                  {row.kind} · chain {row.chainId}
                </span>
                <span className="font-mono text-[11px]">{row.address}</span>
                <span className="text-muted-foreground">
                  {row.codeHash ? "code pinned" : "no code hash"} · expires {fmt(row.expiresAt)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px]"
                  disabled={busy === `v-${row._id}`}
                  onClick={() =>
                    void run(
                      `v-${row._id}`,
                      () =>
                        validateRecord({
                          recordId: row._id,
                          checks: attestChecks(`${reason} — ${row.kind} reviewed`),
                          expiresAt: Date.now() + 90 * DAY_MS,
                          reason,
                        }),
                      "Address validated",
                    )
                  }
                >
                  Validate
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 text-[10px]"
                  disabled={busy === `x-${row._id}`}
                  onClick={() =>
                    void run(`x-${row._id}`, () => revokeRecord({ recordId: row._id, reason }), "Revoked")
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
            {recordRows.length === 0 && (
              <p className="text-muted-foreground">
                No addresses registered. Execution target checks refuse router/factory/executor use until
                the backend has a validated row for them.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
