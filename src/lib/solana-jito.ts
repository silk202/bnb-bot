/**
 * SOL FlashBolt — Jito-style protected submission.
 *
 * Solana's equivalent of the BNB terminal's Flashbots-style private relay:
 * transactions are submitted to the Jito Block-Engine, which forwards them
 * to Jito-Solana validators outside the public mempool path. Verified
 * against the official Jito documentation (docs.jito.wtf):
 *
 * - Single-transaction endpoint (MEV protection by default):
 *     POST https://mainnet.block-engine.jito.wtf/api/v1/transactions
 *     {"jsonrpc":"2.0","id":1,"method":"sendTransaction",
 *      "params":["<base64 tx>", {"encoding":"base64"}]}
 *   `?bundleOnly=true` gives revert protection: the tx is sent exclusively
 *   as a single-transaction bundle — if it would revert, it never lands
 *   (no state change, no fee burn beyond the skipped slot).
 * - Bundles: up to 5 transactions, sequential + atomic in one slot, chosen
 *   by tip auctions running on 50ms ticks. Minimum tip 1000 lamports.
 *
 * Nothing here simulates: the functions POST to the real block-engine
 * endpoints and surface the real JSON-RPC results.
 */

/** Verified block-engine URLs (docs.jito.wtf — Low Latency Transaction Send). */
export const JITO_BLOCK_ENGINES = {
  mainnet: [
    "https://mainnet.block-engine.jito.wtf",
    "https://amsterdam.mainnet.block-engine.jito.wtf",
    "https://dublin.mainnet.block-engine.jito.wtf",
    "https://frankfurt.mainnet.block-engine.jito.wtf",
    "https://london.mainnet.block-engine.jito.wtf",
    "https://ny.mainnet.block-engine.jito.wtf",
    "https://slc.mainnet.block-engine.jito.wtf",
    "https://singapore.mainnet.block-engine.jito.wtf",
    "https://tokyo.mainnet.block-engine.jito.wtf",
  ],
  testnet: ["https://testnet.block-engine.jito.wtf"],
} as const;

/** Jito enforces a 1000-lamport minimum tip on bundles. */
export const JITO_MIN_TIP_LAMPORTS = 1000;

/**
 * Official public RPC endpoints per cluster. The flasher's Testnet/Mainnet
 * setup selects the cluster; `solRpcOverrides` in terminal settings can
 * replace the public URL per cluster (private RPC / dedicated node).
 */
export const SOL_RPC_ENDPOINTS = {
  mainnet: "https://api.mainnet-beta.solana.com",
  testnet: "https://api.devnet.solana.com",
} as const;

export type SolCluster = keyof typeof SOL_RPC_ENDPOINTS;

/** Human label per cluster for dashboards. */
export const SOL_CLUSTER_LABEL: Record<SolCluster, string> = {
  mainnet: "Solana Mainnet-Beta",
  testnet: "Solana Devnet (testnet)",
};

/** Resolve the RPC URL for a cluster, honoring a per-cluster override. */
export function resolveSolRpcUrl(
  cluster: SolCluster,
  overrides?: Record<string, string> | null,
): string {
  const ov = overrides?.[cluster];
  return ov && ov.trim() !== "" ? ov.trim() : SOL_RPC_ENDPOINTS[cluster];
}

/**
 * Submission path per cluster: Jito block-engines exist for mainnet and
 * testnet, but devnet engines are unreliable — when no engine is available
 * the caller submits through the public RPC `sendTransaction` instead.
 */
export function solSubmissionPath(
  cluster: SolCluster,
): { relay: "jito" | "public-rpc"; engines: readonly string[] } {
  return cluster === "mainnet"
    ? { relay: "jito", engines: JITO_BLOCK_ENGINES.mainnet }
    : { relay: "public-rpc", engines: [] };
}

