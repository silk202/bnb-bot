import {
  BACKEND_PAUSED_MESSAGE,
  clearBackendOutage,
  isBackendPausedError,
  markBackendOutage,
  probeBackendRecovered,
} from "@/lib/backend-outage";
import { Loader2, RefreshCw, ZapOff } from "lucide-react";
import { Component, useEffect, useState, type ReactNode } from "react";

const RECOVERY_PROBE_MS = 15000;

/**
 * BackendPausedBoundary — swaps the raw "Preview runtime error" debug wall
 * for a calm, branded standby screen when a Convex render error is the known
 * backend-paused failure (free-plan serving disable). Genuine app bugs are
 * re-thrown and bubble to the regular error boundary above this one.
 *
 * Self-healing: the standby screen probes the deployment on a light interval
 * (plus a manual retry button); the moment it serves again the screen resets
 * the boundary and the app renders whole — no redeploy needed.
 */
export class BackendPausedBoundary extends Component<
  { children: ReactNode },
  { paused: boolean }
> {
  state = { paused: false };

  static getDerivedStateFromError(error: unknown) {
    if (isBackendPausedError(error)) return { paused: true };
    // Not the known outage class — propagate to the real error boundary.
    throw error;
  }

  componentDidCatch(err: unknown) {
    console.warn(
      "[FlashBolt] Backend paused — degraded standby state rendered:",
      err instanceof Error ? err.message : err,
    );
  }

  render() {
    if (this.state.paused) {
      return (
        <BackendPausedScreen
          onRecovered={() => this.setState({ paused: false })}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Full-page standby screen. Also usable directly (e.g. while an auth boot
 * spinner would otherwise spin forever during the outage). Marks the global
 * outage flag on mount, probes for recovery, and reports back via
 * `onRecovered` so a boundary can un-degrade itself.
 */
export function BackendPausedScreen({
  onRecovered,
}: {
  onRecovered?: () => void;
}) {
  useEffect(() => {
    markBackendOutage();
  }, []);

  const [probing, setProbing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const probe = async () => {
      const recovered = await probeBackendRecovered();
      if (cancelled) return;
      if (recovered) {
        clearBackendOutage();
        onRecovered?.();
        return; // recovered — stop probing
      }
      timer = window.setTimeout(probe, RECOVERY_PROBE_MS);
    };
    timer = window.setTimeout(probe, RECOVERY_PROBE_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onRecovered]);

  const retryNow = async () => {
    setProbing(true);
    const recovered = await probeBackendRecovered();
    if (recovered) {
      clearBackendOutage();
      onRecovered?.();
      return;
    }
    setProbing(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10">
          <ZapOff className="size-6 text-amber-500" />
        </div>
        <p className="mt-5 text-lg font-bold tracking-tight">
          Flash<span className="text-primary">Bolt</span> is on standby
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {BACKEND_PAUSED_MESSAGE}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span>Reconnecting automatically…</span>
        </div>
        <button
          type="button"
          onClick={retryNow}
          disabled={probing}
          className="mt-5 inline-flex items-center gap-2 rounded-full border border-border/60 px-5 py-2.5 text-sm font-semibold text-foreground transition-all hover:bg-muted disabled:opacity-60"
        >
          {probing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Try again now
        </button>
      </div>
    </main>
  );
}

/**
 * Compact variant for routes that stay mounted (auth-gated terminals): shows
 * above the page shell when the backend is known to be paused, without
 * hiding the layout chrome the user is already in.
 */
export function BackendPausedNotice() {
  return (
    <div className="mx-auto mt-4 w-full max-w-3xl px-4">
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <ZapOff className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Backend on standby</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {BACKEND_PAUSED_MESSAGE}
          </p>
        </div>
      </div>
    </div>
  );
}
