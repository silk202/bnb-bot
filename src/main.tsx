import '@vly-ai/integrations';
import { api } from "@/convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { BackendPausedBoundary } from "@/components/BackendPausedBoundary";
import { setBackendRecoveryProbe } from "@/lib/backend-outage";
import { GateGuard } from "@/components/GateGuard";
import { RequireAuth } from "@/components/RequireAuth";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { RefreshCw } from "lucide-react";
import { ThemeProvider } from "next-themes";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { installConvexFetchRetry } from "@/lib/convex-fetch-resilience";
import { resolveConvexUrl } from "@/lib/convex-url";

// Install the Convex-backend fetch retry BEFORE any Convex client boots —
// this is what fixes the preview's "TypeError: Failed to fetch" build error
// from the auth handshake's unauthenticatedCall hitting a transient proxy
// drop. See src/lib/convex-fetch-resilience.ts for the full rationale.
installConvexFetchRetry();

// Lazy load route components for better code splitting.
//
// retryableLazy: the platform's preview proxy can transiently time out (504)
// on a cold-start module fetch — the very first request after the dev server
// relaunches can exceed the gateway timeout. A plain React.lazy import that
// fails once would reject and trip the error boundary ("Preview runtime error:
// Failed to fetch dynamically imported module"). Retrying with a capped
// exponential backoff lets the fetch land once Vite's transform cache is
// warm. Combined with warmRouteModules() below (which prefetches every route
// chunk at startup), the cold-start flake is removed at the source: by the
// time the user passes the gate and navigates, the chunk is already cached.
function retryableLazy<T extends React.ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  retries = 6,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await importFn();
      } catch (err) {
        lastError = err;
        // Capped exponential backoff: 500ms, 1s, 2s, 4s, 4s, …
        await new Promise((r) =>
          setTimeout(r, Math.min(4000, 500 * 2 ** attempt)),
        );
      }
    }
    throw lastError;
  });
}

// Every route chunk, in the same order the lazy components above load them.
// Warming runs AFTER first paint so it never competes with the gate page's
// own boot fetch — it just makes sure each module is transformed and cached
// by the dev server before the user can navigate to it.
const ROUTE_MODULES: Array<() => Promise<unknown>> = [
  () => import("./pages/Landing.tsx"),
  () => import("./pages/Gate.tsx"),
  () => import("./pages/Auth.tsx"),
  () => import("./pages/terminal/TerminalLayout.tsx"),
  () => import("./pages/terminal/Overview.tsx"),
  () => import("./pages/terminal/Scanner.tsx"),
  () => import("./pages/terminal/Strategy.tsx"),
  () => import("./pages/terminal/Wallets.tsx"),
  () => import("./pages/terminal/Contract.tsx"),
  () => import("./pages/terminal/History.tsx"),
  () => import("./pages/terminal/Bot.tsx"),
  () => import("./pages/terminal/Sniper.tsx"),
  () => import("./pages/terminal/Signals.tsx"),
  () => import("./pages/terminal/Settings.tsx"),
  () => import("./pages/terminal/SolTerminalLayout.tsx"),
  () => import("./pages/terminal/SolOverview.tsx"),
  () => import("./pages/terminal/SolScanner.tsx"),
  () => import("./pages/terminal/SolBot.tsx"),
  () => import("./pages/terminal/SolSniper.tsx"),
  () => import("./pages/terminal/SolStrategy.tsx"),
  () => import("./pages/terminal/SolWallets.tsx"),
  () => import("./pages/terminal/SolContract.tsx"),
  () => import("./pages/terminal/SolHistory.tsx"),
  () => import("./pages/Downloads.tsx"),
  () => import("./pages/trade/TradeLayout.tsx"),
  () => import("./pages/trade/TradeHome.tsx"),
  () => import("./pages/trade/TradeMarkets.tsx"),
  () => import("./pages/trade/TradePage.tsx"),
  () => import("./pages/trade/TradeEarn.tsx"),
  () => import("./pages/trade/TradeWallet.tsx"),
  () => import("./pages/NotFound.tsx"),
];

