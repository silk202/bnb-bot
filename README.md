# FlashBolt

Dual-chain flash-loan arbitrage terminal — **BNB Chain** and **Solana**. Scan
real multi-DEX spreads from live DexScreener data, run 24/7 server-side
engines, copy Telegram signals into executable routes, and flip to live mode
to send real transactions from your own wallet: on BNB through your deployed
`FlashBoltArbitrage.sol`, on Solana through real Jupiter two-leg routes with
Jito-protected submission. Nothing in any feed is simulated, in paper or live
mode; flash-loan lenders rotate every scan run and keys never leave your
wallet (extension) or your browser tab (import vault, AES-256-GCM).

## Overview

This project uses the following tech stack:
- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- Convex (for backend & database)
- Convex Auth (for authentication)
- Framer Motion (for animations)

All relevant files live in the 'src' directory.

Use bun for the package manager.

## Subsystems

Both chains run the same five-subsystem stack, independently gated:

- **Scanner (BNB / SOL)** — live cross-venue route feed, guard stack (daily
  targets → profit floor → lender fee → execution), auto-execute, honey-pot
  alerts.
- **Sniper (BNB / SOL)** — new-pair sniping with per-chain daily limits,
  auto/manual modes and a live position manager (target/trail exits).
- **Telecopier (BNB / SOL)** — Telegram signal copier: channel polling →
  real cross-venue spread pricing → LIVE ROUTE FEED routes.
- **Flasher / Contract (BNB / SOL)** — contract arming + on-chain execution:
  PancakeSwap flash loans on BNB; real two-leg Jupiter routes on SOL, where
  the wallet fronts the clip — wallet-fit sizing lands an oversized signal as
  a smaller real trade (min clip 0.05 SOL, floor matched in Strategy).
- **Wallets / vaults (BNB / SOL)** — EIP-1193 and injected Solana extensions,
  plus passphrase-sealed import vaults (AES-256-GCM, PBKDF2-SHA-256 310k,
  tab-only), watch-only addresses, recovery sheets and clean-slate removal.

Plus the shared surfaces: the **Trade terminal** (deposits/withdrawals, Earn,
internal transfers), the **TAEngine Telegram bot** (24/7 console, per-chain
engines, digests, trade alerts), the **access gate + operator console**,
**desktop app licensing**, the **support assistant** (knowledge base + AI
fallback) and the **scanner overlay** browser extension.

## Setup

This project is set up already and running on a cloud environment, as well as a convex development in the sandbox.

## Runbook — one-command setup (fresh copy)

The mirror zip (`mirror-vX.Y.Z.zip`) is a complete, self-contained copy of
this project. To stand up a fresh FlashBolt from it:

**macOS / Linux**

```bash
unzip mirror-vX.Y.Z.zip
cd mirror
bun run setup          # installs deps, provisions its own Convex backend
bun run dev
```

**Windows**

```powershell
unzip mirror-vX.Y.Z.zip
cd mirror
bun run setup:win
bun run dev
```

Or manually:

```bash
bun install
bunx convex dev --once   # creates a NEW Convex deployment + writes VITE_CONVEX_URL
bun run dev
```

The setup script is non-destructive: it never edits `.env` files, never
overwrites existing settings and never deploys to production.

## Environment Variables

Client side (`.env.local` / the platform Keys tab): `VITE_CONVEX_URL` (the
deployment the app talks to) and optional `COPIER_SIGNALS_URL` (stamps the
daily-target gate endpoint into the overlay artifacts).

The Convex backend has its own set, configured on the deployment
(`bunx convex env set <NAME>`):

- **Auth (required):** `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL` — point
  `SITE_URL` at the app's public URL; it drives auth redirects.
- **Telegram:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (TAEngine bot and
  the TASignal alert channel).
- **Email:** `RESEND_API_KEY` + `RESEND_FROM` (live transactional email;
  without it code emails fall back to the OTP relay), `BREVO_API_KEY`,
  `CARTESIA_API_KEY` (alternative mail/voice providers).
- **AI support:** `SAMBANOVA_API_KEY` (chatbot answers via the free Llama
  3.3 70B tier; the KB answers still work without it).
- **Other:** `BSCSCAN_API_KEY` (Verify & Publish), `GATE_ENC_KEY` (64-hex AES
  key for the operator passphrase — defaults to a SHA-256 of
  `JWT_PRIVATE_KEY`, then a generated server-side key), and the
  platform-provided `VLY_INTEGRATION_KEY` / `VLY_INTEGRATION_BASE_URL` /
  `VLY_CONVEX_AUTH_ISSUER` / `VLY_APP_NAME`.

