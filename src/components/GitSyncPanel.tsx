// FlashBolt — operator Git sync panel (shared by /terminal/settings and
// /sol-terminal/settings).
//
// WHAT IT DOES — real network calls only, nothing simulated:
//   • Save: stores repo/branch, optional access token (AES-GCM encrypted in
//     the backend, only a last-4 hint ever comes back) and up to four
//     provider deploy-hook URLs (https only).
//   • Sync now: the backend reads the repository's ACTUAL latest commit for
//     the branch, then POSTs to every configured deploy hook and reports the
//     real HTTP status each platform returned — one tap redeploys Vercel,
//     Netlify, Render and Cloudflare from the latest pushed commit, without
//     opening any dashboard.
//   • The panel is operator-gated server-side with the same three-identity
//     verdict as the rest of the console: signed-in operator email, verified
//     "Continue as Guest" session, or a trusted device token.
//
// HONEST SCOPE: source pushes to the repository are owned by the Freebuff
// GitHub Sync (dashboard) or the local CLI (`bun run git:sync`); this panel
// reads the repo's real state and redeploys every connected platform from it.

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  Rocket,
  Save,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getDeviceToken } from "@/lib/gate";

const PROVIDERS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: "vercel",
    label: "Vercel deploy hook",
    hint: "vercel.com → project → Settings → Git → Deploy Hooks",
  },
  {
    key: "netlify",
    label: "Netlify build hook",
    hint: "app.netlify.com → Site settings → Build hooks",
  },
  {
    key: "render",
    label: "Render publish hook",
    hint: "render.com → service → Settings → Build & Deploy → Build Hooks",
  },
  {
    key: "cloudflare",
    label: "Cloudflare Pages hook",
    hint: "dash.cloudflare.com → Pages → Builds → Build hooks",
  },
];

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function fmtWhen(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function GitSyncPanel() {
  const status = useQuery(api.gitSync.getSyncStatus, {
    deviceToken: getDeviceToken() ?? undefined,
  });
  const saveConfig = useMutation(api.gitSync.saveSyncConfig);
  const clearConfig = useMutation(api.gitSync.clearSyncConfig);
  const runSync = useAction(api.gitSync.syncNow);

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [hooks, setHooks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const hydratedRef = useRef(false);

  // Hydrate the form once from the server config (the token itself never
  // comes back — the field stays empty and only the hint is shown).
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!status || status.recognized === false) return;
    hydratedRef.current = true;
    setRepo(status.config.repo ?? "");
    setBranch(status.config.branch);
    setHooks(status.config.hooks);
  }, [status]);

  const recognized = status?.recognized !== false;
  const config = status?.recognized === true ? status.config : null;
  const hooksConfigured = Object.values(hooks).some((u) => u.trim().length > 0);
  const canSync = Boolean(config?.repo) && !syncing;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await saveConfig({
        deviceToken: getDeviceToken() ?? undefined,
        repo,
        branch,
        ...(token.trim() ? { token: token.trim() } : {}),
        hooks: PROVIDERS.map((p) => ({
          provider: p.key,
          url: hooks[p.key] ?? "",
        })),
      });
      if (res.ok) {
        setToken("");
        toast.success(`Sync config saved — ${res.repo}`);
      } else {
        toast.error(res.error ?? "Could not save the sync config");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the sync config");
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    if (!canSync) return;
    setSyncing(true);
    try {
      const res = await runSync({ deviceToken: getDeviceToken() ?? undefined });
      const fired = res.providers.filter((p) => p.ok).length;
      if (res.ok) {
        toast.success(
          res.providers.length
            ? `Synced — ${res.commit ? shortSha(res.commit.sha) : ""} · ${fired}/${res.providers.length} deploy hooks accepted`
            : `Synced — ${res.commit ? shortSha(res.commit.sha) : ""} · latest commit verified`,
        );
      } else {
        toast.error(res.error ?? "Sync failed");
      }
      for (const p of res.providers) {
        if (!p.ok) toast.warning(`${p.name}: ${p.note}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await clearConfig({ deviceToken: getDeviceToken() ?? undefined });
      hydratedRef.current = false;
      setRepo("");
      setBranch("main");
      setToken("");
      setHooks({});
      toast.success("Sync config cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the config");
    } finally {
      setClearing(false);
    }
  };

  const lastSync = config?.lastSync ?? null;
  const lastCommit = config?.lastCommit ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4 text-primary" />
          Git sync
          <Badge variant="outline" className="text-[9px] uppercase">
            instant · no dashboard
          </Badge>
        </CardTitle>
        <CardDescription>
          Read the repository&apos;s latest commit and redeploy every connected
          platform (Vercel, Netlify, Render, Cloudflare) in one tap — straight
          from Settings, no provider dashboard needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!recognized && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-5 text-amber-200">
            <div className="text-xs font-semibold text-amber-100">
              Operator session required
            </div>
            Sign in or use “Continue as Guest” (verified session) to manage
            repository sync from this panel.
          </div>
        )}

        {recognized && (
          <>
            {/* Repo + branch */}
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <div className="space-y-1.5">
                <Label htmlFor="gitsync-repo" className="text-xs">
                  Repository (owner/name)
                </Label>
                <Input
                  id="gitsync-repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="silk202/bnb-bot"
                  className="h-9 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gitsync-branch" className="text-xs">
                  Branch
                </Label>
                <Input
                  id="gitsync-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="h-9 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Access token — encrypted server-side, never echoed back. */}
            <div className="space-y-1.5">
              <Label htmlFor="gitsync-token" className="text-xs">
                Access token{" "}
                <span className="font-normal text-muted-foreground">
                  (optional — private repos &amp; higher rate limits)
                </span>
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="gitsync-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    config?.tokenSet
                      ? `stored · ••••${config.tokenHint ?? ""}`
                      : "access token…"
                  }
                  className="h-9 min-w-0 flex-1 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="new-password"
                />
                {config?.tokenSet && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-emerald-500/40 text-[9px] uppercase text-emerald-400"
                  >
                    encrypted · ••••{config.tokenHint ?? ""}
                  </Badge>
                )}
              </div>
              <p className="text-[10px] leading-4 text-muted-foreground">
                Stored AES-GCM encrypted in the backend and never returned to
                the browser — only this last-4 hint is ever shown.
              </p>
            </div>

            {/* Deploy hooks */}
            <details className="rounded-lg border border-border/60 bg-background/40">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                Deploy hooks — providers that redeploy on Sync now{" "}
                {hooksConfigured
                  ? `(${Object.values(hooks).filter((u) => u.trim()).length} configured)`
                  : "(none configured yet)"}
              </summary>
              <div className="space-y-3 px-3 pb-3 pt-1">
                <p className="text-[10px] leading-4 text-muted-foreground">
                  Paste each platform&apos;s webhook URL; Sync now POSTs to all
                  of them for a real redeploy of the latest pushed commit.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {PROVIDERS.map((p) => (
                    <div key={p.key} className="space-y-1.5">
                      <Label htmlFor={`gitsync-${p.key}`} className="text-xs">
                        {p.label}
                      </Label>
                      <Input
                        id={`gitsync-${p.key}`}
                        value={hooks[p.key] ?? ""}
                        onChange={(e) =>
                          setHooks((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                        placeholder="https://…"
                        className="h-9 font-mono text-[11px]"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <p className="text-[10px] text-muted-foreground">{p.hint}</p>
                    </div>
                  ))}
                </div>
              </div>
            </details>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-9 px-3 text-xs"
                disabled={saving || !repo.trim()}
                onClick={() => void save()}
              >
                {saving ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 size-3.5" />
                )}
                Save config
              </Button>
              <Button
                size="sm"
                className="h-9 px-3 text-xs"
                disabled={!canSync}
                onClick={() => void syncNow()}
              >
                {syncing ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Rocket className="mr-1 size-3.5" />
                )}
                Sync now
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-9 px-3 text-xs text-red-500"
                disabled={clearing || (!config?.repo && !config?.tokenSet && !hooksConfigured)}
                onClick={() => void clear()}
              >
                {clearing ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 size-3.5" />
                )}
                Clear
              </Button>
            </div>

            {/* Real status: latest commit + last run verdicts */}
            {(lastCommit || lastSync) && (
              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                {lastCommit && (
                  <div className="flex items-start gap-2">
                    <GitBranch className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <div className="min-w-0 text-[11px] leading-5">
                      <span className="font-mono font-semibold">
                        {shortSha(lastCommit.sha)}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {lastCommit.message || "(no message)"}
                      </span>
                      <div className="text-[10px] text-muted-foreground">
                        {lastCommit.author ? `${lastCommit.author} · ` : ""}
                        {lastCommit.at ? fmtWhen(lastCommit.at) : ""}
                        {" · branch "}
                        {config?.branch ?? "main"}
                      </div>
                    </div>
                  </div>
                )}
                {lastSync && (
                  <div className="space-y-1.5 border-t border-border/50 pt-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                        Last sync {lastSync.at ? fmtWhen(lastSync.at) : ""}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          "text-[9px] uppercase " +
                          (lastSync.ok
                            ? "border-emerald-500/40 text-emerald-400"
                            : "border-red-500/40 text-red-400")
                        }
                      >
                        {lastSync.ok ? "repo verified" : "failed"}
                      </Badge>
                      {lastSync.providers.map((p) => (
                        <Badge
                          key={p.name}
                          variant="outline"
                          className={
                            "text-[9px] uppercase " +
                            (p.ok
                              ? "border-emerald-500/40 text-emerald-400"
                              : "border-red-500/40 text-red-400")
                          }
                          title={p.note}
                        >
                          {p.ok ? (
                            <CheckCircle2 className="size-3" />
                          ) : (
                            <XCircle className="size-3" />
                          )}
                          {p.name}
                          {p.status ? ` ${p.status}` : ""}
                        </Badge>
                      ))}
                    </div>
                    {lastSync.error && (
                      <div className="text-[10px] leading-4 text-red-400">
                        {lastSync.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Honest scope note */}
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-[10px] leading-4 text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <ShieldCheck className="size-3" />
                How sync works
              </div>
              Source pushes to the repository come from the Freebuff GitHub
              Sync (auto) or the CLI (<code className="font-mono">bun run git:sync</code>).
              This panel verifies the repo&apos;s real latest commit and redeploys
              every configured platform from it — instantly, from Settings.
              {config?.repo && (
                <>
                  {" "}
                  <a
                    href={`https://github.com/${config.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    Open repository <ExternalLink className="size-3" />
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
