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
import {
  SOL_VAULT_MIN_SWAP_LAMPORTS,
  clusterPinVerdict,
  profitFloorVerdict,
  solProfitFloorLamports,
  solWalletRole,
  type SolWalletRole,
} from "./solana-policy";
import { fetchWithTimeout } from "./fetch-timeout";
import { redactRpcUrl } from "./redact";
import {
  SOL_RAIL_UNVERIFIED_MESSAGE,
  solSigningVerdict,
  type SolRailSettings,
} from "./sol-rail-gate";

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
// One Jupiter leg — build, tip (protected), gate, sign, submit, confirm
// ---------------------------------------------------------------------------

/** Structural copy of the jito module's simulation expectation (no type import). */
type LegExpectation = {
  accounts?: string[];
  maxLamportSpend?: bigint;
  minLamportGain?: bigint;
  maxComputeUnits?: number;
};

/**
 * Submit ONE Jupiter swap leg. Shared by the arb route and the sniper so the
 * Jito tip, the zero-gas simulation gate and confirmation are identical on
 * every path. The tip is attached to the UNSIGNED transaction: a signed
 * transaction cannot be modified afterwards, which is exactly how the relay
 * previously advertised a tip it never paid.
 */
async function submitJupiterLeg(opts: {
  quote: JupiterQuoteResponse;
  provider: SolSigningProvider;
  pubkey: string;
  slippageBps: number;
  priorityFeeMicroLamports?: number;
  solRpcUrl: string;
  jitoEngines?: string[];
  expectation?: LegExpectation;
}): Promise<
  | { ok: true; sig: string; engine: string }
  | { ok: false; engine: string; error: string }
> {
  const { addJitoTipToUnsignedTx, jitoSendProtectedTx, simulateSolTx, solSendPublicTx } =
    await import("./solana-jito");
  try {
    const built = await jupiterBuildSwapTransaction(opts.quote, {
      userPublicKey: opts.pubkey,
      slippageBps: opts.slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
    });
    let unsigned = built.swapTransaction;
    if (opts.jitoEngines && opts.jitoEngines.length > 0) {
      unsigned = (
        await addJitoTipToUnsignedTx(unsigned, {
          payer: opts.pubkey,
          rpcUrl: opts.solRpcUrl,
          engines: opts.jitoEngines,
        })
      ).txBase64;
    }

    // Verdict BEFORE the wallet prompt: a would-fail leg refuses without a
    // signature. A transport error is not a verdict — the post-sign gate runs.
    try {
      const pre = await simulateSolTx(unsigned, {
        rpcUrl: opts.solRpcUrl,
        expectation: opts.expectation,
      });
      if (!pre.ok) {
        return {
          ok: false,
          engine: "preflight-sim",
          error: pre.error ?? "pre-sign simulation failed — nothing was signed or spent",
        };
      }
    } catch {
      // No verdict available — sign and let the post-sign gate decide.
    }

    const signed = await walletSignBase64Tx(opts.provider, unsigned);
    const post = await simulateSolTx(signed, {
      rpcUrl: opts.solRpcUrl,
      expectation: opts.expectation,
    });
    if (!post.ok) {
      return { ok: false, engine: "sim", error: post.error ?? "simulation failed — zero gas spent" };
    }

    const sent =
      opts.jitoEngines && opts.jitoEngines.length > 0
        ? await jitoSendProtectedTx(signed, { bundleOnly: true, engines: opts.jitoEngines })
        : await solSendPublicTx(signed, { rpcUrl: opts.solRpcUrl });
    const confirm = await waitForSigConfirm(sent.id, opts.solRpcUrl);
    if (!confirm.confirmed) {
      return {
        ok: false,
        engine: sent.engine,
        error: confirm.err ?? "transaction did not confirm",
      };
    }
    return { ok: true, sig: sent.id, engine: sent.engine };
  } catch (e) {
    return {
      ok: false,
      engine: "none",
      error: e instanceof Error ? e.message : "swap leg failed",
    };
  }
}

/**
 * Pure realized-profit math: the wallet's SOL balance after the round trip
 * minus its balance before the buy. Network fees, priority fees, ATA rent and
 * the Jito tip are already reflected in the delta, so this is the number the
 * operator actually kept — not a re-quote.
 */