All optional keys degrade to "disabled" honestly when absent.
`CONVEX_SITE_URL` is a built-in per-deployment variable — never set it by
hand.

### Gate (first page) — access model

`/` is the access gate: the terminal operator dashboard and the subscriber
passcode dashboard, with the subscribe thumbnail in between. The landing page
lives at `/home` and only opens after a valid operator login or subscriber
passcode (72-hour expiry, one unique `FB-XXXX-XXXX` passcode per email, stored
in the backend). The operator console exposes block/unblock/change/update per
passcode, a trigger arrow to email a passcode to one subscriber at a time, and
an immutable audit log. Auth sign-up requires the same email address used at
subscription, and "Continue as Guest" appears only for the terminal operator.

## Deploying on your own domain

No domain is hardcoded in the app. To run this project on a new domain:

1. Provision your own Convex deployment: `bunx convex dev --once` creates one and
   writes the client `VITE_CONVEX_URL`.
2. Set the backend env vars on that deployment — `JWKS`, `JWT_PRIVATE_KEY`, and
   `SITE_URL` (point `SITE_URL` at your new domain; it drives auth redirects).
3. `bun run build`, then host `dist/` on your domain.

## CLI — every command you need

| Command | What it does |
|---------|--------------|
| `bun run dev` | Vite dev server |
| `bun run build` | Production build (typecheck + overlay artifacts + bundle) |
| `bun run typecheck` / `bun run test` | `tsc -b --noEmit` / full Bun test suite |
| `bun run verify` | Release gate: typecheck + tests + overlay artifacts + fresh drill report |
| `bun run convex:dev` | Convex codegen + push (`--once`, non-interactive) |
| `bun run overlay` | Rebuild scanner-overlay userscript + extension bundles |
| `bun run package:mirror` | Write `mirror-v<version>.zip` + self-verify sync |
| `bun run source:package` | Package source zip/tar for download |
| `bun run git:sync` | Pre-flight gate → commit → push to every configured remote |
| `bun run deploy:vercel` / `deploy:netlify` / `deploy:cloudflare` / `deploy:render` | One-command deploys |
| `bun run drill:all` / `drill:report` / `check:drill` | Live end-to-end drills + the release-gate artifact |
| `bun run setup` / `setup:win` | Fresh-copy setup (deps + Convex provisioning) |

## Deployment platforms (Vercel · Netlify · Cloudflare Pages · Render)

`dist/` is a static SPA — the repo ships first-class configs for all four:

- **Vercel** — `vercel.json` (SPA rewrites with real-file exclusions, cache
  and security headers); `bun run deploy:vercel`
- **Netlify** — `netlify.toml` (build, SPA redirect, headers);
  `bun run deploy:netlify`
- **Cloudflare Pages** — `wrangler.toml` + `public/_headers`;
  `bun run deploy:cloudflare`
- **Render** — `render.yaml` (static site, rewrites, headers);
  `bun run deploy:render`

Set `VITE_CONVEX_URL` in each platform's environment variables. The private
GitHub repository itself (bidirectional sync) is managed from the Freebuff
dashboard → Settings → GitHub Sync; `bun run git:sync` pushes to every
configured remote (origin, render, …) in one step. Full walkthroughs live in
`DEPLOYMENT.md`.

## Downloads & desktop apps

- **Mirror** — `bun run package:mirror` writes `mirror-v<version>.zip`: a
  complete, self-contained copy of the project (runbook above).
- **Source** — `bun run source:package` writes
  `public/downloads/flashbolt-source.zip/.tar.gz`, served by the app itself at
  `/downloads/flashbolt-source.zip` and linked from the account menu
  (**Download source**, operator/guest only). One folder
  (`flashbolt-v<version>/`) with the root configs, `src/` and `src/convex/` —
  enough to run locally or self-host. No GitHub involved.
- **Desktop apps** (Linux / macOS / Windows) — download from `/download`
  (passphrase-gated), run the installer, then activate with your subscriber
  email + activation password. Activation is verified server-side (the
  licenses table) and the app stays licensed permanently; Windows CLI
  activation uses `scripts/flashbolt-windows.ps1`. Details:
  `DEPLOYMENT.md` → Desktop Apps.

## Telegram bot — TAEngine

The TAEngine bot runs the 24/7 console independent of the app being open:
`/start` boots the full fleet (both chains' scanner + sniper engines, each
respecting its own per-chain switch) and `/engines` shows the live board of
all four engines with honest freshness stamps (which driver ran the last
pass and how long ago). Trade/session alerts go to the TASignal channel
(`TELEGRAM_CHAT_ID`); commands, fanout and digests go only to linked operator
chats. The webhook self-heals every 10 minutes (and on every dialog open) —
`getWebhookInfo` must show the serving deployment's own
`.convex.site/api/telegram/webhook` URL.

