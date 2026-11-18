/**
 * Client view of the backend's validated discovery registry.
 *
 * This is a CACHE of what the backend approved — never a source of trust.
 * It exists so the browser can order endpoints and label addresses without a
 * round trip per lookup. Two rules follow from that:
 *
 *   - nothing here is written from browser storage; `hydrate…` takes the
 *     `validatedRpcEndpoints` / `validatedDiscoveryRecords` query results,
 *   - an unhydrated store approves NOTHING. Until the backend answers, no
 *     stored endpoint is preferred and no address is treated as validated.
 *
 * The ordering the execution path uses comes from the backend too: operator
 * `stored` endpoints first, `discovered` endpoints second, and only after both
 * groups have passed the server-side probe (`VALIDATED`, unexpired).
 */
export interface ValidatedRpcEndpoint {
  chainId: number;
  url: string;
  origin: string;
  latencyMs?: number;
  headBlock?: number;
  expiresAt?: number;
}

export type DiscoveryRecordKind = "router" | "factory" | "token" | "pool" | "executor";

export interface ValidatedDiscoveryRecord {
  chainId: number;
  kind: string;
  address: string;
  label?: string;
  codeHash?: string;
  expiresAt?: number;
}

export interface ApprovedInternalDestination {
  chainId: number;
  address: string;
  label?: string;
}

let rpcRows: ValidatedRpcEndpoint[] = [];
let recordRows: ValidatedDiscoveryRecord[] = [];
let destinationRows: ApprovedInternalDestination[] = [];
let rpcLoadedAt = 0;
let recordsLoadedAt = 0;
let destinationsLoadedAt = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break endpoint selection.
    }
  }
}

export function subscribeDiscovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function discoveryStoreState(): {
  rpcLoadedAt: number;
  recordsLoadedAt: number;
  destinationsLoadedAt: number;
  rpcCount: number;
  recordCount: number;
  destinationCount: number;
} {
  return {
    rpcLoadedAt,
    recordsLoadedAt,
    destinationsLoadedAt,
    rpcCount: rpcRows.length,
    recordCount: recordRows.length,
    destinationCount: destinationRows.length,
  };
}

/** Replace the endpoint cache with the backend's validated rows. */
export function hydrateValidatedRpcEndpoints(rows: readonly unknown[], now = Date.now()): void {
  const next: ValidatedRpcEndpoint[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.chainId !== "number" || !Number.isInteger(row.chainId) || row.chainId <= 0) continue;
    if (typeof row.url !== "string" || !/^https?:\/\//i.test(row.url)) continue;
    if (row.expiresAt !== undefined && (typeof row.expiresAt !== "number" || row.expiresAt <= now)) continue;
    next.push({
      chainId: row.chainId,
      url: row.url,
      origin: typeof row.origin === "string" ? row.origin : "stored",
      latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : undefined,
      headBlock: typeof row.headBlock === "number" ? row.headBlock : undefined,
      expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : undefined,
    });
  }
  rpcRows = next;
  rpcLoadedAt = now;
  notify();
}

/** Replace the address cache with the backend's validated rows. */
export function hydrateValidatedDiscovery(rows: readonly unknown[], now = Date.now()): void {
  const next: ValidatedDiscoveryRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.chainId !== "number" || row.chainId <= 0) continue;
    if (typeof row.kind !== "string" || typeof row.address !== "string") continue;
    if (row.expiresAt !== undefined && (typeof row.expiresAt !== "number" || row.expiresAt <= now)) continue;
    next.push({
      chainId: row.chainId,
      kind: row.kind,
      address: row.address,
      label: typeof row.label === "string" ? row.label : undefined,
      codeHash: typeof row.codeHash === "string" ? row.codeHash : undefined,
      expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : undefined,
    });
  }
  recordRows = next;
  recordsLoadedAt = now;
  notify();
}

/**
 * Replace the internal-destination cache with the backend's enabled rows.
 *
 * An empty result is meaningful: no destination is internal, so every payout
 * target classifies as an external withdrawal (refused).
 */
export function hydrateInternalDestinations(rows: readonly unknown[]): void {
  const next: ApprovedInternalDestination[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.chainId !== "number" || row.chainId <= 0) continue;
    if (typeof row.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.address)) continue;
    next.push({
      chainId: row.chainId,
      address: row.address.toLowerCase(),
      label: typeof row.label === "string" ? row.label : undefined,
    });
  }
  destinationRows = next;
  destinationsLoadedAt = Date.now();
  notify();
}

