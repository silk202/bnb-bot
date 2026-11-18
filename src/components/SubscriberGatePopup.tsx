import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, KeyRound, Mail } from "lucide-react";

interface SubscriberGatePopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * Popup window that gates subscriber access from the landing page.
 * Displays two fields: subscribing email address + unique permit code.
 * Verifies against the backend before allowing navigation to the auth page.
 */
export function SubscriberGatePopup({
  open,
  onOpenChange,
  onSuccess,
}: SubscriberGatePopupProps) {
  const verifyPermitGate = useMutation(api.gate.verifySubscriberPermitGate);
  const [email, setEmail] = useState("");
  const [permitCode, setPermitCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyPermitGate({
        email: email.trim(),
        permitCode: permitCode.trim(),
      });
      // Store verified gate state in sessionStorage so the auth page
      // knows the subscriber already verified their permit code
      sessionStorage.setItem(
        "flashbolt.subscriber.gate",
        JSON.stringify({ email: email.trim(), verifiedAt: Date.now() }),
      );
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Invalid email or permit code. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center">
          <DialogTitle className="flex items-center justify-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            Subscriber Access Gate
          </DialogTitle>
          <DialogDescription>
            Enter your subscribing email address and unique permit code to
            access the subscriber terminal. The permit code was emailed to you
            by the operator.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gate-email">Subscribing email address</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="gate-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="pl-9"
                required
                disabled={busy}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gate-permit">Unique permit code</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="gate-permit"
                value={permitCode}
                onChange={(e) => setPermitCode(e.target.value)}
                placeholder="FP-XXXX-XXXX"
                className="pl-9 font-mono uppercase"
                required
                disabled={busy}
              />
            </div>
          </div>
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || !email.trim() || !permitCode.trim()}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="mr-2 h-4 w-4" />
            )}
            Verify & continue
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            No permit code yet? Subscribe using the form on the gate page —
            the operator will send your unique passcode and permit code.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
