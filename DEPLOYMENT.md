# FlashBolt Deployment Guide

## Prerequisites

- [Node.js](https://nodejs.org) v18+ or [Bun](https://bun.sh) v1.0+
- [Git](https://git-scm.com) — optional, only if you want version control of your copy
- A [Convex](https://convex.dev) account (free tier works)

## Quick Start

Get the source from the app itself: open the account menu in any FlashBolt
terminal (BNB, SOL or Trade) and choose **Download source** — that archive is
the full project in one folder, generated from the running build, with no Git
clone, GitHub account or release page involved. The same files are on the
`/download` page (operator/guest only) as `.zip` or `.tar.gz`.

```bash
# Unpack the downloaded archive (one top-level folder)
unzip flashbolt-source.zip          # or: tar xzf flashbolt-source.tar.gz
cd flashbolt-v*

# Install dependencies, then provision Convex (writes VITE_CONVEX_URL for you)
bun install
bun run setup

# Start development server
bun run dev
```

The archive contains every root config (`package.json`, `bun.lock`,
`tsconfig*.json`, `vite.config.ts`, host descriptors) plus `src/` and the
entire `src/convex/` backend, so it builds and deploys as-is. Dependency
folders, build output and all env files are excluded — only `.env.example`
ships as a key reference. Regenerate it after source changes with
`bun run source:package`.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_CONVEX_URL` | The Convex deployment URL **for this build's environment** | Yes |
| `COPIER_SIGNALS_URL` | Live copier-signals feed URL for overlay artifact builds | No |

`VITE_CONVEX_URL` is build-time and per environment: local dev points at the
development deployment, a published build points at the production deployment.
There is no default — a build without it shows a *Backend not configured*
screen. Backend env vars are a different thing entirely: they live on each
deployment, not in the repo — see
[Convex deployments — development vs production](#convex-deployments--development-vs-production).

Set via the Keys/API keys tab in the Freebuff platform, or create `.env.local`:

```
VITE_CONVEX_URL=https://your-deployment.convex.cloud
```

> **Overlay artifacts:** the committed files in `public/overlay/` are deterministic
> builds. When serving your own deployment, rebuild them with `bun run overlay` —
> with `VITE_CONVEX_URL` set the daily-target gate endpoint (the `.convex.site`
> origin) is stamped into the userscript and both extension bundles. Without it the
> artifacts ship unstamped and behave as operator/private installs (no server gate).

### Convex deployments — development vs production

A Convex project has **two deployments, and they are separate entities**:
different URLs, different data, different backend env vars, different usage
counters, different deploy keys. Nothing crosses over automatically.

| | Development | Production |
|---|---|---|
| Created by | `bunx convex dev` (managed binding; project already has one) | dashboard → project → **Create deployment** → *Production*, or `bunx convex deploy` on a project that has none yet |
| Client URL | `https://<dev-deployment>.convex.cloud` | `https://<prod-deployment>.convex.cloud` |
| HTTP-actions origin | `https://<dev-deployment>.convex.site` | `https://<prod-deployment>.convex.site` |
| Frontend `VITE_CONVEX_URL` comes from | `.env.local` (written by `bun run setup`) | the host / CI variable for that build |
| Backend is pushed by | `bunx convex dev --once` | `bunx convex deploy` (with *that* deployment's deploy key) |
| Backend vars written by | `bunx convex env set NAME value` | `bunx convex env set --prod NAME value` |
| Data | test users/grants — safe to wipe | real grants, licences, signals — never point a dev build at it |

**No deployment URL is baked into the source.** `src/main.tsx` has no default:
without `VITE_CONVEX_URL` the app renders a *Backend not configured* screen
instead of silently attaching to whichever deployment the source was written
against. A fork or self-hosted copy therefore cannot read another operator's
data by accident, and a build always names its own deployment.

`CONVEX_SITE_URL` is injected per deployment by Convex — never set it by hand.
`CONVEX_DEPLOYMENT` is written by the CLI. `CONVEX_DEPLOY_KEY` is **not** a
runtime variable: it is a per-deployment CLI/CI credential (dashboard → that
deployment → Settings → Deploy keys) and belongs in the CI secret store.

#### Backend env vars per deployment

Same **names** in both deployments, different **values**. A variable missing
from the deployment a build talks to fails at call time, not at build time —
set them with `bunx convex env set` (dev) or `bunx convex env set --prod`
(production), and verify names with `bunx convex env list` /
`bunx convex env list --prod`.

| Variable | Development | Production | Used by |
|---|---|---|---|
| `JWT_PRIVATE_KEY`, `JWKS` | `npx @convex-dev/auth` | `npx @convex-dev/auth --prod` | This project's own sign-in tokens |
| `SITE_URL` | `http://localhost:5173` | the public site origin | Email/Telegram links, Kora return URL |
| `GATE_ENC_KEY` | optional, 64 hex chars | recommended, 64 hex chars | AES-GCM key for stored secrets. Must match `/^[0-9a-f]{64}$/` or it is ignored (falls back to a SHA-256 of `JWT_PRIVATE_KEY`, then a DB-stored key). Changing it makes existing ciphertext unreadable |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | dev bot (optional) | required for alerts | Notifications, copier, Telegram webhook |
| `RESEND_API_KEY`, `RESEND_FROM` | optional | required | Transactional email; without it no mail is sent |
| `BREVO_API_KEY`, `BREVO_FROM` | optional | optional | Email fallback provider |
| `SAMBANOVA_API_KEY` | optional | optional | Support assistant (reports `enabled: false` without it) |
| `CARTESIA_API_KEY` | optional | optional | Text-to-speech |
| `BSCSCAN_API_KEY` | optional | optional | Contract verification |
| `KORA_SECRET_KEY` | test key | live key | Payments |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TO` | optional | optional | WhatsApp alerts |
| `VLY_INTEGRATION_KEY`, `VLY_INTEGRATION_BASE_URL` | platform-injected | platform-injected | Email OTP gateway |
| `VLY_CONVEX_AUTH_ISSUER` | defaults to `https://freebuff.com` | same default | Federated freebuff sign-in |
| `CONVEX_SITE_URL` | built in | built in | Never set manually |

> **Names are matched exactly.** The code reads `VLY_INTEGRATION_KEY` and
> `VLY_INTEGRATION_BASE_URL` (singular). A dashboard row named
> `VLY_INTEGRATIONS_KEY` / `VLY_INTEGRATIONS_BASE_URL` (plural) is a
> *different, unread* variable — email sign-in keeps failing with
> "VLY_INTEGRATION_KEY is not set on this Convex deployment".

Frontend build-time variables are separate and belong to the build, not the
deployment: `VITE_CONVEX_URL` (required, per environment), plus the optional
platform-injected `VITE_VLY_APP_ID` / `VITE_VLY_MONITORING_URL`.

#### Creating a new production deployment with its own env vars

1. **Create it** — dashboard → project → deployment switcher →
   **Create deployment** → type **Production**. (A project has one production
   deployment; to replace it, delete the old one first, or create a new
   project. Deleting a deployment deletes its data.)
2. **Push the backend into it** from the repo root:
   `bunx convex deploy` — uploads functions, schema, crons and HTTP actions.
   Generate its deploy key in dashboard → that deployment → **Settings →
   Deploy keys** and store it as CI `CONVEX_DEPLOY_KEY`. *A key from another
   deployment silently deploys to that other deployment* — confirm with
   `bunx convex logs --history 1`, whose header prints the deployment URL.
3. **Auth keys** — `npx @convex-dev/auth --prod` writes `JWT_PRIVATE_KEY` and
   `JWKS` to the production deployment.
4. **Everything else**, one call per variable:

   ```bash
   bunx convex env set --prod SITE_URL https://your-domain
   bunx convex env set --prod GATE_ENC_KEY <64-hex>
   bunx convex env set --prod TELEGRAM_BOT_TOKEN <token>
   bunx convex env set --prod TELEGRAM_CHAT_ID <chat-id>
   bunx convex env set --prod RESEND_API_KEY <key>
   bunx convex env set --prod RESEND_FROM "FlashBolt <no-reply@your-domain>"
   bunx convex env list --prod   # names, not values — catches typos
   ```

5. **Point the frontend at it** — set `VITE_CONVEX_URL` to
   `https://<prod-deployment>.convex.cloud` in the host/CI variable list and
   rebuild. Without it the build publishes the *Backend not configured*
   screen.
6. **Re-stamp the overlay artifacts** — the userscript and both extension
   bundles embed the `.convex.site` gate origin and are rebuilt from
   `VITE_CONVEX_URL` on every build (nothing is hardcoded):
   `VITE_CONVEX_URL=https://<prod-deployment>.convex.cloud bun run overlay`.
   Without it they ship unstamped (operator/private installs, no server gate).
7. **Re-arm the per-deployment extras** — usage limits and the Telegram
   webhook (see below). Neither migrates with the code: usage limits are
   armed per deployment, and the webhook self-heals to whichever deployment's
   functions are running, so the old deployment's cron must be paused or
   deleted to stop it stealing the webhook back.
8. **Verify** — `bunx convex deployment usage-limits list --prod` must report
   the new deployment's counters, and `getWebhookInfo` must show
   `https://<new-prod>.convex.site/api/telegram/webhook`.

- Push function/schema/cron changes with `bunx convex dev --once` (dev) or
  `bunx convex deploy` (production). Frontend-only edits need no push, but any
  change under `src/convex/` **or any `src/lib/` file the convex bundle
  imports** (e.g. `src/lib/flashbolt.ts`) does.
- Usage circuit breakers (`functionCalls` and `databaseIoGb`, monthly,
  disable-type) are armed per deployment so a runaway loop trips a known stop
  instead of a surprise free-tier disable. They do not migrate — re-arm them
  on any replacement deployment.
- Telegram webhook: self-heals every 10 minutes and on dialog open; verify
  with `getWebhookInfo` that it points at the serving deployment's
  `https://<deployment>.convex.site/api/telegram/webhook`.

## Deployment Platforms

### GitHub Sync (the repository itself)

The private GitHub repository and its automatic bidirectional sync are owned
by the **Freebuff dashboard → Settings → GitHub Sync** panel:

1. Confirm the **GitHub App installation** shows installed for your account.
2. In **Create GitHub Repository**, choose a name (e.g. `flashbolt`) and press
   **Create & Sync** — this creates the private repo, sets up the sync webhook,
   pushes your current project files and enables bidirectional synchronization.
3. From then on, both platforms stay in sync automatically. To also push to
   your deploy remotes in one step, use the in-repo helper:

```bash
bun run git:sync                # typecheck + tests, commit, push to all remotes
SKIP_GATE=1 bun run git:sync    # fast sync without the pre-flight gate
```

### In-app Git sync (no dashboard needed)

**/terminal/settings** and **/sol-terminal/settings** (operator only — sign-in
OR a verified "Continue as Guest" session OR a trusted device) carry a
**Git sync** panel that works entirely from inside the app:

1. **Repository + branch** — the panel reads the branch's ACTUAL latest commit
   (sha, message, author) from the repository API on every Sync now.
2. **Access token (optional)** — for private repos / rate limits; stored
   AES-GCM encrypted in the backend and never returned to the browser (only a
   last-4 hint is shown).
3. **Deploy hooks** — paste the Vercel deploy hook, Netlify build hook, Render
   publish hook and Cloudflare Pages build hook once; **Sync now** POSTs to
   every configured hook and reports each platform's real HTTP status. That
   redeploys all connected platforms from the latest pushed commit in one tap.
4. **Honest split** — source pushes stay owned by this GitHub Sync panel above
   (automatic bidirectional sync) or the local helper (`bun run git:sync`);
   the in-app panel verifies the repo state and redeploys from it.

### Vercel

1. Push to GitHub
2. Import repository at [vercel.com/new](https://vercel.com/new)
3. Vercel auto-detects Vite — `vercel.json` handles SPA rewrites (with real-file
   exclusions for `/assets`, `/overlay`, `logo.svg`, `robots.txt` and the manifest),
   cache headers and security headers
4. Set `VITE_CONVEX_URL` in Environment Variables
5. Deploy

**CLI:**
```bash
bun add -g vercel
vercel --prod
```

### Netlify

1. Push to GitHub
2. Import at [app.netlify.com](https://app.netlify.com) — `netlify.toml` configures
   the build, SPA redirect and headers automatically
3. Set `VITE_CONVEX_URL` in Environment Variables
4. Deploy

**CLI:**
```bash
bun add -g netlify-cli
netlify deploy --prod
```

### Cloudflare Pages

1. Push to GitHub
2. Create project at [dash.cloudflare.com](https://dash.cloudflare.com) → Pages
3. Build command: `bun run build`
4. Build output directory: `dist`
5. Set `VITE_CONVEX_URL` in Environment Variables
6. Deploy

The `public/_headers` file ships immutable caching for `/assets/*`, 1-hour caching
for `/overlay/*`, no-store for `index.html` and the static security headers for
everything.

`Content-Security-Policy` is **not** in `_headers`: a nonce cannot be expressed in
a static header. `sites/worker.js` mints a nonce per HTML response, stamps it on
every `<script>`/`<style>` tag and sends the matching policy, so the policy only
exists on responses that carry its nonce. Hosts that serve `dist/` directly
without that Worker (Vercel/`taengine.freebuff.app`, a plain static server) send
no CSP — they are not sent a policy whose nonce their HTML lacks. To get the
Worker's headers there, deploy the Worker (see the Freebuff Sites section).

Everything else in `_headers` is mirrored for Vercel in `vercel.json`
(`taengine.freebuff.app` is served from there) and for Netlify in
`netlify.toml`, including HSTS, the robots tag and `Referrer-Policy:
no-referrer`. All three files are hand-written in different formats, so
`bun run check:headers` (part of `bun run verify`) resolves every one of them
the way its host does — all matching rules in file order, later wins — for one
path per declared rule, and fails on any header that is missing, different or
extra on either host.

**CLI:**
```bash
bun add -g wrangler
wrangler pages deploy dist
```

### Render

1. Push to GitHub
2. Create Static Site at [render.com](https://render.com) — `render.yaml` is
   detected automatically (build, publish dir, SPA rewrites with real-file
   exclusions and headers)
3. Set `VITE_CONVEX_URL` as Environment Variable
4. Deploy

### Docker

```dockerfile
FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
}
EOF
EXPOSE 80
```

```bash
docker build -t flashbolt .
docker run -p 80:80 flashbolt
```

## Concurrent auto-update pipeline — one push, every surface

Every push to `main` updates all deployment surfaces at once:

| Surface | How it auto-updates |
|---|---|
| **Convex backend** (functions, crons, schema) | `.github/workflows/ci.yml` runs `bunx convex deploy` after the gates pass — requires the `CONVEX_DEPLOY_KEY` secret (Project settings → prod deployment key). Without the secret the step is skipped with a notice, never red. |
| **Vercel / Netlify / Cloudflare Pages / Render** | Native git integration — connect the repo once in each dashboard; each platform reads the committed zero-config files (`vercel.json`, `netlify.toml`, `wrangler.toml`, `render.yaml`), runs `bun run build` and publishes `dist`. |
| **Overlay (BNB + SOL)** | Rebuilt from `src/lib/overlay-script.ts` / `sol-overlay-script.ts` inside **every** build (`bun run build` = tsc → overlay → vite), so the zips served at `/overlay/` can never drift from the app. The version-sync test fails CI if the consts and `package.json` disagree. |
| **Downloads / desktop packages** | CI uploads `public/overlay/*.zip` + `*.user.js` as a per-commit artifact (`overlay-<sha>`, kept 30 days); the in-app Downloads page keeps serving the committed artifacts. |
| **CLI / scripts** | Typecheck + the full test suite run over every `bun run …` script entry on each push, so a fresh clone's commands always work. |
| **Responsiveness / UI** | Same hard gates (typecheck, tests, production build) — a push that regresses the app never reaches any host. |

One-time setup:

1. Push the repo to GitHub, then in each host's dashboard: *Import git repository* and keep the committed build settings (no dashboard-side build config needed).
2. Repo → Settings → Secrets and variables → Actions: add `CONVEX_DEPLOY_KEY` (backend auto-deploy — it must be the deploy key generated on your **production** deployment; a dev key deploys to dev) and the repository variable `VITE_CONVEX_URL` = `https://<prod-deployment>.convex.cloud` (the deployment the frontend build targets — with no value the build publishes the *Backend not configured* screen).
3. Backend secrets (JWKS, JWT_PRIVATE_KEY, SITE_URL, bot tokens) are set once per Convex deployment via the Keys/API keys tab — they never live in git (`.env*` is gitignored except `.env.example`).

Version releases — one command keeps every surface in lockstep:

```bash
bun run version:bump 2.10.0   # package.json + both overlay consts + CHANGELOG stub + rebuilt overlay artifacts
bun test                      # version-sync guard confirms app ↔ overlays agree
```

## Desktop Apps

### Linux / macOS / Windows

Desktop apps use the same web interface with native wrappers:

1. Download the setup from `/download` (passphrase required)
2. Run the installer for your OS
3. Enter your subscriber email + activation password
4. The app stays licensed permanently after first activation

**CLI activation:**
```bash
# Linux/macOS
curl -X POST "{CONVEX_URL}/activate" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","os":"linux","password":"FB-XXXX-XXXX-XXXX"}'

# Windows (PowerShell)
.\flashbolt-windows.ps1 -Email "you@example.com" -Password "FB-XXXX-XXXX-XXXX" -AppUrl "{CONVEX_URL}"
```

## Source Code

Package source code for download:

```bash
bun run source:package
```

This writes `public/downloads/flashbolt-source.zip` and
`public/downloads/flashbolt-source.tar.gz`. Both contain one top-level folder,
`flashbolt-v{VERSION}/`, holding the working tree: root configs plus `src/` and
the whole `src/convex/` backend. Because they live in `public/`, Vite copies
them into `dist/downloads/` on every build, so the deployed app serves them at
`/downloads/flashbolt-source.zip` and the account menu's **Download source**
entry (operator/guest) downloads them straight from your own origin — no
GitHub, release page or archive endpoint involved.

Excluded from the archive: `node_modules`, `dist`, `isolate`, `.git`, caches and
deploy state (`.vly`, `.vercel`, `.netlify`, `.wrangler`), database export
dumps (`*.jsonl`, `flashbolt-export*`), drill reports, other archives, the
downloads folder itself, and all env files except the committed
`.env.example`. Re-run the command after source changes; the published archive
is a snapshot of the build it was packaged from.

The click is a native download: the menu links to
`/downloads/flashbolt-source.zip` and names the saved file
`flashbolt-v<version>-source.zip`, and the host configs (`public/_headers`,
`netlify.toml`, `vercel.json`) return `Content-Disposition: attachment`, so the
file lands in the machine's Downloads folder rather than opening in the tab
even if the `download` attribute is ignored.

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start development server |
| `bun run build` | Production build (typecheck + overlay artifacts + Vite bundle) |
| `bun run preview` | Preview production build |
| `bun run lint` / `lint:fix` / `format` | ESLint / Prettier |
| `bun run typecheck` | TypeScript type check |
| `bun run test` | Bun test suite (overlay, chains, gates, pipelines) |
| `bun run verify` | Release gate: typecheck + tests + overlay-artifact verification (version + gate stamp) + live drill report (fresh 2/2, no bypass) |
| `bun run drill:all` | Combined live drill (SOL devnet + BSC testnet) — one honest verdict |
| `bun run drill:report` | Combined drill with output pinned to `reports/drill-latest.txt` (the release-gate artifact) |
| `bun run check:drill` | Release-gate check on the pinned drill report (fresh 2/2 required) |
| `bun run drill` / `drill:evm` | SOL devnet drill / BSC-testnet EVM drill individually |
| `bun run check:mirror` | Verify an existing `mirror-v<version>.zip` is still in sync with the live source |
| `bun run clean` | Remove `dist/` and the Vite cache |
| `bun run convex:dev` | Convex codegen (non-interactive, `--once`) |
| `bun run retention:once` | Run the data-retention sweep on demand (normally cron'd every 4 hours) |
| `bun run overlay` | Build scanner overlay artifacts (userscript + Chrome MV3 + Firefox MV2 zips) into `public/overlay/` |
| `bun run setup` / `setup:win` | One-shot setup script (Linux/macOS / Windows) |
| `bun run deploy:vercel` | Deploy to Vercel |
| `bun run deploy:netlify` | Deploy to Netlify |
| `bun run deploy:cloudflare` | Deploy to Cloudflare Pages |
| `bun run deploy:render` | Push to Render (git remote `render`) |
| `bun run git:sync` | Pre-flight gate → commit → push to every configured git remote (origin, render, …) |
| `bun run source:package` | Package source code into `public/downloads/flashbolt-source.zip/.tar.gz` (served by the app) |
| `bun run package:mirror` | Package mirror layout into `mirror-v{VERSION}.zip` + verify sync |

## Release checklist

Every release follows the same lockstep — one version number everywhere
(`package.json` drives the app badge, both overlay manifests, the userscript
header and the install README):

1. **Bump `package.json`** — the version flows automatically into the
   Downloads page (`__APP_VERSION__`), both overlay generators
   (`OVERLAY_VERSION` / `SOL_OVERLAY_VERSION` are pinned to it by
   `src/lib/__tests__/version-sync.test.ts`) and the artifact manifests.
   The version-sync test fails the suite if any const drifts.
2. **Add a CHANGELOG.md entry** under the new version heading.
3. **Rebuild overlay artifacts** — `bun run overlay`. Artifacts are
   deterministic builds served from `public/overlay/` and committed.
4. **Run the release gate** — `bun run verify` (typecheck + full tests +
   artifact verification: version match on userscript/manifests/README and
   the daily-target gate stamp in all three bundles + the **live drill
   gate**: a fresh (≤ 24 h) 2/2 combined verdict pinned by
   `bun run drill:report` — there is no bypass flag, so if the drills have
   not passed, fund the printed addresses per **DRILLS.md** and re-run).
   Deploy only on green.
5. **Deploy** — `bun run deploy:vercel` / `deploy:netlify` /
   `deploy:cloudflare` / `deploy:render`, or package mirrors via
   `bun run package:mirror`.

> Self-hosting note: rebuild artifacts with `VITE_CONVEX_URL` set so your
> Convex `.convex.site` origin (the daily-target gate endpoint) is stamped
> into the generated userscript/extension bundles.

## Data retention & usage limits

Only data that must be stored is stored. A 4-hourly cron (`daily-retention`,
`src/convex/retention.ts`) auto-deletes everything else in bounded batches
(backlogs drain over runs); run it manually with `bun run retention:once`.

| Data | Policy |
|------|--------|
| Bell notifications | 30 days |
| Paper (SIM) executions | 30 days — all-time totals preserved in `pnlStats` |
| Telegram sent-signal history | 7 days |
| One-time operator codes (OTP / guest) | expired + 1 day |
| Rate-limit window buckets | dead + 1 day |
| TTS cache rows **and** storage blobs | 30 days |
| Audit log | 7 days (`audit-log-prune`, every 6 hours) |
| Copier signals | 6 hours (poller TTL) **+ 12 hours (retention backstop)** |

**Kept forever:** trade ledgers (balances, transactions, orders, earn plans,
deposits, cash accounts, Kora deposits), LIVE on-chain execution rows,
`pnlStats`, users & terminal states, subscribers and support tickets,
licenses, Telegram pairing/bot config, gate/operator config, device trust.

Free-plan guardrails (Convex usage limits — enforced, the deployment
pauses when crossed):

```sh
bunx convex deployment usage-limits set --metric functionCalls --window day --type disable --limit 30000
bunx convex deployment usage-limits set --metric databaseIoGb   --window day --type disable --limit 1
bunx convex deployment usage-limits list
```

The DB-I/O metric accepts integer GB only, so the 30 MB/day target is held
by design — indexed bounded reads, materialized aggregates, 180 s engine
loops — with the 1 GB/day stop as the runaway backstop.

## Architecture

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui (mobile-first,
responsive layouts; PWA manifest for install-to-home-screen)
- **Backend**: Convex (serverless functions + database, crons for the 24/7
engines, usage circuit breakers)
- **Auth**: Convex Auth (email/password + EmailOTP)
- **Real-time**: DexScreener + 9 other APIs for live market data
- **Smart Contracts**: Solidity (FlashBoltArbitrage.sol on BSC)
- **Solana**: Jupiter v1 quotes/builds, Jito block-engine submission, real
two-leg routes with wallet-fit sizing (0.05 SOL min clip)
- **Telegram**: TAEngine console bot (per-chain engines, digests, alerts) —
separate from the TASignal alert channel
- **Desktop**: activation licensing (licenses table + email), `/download`
installers for Linux / macOS / Windows

## Convex usage limits — daily gauges with automatic re-enable

The deployment carries platform-level **usage limits** (Convex Deployment
API) so usage caps itself instead of tripping the plan's hard disable. A
limit disables the deployment while its rolling window is over threshold and
**re-enables it automatically** as soon as the window resets under it —
daily gauges therefore self-heal at 00:00 UTC with no manual action.

Armed on whichever deployment is serving production traffic.
**Limits are per-deployment and do not migrate**: re-run the limit block below
against the replacement production deployment's id (or the CLI equivalent with
that deployment's key) whenever production moves, so the gauges guard the
deployment that actually serves traffic:

| Metric | Window | Threshold |
|---|---|---|
| Function calls | day / month | 30,000 / 1,000,000 |
| Database I/O | day / month | 1 GB* / 1 GB** |
| Data egress | day / month | 1 GB* / 1 GB |
| Action compute (Convex/CPU/Node) | day / month | 1 GB-h* / 20 GB-h |
| Search queries | day / month | 96 QGB / 3,000 QGB |

\* Requested tighter — 30 MB/day I/O + egress, 0.4 GB-h/day compute — but
the API accepts **positive integers only** in each metric's native unit
(GB, GB-h): 1 GB / 1 GB-h is the tightest expressible day gauge. The gap
between those gauges and the intended 30 MB / 0.4 GB-h is held by the
application-side enforcement below (purge cadence + the client bump gate).
DB storage (0.3 GB target) and file storage (0.5 GB target) have **no limit
metric at all** — purging is their only enforcement.
\*\* The DB I/O **month** limit can only be set while current-month usage is
below it — after the Nov 1 monthly reset run once:

```bash
curl -sS -X POST "$API/v2/deployments/$DEPLOYMENT_ID/usage-limits" \
  -H "Authorization: Bearer $CONVEX_TEAM_API_KEY" -H 'content-type: application/json' \
  -d '{"metric":"databaseIOGB","window":"month","threshold":1}'
```

**Application-side enforcement beneath the gauges** (what keeps 24/7
operation under 30K calls/day and holds DB I/O, egress and storage far below
the integer floors):

- `daily-retention` cron **every 4 h** (bounded batches, idempotent): old
  notifications, paper executions (LIVE on-chain rows never deleted),
  telegram signal history > 7 d, expired one-time codes, dead rate-limit
  windows, TTS cache + storage blobs > 30 d, and a **12 h backstop sweep
  of the copier signal feed** (BNB copier + SOL sniper), which the poller's
  own 6 h TTL normally handles.
- `audit-log-prune` cron **every 6 h** (7-day keep) — the operator console
  live-subscribes to auditLogs, so its size multiplies subscription I/O.
- Client scan bumps coalesce through one gate at **60 s per chain**
  (`CLIENT_BUMP_GAP_MS`, `src/lib/bump-throttle.ts`): ≤ ~1,440 state writes
  per chain per open tab/day instead of 5,760, and each write re-runs every
  mounted state subscription — the single largest client-side call lever.
  The freshness stamp stays 5× inside the server's 300 s single-driver
  window, so engine invariants are unaffected.
- Server engine loops self-reschedule at 180 s (4 loops ≈ 1,920 calls/day)
  and all crons combined ≈ 2,100 calls/day — fixed server work ≈ 4K/day,
  leaving the bulk of the 30K/day gauge for client queries.
- WhatsApp stores no message data (config only) and Telegram bot
  pairing/config are identity data — nothing there to purge; trade ledgers
  and execution trails are the kept "very important data".

To apply the same gauges to the production deployment (or re-verify), get a
team API key from dashboard → Settings → Access Tokens, then:

```bash
export CONVEX_TEAM_API_KEY=…        # dashboard → Settings → Access Tokens
API=https://api.convex.cloud
curl -sS "$API/v2/deployments?search=production" -H "Authorization: Bearer $CONVEX_TEAM_API_KEY"  # take the production deployment id → DEPLOYMENT_ID
# day gauges: 30K calls · 1 GB DB I/O · 1 GB egress · 1 GB-h compute · 96 QGB search
# month gauges: 1M calls · 1 GB DB I/O · 1 GB egress · 20 GB-h compute · 3000 QGB search
for spec in \
  '["functionCalls","day",30000]'  '["functionCalls","month",1000000]' \
  '["databaseIOGB","day",1]'       '["databaseIOGB","month",1]' \
  '["dataEgressGB","day",1]'       '["dataEgressGB","month",1]' \
  '["actionComputeGB","day",1]'    '["actionComputeGB","month",20]' \
  '["searchQueriesQGB","day",96]'  '["searchQueriesQGB","month",3000]'
do
  IFS=, read -r metric window threshold <<<"$(echo "$spec" | tr -d '[]\"')"
  curl -sS -X POST "$API/v2/deployments/$DEPLOYMENT_ID/usage-limits" \
    -H "Authorization: Bearer $CONVEX_TEAM_API_KEY" -H 'content-type: application/json' \
    -d "{\"metric\":\"$metric\",\"window\":\"$window\",\"threshold\":$threshold}"
  echo
done
```

Verify or adjust any time:

```bash
bunx convex deployment usage-limits --team <team-slug> --json
bunx convex deployment usage --team <team-slug> --json
```

### Action-compute budget — the 20 GB-h/month allowance (24/7-safe)

Action compute is the ONE Convex allowance that queries and mutations never
touch — query/mutation compute is free on serverless plans
(https://docs.convex.dev/production/state/limits), so only actions bill it
and the HTTP-fan-out pollers are the bulk of the story. The Free plan's
20 GB-h/month is a hard per-team cap. Runtime footprints are documented:
Convex-runtime actions run at 64 MiB (≈ 0.0625 GB per action-second) and
Node-runtime actions at 512 MiB — 8× the per-second rate — which is why
the two `"use node"` actions in this app (email relay, Cartesia TTS) are
both event-driven and content-cached, never polled. Convex still does not
publish the exact metering formula (wall-clock vs CPU time, whether fetch
wait counts), so every guard is sized for the worst case: wall time × the
runtime footprint. The daily-average budget (20 GB-h ÷ 30) is ≈ 38,400
Convex-runtime action-seconds (or ≈ 4,800 Node-runtime action-seconds) per
day for EVERY action in the app combined.

| Poller (action) | Trigger | Guard | Real fan-outs/day (was → now) |
|---|---|---|---|
| `marketData.fetchAggregatedSnapshot` — 9+ parallel source fetches | Scanner / Sniper / Landing live feed, 15 s tick | shared per-chain 60 s gate (`src/lib/poller-gate.ts`); first load, mount boot and the operator's manual rescan bypass | 5,760 → ≤1,440 per open tab+chain |
| `tokenDiscovery.discoverTokens` — 10+ API pipeline | discovery panel poll | default cadence 30 s → 120 s + shared 120 s gate; filter changes and manual refresh bypass | 2,880 → ≤720 per open tab |
| `copier.pollChannels` — 2 Telegram pulls (+ Bot API fallback) | 3 bot panels at 30 s + the server cron | shared 60 s gate across ALL panels + 5-minute outage cooldown + fetch timeouts 12 s → 6 s. The cron (every 3 min) is the ungated primary pumper | 2,880 → ≤1,440 per open tab |
| `notifications.telegramTradeAlert` | one per REAL execution (scheduled) | none needed — ~0.3 s × executions/day ≈ <0.01 GB-h/day even at 500 trades | event-driven |

Typical month with the app open 24/7: market ≤ 1.5 GB-h + discovery
≤ 1.5 GB-h + copier (cron + client) ≤ 1.5 GB-h + alerts ≈ **4–6 GB-h —
comfortably inside the 20 GB-h allowance**. Worst case (every fetch pinned
at its timeout cap, all month): ≈ 13 GB-h — still inside. The other half of
the defense is failure behavior: any total upstream failure (Telegram or
the DEX APIs unreachable) stretches the client gate to a 5-minute cooldown,
so a dead upstream costs ~12 action runs/hour, not ~120.

The purging half (see the retention section) keeps the TABLES these pollers
write flat — `copierSignals` 6 h TTL + 12 h backstop, telegram signal
history 7 days, notifications 30 days — so their subscription and storage
costs stay flat too. The market and discovery pollers write no persistent
state at all (their results are returned to the caller, never stored), so
they add zero storage and zero purge surface.

## Support

- WhatsApp: Contact operator via the in-app button
- Issues: GitHub Issues

---

Built by [SHCS Tech](https://shcstechy.com)
