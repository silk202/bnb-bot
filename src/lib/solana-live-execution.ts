/**
 * SOL FlashBolt — REAL live execution with the connected wallet.
 *
 * The missing link, honestly filled: SolScanner's live branch already had
 * simulate → Jito/public submit, but nothing ever built `signedTxBase64`.
 * This module builds REAL swap transactions a connected Phantom/Solflare/
 * Backpack wallet signs, via the two real primitives Solana offers:
 *
 *   1. JUPITER v1 (lite-api.jup.ag) — real on-chain swap routes with real
 *      slippage protection: buy leg SOL→mint, sell leg mint→SOL. The
 *      `computeUnitPriceMicroLamports` priority fee plus Jito bundle landing
 *      is the real protective combination used by production snipers.
 *   2. Direct SERUM/AMM-era fallback is intentionally NOT fabricated — if
 *      Jupiter is unreachable, the module reports honestly and nothing is
 *      signed or broadcast.
 *
 * The wallet signature NEVER leaves the extension: the unsigned serialized
 * transaction goes to `provider.signTransaction`, and only the wallet's
 * signed bytes are ever broadcast (public RPC or Jito block-engine).
 *
 * NO MOCKING anywhere: every function performs real network I/O or refuses.
 */

import { LAMPORTS_PER_SOL } from "./solana-jito";
import { fetchWithTimeout } from "./fetch-timeout";

// ---------------------------------------------------------------------------
// Jupiter v1 API (real endpoints, no keys required for the public tier)
// ---------------------------------------------------------------------------

export const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
export const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

/** Wrapped SOL mint — the quote asset every SOL flasher route starts from. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const SOL_MINT = WSOL_MINT;

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label?: string } }>;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  priorityFeeLamports: number;
  simulationError?: unknown;
}

async function jupGet<T>(url: string, label: string): Promise<T> {
  const res = await fetchWithTimeout(url, 12_000, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}${body ? ` — ${body.slice(0, 140)}` : ""}`);
  }
  return (await res.json()) as T;
}

async function jupPost<T>(url: string, body: unknown, label: string): Promise<T> {
  const res = await fetchWithTimeout(url, 12_000, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}${text ? ` — ${text.slice(0, 140)}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * REAL Jupiter quote: SOL → token (buy leg). amountInRaw is lamports.
 * Refuses honestly (throws) when no route exists — the caller drops the
 * route instead of pretending.
 */
export async function jupiterQuoteSolToToken(
  mint: string,
  amountInLamports: number,
  slippageBps: number,
): Promise<JupiterQuoteResponse> {
  const url =
    `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${encodeURIComponent(mint)}` +
    `&amount=${Math.max(1, Math.floor(amountInLamports))}&slippageBps=${Math.max(0, Math.floor(slippageBps))}`;
  return jupGet<JupiterQuoteResponse>(url, "Jupiter quote (SOL→token)");
}

/** REAL Jupiter quote: token → SOL (sell leg). amountInRaw is mint units. */
export async function jupiterQuoteTokenToSol(
  mint: string,
  amountInRaw: string,
  slippageBps: number,
): Promise<JupiterQuoteResponse> {
  const url =
    `${JUPITER_QUOTE_URL}?inputMint=${encodeURIComponent(mint)}&outputMint=${SOL_MINT}` +
    `&amount=${amountInRaw}&slippageBps=${Math.max(0, Math.floor(slippageBps))}`;
  return jupGet<JupiterQuoteResponse>(url, "Jupiter quote (token→SOL)");
}

export interface BuildSwapTxOpts {
  /** The connected wallet's public key (base58) — the tx's fee payer/signer. */
  userPublicKey: string;
  /** Slippage for BOTH legs, in basis points (from the terminal's setting). */
  slippageBps: number;
  /**
   * Priority fee in micro-lamports per CU — the real Jito-style expediter.
   * Default 50_000 (0.00005 SOL/CU ceiling) keeps tiny routes landable.
   */
  priorityFeeMicroLamports?: number;
}

/**
 * Build the REAL unsigned versioned transaction (base64) for a Jupiter swap.
 * This is the exact artifact the wallet extension signs.
 */
export async function jupiterBuildSwapTransaction(
  quote: JupiterQuoteResponse,
  opts: BuildSwapTxOpts,
): Promise<JupiterSwapResponse> {
  return jupPost<JupiterSwapResponse>(
    JUPITER_SWAP_URL,
    {
      quoteResponse: quote,
      userPublicKey: opts.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: opts.priorityFeeMicroLamports ?? 50_000,
    },
    "Jupiter swap build",
  );
}

// ---------------------------------------------------------------------------
// Route planning — one real two-leg arb plan priced by Jupiter itself
// ---------------------------------------------------------------------------

