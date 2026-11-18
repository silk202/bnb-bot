/**
 * Shared vault-row removal flow — used by BOTH Wallets pages (BNB
 * `evm-vault` and SOL `solana-vault`). Both vaults share the same semantics:
 * `removeFromVault` deletes the signing key from module memory AND the tab's
 * encrypted blob entry — and when the removed signer was the LAST one, the
 * encrypted blob itself is destroyed (storage key removed, AES key/salt
 * dropped). This helper turns that into one honest, reusable outcome so the
 * two pages report identically.
 */

export interface VaultRemovalOutcome {
  /** False when the address was not in the vault (nothing happened). */
  removed: boolean;
  /**
   * True when the removed signer was the last one — memory AND the tab's
   * encrypted blob are gone: a clean slate, no Lock needed.
   */
  cleanSlate: boolean;
  /** Remaining signer addresses after the removal (empty on clean slate). */
  remaining: string[];
  /** Human report for toasts/logs; empty when nothing was removed. */
  message: string;
}

/**
 * Run a removal and describe what actually happened. `remove` is the vault's
 * removeFromVault (returns false for an unknown address — no-op, honest),
 * `remaining` re-reads the vault's signer list AFTER the removal.
 */
export function describeVaultRemoval(args: {
  remove: () => boolean;
  remaining: () => string[];
}): VaultRemovalOutcome {
  const removed = args.remove();
  if (!removed) {
    return { removed: false, cleanSlate: false, remaining: args.remaining(), message: "" };
  }
  const remaining = args.remaining();
  const cleanSlate = remaining.length === 0;
  return {
    removed: true,
    cleanSlate,
    remaining,
    message: cleanSlate
      ? "Clean slate — the signing key left memory and the tab's encrypted blob was destroyed. Import the replacement secret fresh."
      : `Signing key removed — ${remaining.length} signer(s) remain in the vault.`,
  };
}