/** Fetch one route module, retrying through cold-start proxy timeouts. */
async function warmModule(
  load: () => Promise<unknown>,
  attempts = 5,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await load();
      return;
    } catch {
      // A failed warm fetch still pushes Vite to finish the transform in the
      // background, so even this path usually warms the cache; keep trying
      // with backoff until the module actually resolves.
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Prefetch every lazy route chunk after first paint so the dev-server
 * transform cache is warm before the user navigates — this removes the
 * "Failed to fetch dynamically imported module" cold-start crash instead of
 * just retrying it at navigation time.
 */
function warmRouteModules(): void {
  for (const load of ROUTE_MODULES) {
    void warmModule(load);
  }
}

const Gate = retryableLazy(() => import("./pages/Gate.tsx"));
const Landing = retryableLazy(() => import("./pages/Landing.tsx"));
const AuthPage = retryableLazy(() => import("./pages/Auth.tsx"));
const TerminalLayout = retryableLazy(() => import("./pages/terminal/TerminalLayout.tsx"));
const Overview = retryableLazy(() => import("./pages/terminal/Overview.tsx"));
const Scanner = retryableLazy(() => import("./pages/terminal/Scanner.tsx"));
const Strategy = retryableLazy(() => import("./pages/terminal/Strategy.tsx"));
const Wallets = retryableLazy(() => import("./pages/terminal/Wallets.tsx"));
const Contract = retryableLazy(() => import("./pages/terminal/Contract.tsx"));
const History = retryableLazy(() => import("./pages/terminal/History.tsx"));
const Bot = retryableLazy(() => import("./pages/terminal/Bot.tsx"));
const Sniper = retryableLazy(() => import("./pages/terminal/Sniper.tsx"));
const Signals = retryableLazy(() => import("./pages/terminal/Signals.tsx"));
// Operator-only Settings (GitHub Sync etc.) — shared by both terminals.
const Settings = retryableLazy(() => import("./pages/terminal/Settings.tsx"));
const SolTerminalLayout = retryableLazy(
  () => import("./pages/terminal/SolTerminalLayout.tsx"),
);
const SolOverview = retryableLazy(() => import("./pages/terminal/SolOverview.tsx"));
const SolScanner = retryableLazy(() => import("./pages/terminal/SolScanner.tsx"));
const SolBot = retryableLazy(() => import("./pages/terminal/SolBot.tsx"));
const SolSniper = retryableLazy(() => import("./pages/terminal/SolSniper.tsx"));
const SolStrategy = retryableLazy(() => import("./pages/terminal/SolStrategy.tsx"));
const SolWallets = retryableLazy(() => import("./pages/terminal/SolWallets.tsx"));
const SolContract = retryableLazy(() => import("./pages/terminal/SolContract.tsx"));
const SolHistory = retryableLazy(() => import("./pages/terminal/SolHistory.tsx"));
const Downloads = retryableLazy(() => import("./pages/Downloads.tsx"));
// FlashBolt Trade — the exchange terminal (Home/Markets/Trade/Earn/Wallet).
const TradeLayout = retryableLazy(() => import("./pages/trade/TradeLayout.tsx"));
const TradeHome = retryableLazy(() => import("./pages/trade/TradeHome.tsx"));
const TradeMarkets = retryableLazy(() => import("./pages/trade/TradeMarkets.tsx"));
const TradePage = retryableLazy(() => import("./pages/trade/TradePage.tsx"));
const TradeEarn = retryableLazy(() => import("./pages/trade/TradeEarn.tsx"));
const TradeWallet = retryableLazy(() => import("./pages/trade/TradeWallet.tsx"));
const NotFound = retryableLazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Report a runtime error to the backend audit log (diagnostics loop). */
function reportRuntimeError(
  message: string,
  stack?: string,
  source?: string,
) {
  // No deployment configured (the setup screen is showing) — nothing to
  // report to, and a null client must never crash the diagnostics path.
  if (!convex) return;
  try {
    convex
      .mutation(api.gate.reportClientError, {
        message: String(message).slice(0, 1000),
        stack: stack ? String(stack).slice(0, 3000) : undefined,
        source,
      })
      .catch(() => {
        // diagnostics must never break the app
      });
  } catch {
    // noop
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
    reportRuntimeError(err.message || "Unknown error", err.stack, "render-boundary");
  }
  componentDidMount() {
    // Capture errors that escape the React tree (module loads, event handlers).
    const onError = (event: ErrorEvent) => {
      if (event.message) {
        reportRuntimeError(event.message, event.error?.stack, "window-error");
      }
    };
    // Warm the lazy route chunks once the app has painted, so navigating to
    // the landing page (or any terminal page) never hits a cold module fetch.
    const warmTimer = window.setTimeout(warmRouteModules, 1200);
    this._warmTimer = warmTimer;
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      reportRuntimeError(
        reason instanceof Error ? reason.message : "Unhandled promise rejection",
        reason instanceof Error ? reason.stack : undefined,
        "unhandled-rejection",
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.clearTimeout(this._warmTimer);
    };
  }
  private _warmTimer: number | undefined;
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110"
            >
              <RefreshCw className="size-4" />
              Reload preview
            </button>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Reloading after the route chunks have been warmed usually lands
              the page on the first try.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Convex client — VITE_CONVEX_URL is REQUIRED, with no baked-in default.
//
// A development deployment and a production deployment are separate Convex
// entities: different URLs, different backend env vars, different data. A
// hardcoded fallback URL silently pointed every build — including forks and
// self-hosted copies — at whichever deployment the source happened to be
// written against, so a fork would read and write another operator's users,
// grants and signals. Each build therefore declares the deployment it targets.
//
// A missing/blank value used to throw here at module scope, BEFORE React
// mounted and outside the error boundary, leaving a permanently blank page
// with no diagnostic. Now it renders the setup screen below instead.
// Sanitized, not just trimmed: a secret sync can write `' https://…'` into
// .env.local, which a bare trim turns into a quoted URL (blank page, no error).
const envConvexUrl = resolveConvexUrl(import.meta.env.VITE_CONVEX_URL);
const convex: ConvexReactClient | null = envConvexUrl
  ? new ConvexReactClient(envConvexUrl)
  : null;

if (!convex) {
  console.warn(
    "[convex] VITE_CONVEX_URL is not set — this build cannot reach any Convex deployment. " +
      "Set it to THIS environment's deployment URL (dev: .env.local or the managed dev process; " +
      "production: the platform build/CI variable) and rebuild. Dev and production URLs are not interchangeable.",
  );
}

// Backend-outage self-heal: register how the standby screen can detect that
// serving is back. A cheap existing query is the probe — success means the
// paused deployment is serving again (see src/lib/backend-outage.ts).
if (convex) {
  setBackendRecoveryProbe(async () => {
    try {
      await convex.query(api.gate.operatorStatus);
      return true;
    } catch {
      return false;
    }
  });
}

// Shown when no deployment is configured, in place of the app tree.
function MissingConvexUrlScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <div className="max-w-lg">
        <p className="text-sm font-semibold">Backend not configured</p>
        <p className="mt-2 text-sm text-muted-foreground">
          This build has no <code className="font-mono text-xs">VITE_CONVEX_URL</code>, so it
          cannot reach a Convex deployment.
        </p>
        <pre className="mt-4 overflow-auto rounded border border-border/60 p-3 text-left text-[11px] leading-5 text-muted-foreground">
          VITE_CONVEX_URL=https://&lt;deployment&gt;.convex.cloud
        </pre>
        <p className="mt-4 text-xs text-muted-foreground">
          Dev and production are separate Convex deployments with separate URLs and
          separate backend env vars. Point this build at its own deployment —{" "}
          <code className="font-mono text-[11px]">.env.local</code> for local dev, the platform
          Keys panel for a hosted build, or a CI variable — then rebuild.
        </p>
      </div>
    </div>
  );
}



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem={false}
        disableTransitionOnChange
      >
        <ToolbarErrorBoundary>
          <VlyToolbar />
        </ToolbarErrorBoundary>
        {convex ? (
        <BackendPausedBoundary>
        <ConvexAuthProvider client={convex}>
          <BrowserRouter>
            <RouteSyncer />
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                {/* First page: gate (operator + subscriber access) */}
                <Route path="/" element={<Gate />} />
                {/* Second page: the landing page, gated behind access grants */}
                <Route
                  path="/home"
                  element={
                    <GateGuard>
                      <Landing />
                    </GateGuard>
                  }
                />
                {/* Alias: /landing is guarded the same way — without an
                    unlocked gate session it redirects straight back to /. */}
                <Route
                  path="/landing"
                  element={
                    <GateGuard>
                      <Landing />
                    </GateGuard>
                  }
                />
                {/* Public desktop downloads + activation — the setups ship
                    with the app releases on GitHub; activation is password-gated. */}
                <Route path="/download" element={<Downloads />} />
                <Route
                  path="/auth"
                  element={<AuthPage redirectAfterAuth="/terminal" />}
                />
                <Route
                  path="/terminal"
                  element={
                    <RequireAuth>
                      <TerminalLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Overview />} />
                  <Route path="scanner" element={<Scanner />} />
                  <Route path="strategy" element={<Strategy />} />
                  <Route path="wallets" element={<Wallets />} />
                  <Route path="contract" element={<Contract />} />
                  <Route path="history" element={<History />} />
                  <Route path="bot" element={<Bot />} />
                  <Route path="sniper" element={<Sniper />} />
                  <Route path="signals" element={<Signals />} />
                  {/* Operator-only — the route itself renders the operator
                      notice for subscribers; the nav never links here. */}
                  <Route path="settings" element={<Settings />} />
                </Route>
                {/* SOL FlashBolt — the Solana terminal, mirroring /terminal */}
                <Route
                  path="/sol-terminal"
                  element={
                    <RequireAuth>
                      <SolTerminalLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<SolOverview />} />
                  <Route path="scanner" element={<SolScanner />} />
                  <Route path="bot" element={<SolBot />} />
                  <Route path="sniper" element={<SolSniper />} />
                  <Route path="strategy" element={<SolStrategy />} />
                  <Route path="wallets" element={<SolWallets />} />
                  <Route path="contract" element={<SolContract />} />
                  <Route path="history" element={<SolHistory />} />
                  <Route path="signals" element={<Signals />} />
                  {/* Operator-only — same shared Settings page. */}
                  <Route path="settings" element={<Settings />} />
                </Route>
                {/* FlashBolt Trade — the exchange terminal, alongside BNB and
                    SOL FlashBolt. Same RequireAuth gate (operators and
                    subscribers both pass; guests authenticate at /auth). */}
                <Route
                  path="/trade-terminal"
                  element={
                    <RequireAuth>
                      <TradeLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<TradeHome />} />
                  <Route path="markets" element={<TradeMarkets />} />
                  <Route path="trade" element={<TradePage />} />
                  <Route path="earn" element={<TradeEarn />} />
                  <Route path="wallet" element={<TradeWallet />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </ConvexAuthProvider>
        </BackendPausedBoundary>
        ) : (
          <MissingConvexUrlScreen />
        )}
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Boot-success signal for the pre-React loader/watchdog in index.html:
// removes the boot splash and disarms the crash diagnostics. Microtask delay
// guarantees the DOM commit above has flushed first.
queueMicrotask(() => {
  const bootOk = (window as unknown as {
    __flashboltBootOk?: () => void;
  }).__flashboltBootOk;
  if (typeof bootOk === "function") bootOk();
});