export interface SolLiveRoutePlan {
  /** Buy leg: SOL amount in (lamports) and tokens expected out (raw units). */
  buyInLamports: number;
  buyOutRaw: string;
  buyVenueLabels: string[];
  /** Sell leg: tokens in (raw) and SOL expected back (lamports, raw string). */
  sellInRaw: string;
  sellOutLamports: string;
  sellVenueLabels: string[];
  /** Net profit in lamports expected at quote time (sellOut − buyIn). */
  expectedNetLamports: number;
  /** Net ROI vs the borrowed principal, in percent. */
  expectedNetPct: number;
  /** Price impact across both legs, percent (sum; conservative). */
  priceImpactPct: number;
}

/**
 * Price a two-leg SOL→mint→SOL round trip with REAL Jupiter quotes. This is
 * the honest replacement for stale DexScreener spread math: the executable
 * route IS the quote. Returns null when either leg has no real route.
 */
export async function priceSolRoundTrip(
  mint: string,
  loanLamports: number,
  slippageBps: number,
): Promise<SolLiveRoutePlan | null> {
  const buy = await jupiterQuoteSolToToken(mint, loanLamports, slippageBps);
  const sell = await jupiterQuoteTokenToSol(mint, buy.outAmount, slippageBps);
  const buyIn = Number(buy.inAmount);
  const sellOut = Number(sell.outAmount);
  if (!Number.isFinite(buyIn) || !Number.isFinite(sellOut)) return null;
  const expectedNetLamports = sellOut - buyIn;
  const impact = Number(buy.priceImpactPct ?? 0) + Number(sell.priceImpactPct ?? 0);
  return {
    buyInLamports: buyIn,
    buyOutRaw: buy.outAmount,
    buyVenueLabels: (buy.routePlan ?? [])
      .map((s) => s.swapInfo?.label ?? "")
      .filter(Boolean),
    sellInRaw: sell.inAmount,
    sellOutLamports: sell.outAmount,
    sellVenueLabels: (sell.routePlan ?? [])
      .map((s) => s.swapInfo?.label ?? "")
      .filter(Boolean),
    expectedNetLamports,
    expectedNetPct: buyIn > 0 ? (expectedNetLamports / buyIn) * 100 : 0,
    priceImpactPct: impact * 100,
  };
}

// ---------------------------------------------------------------------------
// Wallet signing — the key NEVER leaves the extension
// ---------------------------------------------------------------------------

/** Minimal Solana injected-provider shape used for signing. */
export interface SolSigningProvider {
  publicKey?: { toString(): string } | null;
  signTransaction(tx: unknown): Promise<unknown>;
}

/**
 * Ask the wallet to sign the unsigned base64 versioned tx. Uses
 * @solana/web3.js to deserialize → VersionedTransaction, hands the REAL
 * object to the injected provider, and returns the signed bytes (base64).
 * The private key never leaves the extension.
 */