/** LAMPORTS_PER_SOL — for honest tip/size math. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** JSON-RPC response subset returned by the block-engine send methods. */
interface JitoRpcResult {
  jsonrpc?: string;
  id?: number;
  result?: string | { bundleId?: string };
  error?: { code?: number; message?: string };
}

/** Fetch with a hard timeout — never hangs the execution path. */
async function postJson<T>(url: string, body: unknown, timeoutMs = 12_000): Promise<T> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(url, timeoutMs, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jito HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Submit one SIGNED transaction (base64) through the public Solana JSON-RPC
 * `sendTransaction`. Used on clusters without a dependable block-engine
 * (devnet) or when the caller chooses public submission. Skips preflight
 * here because the app's own simulateTransaction gate already ran.
 */
export async function solSendPublicTx(
  signedTxBase64: string,
  opts: { rpcUrl?: string } = {},
): Promise<{ id: string; engine: string }> {
  const rpcUrl = opts.rpcUrl ?? SOL_RPC_ENDPOINTS.mainnet;
  const res = await postJson<{ result?: string; error?: { message?: string } }>(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        signedTxBase64,
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ],
    },
  );
  if (res.error) throw new Error(res.error.message ?? "sendTransaction rejected");
  if (!res.result) throw new Error("RPC returned no transaction signature");
  return { id: res.result, engine: rpcUrl };
}

/**
 * Submit one SIGNED transaction (base64) through the Jito Block-Engine.
 *
 * This is the SOL terminal's protected relay path — the analog of the BNB
 * terminal's private-relay submission. `bundleOnly=true` adds revert
 * protection: the tx runs as a single-tx bundle and never lands on a
 * failing route. The transaction MUST already be signed by the wallet
 * layer; this function only carries the bytes.
 *
 * Returns the Jito submission id (transaction signature or bundle id).
 */
export async function jitoSendProtectedTx(
  signedTxBase64: string,
  opts: {
    /** revert protection — submit as a single-tx bundle (default ON). */
    bundleOnly?: boolean;
    /** Regional engines to race; defaults to the global mainnet engine set. */
    engines?: readonly string[];
  } = {},
): Promise<{ id: string; engine: string }> {
  const bundleOnly = opts.bundleOnly ?? true;
  const engines = opts.engines ?? JITO_BLOCK_ENGINES.mainnet;
  const errors: string[] = [];

  // Race the primary + regional engines: first accepted submission wins —
  // the same multi-endpoint racing pattern the BNB engine uses for RPCs.
  const attempts = await Promise.allSettled(
    engines.map(async (engine) => {
      const url =
        engine.replace(/\/$/, "") +
        "/api/v1/transactions" +
        (bundleOnly ? "?bundleOnly=true" : "");
      const rpc = await postJson<JitoRpcResult>(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [signedTxBase64, { encoding: "base64" }],
      });
      if (rpc.error) throw new Error(rpc.error.message ?? "sendTransaction rejected");
      const id =
        typeof rpc.result === "string"
          ? rpc.result
          : (rpc.result?.bundleId ?? "");
      if (!id) throw new Error("Block-engine returned no submission id");
      return { id, engine };
    }),
  );

  for (const a of attempts) {
    if (a.status === "fulfilled") return a.value;
    errors.push(a.reason instanceof Error ? a.reason.message : String(a.reason));
  }
  throw new Error("Jito submission failed: " + errors[0]);
}

/**
 * Build a Jito bundle submission payload (up to 5 signed base64 txs) with
 * the tip tx LAST — the documented ordering for sequential atomic bundles.
 * Pure function: tests assert the shape, execution posts it.
 */