export function realizedNetLamports(
  initialLamports: number,
  finalLamports: number,
  principalLamports: number,
): { netLamports: number; netPct: number } {
  // No measurement, no profit: an unreadable balance must never be read as
  // "started at zero and gained everything".
  if (!Number.isFinite(initialLamports) || !Number.isFinite(finalLamports)) {
    return { netLamports: 0, netPct: 0 };
  }
  const initial = initialLamports;
  const final = finalLamports;
  const principal = Number.isFinite(principalLamports) ? principalLamports : 0;
  const netLamports = Math.round(final - initial);
  return {
    netLamports,
    netPct: principal > 0 ? (netLamports / principal) * 100 : 0,
  };
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
      // `getSignatureStatuses` answers an RpcResponse — `{ context, value }` —
      // with one entry per requested signature. Reading the result as a bare
      // array made `statuses[0]` undefined on every reply, so each landed
      // transaction was reported as "confirmation timeout" after the full wait.
      const json = await postRpc<{
        value?: Array<null | { err: unknown; confirmationStatus?: string }>;
      }>(rpcUrl, "getSignatureStatuses", [[sig], { searchHistory: true }]);
      const st = json?.value?.[0];
      if (st) {
        // The node's own failure object is the useful part of a reverted tx;
        // `String(err)` would have shown only "[object Object]".
        if (st.err) {
          const err = typeof st.err === "string" ? st.err : JSON.stringify(st.err);
          return { confirmed: false, err };
        }
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
    // `confirmed` matches the confirmation the execution path waits for; the
    // default (finalized) can lag a just-confirmed buy and look like zero.
    [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
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

/** Which verdict this is: affordable, genuinely short, or a failed read. */
export type BuyAffordabilityKind = "affordable" | "insufficient" | "unreadable";

export interface BuyAffordability {
  /**
   * The discriminant. `ok: false` alone never means "short" — branch on this
   * before formatting `shortfallLamports`, which is only measured when the
   * balance was actually read.
   */
  kind: BuyAffordabilityKind;
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
    kind: ok ? "affordable" : "insufficient",
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
 * Live native balance in lamports.
 *
 * `getBalance` answers `{ context, value }`, never a bare number. Reading it as
 * one is how a funded wallet looks empty: the affordability check saw 0 and
 * refused every live buy, the arb baseline threw "no numeric balance", and the
 * devnet card showed "unknown" for an armed wallet. One unwrapper, in the
 * module every execution path already imports.
 */
export async function fetchSolBalanceLamports(
  rpcUrl: string,
  owner: string,
): Promise<number> {
  const json = await postRpc<{ value?: number }>(rpcUrl, "getBalance", [
    owner,
    { commitment: "confirmed" },
  ]);
  const value = json?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("getBalance returned no numeric balance");
  }
  return value;
}

/**
 * REAL pre-flight: live getBalance (lamports) for the wallet owner, then the
 * pure affordability math. Never throws: an unreadable balance is its own
 * verdict ("could not be read"), never reported as insufficient funds, and an
 * insufficient balance is an `ok: false` verdict with the exact shortfall.
 */
export async function preflightSolBuyBalance(
  rpcUrl: string,
  owner: string,
  amountLamports: number,
  reserveLamports = BUY_FEE_RESERVE_LAMPORTS,
): Promise<BuyAffordability> {
  let balance: number;
  try {
    balance = await fetchSolBalanceLamports(rpcUrl, owner);
  } catch {
    // An unreadable balance is not "insufficient funds" — say which one it is,
    // or an operator tops up a wallet that was never the problem. Nothing was
    // measured here, so the measured fields stay at zero and `kind` carries the
    // meaning; a shortfall is only ever reported from a real read.
    return {
      kind: "unreadable",
      ok: false,
      balanceLamports: 0,
      amountLamports,
      reserveLamports,
      requiredLamports: amountLamports + reserveLamports,
      shortfallLamports: 0,
      // The endpoint is named, never quoted: provider keys live in these URLs.
      message: `getBalance could not be read, so the wallet's real balance is unknown — nothing was signed. Check the RPC (${redactRpcUrl(rpcUrl)}) and retry.`,
    };
  }
  return computeBuyAffordability(balance, amountLamports, reserveLamports);
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
  /**
   * The persisted engine settings. Signing is gated on them: this path only
   * signs Jupiter swaps, so an armed `solcontract` rail refuses here instead
   * of quietly signing a swap the operator did not select. Absent settings
   * refuse too — "not loaded" is never read as "Jupiter is armed".
   */
  railSettings?: SolRailSettings;
}): Promise<LiveSnipeBuyOutcome> {
  // OPEN path — it must be told which rail the operator armed. There is no
  // "assume Jupiter" fallback here: a missing settings object used to sign a
  // real swap on an engine the operator may not have selected.
  const rail = opts.railSettings;
  if (!rail) {
    return {
      ok: false,
      engine: "rail-gate",
      error: `Jupiter buy blocked — ${SOL_RAIL_UNVERIFIED_MESSAGE}. Nothing was signed or spent.`,
      venue: "Jupiter",
    };
  }
  const signing = solSigningVerdict({ ...rail, engine: "jupiter" });
  if (!signing.ok) {
    return { ok: false, engine: "rail-gate", error: signing.message, venue: "Jupiter" };
  }
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
      // A failed read is not a small wallet: fitting against a zero that was
      // never measured would clip the signal to nothing — or tell the operator
      // to top up a wallet that is already funded. Refuse with the read error.
      if (afford.kind === "unreadable") {
        return { ok: false, engine: "preflight-balance", error: afford.message, venue: "Jupiter" };
      }
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
    const { addJitoTipToUnsignedTx, simulateSolTx, jitoSendProtectedTx, solSendPublicTx } =
      await import("./solana-jito");
    // Jito only selects a bundle-only tx that pays a tip, and a signed tx can
    // no longer be modified — attach the tip to the unsigned bytes first.
    let unsignedTx = unsigned.swapTransaction;
    if (opts.jitoEngines && opts.jitoEngines.length > 0) {
      unsignedTx = (
        await addJitoTipToUnsignedTx(unsignedTx, {
          payer: pubkey,
          rpcUrl: opts.solRpcUrl,
          engines: opts.jitoEngines,
        })
      ).txBase64;
    }
    // PRE-FLIGHT 2 — zero-gas simulation of the EXACT unsigned tx against
    // live chain state BEFORE the wallet prompt: a would-fail swap (route
    // moved, ATA rent, slippage) is refused with the real on-chain failure
    // instead of a doomed Phantom "Failed to simulate" confirm dialog. A
    // transport-level sim error is NOT a verdict — execution continues and
    // the post-sign simulation gate still applies.
    try {
      const preSignSim = await simulateSolTx(unsignedTx, {
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
    const signedTxBase64 = await walletSignBase64Tx(provider, unsignedTx);

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
  /** Submission channel actually used (Jito engine or public RPC URL). */
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
  // EXIT path — deliberately takes no rail settings and consults no gate.
  // This function builds a Jupiter sell and nothing else, so "may this engine
  // sign?" has one possible answer here; the operator's armed rail must not
  // decide whether an existing position can be closed. A rail switch cannot
  // strand tokens on chain, and there is no setting an older client could send
  // to withhold a close. OPEN paths are the ones that must prove their rail
  // (see executeLiveSnipeBuy / executeLiveArb).
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
    const { addJitoTipToUnsignedTx, simulateSolTx, jitoSendProtectedTx, solSendPublicTx } =
      await import("./solana-jito");
    let unsignedTx = unsigned.swapTransaction;
    if (opts.jitoEngines && opts.jitoEngines.length > 0) {
      unsignedTx = (
        await addJitoTipToUnsignedTx(unsignedTx, {
          payer: pubkey,
          rpcUrl: opts.solRpcUrl,
          engines: opts.jitoEngines,
        })
      ).txBase64;
    }
    // Pre-sign zero-gas simulation — same refusal-before-prompt discipline
    // as the buy leg (wallet never opens for a would-fail exit). Transport
    // errors carry no verdict and fall through to the post-sign gate.
    try {
      const preSignSim = await simulateSolTx(unsignedTx, {
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
    const signedTxBase64 = await walletSignBase64Tx(provider, unsignedTx);

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
  /**
   * REALIZED net in lamports: the wallet's SOL balance after the sell minus
   * its balance before the buy. Fees, priority fee, ATA rent and any Jito tip
   * are already inside that delta, so this is what the operator actually kept.
   */
  netLamports: number;
  /** Realized net ROI against the clip that was deployed. */
  netPct: number;
  /** Quote-time expected net across both legs — for comparison, not profit. */
  quotedNetLamports?: number;
  /** Quote-time expected ROI. */
  quotedNetPct?: number;
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
  /** Which wallet signed: the in-app vault or a connected external wallet. */
  walletRole: SolWalletRole;
  /** The execution-time profit floor (lamports) this route was judged on. */
  floorLamports?: number;
  /** False when the post-buy exit quote netted below the floor. */
  floorMet?: boolean;
  /** False when the closing balance could not be read (netLamports is 0). */
  netMeasured?: boolean;
}

/**
 * Venue labels from a real Jupiter route plan (empty strings dropped).
 */
function routeLabels(quote: JupiterQuoteResponse): string[] {
  return (quote.routePlan ?? []).map((s) => s.swapInfo?.label ?? "").filter(Boolean);
}

/**
 * Execute a REAL two-leg live arb end-to-end with the connected wallet:
 * quote the buy → simulate → sign → submit (Jito protected when enabled) →
 * confirm → read the tokens actually received → quote/simulate/sign/submit the
 * sell for exactly that amount → confirm → measure the wallet's SOL delta.
 *
 * The sell is deliberately built AFTER the buy confirms. A pre-buy sell
 * simulation can only fail (the wallet does not hold the tokens yet), and the
 * old order therefore refused every fresh route after signing the buy. Profit
 * is reported from the post-sell balance, not from a re-quote.
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
  /**
   * Genesis hash the RPC must report before any quote or signature. When set,
   * a mismatched / unreadable hash refuses with both values (cluster pin).
   */
  expectedGenesis?: string;
  /** Execution-time profit floor as a percent of the deployed clip. */
  minProfitPct?: number;
  /** Absolute profit floor in lamports; the larger of this and the percent wins. */
  minProfitLamports?: number;
  /**
   * Minimum clip in lamports. Defaults to the vault floor (0.05 SOL) for a
   * vault-signed route and 0 for an external wallet.
   */
  minLoanLamports?: number;
  /**
   * Persisted engine settings. Checked BEFORE any quote or signature: the
   * arbitrage route only exists on the Jupiter rail today, so an operator who
   * armed `solcontract` must not receive a Jupiter-signed route from an older
   * client or a stale tab. Absent settings refuse as well — no fallback rail.
   */
  railSettings?: SolRailSettings;
  onPhase?: (phase: string) => void;
}): Promise<LiveArbOutcome> {
  // SIGNING GATE — before the signer lookup, the cluster pin, the baseline read
  // and the first wallet prompt. An engine that is not the armed rail never
  // reaches a key. OPEN path — same rule as the snipe buy: no settings means no
  // signing. `walletRole` is honestly unknown here because no wallet was read.
  const railRefusal = (error: string): LiveArbOutcome => ({
    ok: false,
    netLamports: 0,
    netPct: 0,
    engine: "rail-gate",
    venues: [],
    walletRole: "none",
    error,
  });
  const rail = opts.railSettings;
  if (!rail) {
    return railRefusal(
      `Jupiter route blocked — ${SOL_RAIL_UNVERIFIED_MESSAGE}. Nothing was signed or spent.`,
    );
  }
  const signing = solSigningVerdict({ ...rail, engine: "jupiter" });
  if (!signing.ok) return railRefusal(signing.message);

  const provider = await resolveLiveSigner(opts.provider);
  if (!provider?.publicKey) {
    return {
      ok: false,
      netLamports: 0,
      netPct: 0,
      engine: "none",
      venues: [],
      error: "no-wallet",
      walletRole: "none",
    };
  }
  const pubkey = provider.publicKey.toString();
  // The in-app vault is the VAULT wallet; a connected extension is EXTERNAL.
  // Only the vault carries the 0.05 SOL minimum clip below.
  const { vaultSignerAddresses } = await import("./solana-vault");
  const walletRole = solWalletRole(pubkey, vaultSignerAddresses());
  const { onPhase, solRpcUrl, jitoEngines, mint, slippageBps } = opts;
  const fail = (
    engine: string,
    error: string,
    extra: Partial<LiveArbOutcome> = {},
  ): LiveArbOutcome => ({
    ok: false,
    netLamports: 0,
    netPct: 0,
    engine,
    venues: [],
    walletRole,
    error,
    ...extra,
  });

  try {
    // ── CLUSTER PIN ── verify the RPC serves the pinned chain BEFORE any
    // quote or signature. A refused read is a refusal, not a pass.
    if (opts.expectedGenesis !== undefined) {
      onPhase?.("cluster");
      let observed: string | null = null;
      try {
        observed = await solRpcCall<string>(solRpcUrl, "getGenesisHash", []);
      } catch {
        observed = null;
      }
      const pin = clusterPinVerdict(opts.expectedGenesis, observed);
      if (!pin.ok) return fail("cluster-pin", pin.message);
    }

    // Balance pre-flight BEFORE the first wallet prompt: the route is refused
    // inline (exact shortfall numbers) when the wallet cannot cover the clip
    // plus fees/rent. With fitToWallet the clip shrinks instead.
    const afford = await preflightSolBuyBalance(solRpcUrl, pubkey, opts.loanLamports);
    let loanLamports = opts.loanLamports;
    let fit: LiveArbOutcome["fit"];
    if (!afford.ok) {
      // Same rule as the snipe buy: never fit a clip against an unmeasured balance.
      if (afford.kind === "unreadable") return fail("preflight-balance", afford.message);
      const walletFit = fitRouteLoanToWallet(afford.balanceLamports, opts.loanLamports);
      if (opts.fitToWallet && walletFit.ok) {
        loanLamports = walletFit.loanLamports;
        fit = { requestedLamports: opts.loanLamports, loanLamports };
        onPhase?.("fitted");
      } else {
        return fail("preflight-balance", opts.fitToWallet ? walletFit.message : afford.message);
      }
    }

    // Vault minimum clip — a vault-signed Jupiter swap below 0.05 SOL is
    // fee/rent noise, so it is refused with the exact numbers.
    const minLoan =
      opts.minLoanLamports ??
      (walletRole === "vault" ? SOL_VAULT_MIN_SWAP_LAMPORTS : 0);
    if (loanLamports < minLoan) {
      return fail(
        "min-clip",
        `Clip ${fmtSol(loanLamports)} SOL is below the ${fmtSol(minLoan)} SOL minimum for the ${walletRole} wallet — nothing was signed or spent.`,
      );
    }

    // REALIZED-PROFIT BASELINE — read before the buy, so the closing delta is
    // a measurement of this round trip rather than an estimate. A read
    // failure ABORTS: without a real starting balance the profit report would
    // be invented, and tokenBefore=0 would sell pre-existing holdings.
    onPhase?.("baseline");
    let initialSol: number;
    let tokenBefore: string;
    try {
      initialSol = await fetchSolBalanceLamports(solRpcUrl, pubkey);
      tokenBefore = await fetchTokenBalanceRaw(solRpcUrl, pubkey, mint);
    } catch (e) {
      const why = e instanceof Error ? e.message : "RPC read failed";
      return fail(
        "preflight-read",
        `Could not read the pre-trade baseline (${why}) — refusing to sign: without a measured starting balance the realised profit would be invented.`,
      );
    }

    onPhase?.("quoting");
    const buyQuote = await jupiterQuoteSolToToken(mint, loanLamports, slippageBps);
    const buyVenues = routeLabels(buyQuote);

    // ── EXECUTION-TIME PROFIT FLOOR ── price the exit against the buy output
    // before signing. The sell transaction is still built AFTER the buy (the
    // tokens do not exist yet), but this quote is exact enough to refuse a
    // route that cannot clear the floor.
    onPhase?.("floor");
    const floor = solProfitFloorLamports(
      loanLamports,
      opts.minProfitPct,
      opts.minProfitLamports,
    );
    let preSellQuote: JupiterQuoteResponse;
    try {
      preSellQuote = await jupiterQuoteTokenToSol(mint, buyQuote.outAmount, slippageBps);
    } catch (e) {
      const why = e instanceof Error ? e.message : "exit quote failed";
      return fail("profit-floor", `Could not price the exit leg (${why}) — nothing was signed.`, {
        venues: buyVenues,
      });
    }
    const preQuotedNet = Number(preSellQuote.outAmount) - Number(buyQuote.inAmount);
    const floorCheck = profitFloorVerdict(preQuotedNet, floor);
    if (!floorCheck.ok) {
      return fail("profit-floor", floorCheck.message, {
        quotedNetLamports: Math.round(preQuotedNet),
        quotedNetPct: loanLamports > 0 ? (preQuotedNet / loanLamports) * 100 : 0,
        floorLamports: floor.floorLamports,
        venues: [...buyVenues, ...routeLabels(preSellQuote)],
      });
    }

    onPhase?.("buy");
    const buy = await submitJupiterLeg({
      quote: buyQuote,
      provider,
      pubkey,
      slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
      solRpcUrl,
      jitoEngines,
      expectation: solBuySimExpectation(pubkey, loanLamports),
    });
    if (!buy.ok) return fail(buy.engine, buy.error, { venues: buyVenues });
    onPhase?.("buy-confirm");

    // Sell ONLY what this route bought: the delta over the pre-buy balance, so
    // an arb signal never liquidates tokens the wallet already held. An
    // unreadable balance aborts the sell rather than guessing an amount.
    let tokenAfter: string;
    try {
      tokenAfter = await fetchTokenBalanceRaw(solRpcUrl, pubkey, mint);
    } catch (e) {
      const why = e instanceof Error ? e.message : "token balance read failed";
      return fail(
        "read-after-buy",
        `Buy ${buy.sig.slice(0, 10)}… confirmed but the token balance could not be read (${why}) — not selling a guessed amount; the bought tokens are held, sell manually.`,
        { buySig: buy.sig, venues: buyVenues },
      );
    }
    const boughtRaw = BigInt(tokenAfter) - BigInt(tokenBefore);
    if (boughtRaw <= 0n) {
      return fail(
        "buy",
        `buy ${buy.sig.slice(0, 10)}… confirmed but no tokens arrived (balance ${tokenBefore} → ${tokenAfter}) — not selling existing holdings`,
        { buySig: buy.sig, venues: buyVenues },
      );
    }

    // Quote/simulate/sign the sell AFTER the buy lands, against tokens actually
    // held. The old order simulated it before the buy, when the balance was
    // still zero, so every fresh route refused after the buy was signed.
    onPhase?.("sell");
    const sellQuote = await jupiterQuoteTokenToSol(mint, boughtRaw.toString(), slippageBps);
    const venues = [...buyVenues, ...routeLabels(sellQuote)];
    // Re-check the floor on the exit quote for the tokens actually bought. The
    // position is still closed (holding it is worse than a thin exit), but the
    // outcome says plainly that the executed exit fell below the floor.
    const exitNet = Number(sellQuote.outAmount) - Number(buyQuote.inAmount);
    const floorMet = exitNet >= floor.floorLamports;
    const sell = await submitJupiterLeg({
      quote: sellQuote,
      provider,
      pubkey,
      slippageBps,
      priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
      solRpcUrl,
      jitoEngines,
      expectation: { accounts: [pubkey], maxComputeUnits: 1_400_000 },
    });
    if (!sell.ok) {
      return fail(
        sell.engine,
        `${sell.error} — buy ${buy.sig.slice(0, 10)}… landed and the bought tokens are held; sell manually`,
        { buySig: buy.sig, venues },
      );
    }
    onPhase?.("sell-confirm");

    // Closing balance — the realized number. A read failure is reported as an
    // unmeasured PnL (net 0), never as a fabricated gain; the sell did land.
    let measuredFinalSol: number | null = null;
    try {
      measuredFinalSol = await fetchSolBalanceLamports(solRpcUrl, pubkey);
    } catch {
      measuredFinalSol = null;
    }
    const realized = realizedNetLamports(
      initialSol,
      measuredFinalSol ?? initialSol,
      loanLamports,
    );
    return {
      ok: true,
      buySig: buy.sig,
      sellSig: sell.sig,
      netLamports: measuredFinalSol === null ? 0 : realized.netLamports,
      netPct: measuredFinalSol === null ? 0 : realized.netPct,
      netMeasured: measuredFinalSol !== null,
      quotedNetLamports: Math.round(exitNet),
      quotedNetPct: loanLamports > 0 ? (exitNet / loanLamports) * 100 : 0,
      engine: sell.engine,
      venues,
      fit,
      walletRole,
      floorLamports: floor.floorLamports,
      floorMet,
    };
  } catch (e) {
    return fail(
      jitoEngines?.length ? "jito" : "public",
      e instanceof Error ? e.message : "live route failed",
    );
  }
}

export { LAMPORTS_PER_SOL };