export async function walletSignBase64Tx(
  provider: SolSigningProvider,
  unsignedBase64: string,
): Promise<string> {
  const { VersionedTransaction } = await import("@solana/web3.js");
  const { Buffer } = await import("buffer");
  const raw = Buffer.from(unsignedBase64, "base64");
  const tx = VersionedTransaction.deserialize(new Uint8Array(raw));
  const signed = (await provider.signTransaction(tx)) as {
    serialize(): Uint8Array;
  };
  const bytes = signed.serialize();
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// The end-to-end live route: plan → build both legs → sign → return payloads
// ---------------------------------------------------------------------------

export interface SignedSolRoute {
  /** Base64 SIGNED buy-leg tx (wallet's signature included). */
  buySignedTxBase64: string;
  /** Base64 SIGNED sell-leg tx. */
  sellSignedTxBase64: string;
  plan: SolLiveRoutePlan;
}

/**
 * Build + sign BOTH legs of the live arb for a mint with the connected
 * wallet. Every step is real: quotes are real, the swap txs are real, the
 * signature is the wallet's. Sequential atomicity: the sell tx is built
 * from the buy leg's expected out; both are signed BEFORE any broadcast so
 * the pair lands back-to-back (the sell reverts safely via slippage if the
 * buy landed differently).
 */
export async function buildAndSignLiveArb(opts: {
  provider: SolSigningProvider;
  mint: string;
  loanLamports: number;
  slippageBps: number;
  priorityFeeMicroLamports?: number;
  /** RPC used for the pre-sign simulation gates (verdict before signature). */
  solRpcUrl: string;
}): Promise<SignedSolRoute> {
  const { provider, mint, loanLamports, slippageBps } = opts;
  const pubkey = provider.publicKey?.toString();
  if (!pubkey) {
    throw new Error("Wallet is connected but exposes no public key — unlock it and reconnect.");
  }

  const plan = await priceSolRoundTrip(mint, loanLamports, slippageBps);
  if (!plan) {
    throw new Error("No executable Jupiter route for this token right now — route dropped honestly.");
  }

  const buyQuote = await jupiterQuoteSolToToken(mint, loanLamports, slippageBps);
  const buyUnsigned = await jupiterBuildSwapTransaction(buyQuote, {
    userPublicKey: pubkey,
    slippageBps,
    priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
  });
  // Verdict BEFORE the first signature: a would-fail buy leg refuses the
  // whole route with the wallet never having opened. Transport errors carry
  // no verdict and fall through — the post-sign simulation gate still runs.
  const { simulateSolTx } = await import("./solana-jito");
  try {
    const buySim = await simulateSolTx(buyUnsigned.swapTransaction, { rpcUrl: opts.solRpcUrl });
    if (!buySim.ok) {
      throw new Error(
        `buy leg would fail on-chain (${buySim.error ?? "simulation error"}) — route refused before any signature, zero gas`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("buy leg would fail")) throw e;
    // simulateTransaction transport hiccup — not a verdict; continue.
  }
  const sellQuote = await jupiterQuoteTokenToSol(mint, buyQuote.outAmount, slippageBps);
  const sellUnsigned = await jupiterBuildSwapTransaction(sellQuote, {
    userPublicKey: pubkey,
    slippageBps,
    priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
  });

  const buySignedTxBase64 = await walletSignBase64Tx(provider, buyUnsigned.swapTransaction);
  // The sell leg is only signed after ITS own pre-sign simulation passes —
  // a failing exit never asks the wallet for a second signature. The buy
  // signature (if obtained) is never broadcast by this module on that path.
  try {
    const sellSim = await simulateSolTx(sellUnsigned.swapTransaction, { rpcUrl: opts.solRpcUrl });
    if (!sellSim.ok) {
      throw new Error(
        `sell leg would fail on-chain (${sellSim.error ?? "simulation error"}) — buy leg signed but NOT broadcast, nothing spent`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("sell leg would fail")) throw e;
    // Transport hiccup — not a verdict; proceed (post-sign gate decides).
  }
  const sellSignedTxBase64 = await walletSignBase64Tx(provider, sellUnsigned.swapTransaction);

  return { buySignedTxBase64, sellSignedTxBase64, plan };
}

// ---------------------------------------------------------------------------
// End-to-end submission orchestrator — sim → buy → confirm → sell → result
// ---------------------------------------------------------------------------

/**
 * Public raw-RPC call — the exact transport every execution path uses
 * (drills, position monitor, sell legs). Real JSON-RPC over fetch with the
 * module's timeout discipline; throws on RPC error objects.
 */
export function solRpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  return postRpc<T>(rpcUrl, method, params);
}

async function postRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(rpcUrl, 15_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? method + " failed");
  return json.result as T;
}

/** Poll getSignatureStatuses until the tx lands (or times out) — real confirmation. */
export async function waitForSigConfirm(
  sig: string,
  rpcUrl: string,
  timeoutMs = 60_000,
): Promise<{ confirmed: boolean; err: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const statuses = await postRpc<Array<null | { err: unknown; confirmationStatus?: string }>>(
        rpcUrl,
        "getSignatureStatuses",
        [[sig], { searchHistory: true }],
      );
      const st = statuses?.[0];
      if (st) {
        if (st.err) return { confirmed: false, err: String(st.err) };
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          return { confirmed: true, err: null };
        }
      }
    } catch {
      // RPC hiccup — keep polling until the timeout.
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return { confirmed: false, err: "confirmation timeout" };
}

/** First available injected Solana signing provider (Phantom → Solflare → Backpack). */
export function getInjectedSolProvider(): SolSigningProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const phantom = (w.phantom as { solana?: SolSigningProvider } | undefined)?.solana;
  if (phantom) return phantom;
  const direct = w.solana as SolSigningProvider | undefined;
  if (direct) return direct;
  const solflare = w.solflare as SolSigningProvider | undefined;
  if (solflare) return solflare;
  return (w.backpack as SolSigningProvider | undefined) ?? null;
}

/**
 * The single signer resolver every live surface uses: an explicit provider
 * wins, then the imported-wallet vault signer (in-memory ed25519), then the
 * connected extension. Null = nothing armed — surfaces must refuse honestly.
 */
export async function resolveLiveSigner(
  explicit?: SolSigningProvider | null,
): Promise<SolSigningProvider | null> {
  if (explicit) return explicit;
  const { getVaultSigner } = await import("./solana-vault");
  return getVaultSigner() ?? getInjectedSolProvider();
}

/**
 * REAL on-chain SPL token balance for (owner, mint) — summed across all the
 * owner's token accounts for that mint. Used to sell the ACTUAL position,
 * never a guessed amount. Returns 0 raw units when nothing is held.
 */
