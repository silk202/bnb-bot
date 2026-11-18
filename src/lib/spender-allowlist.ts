/**
 * Trusted spenders for the approval detector.
 *
 * The first version passed a single router (`CHAIN_INFO[chain].router`), which
 * would have blocked every honest unlimited approval granted to any other venue
 * the app itself uses — V2 and V3 routers, the testnet router, and the app's own
 * deployed contract. That is a false positive that trains an operator to
 * override the guard, which is worse than no guard.
 *
 * The list is derived, not hand-written: every router in `CHAIN_NETWORKS` for
 * that chain (both networks, since the same operator runs both) plus anything
 * the caller explicitly adds — the armed FlashBoltArbitrage contract and the
 * payout signer itself.
 */
import { CHAIN_INFO, CHAIN_NETWORKS, type ChainKey, type NetworkKey } from "./chains";

const EVM = /^0x[0-9a-f]{40}$/;

export function knownSpendersFor(input: {
  chainKey: ChainKey;
  network?: NetworkKey;
  extra?: (string | null | undefined)[];
}): ReadonlySet<string> {
  const trusted = new Set<string>();
  const add = (value?: string | null) => {
    const address = (value ?? "").trim().toLowerCase();
    if (EVM.test(address)) trusted.add(address);
  };

  add(CHAIN_INFO[input.chainKey]?.router);

  const networks = CHAIN_NETWORKS[input.chainKey];
  if (networks) {
    for (const key of Object.keys(networks) as NetworkKey[]) {
      // Both networks on purpose: a testnet router cannot drain mainnet funds
      // (different chain), and omitting it would flag ordinary testnet drills.
      for (const venue of networks[key]?.venues ?? []) add(venue.router);
    }
  }

  for (const address of input.extra ?? []) add(address);
  return trusted;
}