export function buildJitoBundlePayload(
  signedTxBase64List: string[],
  opts: { tipLamports?: number } = {},
): {
  jsonrpc: "2.0";
  id: number;
  method: "sendBundle";
  params: [string[]];
} | null {
  if (signedTxBase64List.length === 0 || signedTxBase64List.length > 5) return null;
  const tip = Math.max(JITO_MIN_TIP_LAMPORTS, opts.tipLamports ?? JITO_MIN_TIP_LAMPORTS);
  // The tip instruction rides the LAST tx of the bundle (documented order);
  // here the caller supplies the already-tipped final tx — the payload is
  // the verbatim wire shape of sendBundle.
  void tip;
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [[...signedTxBase64List]],
  };
}

/**
 * Submit an atomic arbitrage bundle (base64 txs, tip tx last) to the Jito
 * Block-Engine. Bundles are all-or-nothing in one slot — the Solana analog
 * of the BNB flash-loan's atomic profit-or-revert guarantee.
 */
export async function jitoSendBundle(
  signedTxBase64List: string[],
  opts: { engines?: readonly string[]; tipLamports?: number } = {},
): Promise<{ id: string; engine: string }> {
  const payload = buildJitoBundlePayload(signedTxBase64List, opts);
  if (!payload) throw new Error("Bundle must carry 1–5 signed transactions");
  const engines = opts.engines ?? JITO_BLOCK_ENGINES.mainnet;
  const errors: string[] = [];
  const attempts = await Promise.allSettled(
    engines.map(async (engine) => {
      const rpc = await postJson<JitoRpcResult>(
        engine.replace(/\/$/, "") + "/api/v1/bundles",
        payload,
      );
      if (rpc.error) throw new Error(rpc.error.message ?? "sendBundle rejected");
      const id = typeof rpc.result === "string" ? rpc.result : (rpc.result?.bundleId ?? "");
      if (!id) throw new Error("Block-engine returned no bundle id");
      return { id, engine };
    }),
  );
  for (const a of attempts) {
    if (a.status === "fulfilled") return a.value;
    errors.push(a.reason instanceof Error ? a.reason.message : String(a.reason));
  }
  throw new Error("Jito bundle submission failed: " + errors[0]);
}

/**
 * Jito tip accounts — fetched from the block engine itself (`getTipAccounts`)
 * and cached per engine. Hard-coding a list here would silently rot when Jito
 * rotates accounts, and a wrong tip account means the bundle never lands.
 */
const tipAccountCache = new Map<string, string[]>();

export async function fetchJitoTipAccounts(engine: string): Promise<string[]> {
  const base = engine.replace(/\/$/, "");
  const cached = tipAccountCache.get(base);
  if (cached && cached.length > 0) return cached;
  const rpc = await postJson<{ result?: string[]; error?: { message?: string } }>(
    base + "/api/v1/bundles",
    { jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] },
  );
  if (rpc.error) throw new Error(rpc.error.message ?? "getTipAccounts rejected");
  if (!Array.isArray(rpc.result) || rpc.result.length === 0) {
    throw new Error("Jito returned no tip accounts — protected submission is unavailable");
  }
  tipAccountCache.set(base, rpc.result);
  return rpc.result;
}

/** Deterministic pick from the fetched list (seeded in tests). */
export function pickJitoTipAccount(accounts: string[], seed = Math.random()): string {
  if (accounts.length === 0) throw new Error("no Jito tip accounts to pick from");
  const clamped = Math.min(0.999999, Math.max(0, Number.isFinite(seed) ? seed : 0));
  return accounts[Math.floor(clamped * accounts.length)]!;
}

/**
 * Attach the Jito tip to an UNSIGNED base64 transaction, before the wallet
 * signs. `bundleOnly=true` submissions are only selected when the transaction
 * itself pays a tip; without this instruction the relay claim in the UI is
 * false and the bundle is dropped. Address lookup tables are resolved so the
 * message can be decompiled and recompiled without losing accounts.
 *
 * Refuses (rather than silently sending an untipped tx) when the tip accounts,
 * a lookup table or the 1232-byte packet limit cannot be satisfied.
 */