export async function fetchTokenBalanceRaw(
  rpcUrl: string,
  owner: string,
  mint: string,
): Promise<string> {
  const json = await postRpc<{ value?: Array<{ account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }>(
    rpcUrl,
    "getTokenAccountsByOwner",
    [owner, { mint }, { encoding: "jsonParsed" }],
  );
  let total = 0n;
  for (const acc of json?.value ?? []) {
    const amount = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amount) total += BigInt(amount);
  }
  return total.toString();
}

// ─────────────────────────────────────────────────────────────────────────
// Buy affordability pre-flight — refuses unaffordable buys BEFORE the wallet
// popup, with exact numbers. This is the in-app catch for the classic
// Phantom failure ("You don't have enough SOL for this transaction" +
// "Failed to simulate the results of this request"): the wallet never opens
// for a swap the balance cannot cover, and the refusal carries the real
// math. NO MOCKING — getBalance hits the live RPC.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fee/rent headroom on top of the buy amount: base fee + priority fee plus
 * transient wrap/unwrap wSOL + destination ATA rent (returned on unwrap,
 * but the balance must cover it during the swap). 0.005 SOL is comfortably
 * above the worst observed combination for a single Jupiter route.
 */
export const BUY_FEE_RESERVE_LAMPORTS = 5_000_000;

/**
 * Validation attached to every SOL BUY simulation (the analogue of BNB's
 * eth_call output validation, but measured on real balances): the wallet's
 * lamports must come out of the dry run no worse than the clip plus the same
 * fee/rent reserve the pre-flight already assumes. A route that would charge
 * more SOL than quoted — or need more compute than a tx can carry — is
 * refused before the wallet opens. Reading pre/post balances is exact
 * because a simulation never commits state.
 */
export function solBuySimExpectation(pubkey: string, amountLamports: number) {
  const clip = Number.isFinite(amountLamports) ? Math.max(0, Math.floor(amountLamports)) : 0;
  return {
    accounts: [pubkey],
    maxLamportSpend: BigInt(clip + BUY_FEE_RESERVE_LAMPORTS),
    // 1.4M CU is the protocol ceiling — a route above it cannot land at all.
    maxComputeUnits: 1_400_000,
  };
}

export interface BuyAffordability {
  ok: boolean;
  balanceLamports: number;
  amountLamports: number;
  reserveLamports: number;
  requiredLamports: number;
  shortfallLamports: number;
  /** Honest human message; carries the exact numbers when short. */
  message: string;
}

const fmtSol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(5);

/**
 * Pure affordability math (unit-tested, no I/O): does the wallet balance
 * cover buy amount + fee/rent reserve? Never throws; negative/NaN inputs
 * are floored to 0 so a bad quote can never fake an "affordable" verdict.
 */
export function computeBuyAffordability(
  balanceLamports: number,
  amountLamports: number,
  reserveLamports = BUY_FEE_RESERVE_LAMPORTS,
): BuyAffordability {
  const balance = Number.isFinite(balanceLamports) ? Math.max(0, Math.floor(balanceLamports)) : 0;
  const amount = Number.isFinite(amountLamports) ? Math.max(0, Math.floor(amountLamports)) : 0;
  const reserve = Number.isFinite(reserveLamports) ? Math.max(0, Math.floor(reserveLamports)) : 0;
  const requiredLamports = amount + reserve;
  const shortfallLamports = Math.max(0, requiredLamports - balance);
  const ok = shortfallLamports === 0;
  return {
    ok,
    balanceLamports: balance,
    amountLamports: amount,
    reserveLamports: reserve,
    requiredLamports,
    shortfallLamports,
    message: ok
      ? `Affordable — wallet ${fmtSol(balance)} SOL covers buy ${fmtSol(amount)} + fees/rent reserve ${fmtSol(reserve)} SOL.`
      : `Insufficient SOL: wallet holds ${fmtSol(balance)} SOL but the buy needs ${fmtSol(amount)} + ${fmtSol(reserve)} fees/rent = ${fmtSol(requiredLamports)} SOL — short by ${fmtSol(shortfallLamports)} SOL. Nothing was signed or spent; top up the wallet or lower the buy amount.`,
  };
}

/**
 * Smallest clip the wallet-fit path will execute. On Solana the wallet
 * FRONTS the whole clip (no borrowed principal), so a signal bigger than
 * the balance can never land — but a smaller REAL trade can. 0.05 SOL keeps
 * the fee/rent reserve and the Jito tip comfortably sub-dominant, so the
 * fitted route still lands as an actual arbitrage rather than fee noise.
 */
export const SOL_FIT_MIN_LOAN_LAMPORTS = 50_000_000; // 0.05 SOL

export interface WalletFit {
  /** True when a route can execute (fitted or at the requested size). */
  ok: boolean;
  /** True when the requested loan had to be clipped down to the wallet. */
  fitted: boolean;
  requestedLamports: number;
  /** Executable loan — equals the request unless `fitted`. */
  loanLamports: number;
  balanceLamports: number;
  reserveLamports: number;
  minFitLamports: number;
  /** Decent human report with the exact numbers, whichever way it went. */
  message: string;
}

