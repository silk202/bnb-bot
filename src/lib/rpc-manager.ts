/**
 * Provider-aware RPC manager.
 *
 * Cycling blindly through URLs is what duplicates a trade: the first send times
 * out while the node actually accepted it, the second send goes out elsewhere
 * and the position is doubled. So this manager is built around two rules:
 *
 *   1. an endpoint is only trusted after `eth_chainId` matches the registry, so
 *      a mainnet payload can never leave through a testnet configuration;
 *   2. a broadcast is never retried on another provider while its status is
 *      uncertain — the transaction hash is checked first, on every provider.
 *
 * It also throttles per provider, backs off exponentially, and prefers the
 * healthiest (lowest-latency, proven) endpoint rather than list order.
 */
import type { NetworkDefinition } from "./network-registry";
import { rpcCall } from "./json-rpc";

export class ChainIdMismatchError extends Error {
  url: string;
  expected: number;
  actual: number;

  constructor(url: string, expected: number, actual: number) {
    super(`RPC ${url} reports chain ${actual}, expected ${expected} — endpoint rejected.`);
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}

export class UncertainBroadcastError extends Error {
  txHash: string;
  attempts: number;

  constructor(txHash: string, attempts: number) {
    super(
      `Broadcast status is UNCERTAIN for ${txHash} after ${attempts} attempt(s): ` +
        "no provider confirms or denies it. Do not resend until it is resolved.",
    );
    this.txHash = txHash;
    this.attempts = attempts;
  }
}

export interface ProviderState {
  url: string;
  provider: string;
  chainIdOk: boolean;
  latencyMs: number;
  failures: number;
  /** Epoch ms before which this endpoint is skipped (backoff / circuit open). */
  cooldownUntil: number;
  supportsLogs: boolean;
  supportsWs: boolean;
  lastError?: string;
}

export interface RpcManagerOptions {
  /** Injectable transport (tests) — defaults to the shared JSON-RPC client. */
  transport?: <T>(url: string, method: string, params: unknown[], timeoutMs?: number) => Promise<T>;
  now?: () => number;
  /** Requests per second allowed per provider. */
  rps?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** How long to keep checking a hash before declaring the broadcast uncertain. */
  confirmWindowMs?: number;
}

const LOGS_PROBE: unknown[] = [{ topics: [`0x${"0".repeat(64)}`], fromBlock: "0x0", toBlock: "latest" }];

/** Errors that mean the transaction itself is invalid — never retried. */
const DEFINITIVE_REJECTIONS = [
  "insufficient funds",
  "nonce too low",
  "nonce is too low",
  "replacement transaction underpriced",
  "execution reverted",
  "intrinsic gas too low",
  "exceeds block gas limit",
  "invalid sender",
  "already imported",
];

export class RpcManager {
  private states: Map<string, ProviderState>;
  private tokens: Map<string, number>;
  private readonly def: NetworkDefinition;
  private readonly transport: NonNullable<RpcManagerOptions["transport"]>;
  private readonly now: () => number;
  private readonly rps: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly confirmWindowMs: number;

  constructor(def: NetworkDefinition, opts: RpcManagerOptions = {}) {
    this.def = def;
    this.transport = opts.transport ?? rpcCall;
    this.now = opts.now ?? Date.now;
    this.rps = opts.rps ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.confirmWindowMs = opts.confirmWindowMs ?? 8_000;
    this.states = new Map(
      def.endpoints.map((e) => [
        e.url,
        {
          url: e.url,
          provider: e.provider,
          chainIdOk: false,
          latencyMs: Number.POSITIVE_INFINITY,
          failures: 0,
          cooldownUntil: 0,
          supportsLogs: def.logsOnPublicRpc,
          supportsWs: Boolean(e.ws),
        },
      ]),
    );
    this.tokens = new Map(def.endpoints.map((e) => [e.url, this.rps]));
  }

  /**
   * Health check: chain id, latency, and method support that matters.
   *
   * Bounded on purpose: a UI switch must not stall on a slow provider, so the
   * caller can cap the endpoint count, the per-call timeout, and skip the
   * (slower) log probe.
   */
  async healthCheck(
    opts: { timeoutMs?: number; maxEndpoints?: number; probeLogs?: boolean } = {},
  ): Promise<ProviderState[]> {
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const endpoints = this.def.endpoints.slice(0, opts.maxEndpoints ?? this.def.endpoints.length);
    const checks = endpoints.map(async (endpoint) => {
      const state = this.states.get(endpoint.url)!;
      const started = this.now();
      try {
        const chainId = Number.parseInt(
          await this.transport<string>(endpoint.url, "eth_chainId", [], timeout),
          16,
        );
        if (chainId !== this.def.chainId) throw new ChainIdMismatchError(endpoint.url, this.def.chainId, chainId);
        state.latencyMs = this.now() - started;
        state.chainIdOk = true;
        state.lastError = undefined;
        // A successful eth_chainId does not prove the execution workload works.
        if (opts.probeLogs !== false) state.supportsLogs = await this.probesLogs(endpoint.url, timeout);
      } catch (e) {
        state.chainIdOk = false;
        state.latencyMs = Number.POSITIVE_INFINITY;
        state.lastError = e instanceof Error ? e.message : "health check failed";
        this.penalize(state, 30_000);
      }
      return state;
    });
    return Promise.all(checks);
  }

