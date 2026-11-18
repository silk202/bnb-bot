import { api } from "@/convex/_generated/api";
import { formatExpiry, isPasscodeExpired } from "@/lib/gate";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  AtSign,
  Ban,
  Building2,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  EyeOff,
  FileImage,
  KeyRound,
  Landmark,
  Loader2,
  LockKeyhole,
  MailCheck,
  MessageCircle,
  Minus,
  Monitor,
  Plus,
  Power,
  RefreshCcw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Timer,
  Trash2,
  UserCog,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { TradeNotificationPanel } from "@/components/TradeNotificationPanel";
import {
  TRADE_CRYPTO_ASSETS,
  TRADE_CASH_ASSETS,
  TRADE_NETWORKS,
  BANK_DEPOSIT_CURRENCIES,
  currencySymbol,
  tradeDetailKey,
} from "@/convex/tradeAssets";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Operator console — shown on the terminal page ONLY for the terminal
 * operator (never for subscribers). Real backend data only:
 * - Operator credentials are stored encrypted; the hidden operator email can
 *   be revealed ("visible") for a short, non-editable window after a one-time
 *   code is verified, or changed within a short editable window.
 * - Subscriber passcodes are stored encrypted and masked everywhere — the
 *   plaintext never leaves the backend. The "send" trigger delivers the
 *   passcode to the subscriber only when it has not expired (and, for payment
 *   receipts, only after confirmation). Every action lands in the audit log.
 */
// Terminal-controls card — the four standard market sessions with their
// default UTC windows (mirrors the Signals engine defaults).
const SESSION_ROWS = [
  { key: "sydney", label: "Sydney", flag: "🇦🇺", openMin: 21 * 60, closeMin: 6 * 60 },
  { key: "tokyo", label: "Tokyo", flag: "🇯🇵", openMin: 0, closeMin: 9 * 60 },
  { key: "london", label: "London", flag: "🇬🇧", openMin: 7 * 60, closeMin: 16 * 60 },
  { key: "new_york", label: "New York", flag: "🇺🇸", openMin: 12 * 60, closeMin: 21 * 60 },
];

function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/40 px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-extrabold tracking-tight text-foreground">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

/** Human label for a rate-limit bucket (server-side enforcement windows). */
function prettifyBucket(bucket: string): string {
  const [kind, ...rest] = bucket.split(":");
  const target = rest.join(":");
  switch (kind) {
    case "operator-login":
      return "Operator login";
    case "operator-code-reveal":
      return "Operator code — reveal";
    case "operator-code-change":
      return "Operator code — change";
    case "operator-verify-reveal":
      return "Operator verify — reveal";
    case "operator-verify-change":
      return "Operator verify — change";
    case "operator-whatsapp-reveal":
      return "Operator WhatsApp link — reveal code";
    case "operator-whatsapp-edit":
      return "Operator WhatsApp link — edit code";
    case "operator-whatsapp-verify":
      return "Operator WhatsApp link — verify code";
    case "subscriber-login":
      return `Subscriber login · ${target}`;
    case "subscriber-submit":
      return `Subscription submit · ${target}`;
    case "subscriber-send":
      return `Passcode send · ${target}`;
    case "activate":
      return `License activation · ${target}`;
    default:
      return bucket;
  }
}

function fmtReset(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const SUBSCRIPTION_PLANS = [
  { value: "free", label: "Free (no plan expiry)", months: 0 },
  { value: "1month", label: "1 Month", months: 1 },
  { value: "2month", label: "2 Months", months: 2 },
  { value: "3month", label: "3 Months", months: 3 },
  { value: "4month", label: "4 Months", months: 4 },
  { value: "5month", label: "5 Months", months: 5 },
  { value: "6month", label: "6 Months", months: 6 },
  { value: "9month", label: "9 Months", months: 9 },
  { value: "1year", label: "1 Year", months: 12 },
] as const;

export function OperatorConsole() {
  const subscribers = useQuery(api.gate.listSubscribers);
  const logs = useQuery(api.gate.listAuditLogs, { limit: 80 });
  const licenses = useQuery(api.licenses.listLicenses);
  const rateBuckets = useQuery(api.rateLimit.getActiveBuckets, {});
  const pingChannels = useAction(api.notifications.pingChannels);

  // Terminal controls — operator-tuned honeypot / news / session settings.
  const terminalCfg = useQuery(api.terminalConfig.getTerminalConfig);
  const updateTerminalCfg = useMutation(api.terminalConfig.updateTerminalConfig);
  const [honeyProfit, setHoneyProfit] = useState("0.5");
  const [honeyLiq, setHoneyLiq] = useState("250000");
  const [keywords, setKeywords] = useState("");
  const [sessionTimes, setSessionTimes] = useState<
    Record<string, { open: string; close: string }>
  >({});
  const [cfgDirty, setCfgDirty] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);

  // Load the effective config into the draft once (and only before the
  // operator edits anything — their draft is never overwritten).
  useEffect(() => {
    if (!terminalCfg || cfgDirty) return;
    setHoneyProfit(String(terminalCfg.honeyMinProfitPct));
    setHoneyLiq(String(terminalCfg.honeyMinLiquidityUsd));
    setKeywords(terminalCfg.newsKeywords.join(", "));
    const times: Record<string, { open: string; close: string }> = {};
    for (const row of SESSION_ROWS) {
      const o = terminalCfg.sessionOverrides[row.key];
      times[row.key] = {
        open: minutesToTime(o?.openMin ?? row.openMin),
        close: minutesToTime(o?.closeMin ?? row.closeMin),
      };
    }
    setSessionTimes(times);
  }, [terminalCfg, cfgDirty]);

  const handleSaveTerminalConfig = async () => {
    setSavingCfg(true);
    try {
      const overrides: Record<string, { openMin: number; closeMin: number }> =
        {};
      for (const row of SESSION_ROWS) {
        const t = sessionTimes[row.key] ?? {
          open: minutesToTime(row.openMin),
          close: minutesToTime(row.closeMin),
        };
        overrides[row.key] = {
          openMin: timeToMinutes(t.open),
          closeMin: timeToMinutes(t.close),
        };
      }
      await updateTerminalCfg({
        honeyMinProfitPct: Number(honeyProfit) || 0,
        honeyMinLiquidityUsd: Number(honeyLiq) || 0,
        newsKeywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
        sessionOverrides: overrides,
      });
      setCfgDirty(false);
      toast.success(
        "Terminal settings saved — the scanner, news and session engines now use them.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save terminal settings.",
      );
    } finally {
      setSavingCfg(false);
    }
  };

  // Real Telegram delivery check — same Bot API path as trades and signals.
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramResult, setTelegramResult] = useState<{
    enabled: boolean;
    ok: boolean;
    description: string;
  } | null>(null);

  // Live summary — computed from the same backend rows rendered below.
  const subRows = subscribers ?? [];
  const licRows = licenses ?? [];
  const activeSubs = subRows.filter(
    (s) => s.status !== "blocked" && !isPasscodeExpired(s.expiresAt),
  ).length;
  const blockedSubs = subRows.filter((s) => s.status === "blocked").length;
  const pendingPayments = subRows.filter(
    (s) => s.subject === "send" && s.paymentStatus !== "confirmed",
  ).length;
  const licensesActive = licRows.filter((l) => l.status === "active").length;
  const licensesExpired = licRows.filter((l) => l.status === "expired").length;
  const licensesBlocked = licRows.filter((l) => l.status === "blocked").length;

  const sendTelegramTest = async () => {
    setTelegramBusy(true);
    setTelegramResult(null);
    try {
      const res = await pingChannels({
        title: "Operator test",
        body: `Test message from the FlashBolt operator console — ${new Date().toLocaleString()}. Real delivery through the Bot API.`,
      });
      setTelegramResult(res);
    } catch (error) {
      setTelegramResult({
        enabled: true,
        ok: false,
        description:
          error instanceof Error ? error.message : "Test send failed.",
      });
    } finally {
      setTelegramBusy(false);
    }
  };

  const block = useMutation(api.gate.blockSubscriber);
  const unblock = useMutation(api.gate.unblockSubscriber);
  const change = useMutation(api.gate.changeSubscriberCode);
  const update = useMutation(api.gate.updateSubscriberCode);
  const setExpiry = useMutation(api.gate.setSubscriberExpiry);
  const send = useMutation(api.gate.sendSubscriberCode);
  const confirmPayment = useMutation(api.gate.confirmPaymentReceipt);
  const rejectPayment = useMutation(api.gate.rejectPaymentReceipt);
  const removeSubscriber = useMutation(api.gate.deleteSubscriber);

  // ---- subscriber permit code management ----
  const blockPermit = useMutation(api.gate.blockSubscriberPermit);
  const unblockPermit = useMutation(api.gate.unblockSubscriberPermit);
  const changePermit = useMutation(api.gate.changeSubscriberPermitCode);
  const updatePermit = useMutation(api.gate.updateSubscriberPermitCode);
  const sendPermit = useMutation(api.gate.sendSubscriberPermitCode);
  const deletePermit = useMutation(api.gate.deleteSubscriberPermit);
  const setSubscriptionPlanMut = useMutation(api.gate.setSubscriptionPlan);
  // Subscriber daily execution target (arb + snipe combined, both terminals).
  const setDailyTarget = useMutation(api.terminal.setSubscriberDailyTarget);
  const resetDailyCounter = useMutation(api.terminal.resetSubscriberDailyCounter);

  // ---- operator credential management ----
  const requestCode = useMutation(api.gate.requestOperatorCode);
  const verifyCode = useMutation(api.gate.verifyOperatorCode);
  const updateEmail = useMutation(api.gate.updateOperatorEmail);
  const updatePassphrase = useMutation(api.gate.updateOperatorPassphrase);

  const [flow, setFlow] = useState<"none" | "reveal" | "change">("none");
  const [codeInput, setCodeInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; passphrase: string; altEmail?: string } | null>(null);
  const [revealExpiresAt, setRevealExpiresAt] = useState<number | null>(null);
  const [changeCurrent, setChangeCurrent] = useState<string | null>(null);
  const [changeExpiresAt, setChangeExpiresAt] = useState<number | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [now, setNow] = useState(Date.now());
  const [credBusy, setCredBusy] = useState<string | null>(null);

  // 1s ticker for the short visible/editable windows
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // auto-hide once the reveal window lapses
  useEffect(() => {
    if (revealExpiresAt && now > revealExpiresAt) {
      setRevealed(null);
      setRevealExpiresAt(null);
      setFlow("none");
      setCodeSent(false);
      toast.info("The operator credentials are hidden again (visible window elapsed).");
    }
  }, [now, revealExpiresAt]);

  // auto-lock once the change window lapses
  useEffect(() => {
    if (changeExpiresAt && now > changeExpiresAt) {
      setChangeCurrent(null);
      setChangeExpiresAt(null);
      setNewEmail("");
      setNewPassphrase("");
      setFlow("none");
      setCodeSent(false);
      toast.info("The change session has expired — request a new one-time code.");
    }
  }, [now, changeExpiresAt]);

  const revealSeconds = revealExpiresAt ? Math.max(0, Math.ceil((revealExpiresAt - now) / 1000)) : 0;
  const changeSeconds = changeExpiresAt ? Math.max(0, Math.ceil((changeExpiresAt - now) / 1000)) : 0;

  // ---- message delivery preference (which inboxes receive messages) ----
  const deliveryPrefQuery = useQuery(api.gate.getOperatorDeliveryPref);
  const setDeliveryPref = useMutation(api.gate.setOperatorDeliveryPref);
  // Guest passcode management
  const guestPasscodeInfo = useQuery(api.gate.getGuestPasscodeInfo);
  const setGuestPasscodeMode = useMutation(api.gate.setGuestPasscodeMode);
  const changeGuestPasscode = useMutation(api.gate.changeGuestPasscode);
  const [guestMode, setGuestModeDraft] = useState<"popup" | "email">("popup");
  const [guestModeDirty, setGuestModeDirty] = useState(false);
  const [guestModeBusy, setGuestModeBusy] = useState(false);
  const [guestPasscodeRevealed, setGuestPasscodeRevealed] = useState(false);
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [changePasscodeBusy, setChangePasscodeBusy] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);

  useEffect(() => {
    if (guestPasscodeInfo?.mode && !guestModeDirty) {
      setGuestModeDraft(guestPasscodeInfo.mode);
    }
  }, [guestPasscodeInfo, guestModeDirty]);

  const saveGuestMode = async () => {
    setGuestModeBusy(true);
    try {
      await setGuestPasscodeMode({ mode: guestMode });
      setGuestModeDirty(false);
    } catch {
      // handled below
    } finally {
      setGuestModeBusy(false);
    }
  };

  const handleChangePasscode = async () => {
    setChangePasscodeBusy(true);
    try {
      const result = await changeGuestPasscode({});
      setRevealedCode(result.code);
      setGuestPasscodeRevealed(true);
    } catch {
      // handled below
    } finally {
      setChangePasscodeBusy(false);
    }
  };

