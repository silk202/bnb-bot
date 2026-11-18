import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Real client-side reachability probe. `mode: "no-cors"` lets the browser
 * send the cross-origin GET and reject when the network/ISP blocks the host
 * (e.g. ERR_BLOCKED_BY_RESPONSE — exactly the failure in the field), which
 * the Convex-side probe cannot see. Nothing is simulated: the verdict is the
 * browser's real response, or lack of one.
 */
async function probeReachable(url: string, timeoutMs = 3500): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Official WhatsApp glyph (Simple Icons path, viewBox 0 0 24 24).
 */
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

/**
 * WhatsApp channel button — rendered in the top bar of every page (gate,
 * landing, auth, downloads, terminal) for operators AND subscribers. Reads
 * the real channel links from the backend (whatsappConfig row) and opens the
 * one the backend resolves. The backend runs a real reachability check
 * (resolveWhatsAppChannel): when the primary channel link fails, it returns
 * the stored alternative (web.whatsapp.com variant) instead — so the button
 * always connects users to a live link, with nothing simulated. Hidden if
 * the backend has no link.
 */
export function WhatsAppChannelButton({ className }: { className?: string }) {
  const data = useQuery(api.whatsapp.getWhatsAppChannel);
  const resolveChannel = useAction(api.whatsapp.resolveWhatsAppChannel);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  // Ask the backend which link is live (primary, or the stored fallback when
  // the primary fails its real reachability check). Runs in the background so
  // the button stays instantly clickable on the configured primary while the
  // probe resolves. Any failure keeps the configured primary — never a dead end.
  useEffect(() => {
    let cancelled = false;
    resolveChannel()
      .then((res) => {
        if (!cancelled && res?.url) setResolvedUrl(res.url);
      })
      .catch(() => {
        // Backend unreachable — the configured primary below still works.
      });
    return () => {
      cancelled = true;
    };
  }, [resolveChannel]);

  const url = resolvedUrl ?? data?.url;
  if (!url) return null;

  // Before opening, probe from THIS browser: when the primary is unreachable
  // here (blocked / refused to connect), open the backend's alternative link
  // (web.whatsapp.com variant) instead — the real fix for a blocked channel.
  const handleClick = async () => {
    const primary = url;
    const fallback = data?.fallbackUrl?.trim();
    let target = primary;
    if (fallback && fallback !== primary) {
      setProbing(true);
      try {
        const primaryOk = await probeReachable(primary);
        if (!primaryOk) {
          const fallbackOk = await probeReachable(fallback);
          if (fallbackOk) target = fallback;
        }
      } finally {
        setProbing(false);
      }
    }
    window.open(target, "_blank", "noopener,noreferrer");
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Join our WhatsApp channel"
      title="Join our WhatsApp channel"
      className={cn("shrink-0", className)}
      disabled={probing}
      onClick={() => void handleClick()}
    >
      {probing ? (
        <Loader2 className="size-4 animate-spin text-[#25D366]" />
      ) : (
        <WhatsAppGlyph className="size-4 text-[#25D366]" />
      )}
    </Button>
  );
}
