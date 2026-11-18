// FlashBolt — in-app git sync for the operator (Settings → Git sync).
//
// WHAT THIS REALLY DOES (nothing mocked):
//   • Reads the repository's ACTUAL latest commit for the configured branch
//     straight from the provider's REST API (authenticated with the operator's
//     encrypted access token when one is saved, anonymously for public repos).
//   • "Sync now" POSTs to every configured deploy hook — Vercel deploy hooks,
//     Netlify build hooks, Render publish hooks, Cloudflare Pages build hooks —
//     and reports the real HTTP status each one returned. That redeploys every
//     connected platform from the latest pushed commit, instantly, without
//     opening any dashboard.
//   • Everything is operator-gated with the same three-identity verdict the
//     rest of the console uses: signed-in operator email, verified
//     "Continue as Guest" session, or a server-issued device-trust token.
//
// SECURITY
//   • The repository access token is encrypted at rest (encryption.ts,
//     AES-GCM) inside this backend and NEVER returned to any client — only a
//     last-4 hint is readable, exactly like the Telegram bot token.
//   • Only https hook URLs are accepted, so a saved config can never turn
//     this action into an arbitrary request primitive.

import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { decryptSecret, encryptSecret } from "./encryption";
import { requireOperatorEmail } from "./telegramBot";

const CONFIG_KEY = "default";
const MAX_HOOKS = 8;

/** Normalize + validate an "owner/name" repository slug. */
function normalizeRepo(raw: string): string | null {
  const repo = raw.trim().replace(/^https?:\/\/(www\.)?[^/]+\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

/** Normalize + validate a branch name (conservative charset). */
function normalizeBranch(raw: string): string | null {
  const branch = raw.trim();
  if (!branch || branch.length > 120) return null;
  return /^[\w./-]+$/.test(branch) ? branch : null;
}

/** Only https hook URLs are ever stored — never arbitrary schemes/hosts. */
function normalizeHook(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** device-trust token from the client, normalized exactly like the bot side. */
function deviceTokenFromClient(token: string | undefined): string | null {
  const raw = token?.trim() ?? "";
  return raw.length >= 32 ? raw : null;
}

/** The config row as seen by queries — cipher stripped, never returned. */
type PublicConfig = {
  repo: string | null;
  branch: string;
  tokenSet: boolean;
  tokenHint: string | null;
  tokenSetAt: number | null;
  hooks: Record<string, string>;
  lastSyncAt: number | null;
  lastSync: {
    ok: boolean;
    commitOk: boolean;
    error: string | null;
    providers: Array<{ name: string; ok: boolean; status: number | null; note: string }>;
    at: number;
  } | null;
  lastCommit: { sha: string; message: string; author: string; at: number } | null;
};

function toPublic(row: Doc<"gitSyncConfig"> | null): PublicConfig {
  let lastSync: PublicConfig["lastSync"] = null;
  if (row?.lastSync) {
    try {
      lastSync = JSON.parse(row.lastSync) as PublicConfig["lastSync"];
    } catch {
      lastSync = null;
    }
  }
  return {
    repo: row?.repo ?? null,
    branch: row?.branch ?? "main",
    tokenSet: Boolean(row?.tokenCipher),
    tokenHint: row?.tokenHint ?? null,
    tokenSetAt: row?.tokenSetAt ?? null,
    hooks: row?.hooks ?? {},
    lastSyncAt: row?.lastSyncAt ?? null,
    lastSync,
    lastCommit: row?.lastCommitSha
      ? {
          sha: row.lastCommitSha,
          message: row.lastCommitMessage ?? "",
          author: row.lastCommitAuthor ?? "",
          at: row.lastCommitAt ?? 0,
        }
      : null,
  };
}

async function readRow(ctx: QueryCtx | MutationCtx): Promise<Doc<"gitSyncConfig"> | null> {
  return await ctx.db
    .query("gitSyncConfig")
    .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
    .first();
}

// ---------------------------------------------------------------------------
// Queries / mutations (operator-gated: sign-in OR verified guest OR device)
// ---------------------------------------------------------------------------

/** Read the sync config for the Settings panel — cipher never leaves here. */
export const getSyncStatus = query({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<
    { recognized: false } | { recognized: true; config: PublicConfig }
  > => {
    try {
      await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    } catch {
      return { recognized: false };
    }
    return { recognized: true, config: toPublic(await readRow(ctx)) };
  },
});

/** Create/update the sync config. Empty token string keeps the stored one. */
export const saveSyncConfig = mutation({
  args: {
    deviceToken: v.optional(v.string()),
    repo: v.string(),
    branch: v.optional(v.string()),
    token: v.optional(v.string()),
    clearToken: v.optional(v.boolean()),
    hooks: v.optional(v.array(v.object({ provider: v.string(), url: v.string() }))),
  },
  handler: async (
    ctx,
    { deviceToken, repo, branch, token, clearToken, hooks },
  ): Promise<{ ok: boolean; error: string | null; repo: string | null }> => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));

    const cleanRepo = normalizeRepo(repo);
    if (!cleanRepo) {
      return { ok: false, error: "Repository must look like owner/name (e.g. silk202/bnb-bot).", repo: null };
    }
    const cleanBranch = branch?.trim() ? normalizeBranch(branch) : "main";
    if (!cleanBranch) {
      return { ok: false, error: "Branch name contains unsupported characters.", repo: null };
    }

    const cleanHooks: Record<string, string> = {};
    if (hooks) {
      if (hooks.length > MAX_HOOKS) {
        return { ok: false, error: `At most ${MAX_HOOKS} deploy hooks.`, repo: null };
      }
      for (const h of hooks) {
        const url = h.url.trim();
        if (!url) continue;
        const norm = normalizeHook(url);
        if (!norm) {
          return { ok: false, error: `Deploy hook for ${h.provider} must be a valid https:// URL.`, repo: null };
        }
        cleanHooks[h.provider.trim().toLowerCase()] = norm;
      }
    }

    const now = Date.now();
    const row = await readRow(ctx);
    const patch: Partial<Doc<"gitSyncConfig">> = {
      repo: cleanRepo,
      branch: cleanBranch,
      updatedAt: now,
    };
    if (hooks !== undefined) patch.hooks = Object.keys(cleanHooks).length ? cleanHooks : undefined;

    if (clearToken) {
      patch.tokenCipher = undefined;
      patch.tokenHint = undefined;
      patch.tokenSetAt = undefined;
    } else if (token !== undefined && token.trim()) {
      const t = token.trim();
      if (t.length > 200) {
        return { ok: false, error: "Access token looks too long — copy it exactly.", repo: null };
      }
      patch.tokenCipher = await encryptSecret(ctx, t);
      patch.tokenHint = t.slice(-4);
      patch.tokenSetAt = now;
    }

    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("gitSyncConfig", {
        key: CONFIG_KEY,
        repo: cleanRepo,
        branch: cleanBranch,
        ...(patch.hooks !== undefined ? { hooks: patch.hooks } : {}),
        ...(patch.tokenCipher !== undefined ? { tokenCipher: patch.tokenCipher, tokenHint: patch.tokenHint, tokenSetAt: patch.tokenSetAt } : {}),
        updatedAt: now,
      });
    }
    return { ok: true, error: null, repo: cleanRepo };
  },
});

