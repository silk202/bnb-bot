import { api } from "@/convex/_generated/api";
import { detectLocation } from "@/lib/gate";
import { useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  FileUp,
  Loader2,
  LocateFixed,
  Paperclip,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type SubscribeSubject = "request" | "send" | "other";

const ACCEPTED_FILES = ".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf";
const FILE_RE = /(image\/(png|jpe?g)|application\/pdf)/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILE_BYTES = 1_500_000;

const SUBJECT_LABELS: Record<SubscribeSubject, string> = {
  request: "Request a passcode",
  send: "Send a passcode",
  other: "Other issues",
};

export function SubscribeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submit = useMutation(api.gate.subscriberSubmit);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [location, setLocation] = useState("");
  const [subject, setSubject] = useState<SubscribeSubject>("request");
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState("");
  const [locating, setLocating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Live backend check: is this email already a registered subscriber?
  // (required to enable Submit when "Send a passcode" is selected)
  const emailNorm = email.trim().toLowerCase();
  const registered = useQuery(api.gate.subscriberRegistered, {
    email: EMAIL_RE.test(emailNorm) ? emailNorm : "",
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    setFileName("");
    setFileData("");
    setSubject("request");
    setLocating(true);
    detectLocation().then((loc) => {
      setLocation(loc);
      setLocating(false);
    });
  }, [open]);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!FILE_RE.test(file.type)) {
      setError("Only .png, .jpg, .jpeg or .pdf files are accepted.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("File is too large (max ~1.5 MB).");
      return;
    }
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setFileData(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };

  const fieldsComplete =
    fullName.trim().length >= 2 &&
    EMAIL_RE.test(emailNorm) &&
    location.trim().length >= 2 &&
    message.trim().length >= 3;

  const canSubmit =
    fieldsComplete &&
    (subject === "request" ||
      subject === "other" ||
      (subject === "send" && Boolean(fileData) && registered?.registered === true));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (subject === "send" && !fileData) {
      setError(
        'Please upload a payment receipt file (.png, .jpg, .jpeg, .pdf) when "Send a passcode" is selected.',
      );
      return;
    }
    if (subject === "send" && registered?.registered !== true) {
      setError(
        'This email address is not registered yet — choose "Request a passcode" first so a passcode can be issued to it.',
      );
      return;
    }
    setIsLoading(true);
    try {
      const res = await submit({
        fullName: fullName.trim(),
        email: email.trim(),
        location: location.trim(),
        subject,
        message: message.trim(),
        file: fileData || undefined,
        fileName: fileName || undefined,
      });
      if (res.subject === "send") {
        setResult(
          "Submitted — the operator has been notified with your payment receipt. Once it is confirmed in the backend, the unique passcode will be sent to your email.",
        );
      } else if (res.subject === "other") {
        setResult(
          "Submitted — your message has been forwarded to the terminal operator. They will get back to you.",
        );
      } else {
        setResult(
          "Submitted — your details and a unique passcode were sent to the operator for review. Once confirmed, the passcode is emailed to you through the operator console.",
        );
      }
      toast.success(
        res.emailDelivered
          ? "Request dispatched to the terminal operator."
          : "Stored in the backend — the email channel is unavailable right now, try again.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Subscribe to FlashBolt</DialogTitle>
          <DialogDescription>
            Request or confirm a unique passcode for terminal access, or send
            other issues to the operator. Passcodes are never generated on this
            screen — they are issued from the backend after review.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sub-full-name">Full name</Label>
            <Input
              id="sub-full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your full name"
              required
              disabled={isLoading}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sub-email">Email address</Label>
            <Input
              id="sub-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              disabled={isLoading}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sub-location">Location (auto-detected)</Label>
            <div className="relative">
              <Input
                id="sub-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, Country"
                disabled={isLoading}
              />
              {locating && (
                <LocateFixed className="absolute right-3 top-3 size-4 animate-pulse text-muted-foreground" />
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Subject line</Label>
            <Select
              value={subject}
              onValueChange={(v) => setSubject(v as SubscribeSubject)}
              disabled={isLoading}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a subject" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SUBJECT_LABELS) as SubscribeSubject[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {SUBJECT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {subject === "send" && registered?.registered === false && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                This email is not registered yet — choose "Request a passcode"
                first so a passcode can be issued to it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sub-message">Message</Label>
            <Textarea
              id="sub-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                subject === "request"
                  ? "Subscription interest / passcode request"
                  : subject === "send"
                    ? "Payment details for passcode release"
                    : "Describe your issue"
              }
              rows={3}
              required
              disabled={isLoading}
            />
          </div>

          {subject === "send" && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Paperclip className="mt-0.5 size-3.5 shrink-0" />
              Attach your payment receipt (.png, .jpg, .jpeg, .pdf, max 1.5 MB)
              — required. The receipt is stored in the backend for the operator
              to confirm, reject or delete.
            </p>
          )}
          {subject === "other" && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Paperclip className="mt-0.5 size-3.5 shrink-0" />
              Both registered and unregistered email addresses are welcome.
              Your message is sent to the terminal operator only.
            </p>
          )}

          {fileName && (
            <p className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary">
              <Paperclip className="size-3.5" />
              {fileName}
            </p>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
          {result && (
            <p className="flex items-start gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              {result}
            </p>
          )}

          {/* Close | file upload | Submit */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              <X className="mr-1.5 size-4" />
              Close
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Upload file"
              title="Upload .png / .jpg / .jpeg / .pdf"
              disabled={isLoading}
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="size-4" />
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_FILES}
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <Button type="submit" className="ml-auto" disabled={isLoading || !canSubmit}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                "Submit"
              )}
            </Button>
          </div>
          {!fieldsComplete && (
            <p className="text-center text-[11px] text-muted-foreground">
              Complete all fields to activate Submit.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