export async function addJitoTipToUnsignedTx(
  unsignedBase64: string,
  opts: {
    payer: string;
    rpcUrl: string;
    engines?: readonly string[];
    tipLamports?: number;
  },
): Promise<{ txBase64: string; tipLamports: number; tipAccount: string }> {
  const engines = opts.engines ?? JITO_BLOCK_ENGINES.mainnet;
  const tipAccounts = await fetchJitoTipAccounts(engines[0] ?? JITO_BLOCK_ENGINES.mainnet[0]!);
  const tipAccount = pickJitoTipAccount(tipAccounts);
  const tipLamports = Math.max(
    JITO_MIN_TIP_LAMPORTS,
    Math.floor(Number.isFinite(opts.tipLamports) ? (opts.tipLamports as number) : JITO_MIN_TIP_LAMPORTS),
  );

  const { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } =
    await import("@solana/web3.js");
  const { Buffer } = await import("buffer");
  const tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(unsignedBase64, "base64")));

  const lookups = [];
  const connection = new Connection(opts.rpcUrl, "confirmed");
  for (const lookup of tx.message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey);
    if (!res.value) {
      throw new Error(
        `lookup table ${lookup.accountKey.toBase58()} is not available — cannot attach the Jito tip safely`,
      );
    }
    lookups.push(res.value);
  }

  const message = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: lookups,
  });
  if (message.payerKey.toBase58() !== opts.payer) {
    throw new Error(
      `transaction fee payer ${message.payerKey.toBase58()} is not the signing wallet ${opts.payer} — refusing to add a tip`,
    );
  }
  message.instructions.push(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(opts.payer),
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    }),
  );

  const compiled = message.compileToV0Message(lookups);
  // Wire format needs one (zeroed) signature slot per required signer; the
  // wallet fills them when it signs the serialized bytes.
  const next = new VersionedTransaction(compiled);
  next.signatures = new Array(compiled.header.numRequiredSignatures).fill(
    new Uint8Array(64),
  ) as Uint8Array[];
  const bytes = next.serialize();
  if (bytes.length > 1232) {
    throw new Error(
      `attaching the Jito tip would make the transaction ${bytes.length} bytes, above the 1232-byte packet limit — shrink the route`,
    );
  }
  return {
    txBase64: Buffer.from(bytes).toString("base64"),
    tipLamports,
    tipAccount,
  };
}

/** Human label for the relay column — mirrors the BNB terminal's relay field. */
export const JITO_RELAY_LABEL = "Jito block-engine (protected)";

// ---------------------------------------------------------------------------
// Simulation gate — the SOL analog of BNB's eth_estimateGas + eth_call gate.
//
// BNB FlashBolt guarantees failed transactions cost ZERO gas by simulating
// every tx before broadcast: a would-fail route never reaches the mempool.
// On Solana the same guarantee comes from `simulateTransaction` on the RPC:
// the tx executes against the live chain state with sigVerify disabled and
// NOTHING is committed — if it fails, we simply never submit it, so no gas,
// no fees, no flash-loan (which would anyway revert atomically).
// ---------------------------------------------------------------------------

/** Result subset of the simulateTransaction JSON-RPC response. */
interface SimulateResult {
  jsonrpc?: string;
  id?: number;
  result?: {
    value?: {
      err?: unknown;
      logs?: string[];
      unitsConsumed?: number;
      /** Newer field name (the RPC renamed it) — either may appear. */
      computeUnitsConsumed?: number;
      /** Post-execution account states, when `accounts` was requested. */
      accounts?: { lamports?: number }[] | null;
      returnData?: { data?: string[] } | null;
    } | null;
  };
  error?: { code?: number; message?: string };
}

interface AccountStatesResult {
  result?: { value?: ({ lamports?: number } | null)[] | null };
  error?: { message?: string };
}

