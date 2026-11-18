// FlashBolt Trade — shared asset + pair registry.
//
// Pure data with NO server imports: imported by the Convex backend
// (src/convex/trade.ts) AND the Trade terminal UI, so both sides always
// agree on assets, pairs and cross-rate math.

export type TradeAssetDef = {
  symbol: string;
  name: string;
  kind: "crypto" | "cash";
  /** CoinGecko id — crypto assets only (live USD price source). */
  cgId?: string;
  decimals: number;
  /** Cash only: deposit method shown in the deposit modal. */
  depositMethod?: "bank_transfer" | "mobile_money";
};

/** Crypto assets — live CoinGecko prices, on-chain deposit/withdrawal. */
export const TRADE_CRYPTO_ASSETS: TradeAssetDef[] = [
  { symbol: "BNB", name: "BNB", kind: "crypto", cgId: "binancecoin", decimals: 8 },
  { symbol: "USDT", name: "Tether", kind: "crypto", cgId: "tether", decimals: 6 },
  { symbol: "TRX", name: "TRON", kind: "crypto", cgId: "tron", decimals: 6 },
  { symbol: "USDC", name: "USD Coin", kind: "crypto", cgId: "usd-coin", decimals: 6 },
  { symbol: "ETH", name: "Ethereum", kind: "crypto", cgId: "ethereum", decimals: 8 },
  { symbol: "SOL", name: "Solana", kind: "crypto", cgId: "solana", decimals: 6 },
  { symbol: "LTC", name: "Litecoin", kind: "crypto", cgId: "litecoin", decimals: 8 },
  { symbol: "BTC", name: "Bitcoin", kind: "crypto", cgId: "bitcoin", decimals: 8 },
  { symbol: "XMR", name: "Monero", kind: "crypto", cgId: "monero", decimals: 8 },
  { symbol: "XAUT", name: "Tether Gold", kind: "crypto", cgId: "tether-gold", decimals: 6 },
];

/** Cash currencies — live FX rates, bank-transfer / mobile-money rails. */
export const TRADE_CASH_ASSETS: TradeAssetDef[] = [
  { symbol: "NGN", name: "Nigerian Naira", kind: "cash", decimals: 2, depositMethod: "bank_transfer" },
  { symbol: "USD", name: "US Dollar", kind: "cash", decimals: 2, depositMethod: "bank_transfer" },
  { symbol: "EUR", name: "Euro", kind: "cash", decimals: 2, depositMethod: "bank_transfer" },
  { symbol: "GBP", name: "British Pound", kind: "cash", decimals: 2, depositMethod: "bank_transfer" },
  { symbol: "GHS", name: "Ghanaian Cedi", kind: "cash", decimals: 2, depositMethod: "mobile_money" },
  { symbol: "KES", name: "Kenyan Shilling", kind: "cash", decimals: 2, depositMethod: "mobile_money" },
  { symbol: "XAF", name: "Central African CFA", kind: "cash", decimals: 2, depositMethod: "mobile_money" },
];

/**
 * Currencies funded through DYNAMIC bank / mobile-money accounts: the
 * operator publishes real receiving details per currency (rotatable —
 * old accounts are kept for audit), unlike the static per-asset details
 * used elsewhere. Every cash currency in the registry (USD, EUR, GBP,
 * NGN, GHS, KES, XAF) gets its own rotatable receiving account; the
 * operator chooses per currency whether users fund it via direct bank
 * transfer or a mobile bank app.
 */
export const BANK_DEPOSIT_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "NGN",
  "GHS",
  "KES",
  "XAF",
] as const;
export type BankDepositCurrency = (typeof BANK_DEPOSIT_CURRENCIES)[number];

export function isBankDepositCurrency(s: string): s is BankDepositCurrency {
  return (BANK_DEPOSIT_CURRENCIES as readonly string[]).includes(s);
}

/**
 * Bank-rail currencies supported by the Kora Pay QUI-CHKOUT instant deposit
 * rail (one-time virtual bank accounts; auto-credited on the verified
 * charge.success webhook). Lives here because BOTH the backend
 * (src/convex/kora.ts) and the client deposit modal import it — and this
 * module is deliberately free of server-only imports so that is safe.
 */
export const KORA_CURRENCIES = ["NGN", "GHS", "KES", "XAF"] as const;
export type KoraCurrency = (typeof KORA_CURRENCIES)[number];

export const TRADE_ASSETS: Record<string, TradeAssetDef> = Object.fromEntries(
  [...TRADE_CRYPTO_ASSETS, ...TRADE_CASH_ASSETS].map((a) => [a.symbol, a]),
);

export const TRADE_CG_IDS = TRADE_CRYPTO_ASSETS
  .map((a) => a.cgId)
  .filter((id): id is string => Boolean(id))
  .join(",");

/** FX codes fetched from open.er-api.com (USD base). */
export const TRADE_FX_CODES = TRADE_CASH_ASSETS
  .map((a) => a.symbol)
  .filter((s) => s !== "USD");

/** Display symbols for cash amounts. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  USD: "$",
  EUR: "€",
  GBP: "£",
  GHS: "GH₵",
  KES: "KSh",
  XAF: "FCFA",
};

export function currencySymbol(asset: string): string {
  return CURRENCY_SYMBOLS[asset] ?? "";
}

/**
 * Markets pairs: every crypto against USDT and every cash currency.
 * Generated so the registry stays the single source of truth.
 */
