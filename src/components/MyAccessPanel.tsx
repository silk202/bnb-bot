import { useQuery } from "convex/react";
import { KeyRound, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

const OS_LABEL: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      : status === "blocked"
        ? "border-red-500/30 bg-red-500/10 text-red-400"
        : "border-amber-500/30 bg-amber-500/10 text-amber-400";
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        tone,
      )}
    >
      {status}
    </span>
  );
}

/**
 * "My access" — subscriber self-service panel. Reads the signed-in user's
 * real backend record: passcode status, live expiry countdown, the expiry
 * window the operator configured, payment status (when a receipt was sent)
 * and the per-OS desktop activation licenses. Renders nothing for
 * non-subscribers (operators see the full console instead). All data comes
 * straight from the backend — no simulation.
 */
export function MyAccessPanel() {
  const access = useQuery(api.gate.myAccess);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (access === undefined) {
    return (
      <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
        <div className="h-4 w-36 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 h-20 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }
  if (access === null) return null;

  const sub = access.subscriber;
  const expiresInMs = sub.expiresAt - now;
  const expired = sub.expiresAt < now;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <KeyRound className="size-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">My access</div>
            <p className="text-[11px] text-muted-foreground">
              subscriber · passcode + desktop licenses
            </p>
          </div>
        </div>
        <StatusBadge status={sub.status} />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Passcode window
          </div>
          <div className="mt-1 text-sm font-bold text-foreground">
            {sub.expiryHours}h window
          </div>
          <div
            className={cn(
              "mt-1 text-[11px] font-semibold",
              expired
                ? "text-red-400"
                : expiresInMs < 6 * 3600_000
                  ? "text-amber-400"
                  : "text-emerald-400",
            )}
          >
            {expired
              ? "Expired — request a new one from the subscription popup"
              : `Expires in ${fmtRemaining(expiresInMs)}`}
          </div>
          {sub.notifyNote && (
            <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {sub.notifyNote}
            </div>
          )}
          {sub.paymentStatus && (
            <div className="mt-1.5">
              <StatusBadge status={`payment ${sub.paymentStatus}`} />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Passcode status
          </div>
          <div className="mt-1 text-sm font-bold text-foreground">
            {sub.activatedAt
              ? "Activated"
              : sub.lastSentAt
                ? "Issued — not yet used"
                : "Not yet issued"}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {sub.activatedAt
              ? `First used ${new Date(sub.activatedAt).toLocaleDateString()}`
              : sub.lastSentAt
                ? `Delivered ${new Date(sub.lastSentAt).toLocaleDateString()} — open the gate with your email + passcode`
                : "Passcodes are delivered by the operator after payment confirmation"}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          <Laptop className="size-3" />
          Desktop licenses
        </div>
        {access.licenses.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            No desktop activation licenses issued yet — the operator generates
            them per operating system from the console.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {access.licenses.map((lic) => (
              <li
                key={lic.os}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    {OS_LABEL[lic.os] ?? lic.os}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {lic.activationCount > 0
                      ? `activated ${lic.activationCount}×${
                          lic.lastActivatedAt
                            ? ` · ${new Date(lic.lastActivatedAt).toLocaleDateString()}`
                            : ""
                        }`
                      : "not activated yet"}
                  </span>
                </div>
                <StatusBadge status={lic.status} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          Licenses reflect the real backend state — statuses change the moment
          the operator acts or the 72-hour window expires. Passwords stay
          encrypted server-side and are emailed only to the operator.
        </p>
      </div>
    </div>
  );
}
