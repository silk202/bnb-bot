import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTerminal } from "@/hooks/use-terminal";
import {
  connectWallet,
  detectProvider,
  shortenAddress,
  WALLET_DEFS,
  weiToBnb,
  type ConnectedWallet as ConnectedWalletResult,
  type WalletKey,
} from "@/lib/wallets";
import { getWalletChainId, ensureWalletChain, type Eip1193Provider } from "@/lib/chain";
import {
  ensureEvmSessionGuard,
  onWalletSessionEvent,
  reconnectInjectedEvm,
} from "@/lib/wallet-session";
import { BNB_NETWORKS, networkForChainId } from "@/lib/chain";
import {
  Check,
  Copy,
  FileDown,
  KeyRound,
  Loader2,
  Lock,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Unplug,
  Wallet,
  X,
} from "lucide-react";
import {
  importToVault as evmImportToVault,
  unlockVault as evmUnlockVault,
  lockVault as evmLockVault,
  removeFromVault as evmRemoveFromVault,
  vaultSignerAddresses as evmVaultSignerAddresses,
  addWatchOnlyAddress as evmAddWatchOnly,
  exportRecoverySheet as evmExportRecoverySheet,
} from "@/lib/evm-vault";
import { connectEvmChain, EvmImportError } from "@/lib/evm-import";
import { describeVaultRemoval } from "@/lib/vault-remove-flow";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const WALLET_ICON_STYLES: Record<WalletKey, { glyph: string; color: string }> = {
  metamask: { glyph: "M", color: "bg-gradient-to-br from-amber-400 to-orange-500" },
  trust: { glyph: "T", color: "bg-gradient-to-br from-sky-400 to-blue-600" },
  okx: { glyph: "•", color: "bg-zinc-700" },
  binance: { glyph: "B", color: "bg-gradient-to-br from-yellow-300 to-amber-500" },
  bybit: { glyph: "B", color: "bg-gradient-to-br from-indigo-400 to-purple-600" },
};

