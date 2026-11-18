/**
 * Emergency circuit breaker.
 *
 * Trips on repeated failures and stays open until an operator resets it with an
 * identity and a reason — a reset is an audited action, not a silent retry.
 * State can be persisted by the caller (localStorage, backend) via the hooks.
 */

export interface BreakerState {
  tripped: boolean;
  reason?: string;
  trips: number;
  consecutiveFailures: number;
  lastTripAt?: number;
  lastResetAt?: number;
  lastResetBy?: string;
}

export interface BreakerHooks {
  load?: () => BreakerState | undefined;
  save?: (state: BreakerState) => void;
  now?: () => number;
}

const EMPTY: BreakerState = { tripped: false, trips: 0, consecutiveFailures: 0 };

export class EmergencyCircuitBreaker {
  private state: BreakerState;
  private readonly threshold: number;
  private readonly hooks: BreakerHooks;

  constructor(threshold = 3, hooks: BreakerHooks = {}) {
    this.threshold = Math.max(1, threshold);
    this.hooks = hooks;
    this.state = hooks.load?.() ?? { ...EMPTY };
  }

  isOpen(): boolean {
    return this.state.tripped;
  }

  /** Why execution is blocked, or undefined when closed. */
  blockReason(): string | undefined {
    return this.state.tripped ? (this.state.reason ?? "Circuit breaker is open.") : undefined;
  }

  recordSuccess(): void {
    const next = { ...this.state, consecutiveFailures: 0 };
    this.commit(next);
  }

  recordFailure(detail: string): void {
    const failures = this.state.consecutiveFailures + 1;
    if (failures >= this.threshold && !this.state.tripped) {
      this.commit({
        ...this.state,
        consecutiveFailures: failures,
        tripped: true,
        trips: this.state.trips + 1,
        reason: `${failures} consecutive failures — last: ${detail}`,
        lastTripAt: this.now(),
      });
      return;
    }
    this.commit({ ...this.state, consecutiveFailures: failures });
  }

  trip(reason: string): void {
    this.commit({
      ...this.state,
      tripped: true,
      trips: this.state.trips + 1,
      reason,
      lastTripAt: this.now(),
    });
  }

  /** Only an identified operator may reset. */
  reset(authorizedBy: string, reason: string): void {
    if (!authorizedBy.trim()) throw new Error("A breaker reset requires an operator identity.");
    if (!reason.trim()) throw new Error("A breaker reset requires a reason.");
    this.commit({
      ...this.state,
      tripped: false,
      reason: undefined,
      consecutiveFailures: 0,
      lastResetAt: this.now(),
      lastResetBy: `${authorizedBy}: ${reason}`,
    });
  }

  snapshot(): BreakerState {
    return { ...this.state };
  }

  private now(): number {
    return (this.hooks.now ?? Date.now)();
  }

  private commit(next: BreakerState): void {
    this.state = next;
    this.hooks.save?.(next);
  }
}
