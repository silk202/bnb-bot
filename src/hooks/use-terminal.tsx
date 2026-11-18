import { api } from "@/convex/_generated/api";
import {
  claimBump,
  releaseBump,
  CLIENT_BUMP_GAP_MS,
} from "@/lib/bump-throttle";
import { useAction, useMutation, useQuery } from "convex/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAuth } from "./use-auth";

const LIVE_ONLY_KEY = "flashbolt.liveOnly";

function useTerminalHook() {
  const { isAuthenticated, isLoading } = useAuth();
  const state = useQuery(api.terminal.getTerminalState);
  const executions = useQuery(api.terminal.listExecutions, { limit: 200 });
  const pnlSummary = useQuery(api.terminal.pnlSummary);
  const notifications = useQuery(api.notifications.listNotifications, {
    limit: 30,
  });
  const unreadCount = useQuery(api.notifications.unreadNotificationCount);

  const ensureTerminalState = useMutation(api.terminal.ensureTerminalState);
  const rawBumpScan = useMutation(api.terminal.bumpScan);
  // BUDGET THROTTLE — bumpScan is a write (freshness stamp + counters), and
  // every write invalidates each mounted getTerminalState subscription. The
  // cadence timer below, the Scanner page tick and the SOL feed hook all
  // stamp the SAME semantic value, so they coalesce through one shared
  // gate: at most one bump per chain per CLIENT_BUMP_GAP_MS, no matter how
  // many sources ask. Failed bumps release the slot so the next tick retries.
  const bumpScan = useCallback(
    (args?: { count?: number; chain?: "bnb" | "sol" }) => {
      const key = `scan:${args?.chain ?? "bnb"}`;
      if (!claimBump(key, CLIENT_BUMP_GAP_MS)) return Promise.resolve(true);
      return rawBumpScan(args ?? {}).catch((err) => {
        releaseBump(key);
        throw err;
      });
    },
    [rawBumpScan],
  );
  const recordExecution = useMutation(api.terminal.recordExecution);
  const setSettings = useMutation(api.terminal.setSettings);
  const setBotRunning = useMutation(api.terminal.setBotRunning);
  const setMode = useMutation(api.terminal.setMode);
  const connectWallet = useMutation(api.terminal.connectWallet);
  const disconnectWallet = useMutation(api.terminal.disconnectWallet);
  const resetAccount = useMutation(api.terminal.resetAccount);
  const markAllNotificationsRead = useMutation(
    api.notifications.markAllNotificationsRead,
  );
  const recordNotification = useMutation(api.notifications.recordNotification);
  const pingChannels = useAction(api.notifications.pingChannels);
  const saveDeployment = useMutation(api.terminal.saveDeployment);
  const purgeCorruptedSolPaper = useMutation(api.terminal.purgeCorruptedSolPaper);

  // LEDGER SELF-HEAL — once per session, right after auth resolves: purge
  // corrupted SOL paper rows (the stale-mark incident minted phantom
  // six-figure credits). Idempotent: a clean ledger is a silent no-op; a
  // corrupted one is repaired server-side and the operator is told exactly
  // what was reversed. The manual button on the Flasher page stays for
  // explicit re-runs.
  const healedRef = useRef(false);
  useEffect(() => {
    if (healedRef.current || !isAuthenticated || isLoading) return;
    healedRef.current = true;
    void purgeCorruptedSolPaper({})
      .then((res) => {
        if (res && res.removed > 0) {
          toast.success(
            `Ledger self-healed — removed ${res.removed} corrupted paper row${res.removed === 1 ? "" : "s"}`,
            {
              description: `Reversed ${res.reversedSol.toFixed(4)} SOL of phantom credits${
                res.removedNotifications > 0 ? ` · ${res.removedNotifications} bell entries cleaned` : ""
              }.`,
            },
          );
        }
      })
      .catch(() => undefined); // heal is best-effort; the manual button remains
  }, [isAuthenticated, isLoading, purgeCorruptedSolPaper]);

  // GLOBAL "Live only" mode — hides 🧪 SIM (paper) rows across the whole
  // terminal (activity feed + histories). SERVER-PERSISTED on the terminal
  // state (follows the operator across browsers/devices), with the old
  // localStorage value migrated up once and kept as an offline fallback.
  const [liveOverride, setLiveOverride] = useState<boolean | null>(null);
  const serverLiveOnly = state?.liveOnly ?? null;
  // One-time migration: a browser that set the old localStorage flag pushes
  // it to the server when no server value exists yet.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current || serverLiveOnly !== null || state === null) return;
    migratedRef.current = true;
    let local = false;
    try {
      local = window.localStorage.getItem(LIVE_ONLY_KEY) === "1";
    } catch {
      local = false;
    }
    if (local) void setSettings({ liveOnly: true }).catch(() => undefined);
  }, [serverLiveOnly, state, setSettings]);
  const liveOnly = liveOverride ?? serverLiveOnly ?? false;
  const setLiveOnly = useCallback(
    (v: boolean) => {
      setLiveOverride(v); // optimistic — UI reacts instantly
      void setSettings({ liveOnly: v }).catch(() => {
        // Server unreachable: fall back to localStorage so the session view
        // still works; the choice syncs on the next successful save.
        setLiveOverride(null);
        try {
          window.localStorage.setItem(LIVE_ONLY_KEY, v ? "1" : "0");
        } catch {
          /* storage unavailable — view-only fallback */
        }
      });
    },
    [setSettings],
  );

  // Create the user's terminal state document on first use.
  useEffect(() => {
    if (isAuthenticated && !isLoading && state === null) {
      ensureTerminalState().catch(() => undefined);
    }
  }, [isAuthenticated, isLoading, state, ensureTerminalState]);

  // Scan loop — advances only while the bot is running.
  useEffect(() => {
    if (!state?.botRunning) return;
    const cadenceMs = (state.cadence ?? 15) * 1000;
    const timer = setInterval(() => {
      bumpScan({}).catch(() => undefined);
    }, cadenceMs);
    return () => clearInterval(timer);
  }, [state?.botRunning, state?.cadence, bumpScan]);

  return {
    state,
    executions,
    pnlSummary,
    notifications,
    unreadCount,
    loading: isLoading || (isAuthenticated && state === undefined),
    ensureTerminalState,
    bumpScan,
    recordExecution,
    setSettings,
    setBotRunning,
    setMode,
    connectWallet,
    disconnectWallet,
    resetAccount,
    markAllNotificationsRead,
    recordNotification,
    pingChannels,
    saveDeployment,
    liveOnly,
    setLiveOnly,
  };
}

type TerminalContextValue = ReturnType<typeof useTerminalHook>;

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const value = useTerminalHook();
  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminal(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error("useTerminal must be used within a TerminalProvider");
  }
  return context;
}
