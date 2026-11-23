// FlashBolt Telegram Bot — operator pairing dialog.
//
// SEAMLESS BY DESIGN: opening this dialog AUTO-CONNECTS the bot (webhook
// self-healing + a live pairing code, no button presses). Pairing itself is
// ONE TAP — the primary "Connect in one tap" button opens the deep link
// https://t.me/<bot>?start=<code>, which preloads the pairing so no code is
// ever typed; the backend pairs the chat instantly on that single message.
// The code block remains only as a quiet fallback for operators who prefer
// typing /pair. Operator sign-in AND "Continue as Guest" sessions both work;
// the amber banner explains the rare unrecognized-session case and offers a
// one-click re-verify.

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/copy-text";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2Off,
  Loader2,
  Play,
  RefreshCcw,
  Send,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { formatExpiry, getDeviceToken, setDeviceToken } from "@/lib/gate";
import { purgeTelemetryLine } from "@/lib/telegramBot";

type BotStatus = {
  recognized: boolean;
  digestEnabled: boolean;
  alertFanout: boolean;
  soundAlerts: boolean;
  autoPairOnStart?: boolean;
  /** Auto-purge: tracked bot/channel messages older than 10 min are deleted. */
  autoPurge?: boolean;
  channelPurge?: boolean;
  /** Last purge sweep's tally — null until the cron has reported one. */
  purgeLast?: { at: number; deleted: number; failed: number; skipped: string | null } | null;
  webhookOk?: boolean | null;
  webhookCheckedAt?: number | null;
  botUsername: string | null;
  /** Where the active bot token comes from — plaintext is never returned. */
  tokenSource?: "app" | "env" | null;
  tokenHint?: string | null;
  tokenSetAt?: number | null;
  /** Real engine state — same switch the bot and terminal use. */
  engineRunning?: boolean | null;
  /** Independent SOL engine switch (its own start/stop state). */
  solEngineRunning?: boolean | null;
  linkedChats: Array<{
    _id: string;
    chatId: string;
    title: string | null;
    username: string | null;
    linkedAt: number;
    lastSeenAt: number;
  }>;
};

type Pairing = { code: string; expiresAt: number } | null;
type ConnPhase = "connecting" | "ready" | "degraded" | "error";

/** True only the FIRST time per page load — guards against multiple mounted
 * dialog instances (AccountMenu on each terminal + the Trade header entry)
 * all claiming the same reopen flag. */
let botDialogReopenClaimedOnce = false;
function botDialogReopenClaimed(): boolean {
  if (botDialogReopenClaimedOnce) return true;
  botDialogReopenClaimedOnce = true;
  return false;
}

