// FlashBolt Trade — watch-only custody core.
//
// SECURITY MODEL (no spend keys on the server, ever):
//   1. The operator pastes a WATCH-ONLY account xpub (zpub/ypub, BIP84).
//      The server derives fresh child addresses (m/0/k) per user — unique
//      deposit addresses with ZERO signing ability. Even a full server
//      compromise cannot move funds.
//   2. Personal bindings: a user binds their OWN wallet by signing a
//      challenge with it (EVM personal_sign / EIP-191, or Solana ed25519).
//      The signature is cryptographically verified against the claimed
//      address BEFORE the binding is stored — nobody can register an
//      address they don't control.
//   3. Auto-detection credits the ledger per (txHash, vout) — stored
//      idempotently, so replays/reorg rescans can never double-credit.
//
// Honest limits: TRON and Monero have no HTTP-public watch stack here, so
// they use the operator-published shared address + txid verification path
// instead of derived addresses.

import { HDKey } from "@scure/bip32";
import { bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { recoverMessageAddress } from "viem";
import { createPublicClient, http } from "viem";
import { mainnet, bsc } from "viem/chains";
import { type TradeNetworkDef } from "./tradeAssets";

// ── BIP84 watch-only derivation (BTC / LTC native bech32) ─────────────────

const COIN_TYPES: Record<string, number> = { BTC: 0, LTC: 2 };
const HRP: Record<string, "bc" | "ltc"> = { BTC: "bc", LTC: "ltc" };

/**
 * Derive the k-th native SegWit (P2WPKH bech32) address from an account
 * xpub: m/0/k below the account level the xpub represents. Watch-only:
 * HDKey built from a public extended key has privateKey === null.
 */
export function deriveUtxoAddress(
  xpub: string,
  coin: "BTC" | "LTC",
  index: number,
): string {
  const hd = HDKey.fromExtendedKey(xpub);
  if (hd.privateKey !== null) {
    throw new Error("Refusing a private xpub — provide the WATCH-ONLY (public) key.");
  }
  const child = hd.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("Derivation failed — check the xpub.");
  return p2wpkhFromPubKey(child.publicKey, HRP[coin]);
}

/** P2WPKH bech32: version-0 witness program over HASH160(pubKey). */
function p2wpkhFromPubKey(pub: Uint8Array, hrp: "bc" | "ltc"): string {
  const h = ripemd160(sha256(pub));
  return bech32.encode(hrp, [0, ...bech32.toWords(h)]);
}

/** Validate any address for a network (used before accepting bindings). */
export function validateAddressForNet(addr: string, net: TradeNetworkDef): boolean {
  const a = addr.trim();
  switch (net.chainKind) {
    case "evm":
      return /^0x[a-fA-F0-9]{40}$/.test(a);
    case "solana":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
    case "utxo":
      return (
        /^(bc1|ltc1)[0-9a-z]{11,71}$/.test(a) ||
        /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a) ||
        /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a)
      );
    case "monero":
      return /^[48][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(a);
    default:
      return a.length >= 20;
  }
}

// ── Signature verification (bindings) ─────────────────────────────────────

export type ChainKind = TradeNetworkDef["chainKind"];

/** Build the exact challenge string a wallet must sign. */
export function bindingChallenge(
  addr: string,
  asset: string,
  netId: string,
  nonce: string,
): string {
  return [
    "FlashBolt Trade — deposit address binding",
    `Address: ${addr}`,
    `Asset: ${asset} (${netId})`,
    `Nonce: ${nonce}`,
    "Signing proves I control this address. FlashBolt never asks for keys.",
  ].join("\n");
}

/**
 * Verify a binding signature. EVM: EIP-191 personal_message recovery must
 * equal the claimed address. Solana: ed25519.verify over the UTF-8 message
 * (Phantom/Solflare/Backpack sign the raw bytes).
 */
export async function verifyBindingSignature(
  chainKind: ChainKind,
  addr: string,
  message: string,
  signatureB58OrHex: string,
): Promise<boolean> {
  const sig = signatureB58OrHex.trim();
  try {
    if (chainKind === "evm") {
      const recovered = await recoverMessageAddress({
        message,
        signature: sig as `0x${string}`,
      });
      return recovered.toLowerCase() === addr.toLowerCase();
    }
    if (chainKind === "solana") {
      // Phantom returns base58; be tolerant of 0x-hex too.
      const bytes = sig.startsWith("0x")
        ? hexToBytes(sig.slice(2) as `0x${string}`)
        : base58Decode(sig);
      return ed25519.verify(bytes, new TextEncoder().encode(message), hexToBytes(addrToEd25519PubHex(addr)));
    }
    return false;
  } catch {
    return false;
  }
}

/** Solana addresses are ed25519 public keys — decode for verification. */
function addrToEd25519PubHex(addr: string): `0x${string}` {
  const raw = base58Decode(addr);
  return bytesToHex(raw) as `0x${string}`;
}

// Minimal base58 (Bitcoin alphabet) — avoids pulling another dep for one op.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  let num = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    num = num * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const c of s) {
    if (c === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}

// ── On-chain verification helpers (watchers) ──────────────────────────────

const EVM_CLIENTS = {
  ERC20: createPublicClient({ chain: mainnet, transport: http() }),
  BEP20: createPublicClient({ chain: bsc, transport: http() }),
} as const;

export type EvmClient = (typeof EVM_CLIENTS)[keyof typeof EVM_CLIENTS];

export function evmClientFor(netId: string): EvmClient | null {
  return (EVM_CLIENTS as Record<string, EvmClient | undefined>)[netId] ?? null;
}

export { verifyMessage } from "viem";

/** Token contract registry (real deployments, decimals included). */
export const EVM_TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  "USDT:ERC20": { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  "USDC:ERC20": { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  "USDT:BEP20": { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  "USDC:BEP20": { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  "XAUT:ERC20": { address: "0x4984950fB9E969D25BcC348B24B5506462aD38EA", decimals: 6 },
};

/** ERC-20 Transfer log topic. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
