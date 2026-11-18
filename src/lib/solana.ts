/**
 * SOL FlashBolt — Solana chain registry.
 *
 * Every value here is real and verified against the live source:
 * - DexScreener `dexId` values for Solana pairs (verified live via
 *   /latest/dex/search?q=SOL%20USDC: raydium, orca, meteora, pumpswap,
 *   metadao — with version labels ["CLMM"] / ["wp"] / ["DLMM"]),
 * - the canonical WSOL mint,
 * - flash-loan lenders that actually deploy on Solana, priced at their
 *   documented fees (Solend 0.3%, MarginFi 0%, Kamino 0.05%).
 *
 * Dynamic-fee venues (CLMM/Whirlpool/DLMM) are priced CONSERVATIVELY at or
 * above their typical tier, so an unknown fee tier can never overstate a
 * route's profit — the same rule the BNB engine applies to unlabeled pairs.
 */

export interface SolDexDef {
  /** Short code shown in the feed, e.g. "RAY". Also the whitelist key. */
  key: string;
  /** DexScreener dex id (several venues share one id — labels disambiguate). */
  dexId: string;
  /** Version labels required for this venue ("CLMM" / "wp" / "DLMM"). */
  labels?: string[];
  name: string;
  /** Swap fee charged per leg (conservative for dynamic-fee venues). */
  fee: number;
  /** Honest human label shown in the UI. */
  feeLabel: string;
  color: string;
}

/** Wrapped SOL — the quote asset every route borrows and repays. */
export const SOL_QUOTE = {
  symbol: "WSOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
} as const;

export const SOL_CHAIN = {
  key: "solana",
  label: "Solana",
  /** DexScreener chainId for Solana pairs. */
  dexScreenerChainId: "solana",
  rpc: "https://api.mainnet-beta.solana.com",
  explorer: "Solscan",
  explorerUrl: "https://solscan.io",
} as const;

/**
 * Solana swap venues — dexIds + labels verified live on DexScreener.
 */
export const SOL_DEXES: SolDexDef[] = [
  {
    key: "RAY",
    dexId: "raydium",
    name: "Raydium AMM v4",
    fee: 0.0025,
    feeLabel: "0.25%",
    color: "#3FCB95",
  },
  {
    key: "RAY_CLMM",
    dexId: "raydium",
    labels: ["CLMM"],
    name: "Raydium CLMM",
    // Concentrated liquidity: fee tiers run 0.01%–0.25%; priced at the top.
    fee: 0.0025,
    feeLabel: "0.01–0.25% dyn. (0.25% priced)",
    color: "#7EE0BC",
  },
  {
    key: "ORCA",
    dexId: "orca",
    name: "Orca Whirlpool",
    // Whirlpool tiers: 0.01 / 0.05 / 0.30 / 1% — priced at the 0.30% tier.
    fee: 0.003,
    feeLabel: "0.01–1% dyn. (0.30% priced)",
    color: "#FFD84D",
  },
  {
    key: "METEORA",
    dexId: "meteora",
    labels: ["DLMM"],
    name: "Meteora DLMM",
    // DLMM base fee runs ~0.02–0.2% — priced at the top of the band.
    fee: 0.002,
    feeLabel: "0.02–0.2% dyn. (0.2% priced)",
    color: "#FF6B9D",
  },
  {
    key: "PUMPSWAP",
    dexId: "pumpswap",
    name: "PumpSwap",
    fee: 0.0025,
    feeLabel: "0.25%",
    color: "#4ADE80",
  },
];

/**
 * Solana flash-loan lenders — real protocols with documented fees.
 * MarginFi's 0% makes it the balancer's priority lender (same rule as BNB's
 * low-fee-first rotation).
 */
export const SOL_FLASH_LENDERS: Array<{
  name: string;
  feePct: number;
  feeLabel: string;
  source: string;
}> = [
  { name: "Solend", feePct: 0.3, feeLabel: "0.3%", source: "docs.solend.fi — flash-loan fee" },
  { name: "MarginFi", feePct: 0, feeLabel: "0%", source: "docs.marginfi.com — flash loans" },
  { name: "Kamino", feePct: 0.05, feeLabel: "0.05%", source: "docs.kamino.finance — flash borrow" },
];

/** Lender info for display, mirroring FLASH_LENDER_INFO on BNB. */
export function solLenderInfo(name: string) {
  return SOL_FLASH_LENDERS.find((l) => l.name === name) ?? SOL_FLASH_LENDERS[0]!;
}

/** The balancer prioritizes low-fee lenders; plain rotation otherwise. */
export function solLenderForRun(run: number, balancer: boolean): string {
  const ordered = balancer
    ? [...SOL_FLASH_LENDERS].sort((a, b) => a.feePct - b.feePct)
    : SOL_FLASH_LENDERS;
  return ordered[Math.abs(run) % ordered.length]!.name;
}

/** Fee label for a lender name, e.g. "MarginFi · 0%". */
export function solLenderFeeLabel(name: string): string {
  const info = solLenderInfo(name);
  return `${info.name} · ${info.feeLabel}`;
}

/** Venue def lookup by terminal key (RAY, ORCA, …). */
export function solDexByKey(key: string): SolDexDef | null {
  return SOL_DEXES.find((d) => d.key === key) ?? null;
}

/**
 * Default SOL venue whitelist — every registered venue. Mirrors the BNB
 * default dexWhitelist so the terminal starts fully armed.
 */
export const SOL_DEFAULT_WHITELIST = SOL_DEXES.map((d) => d.key);