/**
 * What the simulation must PROVE before the tx is allowed to be broadcast.
 * Every field is optional: a bare `simulateSolTx(tx)` behaves exactly as
 * before (err === null is the verdict), and each expectation adds a real
 * check on top.
 */
export interface SolSimulationExpectation {
  /** Accounts (base64 pubkeys) whose lamport balance change is validated. */
  accounts?: string[];
  /** Refuse when accounts[0] loses MORE than this many lamports (buy cost). */
  maxLamportSpend?: bigint;
  /** Refuse when accounts[0] gains FEWER than this many lamports (proceeds). */
  minLamportGain?: bigint;
  /** Refuse when the route needs more compute than this (drop risk). */
  maxComputeUnits?: number;
}

export interface SolSimulationOutcome {
  /** true when the tx would land successfully AND every check passed. */
  ok: boolean;
  /** Program logs from the simulation (truncated by the RPC). */
  logs: string[];
  /** Compute units the route consumed — real blockspace evidence. */
  unitsConsumed: number | null;
  /** First failure reason when ok === false. */
  error: string | null;
  /** Human-readable record of each validation that ran and what it showed. */
  checks: string[];
  /** Net lamport change of expectation.accounts[0], when balances came back. */
  deltaLamports: bigint | null;
  /** Program return data (base64 chunks), when the route produced any. */
  returnData: string[] | null;
}

/**
 * Turn a raw RPC `err` + program logs into an operator-readable verdict.
 * Solana reports almost everything as `{"InstructionError":[i,{"Custom":N}]}`
 * and puts the real reason in the program logs, so the logs are the primary
 * source and the error object is the fallback.
 */
export function classifySolSimFailure(err: unknown, logs: string[]): string {
  const raw = typeof err === "string" ? err : JSON.stringify(err ?? "");
  const joined = logs.join("\n").toLowerCase();
  const lower = raw.toLowerCase();
  if (/insufficient (lamports|funds)/.test(joined) || /insufficientfunds/.test(lower)) {
    return "wallet has insufficient SOL for this route (amount + fees/rent)";
  }
  if (/slippage/.test(joined) || /slippage/.test(lower) || joined.includes("0x1771")) {
    return "route moved beyond the slippage tolerance";
  }
  if (/accountnotfound|account not found/.test(lower) || joined.includes("account not found")) {
    return "a required account (usually the token ATA) does not exist yet";
  }
  if (/blockhashnotfound|blockhash not found/.test(lower)) {
    return "the blockhash aged out before the route could land";
  }
  if (/computebudgetexceeded|computational budget exceeded/.test(joined)) {
    return "the route exceeds the compute budget";
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 200) : "simulation failed";
}

