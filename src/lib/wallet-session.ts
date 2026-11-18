/**
 * Wallet session layer — the "seamless connection" glue that sits ON TOP of
 * the real EIP-1193 / Solana injected providers. It never signs, never holds
 * keys, and never fabricates an account:
 *
 *   • silent reconnect — `eth_accounts` (EVM) and `connect({ onlyIfTrusted:
 *     true })` (Solana) return the already-authorized account with ZERO
 *     popup, so a reload restores the session invisibly.
 *   • session guards — ONE listener set on the injected providers fans
 *     account/chain/disconnect changes out to every subscribed surface
 *     (Wallets pages, Scanner pre-flight) through a tiny pub/sub, so the UI
 *     always shows the wallet's real state.
 *   • freshness probe — `probeWalletSession` reads accounts + chainId right
 *     before a hot broadcast so a stale/locked wallet session can never
 *     stall or misroute a submission (the tx is refused honestly instead).
 */

// ---------------------------------------------------------------------------
// Shared session events (EVM + Solana in one channel)
// ---------------------------------------------------------------------------

export type WalletSessionEvent =
  | { kind: "accounts"; address: string | null; source: "evm" }
  | { kind: "chain"; chainId: number; source: "evm" }
  | { kind: "disconnected"; source: "evm" | "solana"; wallet?: string }
  | { kind: "sol-account"; pubkey: string | null; wallet: string };

type Listener = (e: WalletSessionEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to wallet session events. Returns the unsubscribe function. */
export function onWalletSessionEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(e: WalletSessionEvent) {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // One broken subscriber never breaks the fan-out.
    }
  }
}

// ---------------------------------------------------------------------------
// EVM (EIP-1193) session
// ---------------------------------------------------------------------------

interface EvmProviderEvents {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

function evmProvider(): EvmProviderEvents | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { ethereum?: EvmProviderEvents }).ethereum;
  return p ?? null;
}

/**
 * SILENT reconnect probe — `eth_accounts` (no popup) returns the account the
 * user already authorized. Null means: no wallet, or locked/rejected. This is
 * the only honest way to restore a session after a reload.
 */
export async function reconnectInjectedEvm(): Promise<string | null> {
  const p = evmProvider();
  if (!p) return null;
  try {
    const accounts = (await p.request({ method: "eth_accounts" })) as string[] | undefined;
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

async function currentEvmChainId(): Promise<number | null> {
  const p = evmProvider();
  if (!p) return null;
  try {
    const hex = (await p.request({ method: "eth_chainId" })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return null;
  }
}

export interface WalletSessionProbe {
  address: string | null;
  chainId: number | null;
}

/**
 * Freshness probe used right before a hot broadcast: real eth_accounts +
 * eth_chainId reads. A probe that disagrees with the signer/chain the tx was
 * built for means the session drifted — the caller refuses honestly instead
 * of broadcasting to the wrong account or chain.
 */
export async function probeWalletSession(): Promise<WalletSessionProbe> {
  const [address, chainId] = await Promise.all([reconnectInjectedEvm(), currentEvmChainId()]);
  return { address, chainId };
}

/**
 * Install the EVM session guard — ONE set of EIP-1193 listeners fanning
 * `accountsChanged` / `chainChanged` / `disconnect` into the shared channel.
 * Idempotent: repeated calls are no-ops. Returns a stop function (unused by
 * the app — the guard lives for the page's lifetime).
 */
let evmGuardInstalled = false;
export function ensureEvmSessionGuard(): void {
  if (evmGuardInstalled) return;
  const p = evmProvider();
  if (!p?.on) return;
  evmGuardInstalled = true;
  p.on("accountsChanged", ((accounts: string[]) => {
    emit({ kind: "accounts", address: accounts?.[0] ?? null, source: "evm" });
  }) as never);
  p.on("chainChanged", ((chainIdHex: string) => {
    try {
      emit({ kind: "chain", chainId: Number.parseInt(chainIdHex, 16), source: "evm" });
    } catch {
      // malformed hex — ignore, the next probe re-reads honestly
    }
  }) as never);
  p.on("disconnect", (() => {
    emit({ kind: "disconnected", source: "evm" });
  }) as never);
}

// ---------------------------------------------------------------------------
// Solana session (Phantom / Solflare / Backpack standard injections)
// ---------------------------------------------------------------------------

export type SolWalletKind = "phantom" | "solflare" | "backpack";

interface SolProviderEvents {
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  on?(event: string, handler: (...args: never[]) => void): void;
}

function solProvider(kind: SolWalletKind): SolProviderEvents | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  if (kind === "phantom") {
    const phantom = w.phantom as { solana?: SolProviderEvents } | undefined;
    return phantom?.solana ?? ((w.solana as SolProviderEvents | undefined) ?? null);
  }
  if (kind === "solflare") return (w.solflare as SolProviderEvents | undefined) ?? null;
  return (w.backpack as SolProviderEvents | undefined) ?? null;
}

/**
 * SILENT reconnect — `connect({ onlyIfTrusted: true })` resolves ONLY when
 * the user previously trusted the app; otherwise it rejects (caught → null).
 * Zero popup: the session restores invisibly or reports honestly.
 */
export async function reconnectSolana(kind: SolWalletKind): Promise<string | null> {
  const p = solProvider(kind);
  if (!p) return null;
  try {
    const res = await p.connect({ onlyIfTrusted: true });
    return res?.publicKey?.toString() ?? p.publicKey?.toString() ?? null;
  } catch {
    return null;
  }
}

/**
 * Install the Solana session guard for one wallet kind — fans
 * `accountChanged` / `disconnect` into the shared channel. Idempotent per
 * wallet kind. Returns a stop function (the app keeps guards for life).
 */
const solGuardsInstalled = new Set<SolWalletKind>();
export function ensureSolanaSessionGuard(kind: SolWalletKind): void {
  if (solGuardsInstalled.has(kind)) return;
  const p = solProvider(kind);
  if (!p?.on) return;
  solGuardsInstalled.add(kind);
  p.on("accountChanged", ((pk: { toString(): string } | null) => {
    emit({ kind: "sol-account", pubkey: pk?.toString() ?? null, wallet: kind });
  }) as never);
  p.on("disconnect", (() => {
    emit({ kind: "disconnected", source: "solana", wallet: kind });
  }) as never);
}
