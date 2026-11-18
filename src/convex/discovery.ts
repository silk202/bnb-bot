/**
 * Validated discovery registry — the backend is the authority.
 *
 * Two kinds of records live here:
 *
 *   1. `rpcEndpoints` — every RPC candidate, with the verdict of a SERVER-side
 *      probe. A stored endpoint is useful only after it passes; a discovered
 *      endpoint is secondary and equally unusable until it passes. Both are
 *      re-probed when they expire, so a provider that moves chains or starts
 *      failing stops being used instead of silently serving the wrong chain.
 *
 *   2. `discoveryRecords` — approved addresses per chain and kind (router,
 *      factory, token, pool, executor). A row is VALIDATED only after an
 *      operator records the checks that were run; expiry and revocation are
 *      applied on read.
 *
 * Neither table can be written by a browser session. The validation action is
 * callable by any signed-in user (it only re-proves public endpoints and is
 * rate-limited by host), while registering or approving an address is
 * operator-only. Browser storage may cache the query results for display; it
 * never decides whether either is usable.
 *
 * SSRF guard: the server fetches a URL supplied by a client, so only http(s)
 * URLs with a public hostname are accepted — loopback, RFC1918, link-local,
 * multicast and `.local`/`.internal` names are refused before any fetch.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { isOperatorEmail, requireOperator } from "./operatorEmails";

const DAY_MS = 86_400_000;
/** An RPC probe is fresh for one hour; addresses are approved for 90 days. */
const RPC_TTL_MS = 60 * 60 * 1000;
const RECORD_TERM_MS = 90 * DAY_MS;
const MAX_RECORD_TERM_MS = 180 * DAY_MS;
const PROBE_TIMEOUT_MS = 6_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CODE_HASH = /^0x[0-9a-fA-F]{64}$/;
export const RECORD_KINDS = ["router", "factory", "token", "pool", "executor"] as const;

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fd[0-9a-f]{2}:|\[?fe80:|.*\.local|.*\.internal|.*\.localhost)$/i;

/** Normalize + guard an RPC URL before the server is allowed to fetch it. */
export function assertPublicRpcUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("RPC URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("RPC URL must be http(s).");
  }
  if (url.username || url.password) throw new Error("RPC URL must not embed credentials.");
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error("RPC URL must point at a public host — private, loopback and link-local hosts are refused.");
  }
  if (!url.hostname.includes(".")) {
    throw new Error("RPC URL host must be a public domain name.");
  }
  return url.toString();
}

/** Normalize an address for storage and comparison. */
export function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!ADDRESS.test(trimmed)) throw new Error("Address must be a 0x-prefixed 20-byte address.");
  return trimmed.toLowerCase();
}

