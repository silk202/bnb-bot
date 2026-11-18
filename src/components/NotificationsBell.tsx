import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTradeSounds } from "@/hooks/use-trade-sounds";
import { useTerminal } from "@/hooks/use-terminal";
import { cn } from "@/lib/utils";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { Bell, BellRing, CheckCheck, Clock, Newspaper, Sparkles, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function ago(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * Terminal notification bell. Only real events are listed — executions,
 * honey-pot detections (scanner/terminal) and high-signal market-news
 * alerts (real RSS headlines pushed by the news action). Nothing simulated.
 */
export function NotificationsBell() {
  const { notifications, unreadCount, markAllNotificationsRead } = useTerminal();
  const tradeSettings = useQuery(api.notifications.getTradeNotificationSettings);
  const { playExecute, playSuccess, playFail } = useTradeSounds();
  const [open, setOpen] = useState(false);
  const unread = unreadCount ?? 0;
  const items = notifications ?? [];
  const prevCountRef = useRef(items.length);

  // Play sounds and send push notifications for new trade-related events
  useEffect(() => {
    if (items.length <= prevCountRef.current) {
      prevCountRef.current = items.length;
      return;
    }
    const newItems = items.slice(0, items.length - prevCountRef.current);
    prevCountRef.current = items.length;

    const soundEnabled = tradeSettings?.soundEnabled ?? true;
    const pushEnabled = tradeSettings?.pushEnabled ?? true;

    for (const n of newItems) {
      // Play sound for execution notifications
      if (n.kind === "execution") {
        if (soundEnabled) {
          if (n.title.toLowerCase().includes("fail") || n.title.toLowerCase().includes("revert")) {
            playFail();
          } else {
            playSuccess();
          }
        }
        if (pushEnabled && "Notification" in window && Notification.permission === "granted") {
          try {
            // Brave / DuckDuckGo / Opera Mini may throw here even with
            // permission granted — wrap in try/catch and fall through.
            const pushNotif = new Notification(n.title, { body: n.body, icon: "/favicon.ico", tag: n._id });
            // Some browsers (Brave) auto-close notifications
            setTimeout(() => { try { pushNotif.close(); } catch { /* ignore */ } }, 8000);
          } catch {
            // Push not supported in this environment — sound + visual flash still fire
          }
        }
      }
      // Play execute sound for honey pots
      if (n.kind === "honey_pot") {
        if (soundEnabled) playExecute();
        if (pushEnabled && "Notification" in window && Notification.permission === "granted") {
          try {
            const pushNotif2 = new Notification(n.title, { body: n.body, icon: "/favicon.ico", tag: n._id });
            setTimeout(() => { try { pushNotif2.close(); } catch { /* ignore */ } }, 8000);
          } catch {
            // Push not supported — sound + visual flash still fire
          }
        }
      }
    }
  }, [items, tradeSettings, playExecute, playSuccess, playFail]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Reading the feed marks everything read (fires only when unread > 0).
    if (next && unread > 0) {
      void markAllNotificationsRead().catch(() => undefined);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex size-9 items-center justify-center rounded-full border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Notifications"
        >
          {unread > 0 ? <BellRing className="size-4 text-primary" /> : <Bell className="size-4" />}
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 py-0.5 font-mono text-[9px] font-bold text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[340px] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="text-sm font-semibold text-foreground">
            Notifications
            {unread > 0 && (
              <span className="ml-2 rounded-full bg-red-500/15 px-2 py-0.5 font-mono text-[10px] text-red-400">
                {unread} new
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px]"
            disabled={unread === 0}
            onClick={() => void markAllNotificationsRead().catch(() => undefined)}
          >
            <CheckCheck className="size-3.5" />
            Mark all read
          </Button>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Bell className="size-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              No notifications yet — executions, honey-pot finds, session
              changes and market-news alerts land here the moment they happen.
            </p>
          </div>
        ) : (
          <ul className="max-h-[320px] overflow-y-auto">
            {items.map((n) => (
              <li
                key={n._id}
                className={cn(
                  "flex items-start gap-3 border-b border-border/40 px-4 py-3 last:border-b-0",
                  !n.read && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                    n.kind === "honey_pot"
                      ? "bg-amber-500/15 text-amber-400"
                      : n.kind === "market_news"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : n.kind === "session_update"
                          ? "bg-sky-500/15 text-sky-400"
                          : "bg-primary/12 text-primary",
                  )}
                >
                  {n.kind === "honey_pot" ? (
                    <Sparkles className="size-3" />
                  ) : n.kind === "market_news" ? (
                    <Newspaper className="size-3" />
                  ) : n.kind === "session_update" ? (
                    <Clock className="size-3" />
                  ) : (
                    <Zap className="size-3" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-semibold leading-4 text-foreground">
                      {n.title}
                    </p>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {ago(n.ts)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {n.body}
                  </p>
                  {n.chainKey && (
                    <span
                      className={cn(
                        "mt-1 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                        n.chainKey === "solana"
                          ? "border-[#9945FF]/30 bg-[#9945FF]/10 text-[#9945FF]"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-500",
                      )}
                    >
                      {n.chainKey === "solana" ? "SOL FlashBolt" : "BNB FlashBolt"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