  private async probesLogs(url: string, timeoutMs = this.timeoutMs): Promise<boolean> {
    if (!this.def.logsOnPublicRpc) return false;
    try {
      await this.transport(url, "eth_getLogs", LOGS_PROBE, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Healthiest usable endpoints first: verified chain, not cooling down, lowest latency. */
  private ranked(requireLogs = false): ProviderState[] {
    const t = this.now();
    return [...this.states.values()]
      .filter((s) => s.chainIdOk && s.cooldownUntil <= t && (!requireLogs || s.supportsLogs))
      .sort((a, b) => a.latencyMs - b.latencyMs);
  }

  private penalize(state: ProviderState, baseMs: number): void {
    state.failures += 1;
    const backoff = Math.min(baseMs * 2 ** (state.failures - 1), 300_000);
    state.cooldownUntil = this.now() + backoff;
  }

  /** Token bucket — public endpoints punish bursts long after they forgive one call. */
  private takeToken(url: string): boolean {
    const tokens = this.tokens.get(url) ?? 0;
    if (tokens < 1) return false;
    this.tokens.set(url, tokens - 1);
    return true;
  }

  private async throttle(url: string): Promise<void> {
    while (!this.takeToken(url)) await new Promise((r) => setTimeout(r, 1000 / this.rps));
  }

  private refill(): void {
    for (const url of this.tokens.keys()) this.tokens.set(url, this.rps);
  }

  /** Read call: safe to fail over, so retry across ranked providers with backoff. */
  async call<T>(method: string, params: unknown[], opts: { requireLogs?: boolean } = {}): Promise<T> {
    this.refill();
    const candidates = this.ranked(opts.requireLogs);
    if (candidates.length === 0) {
      throw new Error(`No healthy ${this.def.name} endpoint — run healthCheck() first.`);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < Math.min(this.maxAttempts, candidates.length); attempt += 1) {
      const state = candidates[attempt];
      await this.throttle(state.url);
      try {
        const result = await this.transport<T>(state.url, method, params, this.timeoutMs);
        state.failures = 0;
        return result;
      } catch (e) {
        lastError = e;
        if (e instanceof ChainIdMismatchError) state.chainIdOk = false;
        this.penalize(state, 1_000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${method} failed on every endpoint`);
  }

  /**
   * Broadcast with the one rule that matters: never resend while uncertain.
   * The hash is derived by the caller (it knows the raw transaction); after a
   * failed/timed-out send we ask every provider whether the hash exists before
   * even considering another attempt.
   */
  async broadcast(
    txHash: string,
    rawTx: string,
    opts: { sendRaw?: (url: string, raw: string) => Promise<string> } = {},
  ): Promise<{ hash: string; provider: string }> {
    this.refill();
    const candidates = this.ranked();
    if (candidates.length === 0) throw new Error(`No healthy ${this.def.name} endpoint for broadcast.`);

    const send =
      opts.sendRaw ?? ((url: string, raw: string) => this.transport<string>(url, "eth_sendRawTransaction", [raw], this.timeoutMs));

    let attempts = 0;
    for (const state of candidates.slice(0, this.maxAttempts)) {
      attempts += 1;
      try {
        const returned = await send(state.url, rawTx);
        if (returned.toLowerCase() !== txHash.toLowerCase()) {
          // A node returning a different hash means it rewrote the payload.
          throw new Error(`Provider returned hash ${returned}, expected ${txHash}`);
        }
        return { hash: txHash, provider: state.provider };
      } catch (e) {
        // "already known" means the tx is in the mempool — that is success.
        const message = e instanceof Error ? e.message.toLowerCase() : "";
        if (message.includes("already known") || message.includes("known transaction")) {
          return { hash: txHash, provider: state.provider };
        }
        // Deterministic rejections will fail identically everywhere: resending
        // them elsewhere only burns rate limit and hides the real cause.
        const definitive = DEFINITIVE_REJECTIONS.find((needle) => message.includes(needle));
        if (definitive) {
          throw new Error(`Broadcast rejected (${definitive}): ${e instanceof Error ? e.message : "unknown"}`);
        }
        this.penalize(state, 2_000);
        if (await this.waitForHash(txHash)) return { hash: txHash, provider: state.provider };
      }
    }
    // Nothing confirmed it and nothing denied it: stop, do not duplicate.
    if (await this.waitForHash(txHash)) {
      return { hash: txHash, provider: this.ranked()[0]?.provider ?? "unknown" };
    }
    throw new UncertainBroadcastError(txHash, attempts);
  }

  /** Poll every endpoint for the hash for the confirm window. */
  async waitForHash(txHash: string): Promise<boolean> {
    const deadline = this.now() + this.confirmWindowMs;
    const urls = [...this.states.values()].filter((s) => s.chainIdOk).map((s) => s.url);
    do {
      for (const url of urls) {
        try {
          const tx = await this.transport<unknown>(url, "eth_getTransactionByHash", [txHash], this.timeoutMs);
          if (tx) return true;
        } catch {
          // A provider that cannot answer is not evidence either way.
        }
      }
      if (this.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(1_000, Math.max(0, deadline - this.now()))));
    } while (true);
    return false;
  }

  snapshot(): ProviderState[] {
    return [...this.states.values()];
  }
}
