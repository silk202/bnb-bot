// TAEngine live status chip — sits in every terminal header (BNB, SOL and
// FlashBolt Trade shells).
//
// Shows the REAL Telegram bot health (token + self-heal webhook verdict +
// linked chat count + both engine switches) to operator sessions; renders
// nothing for subscribers. Clicking opens the Telegram Operator Bot dialog.
// TASignal (the broadcast channel) is a separate surface and is intentionally
// NOT represented here.
//
// The four states are exact and non-overlapping:
//   🟢 "TAEngine live · N chats" — token configured AND webhook registered
//      with Telegram (a webhook can only register with a valid token).
//   🟡 "Bot token off"          — tokenConfigured: false (no key in Keys).
//   🟡 "Bot offline"            — token present but webhook dropped; the
//                                 */10 self-heal cron re-registers it.
//   ⚪ "TAEngine…" / "TAEngine"  — loading / not yet checked by self-heal.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TelegramBotDialog } from "@/components/TelegramBotDialog";
import { formatExpiry, getDeviceToken } from "@/lib/gate";
import { Bot } from "lucide-react";
import { useState } from "react";

export function BotStatusChip() {
  const health = useQuery(
    api.telegramBot.getBotHealth,
    { deviceToken: getDeviceToken() ?? undefined },
  ) as
    | {
        recognized: boolean;
        tokenConfigured?: boolean;
        webhookOk?: boolean | null;
        webhookCheckedAt?: number | null;
        linkedChats?: number;
        digestEnabled?: boolean;
        engineRunning?: boolean | null;
        solEngineRunning?: boolean | null;
        botUsername?: string | null;
      }
    | undefined;
  const [open, setOpen] = useState(false);

  // Subscribers and unrecognized sessions: render nothing (not even a chip).
  if (health && !health.recognized) return null;

  const loading = health === undefined;
  const tokenOff = health?.tokenConfigured === false;
  const offline = health?.webhookOk === false;
  const live = health?.webhookOk === true;
  const chats = health?.linkedChats ?? 0;

  const dot = loading
    ? "bg-muted-foreground/60"
    : tokenOff || offline
      ? "bg-amber-500"
      : live
        ? "bg-emerald-500"
        : "bg-muted-foreground/60";

  const label = loading
    ? "TAEngine…"
    : tokenOff
      ? "Bot token off"
      : offline
        ? "Bot offline"
        : live
          ? `TAEngine live${chats > 0 ? ` · ${chats} chat${chats === 1 ? "" : "s"}` : ""}`
          : "TAEngine";

  const engineLine = (name: string, running: boolean | null | undefined) =>
    running === true
      ? `${name}: RUNNING (server heartbeat)`
      : running === false
        ? `${name}: stopped`
        : `${name}: state unknown`;

  const tooltip = health?.recognized
    ? [
        `Webhook: ${
          health.webhookOk === true
            ? "live — registered with Telegram"
            : health.webhookOk === false
              ? "NOT registered — the self-heal pass re-registers it within ~10 min (or click to heal now)"
              : "not checked yet — the next self-heal pass reports it"
        }`,
        health.webhookCheckedAt
          ? `Self-heal checked: ${formatExpiry(health.webhookCheckedAt)} (every 10 min)`
          : "Self-heal: first pass pending",
        `Linked chats: ${chats}`,
        engineLine("BNB engine", health.engineRunning),
        engineLine("SOL engine", health.solEngineRunning),
        `Digest: ${health.digestEnabled ? "on (15 min)" : "off"}`,
        "TASignal channel is separate — this chip is TAEngine only.",
      ].join("\n")
    : "Telegram Operator Bot";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Telegram bot status"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
          >
            <Bot className="size-3.5" />
            <span className={"size-1.5 rounded-full " + dot + (loading ? " animate-pulse" : "")} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="whitespace-pre-line text-left leading-5">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <TelegramBotDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
