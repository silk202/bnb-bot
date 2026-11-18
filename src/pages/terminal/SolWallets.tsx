/**
 * SOL Wallets — connect a Solana wallet for the SOL FlashBolt terminal.
 *
 * Real provider detection via the standard wallet injection points
 * (window.phantom.solana / window.solana for Phantom, window.solflare for
 * Solflare, window.backpack for Backpack). Connection state persists into
 * the terminal's connectedWallets so the Flasher knows a signer exists.
 * Includes the operator-only Source Code link, mirroring the BNB sidebar.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTerminal } from "@/hooks/use-terminal";
import { getGrant } from "@/lib/gate";
import {
  addWatchOnlyAddress,
  exportRecoverySheet,
  importToVault,
  lockVault,
  removeFromVault,
  unlockVault,
  vaultSignerAddresses,
  wipeVault,
} from "@/lib/solana-vault";
import { solRpcCall } from "@/lib/solana-live-execution";
import { SOL_RPC_ENDPOINTS } from "@/lib/solana-jito";
import { SolImportError } from "@/lib/solana-import";
import { describeVaultRemoval } from "@/lib/vault-remove-flow";
import { cn } from "@/lib/utils";
import {
  Check,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ensureSolanaSessionGuard,
  onWalletSessionEvent,
  reconnectSolana,
} from "@/lib/wallet-session";
import { toast } from "sonner";

/** Minimal shape of an injected Solana wallet provider. */
interface SolProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
}

/** Detect an installed provider by the standard window injection points. */
function detectProvider(kind: "phantom" | "solflare" | "backpack"): SolProvider | null {
  const w = window as unknown as Record<string, unknown>;
  if (kind === "phantom") {
    const phantom = w.phantom as { solana?: SolProvider } | undefined;
    if (phantom?.solana?.isPhantom) return phantom.solana;
    const direct = w.solana as SolProvider | undefined;
    if (direct?.isPhantom) return direct;
    return null;
  }
  if (kind === "solflare") {
    const sf = w.solflare as SolProvider | undefined;
    if (sf?.isSolflare) return sf;
    const direct = w.solana as SolProvider | undefined;
    if (direct?.isSolflare) return direct;
    return null;
  }
  const bp = w.backpack as SolProvider | undefined;
  if (bp && (bp as { isBackpack?: boolean }).isBackpack) return bp;
  return null;
}

const WALLETS: Array<{
  key: "phantom" | "solflare" | "backpack";
  name: string;
  installUrl: string;
  accent: string;
}> = [
  {
    key: "phantom",
    name: "Phantom",
    installUrl: "https://phantom.app/download",
    accent: "text-violet-400",
  },
  {
    key: "solflare",
    name: "Solflare",
    installUrl: "https://solflare.com/download",
    accent: "text-amber-400",
  },
  {
    key: "backpack",
    name: "Backpack",
    installUrl: "https://backpack.app/download",
    accent: "text-rose-400",
  },
];

