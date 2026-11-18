/**
 * Execution manager: gate → verify chain → simulate → sign → broadcast.
 *
 * It does not switch chains. Provider failover happens inside the RPC manager
 * for the SAME chain, and the chain id is re-verified immediately before the
 * broadcast. Signing is delegated to the caller's signer (hot wallet/vault);
 * this class never holds a key.
 */
import { RpcManager } from "../../lib/rpc-manager";
import type { NetworkConfig } from "../registry/chain-types";
import { canExecute, type ExecutionPolicy, type ExecutionRequest, type GateDecision } from "./execution-gate";
import { simulateTransaction, type SimulationResult } from "./transaction-simulator";
import type { EmergencyCircuitBreaker } from "./emergency-circuit-breaker";

export interface ExecutionOutcome {
  status: "blocked" | "simulated" | "sent" | "uncertain" | "failed";
  reasons: string[];
  simulation?: SimulationResult;
  txHash?: string;
  provider?: string;
}

export interface ExecutionManagerOptions {
  network: NetworkConfig;
  rpc: RpcManager;
  breaker: EmergencyCircuitBreaker;
  policy: () => ExecutionPolicy;
  /** Caller-provided signer: returns the signed raw transaction. */
  sign: (tx: { to: string; data: string; value?: string; gasLimit: string }) => Promise<string>;
  /** Caller-provided hash of the raw transaction (keccak256 of the signed bytes). */
  hashOf: (rawTx: string) => string;
}

export class ExecutionManager {
  private readonly opts: ExecutionManagerOptions;

  constructor(opts: ExecutionManagerOptions) {
    this.opts = opts;
  }

  /** Dry run: gate + simulation only, never signs. */
  async simulate(request: ExecutionRequest, tx: { to: string; data: string; value?: string }): Promise<ExecutionOutcome> {
    const decision = this.decide(request);
    if (!decision.allowed) return { status: "blocked", reasons: decision.reasons };

    const breaker = this.opts.breaker.blockReason();
    if (breaker) return { status: "blocked", reasons: [breaker] };

    const rpcUrl = this.opts.network.rpc.http[0];
    if (!rpcUrl) return { status: "blocked", reasons: ["No RPC endpoint configured."] };

    // The manager's candidates must be verified before any call is routed.
    if (!this.opts.rpc.snapshot().some((s) => s.chainIdOk)) await this.opts.rpc.healthCheck();

    const simulation = await simulateTransaction(
      { rpcUrl, from: request.wallet, to: tx.to, data: tx.data, ...(tx.value ? { value: tx.value } : {}) },
      {
        transport: <T,>(_url: string, method: string, params: unknown[]) =>
          this.opts.rpc.call<T>(method, params, { requireLogs: method === "eth_getLogs" }),
        ensureAllowed: () => void 0,
      },
    );
    if (!simulation.ok) {
      this.opts.breaker.recordFailure(simulation.error ?? "simulation failed");
      return { status: "failed", reasons: [simulation.error ?? "simulation failed"], simulation };
    }
    this.opts.breaker.recordSuccess();
    return { status: "simulated", reasons: [], simulation };
  }

  /**
   * Full path. Returns `blocked` today for every network: the gate requires a
   * backend activation policy that does not exist until authorization ships.
   */
  async execute(
    request: ExecutionRequest,
    tx: { to: string; data: string; value?: string; gasLimit: string },
  ): Promise<ExecutionOutcome> {
    const decision = this.decide(request);
    if (!decision.allowed) return { status: "blocked", reasons: decision.reasons };

    const dry = await this.simulate(request, tx);
    if (dry.status !== "simulated") return dry;
    const simulation = dry.simulation;

    // Chain identity is re-checked right before signing: failover must never
    // have moved us to another chain.
    await this.opts.rpc.healthCheck();
    const chainId = Number.parseInt(await this.opts.rpc.call<string>("eth_chainId", []), 16);
    if (chainId !== this.opts.network.chainId) {
      return {
        status: "blocked",
        reasons: [`Chain identity changed before signing: ${chainId} ≠ ${this.opts.network.chainId}.`],
      };
    }

    const rawTx = await this.opts.sign(tx);
    const hash = this.opts.hashOf(rawTx);
    try {
      const sent = await this.opts.rpc.broadcast(hash, rawTx);
      this.opts.breaker.recordSuccess();
      return { status: "sent", reasons: [], txHash: sent.hash, provider: sent.provider, simulation };
    } catch (e) {
      const uncertain = (e as { name?: string }).name === "UncertainBroadcastError";
      this.opts.breaker.recordFailure(e instanceof Error ? e.message : "broadcast failed");
      return {
        status: uncertain ? "uncertain" : "failed",
        reasons: [e instanceof Error ? e.message : "broadcast failed"],
        txHash: uncertain ? hash : undefined,
        simulation,
      };
    }
  }

  private decide(request: ExecutionRequest): GateDecision {
    return canExecute(request, this.opts.network, this.opts.policy());
  }

}