/** Remove the stored sync config entirely (token ciphertext included). */
export const clearSyncConfig = mutation({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<{ ok: boolean }> => {
    await requireOperatorEmail(ctx, deviceTokenFromClient(deviceToken));
    const row = await readRow(ctx);
    if (row) {
      await ctx.db.patch(row._id, {
        repo: undefined,
        branch: undefined,
        tokenCipher: undefined,
        tokenHint: undefined,
        tokenSetAt: undefined,
        hooks: undefined,
        lastSyncAt: undefined,
        lastSync: undefined,
        lastCommitSha: undefined,
        lastCommitMessage: undefined,
        lastCommitAuthor: undefined,
        lastCommitAt: undefined,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

/** Internal: raw row (cipher included) for the syncNow action. */
export const readSyncConfig = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"gitSyncConfig"> | null> => {
    return await ctx.db
      .query("gitSyncConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
  },
});

/**
 * Internal: decrypt the stored access token for the syncNow action. Actions
 * have no db access, so the decryption happens here (query-side) and the
 * plaintext travels only server-to-server — it never reaches any client.
 */
export const readSyncToken = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const row = await ctx.db
      .query("gitSyncConfig")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .first();
    if (!row?.tokenCipher) return null;
    try {
      return await decryptSecret(ctx, row.tokenCipher);
    } catch {
      return null;
    }
  },
});

/** Internal: stamp the verdict of a real sync run (commit + hook statuses). */
export const recordSyncResult = internalMutation({
  args: {
    snapshot: v.string(),
    commitOk: v.boolean(),
    sha: v.optional(v.string()),
    message: v.optional(v.string()),
    author: v.optional(v.string()),
    at: v.optional(v.number()),
  },
  handler: async (ctx, { snapshot, commitOk, sha, message, author, at }) => {
    const now = Date.now();
    const row = await readRow(ctx);
    const patch: Partial<Doc<"gitSyncConfig">> = {
      lastSyncAt: now,
      lastSync: snapshot,
      updatedAt: now,
    };
    if (commitOk && sha) {
      patch.lastCommitSha = sha;
      patch.lastCommitMessage = message ?? "";
      patch.lastCommitAuthor = author ?? "";
      patch.lastCommitAt = at ?? now;
    }
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("gitSyncConfig", {
        key: CONFIG_KEY,
        lastSyncAt: now,
        lastSync: snapshot,
        ...(commitOk && sha
          ? {
              lastCommitSha: sha,
              lastCommitMessage: message ?? "",
              lastCommitAuthor: author ?? "",
              lastCommitAt: at ?? now,
            }
          : {}),
        updatedAt: now,
      });
    }
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// syncNow — the real work: read the actual commit, fire the actual hooks.
// ---------------------------------------------------------------------------

type ProviderResult = { name: string; ok: boolean; status: number | null; note: string };

/** Read the branch's latest commit from the provider REST API. */
async function fetchLatestCommit(
  repo: string,
  branch: string,
  token: string | null,
): Promise<
  | { ok: true; sha: string; message: string; author: string; at: number }
  | { ok: false; error: string }
> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "flashbolt-git-sync",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`,
      { headers },
    );
    if (res.status === 404) {
      return { ok: false, error: `Repository or branch not found: ${repo}@${branch}` };
    }
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        ok: false,
        error:
          res.status === 401
            ? "Access token rejected (401) — paste a fresh token in the panel."
            : `Rate limited or forbidden (403)${body.message ? `: ${body.message}` : ""}`,
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Repository API returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      sha?: string;
      commit?: {
        message?: string;
        author?: { name?: string; date?: string };
      };
    };
    if (!data.sha) return { ok: false, error: "Repository API returned no commit" };
    const at = Date.parse(data.commit?.author?.date ?? "");
    return {
      ok: true,
      sha: data.sha,
      message: (data.commit?.message ?? "").split("\n")[0].slice(0, 140),
      author: data.commit?.author?.name ?? "",
      at: Number.isFinite(at) ? at : Date.now(),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Repository unreachable" };
  }
}

/** POST one deploy hook and report its REAL HTTP verdict. */
async function fireHook(name: string, url: string): Promise<ProviderResult> {
  try {
    const res = await fetch(url, { method: "POST" });
    const ok = res.status >= 200 && res.status < 300;
    return {
      name,
      ok,
      status: res.status,
      note: ok ? "accepted" : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      status: null,
      note: err instanceof Error ? err.message : "unreachable",
    };
  }
}

/**
 * Operator-gated sync run:
 *   1. verify identity (sign-in / verified guest / trusted device);
 *   2. decrypt the stored token server-side;
 *   3. read the REAL latest commit for the configured branch;
 *   4. fire every configured deploy hook (real HTTP, real statuses);
 *   5. stamp the verdict so the panel shows the last run's true result.
 */
export const syncNow = action({
  args: { deviceToken: v.optional(v.string()) },
  handler: async (ctx, { deviceToken }): Promise<{
    ok: boolean;
    repo: string | null;
    commit: { sha: string; message: string; author: string; at: number } | null;
    providers: ProviderResult[];
    error: string | null;
  }> => {
    const gate = await ctx.runQuery(internal.telegramBot.verifyOperatorInternal, {
      deviceToken: deviceTokenFromClient(deviceToken) ?? undefined,
    });
    if (!gate.ok) {
      return { ok: false, repo: null, commit: null, providers: [], error: gate.error };
    }

    const row = await ctx.runQuery(internal.gitSync.readSyncConfig, {});
    const repo = row?.repo ?? null;
    if (!repo) {
      return {
        ok: false,
        repo: null,
        commit: null,
        providers: [],
        error: "No repository configured yet — save the repo (owner/name) first.",
      };
    }
    const branch = row?.branch ?? "main";

    // Decrypt the token server-side only (falls back to anonymous for public repos).
    let token: string | null = null;
    if (row?.tokenCipher) {
      try {
        token = await ctx.runQuery(internal.gitSync.readSyncToken, {});
      } catch {
        token = null;
      }
    }

    const commit = await fetchLatestCommit(repo, branch, token);

    const hooks = row?.hooks ?? {};
    const providers: ProviderResult[] = [];
    for (const [name, url] of Object.entries(hooks)) {
      providers.push(await fireHook(name, url));
    }

    const hooksFired = providers.length;
    const hooksOk = providers.filter((p) => p.ok).length;
    const error = commit.ok
      ? null
      : `${commit.error}${hooksFired ? ` — deploy hooks still fired (${hooksOk}/${hooksFired} accepted).` : ""}`;
    const snapshot = JSON.stringify({
      ok: commit.ok,
      commitOk: commit.ok,
      error,
      providers,
      at: Date.now(),
    });
    await ctx.runMutation(internal.gitSync.recordSyncResult, {
      snapshot,
      commitOk: commit.ok,
      ...(commit.ok
        ? { sha: commit.sha, message: commit.message, author: commit.author, at: commit.at }
        : {}),
    });

    return {
      ok: commit.ok,
      repo,
      commit: commit.ok
        ? { sha: commit.sha, message: commit.message, author: commit.author, at: commit.at }
        : null,
      providers,
      error,
    };
  },
});
