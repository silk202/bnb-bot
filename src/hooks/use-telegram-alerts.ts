/**
 * useTelegramAlerts — fires Telegram channel alerts for key scanner
 * and flash-loan events via the existing Convex pingChannels action.
 *
 * The Telegram channel carries:
 *   1. Flash-loan trades + earnings (submitted, confirmed, failed)
 *   2. High-signal scanner alerts (arb detected, new token, honey pot)
 *
 * Real-time latency: the snipe alerts carry the REAL measured signing
 * latency when the caller measured it in the vault seam (performance.now()
 * around the actual sign call) — sub-ms values render as µs. Omitted values
 * render nothing; nothing here is estimated or mocked.
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be set in the
 * project's Keys/API keys tab. When not configured the hook silently
 * degrades — no errors, no fake sends.
 */
import { useCallback } from "react";
import { fmtSignLatency } from "@/lib/telegram";
import { useTerminal } from "./use-terminal";

export type TelegramAlertKind =
  | "flash_submitted"
  | "flash_confirmed"
  | "flash_failed"
  | "arb_detected"
  | "honey_pot"
  | "token_discovered"
  | "snipe_executed"
  | "snipe_confirmed"
  | "snipe_failed";

export function useTelegramAlerts() {
  const { pingChannels } = useTerminal();

  const sendAlert = useCallback(
    (kind: TelegramAlertKind, title: string, body: string) => {
      // Fire-and-forget — the channel is best-effort, never blocks the UI
      void pingChannels({ title: `[${kind}] ${title}`, body }).catch(
        () => undefined,
      );
    },
    [pingChannels],
  );

  const flashSubmitted = useCallback(
    (symbol: string, spreadPct: number, lender: string) =>
      sendAlert(
        "flash_submitted",
        `⚡ Flash Loan Submitted`,
        `${symbol} · +${spreadPct.toFixed(2)}% · lender ${lender} · awaiting on-chain confirmation`,
      ),
    [sendAlert],
  );

  const flashConfirmed = useCallback(
    (symbol: string, spreadPct: number, lender: string, gain: number, txHash?: string, signingLatencyMs?: number) => {
      const lat = fmtSignLatency(signingLatencyMs);
      sendAlert(
        "flash_confirmed",
        `✅ Flash Loan Confirmed${lat ? ` · ${lat}` : ""}`,
        `${symbol} · +${spreadPct.toFixed(2)}% · ${gain.toFixed(4)} BNB profit · lender ${lender}${txHash ? ` · tx ${txHash.slice(0, 10)}…` : ""}${lat ? ` · ${lat}` : ""}`,
      );
    },
    [sendAlert],
  );

  const flashFailed = useCallback(
    (symbol: string, lender: string, reason?: string) =>
      sendAlert(
        "flash_failed",
        `❌ Flash Loan Failed`,
        `${symbol} · lender ${lender}${reason ? ` · ${reason}` : ""} · zero gas fee on revert`,
      ),
    [sendAlert],
  );

  const arbDetected = useCallback(
    (symbol: string, spreadPct: number, method: string) =>
      sendAlert(
        "arb_detected",
        `🔍 Arbitrage Detected`,
        `${symbol} · +${spreadPct.toFixed(2)}% · ${method} method`,
      ),
    [sendAlert],
  );

  const honeyPot = useCallback(
    (symbol: string, spreadPct: number, liquidityUsd: number) =>
      sendAlert(
        "honey_pot",
        `🍯 Honey Pot Detected`,
        `${symbol} · +${spreadPct.toFixed(2)}% · $${Math.round(liquidityUsd / 1000)}k liquidity`,
      ),
    [sendAlert],
  );

  const tokenDiscovered = useCallback(
    (symbol: string, source: string) =>
      sendAlert(
        "token_discovered",
        `🆕 New Token Discovered`,
        `${symbol} · via ${source}`,
      ),
    [sendAlert],
  );

  const snipeExecuted = useCallback(
    (symbol: string, amountBnb: number, signingLatencyMs?: number) => {
      const lat = fmtSignLatency(signingLatencyMs);
      sendAlert(
        "snipe_executed",
        `⚡ Snipe Submitted${lat ? ` · ${lat}` : ""}`,
        `${symbol} · ${amountBnb} BNB buy · flash loan automated`,
      );
    },
    [sendAlert],
  );

  const snipeConfirmed = useCallback(
    (symbol: string, pnl: number, signingLatencyMs?: number) => {
      const lat = fmtSignLatency(signingLatencyMs);
      sendAlert(
        "snipe_confirmed",
        `✅ Snipe Confirmed${lat ? ` · ${lat}` : ""}`,
        `${symbol} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% PnL${lat ? ` · ${lat}` : ""}`,
      );
    },
    [sendAlert],
  );

  const snipeFailed = useCallback(
    (symbol: string, reason?: string, signingLatencyMs?: number) => {
      const lat = fmtSignLatency(signingLatencyMs);
      sendAlert(
        "snipe_failed",
        `❌ Snipe Failed${lat ? ` · ${lat}` : ""}`,
        `${symbol}${reason ? ` · ${reason}` : ""} · zero gas fee on revert${lat ? ` · ${lat}` : ""}`,
      );
    },
    [sendAlert],
  );

  return {
    sendAlert,
    flashSubmitted,
    flashConfirmed,
    flashFailed,
    arbDetected,
    honeyPot,
    tokenDiscovered,
    snipeExecuted,
    snipeConfirmed,
    snipeFailed,
  };
}
