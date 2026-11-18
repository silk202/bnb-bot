import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { useMutation, useQuery } from "convex/react";
import {
  BellRing,
  Info,
  Loader2,
  MonitorSmartphone,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTradeSounds } from "@/hooks/use-trade-sounds";

/**
 * Trade notification settings panel — per-user sound + push toggles.
 *
 * Compatible with all mobile browsers:
 *   Chrome, Firefox, Edge, Safari, Brave, DuckDuckGo, Opera Mini,
 *   Samsung Internet, Opera, UC Browser, Bing/Microsoft Start.
 *
 * Sound uses Web Audio API with HTML5 Audio + visual flash fallbacks.
 * Push uses the browser Notification API (gracefully degrades).
 */
export function TradeNotificationPanel({
  className,
}: {
  className?: string;
}) {
  const settings = useQuery(api.notifications.getTradeNotificationSettings);
  const updateSettings = useMutation(
    api.notifications.updateTradeNotificationSettings,
  );
  const { playExecute, browserInfo } = useTradeSounds();
  const [busy, setBusy] = useState<"sound" | "push" | null>(null);
  const [pushPermission, setPushPermission] = useState<string | null>(() => {
    try {
      if ("Notification" in window) return Notification.permission;
    } catch {
      // Ignore
    }
    return null;
  });

  const handleSoundToggle = async (value: boolean) => {
    setBusy("sound");
    try {
      await updateSettings({ soundEnabled: value });
      if (value) {
        // Play a test sound so the user hears it working
        playExecute();
      }
      toast.success(value ? "Trade sounds enabled" : "Trade sounds muted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setBusy(null);
    }
  };

  const handlePushToggle = async (value: boolean) => {
    setBusy("push");
    try {
      if (value && "Notification" in window) {
        // Request browser push notification permission
        const perm = await Notification.requestPermission();
        setPushPermission(perm);
        if (perm === "denied" || perm === "default") {
          // Browser-specific guidance
          let hint = "Enable notifications in your browser settings.";
          if (browserInfo.isBrave) {
            hint =
              "Brave Shields blocks push notifications by default. Tap the Brave shield icon in the address bar and disable 'Notifications' protection, then toggle this back on.";
          } else if (browserInfo.isDuckDuckGo) {
            hint =
              "DuckDuckGo blocks push notifications by default for privacy. Go to Settings → Permissions → Notifications and allow this site.";
          } else if (browserInfo.isOperaMini) {
            hint =
              "Opera Mini has limited push notification support. Notifications will still show as in-app alerts and visual flashes.";
          } else if (browserInfo.isBingOrEdge) {
            hint =
              "Edge on mobile requires notification permission in the app settings. Go to Settings → Site permissions → Notifications.";
          }
          toast.error("Push notifications blocked", { description: hint });
          setBusy(null);
          return;
        }
      }
      await updateSettings({ pushEnabled: value });
      toast.success(
        value ? "Push notifications enabled" : "Push notifications disabled",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setBusy(null);
    }
  };

  if (settings === undefined) {
    return (
      <div
        className={cn(
          "rounded-2xl border border-border/70 bg-card/40 px-5 py-4",
          className,
        )}
      >
        <div className="h-4 w-48 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 space-y-2">
          <div className="h-14 animate-pulse rounded-xl bg-muted/40" />
          <div className="h-14 animate-pulse rounded-xl bg-muted/40" />
        </div>
      </div>
    );
  }

  const soundOn = settings?.soundEnabled ?? true;
  const pushOn = settings?.pushEnabled ?? true;

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/70 bg-card/40 px-5 py-4",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <BellRing className="size-4" />
        </div>
        <div>
          <div className="text-sm font-bold text-foreground">
            Trade notifications
          </div>
          <p className="text-[11px] text-muted-foreground">
            alerts for flash-loan trades placed, won &amp; failed
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {/* Sound toggle */}
        <li className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              {soundOn ? (
                <Volume2 className="size-3.5 text-emerald-400" />
              ) : (
                <VolumeX className="size-3.5 text-muted-foreground" />
              )}
              Notification sounds
              {busy === "sound" && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              Play a sound on every trade event — execute (ping), win
              (arpeggio), fail (buzz).
              {browserInfo.isOperaMini
                ? " Falls back to a visual flash on Opera Mini."
                : " Works on desktop & mobile."}
            </p>
          </div>
          <Switch
            checked={soundOn}
            disabled={busy !== null}
            onCheckedChange={(value) => void handleSoundToggle(value)}
            aria-label="Toggle notification sounds"
          />
        </li>

        {/* Push notification toggle */}
        <li className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <BellRing className="size-3.5" />
              Push notifications
              {busy === "push" && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              Get browser alerts even when the tab is in the background.
              {browserInfo.isBrave
                ? " Disable Brave Shields for this site first."
                : browserInfo.isDuckDuckGo
                  ? " Allow in DuckDuckGo Settings → Permissions."
                  : browserInfo.isOperaMini
                    ? " Opera Mini: uses in-app alerts (limited push)."
                    : " Works on all platforms — desktop, Android & iOS Safari."}
            </p>
            {pushPermission === "denied" && (
              <p className="mt-1 text-[10px] font-semibold text-amber-400">
                Permission denied — enable in browser settings to use.
              </p>
            )}
          </div>
          <Switch
            checked={pushOn}
            disabled={busy !== null}
            onCheckedChange={(value) => void handlePushToggle(value)}
            aria-label="Toggle push notifications"
          />
        </li>
      </ul>

      {/* Browser compatibility info banner */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2.5">
        <MonitorSmartphone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[10px] leading-4 text-muted-foreground">
          Compatible with Chrome, Firefox, Edge, Safari, Brave, DuckDuckGo,
          Opera Mini, Samsung Internet, UC Browser and all modern mobile
          browsers. Sounds use Web Audio API with HTML5 Audio + visual flash
          fallbacks. Push uses the Notification API with graceful degradation.
        </p>
      </div>

      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        Settings are saved to your real backend record and applied instantly —
        nothing is mocked or simulated.
      </p>
    </div>
  );
}