## Responsiveness

The terminal is mobile-first: every page and dialog is laid out for phone
widths first (stacked cards, scrollable dialogs, touch-sized controls) and
scales up to wide desktops inside a centered max-width container. Both
terminals (BNB and SOL) are fully usable from mobile web; the overlay
extension covers desktop browsers, and the PWA manifest
(`public/manifest.webmanifest`) allows install-to-home-screen.

## Live mode — real on-chain execution

Paper mode never moves real BNB. Live mode sends genuine flash-loan
transactions from your own deployment of `FlashBoltArbitrage.sol` through
your connected wallet (EIP-1193). Nothing is simulated at any point.

1. **Deploy the contract.** Copy the source from the Contract page (or the
   `FlashBoltArbitrage.sol` block below it) into Remix or Hardhat. The
   constructor takes the PancakeSwap V2 Router02 address:

   - Mainnet (chain 56): `0x10ED43C718714eb63d5aA57B78B54704E256024E`
   - Testnet (chain 97): `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`

2. **Arm the deployment.** On the terminal's Contract page, switch to your
   network (mainnet/testnet), paste the deployed contract address and press
   "Arm live deployment". The router defaults to the official address for
   the selected network.

3. **Connect a wallet.** Open the Wallets page and connect MetaMask, Trust,
   OKX or Binance Wallet. Keys never leave your extension.

4. **Flip to Live on chain.** The Bot page (or the Overview status bar)
   unlocks Live once a contract is armed. The wallet is switched to the
   selected network automatically.

5. **Execute from the Scanner.** In live mode the Execute button builds
   `execute(address[],uint256)` calldata from the live feed's real token
   addresses, submits the tx via your wallet (1 BNB flash loan), polls the
   receipt and records the outcome —   success (profit auto-paid when
   auto-payout is on) or reverted (recorded as Failed, tx hash linkable from
   History). MEV guard and profit-floor checks still gate what reaches the
   button.

### Solana live mode (SOL terminal)

No on-chain borrowed principal: the wallet fronts the clip, so the engine
runs a live `getBalance` pre-flight and **fits oversized signals down to what
the wallet can actually front** (balance − 0.005 SOL fee/rent reserve, floor
0.05 SOL) — a real, smaller two-leg Jupiter route lands instead of a doomed
Phantom popup. Both legs are quoted, built and simulated before any
broadcast, submitted through the Jito block-engine (revert-protected) or the
public RPC, and confirmed on-chain; the sell leg only fires after the buy
confirms. Imported vault wallets sign in-process with no extension popup;
connected extensions sign in the wallet. Every number in the outcome and the
ledger is real, and refusals carry the exact top-up math.

## Testnet deploy runbook (BNB Chain testnet)

Practice the whole live flow risk-free with test BNB. Nothing here is
simulated — the feed still reads real DexScreener prices and every execution
is a genuine testnet transaction.

> **Automated end-to-end proof:** the live-path drills exercise the real
> execution path (vault → signing → funding → broadcast → swap) against the
> test networks — addresses, funding runbook and the honest-failure contract
> are documented in **[DRILLS.md](DRILLS.md)** (`bun run drill:all`).

