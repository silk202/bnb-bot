import { useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useTradeSounds } from "@/hooks/use-trade-sounds";

/**
 * EnginePulse — the 24/7 engines' audible presence, ANYWHERE in the app
 * (BNB terminal, SOL terminal, FlashBolt Trade — mounted in every shell).
 *
 * While the operator IS in the app, this mirrors the open-scanner experience
 * so there is never a dull moment and never a double driver of sound:
 *
 *   • scan tick — each fresh server rescan of a chain's feed plays the
 *     scanner tick, exactly like the page-open loop (scanner closed? the
 *     engine still narrates itself).
 *   • arb-detection sting + toast — when a rescan surfaces MORE live routes
 *     than the pass before (per chain, from the engines' own stamps).
 *   • execution fills — success/fail sounds + toasts from the live
 *     executions ledger. Shells that already carry the NotificationsBell
 *     (BNB + SOL terminals) handle fills there, so the pulse stays silent
 *     to avoid double-firing; in shells WITHOUT the bell (FlashBolt Trade)
 *     the pulse narrates fills itself — same sounds, same honesty.
 *
 * Everything rides the SAME reactive Convex data the dashboards read — no
 * polling, no fabricated events: a silent engine plays nothing, a running
 * engine narrates itself. Sniper passes are intentionally silent here (the
 * snipers are tactical tools — their fills surface via the ledger/bell and
 * Telegram alerts, never as tick noise).
 */

/** A chain's own Scanner page plays its ticks/stings for the same passes —
 * the OTHER chain's engine audio still narrates (that scanner is closed). */

/** A server stamp newer than this counts as the engine actively driving. */
const SERVER_ONLINE_WINDOW_MS = 90_000;

export function EnginePulse({ withFillNarration = false }: { withFillNarration?: boolean }) {
  const location = useLocation();
  const { playScan, playArbDetected, playSuccess, playFail } = useTradeSounds();

  // Self-sufficient data (no TerminalProvider needed): the same reactive
  // queries the terminal context subscribes to — but the state read is the
  // SLIM engine-pulse projection (this component mounts in every shell; its
  // old full getTerminalState subscription re-delivered the whole terminal
  // doc on every scan stamp). The executions feed is only subscribed when
  // this shell actually narrates fills (limit 0 ⇒ empty, no rows read).
  const state = useQuery(api.terminal.getEnginePulseState);
  const executions = useQuery(api.terminal.listExecutions, {
    limit: withFillNarration ? 30 : 0,
  });
  const settings = useQuery(api.notifications.getTradeNotificationSettings);
  const soundEnabled = settings?.soundEnabled ?? true;

  const pathname = location.pathname;
  const suppressBnb = useMemo(
    () => pathname === "/terminal/scanner" || pathname.startsWith("/terminal/scanner/"),
    [pathname],
  );
  const suppressSol = useMemo(
    () =>
      pathname === "/sol-terminal/scanner" || pathname.startsWith("/sol-terminal/scanner/"),
    [pathname],
  );

  // ── Engine scan ticks + arb stings (reactive: the engines' own stamps) ──
  const bnbOn = state?.botRunning !== false;
  const solOn = state?.solBotRunning !== false;
  const bnbAt = state?.lastScanAt ?? 0;
  const solAt = state?.solLastScanAt ?? 0;
  const bnbServer = state?.lastScanSource === "server";
  const solServer = state?.solLastScanSource === "server";
  const bnbOpp = state?.bnbOpenOpportunities ?? 0;
  const solOpp = state?.solOpenOpportunities ?? 0;

  const lastTickRef = useRef<{ bnb: number; sol: number }>({ bnb: 0, sol: 0 });
  const lastOppRef = useRef<{ bnb: number; sol: number }>({ bnb: 0, sol: 0 });
  const primedRef = useRef(false);

  useEffect(() => {
    // Prime on first state so a page load doesn't blast stale events.
    if (!primedRef.current) {
      if (state) {
        lastTickRef.current = { bnb: bnbAt, sol: solAt };
        lastOppRef.current = { bnb: bnbOpp, sol: solOpp };
        primedRef.current = true;
      }
      return;
    }

    const now = Date.now();
    const chains = [
      { key: "bnb" as const, at: bnbAt, server: bnbServer, on: bnbOn, opp: bnbOpp },
      { key: "sol" as const, at: solAt, server: solServer, on: solOn, opp: solOpp },
    ];
    for (const c of chains) {
      if (c.at <= lastTickRef.current[c.key]) continue;
      const freshServerPass = c.server && c.on && now - c.at < SERVER_ONLINE_WINDOW_MS;
      lastTickRef.current[c.key] = c.at;
      const oppGrew = c.opp > lastOppRef.current[c.key];
      lastOppRef.current[c.key] = c.opp;
      if (!freshServerPass) continue;
      // The chain's own open Scanner page already plays this pass.
      if (c.key === "bnb" ? suppressBnb : suppressSol) continue;

      if (soundEnabled) playScan();
      if (oppGrew) {
        playArbDetected();
        toast.success(
          `${c.key === "sol" ? "SOL" : "BNB"} FlashBolt — ${c.opp} live route${c.opp === 1 ? "" : "s"} on the feed`,
          {
            description: c.on
              ? "The 24/7 engine just rescanned — routes are ready to flash."
              : "Feed rescanned — routes are ready to flash.",
          },
        );
      }
    }
  }, [
    state,
    bnbAt,
    bnbServer,
    bnbOn,
    bnbOpp,
    solAt,
    solServer,
    solOn,
    solOpp,
    soundEnabled,
    suppressBnb,
    suppressSol,
    playScan,
    playArbDetected,
  ]);

  // ── Execution fills — ONLY in shells without the NotificationsBell ──
  // (BNB/SOL terminal shells mount the bell in their top bars; duplicating
  // fill sounds here would double-fire. The Trade shell has no bell, so the
  // pulse narrates its fills with the same sounds + toasts.)
  const prevExecCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (!withFillNarration) return;
    const list = executions ?? [];
    if (prevExecCountRef.current === null) {
      prevExecCountRef.current = list.length;
      return;
    }
    if (list.length <= prevExecCountRef.current) {
      prevExecCountRef.current = list.length;
      return;
    }
    const fresh = list.slice(0, list.length - prevExecCountRef.current);
    prevExecCountRef.current = list.length;
    for (const ex of fresh) {
      // Real row fields (executions table): status is success | blocked |
      // below_floor | failed; the credited amount rides amountBnb; the native
      // unit follows the row's originating chain (solana rows are SOL).
      const chainLabel = ex.chain === "solana" ? "SOL" : "BNB";
      const sym = ex.chain === "solana" ? "SOL" : "BNB";
      if (ex.status === "failed") {
        if (soundEnabled) playFail();
        toast.error(`${chainLabel} engine — flash reverted`, {
          description: `${ex.label} · check History for the revert reason.`,
        });
      } else if (ex.status === "success") {
        if (soundEnabled) playSuccess();
        toast.success(`${chainLabel} engine — flash executed`, {
          description: `+${ex.amountBnb.toFixed(4)} ${sym} · ${ex.label} · profit ${ex.profitPct}%.`,
        });
      } else {
        // blocked (MEV guard) / below_floor (profit floor): honest, quiet.
        toast.info(`${chainLabel} engine — route held back`, {
          description:
            ex.status === "blocked"
              ? `${ex.label} · MEV shield blocked this route.`
              : `${ex.label} · below the profit floor.`,
        });
      }
    }
  }, [withFillNarration, executions, soundEnabled, playSuccess, playFail]);

  return null;
}