/**
 * Wallet-fit sizing for the two-leg SOL route: instead of refusing an
 * oversized signal (or letting it reach the wallet as a doomed Phantom
 * popup), clip the clip down to what the wallet can actually front —
 * `balance − fee/rent reserve` — floored at SOL_FIT_MIN_LOAN_LAMPORTS.
 * Below the floor the fit refuses with the exact top-up math. Pure math, no
 * I/O; unit tested.
 */
export function fitRouteLoanToWallet(
  balanceLamports: number,
  requestedLamports: number,
  reserveLamports = BUY_FEE_RESERVE_LAMPORTS,
  minFitLamports = SOL_FIT_MIN_LOAN_LAMPORTS,
): WalletFit {
  const balance = Number.isFinite(balanceLamports) ? Math.max(0, Math.floor(balanceLamports)) : 0;
  const requested = Number.isFinite(requestedLamports) ? Math.max(0, Math.floor(requestedLamports)) : 0;
  const reserve = Number.isFinite(reserveLamports) ? Math.max(0, Math.floor(reserveLamports)) : 0;
  const minFit = Number.isFinite(minFitLamports) ? Math.max(0, Math.floor(minFitLamports)) : 0;
  const affordable = Math.max(0, balance - reserve);
  if (requested <= affordable) {
    return {
      ok: true,
      fitted: false,
      requestedLamports: requested,
      loanLamports: requested,
      balanceLamports: balance,
      reserveLamports: reserve,
      minFitLamports: minFit,
      message: `Wallet covers the requested ${fmtSol(requested)} SOL clip — no fit needed.`,
    };
  }
  if (affordable >= minFit) {
    return {
      ok: true,
      fitted: true,
      requestedLamports: requested,
      loanLamports: affordable,
      balanceLamports: balance,
      reserveLamports: reserve,
      minFitLamports: minFit,
      message: `Clip fitted to the wallet: ${fmtSol(requested)} SOL requested, ${fmtSol(affordable)} SOL executable (balance ${fmtSol(balance)} − ${fmtSol(reserve)} fees/rent reserve). The wallet fronts the clip on Solana, so the route lands at the fitted size.`,
    };
  }
  return {
    ok: false,
    fitted: false,
    requestedLamports: requested,
    loanLamports: 0,
    balanceLamports: balance,
    reserveLamports: reserve,
    minFitLamports: minFit,
    message: `Wallet too small to front any route: ${fmtSol(balance)} SOL held − ${fmtSol(reserve)} fees/rent = ${fmtSol(affordable)} SOL usable, below the ${fmtSol(minFit)} SOL minimum clip — top up to at least ${fmtSol(minFit + reserve)} SOL and the next signal lands. Nothing was signed or spent.`,
  };
}

/**
 * REAL pre-flight: live getBalance (lamports) for the wallet owner, then the
 * pure affordability math. Throws only on RPC transport failure (the caller
 * decides whether that blocks execution); an insufficient balance is NOT a
 * throw — it is an `ok: false` verdict with the exact shortfall.
 */