export default function SolWallets() {
  const { state, connectWallet, disconnectWallet } = useTerminal();
  const connected = state?.connectedWallets ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Mirror of the persisted connections for the silent-reconnect effect.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  // Re-detect providers once the window finishes loading — extensions inject
  // asynchronously after first render.
  useEffect(() => {
    const onLoad = () => setTick((t) => t + 1);
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);

  // SEAMLESS SESSION — silent reconnect + live account guards. The probe is
  // connect({ onlyIfTrusted: true }): it resolves ONLY when this app was
  // already authorized, so a reload restores the signer with ZERO popup;
  // anything else resolves null and is reported honestly (never fabricated).
  // accountChanged/disconnect events from the extensions update the page
  // live via the shared session channel.
  useEffect(() => {
    let alive = true;
    ensureSolanaSessionGuard("phantom");
    ensureSolanaSessionGuard("solflare");
    ensureSolanaSessionGuard("backpack");
    void (async () => {
      for (const w of WALLETS) {
        const pk = await reconnectSolana(w.key);
        if (!alive || !pk) continue;
        const rec = w.key + ":" + pk.slice(0, 8);
        const known = connectedRef.current.some(
          (c) => c.startsWith(w.key + ":") || c === w.key,
        );
        if (!known) {
          // Session restored but the record went missing — re-persist it.
          void connectWallet({ walletKey: rec }).catch(() => undefined);
        }
      }
    })();
    const off = onWalletSessionEvent((e) => {
      if (!alive) return;
      if (e.kind === "sol-account" && e.pubkey === null) {
        toast.info(`${e.wallet} locked or disconnected`, {
          description: "Unlock the extension and press Connect to restore the signer.",
        });
      }
      if (e.kind === "disconnected" && e.source === "solana") {
        setTick((t) => t + 1); // re-detect providers honestly
      }
    });
    return () => {
      alive = false;
      off();
    };
    // connectWallet is a stable mutation reference; WALLETS is module-level.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detection = useMemo(() => {
    return Object.fromEntries(
      WALLETS.map((w) => [w.key, detectProvider(w.key)]),
    ) as Record<string, SolProvider | null>;
  }, [tick]);

  // One-tap copy for a full pubkey (the persisted row keeps only 8 chars, so
  // the full address is read from the LIVE provider — and only offered when
  // the extension actually exposes it; a locked wallet shows no copy button
  // rather than a shortened string pretending to be the whole address).
  const copyAddress = (address: string) => {
    void navigator.clipboard.writeText(address);
    toast.success("Address copied", {
      description: `${address.slice(0, 8)}…${address.slice(-4)} — full Solana address on your clipboard.`,
    });
  };

  const handleConnect = async (key: "phantom" | "solflare" | "backpack") => {
    setBusy(key);
    try {
      const provider = detection[key];
      if (!provider) {
        toast.info(`${WALLETS.find((w) => w.key === key)!.name} not detected`, {
          description: "Install the browser extension, then reconnect.",
        });
        return;
      }
      const res = await provider.connect();
      const pubkey = res?.publicKey?.toString() ?? provider.publicKey?.toString() ?? "";
      await connectWallet({ walletKey: key + (pubkey ? ":" + pubkey.slice(0, 8) : "") });
      toast.success(`${WALLETS.find((w) => w.key === key)!.name} connected`, {
        description: pubkey ? `Signer ${pubkey.slice(0, 8)}…${pubkey.slice(-4)} armed for live execution.` : "Signer armed for live execution.",
      });
    } catch (e) {
      toast.error("Connection rejected", {
        description: e instanceof Error ? e.message : "The wallet request was denied.",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async (key: string) => {
    const base = key.split(":")[0] as "phantom" | "solflare" | "backpack";
    const provider = detection[base];
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        // wallet may already be disconnected
      }
    }
    await disconnectWallet({ walletKey: key });
    toast("Wallet disconnected");
  };

  /* ── Inline Import wallet — seed phrase / private key / public key ── */
  const [importOpenFor, setImportOpenFor] = useState<string | null>(null);
  const [importSecret, setImportSecret] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importedSigners, setImportedSigners] = useState<string[]>(() => vaultSignerAddresses());
  const [showSecret, setShowSecret] = useState(false);
  /* ── Vault dashboard state: real balances + recovery sheet ── */
  const [signerBalances, setSignerBalances] = useState<Record<string, string>>({});
  const [balancesBusy, setBalancesBusy] = useState(false);
  const [sheetPass, setSheetPass] = useState("");
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetText, setSheetText] = useState<string | null>(null);

  const refreshBalances = async (addresses: string[]) => {
    if (addresses.length === 0) return;
    setBalancesBusy(true);
    try {
      const next: Record<string, string> = { ...signerBalances };
      await Promise.all(
        addresses.map(async (a) => {
          try {
            const json = await solRpcCall<{ value: number }>(SOL_RPC_ENDPOINTS.mainnet, "getBalance", [a]);
            next[a] = (json.value / 1e9).toFixed(4);
          } catch {
            next[a] = "—"; // RPC unreachable — honest placeholder, never a guess
          }
        }),
      );
      setSignerBalances(next);
    } finally {
      setBalancesBusy(false);
    }
  };

  // Refresh signer list + balances whenever the vault changes.
  useEffect(() => {
    const addrs = vaultSignerAddresses();
    setImportedSigners(addrs);
    if (addrs.length > 0) void refreshBalances(addrs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importedSigners.length]);

  const handleExportSheet = async () => {
    if (!sheetPass.trim()) {
      toast.error("Passphrase required", {
        description: "The recovery sheet re-verifies your session passphrase before exposing keys.",
      });
      return;
    }
    setSheetBusy(true);
    try {
      const res = await exportRecoverySheet(sheetPass);
      if (res.ok) {
        setSheetText(res.text);
        setSheetPass("");
        toast.success("Recovery sheet generated", {
          description: `${res.entries.length} key(s) exported — store offline, like cash.`,
        });
      } else {
        toast.error("Sheet refused", { description: res.error });
      }
    } finally {
      setSheetBusy(false);
    }
  };

  const downloadSheet = () => {
    if (!sheetText) return;
    const blob = new Blob([sheetText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flashbolt-vault-recovery-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Vault-row removal — shared flow with the BNB page: deletes the key from
  // memory AND the encrypted blob; the last removal is a CLEAN SLATE (the
  // blob itself is destroyed — no Lock needed), and the report says exactly
  // that. The stale recovery sheet is dropped so it never describes a vault
  // that no longer holds the removed key.
  const handleRemoveSigner = (address: string) => {
    const outcome = describeVaultRemoval({
      remove: () => removeFromVault(address),
      remaining: vaultSignerAddresses,
    });
    if (!outcome.removed) return;
    setImportedSigners(outcome.remaining);
    setSheetText(null); // stale sheet — force regeneration
    if (outcome.cleanSlate) {
      setSheetPass("");
    }
    toast.success(outcome.cleanSlate ? "Vault cleared — clean slate" : "Signer removed from vault", {
      description:
        `${address.slice(0, 8)}…${address.slice(-4)} no longer signs for live execution. ` +
        (outcome.cleanSlate
          ? outcome.message
          : "Generate a new recovery sheet for the remainder."),
    });
  };

  const handleVaultImport = async (walletName: string) => {
    if (!importPassphrase.trim()) {
      toast.error("Session passphrase required", {
        description: "Your secret is sealed with AES-256-GCM under this passphrase — it never leaves the browser.",
      });
      return;
    }
    setImportBusy(true);
    try {
      const trimmed = importSecret.trim();
      // Public key (watch-only)? 32–44 base58 chars, no derivation possible.
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) && trimmed.split(/\s+/).length === 1 && !/[IlO0]/.test(trimmed.slice(1, -1))) {
        const ok = addWatchOnlyAddress(trimmed);
        if (!ok) throw new Error("Not a valid base58 public key.");
        await connectWallet({ walletKey: "imported:" + trimmed.slice(0, 8) });
        toast.info("Watch-only address armed", {
          description: "Public keys cannot sign — payouts target it; signing still needs a secret import.",
        });
      } else {
        const { address, via, path } = await importToVault(trimmed, importPassphrase);
        await connectWallet({ walletKey: "imported:" + address.slice(0, 8) });
        setImportedSigners(vaultSignerAddresses());
        toast.success(`${walletName} imported — LIVE signer armed`, {
          description: `${address.slice(0, 8)}…${address.slice(-6)} · ${via === "mnemonic" ? path ?? "BIP39" : "private key"} · AES-256-GCM vault.`,
        });
      }
      setImportSecret("");
      setImportOpenFor(null);
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof SolImportError || e instanceof Error ? e.message : "The import was refused — nothing was stored.",
      });
    } finally {
      setImportBusy(false);
    }
  };

  const handleVaultUnlock = async () => {
    setImportBusy(true);
    try {
      const ok = await unlockVault(importPassphrase);
      setImportedSigners(vaultSignerAddresses());
      if (ok) {
        toast.success("Vault unlocked", {
          description: `${vaultSignerAddresses().length} signer(s) live in memory — sub-ms local signing armed.`,
        });
      } else {
        toast.error("Unlock failed", {
          description: vaultSignerAddresses().length ? "Try again." : "No vault exists in this tab yet.",
        });
      }
    } finally {
      setImportBusy(false);
    }
  };

  const grant = getGrant();
  const isOperator = grant?.role === "operator";

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          SOL FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Wallets
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Connect a Solana signer — keys never leave the extension
        </p>
      </header>

      {importedSigners.length > 0 && (
        <Card className="border-emerald-500/25 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="flex items-center gap-2 text-emerald-400">
                <ShieldCheck className="size-4" />
                Vault dashboard — in-memory live signers
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-[10px]"
                disabled={balancesBusy}
                onClick={() => void refreshBalances(importedSigners)}
              >
                {balancesBusy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                Refresh balances
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {importedSigners.map((a) => (
              <div key={a} className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-background/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-semibold text-emerald-300">
                    {a.slice(0, 8)}…{a.slice(-6)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {signerBalances[a] === "—"
                      ? "balance unreachable (RPC)"
                      : signerBalances[a] !== undefined
                        ? `${signerBalances[a]} SOL`
                        : "balance…"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-[10px] text-red-400 hover:text-red-300"
                  onClick={() => handleRemoveSigner(a)}
                >
                  <X className="size-3" />
                  Remove
                </Button>
              </div>
            ))}

            {/* Recovery sheet — passphrase re-gated, plaintext keys */}
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-[11px] font-semibold text-amber-400">
                Recovery sheet — export the vaulted keys (passphrase re-gated)
              </div>
              <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                Mnemonic imports are vaulted as their derived ed25519 key — the word list was never stored, so
                keep your seed phrase backed up separately. This sheet is your cold backup; treat it like cash.
              </p>
              {sheetText === null ? (
                <div className="mt-2 flex gap-2">
                  <Input
                    type="password"
                    placeholder="Session passphrase"
                    value={sheetPass}
                    onChange={(e) => setSheetPass(e.target.value)}
                    className="h-8 flex-1 text-[11px]"
                    autoComplete="off"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-[10px]"
                    disabled={sheetBusy || !sheetPass.trim()}
                    onClick={() => void handleExportSheet()}
                  >
                    {sheetBusy ? <Loader2 className="size-3 animate-spin" /> : <FileDown className="size-3" />}
                    Generate
                  </Button>
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <pre className="max-h-40 overflow-auto rounded-md border border-amber-500/30 bg-background/80 p-2 font-mono text-[10px] text-amber-200">
                    {sheetText}
                  </pre>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[10px]" onClick={downloadSheet}>
                      <FileDown className="size-3" />
                      Download .txt
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-[10px]"
                      onClick={() => {
                        void navigator.clipboard.writeText(sheetText);
                        toast("Sheet copied to clipboard");
                      }}
                    >
                      <FileDown className="size-3" />
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-[10px]"
                      onClick={() => setSheetText(null)}
                    >
                      Hide
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {WALLETS.map((w) => {
          const provider = detection[w.key];
          const connectedRow = connected.find((c) => c.startsWith(w.key + ":") || c === w.key);
          // Full pubkey from the live provider (persisted rows keep 8 chars).
          const fullPubkey = connectedRow
            ? provider?.publicKey?.toString() ?? null
            : null;
          return (
            <Card key={w.key} className="border-border/70 bg-card/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
                  <span className="flex items-center gap-2">
                    <Wallet className={cn("size-4", w.accent)} />
                    {w.name}
                  </span>
                  {connectedRow ? (
                    <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                      <Check className="size-3" />
                      connected
                    </Badge>
                  ) : provider ? (
                    <Badge variant="outline" className="text-[10px]">
                      detected
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      not installed
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                    {connectedRow
                      ? `Signer ${fullPubkey ? `${fullPubkey.slice(0, 8)}…${fullPubkey.slice(-4)}` : `${connectedRow.split(":")[1] ?? ""}…`} armed for live routes.`
                      : provider
                        ? "Extension detected — connect to arm live execution."
                        : "Install the extension to arm live execution."}
                  </p>
                  {connectedRow && fullPubkey && (
                    <button
                      type="button"
                      aria-label="Copy full address"
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      onClick={() => copyAddress(fullPubkey)}
                    >
                      <Copy className="size-3" />
                    </button>
                  )}
                </div>
                {connectedRow ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-[11px]"
                    onClick={() => void handleDisconnect(connectedRow)}
                  >
                    <X className="size-3.5" />
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full text-[11px]"
                    disabled={busy === w.key}
                    onClick={() => void handleConnect(w.key)}
                  >
                    {provider ? "Connect" : (
                      <>
                        <Download className="size-3.5" />
                        Get {w.name}
                      </>
                    )}
                  </Button>
                )}
                {!provider && (
                  <a
                    href={w.installUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                  >
                    Official download
                    <ExternalLink className="size-3" />
                  </a>
                )}
                {/* Inline import — alternative to extension connect */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setImportOpenFor(importOpenFor === w.key ? null : w.key)}
                >
                  <KeyRound className="size-3" />
                  Import wallet
                </Button>
                {importOpenFor === w.key && (
                  <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-2.5">
                    <Input
                      type="password"
                      placeholder="Session passphrase (AES-256-GCM)"
                      value={importPassphrase}
                      onChange={(e) => setImportPassphrase(e.target.value)}
                      disabled={importBusy}
                      className="h-8 text-[11px]"
                      autoComplete="new-password"
                    />
                    <div className="relative">
                      <Input
                        type={showSecret ? "text" : "password"}
                        placeholder="seed phrase · private key · public key (watch-only)"
                        value={importSecret}
                        onChange={(e) => setImportSecret(e.target.value)}
                        disabled={importBusy}
                        className="h-8 pr-14 font-mono text-[11px]"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase text-muted-foreground hover:text-foreground"
                      >
                        {showSecret ? "Hide" : "Show"}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Button
                        size="sm"
                        className="h-7 gap-1 text-[10px]"
                        disabled={!importSecret.trim() || !importPassphrase.trim() || importBusy}
                        onClick={() => void handleVaultImport(w.name)}
                      >
                        {importBusy ? <Loader2 className="size-3 animate-spin" /> : <KeyRound className="size-3" />}
                        Import
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-[10px]"
                        disabled={importBusy}
                        onClick={() => void handleVaultUnlock()}
                      >
                        <Lock className="size-3" />
                        Unlock
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-full gap-1 text-[9px]"
                      onClick={() => {
                        lockVault();
                        setImportedSigners([]);
                        toast.info("Vault locked", { description: "All memory material and the tab's ciphertext wiped." });
                      }}
                    >
                      <X className="size-3" />
                      Lock vault — wipe this tab
                    </Button>
                    <p className="flex items-start gap-1 text-[9px] leading-tight text-muted-foreground">
                      <ShieldCheck className="mt-0.5 size-2.5 shrink-0" />
                      BIP39 + SLIP-0010 validated locally; sealed AES-256-GCM in this tab only — the secret never leaves the browser.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isOperator && (
        <a
          href="/download"
          className="flex items-center justify-between rounded-xl border border-border/70 bg-card/40 px-4 py-3 transition-colors hover:border-primary/40"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Code className="size-4 text-primary" />
            Source Code
            <span className="text-[11px] font-normal text-muted-foreground">
              desktop setups · Linux / macOS / Windows
            </span>
          </span>
          <span className="text-[10px] font-semibold text-primary">Download</span>
        </a>
      )}
    </div>
  );
}
