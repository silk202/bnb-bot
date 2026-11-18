import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { useMutation, useQuery } from "convex/react";
import { BellRing, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const PREFS = [
  {
    key: "marketNews",
    label: "Market-news alerts",
    description:
      "High-signal headlines (flash loans, arbitrage, MEV, exploits) pushed to your bell from the real RSS feeds.",
  },
  {
    key: "sessionAlerts",
    label: "Session-change alerts",
    description:
      "A bell entry whenever a new market session opens (Sydney, Tokyo, London, New York).",
  },
  {
    key: "honeyPot",
    label: "Honey-pot detections",
    description:
      "Routes that clear the honey-pot thresholds get flagged in your bell the moment the scanner finds one.",
  },
  {
    key: "earnings",
    label: "Executions & earnings",
    description:
      "Your execution trail and earnings events land in the bell (paper and live).",
  },
] as const;

/**
 * Subscriber alert preferences — real toggles persisted to the subscriber's
 * backend row (api.gate.updateAlertPrefs). They control the in-app bell only:
 * the Telegram channel is operator-managed and is never gated by these (only
 * flash-loan trades, earnings and the explicit session dashboards go there).
 * Renders nothing for operators / non-subscribers (they have no preference
 * row); the panel itself reads the signed-in user's real access record.
 */
export function AlertPrefsPanel({ className }: { className?: string }) {
  const access = useQuery(api.gate.myAccess);
  const updatePrefs = useMutation(api.gate.updateAlertPrefs);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (access === undefined) {
    return (
      <div className={cn("rounded-2xl border border-border/70 bg-card/40 px-5 py-4", className)}>
        <div className="h-4 w-40 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 space-y-2">
          <div className="h-12 animate-pulse rounded-xl bg-muted/40" />
          <div className="h-12 animate-pulse rounded-xl bg-muted/40" />
        </div>
      </div>
    );
  }
  if (access === null) return null;

  const prefs = access.subscriber.alertPrefs;

  const toggle = async (key: (typeof PREFS)[number]["key"], value: boolean) => {
    setBusyKey(key);
    try {
      await updatePrefs({ [key]: value });
      toast.success(`${value ? "Enabled" : "Paused"} ${PREFS.find((p) => p.key === key)?.label.toLowerCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className={cn("rounded-2xl border border-border/70 bg-card/40 px-5 py-4", className)}>
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <BellRing className="size-4" />
        </div>
        <div>
          <div className="text-sm font-bold text-foreground">Alert preferences</div>
          <p className="text-[11px] text-muted-foreground">
            in-app bell only · Telegram channel is operator-managed
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {PREFS.map((pref) => {
          const on = prefs[pref.key];
          const busy = busyKey === pref.key;
          return (
            <li
              key={pref.key}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  {pref.label}
                  {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                </div>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {pref.description}
                </p>
              </div>
              <Switch
                checked={on}
                disabled={busy}
                onCheckedChange={(value) => void toggle(pref.key, value)}
                aria-label={pref.label}
              />
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        Preferences are saved to your real backend record and applied by the
        server the moment you toggle them — nothing is mocked or simulated.
      </p>
    </div>
  );
}