1. **Get test BNB.** Use the official BNB Chain testnet faucet
   (https://www.bnbchain.org/en/testnet-faucet) and send a small amount of
   test BNB to your wallet.

2. **Switch the terminal to testnet.** On the Contract page, tap "BNB
   Testnet" in the Deployment target card. The RPC, explorer and router all
   follow — PancakeSwap V2 Router02 on testnet (chain 97) is
   `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`.

3. **Deploy the contract.** Copy `FlashBoltArbitrage.sol` (Contract page)
   into Remix, set the compiler to ^0.8.20, and deploy with the testnet
   router address as the constructor argument. Or with Hardhat:
   `npx hardhat run scripts/deploy.js --network testnet`.

4. **Arm the deployment.** Paste the deployed testnet address into "Live
   deployment" and press "Arm live deployment". The router field keeps the
   testnet Router02 default.

5. **Connect a wallet + flip Live.** Connect your wallet on the Wallets page
   (the wallet is asked to switch to chain 97), then flip to "Live on chain"
   from the Bot page or the Overview status bar — it unlocks now that a
   contract is armed.

6. **Execute on the Scanner.** Press Execute on a live route. The tx is sent
   through your wallet against the testnet contract: borrow, sweep, repay and
   payout all happen on-chain; History links the tx hash on
   testnet.bscscan.com.

## Packaging & releases

Keep the mirror copy 100% in sync with the live app:

```bash
bun run verify                      # release gate: typecheck + tests + overlay artifact checks
bun run package:mirror              # writes mirror-v<version>.zip, then self-verifies
VERSION=2.0.0 bun run package:mirror # explicit version
bun run check:mirror                # verify an existing mirror is still in sync
```

The zip contains the full source tree under `mirror/` (src, convex, libs,
configs, README, CHANGELOG, bun.lock) with node_modules, .git, secrets
(`.env*`) and artifacts excluded. The version is stamped into `package.json`
and shown as `v<version>` on the Contract page — bump both together for a
release.

`package:mirror` runs the release guard (`scripts/check-mirror-sync.sh`)
after packaging: it fails loudly whenever `src/`, `package.json`,
`CHANGELOG.md`, `README.md` or `scripts/` drift from the live source, or when
forbidden contents leak into the zip. Run it standalone with `bun run
check:mirror`.

Run the unit suite with `bun test` (calldata encoding, amount-out math,
route detection, lender rotation — real fixtures, no mocks). Every release:
bump `package.json` + `CHANGELOG.md`, `bun run overlay`, then `bun run
verify` — the version-sync test pins both overlay generators to the app
version, and the gate script re-checks the built artifacts. Full walkthrough:
**Release checklist** in `DEPLOYMENT.md`.

Sync everything to git in one step with `bun run git:sync` (pre-flight
typecheck + tests, commit, push to every configured remote — origin, Render,
etc.). The private GitHub repository itself and its automatic bidirectional
sync are managed on the Freebuff dashboard → Settings → GitHub Sync; the
in-app mirror lives at `/terminal/settings` (operator only).

### Version history

- **v2.9.0** — free-plan budget hardening + daily data retention: engine loops at 180 s with a 5-min heartbeat window (calls/day ≈ 23k → ~6–8k), indexed operator resolution and bounded reads everywhere (no more full-table collects on hot paths), materialized `pnlStats` + cached fleet metrics (the 6 MB executions rescan per trade and 94 KB aggregate scan per digest are gone), one shared client bump-throttle, and a `daily-retention` cron that keeps ONLY essential data (bell history 30 d, paper trades 30 d with totals preserved, signal log 7 d, expired OTPs, dead rate-limit windows, TTS cache + blobs) while the trade ledger, live on-chain rows, accounts and licenses stay permanent — enforced by a 30,000 calls/day usage limit and a 1 GB/day DB-I/O stop.
- **v2.8.0** — release-sync maintenance pass; wallet-fit execution (oversized SOL signals land as smaller real trades), funding made one-glance on the Wallets pages (full address copy + live balance), clean-slate vault removal on both chains, SOL min loan 0.05 (strategy floor = wallet-fit floor), support-assistant SOL + funding coverage, graceful backend-standby mode, TAEngine `/engines` board + full-console `/start`, free-tier circuit breakers (400K→800K calls diet + monthly disable limits).
- **v2.7.0** — SOL Flasher session stats + SOL scan sync.
- **v2.6.0** — subscriber daily target limit (server-enforced, shared by snipes and both flash terminals).
- **v2.1.0** — real-time Telegram session signals (15-minute live session dashboard on the channel).
- **v2.0.0** — access gate first page (operator + subscriber dashboards, subscribe popup), password auth with strong-password rules + email OTP, encrypted operator passphrase, 72h passcode engine with block/unblock/change/update + trigger resend, audit log, live email (Resend + relay fallback)
- **v1.9.0** — support ticket escalation + polished chat (copy/timestamps)
- **v1.8.0** — AI-backed support (SambaNova) + persisted chat history + bigger knowledge base
- **v1.7.0** — support assistant + UTC world clock + top-bar redesign
- **v1.6.0** — per-chain deployments + private RPC overrides + Telegram
  alerts; every chain arms its own contract and keeps its own DEX whitelist.
- **v1.5.0** — multi-chain scanner (BNB Chain, Ethereum, Arbitrum, Polygon
  with real per-chain DexScreener ids, quote tokens, RPCs, routers and
  chain-scoped flash-loan lenders), notification center bell (real execution
  + honey-spot events), Verify & Publish via the real BscScan API with a
  flattened source (BSCSCAN_API_KEY) and an honest manual-wizard fallback.
- **v1.4.0** — one-click deploy from the Contract page (real wallet-signed
  contract creation with the compiled bytecode, receipt polling and
  auto-arm), real PnL analytics on the Overview (net of documented lender
  fees and actual gas paid per receipt), on-chain receipts in History
  (status / block / gas fetched from the BNB RPC with BscScan links).
- **v1.3.0** — Lender balancer v (low-fee lenders prioritized by documented
  protocol fees), honey-spot scanner (high profit + high liquidity filter),
  real auto-compile (solc 0.8.20 in a Web Worker against real OZ/Uniswap
  sources), always-on profit guard (only profitable executions, paper + live),
  world clock top-right on every page, © Power by SHCS footer.
- **v1.2.0** — release guard script (fails on mirror drift), Contract page
  deploy helper (faucet link + copyable Router02/Hardhat commands), unit
  tests for chain + route logic, honest WBNB fallback (no hardcoded $592).
- **v1.1.1** — anti-fabrication: simulated wallet fallback removed, seeded
  PnL/scan/opportunity counters zeroed, no synthetic PnL curve or hardcoded
  price, testnet deploy runbook added.
- **v1.0.0** — baseline mirror of the FlashBolt terminal (paper + live modes,
  auto-payout, mainnet/testnet switch, dark/light theme, © Powered by SHCS
  footer on every page).
- **v1.1.0** — real live-mode execution path (viem calldata builder, wallet
  tx + receipt polling, deployed-contract arming on the Contract page, tx
  hashes in History), simulation-free feeds (lender rotation per run, no
  fabricated prices or counters), theme-aware 404 page.


# Using Authentication (Important!)

You must follow these conventions when using authentication.

## Auth is already set up.

All convex authentication functions are already set up. The auth currently uses email OTP and anonymous users, but can support more.

The email OTP configuration is defined in `src/convex/auth/emailOtp.ts`. DO NOT MODIFY THIS FILE.

Also, DO NOT MODIFY THESE AUTH FILES: `src/convex/auth.config.ts` and `src/convex/auth.ts`.

## Using Convex Auth on the backend

On the `src/convex/users.ts` file, you can use the `getCurrentUser` function to get the current user's data.

## Using Convex Auth on the frontend

The `/auth` page is already set up to use auth. Navigate to `/auth` for all log in / sign up sequences.

You MUST use this hook to get user data. Never do this yourself without the hook:
```typescript
import { useAuth } from "@/hooks/use-auth";

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth();
```

## Protected Routes

The `/terminal` route (the FlashBolt paper-trading terminal) is protected with
`RequireAuth`, which sends signed-out users to `/auth?returnTo=<current route>`.
Reuse `RequireAuth` when adding another protected route.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`.

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, you can use the `useAuth` hook to get the current user's data and authentication state.

You should also be protecting queries, mutations, and actions at the base level, checking for authorization securely.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.
- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.


## Landing Pages

You must always create good-looking designer-level styles to your application. 
- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.


### Other Items to animate
- Fade in and Fade Out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead. 

# Using the Convex backend

You will be implementing the convex backend. Follow your knowledge of convex and the documentation to implement the backend.

## The Convex Schema

You must correctly follow the convex schema implementation.

The schema is defined in `src/convex/schema.ts`.

Do not include the `_id` and `_creationTime` fields in your queries (it is included by default for each table).
Do not index `_creationTime` as it is indexed for you. Never have duplicate indexes.


## Convex Actions: Using CRUD operations

When running anything that involves external connections, you must use a convex action with "use node" at the top of the file.

You cannot have queries or mutations in the same file as a "use node" action file. Thus, you must use pre-built queries and mutations in other files.

You can also use the pre-installed internal crud functions for the database:

```ts
// in convex/users.ts
import { crud } from "convex-helpers/server/crud";
import schema from "./schema.ts";

export const { create, read, update, destroy } = crud(schema, "users");

// in some file, in an action:
const user = await ctx.runQuery(internal.users.read, { id: userId });

await ctx.runMutation(internal.users.update, {
  id: userId,
  patch: {
    status: "inactive",
  },
});
```


## Common Convex Mistakes To Avoid

When using convex, make sure:
- Document IDs are referenced as `_id` field, not `id`.
- Document ID types are referenced as `Id<"TableName">`, not `string`.
- Document object types are referenced as `Doc<"TableName">`.
- Keep schemaValidation to false in the schema file.
- You must correctly type your code so that it passes the type checker.
- You must handle null / undefined cases of your convex queries for both frontend and backend, or else it will throw an error that your data could be null or undefined.
- Always use the `@/folder` path, with `@/convex/folder/file.ts` syntax for importing convex files.
- This includes importing generated files like `@/convex/_generated/server`, `@/convex/_generated/api`
- Remember to import functions like useQuery, useMutation, useAction, etc. from `convex/react`
- NEVER have return type validators.
