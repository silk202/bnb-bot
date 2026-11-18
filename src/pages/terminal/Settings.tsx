// Operator Settings — visible ONLY inside the operator terminals.
//
// Git sync has TWO halves, both surfaced here so the operator never needs a
// provider dashboard for routine work:
//   1. In-app **Git sync panel** (GitSyncPanel) — reads the repository's real
//      latest commit and redeploys Vercel / Netlify / Render / Cloudflare
//      instantly via their deploy hooks. Operator-gated server-side (sign-in
//      OR verified "Continue as Guest" OR trusted device).
//   2. The Freebuff dashboard's Settings → GitHub Sync section — owns the
//      private repository creation + automatic bidirectional source sync.
// No part of this page fakes a connection status — it only surfaces real,
// verifiable facts (commit state, deploy-hook verdicts, export links).

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GitSyncPanel } from "@/components/GitSyncPanel";
import { NetworkReadinessTable } from "@/components/NetworkReadinessTable";
import { RpcDiagnosticsPanel } from "@/components/RpcDiagnosticsPanel";
import { ActivationConsole } from "@/components/ActivationConsole";
import { SecurityChecksPanel } from "@/components/SecurityChecksPanel";
import { BlockedExecutionsPanel } from "@/components/BlockedExecutionsPanel";
import { ExternalLink, GitBranch, RefreshCcw, ShieldCheck } from "lucide-react";
import { getGrant } from "@/lib/gate";
import { classifyDeployment, describeDeployment, DEPLOYMENT_TARGETS } from "@/lib/deployment-target";

/** Freebuff project dashboard — GitHub Sync section (the panel that owns the
 * repository creation + bidirectional sync for this deployment). */
const FREEBUFF_GITHUB_SETTINGS_URL =
  "https://freebuff.com/web/settings?section=github";

/**
 * Backend target: dev is `pastel-pelican-634`, production is
 * `flexible-frog-776`. Any other deployment — in particular
 * `shiny-bulldog-311` — is rejected by `resolveConvexUrl`, so it can never
 * receive metrics or any other request from this app.
 */
function BackendTargetCard() {
  const raw = import.meta.env.VITE_CONVEX_URL as string | undefined;
  const target = classifyDeployment(raw);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          Backend target
          {target && (
            <Badge variant="outline" className="text-[9px] uppercase">
              {target.environment}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Every query, metric and HTTP action from this build goes to this
          deployment only. Other deployments are refused before any request is
          made.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Connected to</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">
            {describeDeployment(raw)}
          </code>
        </div>
        <div className="text-[12px] text-muted-foreground">
          Allowed: dev <code className="font-mono">{DEPLOYMENT_TARGETS.dev}</code> · prod{" "}
          <code className="font-mono">{DEPLOYMENT_TARGETS.prod}</code>. Builds pointing anywhere else show the
          “Backend not configured” state instead of connecting.
        </div>
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const isSubscriber = getGrant()?.role === "subscriber";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-1 sm:px-0">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <ShieldCheck className="size-5 text-primary" />
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Operator-only — this page never appears for subscribers.
        </p>
      </div>

      {/* Which backend this build talks to. Read from the single sanitized
          env read, so it is the real target — and a foreign deployment shows
          as blocked rather than silently receiving metrics. */}
      <BackendTargetCard />

      {/* Read-only readiness table — no control here can enable execution. */}
      <NetworkReadinessTable />

      {/* Per-endpoint RPC diagnostics — probes on demand, never changes config. */}
      <RpcDiagnosticsPanel />

      {/* What is authorized right now, derived from the backend stores. */}
      <SecurityChecksPanel />

      {/* Refusals by code/period — a refusal is not a loss. */}
      <BlockedExecutionsPanel />

      {/* Operator lifecycle: activations, RPC validation, address validation.
          Every control is an operator-gated backend mutation. */}
      <ActivationConsole />

      {/* In-app instant sync — reads the real repo state, redeploys every
          connected platform from Settings without any provider dashboard. */}
      <GitSyncPanel />

      {/* Source sync ownership — the real panel lives on the Freebuff project dashboard */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="size-4 text-primary" />
            GitHub Sync
            <Badge variant="outline" className="text-[9px] uppercase">
              managed on Freebuff
            </Badge>
          </CardTitle>
          <CardDescription>
            Creates a new private GitHub repository for this project and sets
            up automatic synchronization. Both directions — it pushes your
            current project files to GitHub and keeps both platforms in sync
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-1.5 text-[13px] leading-6 text-muted-foreground">
            <li>
              <span className="font-semibold text-foreground">1.</span> Open
              the Freebuff dashboard → <span className="font-semibold text-foreground">Settings → GitHub Sync</span>{" "}
              (button below goes there directly).
            </li>
            <li>
              <span className="font-semibold text-foreground">2.</span> Under
              "GitHub App installation" confirm it shows{" "}
              <span className="font-semibold text-foreground">installed</span>{" "}
              for your account — reinstall only if it was removed.
            </li>
            <li>
              <span className="font-semibold text-foreground">3.</span> In
              "Create GitHub Repository", type a repository name (e.g.{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">flashbolt</code>),
              then press <span className="font-semibold text-foreground">Create &amp; Sync</span>.
            </li>
            <li>
              <span className="font-semibold text-foreground">4.</span> The
              panel creates the <span className="font-semibold text-foreground">private</span> repo,
              sets up the sync webhook, pushes your current files, and enables
              bidirectional synchronization.
            </li>
          </ol>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button asChild className="h-9">
              <a
                href={FREEBUFF_GITHUB_SETTINGS_URL}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mr-2 size-3.5" />
                Open GitHub Sync settings
              </a>
            </Button>
            <Button asChild variant="outline" className="h-9">
              <a
                href="https://github.com/silk202/bnb-bot"
                target="_blank"
                rel="noreferrer"
              >
                <GitBranch className="mr-2 size-3.5" />
                View repository
              </a>
            </Button>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <RefreshCcw className="size-3" />
              What happens next (from the dashboard panel)
            </div>
            • Creates a new private GitHub repository
            <br />• Sets up a webhook for automatic sync
            <br />• Pushes your current project files to GitHub
            <br />• Enables bidirectional synchronization
            <br />• Keeps both platforms in sync automatically
          </div>

          {isSubscriber && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-200">
              You are on a subscriber session — repository management is an
              operator capability.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
