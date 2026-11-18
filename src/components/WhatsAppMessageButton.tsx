import { useQuery } from "convex/react";
import { MessageCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEFAULT_PREFILL =
  "Hi FlashBolt — I'm a subscriber. I need help with my passcode / desktop activation password.";

/**
 * "Message the operator on WhatsApp" — the operator's second default inbox
 * for receiving subscriber messages (pass codes with all necessary
 * information, activation passwords, etc.) alongside the operator email.
 *
 * Real click-to-chat: the operator's E.164 number is stored in the backend
 * (whatsappConfig.supportNumber) and this button opens a genuine wa.me thread
 * with that number, pre-filled with a subscriber message template. It only
 * renders once the operator sets their number in the console — no number, no
 * button, nothing simulated.
 */
export function WhatsAppMessageButton({
  className,
  prefill = DEFAULT_PREFILL,
}: {
  className?: string;
  prefill?: string;
}) {
  const data = useQuery(api.whatsapp.getWhatsAppChannel);
  const number = data?.supportNumber?.trim();
  if (!number) return null;

  const digitsOnly = number.replace(/^\+/, "");
  const href = `https://wa.me/${digitsOnly}?text=${encodeURIComponent(prefill)}`;

  return (
    <Button
      type="button"
      variant="outline"
      className={cn("shrink-0", className)}
      asChild
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Message the operator on WhatsApp"
        title="Message the operator on WhatsApp"
      >
        <MessageCircle className="size-4 text-[#25D366]" />
        Message the operator on WhatsApp
      </a>
    </Button>
  );
}
