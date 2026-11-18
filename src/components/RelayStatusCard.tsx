/**
 * RelayStatusCard — live per-chain status of the private-relay submission
 * layer (Flashbots Protect / bloXroute Protect).
 *
 * Probes every registered relay for the SELECTED chain + network with a real
 * eth_chainId round-trip and reports:
 *   • latency (ms) per endpoint — green dot when answering the right chain
 *   • which relay the next hot-wallet broadcast will use
 *   • an honest "public RPC fallback" state for chains with no public no-key
 *     relay (Arbitrum, Polygon, BSC testnet)
 *
 * Probes run on mount, on chain/network change, and via the refresh button.
 * Purely read-only — never broadcasts anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, ShieldCheck, ShieldOff, Globe, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  cacheLatencyRanking,
  getRelayHealth,
  isPrivateRpcAvailable,
  orderEndpointsByLatency,
  privateRpcSet,
  probeAllPrivateRpcs,
  RELAY_COOLDOWN_MS,
  RELAY_FAIL_THRESHOLD,
  type PrivateRpcProbe,
} from "@/lib/private-rpc";
import { recordProbeSample } from "@/lib/relay-history";
import { useTradeSounds } from "@/hooks/use-trade-sounds";
import type { ChainKey, NetworkKey } from "@/lib/chains";
import { networkInfoFor } from "@/lib/chains";

/** Short display host for toasts. */
const fmtHost = (endpoint: string) =>
  endpoint.replace(/^https:\/\//, "").split("/")[0];

interface RelayStatusCardProps {
  chainKey: ChainKey;
  network: NetworkKey;
  /** Fired after each probe round completes (lets parents refresh charts). */
  onProbed?: () => void;
}

type ProbeState =
  | { phase: "idle" | "probing" }
  | { phase: "done"; probes: PrivateRpcProbe[]; measuredAt: number };

/** Auto-probe cadence while the card is mounted. */
const AUTO_REFRESH_MS = 30_000;
/** Preference persists across reloads (per browser, like probe history). */
const AUTO_REFRESH_KEY = "flashbolt.relayAutoRefresh";

function loadAutoRefresh(): boolean {
  try {
    if (localStorage.getItem(AUTO_REFRESH_KEY) === "off") return false;
  } catch {
    // Storage unavailable (private mode) — default on.
  }
  return true;
}

export function RelayStatusCard({ chainKey, network, onProbed }: RelayStatusCardProps) {
  const [probeState, setProbeState] = useState<ProbeState>({ phase: "idle" });
  const [autoRefresh, setAutoRefresh] = useState<boolean>(loadAutoRefresh);
  const { playSound } = useTradeSounds();
  /** Last measured primary relay — alerts fire only on a real transition. */
  const lastPrimaryRef = useRef<string | null>(null);

  const env = networkInfoFor(chainKey, network);
  const available = isPrivateRpcAvailable(env.chainId, network);
  const relays = privateRpcSet(env.chainId, network);

  const runProbe = useCallback(async () => {
    if (!available) {
      setProbeState({ phase: "done", probes: [], measuredAt: Date.now() });
      return;
    }
    setProbeState({ phase: "probing" });
    // Health snapshot before this round — lets us detect relays ENTERING
    // cooldown during the round (also fires for broadcast-path failures,
    // which record into the same health layer and surface on the next round).
    const healthBefore = relays.map(getRelayHealth);
    const probes = await probeAllPrivateRpcs(env.chainId, network);
    // Feed the measured latencies into the shared ranking cache — the
    // broadcast hot path reads this and sends to the FASTEST relay first —
    // and into the persistent probe history for the latency chart.
    cacheLatencyRanking(env.chainId, network, probes);
    const t = Date.now();
    for (const p of probes) {
      recordProbeSample(p.endpoint, { t, latencyMs: p.latencyMs, ok: p.ok, error: p.error });
    }
    setProbeState({ phase: "done", probes, measuredAt: t });

    // ── Transition alerts (sound + toast, real state changes only) ──
    const rankedHealthy = orderEndpointsByLatency(probes.filter((p) => p.ok));
    const primary = rankedHealthy[0] ?? null;
    const prev = lastPrimaryRef.current;
    if (prev && primary && primary !== prev) {
      playSound("alert");
      toast("Fastest relay changed", {
        description: `${fmtHost(prev)} → ${fmtHost(primary)} — broadcasts now go out via ${fmtHost(primary)}.`,
      });
    }
    if (primary) lastPrimaryRef.current = primary;
    relays.forEach((endpoint, i) => {
      const before = healthBefore[i];
      const after = getRelayHealth(endpoint);
      const wasDown = before.degradedUntil != null && before.degradedUntil > t;
      const isDown = after.degradedUntil != null && after.degradedUntil > t;
      if (!wasDown && isDown) {
        playSound("fail");
        toast("Relay entered cooldown", {
          description: `${fmtHost(endpoint)} failed ${RELAY_FAIL_THRESHOLD}× in a row — traffic shifts to the remaining relay(s), then the public RPC.`,
        });
      }
    });

    onProbed?.();
  }, [available, env.chainId, network, onProbed]);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  // Auto-refresh: re-probe on a fixed cadence so the ranking the broadcast
  // hot path reads never goes stale while the page is open. `runProbe` is
  // memoized on chain/network/availability, so the interval only re-arms on
  // a real target change — and a fresh mount probes immediately anyway.
  useEffect(() => {
    if (!autoRefresh || !available) return;
    const id = setInterval(() => {
      void runProbe();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, available, runProbe]);

  const toggleAutoRefresh = (v: boolean) => {
    setAutoRefresh(v);
    try {
      localStorage.setItem(AUTO_REFRESH_KEY, v ? "on" : "off");
    } catch {
      // Storage unavailable — the in-session toggle still applies.
    }
  };

  return (
    <Card className="border-border/70 bg-card/40 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-sky-500/12 text-sky-400">
              <ShieldCheck className="size-4" />
            </div>
            <CardTitle className="text-sm font-semibold">
              Private relay status
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {available ? (
              <Badge className="border-sky-500/25 bg-sky-500/10 text-sky-400">
                Anti-MEV submission armed
              </Badge>
            ) : (
              <Badge variant="outline">Public RPC fallback</Badge>
            )}
            {available && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/50 px-2 py-1">
                <Switch
                  checked={autoRefresh}
                  onCheckedChange={toggleAutoRefresh}
                  aria-label="Auto-refresh relay probes every 30 seconds"
                  className="scale-90"
                />
                <span className="text-[10px] font-medium text-muted-foreground">
                  Auto 30s
                </span>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={probeState.phase === "probing"}
              onClick={() => void runProbe()}
            >
              {probeState.phase === "probing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] leading-4 text-muted-foreground">
          {available
            ? "Signed hot-wallet txs are broadcast to the fastest answering relay below — hidden from the public mempool until inclusion. Reverted txs never land on chain (zero gas on failure)."
            : `No public no-key relay exists for ${env.label} — broadcasts go out the standard public RPC. Nothing is faked: the moment a relay is added to the registry it appears here.`}
        </p>

        {!available ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-background/40 p-3.5">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              Public RPC:{" "}
              <span className="font-mono text-foreground/90">{env.rpc}</span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {(probeState.phase === "done"
              ? // Display in the ranking order the broadcast hot path uses:
                // fastest answering relay first.
                orderEndpointsByLatency(probeState.probes).map((endpoint) => {
                  const probe = probeState.probes.find((p) => p.endpoint === endpoint)!;
                  return { ...probe, primary: endpoint === relays[0] };
                })
              : relays.map((endpoint) => ({
                  endpoint,
                  ok: false,
                  latencyMs: 0,
                  error: undefined as string | undefined,
                  primary: endpoint === relays[0],
                })))
              .map((probe) => (
              <div
                key={probe.endpoint}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 p-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {probeState.phase === "probing" ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : probe.ok ? (
                    <span className="relative flex size-2.5 shrink-0">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                      <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
                    </span>
                  ) : (
                    <ShieldOff className="size-3.5 shrink-0 text-red-400" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-foreground/90">
                        {probe.endpoint.replace(/^https:\/\//, "")}
                      </span>
                      {(() => {
                        const h = getRelayHealth(probe.endpoint);
                        if (h.degradedUntil && Date.now() <= h.degradedUntil) {
                          return (
                            <Badge className="shrink-0 border-amber-500/30 bg-amber-500/10 px-1 py-0 text-[9px] text-amber-400">
                              cooldown {Math.ceil((h.degradedUntil - Date.now()) / 1000)}s
                            </Badge>
                          );
                        }
                        if (h.consecutiveFails > 0) {
                          return (
                            <Badge className="shrink-0 border-border/60 bg-background/60 px-1 py-0 text-[9px] text-muted-foreground">
                              {RELAY_FAIL_THRESHOLD - h.consecutiveFails} fails to cooldown
                            </Badge>
                          );
                        }
                        return null;
                      })()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {probe.primary
                        ? "used first — fastest measured relay"
                        : "failover relay"}
                      {" · "}
                      {probeState.phase === "done" && probe.ok
                        ? "live · correct chain"
                        : probeState.phase === "done"
                          ? probe.error ?? "no answer"
                          : "probing…"}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {probeState.phase === "done" && probe.ok ? (
                    <span className="font-mono text-xs font-bold text-emerald-400">
                      {probe.latencyMs.toFixed(0)} ms
                    </span>
                  ) : probeState.phase === "probing" ? (
                    <span className="text-[10px] text-muted-foreground">…</span>
                  ) : (
                    <span className="text-[10px] text-red-400">down</span>
                  )}
                </div>
              </div>
            ))}
            {probeState.phase === "done" && probeState.probes.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                Measured {new Date(probeState.measuredAt).toLocaleTimeString()} ·
                eth_chainId round-trip from your browser · read-only
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