export const TRADE_PAIRS: Array<[string, string, string]> =
  TRADE_CRYPTO_ASSETS.flatMap((c) => {
    const quotes = ["USDT", ...TRADE_FX_CODES];
    return quotes.map((q) => [c.symbol, q, q === "USDT" ? "Spot" : "Instant"] as [string, string, string]);
  });

/** Price map payload of tradePriceCache (JSON string ⇄ this shape). */
export type TradePriceMap = Record<
  string,
  { usd: number; ngn: number; change24hPct: number; ts: number }
>;

/** Cross rate: how many `to` units one `from` unit buys (USD-anchored). */
export function tradeCrossRate(
  prices: TradePriceMap,
  from: string,
  to: string,
): number {
  const f = prices[from];
  const t = prices[to];
  if (!f || !t || !(t.usd > 0)) return 0;
  return f.usd / t.usd;
}

/** Price of `base` quoted in `quote` (works for crypto and cash quotes). */
export function tradeQuotePrice(
  prices: TradePriceMap | null,
  base: string,
  quote: string,
): number {
  if (!prices) return 0;
  return tradeCrossRate(prices, base, quote);
}

/** Human amount formatting used across the terminal. */
export function fmtTradeAmount(n: number, maxFrac = 6): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(2, maxFrac) });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function fmtTradeUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

// ── Networks & wallet compatibility (real-world deposit routing) ──────────

export type TradeNetworkDef = {
  id: string; // "ERC20" | "BEP20" | "TRC20" | "SOL" | "BTC" | "LTC" | "XMR" …
  label: string;
  chainKind: "evm" | "solana" | "tron" | "utxo" | "monero";
  /** Address explorer URL template with {addr}. */
  explorer?: string;
  /** Wallets / exchanges that can send on this network (factual support). */
  wallets: string[];
};

const EVM_WALLETS = ["MetaMask", "Trust Wallet", "OKX", "Binance", "Bybit", "Bitget"];
const SOL_WALLETS = ["Phantom", "Solflare", "Backpack", "OKX", "Binance", "Bybit", "Bitget"];
const EXCHANGES = ["Binance", "Bybit", "Bitget", "OKX"];

export const TRADE_NETWORKS: Record<string, TradeNetworkDef[]> = {
  BNB: [{ id: "BEP20", label: "BNB Smart Chain (BEP-20)", chainKind: "evm", explorer: "https://bscscan.com/address/{addr}", wallets: EVM_WALLETS }],
  ETH: [{ id: "ERC20", label: "Ethereum (ERC-20)", chainKind: "evm", explorer: "https://etherscan.io/address/{addr}", wallets: EVM_WALLETS }],
  USDT: [
    { id: "TRC20", label: "Tron (TRC-20) — lowest fees", chainKind: "tron", explorer: "https://tronscan.org/#/address/{addr}", wallets: ["Trust Wallet", ...EXCHANGES] },
    { id: "ERC20", label: "Ethereum (ERC-20)", chainKind: "evm", explorer: "https://etherscan.io/address/{addr}", wallets: EVM_WALLETS },
    { id: "BEP20", label: "BNB Smart Chain (BEP-20)", chainKind: "evm", explorer: "https://bscscan.com/address/{addr}", wallets: EVM_WALLETS },
    { id: "SOL", label: "Solana (SPL)", chainKind: "solana", explorer: "https://solscan.io/account/{addr}", wallets: SOL_WALLETS },
  ],
  USDC: [
    { id: "ERC20", label: "Ethereum (ERC-20)", chainKind: "evm", explorer: "https://etherscan.io/address/{addr}", wallets: EVM_WALLETS },
    { id: "BEP20", label: "BNB Smart Chain (BEP-20)", chainKind: "evm", explorer: "https://bscscan.com/address/{addr}", wallets: EVM_WALLETS },
    { id: "SOL", label: "Solana (SPL)", chainKind: "solana", explorer: "https://solscan.io/account/{addr}", wallets: SOL_WALLETS },
  ],
  TRX: [{ id: "TRON", label: "Tron native", chainKind: "tron", explorer: "https://tronscan.org/#/address/{addr}", wallets: ["Trust Wallet", ...EXCHANGES] }],
  SOL: [{ id: "SOL", label: "Solana native", chainKind: "solana", explorer: "https://solscan.io/account/{addr}", wallets: SOL_WALLETS }],
  LTC: [{ id: "LTC", label: "Litecoin native", chainKind: "utxo", explorer: "https://blockchair.com/litecoin/address/{addr}", wallets: ["Trust Wallet", "Litewallet", ...EXCHANGES] }],
  BTC: [{ id: "BTC", label: "Bitcoin native (SegWit)", chainKind: "utxo", explorer: "https://mempool.space/address/{addr}", wallets: ["Trust Wallet", ...EXCHANGES] }],
  XMR: [{ id: "XMR", label: "Monero native", chainKind: "monero", wallets: ["Official Monero GUI", "Feather Wallet", ...EXCHANGES] }],
  XAUT: [{ id: "ERC20", label: "Ethereum (ERC-20)", chainKind: "evm", explorer: "https://etherscan.io/address/{addr}", wallets: EVM_WALLETS }],
};

/** Storage key for a receiving detail: "USDT:TRC20" or plain "NGN". */
export function tradeDetailKey(asset: string, netId?: string): string {
  return netId ? `${asset}:${netId}` : asset;
}

/** Parse "ASSET" / "ASSET:NET" into parts. */
export function parseTradeDetailKey(key: string): { asset: string; netId?: string } {
  const i = key.indexOf(":");
  if (i < 0) return { asset: key };
  return { asset: key.slice(0, i), netId: key.slice(i + 1) };
}