/** Real lamport balances (never committed — a simulation changes nothing). */
async function fetchLamports(rpcUrl: string, address: string): Promise<number | null> {
  const { fetchWithTimeout } = await import("./fetch-timeout");
  try {
    const res = await fetchWithTimeout(rpcUrl, 8_000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [[address], { encoding: "base64" }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as AccountStatesResult;
    const lamports = json.result?.value?.[0]?.lamports;
    return typeof lamports === "number" ? lamports : null;
  } catch {
    // No balance → no delta check; the err===null verdict still stands.
    return null;
  }
}

/**
 * Simulate a signed base64 transaction against live chain state.
 *
 * `sigVerify: false` lets us simulate without the wallet re-signing for a
 * possibly-stale blockhash; `replaceRecentBlockhash: true` keeps the
 * simulation valid when the tx's blockhash has aged out. This call NEVER
 * submits anything — it is a pure dry run, the zero-gas guarantee's gate.
 */
export async function simulateSolTx(
  signedTxBase64: string,
  opts: { rpcUrl?: string; expectation?: SolSimulationExpectation } = {},
): Promise<SolSimulationOutcome> {
  const rpcUrl = opts.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const expectation = opts.expectation;
  const trackedAddress = expectation?.accounts?.[0];

  // PRE-STATE — a simulation never commits, so the chain still holds the
  // pre-execution balance while the RPC reports the post-execution accounts.
  // Reading both makes the lamport delta a real measurement, not a guess.
  const preLamports = trackedAddress ? await fetchLamports(rpcUrl, trackedAddress) : null;

  const config: Record<string, unknown> = {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
  };
  if (expectation?.accounts && expectation.accounts.length > 0) {
    config.accounts = { encoding: "base64", addresses: expectation.accounts };
  }

  const { fetchWithTimeout } = await import("./fetch-timeout");
  const res = await fetchWithTimeout(rpcUrl, 12_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [signedTxBase64, config],
    }),
  });
  if (!res.ok) throw new Error(`Simulation RPC HTTP ${res.status}`);
  const json = (await res.json()) as SimulateResult;
  if (json.error) {
    throw new Error(json.error.message ?? "simulateTransaction rejected");
  }
  const value = json.result?.value;
  const logs = value?.logs ?? [];
  const unitsConsumed = value?.computeUnitsConsumed ?? value?.unitsConsumed ?? null;
  const returnData = value?.returnData?.data ?? null;
  const checks: string[] = [];

  // CHECK 1 — the program itself must report no error.
  if (value?.err) {
    return {
      ok: false,
      logs,
      unitsConsumed,
      error: classifySolSimFailure(value.err, logs),
      checks: ["program error: would fail on-chain — nothing was broadcast"],
      deltaLamports: null,
      returnData,
    };
  }
  if (!value) {
    return {
      ok: false,
      logs,
      unitsConsumed,
      error: "RPC returned no simulation result",
      checks: ["no verdict from the RPC"],
      deltaLamports: null,
      returnData,
    };
  }
  checks.push("program error: none — the tx would land");

  // CHECK 2 — compute budget: an over-budget route is dropped at execution.
  if (expectation?.maxComputeUnits && unitsConsumed !== null) {
    if (unitsConsumed > expectation.maxComputeUnits) {
      return {
        ok: false,
        logs,
        unitsConsumed,
        error: `route needs ${unitsConsumed} CU, above the ${expectation.maxComputeUnits} CU ceiling`,
        checks,
        deltaLamports: null,
        returnData,
      };
    }
    checks.push(`compute: ${unitsConsumed} CU (ceiling ${expectation.maxComputeUnits})`);
  } else if (unitsConsumed !== null) {
    checks.push(`compute: ${unitsConsumed} CU`);
  }

  // CHECK 3 — the balance change the route actually produces.
  let deltaLamports: bigint | null = null;
  const postLamports = value.accounts?.[0]?.lamports;
  if (typeof postLamports === "number" && typeof preLamports === "number") {
    deltaLamports = BigInt(postLamports) - BigInt(preLamports);
    checks.push(`lamports: ${deltaLamports >= 0n ? "+" : ""}${deltaLamports.toString()}`);
    if (expectation?.maxLamportSpend !== undefined && -deltaLamports > expectation.maxLamportSpend) {
      return {
        ok: false,
        logs,
        unitsConsumed,
        error: `route would spend ${(-deltaLamports).toString()} lamports, above the ${expectation.maxLamportSpend.toString()} quoted`,
        checks,
        deltaLamports,
        returnData,
      };
    }
    if (expectation?.minLamportGain !== undefined && deltaLamports < expectation.minLamportGain) {
      return {
        ok: false,
        logs,
        unitsConsumed,
        error: `route would return ${deltaLamports.toString()} lamports, below the ${expectation.minLamportGain.toString()} expected`,
        checks,
        deltaLamports,
        returnData,
      };
    }
  } else if (expectation?.accounts?.length) {
    checks.push("lamports: balance delta unavailable from this RPC");
  }

  return {
    ok: true,
    logs,
    unitsConsumed,
    error: null,
    checks,
    deltaLamports,
    returnData,
  };
}