export function TelegramBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const status = useQuery(
    api.telegramBot.getBotStatus,
    open ? { deviceToken: getDeviceToken() ?? undefined } : "skip",
  ) as BotStatus | undefined;
  const autoConnect = useAction(api.telegramBot.autoConnectBot);
  const rotateCode = useMutation(api.telegramBot.issuePairingCode);
  const unlink = useMutation(api.telegramBot.unlinkChat);
  const testAlert = useMutation(api.telegramBot.sendSimTradeAlert);
  const setAutoPair = useMutation(api.telegramBot.setAutoPair);
  const setAutoPurge = useMutation(api.telegramBot.setAutoPurge);
  const setChannelPurge = useMutation(api.telegramBot.setChannelPurge);
  const saveBotToken = useAction(api.telegramBot.setBotToken);
  const removeBotToken = useMutation(api.telegramBot.clearBotToken);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const startBot = useMutation(api.terminal.botStartFromDialog);
  const stopBot = useMutation(api.terminal.setBotRunning);
  const [startBusy, setStartBusy] = useState(false);
  const [startState, setStartState] = useState<null | boolean>(null);
  // Real engine switch wins once a status arrives; the local toggle only
  // bridges the moment between the click and the reactive refetch.
  const engineRunning = status?.engineRunning ?? startState;
  const [testBusy, setTestBusy] = useState(false);

  const [pairing, setPairing] = useState<Pairing>(null);
  const [conn, setConn] = useState<{
    phase: ConnPhase;
    botUsername: string | null;
    error: string | null;
  }>({ phase: "connecting", botUsername: null, error: null });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const navigate = useNavigate();
  const location = useLocation();

  // Re-verify flow: when this dialog launched the /auth re-verify (amber
  // banner button), it reopens itself on return. Module-level guard so exactly
  // ONE mounted instance consumes the flag — never double-open.
  useEffect(() => {
    let flag: string | null = null;
    try {
      flag = sessionStorage.getItem("flashbolt.botDialogReopen");
    } catch {
      flag = null;
    }
    if (flag === "1" && !botDialogReopenClaimed()) {
      try {
        sessionStorage.removeItem("flashbolt.botDialogReopen");
      } catch {
        /* ignore */
      }
      onOpenChange(true);
    }
    // Runs once on mount; onOpenChange is stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SEAMLESS AUTO-CONNECT — when the dialog opens (and the server has
  // confirmed the session is operator), connect automatically: self-heal the
  // webhook with Telegram and ensure a live pairing code. ONE attempt per
  // open, identity-guarded: a status-query refetch (getBotStatus updates as
  // chats link/unlink) can never re-fire it — that re-fire was the glitch.
  const attemptRef = useRef(0);
  const attemptOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      attemptOpenRef.current = false;
      return;
    }
    if (attemptOpenRef.current) return;
    // Wait for the server-side session check so an unrecognized session gets
    // the honest banner instead of an "Operator access required" error.
    if (status === undefined || status.recognized === false) return;
    attemptOpenRef.current = true;
    const attempt = ++attemptRef.current;
    setConn({ phase: "connecting", botUsername: null, error: null });
    autoConnect({ deviceToken: getDeviceToken() ?? undefined })
      .then((res) => {
        if (attempt !== attemptRef.current) return;
        // Silent device upgrade: the server verified this session via identity
        // and minted a device-trust token — persist it (returned exactly once).
        if (res.deviceToken) setDeviceToken(res.deviceToken);
        setPairing(
          res.pairing
            ? { code: res.pairing.code, expiresAt: res.pairing.expiresAt }
            : null,
        );
        setConn({
          phase: res.ok ? "ready" : "degraded",
          botUsername: res.botUsername,
          error: res.error ?? null,
        });
      })
      .catch((err) => {
        if (attempt !== attemptRef.current) return;
        setConn({
          phase: "error",
          botUsername: null,
          error: err instanceof Error ? err.message : "Auto-connect failed",
        });
      });
  }, [open, status, autoConnect]);

  // Ticking clock for the code expiry countdown.
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  // When the server stamps a bot username (autoConnectBot stamps it on every
  // dialog open), flip the local connection view to "ready" immediately so the
  // dialog shows the native deep link + connected state instead of the
  // connecting spinner. The status refetch is driven by getBotStatus, which
  // this dialog reads with the deviceToken gate — the same query AccountMenu
  // uses for the account-menu row. This is keyed off conn.phase so a
  // degraded/error view is never silently overwritten by a stale cache.
  useEffect(() => {
    if (conn.phase !== "connecting" && conn.phase !== "error") return;
    if (status?.recognized !== true) return;
    if (!status.botUsername) return;
    setConn({
      phase: "ready",
      botUsername: status.botUsername,
      error: null,
    });
  }, [status, conn]);

  // Manual code rotation (fallback path only — keeps the operator in control;
  // auto-connect already guarantees a live code, this just refreshes it).
  const rotate = async () => {
    setBusy(true);
    try {
      const res = await rotateCode({ deviceToken: getDeviceToken() ?? undefined });
      setPairing(res);
      setNow(Date.now());
      toast.success("Fresh pairing code — valid for 15 minutes");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rotate code");
    } finally {
      setBusy(false);
    }
  };

  const retryConnect = () => {
    if (status === undefined || status.recognized === false) return;
    const attempt = ++attemptRef.current;
    setConn({ phase: "connecting", botUsername: null, error: null });
    autoConnect({ deviceToken: getDeviceToken() ?? undefined })
      .then((res) => {
        if (attempt !== attemptRef.current) return;
        // Silent device upgrade: the server verified this session via identity
        // and minted a device-trust token — persist it (returned exactly once).
        if (res.deviceToken) setDeviceToken(res.deviceToken);
        setPairing(
          res.pairing
            ? { code: res.pairing.code, expiresAt: res.pairing.expiresAt }
            : null,
        );
        setConn({
          phase: res.ok ? "ready" : "degraded",
          botUsername: res.botUsername,
          error: res.error ?? null,
        });
      })
      .catch((err) => {
        if (attempt !== attemptRef.current) return;
        setConn({
          phase: "error",
          botUsername: null,
          error: err instanceof Error ? err.message : "Auto-connect failed",
        });
      });
  };

  const copyCode = () => {
    if (!pairing) return;
    void copyText(pairing.code, { message: "Code copied — paste it into the bot chat" });
  };

  // Bot-token mini-dashboard: save verifies the candidate token against
  // Telegram's getMe server-side BEFORE anything is stored (AES-GCM at rest,
  // plaintext never returns to the browser); remove clears the ciphertext so
  // the backend falls back to the deployment env token.
  const saveToken = () => {
    const t = tokenInput.trim();
    if (!t || tokenBusy) return;
    setTokenBusy(true);
    saveBotToken({ deviceToken: getDeviceToken() ?? undefined, token: t })
      .then((res) => {
        if (res.ok) {
          setTokenInput("");
          toast.success(
            `Token verified — @${res.username} saved${res.webhookOk ? " · webhook live" : " · webhook self-heal queued"}`,
          );
        } else {
          toast.error(res.error ?? "Telegram rejected this token");
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not save the token"))
      .finally(() => setTokenBusy(false));
  };

  const removeToken = () => {
    if (tokenBusy) return;
    setTokenBusy(true);
    removeBotToken({ deviceToken: getDeviceToken() ?? undefined })
      .then(() => {
        setTokenInput("");
        toast.success("App token removed — the deployment env token takes over (if set)");
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not remove the token"))
      .finally(() => setTokenBusy(false));
  };

  const secsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const expired = pairing !== null && secsLeft <= 0;
  const recognized = status?.recognized !== false;
  // Server-stamped identity wins over the local optimistic view: on the first
  // open autoConnectBot stamps the @username (from getMe or the config row)
  // and the webhook self-heal verdict, and this reactive query (read with the
  // deviceToken gate) surfaces both immediately. The deep link is built from
  // the server value so the one-tap CTA opens Web Telegram directly, no
  // round-trip, without ever constructing the link off a transient null.
  const serverUsername = conn.botUsername ?? status?.botUsername ?? null;
  const deepLink =
    serverUsername && pairing && !expired
      ? `https://t.me/${serverUsername}?start=${pairing.code}`
      : null;
  // Linked = paired chats exist. When paired, the one-tap CTA is replaced by
  // the connected state (the fallback code block stays available below).
  const linkedCount = status?.linkedChats.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            Telegram Operator Bot
            <Badge variant="outline" className="text-[9px] uppercase">
              operator only
            </Badge>
          </DialogTitle>
          <DialogDescription>
            A standalone bot that mirrors this entire app — dashboards, flash-loan
            controls, sniper settings and the full Trade exchange — in your
            Telegram. Connecting is automatic; pairing is one tap.
          </DialogDescription>
        </DialogHeader>

        {/* Session not recognized — never crash, just explain. */}
        {!recognized && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-5 text-amber-200">
            <div className="text-xs font-semibold text-amber-100">Session not recognized</div>
            This session is not verified as the operator on the server (the guest
            access code may not have been confirmed for it). Re-enter through
            "Continue as Guest" and confirm the 6-digit code — or sign in with
            your operator email — then reopen this dialog.
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full border-amber-500/40 text-[11px] text-amber-100 hover:bg-amber-500/15"
              onClick={() => {
                // Re-verify shortcut: run the guest re-auth flow, then come
                // straight back into this dialog on the same page.
                try {
                  sessionStorage.setItem("flashbolt.botDialogReopen", "1");
                } catch {
                  /* storage unavailable — dialog just won't auto-reopen */
                }
                const returnTo = encodeURIComponent(
                  location.pathname + location.search,
                );
                onOpenChange(false);
                navigate(`/auth?returnTo=${returnTo}&reverify=1`);
              }}
            >
              <ShieldCheck className="mr-1 size-3" />
              Re-verify session now
            </Button>
          </div>
        )}

        {/* PAIRED — compact connected state, everything else collapses. */}
        {recognized && linkedCount > 0 && (
          <>
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-100">
                  <Check className="size-4 text-emerald-500" />
                  Bot connected
                  {conn.botUsername ? ` — @${conn.botUsername}` : ""}
                </div>
                <Badge
                  variant="outline"
                  className="border-emerald-500/40 text-[9px] uppercase text-emerald-300"
                >
                  standalone mirror
                </Badge>
              </div>
              <div className="mt-1 text-[11px] leading-5 text-emerald-200/80">
                Webhook live · {linkedCount} chat{linkedCount === 1 ? "" : "s"} paired ·
                full app parity (dashboards, BNB/SOL bot controls, Trade, alerts).
                Reconnect on a new device is the same one tap — no codes.
              </div>
              {/* Honest self-heal line — same data the header chip's tooltip
                  reads (getBotStatus webhookOk + webhookCheckedAt). */}
              {typeof status?.webhookOk === "boolean" && (
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-200/70">
                  <ShieldCheck className="size-3 shrink-0" />
                  <span>
                    Webhook:{" "}
                    {status.webhookOk
                      ? "live"
                      : "temporarily down — the 10-min self-heal pass re-registers it"}
                    {status?.webhookCheckedAt
                      ? ` · self-heal checked ${formatExpiry(status.webhookCheckedAt)}`
                      : " · first self-heal pass pending"}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* Connection — automatic, no button. */}
        {recognized && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="text-sm font-semibold">Connection</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Runs automatically — registers/self-heals the Telegram webhook for
              this deployment. Idempotent; Telegram is asked for its current
              state first.
            </div>
            <div className="mt-2">
              {conn.phase === "connecting" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Connecting the bot automatically…
                </div>
              )}
              {conn.phase === "ready" && (
                <div className="flex items-center gap-2 text-xs text-emerald-500">
                  <Check className="size-3.5" />
                  {/* Server-stamped identity keeps this in sync with the
                      account menu row (getBotStatus) — no local guess. */}
                  Connected{conn.botUsername ? ` — @${conn.botUsername}` : ""} · webhook live
                </div>
              )}
              {(conn.phase === "degraded" || conn.phase === "error") && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-5 text-amber-200">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-100">
                    <TriangleAlert className="size-3.5" />
                    {conn.phase === "degraded" ? "Connection issue" : "Auto-connect failed"}
                  </div>
                  {conn.error ?? "Unknown error — set the bot token in the panel below, or check Keys."}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7 w-full border-amber-500/40 text-[11px] text-amber-100 hover:bg-amber-500/15"
                    disabled={busy}
                    onClick={retryConnect}
                  >
                    <RefreshCcw className="mr-1 size-3" />
                    Retry connection
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Operator bot token — mini-dashboard: encrypted at rest,
            verified live by Telegram's getMe before anything is stored. */}
        {recognized && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <KeyRound className="size-3.5 text-primary" />
                Bot token
              </div>
              <Badge
                variant="outline"
                className={
                  "text-[9px] uppercase " +
                  (status?.tokenSource === "app"
                    ? "border-emerald-500/40 text-emerald-400"
                    : status?.tokenSource === "env"
                      ? "border-sky-500/40 text-sky-400"
                      : "border-amber-500/40 text-amber-400")
                }
              >
                {status === undefined
                  ? "…"
                  : status.tokenSource === "app"
                    ? `app · ••••${status.tokenHint ?? ""}`
                    : status.tokenSource === "env"
                      ? "env fallback"
                      : "not set"}
              </Badge>
            </div>
            <div className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
              Paste the token from @BotFather to deploy the bot live. It is
              verified against Telegram's getMe server-side, then stored AES-GCM
              encrypted in the backend — the plaintext never returns to the
              browser; only this last-4 hint is ever shown.
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder="123456789:AA..."
                className="h-9 min-w-0 flex-1 font-mono text-xs"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveToken();
                }}
              />
              <Button
                size="sm"
                className="h-9 shrink-0 px-3 text-xs"
                disabled={tokenBusy || tokenInput.trim().length === 0}
                onClick={saveToken}
              >
                {tokenBusy ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 size-3.5" />
                )}
                Save & verify
              </Button>
            </div>
            {status?.tokenSource === "app" && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  Encrypted at rest
                  {status.tokenSetAt ? ` · saved ${formatExpiry(status.tokenSetAt)}` : ""}
                  {status.botUsername ? ` · @${status.botUsername}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 text-[10px] text-red-500"
                  disabled={tokenBusy}
                  onClick={removeToken}
                >
                  <Link2Off className="size-3" />
                  Remove
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Pairing — ONE TAP primary when unpaired; code is fallback only. */}
        {recognized && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="text-sm font-semibold">Pair your chat</div>
            {linkedCount === 0 ? (
              <>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  One tap below — Telegram opens with the pairing preloaded
                  (no code to type) and the chat links instantly.
                </div>
                {conn.phase === "connecting" ? (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Preparing the link…
                  </div>
                ) : deepLink ? (
                  <Button
                    className="mt-2 h-11 w-full text-sm font-semibold shadow-lg shadow-primary/20"
                    onClick={() => window.open(deepLink, "_blank", "noopener")}
                  >
                    <Send className="mr-2 size-4" />
                    Connect in one tap — open in Telegram
                  </Button>
                ) : (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    Waiting for the bot link…
                  </div>
                )}
              </>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="text-[11px] text-muted-foreground">
                  All set — your chat receives the full mirror.
                </div>
                {deepLink && (
                  <Button
                    variant="outline"
                    className="h-9 w-full text-xs"
                    onClick={() => window.open(deepLink, "_blank", "noopener")}
                  >
                    <Send className="mr-2 size-3.5" />
                    Pair another chat or device — one tap
                  </Button>
                )}
              </div>
            )}
            {/* Fallback for operators who prefer typing: collapsed by default. */}
            <details className="mt-2 rounded-lg border border-border/40 bg-background/40">
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground">
                Prefer typing a code? Show the fallback
              </summary>
              <div className="px-3 pb-3">
                <div className="text-[11px] text-muted-foreground">
                  Send <code className="font-mono">/pair</code>, then this code —
                  single-use, 15 minutes. (The one-tap link already contains it.)
                </div>
                {conn.phase === "connecting" ? (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Preparing your code…
                  </div>
                ) : pairing && !expired ? (
                  <div className="mt-2 space-y-2">
                    <div className="rounded-lg border border-primary/40 bg-primary/10 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-2xl font-extrabold tracking-[0.3em] text-primary">
                          {pairing.code}
                        </span>
                        <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={copyCode}>
                          <Copy className="mr-1 size-3" />
                          Copy
                        </Button>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <ShieldCheck className="size-3 text-emerald-500" />
                        Expires in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")}
                        <button
                          type="button"
                          className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
                          disabled={busy}
                          onClick={() => void rotate()}
                        >
                          <RefreshCcw className={"size-3" + (busy ? " animate-spin" : "")} />
                          New code
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" className="mt-2 h-8 text-xs" disabled={busy} onClick={() => void rotate()}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="mr-1 size-3.5" />}
                    {pairing && expired ? "Code expired — generate new" : "Generate pairing code"}
                  </Button>
                )}
              </div>
            </details>
          </div>
        )}

        {/* One-tap engine control — START boots the console from the app too.
            TWO INDEPENDENT engines: BNB and SOL each have their own switch,
            so starting/stopping one never touches the other. */}
        {recognized && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Engine control — independent bots
            </div>
            {([
              {
                key: "bnb" as const,
                label: "BNB FlashBolt",
                running: engineRunning,
              },
              {
                key: "sol" as const,
                label: "SOL FlashBolt",
                running: status?.solEngineRunning ?? null,
              },
            ]).map((eng) => {
              const on = eng.running === true;
              const off = eng.running === false;
              return (
                <div key={eng.key} className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        "text-[9px] uppercase " +
                        (on ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")
                      }
                    >
                      {on ? "running" : off ? "stopped" : "…"}
                    </Badge>
                    <span className="truncate text-sm font-semibold">{eng.label}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-semibold"
                      variant={on ? "outline" : "default"}
                      disabled={startBusy || on}
                      onClick={() => {
                        setStartBusy(true);
                        startBot({ deviceToken: getDeviceToken() ?? undefined, chain: eng.key })
                          .then(() => {
                            setStartState(true);
                            toast.success(`${eng.label} started — its engine runs on the server heartbeat`);
                          })
                          .catch((err) => toast.error(err instanceof Error ? err.message : "Could not start"))
                          .finally(() => setStartBusy(false));
                      }}
                    >
                      {startBusy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Play className="mr-1 size-3.5" />}
                      START
                    </Button>
                    <Button
                      size="sm"
                      variant={on ? "default" : "outline"}
                      className="h-8 px-3 text-xs"
                      disabled={startBusy || off}
                      onClick={() => {
                        setStartBusy(true);
                        stopBot({ running: false, chain: eng.key })
                          .then(() => {
                            setStartState(false);
                            toast.success(`${eng.label} stopped — the other bot is unaffected`);
                          })
                          .catch((err) => toast.error(err instanceof Error ? err.message : "Could not stop"))
                          .finally(() => setStartBusy(false));
                      }}
                    >
                      {startBusy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Square className="mr-1 size-3.5" />}
                      STOP
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="mt-2 text-[11px] text-muted-foreground">
              Each bot runs with the app open or closed and stops only via its
              own switch — the Telegram /bnb_off · /sol_off buttons and these
              controls are the same switches.
            </div>
          </div>
        )}

        {/* /start auto-pair policy — ON: plain /start pairs + boots with zero codes. */}
        {recognized && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">/start auto-pair</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                ON: sending /start to the bot pairs that chat automatically and boots
                the full console — no code, no taps. OFF: the app-issued code is
                required again.
                {typeof status?.webhookOk === "boolean" && (
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    Webhook: {status.webhookOk ? "live" : "not confirmed"}
                    {status?.webhookCheckedAt ? ` · self-heal checked ${formatExpiry(status.webhookCheckedAt)}` : ""}
                  </span>
                )}
              </div>
            </div>
            <Switch
              checked={status?.autoPairOnStart !== false}
              onCheckedChange={(checked) => {
                setAutoPair({ enabled: checked, deviceToken: getDeviceToken() ?? undefined })
                  .then(() => toast.success(checked ? "Auto-pair on /start enabled" : "Strict code pairing restored"))
                  .catch((err) => toast.error(err instanceof Error ? err.message : "Could not update"));
              }}
              aria-label="Toggle /start auto-pair"
            />
          </div>
        )}

        {/* Auto-purge policy — the bot's own 10-minute message sweep. */}
        {recognized && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Auto-purge messages</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                ON: every message the bot posts (boards, digests, trade alerts) and every
                channel post is deleted after 10 minutes, so a linked chat shows the last
                ten minutes instead of an unbounded scrollback. The sweep runs every 10
                minutes; /purge in the chat clears it immediately. OFF keeps everything.
              </div>
              {/* The sweep's own honest tally — the same line `/alerts` shows. */}
              <div className="mt-1 text-[10px] text-muted-foreground/80">
                Last sweep: {purgeTelemetryLine(status?.purgeLast, now)}
              </div>
            </div>
            <Switch
              checked={status?.autoPurge !== false}
              onCheckedChange={(checked) => {
                setAutoPurge({ enabled: checked, deviceToken: getDeviceToken() ?? undefined })
                  .then(() =>
                    toast.success(
                      checked
                        ? "Auto-purge on — messages are deleted after 10 minutes"
                        : "Auto-purge off — new messages will stay",
                    )
                  )
                  .catch((err) => toast.error(err instanceof Error ? err.message : "Could not update"));
              }}
              aria-label="Toggle auto-purge of bot messages"
            />
          </div>
        )}

        {/* Channel purge scope — separate from the chat sweep on purpose. */}
        {recognized && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Purge channel posts</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                ON: trade and signal posts to the channel are deleted after 10 minutes by the same
                sweep. OFF: the channel keeps its history while linked chats still clear. Kept
                separate on purpose — /purge in a chat never deletes channel posts.
              </div>
            </div>
            <Switch
              checked={status?.channelPurge !== false}
              onCheckedChange={(checked) => {
                setChannelPurge({ enabled: checked, deviceToken: getDeviceToken() ?? undefined })
                  .then(() =>
                    toast.success(
                      checked
                        ? "Channel purge on — posts are deleted after 10 minutes"
                        : "Channel purge off — channel posts stay",
                    )
                  )
                  .catch((err) => toast.error(err instanceof Error ? err.message : "Could not update"));
              }}
              aria-label="Toggle purge of channel posts"
            />
          </div>
        )}

        {/* Linked chats */}
        <div className="rounded-lg border border-border/60 bg-card/50 p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Linked chats</div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[9px]"
                disabled={testBusy || !status || status.linkedChats.length === 0}
                title="Sends a clearly-labeled SIM trade to TAEngine chats only — TASignal channel untouched"
                onClick={() => {
                  setTestBusy(true);
                  testAlert({ deviceToken: getDeviceToken() ?? undefined })
                    .then((res) => {
                      if (res.ok) toast.success(`SIM alert dispatched to ${res.recipients} TAEngine chat(s)`);
                      else toast.error(res.error ?? "Could not send the SIM alert");
                    })
                    .catch((err) =>
                      toast.error(err instanceof Error ? err.message : "SIM alert failed"),
                    )
                    .finally(() => setTestBusy(false));
                }}
              >
                {testBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Send className="mr-1 size-3" />}
                Send test alert (SIM)
              </Button>
            </div>
          </div>
          {status === undefined ? (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          ) : !status.recognized ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Available once the session is re-verified.
            </div>
          ) : status.linkedChats.length === 0 ? (
            <div className="mt-2 text-xs text-muted-foreground">
              No chats paired yet — tap "Connect in one tap" above.
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {status.linkedChats.map((c) => (
                <div
                  key={c._id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Check className="size-3.5 text-emerald-500" />
                      {c.title ?? c.username ?? `Chat ${c.chatId}`}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      linked {formatExpiry(c.linkedAt)} · last seen {formatExpiry(c.lastSeenAt)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 text-[10px] text-red-500"
                    onClick={() => {
                      void unlink({
                        chatId: c.chatId,
                        deviceToken: getDeviceToken() ?? undefined,
                      }).then(() => toast.success("Chat unlinked"));
                    }}
                  >
                    <Link2Off className="mr-1 size-3" />
                    Unlink
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bot capabilities summary */}
        <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
          <div className="mb-1 text-xs font-semibold text-foreground">What the bot can do</div>
          • Full dashboards: market sessions, AI score, fleet metrics, PnL
          <br />• BNB FlashBolt: start/stop, paper/live, live scan, routes, executions
          <br />• SOL FlashBolt: start/stop, feed refresh, sniper settings view
          <br />• FlashBolt Trade: balances, live prices, orders, earn, interest claims, ledger
          <br />• Alerts: trade mirror, scheduled digest, per-chat sound controls
        </div>
      </DialogContent>
    </Dialog>
  );
}