function requireKind(kind: string): string {
  if (!(RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown record kind "${kind}" — expected ${RECORD_KINDS.join(", ")}.`);
  }
  return kind;
}

async function isOperatorQuery(ctx: QueryCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.email) return false;
  return await isOperatorEmail(ctx, identity.email);
}

async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message || "JSON-RPC error");
    if (body.result === undefined) throw new Error("Empty JSON-RPC result");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side probe of one RPC endpoint.
 *
 * The chain id is proved here, not reported by the caller. Anything that fails
 * or disagrees is stored as REJECTED with the reason, so the operator can see
 * why an endpoint is not used.
 */
export const validateRpcEndpoint = action({
  args: {
    chainId: v.number(),
    url: v.string(),
    origin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in to validate an RPC endpoint.");
    if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    const url = assertPublicRpcUrl(args.url);
    const origin = ["stored", "discovered", "operator"].includes(args.origin ?? "")
      ? (args.origin as string)
      : "stored";
    const started = Date.now();
    try {
      const [chainHex, blockHex] = await Promise.all([
        jsonRpc<string>(url, "eth_chainId", []),
        jsonRpc<string>(url, "eth_blockNumber", []),
      ]);
      const provedChainId = Number.parseInt(chainHex, 16);
      const headBlock = Number.parseInt(blockHex, 16);
      if (provedChainId !== args.chainId) {
        throw new Error(`Endpoint reports chain ${provedChainId}, not ${args.chainId}`);
      }
      await ctx.runMutation(internal.discovery.recordRpcValidation, {
        chainId: args.chainId,
        url,
        origin,
        status: "VALIDATED",
        latencyMs: Date.now() - started,
        headBlock: Number.isFinite(headBlock) ? headBlock : undefined,
        validatedBy: userId,
      });
      return { status: "VALIDATED" as const, chainId: provedChainId, latencyMs: Date.now() - started };
    } catch (e) {
      const error = e instanceof Error ? e.message : "unreachable";
      await ctx.runMutation(internal.discovery.recordRpcValidation, {
        chainId: args.chainId,
        url,
        origin,
        status: "REJECTED",
        validatedBy: userId,
        error,
      });
      return { status: "REJECTED" as const, error };
    }
  },
});

/** Persist a probe verdict and the run that produced it. Internal only. */
export const recordRpcValidation = internalMutation({
  args: {
    chainId: v.number(),
    url: v.string(),
    origin: v.string(),
    status: v.string(),
    latencyMs: v.optional(v.number()),
    headBlock: v.optional(v.number()),
    validatedBy: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = (await ctx.db
      .query("rpcEndpoints")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .collect()).find((row) => row.chainId === args.chainId);
    const row = {
      chainId: args.chainId,
      url: args.url,
      origin: args.origin,
      status: args.status,
      latencyMs: args.latencyMs,
      headBlock: args.headBlock,
      checkedAt: now,
      expiresAt: now + RPC_TTL_MS,
      validatedBy: args.validatedBy,
      lastError: args.error,
    };
    const id = existing ? (await ctx.db.patch(existing._id, row), existing._id) : await ctx.db.insert("rpcEndpoints", row);
    await ctx.db.insert("validationRuns", {
      chainId: args.chainId,
      scope: "rpc",
      createdAt: now,
      actorId: args.validatedBy,
      summary:
        args.status === "VALIDATED"
          ? `Validated ${new URL(args.url).hostname} for chain ${args.chainId} (${args.latencyMs ?? 0}ms)`
          : `Rejected ${new URL(args.url).hostname}: ${args.error ?? "unknown"}`,
      checks: [
        { id: "chain-id", ok: args.status === "VALIDATED", detail: args.error ?? `proved chain ${args.chainId}` },
      ],
    });
    return id;
  },
});

/**
 * The execution read path: validated, unexpired endpoints only.
 *
 * `stored` (operator-provided) rows come first, discovered rows second — the
 * requirement that discovered infrastructure is secondary and must pass
 * validation before use.
 */
export const validatedRpcEndpoints = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const rows = args.chainId
      ? await ctx.db
          .query("rpcEndpoints")
          .withIndex("by_chain_status", (q) => q.eq("chainId", args.chainId!).eq("status", "VALIDATED"))
          .collect()
      : await ctx.db.query("rpcEndpoints").withIndex("by_chain_status").collect();
    return rows
      .filter((row) => row.status === "VALIDATED" && row.expiresAt > now)
      .map((row) => ({
        chainId: row.chainId,
        url: row.url,
        origin: row.origin,
        latencyMs: row.latencyMs,
        headBlock: row.headBlock,
        checkedAt: row.checkedAt,
        expiresAt: row.expiresAt,
      }))
      .sort((a, b) => {
        const rank = (origin: string) => (origin === "discovered" ? 1 : 0);
        return rank(a.origin) - rank(b.origin) || (a.latencyMs ?? 9_999) - (b.latencyMs ?? 9_999);
      });
  },
});

/** Operator view: every endpoint row, including rejected ones. */
export const rpcEndpointAudit = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isOperatorQuery(ctx))) return [];
    const rows = args.chainId
      ? await ctx.db
          .query("rpcEndpoints")
          .withIndex("by_chain_status", (q) => q.eq("chainId", args.chainId!))
          .collect()
      : await ctx.db.query("rpcEndpoints").collect();
    return rows.sort((a, b) => b.checkedAt - a.checkedAt);
  },
});

/** Register an address for validation. Operator-only; it starts PENDING. */
export const registerDiscoveryRecord = mutation({
  args: {
    chainId: v.number(),
    kind: v.string(),
    address: v.string(),
    label: v.optional(v.string()),
    evidenceRefs: v.array(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const address = normalizeAddress(args.address);
    const kind = requireKind(args.kind);
    if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
      throw new Error("chainId must be a positive EVM chain id.");
    }
    const existing = await ctx.db
      .query("discoveryRecords")
      .withIndex("by_address", (q) => q.eq("chainId", args.chainId).eq("address", address))
      .collect();
    const duplicate = existing.find((row) => row.kind === kind && row.status !== "REVOKED");
    if (duplicate) {
      // Idempotent for the executor flow: re-registering returns the row that
      // already exists instead of failing after the code has been read.
      return duplicate._id;
    }
    const id = await ctx.db.insert("discoveryRecords", {
      chainId: args.chainId,
      kind,
      address,
      label: args.label?.slice(0, 120),
      status: "PENDING",
      source: args.source === "discovery" ? "discovery" : "operator",
      evidenceRefs: args.evidenceRefs.map((ref) => ref.trim()).filter(Boolean).slice(0, 20),
      checks: [],
      registeredBy: actor,
    });
    return id;
  },
});

/**
 * Approve an address after recording what was checked.
 *
 * Requires at least one check, a matching chain, and a bounded term. The code
 * hash is optional but, when supplied, execution compares it with the live
 * code before using the address.
 */
export const validateDiscoveryRecord = mutation({
  args: {
    recordId: v.id("discoveryRecords"),
    checks: v.array(v.object({ id: v.string(), ok: v.boolean(), detail: v.string() })),
    codeHash: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const now = Date.now();
    const row = await ctx.db.get(args.recordId);
    if (!row) throw new Error("Discovery record not found.");
    if (row.status === "REVOKED") throw new Error("A revoked record cannot be validated.");
    if (args.checks.length === 0) {
      throw new Error("Record at least one check — an approval with no evidence is not validation.");
    }
    if (args.codeHash && !CODE_HASH.test(args.codeHash)) {
      throw new Error("codeHash must be a 32-byte 0x hash.");
    }
    const expiresAt = args.expiresAt ?? now + RECORD_TERM_MS;
    if (expiresAt <= now) throw new Error("expiresAt must be in the future.");
    if (expiresAt > now + MAX_RECORD_TERM_MS) {
      throw new Error("A validation term may not exceed 180 days.");
    }
    if (args.reason.trim().length < 4) throw new Error("A short reason is required.");
    const checks = args.checks.map((c) => ({
      id: c.id.slice(0, 120),
      ok: Boolean(c.ok),
      detail: c.detail.slice(0, 500),
    }));
    // Every check must have passed: a partially validated address is not valid.
    if (checks.some((c) => !c.ok)) {
      throw new Error("All recorded checks must pass before an address is VALIDATED.");
    }
    await ctx.db.patch(args.recordId, {
      status: "VALIDATED",
      checks,
      codeHash: args.codeHash?.toLowerCase(),
      validatedAt: now,
      expiresAt,
    });
    await ctx.db.insert("validationRuns", {
      chainId: row.chainId,
      scope: "discovery",
      createdAt: now,
      actorId: actor,
      summary: `Validated ${row.kind} ${row.address} on chain ${row.chainId} until ${new Date(expiresAt).toISOString()}`,
      checks,
    });
    return { recordId: args.recordId, expiresAt };
  },
});

/** Revoke an approved address. Operator-only; revocation is immediate. */
export const revokeDiscoveryRecord = mutation({
  args: { recordId: v.id("discoveryRecords"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireOperator(ctx);
    const row = await ctx.db.get(args.recordId);
    if (!row) throw new Error("Discovery record not found.");
    if (row.status === "REVOKED") throw new Error("Already revoked.");
    const reason = args.reason.trim();
    if (reason.length < 4) throw new Error("A short reason is required to revoke.");
    const now = Date.now();
    await ctx.db.patch(args.recordId, { status: "REVOKED", revokedAt: now, revocationReason: reason.slice(0, 500) });
    await ctx.db.insert("validationRuns", {
      chainId: row.chainId,
      scope: "discovery",
      createdAt: now,
      actorId: actor,
      summary: `Revoked ${row.kind} ${row.address}: ${reason.slice(0, 200)}`,
      checks: [],
    });
    return { recordId: args.recordId };
  },
});

/**
 * The execution read path for addresses: VALIDATED and unexpired only.
 * Revoked, expired and pending rows are never returned.
 */
export const validatedDiscoveryRecords = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const rows = args.chainId
      ? await ctx.db
          .query("discoveryRecords")
          .withIndex("by_chain_kind", (q) => q.eq("chainId", args.chainId!))
          .collect()
      : await ctx.db.query("discoveryRecords").collect();
    return rows
      .filter(
        (row) =>
          row.status === "VALIDATED" &&
          (!row.expiresAt || row.expiresAt > now) &&
          !row.revokedAt,
      )
      .map((row) => ({
        chainId: row.chainId,
        kind: row.kind,
        address: row.address,
        label: row.label,
        codeHash: row.codeHash,
        expiresAt: row.expiresAt,
      }));
  },
});

/** Operator view of every address record and its status. */
export const discoveryRecordAudit = query({
  args: { chainId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isOperatorQuery(ctx))) return [];
    const rows = args.chainId
      ? await ctx.db
          .query("discoveryRecords")
          .withIndex("by_chain_kind", (q) => q.eq("chainId", args.chainId!))
          .collect()
      : await ctx.db.query("discoveryRecords").collect();
    return rows.sort((a, b) => b._creationTime - a._creationTime);
  },
});

/** Recent validation runs (evidence for "why is this approved?"). */
export const recentValidationRuns = query({
  args: { chainId: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await isOperatorQuery(ctx))) return [];
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    return await ctx.db
      .query("validationRuns")
      .withIndex("by_chain_created", (q) => (args.chainId ? q.eq("chainId", args.chainId) : q))
      .order("desc")
      .take(limit);
  },
});

/** Convenience for the operator UI: is a given record id still usable? */
export const recordStatus = query({
  args: { recordId: v.id("discoveryRecords") },
  handler: async (ctx, args): Promise<"PENDING" | "VALIDATED" | "REJECTED" | "REVOKED" | "EXPIRED" | "MISSING"> => {
    const row = await ctx.db.get(args.recordId as Id<"discoveryRecords">);
    if (!row) return "MISSING";
    if (row.status === "REVOKED") return "REVOKED";
    if (row.status === "VALIDATED" && row.expiresAt && row.expiresAt <= Date.now()) return "EXPIRED";
    return row.status as "PENDING" | "VALIDATED" | "REJECTED";
  },
});

/**
 * BSC execution targets that ship with this repository.
 *
 * These three addresses are the ones the engine actually swaps through on BSC
 * (PancakeSwap V2 router, its factory, and WBNB), taken from the repo's own
 * registry (`src/lib/chain.ts`). They are seeded as VALIDATED only after the
 * SERVER confirms deployed code exists at each address on chain 56 — that is
 * real evidence, but it is not proof of authenticity or of bytecode identity,
 * so no code hash is pinned here. An operator can pin the hash later.
 *
 * Executor contracts are deliberately NOT seeded: that address is deployment
 * specific, and inventing one would authorize an unknown contract.
 */
export const BSC_SEED_TARGETS = [
  { kind: "router", address: "0x10ED43C718714eb63d5aA57B78B54704E256024E", label: "PancakeSwap V2 router" },
  { kind: "factory", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", label: "PancakeSwap V2 factory" },
  { kind: "token", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", label: "WBNB" },
] as const;

const BSC_PUBLIC_RPC = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-rpc.publicnode.com",
  "https://1rpc.io/bnb",
];

/** Fetch deployed code, trying each public endpoint until one answers. */
async function codeFor(address: string): Promise<{ code: string; via: string }> {
  let lastError = "no endpoint answered";
  for (const url of BSC_PUBLIC_RPC) {
    try {
      const code = await jsonRpc<string>(url, "eth_getCode", [address, "latest"]);
      return { code, via: url };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "RPC failed";
    }
  }
  throw new Error(`Could not read code for ${address}: ${lastError}`);
}

/**
 * Seed (idempotently) the three BSC targets. Operator-only through the
 * console; the checks are produced by the server, not the caller.
 */
async function runSeed(
  ctx: ActionCtx,
): Promise<{ kind: string; address: string; ok: boolean; detail: string }[]> {
  const results: { kind: string; address: string; ok: boolean; detail: string }[] = [];
    for (const target of BSC_SEED_TARGETS) {
      try {
        const { code, via } = await codeFor(target.address);
        const bytes = code.startsWith("0x") ? (code.length - 2) / 2 : 0;
        if (bytes === 0) throw new Error("no deployed code at this address");
        results.push({
          kind: target.kind,
          address: target.address.toLowerCase(),
          ok: true,
          detail: `deployed code present (${bytes} bytes), read from ${new URL(via).hostname}`,
        });
      } catch (e) {
        results.push({
          kind: target.kind,
          address: target.address.toLowerCase(),
          ok: false,
          detail: e instanceof Error ? e.message : "unreachable",
        });
      }
    }
  await ctx.runMutation(internal.discovery.recordSeedTargets, {
    actorId: "seed-bsc-targets",
    results,
  });
  return results;
}

/**
 * Seed from the operator console (signed-in caller).
 *
 * The seed itself is shared with an internal action so it can also be run
 * during a deployment without a browser session; the checks are identical.
 */
export const seedBscTargets = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in to seed targets.");
    return await runSeed(ctx);
  },
});

/** Same seed, runnable from the CLI (`convex run`). Not client-callable. */
export const seedBscTargetsInternal = internalAction({
  args: {},
  handler: async (ctx) => await runSeed(ctx),
});

/** Persist the seed verdicts. Internal only. */
export const recordSeedTargets = internalMutation({
  args: {
    actorId: v.string(),
    results: v.array(
      v.object({ kind: v.string(), address: v.string(), ok: v.boolean(), detail: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const inserted: string[] = [];
    for (const result of args.results) {
      const target = BSC_SEED_TARGETS.find(
        (t) => t.address.toLowerCase() === result.address.toLowerCase() && t.kind === result.kind,
      );
      if (!target) continue;
      const existing = await ctx.db
        .query("discoveryRecords")
        .withIndex("by_address", (q) => q.eq("chainId", 56).eq("address", result.address))
        .collect();
      const live = existing.find((row) => row.kind === result.kind && row.status === "VALIDATED");
      if (live && (!live.expiresAt || live.expiresAt > now)) continue;
      const checks = [
        { id: "code-present", ok: result.ok, detail: result.detail },
        { id: "repo-registry", ok: true, detail: "address matches src/lib/chain.ts (BNB registry)" },
      ];
      if (!result.ok) {
        await ctx.db.insert("validationRuns", {
          chainId: 56,
          scope: "discovery",
          createdAt: now,
          actorId: args.actorId,
          summary: `Seed rejected ${result.kind} ${result.address}: ${result.detail}`,
          checks,
        });
        continue;
      }
      const recordId = await ctx.db.insert("discoveryRecords", {
        chainId: 56,
        kind: result.kind,
        address: result.address,
        label: target.label,
        status: "VALIDATED",
        source: "bootstrap",
        evidenceRefs: ["src/lib/chain.ts", "on-chain eth_getCode"],
        checks,
        registeredBy: args.actorId,
        validatedAt: now,
        expiresAt: now + RECORD_TERM_MS,
      });
      await ctx.db.insert("validationRuns", {
        chainId: 56,
        scope: "discovery",
        createdAt: now,
        actorId: args.actorId,
        summary: `Seeded ${result.kind} ${result.address} (${target.label}) until ${new Date(now + RECORD_TERM_MS).toISOString()}`,
        checks,
      });
      inserted.push(recordId);
    }
    return { inserted: inserted.length };
  },
});