export default function Wallets() {
  const { state, connectWallet: persistConnection, disconnectWallet: persistDisconnect, setSettings } =
    useTerminal();
  const [connections, setConnections] = useState<Record<string, ConnectedWalletResult>>({});

  const connectedKeys = state?.connectedWallets ?? [];

  /* ── Inline Import wallet — seed phrase / private key / public address ──
   * Cryptographically secured: the secret is derived locally (BIP39
   * m/44'/60'/0'/0/0 via viem/accounts) and sealed with AES-256-GCM under
   * the operator's session passphrase in this tab only. Only the PUBLIC
   * address is persisted. Imported signers feed the sniper/scanner/flasher
   * live-execution paths (in-memory, sub-ms local signing). */
  const [importOpenFor, setImportOpenFor] = useState<string | null>(null);
  const [importSecret, setImportSecret] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [importedSigners, setImportedSigners] = useState<string[]>(() => evmVaultSignerAddresses());

  const handleVaultImport = async () => {
    if (!importPassphrase.trim()) {
      toast.error("Session passphrase required", {
        description: "Your secret is sealed with AES-256-GCM under this passphrase — it never leaves the browser.",
      });
      return;
    }
    setImportBusy(true);
    try {
      const trimmed = importSecret.trim();
      // Public address (watch-only)? 0x + 40 hex chars, no signature possible.
      if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
        const ok = evmAddWatchOnly(trimmed);
        if (!ok) throw new EvmImportError("Not a valid 0x address.");
        await persistConnection({ walletKey: "imported:" + trimmed.slice(0, 10) });
        toast.info("Watch-only address armed", {
          description: "Addresses cannot sign — payouts target it; signing still needs a secret import.",
        });
      } else {
        const res = await evmImportToVault(trimmed, importPassphrase);
        await persistConnection({ walletKey: "imported:" + res.address.slice(0, 10) });
        setImportedSigners(evmVaultSignerAddresses());
        const prev = state?.evmImportedWallets ?? [];
        if (!prev.some((a) => a.toLowerCase() === res.address.toLowerCase())) {
          void setSettings({ evmImportedWallets: [...prev, res.address] }).catch(() => undefined);
        }
        // Live chain check — real eth_chainId round-trip on the active network.
        const net = state?.network === "testnet" ? "testnet" : "mainnet";
        const conn = await connectEvmChain(net);
        if (conn.connected) {
          toast.success("Imported — LIVE signer armed", {
            description: `${res.address.slice(0, 10)}…${res.address.slice(-6)} · ${res.via === "mnemonic" ? "BIP44 m/44'/60'/0'/0/0" : "private key"} · vault sealed (AES-256-GCM) · chainId ${conn.chainId} in ${conn.latencyMs}ms.`,
          });
        } else {
          toast.warning("Imported — RPC unreachable", {
            description: conn.error ?? "Signing still works locally once the network is back.",
          });
        }
      }
      setImportSecret("");
      setImportOpenFor(null);
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof EvmImportError || e instanceof Error ? e.message : "The import was refused — nothing was stored.",
      });
    } finally {
      setImportBusy(false);
    }
  };

  const handleVaultUnlock = async () => {
    setImportBusy(true);
    try {
      const ok = await evmUnlockVault(importPassphrase);
      setImportedSigners(evmVaultSignerAddresses());
      if (ok) {
        toast.success("Vault unlocked", {
          description: `${evmVaultSignerAddresses().length} signer(s) live in memory — sub-ms local signing armed.`,
        });
      } else {
        toast.error("Unlock failed", {
          description: evmVaultSignerAddresses().length ? "Try again." : "No vault exists in this tab yet.",
        });
      }
    } finally {
      setImportBusy(false);
    }
  };

  // Vault-row removal — shared flow with the SOL page: deletes the key from
  // memory AND the encrypted blob; the last removal is a CLEAN SLATE (the
  // blob itself is destroyed — no Lock needed), and the report says exactly
  // that. A stale recovery sheet is dropped so it can never be re-exported
  // describing a vault that no longer holds the removed key.
  const handleRemoveSigner = (address: string) => {
    const outcome = describeVaultRemoval({
      remove: () => evmRemoveFromVault(address),
      remaining: evmVaultSignerAddresses,
    });
    if (!outcome.removed) return;
    setImportedSigners(outcome.remaining);
    setSheetText(null);
    if (outcome.cleanSlate) {
      setSheetPass("");
    }
    toast.success(outcome.cleanSlate ? "Vault cleared — clean slate" : "Signer removed from vault", {
      description:
        `${address.slice(0, 10)}…${address.slice(-6)} no longer signs for live execution. ` +
        (outcome.cleanSlate
          ? outcome.message
          : "Generate a new recovery sheet for the remainder."),
    });
  };

  /* ── Recovery sheet — passphrase re-gated plaintext key export ── */
  const [sheetPass, setSheetPass] = useState("");
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetText, setSheetText] = useState<string | null>(null);

  const handleExportSheet = async () => {
    if (!sheetPass.trim()) {
      toast.error("Passphrase required", {
        description: "The recovery sheet re-verifies your session passphrase before exposing keys.",
      });
      return;
    }
    setSheetBusy(true);
    try {
      const res = await evmExportRecoverySheet(sheetPass);
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
    a.download = `flashbolt-evm-vault-recovery-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Vault balances — REAL eth_getBalance per signer on the active network ── */
  const [signerBalances, setSignerBalances] = useState<Record<string, string>>({});
  const [balancesBusy, setBalancesBusy] = useState(false);

  const refreshBalances = async (addresses: string[]) => {
    if (addresses.length === 0) return;
    setBalancesBusy(true);
    try {
      const net = state?.network === "testnet" ? "testnet" : "mainnet";
      const endpoint = BNB_NETWORKS[net].rpc;
      const next: Record<string, string> = { ...signerBalances };
      await Promise.all(
        addresses.map(async (a) => {
          try {
            const { fetchWithTimeout } = await import("@/lib/fetch-timeout");
            const res = await fetchWithTimeout(endpoint, 8_000, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getBalance",
                params: [a, "latest"],
              }),
            });
            const json = (await res.json()) as { result?: string; error?: { message?: string } };
            if (typeof json.result !== "string") throw new Error(json.error?.message ?? "no balance in response");
            next[a] = (Number(BigInt(json.result)) / 1e18).toFixed(4);
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

  // Refresh balances whenever the vault signer set changes.
  useEffect(() => {
    if (importedSigners.length > 0) void refreshBalances(importedSigners);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importedSigners.length]);

  // One-tap copy for a full address (the shortened rows hide it).
  const copyAddress = (address: string) => {
    void navigator.clipboard.writeText(address);
    toast.success("Address copied", {
      description: `${address.slice(0, 10)}…${address.slice(-6)} — full 0x address on your clipboard.`,
    });
  };

  // ── SEAMLESS SESSION: silent reconnect + live account/chain tracking ──
  // On mount: one eth_accounts probe (zero popup) restores the authorized
  // account after a reload, and the EIP-1193 guard fans account/chain
  // changes into this page live. No key ever leaves the extension.
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [chainOk, setChainOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    ensureEvmSessionGuard();
    void reconnectInjectedEvm().then((addr) => {
      if (alive) setSessionAddress(addr);
    });
    void (async () => {
      const p = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
      if (!p) return;
      const id = await getWalletChainId(p);
      if (alive) setChainOk(id === null ? null : networkForChainId(id) !== null);
    })();
    const off = onWalletSessionEvent((e) => {
      if (e.kind === "accounts") {
        setSessionAddress(e.address);
        if (e.address === null) {
          toast.info("Wallet locked or disconnected", {
            description: "Unlock the extension and press Connect to restore the session.",
          });
        }
      }
      if (e.kind === "chain") {
        setChainOk(networkForChainId(e.chainId) !== null);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const handleConnect = async (key: WalletKey) => {
    const def = WALLET_DEFS.find((w) => w.key === key);
    try {
      const result = await connectWallet(key);
      setConnections((prev) => ({ ...prev, [key]: result }));
      await persistConnection({ walletKey: key });
      setSessionAddress(result.address);
      toast.success(`${def?.name} connected`, {
        description: `${shortenAddress(result.address)} · EIP-1193 (keys stay in your extension).`,
      });
    } catch (error) {
      toast.error("Connection failed", {
        description: error instanceof Error ? error.message : "The wallet rejected the request.",
      });
    }
  };

  // Header funding strip — the connected account's FULL address (click-to-copy)
  // plus its live BNB balance from a real eth_getBalance. This is the funding
  // answer: one glance shows exactly what to give an exchange or sender.
  const [headerBal, setHeaderBal] = useState<string | null>(null);
  useEffect(() => {
    setHeaderBal(null);
    if (!sessionAddress) return;
    let alive = true;
    void (async () => {
      try {
        const net = state?.network === "testnet" ? "testnet" : "mainnet";
        const { fetchWithTimeout } = await import("@/lib/fetch-timeout");
        const res = await fetchWithTimeout(BNB_NETWORKS[net].rpc, 8_000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [sessionAddress, "latest"],
          }),
        });
        const json = (await res.json()) as { result?: string };
        if (alive && typeof json.result === "string") {
          setHeaderBal((Number(BigInt(json.result)) / 1e18).toFixed(4));
        }
      } catch {
        if (alive) setHeaderBal(null); // RPC unreachable — honest placeholder
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionAddress, state?.network]);

  const handleDisconnect = async (key: WalletKey) => {
    setConnections((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await persistDisconnect({ walletKey: key });
    toast("Wallet disconnected", {
      description: "No keys ever left your extension — paper mode continues.",
    });
  };

  // One-tap chain repair — real wallet_switchEthereumChain via EIP-1193.
  const switchToBnbChain = async () => {
    const p = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
    if (!p) return;
    const network = state?.network === "testnet" ? "testnet" : "mainnet";
    try {
      await ensureWalletChain(p, network);
      setChainOk(true);
      toast.success(`Wallet switched to ${BNB_NETWORKS[network].label}`);
    } catch (err) {
      toast.error("Chain switch rejected", {
        description: err instanceof Error ? err.message : "Approve the switch in your extension.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Wallets
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          One EIP-1193 connector, five wallets. Connect your extension to read
          your balance — the terminal never touches your keys, and paper mode
          never moves funds.
        </p>
        {sessionAddress && (
          <div className="mt-3 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-background/40 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-foreground/90">
              {sessionAddress}
            </span>
            <button
              type="button"
              aria-label="Copy full address"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              onClick={() => copyAddress(sessionAddress)}
            >
              <Copy className="size-3" />
            </button>
            <span className="text-[10px] text-muted-foreground">
              your funding address · live balance{" "}
              <span className="font-mono font-semibold text-emerald-400">
                {headerBal !== null ? `${headerBal} BNB` : "…"}
              </span>
            </span>
          </div>
        )}
      </header>

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      {/* Session strip — the honest, live connection state of the extension */}
      {connectedKeys.length > 0 && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-xs",
            chainOk === false
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
          )}
        >
          {chainOk === false ? (
            <>
              <ShieldAlert className="size-3.5 shrink-0" />
              <span className="font-semibold">
                Wallet on a different network
              </span>
              <span className="text-amber-200/80">
                Live execution auto-switches the chain at broadcast — or switch now:
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-500/40 px-2 text-[10px] text-amber-100 hover:bg-amber-500/15"
                onClick={() => void switchToBnbChain()}
              >
                Switch to {BNB_NETWORKS[state?.network === "testnet" ? "testnet" : "mainnet"].label}
              </Button>
            </>
          ) : (
            <>
              <ShieldCheck className="size-3.5 shrink-0" />
              <span className="font-semibold">Wallet session live</span>
              <span className="text-emerald-200/80">
                {sessionAddress
                  ? `${shortenAddress(sessionAddress)} · reconnects silently on reload · chain OK`
                  : "extension authorized — unlock it to restore the signer"}
              </span>
            </>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {WALLET_DEFS.map((wallet) => {
          const isConnected = connectedKeys.includes(wallet.key);
          const installed = detectProvider(wallet.key) !== null;
          const result = connections[wallet.key];
          const icon = WALLET_ICON_STYLES[wallet.key];
          const balance = result ? weiToBnb(result.balanceWei) : null;
          // Honest badge: a persisted connection whose extension went missing
          // or whose authorization was revoked is shown as needing reconnect
          // — never pretended to be live.
          const sessionLive = isConnected && installed && sessionAddress !== null;
          return (
            <Card
              key={wallet.key}
              className={cn(
                "border-border/70 bg-card/40 shadow-none transition-colors",
                sessionLive && "border-emerald-500/40",
                isConnected && !sessionLive && "border-amber-500/40",
              )}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div
                    className={cn(
                      "flex size-11 items-center justify-center rounded-full text-lg font-extrabold text-white shadow-lg",
                      icon.color,
                    )}
                  >
                    {icon.glyph}
                  </div>
                  {sessionLive ? (
                    <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
                      <Check className="size-3" />
                      Connected
                    </Badge>
                  ) : isConnected ? (
                    <Badge className="border-amber-500/25 bg-amber-500/10 text-amber-400">
                      <ShieldAlert className="size-3" />
                      Reconnect needed
                    </Badge>
                  ) : (
                    <Badge variant="outline">Not connected</Badge>
                  )}
                </div>
                <CardTitle className="mt-3 text-base font-semibold">
                  {wallet.name}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{wallet.desc}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {isConnected && (
                  <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-foreground/90">
                        {sessionAddress
                          ? shortenAddress(sessionAddress)
                          : result?.address
                            ? shortenAddress(result.address)
                            : "Wallet connected"}
                      </span>
                      {(sessionAddress ?? result?.address) && (
                        <button
                          type="button"
                          aria-label="Copy full address"
                          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                          onClick={() => copyAddress((sessionAddress ?? result?.address)!)}
                        >
                          <Copy className="size-3" />
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {!installed
                        ? "extension missing — install it and press Connect"
                        : balance !== null
                          ? `${balance.toFixed(4)} BNB on this chain`
                          : sessionAddress
                            ? "session restored — live balance on next connect"
                            : "switch wallet to BNB Smart Chain"}
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  variant={isConnected ? "outline" : "default"}
                  className="w-full gap-2"
                  onClick={() =>
                    isConnected
                      ? void handleDisconnect(wallet.key)
                      : void handleConnect(wallet.key)
                  }
                >
                  {isConnected ? (
                    <>
                      <Unplug className="size-4" />
                      Disconnect
                    </>
                  ) : (
                    <>
                      <PlugZap className="size-4" />
                      Connect
                    </>
                  )}
                </Button>
                {/* Inline import — alternative to the extension connect */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setImportOpenFor(importOpenFor === wallet.key ? null : wallet.key)}
                >
                  <KeyRound className="size-3.5" />
                  Import wallet
                </Button>
                {importOpenFor === wallet.key && (
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
                        placeholder="seed phrase · private key · 0x address (watch-only)"
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
                        onClick={() => void handleVaultImport()}
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
                        evmLockVault();
                        setImportedSigners([]);
                        toast.info("Vault locked", { description: "All memory material cleared — the encrypted blob stays for this tab." });
                      }}
                    >
                      <X className="size-3" />
                      Lock vault — clear this tab's keys
                    </Button>
                    <p className="flex items-start gap-1 text-[9px] leading-tight text-muted-foreground">
                      <ShieldCheck className="mt-0.5 size-2.5 shrink-0" />
                      BIP39/BIP44 validated locally; sealed AES-256-GCM in this tab only — the secret never leaves the browser and never reaches any server.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Vault dashboard — imported live signers with real on-chain presence checks */}
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
            <p className="text-[11px] text-muted-foreground">
              Keys sealed under your session passphrase (AES-256-GCM, PBKDF2-SHA-256 310k). These signers drive
              scanner, flasher and sniper live execution — in-process signing, no extension popup, no mocks.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {importedSigners.map((a) => (
              <div key={a} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/30 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-emerald-300">
                      {a.slice(0, 10)}…{a.slice(-6)}
                    </span>
                    <button
                      type="button"
                      aria-label="Copy full address"
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      onClick={() => copyAddress(a)}
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {signerBalances[a] === "—"
                      ? "balance unreachable (RPC)"
                      : signerBalances[a] !== undefined
                        ? `${signerBalances[a]} BNB`
                        : "balance…"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] text-red-400 hover:text-red-300"
                  onClick={() => handleRemoveSigner(a)}
                >
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
                Mnemonic imports are vaulted as their derived secp256k1 key — the word list was never stored, so
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

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col justify-center gap-2.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-4 text-xs">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <Wallet className="size-4 text-emerald-400" />
            Automatic payout
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
              {state?.autoPayout ? "ON" : "OFF"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {state?.autoPayout
              ? `${(state?.payoutsTotal ?? 0).toFixed(4)} BNB has been auto-paid out to your wallet across ${state?.payoutsCount ?? 0} executions.`
              : "Auto-payout is off — profits stay in the paper account. Flip it on from the Strategy or Bot page."}
          </p>
        </div>
        <div className="flex items-start gap-2.5 rounded-2xl border border-primary/25 bg-primary/8 px-4 py-4 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            Extension connections: no keys ever leave the wallet — sessions restore silently after reload.
            <span className="mt-1 block">
              Imported wallets: secrets are derived locally (BIP39/BIP44) and sealed with AES-256-GCM under your
              session passphrase in this tab only — never stored in plaintext, never transmitted, wiped on Lock or
              when the tab closes. Only public addresses persist on your account.
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