/** Test/cleanup helper — the app never calls this. */
export function resetDiscoveryStore(): void {
  rpcRows = [];
  recordRows = [];
  destinationRows = [];
  rpcLoadedAt = 0;
  recordsLoadedAt = 0;
  destinationsLoadedAt = 0;
  notify();
}

/**
 * Validated endpoints for a chain, split by provenance.
 *
 * Both lists contain only rows the backend probed and has not let expire.
 * `stored` is preferred; `discovered` is the secondary pool.
 */
export function validatedRpcUrls(chainId: number): { stored: string[]; discovered: string[] } {
  if (rpcLoadedAt === 0) return { stored: [], discovered: [] };
  const rows = rpcRows.filter((row) => row.chainId === chainId);
  const byLatency = (a: ValidatedRpcEndpoint, b: ValidatedRpcEndpoint) =>
    (a.latencyMs ?? 9_999) - (b.latencyMs ?? 9_999);
  return {
    stored: rows.filter((row) => row.origin !== "discovered").sort(byLatency).map((row) => row.url),
    discovered: rows.filter((row) => row.origin === "discovered").sort(byLatency).map((row) => row.url),
  };
}

/** True only when the backend validated this exact chain/kind/address. */
export function isValidatedAddress(args: {
  chainId: number;
  kind: DiscoveryRecordKind;
  address: string;
  now?: number;
}): boolean {
  if (recordsLoadedAt === 0) return false;
  const now = args.now ?? Date.now();
  const address = args.address.trim().toLowerCase();
  return recordRows.some(
    (row) =>
      row.chainId === args.chainId &&
      row.kind === args.kind &&
      row.address.trim().toLowerCase() === address &&
      (!row.expiresAt || row.expiresAt > now),
  );
}

/** Backend-approved record for an address, if any. */
export function validatedRecordFor(args: {
  chainId: number;
  kind: DiscoveryRecordKind;
  address: string;
  now?: number;
}): ValidatedDiscoveryRecord | undefined {
  const now = args.now ?? Date.now();
  const address = args.address.trim().toLowerCase();
  return recordRows.find(
    (row) =>
      row.chainId === args.chainId &&
      row.kind === args.kind &&
      row.address.trim().toLowerCase() === address &&
      (!row.expiresAt || row.expiresAt > now),
  );
}

/**
 * Refusals for the addresses an execution is about to use.
 *
 * Called before building a swap: a router or factory that the backend has not
 * validated is not usable, even though it is compiled into the app's own
 * registry. Empty result = every target is validated.
 */
export function executionTargetReasons(args: {
  chainId: number;
  router?: string;
  factory?: string;
  executor?: string;
  now?: number;
}): string[] {
  const reasons: string[] = [];
  if (recordsLoadedAt === 0) {
    return [
      "The backend's validated discovery registry has not loaded — router/factory/executor use is refused until it answers.",
    ];
  }
  const check = (kind: DiscoveryRecordKind, address: string | undefined, label: string) => {
    if (!address) return;
    if (!isValidatedAddress({ chainId: args.chainId, kind, address, now: args.now })) {
      reasons.push(`${label} ${address.slice(0, 10)}… is not validated for chain ${args.chainId}.`);
    }
  };
  check("router", args.router, "Router");
  check("factory", args.factory, "Factory");
  check("executor", args.executor, "Executor");
  return reasons;
}

/** The approved internal destination for a chain, if one is enabled. */
export function internalDestinationFor(chainId: number): ApprovedInternalDestination | undefined {
  return destinationRows.find((row) => row.chainId === chainId);
}

/**
 * True only when the backend registry approves this exact chain + address as
 * an INTERNAL payout destination. A connected wallet, a card entry or the
 * signer's own address is never enough.
 */
export function isApprovedInternalDestination(chainId: number, address: string): boolean {
  if (destinationsLoadedAt === 0) return false;
  const target = address.trim().toLowerCase();
  return destinationRows.some((row) => row.chainId === chainId && row.address === target);
}

/** Counts for the checks console. */
export function validatedRpcCount(chainId: number): number {
  return rpcLoadedAt === 0 ? 0 : rpcRows.filter((row) => row.chainId === chainId).length;
}

export function validatedAddressCount(chainId: number): number {
  return recordsLoadedAt === 0 ? 0 : recordRows.filter((row) => row.chainId === chainId).length;
}

/** One-line status for the diagnostics/operator panel. */
export function discoveryStoreSummary(): string {
  if (rpcLoadedAt === 0 && recordsLoadedAt === 0) return "backend discovery registry not loaded";
  return `${rpcRows.length} validated endpoints, ${recordRows.length} validated addresses`;
}