const [deliveryPref, setDeliveryPrefDraft] = useState<
    "all" | "primary" | "secondary" | "whatsapp"
  >("all");
  const [deliveryDirty, setDeliveryDirty] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);

  // Load the stored preference once (and only before the operator edits it).
  useEffect(() => {
    if (deliveryPrefQuery?.pref && !deliveryDirty) {
      setDeliveryPrefDraft(deliveryPrefQuery.pref);
    }
  }, [deliveryPrefQuery, deliveryDirty]);

  const saveDeliveryPref = async () => {
    setDeliveryBusy(true);
    try {
      await setDeliveryPref({ pref: deliveryPref });
      setDeliveryDirty(false);
      toast.success(
        "Delivery preference saved — incoming messages now go to the selected inboxes.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save the delivery preference.",
      );
    } finally {
      setDeliveryBusy(false);
    }
  };

  // ---- subscriber registry unlock (either operator default email + passphrase) ----
  const operatorLogin = useAction(api.gate.operatorLogin);
  const exportCsv = useMutation(api.gate.exportSubscribersCsv);
  const [registryUnlocked, setRegistryUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem("fb-registry-unlocked") === "1";
    } catch {
      return false;
    }
  });
  const [registryEmail, setRegistryEmail] = useState("");
  const [registryPassphrase, setRegistryPassphrase] = useState("");
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const handleRegistryUnlock = async () => {
    setRegistryBusy(true);
    setRegistryError(null);
    try {
      await operatorLogin({ email: registryEmail, passphrase: registryPassphrase });
      setRegistryUnlocked(true);
      try {
        sessionStorage.setItem("fb-registry-unlocked", "1");
      } catch {
        // private mode — unlock lasts for this page session only
      }
      setRegistryEmail("");
      setRegistryPassphrase("");
      toast.success("Subscriber registry unlocked.");
    } catch (error) {
      setRegistryError(
        error instanceof Error ? error.message : "Unlock failed — check the email and passphrase.",
      );
    } finally {
      setRegistryBusy(false);
    }
  };

  const handleExportCsv = async () => {
    setBusy("csv-export");
    try {
      const res = await exportCsv();
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`Subscriber registry exported as CSV (${res.count} rows).`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  // ---- subscriber table state ----
  const [editEmail, setEditEmail] = useState<string | null>(null);
  const [editCode, setEditCode] = useState("");
  const [expiryEmail, setExpiryEmail] = useState<string | null>(null);
  const [expiryHours, setExpiryHours] = useState("");
  const [targetEmail, setTargetEmail] = useState<string | null>(null);
  const [targetValue, setTargetValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(okMsg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const submitUpdate = async (email: string) => {
    if (!editCode.trim()) return;
    await run(
      `update-${email}`,
      () => update({ email, passcode: editCode }),
      "Passcode updated (stored encrypted)",
    );
    setEditEmail(null);
    setEditCode("");
  };

  const submitExpiry = async (email: string) => {
    const hours = Number(expiryHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) return;
    await run(
      `expiry-${email}`,
      () => setExpiry({ email, hours }),
      "Expiry window updated (timer restarted)",
    );
    setExpiryEmail(null);
    setExpiryHours("");
  };

  const submitDailyTarget = async (email: string) => {
    const limit = Number(targetValue);
    if (!Number.isFinite(limit) || limit < 0 || limit > 1000) return;
    await run(
      `target-${email}`,
      () => setDailyTarget({ email, limit }),
      limit === 0
        ? "Executions blocked for this subscriber (daily target = 0)"
        : `Daily target set to ${limit} for ${email}`,
    );
    setTargetEmail(null);
    setTargetValue("");
  };

  const handleRequestCode = async (purpose: "reveal" | "change") => {
    setCredBusy(purpose);
    try {
      const res = await requestCode({ purpose });
      setFlow(purpose);
      setCodeInput("");
      setCodeSent(true);
      toast.info(
        res.emailDelivered
          ? "One-time code dispatched to the operator email — check the inbox."
          : "Code stored — the email channel is unavailable right now, try again.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send the code.");
    } finally {
      setCredBusy(null);
    }
  };

  const handleVerifyCode = async () => {
    if (flow === "none") return;
    setCredBusy("verify");
    try {
      const res = await verifyCode({ purpose: flow, code: codeInput });
      if (flow === "reveal" && "reveal" in res && res.reveal) {
        setRevealed({
          email: res.reveal.email,
          passphrase: res.reveal.passphrase,
          altEmail: res.reveal.altEmail ?? "",
        });
        setRevealExpiresAt(res.revealExpiresAt);
        setCodeSent(false);
        toast.success("Code verified — credentials revealed for a short window.");
      } else if (flow === "change" && "current" in res && res.current) {
        setChangeCurrent(res.current);
        setNewEmail(res.current);
        setNewPassphrase("");
        setChangeExpiresAt(res.changeExpiresAt);
        setCodeSent(false);
        toast.success("Code verified — you may now edit the credentials and press Update.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setCredBusy(null);
    }
  };

  const handleUpdateEmail = async () => {
    setCredBusy("update-email");
    try {
      await updateEmail({ email: newEmail });
      setChangeCurrent(null);
      setChangeExpiresAt(null);
      setFlow("none");
      toast.success("Operator email updated and re-encrypted in the backend.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setCredBusy(null);
    }
  };

  const handleUpdatePassphrase = async () => {
    setCredBusy("update-passphrase");
    try {
      await updatePassphrase({ passphrase: newPassphrase });
      setChangeCurrent(null);
      setChangeExpiresAt(null);
      setFlow("none");
      setNewPassphrase("");
      toast.success("Operator passphrase updated and re-encrypted in the backend.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setCredBusy(null);
    }
  };

  const handleDelete = async (email: string) => {
    if (!window.confirm(`Delete the subscriber record for ${email} permanently?`)) return;
    await run(`delete-${email}`, () => removeSubscriber({ email }), "Subscriber record deleted");
  };

  return (
    <div className="space-y-6">
      {/* Real-time operator summary — computed from the live backend rows */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Subscribers"
          value={String(subRows.length)}
          sub={`${activeSubs} active · ${blockedSubs} blocked`}
        />
        <SummaryCard
          label="Pending payment confirmations"
          value={String(pendingPayments)}
          sub="send-passcode requests awaiting confirmation"
        />
        <SummaryCard
          label="Desktop licenses"
          value={String(licRows.length)}
          sub={`${licensesActive} active · ${licensesExpired} expired · ${licensesBlocked} blocked`}
        />
        <SummaryCard
          label="Audit events"
          value={String(logs?.length ?? 0)}
          sub="most recent 80 shown below"
        />
      </div>

      {/* Message delivery preference — which inboxes receive incoming messages */}
      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Message delivery
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Choose which inboxes receive incoming messages — subscriber
                submissions (request a passcode / send a passcode / other
                issues), unique pass codes, payment receipts, desktop
                activation passwords and one-time codes — from subscriber and
                operator actions alike. Every event is delivered simultaneously
                to every selected channel.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void saveDeliveryPref()}
            disabled={deliveryBusy || !deliveryDirty}
          >
            {deliveryBusy ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 size-4" />
            )}
            Save
          </Button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              key: "all" as const,
              title: "All channels",
              desc: "Both default emails + WhatsApp chat link (default)",
            },
            {
              key: "primary" as const,
              title: "Primary email",
              desc: "Primary default inbox only",
            },
            {
              key: "secondary" as const,
              title: "Secondary email",
              desc: "Alternative default inbox only",
            },
            {
              key: "whatsapp" as const,
              title: "WhatsApp chat link",
              desc: "WhatsApp only — no emails",
            },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                setDeliveryPrefDraft(opt.key);
                setDeliveryDirty(true);
              }}
              className={`rounded-xl border px-3.5 py-3 text-left transition-colors ${
                deliveryPref === opt.key
                  ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                  : "border-border/60 bg-background/40 hover:border-border"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    deliveryPref === opt.key
                      ? "bg-primary"
                      : "bg-muted-foreground/40"
                  }`}
                />
                <span className="text-xs font-bold text-foreground">{opt.title}</span>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {opt.desc}
              </p>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          The hidden operator default email addresses never appear in this view
          — the preference is stored encrypted in the backend and enforced on
          every delivery.
        </p>
      </div>

      {/* Guest passcode management — mode selector + passcode view/change */}
      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Guest passcode
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Manage how "Continue as Guest" delivers the one-time passcode.
                In <b>Popup</b> mode, the code is generated and displayed directly
                in the popup window. In <b>Email</b> mode, the code is emailed to
                the operator's default address. The passcode is securely encrypted
                in the backend.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void saveGuestMode()}
            disabled={guestModeBusy || !guestModeDirty}
          >
            {guestModeBusy ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 size-4" />
            )}
            Save
          </Button>
        </div>

        {/* Mode selector */}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            {
              key: "popup" as const,
              title: "Popup display (default)",
              desc: "Code shown directly in the popup — no email needed",
            },
            {
              key: "email" as const,
              title: "Email delivery",
              desc: "Code sent to operator's default email address",
            },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                setGuestModeDraft(opt.key);
                setGuestModeDirty(true);
              }}
              className={`rounded-xl border px-3.5 py-3 text-left transition-colors ${
                guestMode === opt.key
                  ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                  : "border-border/60 bg-background/40 hover:border-border"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    guestMode === opt.key
                      ? "bg-primary"
                      : "bg-muted-foreground/40"
                  }`}
                />
                <span className="text-xs font-bold text-foreground">{opt.title}</span>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {opt.desc}
              </p>
            </button>
          ))}
        </div>

        {/* Active passcode status */}
        {guestPasscodeInfo && (
          <div className="mt-4 rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-foreground">Current passcode</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {guestPasscodeInfo.active
                    ? `Active — expires ${guestPasscodeInfo.expiresAt ? new Date(guestPasscodeInfo.expiresAt).toLocaleTimeString() : "soon"}`
                    : "No active passcode"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {guestPasscodeRevealed && revealedCode ? (
                  <span className="font-mono text-sm font-bold text-primary">{revealedCode}</span>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground">
                    {guestPasscodeInfo.maskedCode ?? "••••••"}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={revealBusy || changePasscodeBusy}
                onClick={() => {
                  if (guestPasscodeRevealed) {
                    setGuestPasscodeRevealed(false);
                    setRevealedCode(null);
                  } else {
                    handleChangePasscode();
                  }
                }}
              >
                {changePasscodeBusy ? (
                  <Loader2 className="mr-1.5 size-3 animate-spin" />
                ) : guestPasscodeRevealed ? (
                  <EyeOff className="mr-1.5 size-3" />
                ) : (
                  <Eye className="mr-1.5 size-3" />
                )}
                {guestPasscodeRevealed ? "Hide" : "Reveal & change"}
              </Button>
            </div>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          All guest passcodes are stored AES-256-GCM encrypted in the backend.
          The "Forgot passcode" button on the auth page sends a reset link via
          the operator's default delivery method.
        </p>
      </div>

      {/* Trade notifications — sound + push toggles */}
      <TradeNotificationPanel />

      {/* Telegram channel — real Bot API delivery check */}
      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Send className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Telegram channel
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Verify live delivery with a real test message. Channel policy:
                only flash-loan trades + earnings (operator &amp; subscribers)
                and the explicit session dashboards are posted to Telegram —
                all other alerts stay in-app (the bell) or go to the operator
                email.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void sendTelegramTest()}
            disabled={telegramBusy}
          >
            {telegramBusy ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Send className="mr-2 size-4" />
            )}
            Send test message
          </Button>
        </div>
        {telegramResult && (
          <p
            className={`mt-3 flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs ${
              telegramResult.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {telegramResult.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              {telegramResult.ok
                ? "Delivered to the channel through the real Bot API."
                : telegramResult.enabled
                  ? "Send failed — the Bot API rejected the request."
                  : "Telegram not configured — add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in Keys."}
              <span className="text-muted-foreground">
                {" "}
                {telegramResult.description}
              </span>
            </span>
          </p>
        )}
      </div>

      {/* Server-side rate limits — real throttles currently active */}
      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Timer className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Rate limits
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Real server-side throttles currently being enforced — operator
                login, one-time codes, subscriber logins, subscription
                submits, passcode sends and license activations. Buckets with
                2+ calls in the current window are listed (operator buckets
                are email-free; subscriber buckets show the subscriber email
                already visible in the console).
              </p>
            </div>
          </div>
          <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-400">
            {(rateBuckets ?? []).filter((b) => b.count >= 2).length} tracking
          </Badge>
        </div>
        {rateBuckets === undefined ? (
          <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
        ) : (rateBuckets ?? []).filter((b) => b.count >= 2).length === 0 ? (
          <p className="mt-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
            No active throttle buckets — nothing has hit a limit in the
            current windows.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {(rateBuckets ?? [])
              .filter((b) => b.count >= 2)
              .map((b) => (
                <li
                  key={b.bucket}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {prettifyBucket(b.bucket)}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {b.count}/{b.limit} used · resets in {fmtReset(b.resetsInMs)}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      b.count >= b.limit
                        ? "bg-red-500/15 text-red-400"
                        : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    {b.count >= b.limit ? "Limited" : "Tracking"}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Terminal controls — operator-tuned honeypot / news / session settings */}
      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <SlidersHorizontal className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Terminal controls
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Real settings enforced by the actual engines: the honeypot
                scanner thresholds, the market-news high-signal watchlist and
                the market-session UTC windows (signals + terminal clocks).
                Saved values take effect on the next scan/signal run.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSaveTerminalConfig()}
            disabled={savingCfg || terminalCfg === undefined}
          >
            {savingCfg ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 size-4" />
            )}
            Save settings
          </Button>
        </div>

        {terminalCfg === undefined ? (
          <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Honey-pot scanner thresholds */}
            <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Honey-pot scanner
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px] text-muted-foreground">
                    Min profit %
                  </Label>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={honeyProfit}
                    onChange={(e) => {
                      setHoneyProfit(e.target.value);
                      setCfgDirty(true);
                    }}
                    className="mt-1 h-8 font-mono text-xs"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">
                    Min liquidity $
                  </Label>
                  <Input
                    type="number"
                    step="1000"
                    min="0"
                    value={honeyLiq}
                    onChange={(e) => {
                      setHoneyLiq(e.target.value);
                      setCfgDirty(true);
                    }}
                    className="mt-1 h-8 font-mono text-xs"
                  />
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                Routes must clear BOTH to qualify as honey pots in the
                scanner, guard panel and bell.
              </p>
            </div>

            {/* Market-news watchlist */}
            <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Market-news watchlist
              </div>
              <Label className="text-[10px] text-muted-foreground">
                Keywords (comma-separated)
              </Label>
              <textarea
                value={keywords}
                onChange={(e) => {
                  setKeywords(e.target.value);
                  setCfgDirty(true);
                }}
                rows={4}
                placeholder="flash loan, arbitrage, mev, exploit…"
                className="mt-1 w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
              />
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                Only NEW real RSS headlines matching these reach subscriber
                bells as market-news alerts.
              </p>
            </div>

            {/* Market-session windows */}
            <div className="rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Market sessions (UTC)
              </div>
              <ul className="mt-2 space-y-2">
                {SESSION_ROWS.map((row) => {
                  const t = sessionTimes[row.key] ?? {
                    open: minutesToTime(row.openMin),
                    close: minutesToTime(row.closeMin),
                  };
                  return (
                    <li
                      key={row.key}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="w-24 text-[11px] font-semibold text-foreground">
                        {row.flag} {row.label}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="time"
                          value={t.open}
                          onChange={(e) => {
                            setSessionTimes((prev) => ({
                              ...prev,
                              [row.key]: { ...t, open: e.target.value },
                            }));
                            setCfgDirty(true);
                          }}
                          className="h-7 rounded-md border border-input bg-background px-1.5 font-mono text-[11px] text-foreground outline-none transition-colors focus:border-primary"
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <input
                          type="time"
                          value={t.close}
                          onChange={(e) => {
                            setSessionTimes((prev) => ({
                              ...prev,
                              [row.key]: { ...t, close: e.target.value },
                            }));
                            setCfgDirty(true);
                          }}
                          className="h-7 rounded-md border border-input bg-background px-1.5 font-mono text-[11px] text-foreground outline-none transition-colors focus:border-primary"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                UTC minutes-of-day; sessions crossing midnight (Sydney, Tokyo)
                keep open &gt; close. Signals and terminal clocks use these
                windows.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Operator credentials (hidden email + passphrase) */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" />
          Operator credentials
        </h3>
        <div className="rounded-xl border border-border/70 p-4">
          <p className="text-xs text-muted-foreground">
            The operator email and passphrase are stored encrypted and hidden.
            Revealing them requires a one-time code sent to the operator email;
            they stay visible for a short window only, and changes become
            effective after you press Update within the change window.
          </p>

          {flow === "none" && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => handleRequestCode("reveal")}
                disabled={credBusy !== null}
              >
                <Eye className="mr-2 size-4" />
                Visible
              </Button>
              <Button
                variant="outline"
                onClick={() => handleRequestCode("change")}
                disabled={credBusy !== null}
              >
                <LockKeyhole className="mr-2 size-4" />
                Change
              </Button>
            </div>
          )}

          {codeSent && (
            <div className="mt-3 space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
              <p className="text-xs text-muted-foreground">
                A one-time code was sent to the operator email. Enter it below (
                {flow === "reveal" ? "visible" : "change"}).
              </p>
              <div className="flex gap-2">
                <Input
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="6-digit code"
                  className="font-mono"
                  maxLength={6}
                />
                <Button onClick={handleVerifyCode} disabled={credBusy !== null || codeInput.length !== 6}>
                  {credBusy === "verify" ? <Loader2 className="size-4 animate-spin" /> : "Verify"}
                </Button>
              </div>
            </div>
          )}

          {revealed && (
            <div className="mt-3 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Visible but unchangeable — hides automatically in {revealSeconds}s.</span>
                <EyeOff className="size-3.5" />
              </p>
              <div className="space-y-1.5 text-sm">
                <div>
                  <span className="text-xs font-semibold text-muted-foreground">Operator email (primary):</span>
                  <code className="mt-0.5 block break-all rounded bg-background px-2 py-1 font-mono">
                    {revealed.email}
                  </code>
                </div>
                {revealed.altEmail && (
                  <div>
                    <span className="text-xs font-semibold text-muted-foreground">Operator email (alternative):</span>
                    <code className="mt-0.5 block break-all rounded bg-background px-2 py-1 font-mono">
                      {revealed.altEmail}
                    </code>
                  </div>
                )}
                <div>
                  <span className="text-xs font-semibold text-muted-foreground">Passphrase:</span>
                  <code className="mt-0.5 block break-all rounded bg-background px-2 py-1 font-mono">
                    {revealed.passphrase}
                  </code>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                To change them, click Change — a new one-time code will be sent.
              </p>
            </div>
          )}

          {changeCurrent && (
            <div className="mt-3 space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
              <p className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Editable for {changeSeconds}s — press Update to make changes effective.</span>
                <LockKeyhole className="size-3.5" />
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="op-new-email">Operator email</Label>
                <Input
                  id="op-new-email"
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="operator@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="op-new-passphrase">New passphrase (min 8 chars)</Label>
                <Input
                  id="op-new-passphrase"
                  type="password"
                  value={newPassphrase}
                  onChange={(e) => setNewPassphrase(e.target.value)}
                  placeholder="Leave empty to keep the current one"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleUpdateEmail} disabled={credBusy !== null || newEmail.trim().length < 5}>
                  {credBusy === "update-email" ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Update email
                </Button>
                <Button
                  variant="outline"
                  onClick={handleUpdatePassphrase}
                  disabled={credBusy !== null || newPassphrase.length < 8}
                >
                  {credBusy === "update-passphrase" ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Update passphrase
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Subscriber registry — locked until the operator unlocks it with
          either default email + the same passphrase */}
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="size-4 text-primary" />
            Subscriber registry
            <Badge variant="secondary" className="ml-1">
              {subscribers?.length ?? "…"}
            </Badge>
          </h3>
          <span className="ml-auto" />
          {registryUnlocked && (
            <Button
              size="sm"
              variant="outline"
              title="Download all subscribers' info (incl. unique passcodes) as CSV"
              onClick={() => void handleExportCsv()}
              disabled={busy === "csv-export" || subRows.length === 0}
            >
              {busy === "csv-export" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 size-3.5" />
              )}
              Export CSV
            </Button>
          )}
        </div>

        {!registryUnlocked ? (
          <div className="rounded-xl border border-border/70 p-4">
            <p className="text-xs text-muted-foreground">
              The subscriber registry is locked. Unlock it with either
              operator default email address (primary or alternative) and the
              same operator passphrase.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="registry-email">Operator email address</Label>
                <Input
                  id="registry-email"
                  type="email"
                  value={registryEmail}
                  onChange={(e) => setRegistryEmail(e.target.value)}
                  placeholder="operator@example.com"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="registry-passphrase">Passphrase</Label>
                <Input
                  id="registry-passphrase"
                  type="password"
                  value={registryPassphrase}
                  onChange={(e) => setRegistryPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && registryEmail.trim() && registryPassphrase) {
                      void handleRegistryUnlock();
                    }
                  }}
                  placeholder="••••••••••••••••"
                  autoComplete="off"
                />
              </div>
            </div>
            {registryError && <p className="mt-2 text-sm text-red-500">{registryError}</p>}
            <Button
              className="mt-3"
              onClick={() => void handleRegistryUnlock()}
              disabled={registryBusy || !registryEmail.trim() || !registryPassphrase}
            >
              {registryBusy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <LockKeyhole className="mr-2 size-4" />
              )}
              Unlock registry
            </Button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Same backend check as the terminal gate — either default email +
              the same valid passphrase unlock this registry, and the unlock
              stays active for this browser session.
            </p>
          </div>
        ) : (
        <div className="overflow-x-auto rounded-xl border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Passcode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Daily target</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscribers === undefined ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto size-4 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : subscribers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No subscribers yet — passcodes appear here as requests come in.
                  </TableCell>
                </TableRow>
              ) : (
                subscribers.map((s) => {
                  const expired = isPasscodeExpired(s.expiresAt);
                  const needsConfirmation = s.subject === "send" && s.paymentStatus !== "confirmed";
                  return (
                    <TableRow key={s.email}>
                      <TableCell>
                        <div className="text-sm font-medium">{s.email}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.fullName} · {s.location || "no location"}
                          {s.hasFile && (
                            <span className="ml-1 inline-flex items-center gap-1 text-primary">
                              <FileImage className="size-3" /> receipt
                            </span>
                          )}
                          {s.activatedAt && (
                            <span className="ml-1 inline-flex items-center gap-1 text-emerald-500">
                              · activated
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {editEmail === s.email ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              value={editCode}
                              onChange={(e) => setEditCode(e.target.value)}
                              placeholder="NEW PASSCODE"
                              className="h-8 w-36 font-mono text-xs"
                            />
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => submitUpdate(s.email)}
                              disabled={busy === `update-${s.email}`}
                            >
                              Set
                            </Button>
                          </div>
                        ) : (
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                            {s.maskedPasscode}
                          </code>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            s.status === "blocked"
                              ? "destructive"
                              : expired
                                ? "outline"
                                : "default"
                          }
                        >
                          {s.status === "blocked" ? "blocked" : expired ? "expired" : "active"}
                        </Badge>
                        {s.subscriptionPlan && s.subscriptionPlan !== "free" && (
                          <Badge variant="secondary" className="mt-1 text-[10px]">
                            {SUBSCRIPTION_PLANS.find((p) => p.value === s.subscriptionPlan)?.label ?? s.subscriptionPlan}
                          </Badge>
                        )}
                        {s.subscriptionExpiry && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            Plan expires {new Date(s.subscriptionExpiry).toLocaleDateString()}
                          </div>
                        )}
                        {s.paymentStatus && (
                          <div className="mt-1">
                            <Badge
                              variant={
                                s.paymentStatus === "confirmed"
                                  ? "default"
                                  : s.paymentStatus === "rejected"
                                    ? "destructive"
                                    : "outline"
                              }
                              className="text-[10px]"
                            >
                              {s.paymentStatus}
                            </Badge>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {expiryEmail === s.email ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              min={1}
                              max={720}
                              value={expiryHours}
                              onChange={(e) => setExpiryHours(e.target.value)}
                              placeholder="72"
                              className="h-8 w-16 font-mono text-xs"
                              aria-label="Expiry window in hours"
                            />
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => submitExpiry(s.email)}
                              disabled={busy === `expiry-${s.email}`}
                            >
                              Set
                            </Button>
                          </div>
                        ) : (
                          <span className="flex flex-col items-start gap-0.5">
                            <span>{formatExpiry(s.expiresAt)}</span>
                            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
                              <Clock className="size-3" />
                              {s.expiryHours}h window
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={s.subscriptionPlan ?? "free"}
                          onValueChange={async (val) => {
                            await setSubscriptionPlanMut({ email: s.email, plan: val as any });
                          }}
                          disabled={s.status === "blocked"}
                        >
                          <SelectTrigger className="h-8 w-[110px] text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SUBSCRIPTION_PLANS.map((p) => (
                              <SelectItem key={p.value} value={p.value} className="text-[11px]">
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {targetEmail === s.email ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              min={0}
                              max={1000}
                              value={targetValue}
                              onChange={(e) => setTargetValue(e.target.value)}
                              placeholder="3"
                              className="h-8 w-16 font-mono text-xs"
                              aria-label="Daily execution target (0 blocks)"
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && targetValue !== "") {
                                  void submitDailyTarget(s.email);
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              className="h-8"
                              onClick={() => void submitDailyTarget(s.email)}
                              disabled={busy === `target-${s.email}` || targetValue === ""}
                            >
                              Set
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col items-start gap-0.5">
                            <span className="inline-flex items-center gap-1">
                              {(s.dailyTradeCount ?? 0)}/{s.dailyTradeLimit === null ? 3 : s.dailyTradeLimit}
                              {(s.dailyTradeLimit === 0) && (
                                <Badge variant="destructive" className="text-[10px]">blocked</Badge>
                              )}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 w-6 p-0"
                                title="Decrease daily target"
                                onClick={() =>
                                  run(
                                    `target-dec-${s.email}`,
                                    () => setDailyTarget({ email: s.email, limit: Math.max(0, (s.dailyTradeLimit ?? 3) - 1) }),
                                    `Daily target set to ${Math.max(0, (s.dailyTradeLimit ?? 3) - 1)} for ${s.email}`,
                                  )
                                }
                                disabled={busy === `target-dec-${s.email}`}
                              >
                                <Minus className="size-3" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 w-6 p-0"
                                title="Increase daily target"
                                onClick={() =>
                                  run(
                                    `target-inc-${s.email}`,
                                    () => setDailyTarget({ email: s.email, limit: (s.dailyTradeLimit ?? 3) + 1 }),
                                    `Daily target set to ${(s.dailyTradeLimit ?? 3) + 1} for ${s.email}`,
                                  )
                                }
                                disabled={busy === `target-inc-${s.email}`}
                              >
                                <Plus className="size-3" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-1.5 text-[10px]"
                                title="Set an explicit target (0 = block all executions)"
                                onClick={() => {
                                  setTargetEmail(s.email);
                                  setTargetValue(String(s.dailyTradeLimit ?? 3));
                                }}
                              >
                                set
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 w-6 p-0"
                                title="Reset today's used counter back to 0"
                                onClick={() =>
                                  run(
                                    `target-reset-${s.email}`,
                                    () => resetDailyCounter({ email: s.email }),
                                    `Daily counter reset for ${s.email}`,
                                  )
                                }
                                disabled={busy === `target-reset-${s.email}`}
                              >
                                <RotateCcw className="size-3" />
                              </Button>
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[180px] text-xs text-muted-foreground">
                        {s.notifyNote ?? (
                          <span className="text-muted-foreground/60">
                            {s.subject === "request" ? "Passcode reported to operator" : "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {/* Send trigger — email the passcode to this subscriber */}
                          <Button
                            size="sm"
                            variant="outline"
                            title={
                              needsConfirmation
                                ? "Confirm the payment receipt first"
                                : expired
                                  ? "Passcode expired — rotate a new one first"
                                  : "Email the passcode to this subscriber"
                            }
                            onClick={() =>
                              run(
                                `send-${s.email}`,
                                async () => {
                                  const res = await send({ email: s.email });
                                  toast.success(
                                    res.emailDelivered
                                      ? `Passcode dispatched to ${s.email} — check the inbox.`
                                      : "Passcode ready — the email channel is unavailable right now, try again.",
                                  );
                                },
                                "",
                              )
                            }
                            disabled={
                              s.status === "blocked" ||
                              expired ||
                              needsConfirmation ||
                              busy === `send-${s.email}`
                            }
                          >
                            {busy === `send-${s.email}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Send className="size-3.5" />
                            )}
                          </Button>
                          {/* Confirm payment receipt */}
                          {s.subject === "send" && s.paymentStatus !== "confirmed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Confirm the payment receipt (unlocks Send)"
                              onClick={() =>
                                run(
                                  `confirm-${s.email}`,
                                  () => confirmPayment({ email: s.email }),
                                  "Payment receipt confirmed — passcode can now be sent",
                                )
                              }
                              disabled={busy === `confirm-${s.email}`}
                            >
                              <CheckCircle2 className="size-3.5 text-emerald-500" />
                            </Button>
                          )}
                          {/* Reject payment receipt */}
                          {s.subject === "send" && s.paymentStatus !== "rejected" && (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Reject the payment receipt"
                              onClick={() =>
                                run(
                                  `reject-${s.email}`,
                                  () => rejectPayment({ email: s.email }),
                                  "Payment receipt rejected",
                                )
                              }
                              disabled={busy === `reject-${s.email}`}
                            >
                              <XCircle className="size-3.5 text-red-500" />
                            </Button>
                          )}
                          {/* Expiry window (per-subscriber hours) */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Set expiry window in hours (1–720)"
                            onClick={() => {
                              setExpiryEmail(s.email);
                              setExpiryHours(String(s.expiryHours));
                            }}
                          >
                            <Clock className="size-3.5" />
                          </Button>
                          {/* Rotate (change) */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Rotate to a new passcode"
                            onClick={() =>
                              run(
                                `change-${s.email}`,
                                () => change({ email: s.email }),
                                "Passcode rotated (window reset)",
                              )
                            }
                            disabled={busy === `change-${s.email}`}
                          >
                            <RefreshCcw className="size-3.5" />
                          </Button>
                          {/* Update (explicit passcode) */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Set an explicit passcode"
                            onClick={() => {
                              setEditEmail(s.email);
                              setEditCode("");
                            }}
                          >
                            <MailCheck className="size-3.5" />
                          </Button>
                          {/* Block / unblock */}
                          {s.status === "blocked" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Unblock"
                              onClick={() =>
                                run(
                                  `unblock-${s.email}`,
                                  () => unblock({ email: s.email }),
                                  "Subscriber unblocked",
                                )
                              }
                              disabled={busy === `unblock-${s.email}`}
                            >
                              <CheckCircle2 className="size-3.5 text-emerald-500" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Block (rule infringement)"
                              onClick={() =>
                                run(
                                  `block-${s.email}`,
                                  () => block({ email: s.email }),
                                  "Subscriber blocked",
                                )
                              }
                              disabled={busy === `block-${s.email}`}
                            >
                              <Ban className="size-3.5 text-red-500" />
                            </Button>
                          )}
                          {/* Delete */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Delete subscriber record"
                            onClick={() => handleDelete(s.email)}
                            disabled={busy === `delete-${s.email}`}
                          >
                            <Trash2 className="size-3.5 text-red-500" />
                          </Button>
                        </div>
                        {/* Permit code management row */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mr-1">
                            Permit:
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {s.hasPermitCode ? s.maskedPermitCode : "—"}
                          </span>
                          {/* Send permit code */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Email the permit code to the subscriber"
                            onClick={() =>
                              run(
                                `send-permit-${s.email}`,
                                async () => {
                                  const res = await sendPermit({ email: s.email });
                                  toast.success(
                                    res.emailDelivered
                                      ? `Permit code dispatched to ${s.email}`
                                      : "Permit code ready — email channel unavailable",
                                  );
                                },
                                "",
                              )
                            }
                            disabled={s.status === "blocked" || !s.hasPermitCode || busy === `send-permit-${s.email}`}
                          >
                            {busy === `send-permit-${s.email}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Send className="size-3.5" />
                            )}
                          </Button>
                          {/* Rotate permit code */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Rotate to a new permit code"
                            onClick={() =>
                              run(
                                `change-permit-${s.email}`,
                                () => changePermit({ email: s.email }),
                                "Permit code rotated",
                              )
                            }
                            disabled={busy === `change-permit-${s.email}`}
                          >
                            <RefreshCcw className="size-3.5" />
                          </Button>
                          {/* Update permit code (explicit) */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Set an explicit permit code"
                            onClick={() => {
                              setEditEmail(s.email);
                              setEditCode("");
                            }}
                          >
                            <MailCheck className="size-3.5" />
                          </Button>
                          {/* Block/unblock permit code */}
                          {s.hasPermitCode ? (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Block permit code (prevents gate access)"
                              onClick={() =>
                                run(
                                  `block-permit-${s.email}`,
                                  () => blockPermit({ email: s.email }),
                                  "Permit code blocked",
                                )
                              }
                              disabled={busy === `block-permit-${s.email}`}
                            >
                              <Ban className="size-3.5 text-amber-500" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              title="Unblock permit code (generate fresh)"
                              onClick={() =>
                                run(
                                  `unblock-permit-${s.email}`,
                                  () => unblockPermit({ email: s.email }),
                                  "Permit code unblocked (fresh code generated)",
                                )
                              }
                              disabled={busy === `unblock-permit-${s.email}`}
                            >
                              <CheckCircle2 className="size-3.5 text-emerald-500" />
                            </Button>
                          )}
                          {/* Delete permit code */}
                          <Button
                            size="sm"
                            variant="outline"
                            title="Delete permit code entirely"
                            onClick={() =>
                              run(
                                `delete-permit-${s.email}`,
                                () => deletePermit({ email: s.email }),
                                "Permit code deleted",
                              )
                            }
                            disabled={busy === `delete-permit-${s.email}`}
                          >
                            <Trash2 className="size-3.5 text-red-400" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        )}
      </div>

      {/* Operator sign-in emails (passcode-free auth addresses) */}
      <OperatorEmailsSection />

      {/* FlashBolt Trade — pending deposit/withdrawal settlements */}
      <TradeSettlementsSection />

      {/* FlashBolt Trade — Kora Pay instant auto-credited deposits */}
      <TradeKoraDepositsSection />

      {/* FlashBolt Trade — dynamic rotatable bank/mobile-bank receiving accounts */}
      <TradeCashAccountsSection />

      {/* FlashBolt Trade — receiving details (addresses / bank accounts) */}
      <TradeDepositDetailsSection />

      {/* WhatsApp — channel links + the operator inbox number subscribers message */}
      <WhatsAppSupportSection />

      {/* Desktop app activation licenses (Linux / macOS / Windows) */}
      <DesktopLicenses />

      {/* Audit log */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <ShieldAlert className="size-4 text-primary" />
          Audit log
          <Badge variant="secondary" className="ml-1">
            {logs?.length ?? "…"}
          </Badge>
        </h3>
        <div className="max-h-80 overflow-auto rounded-xl border border-border/70">
          {logs === undefined ? (
            <div className="py-8 text-center text-muted-foreground">
              <Loader2 className="mx-auto size-4 animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No audit events yet.
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {logs.map((log) => (
                <li key={log._id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                    {new Date(log.ts).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="flex-1">
                    <span className="font-medium">{log.action}</span>
                    <span className="mx-1.5 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{log.description}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{log.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Label className="font-normal">
          Passcodes are stored encrypted server-side and masked everywhere in
          this view — the plaintext cannot be copied anywhere. The send trigger
          delivers only unexpired passcodes, and only after the payment receipt
          is confirmed for "Send a passcode" subscriptions. The operator email
          never appears in any log entry.
        </Label>
      </p>
    </div>
  );
}

/**
 * WhatsApp — the community channel links (primary + fallback) and the
 * operator's support number, which is the second default inbox (besides
 * email) where subscribers send pass codes / activation-password requests.
 * The number powers the real wa.me click-to-chat button on the subscriber
 * surfaces; the channel links feed the WhatsApp button on every page. All
 * values live in the backend (whatsappConfig) — never hardcoded in the
 * frontend.
 */
function WhatsAppSupportSection() {
  const cfg = useQuery(api.whatsapp.getWhatsAppChannel);
  const setCfg = useMutation(api.whatsapp.setWhatsAppChannel);
  const requestLinkCode = useMutation(api.whatsapp.requestWhatsAppChatLinkCode);
  const verifyLinkCode = useMutation(api.whatsapp.verifyWhatsAppChatLinkCode);
  const saveLink = useMutation(api.whatsapp.saveWhatsAppChatLink);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);

  // Encrypted chat link — code-gated visible / edit / save (short windows).
  const [linkFlow, setLinkFlow] = useState<"none" | "reveal" | "edit">("none");
  const [linkCode, setLinkCode] = useState("");
  const [linkCodeSent, setLinkCodeSent] = useState(false);
  const [revealedLink, setRevealedLink] = useState<string | null>(null);
  const [revealExpiresAt, setRevealExpiresAt] = useState<number | null>(null);
  const [editLink, setEditLink] = useState<string | null>(null);
  const [editExpiresAt, setEditExpiresAt] = useState<number | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (cfg && cfg.supportNumber !== number) setNumber(cfg.supportNumber ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.supportNumber]);

  // 1s ticker for the short visible / editable windows
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // auto-hide once the reveal window lapses
  useEffect(() => {
    if (revealExpiresAt && now > revealExpiresAt) {
      setRevealedLink(null);
      setRevealExpiresAt(null);
      setLinkFlow("none");
      setLinkCodeSent(false);
      toast.info("The WhatsApp chat link is hidden again (visible window elapsed).");
    }
  }, [now, revealExpiresAt]);

  // auto-lock once the edit window lapses
  useEffect(() => {
    if (editExpiresAt && now > editExpiresAt) {
      setEditLink(null);
      setEditExpiresAt(null);
      setLinkFlow("none");
      setLinkCodeSent(false);
      toast.info("The edit session expired — request a new one-time code.");
    }
  }, [now, editExpiresAt]);

  const revealSeconds = revealExpiresAt
    ? Math.max(0, Math.ceil((revealExpiresAt - now) / 1000))
    : 0;
  const editSeconds = editExpiresAt
    ? Math.max(0, Math.ceil((editExpiresAt - now) / 1000))
    : 0;

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const res = await setCfg({
        url: cfg.url,
        fallbackUrl: cfg.fallbackUrl,
        supportNumber: number.trim(),
      });
      toast.success(
        res.supportNumber
          ? `WhatsApp support number saved (${res.supportNumber}) — subscribers can now message you.`
          : "WhatsApp support number cleared — the message button is hidden everywhere.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleLinkRequest = async (purpose: "reveal" | "edit") => {
    setLinkBusy(purpose);
    try {
      await requestLinkCode({ purpose });
      setLinkFlow(purpose);
      setLinkCode("");
      setLinkCodeSent(true);
      toast.info(
        `One-time code dispatched to the operator email — check the inbox (${purpose === "reveal" ? "visible" : "edit + save"} window).`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send the code.");
    } finally {
      setLinkBusy(null);
    }
  };

  const handleLinkVerify = async () => {
    if (linkFlow === "none") return;
    setLinkBusy("verify");
    try {
      const res = await verifyLinkCode({ purpose: linkFlow, code: linkCode });
      if (linkFlow === "reveal") {
        setRevealedLink(res.link || "");
        setRevealExpiresAt(res.revealExpiresAt ?? null);
        setLinkCodeSent(false);
        toast.success("Code verified — the WhatsApp chat link is visible for a short window.");
      } else {
        setEditLink(res.link || "");
        setEditExpiresAt(res.editExpiresAt ?? null);
        setLinkCodeSent(false);
        toast.success("Code verified — you may now edit the chat link and press Save.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid code.");
    } finally {
      setLinkBusy(null);
    }
  };

  const handleLinkSave = async () => {
    if (editLink === null) return;
    setLinkBusy("save");
    try {
      const res = await saveLink({ link: editLink });
      setEditLink(null);
      setEditExpiresAt(null);
      setLinkFlow("none");
      setLinkCode("");
      setLinkCodeSent(false);
      toast.success(
        res.hasChatLink
          ? "WhatsApp chat link re-encrypted and saved in the backend."
          : "WhatsApp chat link cleared from the backend.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setLinkBusy(null);
    }
  };

  const waMe = number.trim().replace(/^\+/, "");

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <MessageCircle className="size-4 text-[#25D366]" />
          WhatsApp
          <Badge variant="secondary" className="ml-1">
            {cfg?.supportNumber ? "inbox on" : "inbox off"}
          </Badge>
        </h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Channel links for every page · support number = second inbox for subscriber messages
        </span>
      </div>

      <div className="grid gap-3 rounded-xl border border-border/60 bg-background/40 p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold text-muted-foreground">
            Operator WhatsApp number (E.164) — subscribers message this number
          </Label>
          <Input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="e.g. +15551234567"
            className="h-9 font-mono text-xs"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            {waMe
              ? `Subscribers open a real chat at wa.me/${waMe} with a pre-filled message.`
              : 'Leave empty to hide the "Message the operator on WhatsApp" button everywhere.'}
          </p>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 space-y-1 text-[11px] text-muted-foreground">
            <p className="truncate">Channel: {cfg?.url ?? "…"}</p>
            <p className="truncate">Fallback: {cfg?.fallbackUrl ?? "…"}</p>
          </div>
          <Button size="sm" onClick={save} disabled={busy || !cfg} className="shrink-0">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MailCheck className="size-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {/* Encrypted WhatsApp chat link — second default inbox (visible / edit / save) */}
      <div className="mt-3 rounded-xl border border-[#25D366]/25 bg-[#25D366]/5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              WhatsApp chat link (encrypted)
            </h4>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              Second default inbox (besides email) — subscriber information,
              unique pass codes and desktop activation passwords land here.
              Stored AES-256-GCM encrypted; the plaintext is only visible /
              editable for a short window after a one-time code.
            </p>
          </div>
          <Badge variant="secondary" className="ml-auto shrink-0">
            {cfg?.hasChatLink ? "seeded & encrypted" : "not set"}
          </Badge>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">
            {(revealedLink ?? editLink ?? cfg?.chatLinkMasked) || "Not set"}
          </code>
          {linkFlow === "none" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleLinkRequest("reveal")}
                disabled={linkBusy !== null}
              >
                <Eye className="mr-1.5 size-3.5" />
                Visible
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleLinkRequest("edit")}
                disabled={linkBusy !== null}
              >
                <LockKeyhole className="mr-1.5 size-3.5" />
                Edit
              </Button>
            </>
          )}
        </div>

        {linkCodeSent && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value)}
              placeholder="6-digit code"
              maxLength={6}
              className="h-8 w-36 font-mono text-xs"
              aria-label="One-time code for the WhatsApp chat link"
            />
            <Button
              size="sm"
              onClick={handleLinkVerify}
              disabled={linkBusy === "verify" || linkCode.length !== 6}
            >
              {linkBusy === "verify" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1.5 size-3.5" />
              )}
              Verify
            </Button>
          </div>
        )}

        {revealedLink !== null && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-amber-500">
            <EyeOff className="size-3.5" />
            Visible but unchangeable — hides automatically in {revealSeconds}s.
            To change it, use Edit (a new code will be emailed).
          </p>
        )}

        {editLink !== null && (
          <div className="mt-3 space-y-2">
            <Input
              value={editLink}
              onChange={(e) => setEditLink(e.target.value)}
              placeholder="https://wa.me/message/…"
              className="h-9 font-mono text-xs"
              aria-label="WhatsApp chat link"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={handleLinkSave}
                disabled={linkBusy === "save"}
              >
                {linkBusy === "save" ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <MailCheck className="mr-1.5 size-3.5" />
                )}
                Save
              </Button>
              <span className="text-[11px] text-amber-500">
                Editable for {editSeconds}s — leave empty to clear, then Save.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const OS_META: Record<string, { label: string; icon: typeof Monitor }> = {
  linux: { label: "Linux", icon: Monitor },
  macos: { label: "macOS", icon: Monitor },
  windows: { label: "Windows", icon: Monitor },
};

const OS_ORDER = ["linux", "macos", "windows"] as const;

/**
 * Operator sign-in emails — every email address the terminal operator used
 * for passcode-free sign-up on the auth page, stored in the backend with the
 * full lifecycle controls: block / unblock / delete / change / update.
 */
function OperatorEmailsSection() {
  const emails = useQuery(api.operatorEmails.listOperatorEmails);

  const register = useMutation(api.operatorEmails.registerOperatorEmail);
  const block = useMutation(api.operatorEmails.blockOperatorEmail);
  const unblock = useMutation(api.operatorEmails.unblockOperatorEmail);
  const remove = useMutation(api.operatorEmails.deleteOperatorEmail);
  const change = useMutation(api.operatorEmails.changeOperatorEmail);
  const update = useMutation(api.operatorEmails.updateOperatorEmail);

  const [busy, setBusy] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [changeTarget, setChangeTarget] = useState<string | null>(null);
  const [changeValue, setChangeValue] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(okMsg);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const addEmail = async () => {
    if (!newEmail.trim()) return;
    setBusy("add");
    try {
      const res = await register({ email: newEmail });
      toast.success(
        res.isNew
          ? `${res.email} registered for passcode-free operator sign-in.`
          : `${res.email} is already registered.`,
      );
      setNewEmail("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setBusy(null);
    }
  };

  const submitChange = async (email: string) => {
    if (!changeValue.trim()) return;
    await run(
      `change-${email}`,
      () => change({ email, newEmail: changeValue }),
      "Operator email changed (fresh internal credential stored encrypted).",
    );
    setChangeTarget(null);
    setChangeValue("");
  };

  const handleDelete = async (email: string) => {
    if (!window.confirm(`Delete the operator email ${email} permanently?`)) return;
    await run(`delete-${email}`, () => remove({ email }), "Operator email record deleted.");
  };

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <UserCog className="size-4 text-primary" />
          Operator sign-in emails
          <Badge variant="secondary" className="ml-1">
            {emails?.length ?? "…"}
          </Badge>
        </h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Any email can sign up on the auth page · no pass codes · block / unblock / delete / change / update
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addEmail()}
          placeholder="Add another operator email (passcode-free sign-up)"
          className="h-9 max-w-sm"
        />
        <Button size="sm" onClick={addEmail} disabled={busy === "add" || !newEmail.trim()}>
          {busy === "add" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Add email
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Registered</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emails === undefined ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : emails.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  No operator emails yet — any email used on the auth page registers here automatically.
                </TableCell>
              </TableRow>
            ) : (
              emails.map((row) => (
                <TableRow key={row.email}>
                  <TableCell>
                    {changeTarget === row.email ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="email"
                          value={changeValue}
                          onChange={(e) => setChangeValue(e.target.value)}
                          className="h-8 w-64 font-mono text-xs"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          className="h-8"
                          onClick={() => submitChange(row.email)}
                          disabled={busy === `change-${row.email}` || !changeValue.trim()}
                        >
                          Set
                        </Button>
                      </div>
                    ) : (
                      <span className="font-mono text-xs">{row.email}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={
                        row.status === "blocked"
                          ? "border-red-500/30 bg-red-500/10 text-red-500"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                      }
                    >
                      {row.status === "blocked" ? "Blocked" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        title="Change to a different email address"
                        onClick={() => {
                          setChangeTarget(row.email);
                          setChangeValue(row.email);
                        }}
                        disabled={busy !== null}
                      >
                        <RefreshCcw className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        title="Update — refresh the record (active + rotated credential)"
                        onClick={() =>
                          run(
                            `update-${row.email}`,
                            () => update({ email: row.email }),
                            "Operator email record refreshed.",
                          )
                        }
                        disabled={busy === `update-${row.email}`}
                      >
                        <MailCheck className="size-3.5" />
                      </Button>
                      {row.status === "blocked" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          title="Unblock this email"
                          onClick={() =>
                            run(
                              `unblock-${row.email}`,
                              () => unblock({ email: row.email }),
                              "Operator email unblocked.",
                            )
                          }
                          disabled={busy === `unblock-${row.email}`}
                        >
                          <CheckCircle2 className="size-3.5 text-emerald-500" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          title="Block this email (can no longer sign in)"
                          onClick={() =>
                            run(
                              `block-${row.email}`,
                              () => block({ email: row.email }),
                              "Operator email blocked.",
                            )
                          }
                          disabled={busy === `block-${row.email}`}
                        >
                          <Ban className="size-3.5 text-red-500" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        title="Delete this operator email record"
                        onClick={() => handleDelete(row.email)}
                        disabled={busy === `delete-${row.email}`}
                      >
                        <Trash2 className="size-3.5 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <AtSign className="size-3.5 shrink-0" />
        Any email entered here (or on the auth page) becomes an operator sign-in email. The
        internal credential is stored encrypted; the operator never types or sees a passcode.
      </p>
    </div>
  );
}

/**
 * Desktop app activation licenses — one encrypted activation password per
 * operating system (Linux / macOS / Windows). Real backend data only:
 * - Passwords are generated server-side, AES-256-GCM encrypted, and emailed
 *   ONLY to the terminal operator — they are never shown in any UI. "send"
 *   re-emails the current password, "update" generates + emails a new one.
 * - "change" emails a one-time code; verifying it reveals the password for a
 *   10-second window in which it can be edited. If edited, the changed
 *   password is re-encrypted and auto-emailed to the operator; if nothing
 *   changed, no email is sent.
 * - Any new password never used to activate the app within 72 hours is
 *   auto-expired by a daily cron; once used even once it stays active for
 *   re-use / re-run. Every action lands in the audit log.
 */
function DesktopLicenses() {
  const licenses = useQuery(api.licenses.listLicenses);
  const subscribers = useQuery(api.gate.listSubscribers);

  const ensure = useMutation(api.licenses.ensureLicenses);
  const sendPw = useMutation(api.licenses.sendLicensePassword);
  const updatePw = useMutation(api.licenses.updateLicensePassword);
  const block = useMutation(api.licenses.blockLicense);
  const unblock = useMutation(api.licenses.unblockLicense);
  const remove = useMutation(api.licenses.deleteLicense);
  const requestCode = useMutation(api.licenses.requestLicenseChangeCode);
  const verifyCode = useMutation(api.licenses.verifyLicenseChangeCode);
  const applyChange = useMutation(api.licenses.applyLicenseChange);

  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [selectedEmail, setSelectedEmail] = useState("");
  const [customEmail, setCustomEmail] = useState("");
  // change flow (one OS at a time)
  const [changeOs, setChangeOs] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [revealed, setRevealed] = useState<{
    password: string;
    expiresAt: number;
  } | null>(null);
  const [draft, setDraft] = useState("");

  // 1s ticker for the 10-second reveal window + expiry countdown
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // default the picker to the first subscriber email once the list loads
  useEffect(() => {
    if (!selectedEmail && subscribers && subscribers.length > 0) {
      setSelectedEmail(subscribers[0].email);
    }
  }, [subscribers, selectedEmail]);

  // seed the per-OS licenses for the selected subscriber email (generates +
  // emails the initial encrypted passwords to the operator)
  useEffect(() => {
    if (!selectedEmail) return;
    ensure({ email: selectedEmail }).catch(() => {
      // non-subscriber emails / not-yet-seeded profiles — silence for UX
    });
  }, [selectedEmail, ensure]);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(okMsg);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const activeEmail = selectedEmail.trim().toLowerCase();
  const rows =
    licenses === undefined
      ? undefined
      : licenses
          .filter((l) => l.email === activeEmail)
          .sort(
            (a, b) =>
              OS_ORDER.indexOf(a.os as (typeof OS_ORDER)[number]) -
              OS_ORDER.indexOf(b.os as (typeof OS_ORDER)[number]),
          );

  const startChange = (os: string) => {
    setChangeOs(os);
    setCodeInput("");
    setRevealed(null);
    setDraft("");
    run(
      `code-${os}`,
      () => requestCode({ email: activeEmail, os }),
      "One-time code emailed to the operator.",
    );
  };

  const verify = async (os: string) => {
    if (!codeInput.trim()) return;
    setBusy(`verify-${os}`);
    try {
      const res = await verifyCode({ email: activeEmail, os, code: codeInput.trim() });
      setRevealed({ password: res.password, expiresAt: res.changeRevealExpiresAt });
      setDraft(res.password);
      toast.info("Password revealed — 10 seconds to edit. If changed it is emailed to you automatically.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setBusy(null);
    }
  };

  const commitChange = (os: string, changed: boolean) => {
    if (busy === `commit-${os}`) return;
    setBusy(`commit-${os}`);
    const payload = changed
      ? { email: activeEmail, os, newPassword: draft }
      : { email: activeEmail, os };
    applyChange(payload)
      .then((res) => {
        if (res.changed) {
          toast.success("Changed password saved (encrypted) and emailed to the operator.");
        } else {
          toast.info("Nothing changed — no email was sent.");
        }
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Could not apply the change.");
      })
      .finally(() => {
        setChangeOs(null);
        setRevealed(null);
        setDraft("");
        setCodeInput("");
        setBusy(null);
      });
  };

  // auto-commit when the 10-second window elapses: edited → save + email the
  // changed password; untouched → close the window silently (no email)
  useEffect(() => {
    if (!changeOs || !revealed) return;
    if (now >= revealed.expiresAt) {
      const changed = draft.trim() !== revealed.password.trim() && draft.trim().length > 0;
      commitChange(changeOs, changed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, changeOs, revealed]);

  const secondsLeft = revealed ? Math.max(0, Math.ceil((revealed.expiresAt - now) / 1000)) : 0;

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <KeyRound className="size-4 text-primary" />
          Desktop app activation licenses
          <Badge variant="secondary" className="ml-1">
            {licenses?.filter((l) => l.email === activeEmail).length ?? "…"}
          </Badge>
        </h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Per subscriber email + OS · 72h expiry if never used · emailed to the operator
        </span>
      </div>

      {/* Subscriber email picker — only backend-registered subscriber emails
          are recognized (the same email used on the first page). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/40 p-3">
        <AtSign className="size-4 shrink-0 text-primary" />
        <label htmlFor="lic-email" className="text-xs font-semibold text-muted-foreground">
          Subscriber email
        </label>
        <select
          id="lic-email"
          value={activeEmail}
          onChange={(e) => {
            setSelectedEmail(e.target.value);
            setChangeOs(null);
            setRevealed(null);
            setCodeInput("");
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {!activeEmail && <option value="">Select a subscriber email…</option>}
          {(subscribers ?? []).map((s) => (
            <option key={s.email} value={s.email}>
              {s.email}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <Input
            type="email"
            value={customEmail}
            onChange={(e) => setCustomEmail(e.target.value)}
            placeholder="Or type another subscriber email…"
            className="h-9 w-60 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && customEmail.trim()) {
                setSelectedEmail(customEmail.trim());
                setCustomEmail("");
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!customEmail.trim()}
            onClick={() => {
              setSelectedEmail(customEmail.trim());
              setCustomEmail("");
            }}
          >
            Load
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">Operating system</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Password</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === undefined ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : !activeEmail ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  Pick a subscriber email above to manage its desktop activation licenses.
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  No licenses for {activeEmail} yet — the three per-OS licenses are generated
                  automatically when this subscriber email is selected.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((lic) => {
                const meta = OS_META[lic.os] ?? { label: lic.os, icon: Monitor };
                const Icon = meta.icon;
                const expired = lic.activationCount === 0 && lic.expiresAt < now;
                const inFlow = changeOs === lic.os;
                return (
                  <TableRow key={lic.os}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        <Icon className="size-4 text-muted-foreground" />
                        {meta.label}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={
                          lic.status === "blocked"
                            ? "border-red-500/30 bg-red-500/10 text-red-500"
                            : expired
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
                              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                        }
                      >
                        {lic.status === "blocked"
                          ? "Blocked"
                          : expired
                            ? "Expired"
                            : "Active"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {inFlow && revealed ? (
                        <span className="flex items-center gap-2">
                          <Input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value.toUpperCase())}
                            className="h-8 w-48 font-mono text-xs"
                            autoFocus
                          />
                          <span className="flex items-center gap-1 text-[11px] text-amber-500">
                            <Timer className="size-3" />
                            {secondsLeft}s
                          </span>
                        </span>
                      ) : inFlow ? (
                        <span className="flex items-center gap-2">
                          <Input
                            value={codeInput}
                            onChange={(e) => setCodeInput(e.target.value)}
                            placeholder="Enter emailed code"
                            className="h-8 w-44 font-mono text-xs"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `verify-${lic.os}` || !codeInput.trim()}
                            onClick={() => verify(lic.os)}
                          >
                            {busy === `verify-${lic.os}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Eye className="size-3.5" />
                            )}
                            Reveal
                          </Button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <LockKeyhole className="size-3" />
                          {lic.maskedPassword}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {lic.activationCount > 0 ? (
                        <span className="text-emerald-500">Active for re-use</span>
                      ) : expired ? (
                        <span className="text-amber-500">Expired · never used in 72h</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {Math.max(0, Math.ceil((lic.expiresAt - now) / 3600000))}h left
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {lic.activationCount === 0
                        ? "Never activated"
                        : `Activated ${lic.activationCount}×`}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {!inFlow && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              title="Email the current password to the operator"
                              disabled={
                                busy === `send-${lic.os}` || lic.status === "blocked" || expired
                              }
                              onClick={() =>
                                run(
                                  `send-${lic.os}`,
                                  () => sendPw({ email: activeEmail, os: lic.os }),
                                  "Password emailed to the operator.",
                                )
                              }
                            >
                              {busy === `send-${lic.os}` ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                              <span className="hidden xl:inline">Send</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              title="Generate a brand-new password and email it instantly"
                              disabled={busy === `update-${lic.os}` || lic.status === "blocked"}
                              onClick={() =>
                                run(
                                  `update-${lic.os}`,
                                  () => updatePw({ email: activeEmail, os: lic.os }),
                                  "New password generated and emailed to the operator.",
                                )
                              }
                            >
                              {busy === `update-${lic.os}` ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <RefreshCcw className="size-3.5" />
                              )}
                              <span className="hidden xl:inline">Update</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              title="Change — emailed code reveals the password for 10 seconds"
                              disabled={
                                busy === `code-${lic.os}` || lic.status === "blocked"
                              }
                              onClick={() => startChange(lic.os)}
                            >
                              {busy === `code-${lic.os}` ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                              <span className="hidden xl:inline">Change</span>
                            </Button>
                            {lic.status === "blocked" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                title="Unblock this operating system"
                                onClick={() =>
                                  run(
                                    `unblock-${lic.os}`,
                                    () => unblock({ email: activeEmail, os: lic.os }),
                                    "License unblocked.",
                                  )
                                }
                                disabled={busy === `unblock-${lic.os}`}
                              >
                                <CheckCircle2 className="size-3.5 text-emerald-500" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                title="Block this operating system (stops activation)"
                                onClick={() =>
                                  run(
                                    `block-${lic.os}`,
                                    () => block({ email: activeEmail, os: lic.os }),
                                    "License blocked.",
                                  )
                                }
                                disabled={busy === `block-${lic.os}`}
                              >
                                <Ban className="size-3.5 text-red-500" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              title="Delete this license (a fresh one is generated on next use)"
                              onClick={() =>
                                run(
                                  `delete-${lic.os}`,
                                  () => remove({ email: activeEmail, os: lic.os }),
                                  "License deleted — a fresh one is generated on next use.",
                                )
                              }
                              disabled={busy === `delete-${lic.os}`}
                            >
                              <Trash2 className="size-3.5 text-red-500" />
                            </Button>
                          </>
                        )}
                        {inFlow && revealed && (
                          <>
                            <Button
                              size="sm"
                              disabled={busy === `commit-${lic.os}`}
                              onClick={() =>
                                commitChange(lic.os, draft.trim() !== revealed.password.trim() && draft.trim().length > 0)
                              }
                            >
                              {busy === `commit-${lic.os}` ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <MailCheck className="size-3.5" />
                              )}
                              Save &amp; email
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => commitChange(lic.os, false)}
                              disabled={busy === `commit-${lic.os}`}
                            >
                              Discard
                            </Button>
                          </>
                        )}
                        {inFlow && !revealed && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setChangeOs(null);
                              setCodeInput("");
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Download className="size-3.5 shrink-0" />
        Only emails used for subscribing on the first page are recognized in the backend.
        Subscribers activate on the public download page (or via the CLI / PowerShell) with their
        email + password — after activation the desktop app runs the same flow as the browser app
        (landing → auth → terminal). Passwords are encrypted server-side and never shown in any
        interface; every action is in the audit log.
      </p>
    </div>
  );
}

// ── FlashBolt Trade — pending settlements ──────────────────────────────────

/**
 * Pending Trade-terminal cash deposits / withdrawals awaiting operator
 * settlement. Approve credits the user's ledger (deposits); reject refunds
 * debited withdrawals. Everything is ledger-audited.
 */
function TradeSettlementsSection() {
  const pending = useQuery(api.trade.listPendingSettlements, {}) as Array<{
    _id: string;
    userId: string;
    kind: "cash" | "crypto" | "internal";
    direction: string;
    asset: string;
    amount: number;
    status: string;
    ts: number;
    note?: string;
  }> | undefined;
  const settle = useMutation(api.trade.settlePending);

  const act = async (txId: string, approve: boolean) => {
    try {
      await settle({ txId: txId as never, approve });
      toast.success(approve ? "Settled — ledger credited" : "Rejected — funds refunded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Settlement failed");
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        Trade settlements
        {pending && pending.length > 0 && (
          <Badge className="bg-amber-500/15 text-amber-500 hover:bg-amber-500/15">
            {pending.length} pending
          </Badge>
        )}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        FlashBolt Trade cash deposits above the instant threshold and large withdrawals queue here.
        Approving a deposit credits the user's ledger; rejecting a withdrawal refunds it in full.
      </p>
      <div className="mt-3 space-y-2">
        {pending === undefined && (
          <div className="py-3 text-center text-xs text-muted-foreground">Loading…</div>
        )}
        {pending !== undefined && pending.length === 0 && (
          <div className="py-3 text-center text-xs text-muted-foreground">
            No pending settlements — the Trade ledger is fully settled.
          </div>
        )}
        {(pending ?? []).map((t) => (
          <div
            key={t._id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {t.direction === "deposit" ? "Deposit" : "Withdrawal"} · {t.asset}{" "}
                <span className="tabular-nums">
                  {currencySymbol(t.asset)}
                  {t.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {new Date(t.ts).toLocaleString()} · {t.note ?? ""}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-[10px]" onClick={() => void act(t._id, true)}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] text-red-500"
                onClick={() => void act(t._id, false)}
              >
                Reject & refund
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * FlashBolt Trade — receiving details manager. The operator publishes the
 * REAL receiving address / bank account / mobile-money number per asset;
 * the Trade terminal deposit modal serves exactly what is stored here.
 */
function TradeKoraDepositsSection() {
  const rows = useQuery(api.kora.listKoraDepositsAdmin, {}) as
    | Array<{
        _id: string;
        reference: string;
        asset: string;
        amount: number;
        status: "pending" | "success" | "failed" | "expired";
        credited: boolean;
        koraFee?: number;
        failureReason?: string;
        ts: number;
        settledAt?: number;
      }>
    | undefined;

  const successful = (rows ?? []).filter((r) => r.status === "success");
  const pending = (rows ?? []).filter((r) => r.status === "pending");

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Zap className="size-4 text-primary" />
        Kora instant deposits (auto-credited)
        <Badge variant="outline" className="text-[9px] uppercase">QUI-CHKOUT</Badge>
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        One-time virtual bank accounts through Kora Pay for NGN / GHS / KES / XAF.
        Successful transfers credit the user\u2019s ledger automatically — webhook-verified
        (HMAC), idempotent, and settled without any operator action. No claim queue here:
        this is the audit trail.
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <Badge variant="outline" className="text-emerald-500">{successful.length} credited</Badge>
        <Badge variant="outline" className="text-amber-500">{pending.length} pending</Badge>
        <Badge variant="outline" className="text-muted-foreground">
          {(rows ?? []).length - successful.length - pending.length} failed/expired
        </Badge>
      </div>
      <div className="mt-3 space-y-2">
        {rows !== undefined && rows.length === 0 && (
          <div className="rounded-lg border border-border/40 py-3 text-center text-xs text-muted-foreground">
            No Kora checkouts yet — users see the \u201cInstant Bank Deposit\u201d option in the Trade
            deposit modal once KORA_SECRET_KEY is set in Keys.
          </div>
        )}
        {(rows ?? []).slice(0, 12).map((r) => (
          <div
            key={r._id}
            className={
              "rounded-lg border px-3 py-2.5 " +
              (r.status === "success"
                ? "border-emerald-500/40 bg-emerald-500/5"
                : r.status === "pending"
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-border/50 bg-background/40")
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {r.asset} {r.amount.toLocaleString()}
                  <Badge
                    variant="outline"
                    className={
                      "text-[9px] " +
                      (r.status === "success"
                        ? "text-emerald-500"
                        : r.status === "pending"
                          ? "text-amber-500"
                          : "text-muted-foreground")
                    }
                  >
                    {r.credited ? "credited" : r.status}
                  </Badge>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{r.reference}</div>
                <div className="text-[9px] text-muted-foreground">
                  created {new Date(r.ts).toLocaleString()}
                  {r.settledAt ? ` · settled ${new Date(r.settledAt).toLocaleTimeString()}` : ""}
                  {typeof r.koraFee === "number" ? ` · fee ${r.koraFee}` : ""}
                </div>
                {r.failureReason && (
                  <div className="mt-0.5 text-[10px] text-red-500">{r.failureReason}</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradeCashAccountsSection() {
  const history = useQuery(api.trade.listCashAccountHistory, {}) as Array<{
    _id: string;
    asset: string;
    details: string;
    method: "bank_transfer" | "mobile_money";
    active: boolean;
    rotatedAt?: number;
    ts: number;
  }> | undefined;
  const rotate = useMutation(api.trade.rotateCashAccount);
  const setStatus = useMutation(api.trade.setCashAccountStatus);
  const [currency, setCurrency] = useState<string>(BANK_DEPOSIT_CURRENCIES[0]);
  const [details, setDetails] = useState("");
  const [method, setMethod] = useState<"bank_transfer" | "mobile_money">("bank_transfer");
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    setBusy(true);
    try {
      await rotate({ asset: currency, details, method });
      toast.success(`${currency} receiving account published — users see it instantly`);
      setDetails("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not publish account");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, active: boolean, asset: string) => {
    try {
      await setStatus({ id: id as never, active });
      toast.success(active ? `${asset} account re-activated` : `${asset} account deactivated — no longer shown to users`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Landmark className="size-4 text-primary" />
        Dynamic receiving accounts
        <Badge variant="outline" className="text-[9px] uppercase">bank rails</Badge>
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Rotatable bank / mobile-bank receiving accounts for EVERY cash currency
        ({BANK_DEPOSIT_CURRENCIES.join(", ")}). Publishing a new account for a
        currency instantly replaces the one users see — the old account is kept
        for audit, never deleted.
      </p>

      {/* Publish a new account */}
      <div className="mt-3 grid gap-2 rounded-lg border border-border/50 bg-background/40 p-3 md:grid-cols-4 md:items-end">
        <div className="space-y-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Currency</Label>
          <Select value={currency} onValueChange={(v) => setCurrency(v)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BANK_DEPOSIT_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Rail</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as "bank_transfer" | "mobile_money")}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bank_transfer" className="text-xs">
                <span className="flex items-center gap-1.5"><Building2 className="size-3" /> Direct bank transfer</span>
              </SelectItem>
              <SelectItem value="mobile_money" className="text-xs">
                <span className="flex items-center gap-1.5"><Smartphone className="size-3" /> Mobile bank app</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Receiving details ({method === "mobile_money" ? "mobile-bank number · name · app instructions" : "account number · bank · name"})
          </Label>
          <Textarea
            className="min-h-[64px] font-mono text-xs"
            placeholder={method === "mobile_money" ? "e.g. +233 24 123 4567 · MTN MoMo · holder name — dial *170#…" : "e.g. 0123456789 · GTBank · FlashBolt Ltd — use the narration code FB-…"}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
          <Button
            size="sm"
            className="h-7 w-full text-[10px]"
            disabled={busy || details.trim().length < 6}
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : `Publish ${currency} receiving account`}
          </Button>
        </div>
      </div>

      {/* Account history */}
      <div className="mt-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Account history {history && history.filter((h) => h.active).length > 0 && (
            <Badge className="ml-1 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">
              {history.filter((h) => h.active).length} active
            </Badge>
          )}
        </div>
        <div className="mt-2 space-y-2">
          {history !== undefined && history.length === 0 && (
            <div className="rounded-lg border border-border/40 py-3 text-center text-xs text-muted-foreground">
              No receiving accounts published yet — users cannot file cash deposit claims until at least one is active.
            </div>
          )}
          {(history ?? []).map((h) => (
            <div
              key={h._id}
              className={
                "rounded-lg border px-3 py-2.5 " +
                (h.active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/50 bg-background/40")
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {h.asset}
                    <Badge variant="outline" className="text-[9px]">
                      {h.method === "bank_transfer" ? (
                        <span className="flex items-center gap-1"><Building2 className="size-2.5" /> bank</span>
                      ) : (
                        <span className="flex items-center gap-1"><Smartphone className="size-2.5" /> mobile</span>
                      )}
                    </Badge>
                    {h.active ? (
                      <Badge variant="outline" className="text-[9px] text-emerald-500">live — shown to users</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px] text-muted-foreground">
                        retired {h.rotatedAt ? new Date(h.rotatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : ""}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 line-clamp-2 break-all font-mono text-[10px] text-muted-foreground">{h.details}</div>
                  <div className="text-[9px] text-muted-foreground">published {new Date(h.ts).toLocaleString()}</div>
                </div>
                <div className="flex gap-2">
                  {h.active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] text-red-500"
                      onClick={() => void toggle(h._id, false, h.asset)}
                    >
                      <Power className="mr-1 size-3" />
                      Deactivate
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px]"
                      onClick={() => void toggle(h._id, true, h.asset)}
                    >
                      <Power className="mr-1 size-3" />
                      Make active
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TradeDepositDetailsSection() {
  const details = useQuery(api.trade.getDepositDetails, {}) as Record<string, string> | undefined;
  const claims = useQuery(api.trade.listDepositClaims, {}) as Array<{
    _id: string;
    userId: string;
    asset: string;
    amount: number;
    method: "bank_transfer" | "mobile_money";
    senderName: string;
    reference: string;
    status: "pending" | "verified" | "rejected";
    ts: number;
  }> | undefined;
  const setDetail = useMutation(api.trade.setDepositDetail);
  const settleClaim = useMutation(api.trade.settleDepositClaim);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyAsset, setBusyAsset] = useState<string | null>(null);

  // Every publishable detail slot: one per cash currency, and one PER
  // NETWORK for crypto (USDT on TRC-20 ≠ USDT on ERC-20 — real custody
  // requires network-scoped addresses).
  const allDetailSlots = [
    ...TRADE_CASH_ASSETS.map((a) => ({
      key: tradeDetailKey(a.symbol),
      label: `${a.symbol} · ${a.depositMethod === "mobile_money" ? "mobile money" : "bank"}`,
      hint: a.depositMethod === "mobile_money" ? "Mobile-money number + instructions" : undefined,
    })),
    ...TRADE_CRYPTO_ASSETS.flatMap((a) =>
      (TRADE_NETWORKS[a.symbol] ?? []).map((n) => ({
        key: tradeDetailKey(a.symbol, n.id),
        label: `${a.symbol} · ${n.id}`,
        hint: n.label,
      })),
    ),
  ];

  const save = async (asset: string) => {
    const detail = (drafts[asset] ?? "").trim();
    if (!detail) {
      toast.error("Enter the receiving details first.");
      return;
    }
    setBusyAsset(asset);
    try {
      await setDetail({ asset, detail });
      toast.success(`${asset} receiving details published`);
      setDrafts((d) => ({ ...d, [asset]: "" }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save details");
    } finally {
      setBusyAsset(null);
    }
  };

  const verifyClaim = async (claimId: string, approve: boolean) => {
    try {
      await settleClaim({ claimId: claimId as never, approve });
      toast.success(approve ? "Claim verified — settle the matching deposit to credit the ledger" : "Claim rejected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        Trade receiving details
        <Badge variant="outline" className="text-[9px] uppercase">deposits</Badge>
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Publish the REAL account users pay into — crypto receiving addresses and cash bank /
        mobile-money accounts. What you save here is exactly what the Trade terminal shows.
      </p>

      {/* Cash deposit claims (real bank/mobile-money proofs) */}
      <div className="mt-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Deposit claims {claims && claims.filter((c) => c.status === "pending").length > 0 && (
            <Badge className="ml-1 bg-amber-500/15 text-amber-500 hover:bg-amber-500/15">
              {claims.filter((c) => c.status === "pending").length} pending
            </Badge>
          )}
        </div>
        <div className="mt-2 space-y-2">
          {claims !== undefined && claims.length === 0 && (
            <div className="rounded-lg border border-border/40 py-3 text-center text-xs text-muted-foreground">
              No deposit claims yet.
            </div>
          )}
          {(claims ?? []).map((c) => (
            <div key={c._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {c.asset} {c.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                  <Badge variant="outline" className="ml-2 text-[9px]">
                    {c.method === "bank_transfer" ? "bank" : "mobile"}
                  </Badge>
                  {c.status !== "pending" && (
                    <Badge variant="outline" className={"ml-1 text-[9px] " + (c.status === "verified" ? "text-emerald-500" : "text-red-500")}>
                      {c.status}
                    </Badge>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  sender: {c.senderName} · ref: {c.reference} · {new Date(c.ts).toLocaleString()}
                </div>
              </div>
              {c.status === "pending" && (
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-[10px]" onClick={() => void verifyClaim(c._id, true)}>
                    Mark verified
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[10px] text-red-500" onClick={() => void verifyClaim(c._id, false)}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Per-asset / per-network receiving details */}
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {allDetailSlots.map(({ key, label, hint }) => (
          <div key={key} className="rounded-lg border border-border/50 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold">{label}</span>
              {details?.[key] && <span className="shrink-0 text-[9px] text-emerald-500">published</span>}
            </div>
            {hint && <div className="mt-0.5 text-[9px] text-muted-foreground">{hint}</div>}
            {details?.[key] && (
              <div className="mt-1 line-clamp-2 break-all font-mono text-[10px] text-muted-foreground">{details[key]}</div>
            )}
            <Input
              className="mt-2 h-8 font-mono text-xs"
              placeholder={details?.[key] ? "Replace with new details…" : hint ? "Address for this network" : "Account number · bank · name"}
              value={drafts[key] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
            />
            <Button
              size="sm"
              className="mt-2 h-7 w-full text-[10px]"
              disabled={busyAsset === key || !(drafts[key] ?? "").trim()}
              onClick={() => void save(key)}
            >
              {busyAsset === key ? "Saving…" : details?.[key] ? "Replace" : "Publish"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