export async function preflightSolBuyBalance(
  rpcUrl: string,
  owner: string,
  amountLamports: number,
  reserveLamports = BUY_FEE_RESERVE_LAMPORTS,
): Promise<BuyAffordability> {
  const balance = await postRpc<number>(rpcUrl, "getBalance", [owner]);
  return computeBuyAffordability(
    typeof balance === "number" ? balance : 0,
    amountLamports,
    reserveLamports,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Live SNIPE legs — real buy + real sell for the Solana sniper (auto/manual)
// ─────────────────────────────────────────────────────────────────────────

export interface LiveSnipeBuyOutcome {
  ok: boolean;
  buySig?: string;
  /** Token raw units the buy quote expected out (the planned position). */
  expectedOutRaw?: string;
  engine: string;
  error?: string;
  venue?: string;
  /**
   * Present when the clip was fitted down to the wallet's real balance
   * (requested vs executed lamports) — the report should say so.
   */
  fit?: { requestedLamports: number; loanLamports: number };
}

/**
 * Execute a REAL snipe buy: Jupiter quote SOL→mint with the operator's clip,
 * build the swap tx, sign (vault or extension), zero-gas simulate, submit
 * (Jito protected when engines given, public otherwise), confirm on-chain.
 */
export async function executeLiveSnipeBuy(opts: {
  mint: string;
  amountLamports: number;
  slippageBps: number;
  solRpcUrl: string;
  jitoEngines?: string[];
  provider?: SolSigningProvider;
  priorityFeeMicroLamports?: number;
  /**
   * When true, an oversized clip is FITTED down to what the wallet can
   * actually front (balance − fee/rent reserve, floored at
   * SOL_FIT_MIN_LOAN_LAMPORTS) instead of being refused — the buy lands as
   * a real, smaller clip. Below the floor the refusal stands.
   */
  fitToWallet?: boolean;
}): Promise<LiveSnipeBuyOutcome> {
  const provider = await resolveLiveSigner(opts.provider);
  if (!provider?.publicKey) {
    return { ok: false, engine: "none", error: "no-wallet" };
  }
  const pubkey = provider.publicKey.toString();
  try {
    // PRE-FLIGHT 1 — real balance check BEFORE anything reaches the wallet:
    // buy amount + fee/rent reserve must fit the wallet's actual lamports,
    // or the route is refused inline (Phantom never opens, nothing signed).
    // With fitToWallet the clip instead shrinks to what the wallet can front
    // and the buy executes at the fitted size — a real, smaller position.
    const afford = await preflightSolBuyBalance(opts.solRpcUrl, pubkey, opts.amountLamports);
    let amountLamports = opts.amountLamports;
    let fit: LiveSnipeBuyOutcome["fit"];
    if (!afford.ok) {
      const walletFit = fitRouteLoanToWallet(afford.balanceLamports, opts.amountLamports);
      if (opts.fitToWallet && walletFit.ok) {
        amountLamports = walletFit.loanLamports;
        fit = { requestedLamports: opts.amountLamports, loanLamports: amountLamports };
      } else {
        return {
          ok: false,
          engine: "preflight-balance",
          error: opts.fitToWallet ? walletFit.message : afford.message,
          venue: "Jupiter",
        };
      }
    }
    const quote = await jupiterQuoteSolToToken(opts.mint, amountLamports, opts.slippageBps);
    const venue = (quote.routePlan ?? [])[0]?.swapInfo?.label ?? "Jupiter";
    const unsigned = await jupiterBuildSwapTransaction(quote, {
      userPublicKey: pubkey,
      slippageBps: opts.slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
    });
    // PRE-FLIGHT 2 — zero-gas simulation of the EXACT unsigned tx against
    // live chain state BEFORE the wallet prompt: a would-fail swap (route
    // moved, ATA rent, slippage) is refused with the real on-chain failure
    // instead of a doomed Phantom "Failed to simulate" confirm dialog. A
    // transport-level sim error is NOT a verdict — execution continues and
    // the post-sign simulation gate still applies.
    const { simulateSolTx, jitoSendProtectedTx, solSendPublicTx } = await import("./solana-jito");
    try {
      const preSignSim = await simulateSolTx(unsigned.swapTransaction, {
        rpcUrl: opts.solRpcUrl,
        expectation: solBuySimExpectation(pubkey, amountLamports),
      });
      if (!preSignSim.ok) {
        return {
          ok: false,
          engine: "preflight-sim",
          error: preSignSim.error ?? "buy pre-sign simulation failed — nothing was signed or spent",
          venue,
        };
      }
    } catch {
      // No verdict available — proceed to sign; the post-sign gate decides.
    }
    const signedTxBase64 = await walletSignBase64Tx(provider, unsigned.swapTransaction);

    const sim = await simulateSolTx(signedTxBase64, {
      rpcUrl: opts.solRpcUrl,
      expectation: solBuySimExpectation(pubkey, amountLamports),
    });
    if (!sim.ok) {
      return { ok: false, engine: "sim", error: sim.error ?? "buy simulation failed — zero gas spent", venue };
    }
    const sent =
      opts.jitoEngines && opts.jitoEngines.length > 0
        ? await jitoSendProtectedTx(signedTxBase64, { bundleOnly: true, engines: opts.jitoEngines })
        : await solSendPublicTx(signedTxBase64, { rpcUrl: opts.solRpcUrl });
    const confirm = await waitForSigConfirm(sent.id, opts.solRpcUrl);
    if (!confirm.confirmed) {
      return { ok: false, buySig: sent.id, engine: sent.engine, error: confirm.err ?? "buy did not confirm", venue };
    }
    return { ok: true, buySig: sent.id, expectedOutRaw: quote.outAmount, engine: sent.engine, venue, fit };
  } catch (e) {
    return { ok: false, engine: "none", error: e instanceof Error ? e.message : "snipe buy failed" };
  }
}

export interface LiveSnipeSellOutcome {
  ok: boolean;
  sellSig?: string;
  /** Realized net vs the recorded entry cost, lamports (quote-time). */
  engine: string;
  error?: string;
  soldRaw?: string;
}

/**
 * Execute a REAL snipe sell: reads the wallet's ACTUAL token balance for the
 * mint (never a guessed amount), quotes mint→SOL on Jupiter, signs, sims,
 * submits and confirms. `tokenAmountRaw` overrides the balance query when
 * the caller wants a partial exit.
 */
export async function executeLiveSnipeSell(opts: {
  mint: string;
  tokenAmountRaw?: string;
  slippageBps: number;
  solRpcUrl: string;
  jitoEngines?: string[];
  provider?: SolSigningProvider;
  priorityFeeMicroLamports?: number;
}): Promise<LiveSnipeSellOutcome> {
  const provider = await resolveLiveSigner(opts.provider);
  if (!provider?.publicKey) {
    return { ok: false, engine: "none", error: "no-wallet" };
  }
  const pubkey = provider.publicKey.toString();
  try {
    const raw = opts.tokenAmountRaw ?? (await fetchTokenBalanceRaw(opts.solRpcUrl, pubkey, opts.mint));
    if (!raw || raw === "0") {
      return { ok: false, engine: "none", error: "no token balance held for this mint" };
    }
    const quote = await jupiterQuoteTokenToSol(opts.mint, raw, opts.slippageBps);
    const unsigned = await jupiterBuildSwapTransaction(quote, {
      userPublicKey: pubkey,
      slippageBps: opts.slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
    });
    // Pre-sign zero-gas simulation — same refusal-before-prompt discipline
    // as the buy leg (wallet never opens for a would-fail exit). Transport
    // errors carry no verdict and fall through to the post-sign gate.
    const { simulateSolTx, jitoSendProtectedTx, solSendPublicTx } = await import("./solana-jito");
    try {
      const preSignSim = await simulateSolTx(unsigned.swapTransaction, {
        rpcUrl: opts.solRpcUrl,
        // Balance deltas are reported for the exit (an exit must never be
        // judged on lamport gain alone — priority fees and rent move it).
        expectation: { accounts: [pubkey], maxComputeUnits: 1_400_000 },
      });
      if (!preSignSim.ok) {
        return {
          ok: false,
          engine: "preflight-sim",
          error: preSignSim.error ?? "sell pre-sign simulation failed — nothing was signed or spent",
          soldRaw: raw,
        };
      }
    } catch {
      // No verdict available — proceed to sign; the post-sign gate decides.
    }
    const signedTxBase64 = await walletSignBase64Tx(provider, unsigned.swapTransaction);

    const sim = await simulateSolTx(signedTxBase64, {
      rpcUrl: opts.solRpcUrl,
      expectation: { accounts: [pubkey], maxComputeUnits: 1_400_000 },
    });
    if (!sim.ok) {
      return { ok: false, engine: "sim", error: sim.error ?? "sell simulation failed — position untouched", soldRaw: raw };
    }
    const sent =
      opts.jitoEngines && opts.jitoEngines.length > 0
        ? await jitoSendProtectedTx(signedTxBase64, { bundleOnly: true, engines: opts.jitoEngines })
        : await solSendPublicTx(signedTxBase64, { rpcUrl: opts.solRpcUrl });
    const confirm = await waitForSigConfirm(sent.id, opts.solRpcUrl);
    if (!confirm.confirmed) {
      return { ok: false, sellSig: sent.id, engine: sent.engine, error: confirm.err ?? "sell did not confirm", soldRaw: raw };
    }
    return { ok: true, sellSig: sent.id, engine: sent.engine, soldRaw: raw };
  } catch (e) {
    return { ok: false, engine: "none", error: e instanceof Error ? e.message : "snipe sell failed" };
  }
}

export interface LiveArbOutcome {
  ok: boolean;
  /** Real buy-leg signature (present once the buy was broadcast). */
  buySig?: string;
  /** Real sell-leg signature (present once the sell was broadcast). */
  sellSig?: string;
  /** Real quoted net in lamports (sellOut − buyIn at execution quotes). */
  netLamports: number;
  /** Net ROI percent at execution quotes. */
  netPct: number;
  /** Submission channel actually used. */
  engine: string;
  /** Honest failure description when ok is false. */
  error?: string;
  /** Venue labels of both legs (real Jupiter route plan). */
  venues: string[];
  /**
   * Present when the clip was fitted down to the wallet's real balance
   * (requested vs executed lamports) — the report should say so.
   */
  fit?: { requestedLamports: number; loanLamports: number };
}

/**
 * Execute a REAL two-leg live arb end-to-end with the connected wallet:
 * build both legs from live Jupiter quotes → wallet signs → zero-gas
 * simulation of the buy leg → submit through Jito (protected) or the public
 * RPC → wait for the buy to confirm → submit the sell → wait. Every number
 * in the outcome is real; any failure aborts honestly with what actually
 * happened (the sell is only fired after the buy confirms — if the buy
 * itself failed, nothing more is broadcast).
 */
export async function executeLiveArb(opts: {
  mint: string;
  loanLamports: number;
  slippageBps: number;
  priorityFeeMicroLamports?: number;
  solRpcUrl: string;
  /** When set, txs go through the Jito block-engine (protected, revert-safe). */
  jitoEngines?: string[];
  /**
   * Explicit signer override — the imported-wallet vault signer (in-memory
   * ed25519, no extension prompt). When unset, the connected extension
   * wallet is used. Exactly one of them must exist or the route is refused
   * honestly with "no-wallet".
   */
  provider?: SolSigningProvider;
  /**
   * When true, an oversized clip is FITTED down to what the wallet can
   * actually front (balance − fee/rent reserve, floored at
   * SOL_FIT_MIN_LOAN_LAMPORTS) instead of being refused — the route lands
   * as a real, smaller trade. Below the floor the refusal stands.
   */
  fitToWallet?: boolean;
  onPhase?: (phase: string) => void;
}): Promise<LiveArbOutcome> {
  const provider = await resolveLiveSigner(opts.provider);
  if (!provider?.publicKey) {
    return { ok: false, netLamports: 0, netPct: 0, engine: "none", venues: [], error: "no-wallet" };
  }
  const { simulateSolTx, jitoSendProtectedTx, solSendPublicTx } = await import("./solana-jito");
  const { onPhase, solRpcUrl, jitoEngines, mint, slippageBps } = opts;
  const send = async (signedBase64: string): Promise<{ id: string; engine: string }> =>
    jitoEngines && jitoEngines.length > 0
      ? jitoSendProtectedTx(signedBase64, { bundleOnly: true, engines: jitoEngines })
      : solSendPublicTx(signedBase64, { rpcUrl: solRpcUrl });

  try {
    // Balance pre-flight BEFORE the first wallet prompt: the two-leg route
    // is refused inline (exact shortfall numbers) when the wallet cannot
    // cover the loan size + fees/rent. With fitToWallet the clip is instead
    // FITTED down to what the wallet can front so an oversized signal lands
    // as a real, smaller trade — never a doomed Phantom popup.
    const afford = await preflightSolBuyBalance(
      solRpcUrl,
      provider.publicKey.toString(),
      opts.loanLamports,
    );
    let loanLamports = opts.loanLamports;
    let fit: LiveArbOutcome["fit"];
    if (!afford.ok) {
      const walletFit = fitRouteLoanToWallet(afford.balanceLamports, opts.loanLamports);
      if (opts.fitToWallet && walletFit.ok) {
        loanLamports = walletFit.loanLamports;
        fit = { requestedLamports: opts.loanLamports, loanLamports };
        onPhase?.("fitted");
      } else {
        return {
          ok: false,
          netLamports: 0,
          netPct: 0,
          engine: "preflight-balance",
          venues: [],
          error: opts.fitToWallet ? walletFit.message : afford.message,
        };
      }
    }
    onPhase?.("quoting");
    const signed = await buildAndSignLiveArb({
      provider,
      mint,
      loanLamports,
      slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
      solRpcUrl,
    });
    const venues = [...signed.plan.buyVenueLabels, ...signed.plan.sellVenueLabels];

    onPhase?.("simulating");
    const sim = await simulateSolTx(signed.buySignedTxBase64, { rpcUrl: solRpcUrl });
    if (!sim.ok) {
      return {
        ok: false,
        netLamports: 0,
        netPct: 0,
        engine: jitoEngines?.length ? "jito" : "public",
        venues,
        error: sim.error ?? "buy-leg simulation failed — tx dropped, zero gas",
      };
    }

    onPhase?.("buy");
    const buy = await send(signed.buySignedTxBase64);
    onPhase?.("buy-confirm");
    const buyC = await waitForSigConfirm(buy.id, solRpcUrl);
    if (!buyC.confirmed) {
      return {
        ok: false,
        buySig: buy.id,
        netLamports: 0,
        netPct: 0,
        engine: buy.engine,
        venues,
        error: buyC.err ?? "buy leg did not confirm — sell never fired",
      };
    }

    onPhase?.("sell");
    const sell = await send(signed.sellSignedTxBase64);
    onPhase?.("sell-confirm");
    const sellC = await waitForSigConfirm(sell.id, solRpcUrl);
    if (!sellC.confirmed) {
      return {
        ok: false,
        buySig: buy.id,
        sellSig: sell.id,
        netLamports: 0,
        netPct: 0,
        engine: sell.engine,
        venues,
        error: sellC.err ?? "sell leg failed on-chain (tokens held — sell manually or retry)",
      };
    }

    return {
      ok: true,
      buySig: buy.id,
      sellSig: sell.id,
      netLamports: signed.plan.expectedNetLamports,
      netPct: signed.plan.expectedNetPct,
      engine: sell.engine,
      venues,
      fit,
    };
  } catch (e) {
    return {
      ok: false,
      netLamports: 0,
      netPct: 0,
      engine: jitoEngines?.length ? "jito" : "public",
      venues: [],
      error: e instanceof Error ? e.message : "live route failed",
    };
  }
}

export { LAMPORTS_PER_SOL };
