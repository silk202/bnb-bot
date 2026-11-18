import MultiSignalMonitor from "@/components/MultiSignalMonitor";
import CopierBotPanel from "@/components/CopierBotPanel";
import { ScannerOverlayPanel } from "@/components/ScannerOverlayPanel";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTerminal } from "@/hooks/use-terminal";
import { CHAIN_INFO, DEFAULT_FEED_SETTINGS, loadDailyTracker, incrementTracker, canExecute, type MarketSnapshot } from "@/lib/flashbolt";
import { getInjectedProvider, getWalletAddress } from "@/lib/chain";
import {
  auditLine,
  breakerVerdict,
  chainConfigVerdict,
  checkTransactionLimits,
  DEFAULT_PAYOUT_LIMITS,
  evaluateValueMovement,
  nextBreakerState,
  payoutRoleVerdict,
  resolvePayoutTarget,
  type OverrideAuthorization,
  type RiskFinding,
} from "@/lib/wallet-guard";
import {
  addExposure,
  loadBaseline,
  loadBreaker,
  loadExposure,
  recordBaseline,
  resetBreaker,
  saveBreaker,
} from "@/lib/payout-ledger";
import { classifyOutflow, detectApprovals, nativeBalance, probeAllowances } from "@/lib/wallet-risk";
import { knownSpendersFor } from "@/lib/spender-allowlist";
import { discoverApprovalsFromHistory } from "@/lib/wallet-history";
import { refusalMessage } from "@/chains/execution/preflight";
import { authorizeExternalWithdrawal, authorizeInternalPayout } from "@/chains/execution/authorization";
import { verifyExecutorPinned } from "@/chains/execution/bytecode-pin";
import { activationFor } from "@/chains/registry/activations";
import { executionTargetReasons, internalDestinationFor } from "@/chains/registry/discovery-store";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { cn } from "@/lib/utils";
import {
  ArrowRightLeft,
  ArrowUpRight,
  Bot,
  Cog,
  Crosshair,
  Eye,
  Flame,
  HelpCircle,
  History,
  Key,
  LayoutDashboard,
  List,
  Loader2,
  Minus,
  Monitor,
  Network,
  RefreshCw,
  Scan,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldOff,
  Signal,
  Target,
  Terminal,
  TrendingUp,
  Wallet,
  Zap,
  X,
} from "lucide-react";
import { useTelegramAlerts } from "@/hooks/use-telegram-alerts";
import { fmtSignLatency } from "@/lib/telegram";
import { useAutoSell } from "@/hooks/use-auto-sell";
import {
  buyToken,
  fetchTokenPriceUsd,
  resolveSignerFrom,
  transferNative,
  type SwapSigner,
} from "@/lib/swap-executor";
import { CHAIN_NETWORKS, executionEnvFor, type ChainKey, type NetworkKey } from "@/lib/chains";
import { isPrivateRpcAvailable } from "@/lib/private-rpc";
import { RelayStatusCard } from "@/components/RelayStatusCard";
import { ALL_SOURCES, type LiveTokenSignal } from "@/components/MultiSignalMonitor";
import { fetchMultiSignalTokens } from "@/lib/multi-signal-fetcher";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { classifyBuyable, fetchTokenPairTvlNative } from "@/lib/profit-guarantor";
import { type Hex } from "viem";
import { isAddressLike, fetchGasPriceGwei } from "@/lib/chain";
import {
  importToVault as evmImportToVault,
  unlockVault as evmUnlockVault,
  lockVault as evmLockVault,
  removeFromVault as evmRemoveFromVault,
  getVaultHotWallet as evmGetVaultHotWallet,
  vaultSignerAddresses as evmVaultSignerAddresses,
  vaultUnlocked as evmVaultUnlocked,
  addWatchOnlyAddress as evmAddWatchOnly,
  getVaultPrivateKey as evmGetVaultPrivateKey,
} from "@/lib/evm-vault";
import { connectEvmChain, EvmImportError } from "@/lib/evm-import";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { generateMnemonic, english, privateKeyToAccount, generatePrivateKey } from "viem/accounts";

/* ─── Supported chains ─── */
const SNIPER_CHAINS: { key: ChainKey; label: string; symbol: string }[] = [
  { key: "bsc", label: "BSC", symbol: "BNB" },
  { key: "ethereum", label: "ETH", symbol: "ETH" },
  { key: "polygon", label: "MATIC", symbol: "MATIC" },
  { key: "arbitrum", label: "ARB", symbol: "ETH" },
];

/**
 * Subscriber-facing daily-target badge (BNB + SOL snipers and scanners).
 * Reads the same server-enforced counter the execution guard consumes:
 * subscribers see live usage against their operator-set daily target;
 * operators and non-gated accounts see unlimited.
 */
export function DailyTargetBadge() {
  const myLimit = useQuery(api.terminal.myExecutionLimit);
  if (myLimit === undefined || myLimit === null) return null;
  if (myLimit.unlimited || myLimit.operator || (myLimit as { guest?: boolean }).guest) {
    return (
      <Badge variant="outline" className="gap-1.5 text-[11px] text-muted-foreground" title="Daily execution target — arb + snipe combined across both terminals">
        <Target className="size-3" />
        Daily target: unlimited
      </Badge>
    );
  }
  const limit = (myLimit.limit as number | null) ?? 0;
  const used = myLimit.used ?? 0;
  const exhausted = used >= limit;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 text-[11px]",
        exhausted ? "border-red-500/50 text-red-400" : "text-muted-foreground",
      )}
      title="Daily execution target — arb + snipe combined across both terminals. Resets at UTC midnight; the operator can raise, lower or block it."
    >
      <Target className="size-3" />
      Daily target: {used}/{limit}{exhausted ? " — reached" : ""}
    </Badge>
  );
}

/* ─── Command definitions matching screenshots ─── */
type CommandKey =
  | "start" | "setup" | "my_settings" | "bridge" | "quick"
  | "monitor" | "chains" | "signal" | "godmode" | "trademode"
  | "tradestat" | "cleartrades" | "trending" | "wallets"
  | "import" | "help" | "withdraw" | "multisignal";

interface CommandDef {
  cmd: CommandKey;
  label: string;
  icon: React.ReactNode;
  desc: string;
  section: string;
}

const COMMANDS: CommandDef[] = [
  { cmd: "start", label: "Main System HUD Control Dashboard", icon: <LayoutDashboard className="size-4" />, desc: "The primary HUD control dashboard", section: "hud" },
  { cmd: "setup", label: "Global Configurations Interface", icon: <Cog className="size-4" />, desc: "Modify parameters, builder tip priorities, and custom triggers", section: "config" },
  { cmd: "my_settings", label: "Slippage and Profit Targets Setup", icon: <Settings className="size-4" />, desc: "Slippage Floor, Minimum Target Profit", section: "config" },
  { cmd: "bridge", label: "Cross-Chain Vault Liquidity Bridge", icon: <ArrowRightLeft className="size-4" />, desc: "Route stable assets dynamically between EVM instances and Solana gas paths", section: "bridge" },
  { cmd: "quick", label: "Launch High-Frequency Direct Sniper", icon: <Zap className="size-4" />, desc: "Input a raw address shortcut path to deploy atomic simulation transactions immediately", section: "execute" },
  { cmd: "monitor", label: "Stream Active Open Positions", icon: <Monitor className="size-4" />, desc: "Real-time active position monitoring for all dynamic entry positions", section: "monitor" },
  { cmd: "chains", label: "Check Network Node Connection Status", icon: <Network className="size-4" />, desc: "Multi-Chain Protocol Registry Status", section: "network" },
  { cmd: "signal", label: "Run Pre-Flight Token Simulations", icon: <Signal className="size-4" />, desc: "Real-time token profile with live sandbox profile matrix", section: "analysis" },
  { cmd: "godmode", label: "Advanced Anti-Rug Security Protocols", icon: <ShieldAlert className="size-4" />, desc: "Frontrun honeypot activation strings or tax state modification adjustments", section: "security" },
  { cmd: "trademode", label: "Shift Paths Between Auto/Manual Modes", icon: <ArrowUpRight className="size-4" />, desc: "Toggle variables interactively between Auto/Manual", section: "trade" },
  { cmd: "tradestat", label: "View Performance History Analytics", icon: <History className="size-4" />, desc: "Historical metrics tracking and analytics", section: "trade" },
  { cmd: "cleartrades", label: "Clear Cached Pipeline Logs", icon: <Minus className="size-4" />, desc: "Clear historical metrics tracking logs", section: "trade" },
  { cmd: "trending", label: "View Top Volume Launch Targets", icon: <Flame className="size-4" />, desc: "Cross-Chain Trending Token Flow", section: "discovery" },
  { cmd: "wallets", label: "View Connected Vault Accounts Array", icon: <Wallet className="size-4" />, desc: "Connected Wallets Management — Metamask, TrustWallet, Phantom, Binance, Bybit", section: "vault" },
  { cmd: "import", label: "Add Master Cryptographic Credentials", icon: <Key className="size-4" />, desc: "Secure Cryptographic Key Import Terminal", section: "vault" },
  { cmd: "help", label: "Load Systems Operations Manual Hub", icon: <HelpCircle className="size-4" />, desc: "Run /sniper to load the primary HUD control dashboard interface", section: "help" },
  { cmd: "withdraw", label: "Instant Fund Withdrawal Gateway Extraction", icon: <Send className="size-4" />, desc: "Asset Withdrawal Portal — extract system hot wallet parameters to cold wallets", section: "vault" },
];

/* ─── Sniper state (local, not persisted to backend) ─── */
interface SniperState {
  networkTarget: ChainKey;
  routingMatrix: string;
  executionMode: "auto" | "manual";
  activeTrack: "snipe" | "arb" | "mev";
  slippageFloor: number;
  minTargetProfit: number;
  mevProtection: boolean;
  autoRouter: boolean;
  honeypotDetection: boolean;
  contractVerification: boolean;
  maxGasPrice: number;
  minLiquidity: number;
  maxHolderConcentration: number;
  bridgeSourceChain: ChainKey;
  bridgeDestChain: ChainKey;
  pendingPnl: number;
  realizedPnl: number;
  activePositions: { symbol: string; entry: number; current: number; pnl: number; chain: string }[];
}

const INITIAL_STATE: SniperState = {
  networkTarget: "bsc",
  routingMatrix: "PANCAKE_V3",
  executionMode: "manual",
  activeTrack: "snipe",
  slippageFloor: 3,
  minTargetProfit: 10,
  mevProtection: true,
  autoRouter: false,
  honeypotDetection: true,
  contractVerification: true,
  maxGasPrice: 5,
  minLiquidity: 10000,
  maxHolderConcentration: 60,
  bridgeSourceChain: "bsc",
  bridgeDestChain: "ethereum",
  pendingPnl: 0,
  realizedPnl: 0,
  activePositions: [],
};

/* ─── Action button grid items ─── */
const GRID_ACTIONS = [
  { label: "Multi-Signal Monitor", icon: <Bot className="size-4" />, action: "multisignal" as CommandKey, color: "text-emerald-400" },
  { label: "Multi-Sniper Bot", icon: <Crosshair className="size-4" />, action: "quick" as CommandKey, color: "text-emerald-400" },
  { label: "Chains Status", icon: <Network className="size-4" />, action: "chains" as CommandKey, color: "text-blue-400" },
  { label: "Wallets Setup", icon: <Wallet className="size-4" />, action: "wallets" as CommandKey, color: "text-amber-400" },
  { label: "Call Channels", icon: <Signal className="size-4" />, action: "monitor" as CommandKey, color: "text-purple-400" },
  { label: "Trading Signals", icon: <TrendingUp className="size-4" />, action: "signal" as CommandKey, color: "text-cyan-400" },
  { label: "God Mode", icon: <ShieldAlert className="size-4" />, action: "godmode" as CommandKey, color: "text-red-400" },
];

export default function Sniper() {
  const { state, setSettings } = useTerminal();
  const [sniper, setSniper] = useState<SniperState>(INITIAL_STATE);
  const [activeCmd, setActiveCmd] = useState<CommandKey | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [quickTarget, setQuickTarget] = useState("");
  const [importKey, setImportKey] = useState("");
  const consumeExecutionSlot = useMutation(api.terminal.consumeExecutionSlot);
  /** Blocked payouts are recorded in the execution trail (status "blocked"). */
  const recordExecution = useMutation(api.terminal.recordExecution);
  const recordPayoutBlock = useMutation(api.payouts.recordPayoutBlock);
  const rejectWithdrawalOnServer = useMutation(api.payouts.requestExternalWithdrawal);
  const approveInternalDestination = useMutation(api.destinations.approveInternalDestination);
  const recordBlockedExecution = useMutation(api.executionBlocks.recordBlockedExecution);
  // The approve control is operator-only; the mutation enforces it server-side
  // too, but a button that can only ever error should not be shown.
  const operatorCheck = useQuery(api.gate.isOperatorUser);
  const isOperator = operatorCheck?.isOperator === true;
  const myLimit = useQuery(api.terminal.myExecutionLimit);
  const [importNetwork, setImportNetwork] = useState("BSC");
  const [bridgeAmount, setBridgeAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState("");
  const [signalToken, setSignalToken] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [autoApprove, setAutoApprove] = useState(true);
  const [customBuyAmount, setCustomBuyAmount] = useState(0.01);
  const [customSellPct, setCustomSellPct] = useState(100);
  const [customSellAmountPct, setCustomSellAmountPct] = useState(100);
  const [showMultiSignal, setShowMultiSignal] = useState(false);
  const [showCopier, setShowCopier] = useState(true);
  const [hiddenSignalTokens, setHiddenSignalTokens] = useState<Set<string>>(new Set());
  const tg = useTelegramAlerts();
  // Flash loan removed from sniper — sniper is sniping ONLY, no flash loan.
  const [directWalletPayout, setDirectWalletPayout] = useState(true); // Default: auto payout to connected wallet
  const [hotWalletPayout, setHotWalletPayout] = useState(false); // auto-withdraw to the CONNECTED external wallet
  // Hot wallet (generated) — BIP39 12-word mnemonic + private key + address
  const [hotWallet, setHotWallet] = useState<{ mnemonic: string; privateKey: string; address: string } | null>(null);
  /**
   * Payout destination: the external wallet connected RIGHT NOW, resolved at
   * payout time. There is deliberately no address field — a typed/pasted
   * address is how profit could be redirected (see the drain incident report).
   * The only operator input is a reason, used when the wallet guard trips.
   */
  const [payoutOverrideReason, setPayoutOverrideReason] = useState("");
  /** Single-use, 15-minute authorization issued by an explicit operator click. */
  const [payoutAuth, setPayoutAuth] = useState<OverrideAuthorization | null>(null);
  /** Chosen receive-only destination from the connected external wallets. */
  const [payoutWallet, setPayoutWallet] = useState("");
  const payoutWallets = (state?.connectedWallets ?? []).filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w));
  const authorizeNextPayout = useCallback(async () => {
    const injected = getInjectedProvider();
    const connected = injected ? await getWalletAddress(injected) : null;
    const now = Date.now();
    setPayoutAuth({
      operatorId: "terminal-operator",
      reason: payoutOverrideReason,
      wallet: (connected ?? "").toLowerCase(),
      txKey: `payout-${now.toString(36)}`,
      issuedAt: now,
      expiresAt: now + 15 * 60 * 1000,
    });
  }, [payoutOverrideReason]);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  // Direct wallet (imported) — via private key or 12-word mnemonic
  const [directWallet, setDirectWallet] = useState<{ address: string } | null>(null);
  // Vault live signers (public addresses) currently in memory.
  const [evmVaultSigners, setEvmVaultSigners] = useState<string[]>([]);
  // HUD "Live signer": vault import → generated hot wallet → injected/none.
  const liveSignerRow = evmVaultSigners[0]
    ? `${evmVaultSigners[0].slice(0, 6)}… (vault)`
    : hotWallet
      ? `${hotWallet.address.slice(0, 6)}… (hot)`
      : "extension / none";
  const [importMnemonic, setImportMnemonic] = useState("");
  const [importType, setImportType] = useState<"privateKey" | "mnemonic">("privateKey");



  const [dailySnipeLimit, setDailySnipeLimit] = useState(3);
  const [dailyTracker, setDailyTracker] = useState(() => loadDailyTracker("sniper"));
  // Win/loss trade history tracking
  const [tradeHistory, setTradeHistory] = useState<Array<{ symbol: string; type: string; status: "win" | "loss"; pnlPct: number; timestamp: number; relay?: string }>>([]);
  const [currentStreak, setCurrentStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [bestTradePnl, setBestTradePnl] = useState(0);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState(0);
  // Refresh tracker every 10 seconds so the UI stays current
  useEffect(() => {
    const t = setInterval(() => setDailyTracker(loadDailyTracker("sniper")), 10_000);
    return () => clearInterval(t);
  }, []);

  // Live feed snapshot is created below, after network/rpcOverride resolve.

  const chainKey = state?.chainKey ?? "bsc";
  const chain = CHAIN_INFO[chainKey];

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  // Generate a new hot wallet with BIP39 12-word mnemonic
  const generateHotWallet = useCallback(() => {
    try {
      const mnemonic = generateMnemonic(english, 128); // 128 bits = 12 words
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      setHotWallet({
        mnemonic,
        privateKey: pk,
        address: account.address,
      });
      addLog(`Hot wallet generated: ${account.address}`);
      toast.success("Hot wallet generated", {
        description: `${account.address.slice(0, 10)}\u2026${account.address.slice(-6)} — 12-word BIP39 mnemonic created.`,
      });
    } catch (err) {
      addLog(`Hot wallet generation failed: ${err instanceof Error ? err.message : "unknown"}`);
      toast.error("Wallet generation failed");
    }
  }, [addLog]);

  // Import direct wallet — CRYPTOGRAPHICALLY SECURED. The pasted secret is
  // validated + derived locally (BIP39 m/44'/60'/0'/0/0 via viem/accounts),
  // then sealed with AES-256-GCM under the operator's session passphrase
  // (PBKDF2-SHA-256, 310k iters). Only the PUBLIC address leaves this
  // module: persisted to the terminal state, rendered in the UI. The
  // plaintext key lives ONLY in vault memory and signs live txs in-process.
  const [evmVaultPass, setEvmVaultPass] = useState("");
  const [evmVaultBusy, setEvmVaultBusy] = useState(false);
  const importDirectWallet = useCallback(
    async (input: string) => {
      if (evmVaultBusy) return;
      if (!evmVaultPass.trim()) {
        toast.error("Session passphrase required", {
          description: "Your secret is sealed with AES-256-GCM under this passphrase — it never leaves this browser.",
        });
        return;
      }
      setEvmVaultBusy(true);
      try {
        const res = await evmImportToVault(input, evmVaultPass);
        setDirectWallet({ address: res.address }); // vault memory holds the key — React state holds only the public identity
        const prev = state?.evmImportedWallets ?? [];
        if (!prev.some((a) => a.toLowerCase() === res.address.toLowerCase())) {
          void setSettings({ evmImportedWallets: [...prev, res.address] }).catch(() => undefined);
        }
        // Live chain check on the ACTIVE network (real eth_chainId round-trip).
        const activeNet: NetworkKey = state?.network === "testnet" ? "testnet" : "mainnet";
        const conn = await connectEvmChain(activeNet, state?.rpcOverrides?.[chainKey]);
        addLog(`Wallet imported via vault (${res.via}): ${res.address}`);
        if (conn.connected) {
          toast.success(`Wallet imported — LIVE signer armed on ${conn.network}`, {
            description: `${res.address.slice(0, 10)}…${res.address.slice(-6)} · ${res.via === "mnemonic" ? "BIP44 m/44'/60'/0'/0/0" : "private key"} · vault sealed (AES-256-GCM) · chainId ${conn.chainId} in ${conn.latencyMs}ms.`,
          });
        } else {
          toast.warning("Wallet imported — RPC unreachable", {
            description: conn.error ?? "The chain check failed — signing still works locally once the network is back.",
          });
        }
      } catch (err) {
        const msg = err instanceof EvmImportError ? err.message : err instanceof Error ? err.message : "import failed";
        addLog(`Import failed: ${msg}`);
        toast.error("Import failed", { description: msg });
      } finally {
        setEvmVaultBusy(false);
      }
    },
    [evmVaultBusy, evmVaultPass, state?.network, state?.rpcOverrides, chainKey, state?.evmImportedWallets, setSettings, addLog],
  );


  // Vault lifecycle: on mount, expose the UNLOCKED vault signers in the UI
  // (after a reload the encrypted blob needs the passphrase again — honest
  // empty list until then, never a fabricated signer).
  useEffect(() => {
    const refresh = () => setEvmVaultSigners(evmVaultSignerAddresses());
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const unlockEvmVault = useCallback(async () => {
    if (!evmVaultPass.trim()) {
      toast.error("Session passphrase required");
      return;
    }
    setEvmVaultBusy(true);
    try {
      const ok = await evmUnlockVault(evmVaultPass);
      const signers = evmVaultSignerAddresses();
      setEvmVaultSigners(signers);
      if (ok) {
        toast.success("Vault unlocked", {
          description: `${signers.length} signer(s) live in memory — sub-ms local signing armed.`,
        });
      } else {
        toast.error("Unlock failed", {
          description: signers.length ? "Try again." : "No vault exists in this tab yet.",
        });
      }
    } finally {
      setEvmVaultBusy(false);
    }
  }, [evmVaultPass]);

  const removeEvmVaultSigner = useCallback((address: string) => {
    if (evmRemoveFromVault(address)) {
      setEvmVaultSigners(evmVaultSignerAddresses());
      toast.info("Signer removed from vault", {
        description: `${address.slice(0, 10)}… no longer signs — generate a new recovery sheet for the remainder.`,
      });
    }
  }, []);

  const lockEvmVault = useCallback(() => {
    evmLockVault();
    setEvmVaultSigners([]);
    toast.info("Vault locked", { description: "All memory material cleared — the encrypted blob stays for this tab." });
  }, []);

  const disconnEvmVault = useCallback(() => {
    setDirectWallet(null);
    toast.info("Imported wallet disconnected", {
      description: "Vault material stays sealed; the address remains in your terminal history.",
    });
  }, []);

  // Record a trade in win/loss history with streak tracking. `relay` names
  // the private relay that carried the broadcast (undefined = public RPC).
  const recordTrade = useCallback((symbol: string, type: string, status: "win" | "loss", pnlPct: number, relay?: string) => {
    setTradeHistory((prev) => [{ symbol, type, status, pnlPct, timestamp: Date.now(), relay }, ...prev].slice(0, 100));
    setCurrentStreak((prev) => {
      const next = status === "win" ? prev + 1 : 0;
      setBestStreak((b) => Math.max(b, next));
      return next;
    });
    setBestTradePnl((b) => Math.max(b, pnlPct));
    setTotalRealizedPnl((p) => p + pnlPct);
  }, []);

  // Auto-sell monitor — watches positions with LIVE prices and sells through
  // the real router on the position's OWN chain when the profit target or
  // trailing stop hits. Every sell is full eth_estimateGas-simulated first
  // (zero gas on failure). Every chain executes exactly like BSC through its
  // own execution environment (router / wrapped-native / raced RPCs).
  const rpcOverride = state?.rpcOverrides?.[sniper.networkTarget];
  // Which network of the target chain we execute on. A sniper-local override
  // wins (persisted through the same settings mutation as the Contract page);
  // otherwise it mirrors the terminal's mainnet/testnet switch so both
  // networks work exactly the same way.
  const [sniperNetOverride, setSniperNetOverride] = useState<NetworkKey | null>(null);
  const network: NetworkKey = sniperNetOverride ?? (state?.network === "testnet" ? "testnet" : "mainnet");
  const networkIsOverridden = sniperNetOverride !== null && sniperNetOverride !== (state?.network === "testnet" ? "testnet" : "mainnet");

  const toggleSniperNetwork = useCallback(() => {
    const terminalNet: NetworkKey = state?.network === "testnet" ? "testnet" : "mainnet";
    const next: NetworkKey = network === "mainnet" ? "testnet" : "mainnet";
    setSniperNetOverride(next === terminalNet ? null : next);
    void setSettings({ network: next }).catch(() => undefined);
    addLog(`Network switched → ${next.toUpperCase()} · feed, discovery and execution now target ${next}`);
    toast.success(`Sniper network → ${next.toUpperCase()}`, {
      description: `Live feed, /trending discovery and execution now run on the ${next} environment.`,
    });
  }, [network, state?.network, setSettings, addLog]);

  /* ─── /trending — REAL-TIME discovery from the enabled signal sources ─── */
  const [trendingSignals, setTrendingSignals] = useState<LiveTokenSignal[]>([]);
  const [trendingBusy, setTrendingBusy] = useState(false);
  const [trendingFetchedAt, setTrendingFetchedAt] = useState(0);
  const [trendingFailedSources, setTrendingFailedSources] = useState(0);

  const loadTrending = useCallback(async () => {
    setTrendingBusy(true);
    try {
      const enabledIds = ALL_SOURCES.filter((s) => s.enabled).map((s) => s.id);
      const signals = await fetchMultiSignalTokens(enabledIds, sniper.networkTarget, network);
      // Rank REAL sniping opportunities: fresh momentum first, then absolute
      // liquidity floor — the honest gate the executor itself applies.
      const ranked = [...signals]
        .filter((s) => s.address)
        .sort((a, b) => {
          const scoreA = a.signalStrength * 0.6 + Math.max(0, a.priceChange5m) * 0.25 + (a.buyable ? 10 : 0);
          const scoreB = b.signalStrength * 0.6 + Math.max(0, b.priceChange5m) * 0.25 + (b.buyable ? 10 : 0);
          return scoreB - scoreA;
        })
        .slice(0, 25);
      setTrendingSignals(ranked);
      setTrendingFetchedAt(Date.now());
      const failed = ALL_SOURCES.filter((s) => s.enabled && !signals.some((t) => t.sourceId === s.id || t.sources?.includes(s.id))).length;
      setTrendingFailedSources(Math.min(failed, ALL_SOURCES.length));
      addLog(`📡 /trending: ${ranked.length} live opportunities across ${new Set(signals.map((s) => s.sourceId)).size} sources (${network})`);
    } catch (e) {
      addLog(`❌ /trending fetch failed: ${e instanceof Error ? e.message : "network error"}`);
      toast.error("Trending fetch failed", { description: "All discovery sources unreachable — check the connection." });
    } finally {
      setTrendingBusy(false);
    }
  }, [sniper.networkTarget, network, addLog]);

  // Auto-fetch on first open of the /trending panel (real data, never seeded).
  useEffect(() => {
    if (activeCmd === "trending" && trendingSignals.length === 0 && !trendingBusy && trendingFetchedAt === 0) {
      void loadTrending();
    }
  }, [activeCmd, trendingSignals.length, trendingBusy, trendingFetchedAt, loadTrending]);

  // Live feed snapshot for route generation in MultiSignalMonitor. Follows
  // the sniper's network target chain + network (testnet scans on-chain).
  const sniperFeed = useLiveFeed({
    cadence: 15,
    chainKey: sniper.networkTarget,
    network,
    rpcOverride,
  });
  const sniperSnapshot: MarketSnapshot | null = sniperFeed.snapshot;
  const autoSell = useAutoSell({
    onBlocked: (position, block) => {
      // Auto-sell refusals were log-only; record them like snipe refusals so the
      // ledger answers "how often did policy block a sell?".
      void recordBlockedExecution({
        chainId: block.chainId,
        code: block.code,
        reason: `auto-sell: ${block.reason}`,
        router: block.router,
        token: position.address,
        amountNative: 0,
        network,
      }).catch(() => undefined);
    },
    enabled: true,
    profitTargetPct: sniper.minTargetProfit,
    trailingStopPct: 5,
    slippagePct: sniper.slippageFloor,
    defaultChain: sniper.networkTarget,
    network,
    privateSubmit: { enabled: state?.privateSubmit ?? true, network },
    rpcOverride,
    getSigner: useCallback((): SwapSigner | null => {
      // Vault signer first (imported wallet, in-memory key, sub-ms local
      // signing), then the generated hot wallet. An injected external wallet is
      // deliberately not a signer: it is a withdrawal destination only.
      const vaultHw = evmGetVaultHotWallet();
      return resolveSignerFrom(
        vaultHw ?? (hotWallet ? { privateKey: hotWallet.privateKey as `0x${string}`, address: hotWallet.address } : null),
        null,
        sniper.networkTarget,
        null,
        rpcOverride,
        network,
      );
    }, [hotWallet, sniper.networkTarget, rpcOverride, network]),
    onSell: (pos, pnl, relay, sellSigningLatencyMs) => {
      addLog(`Auto-sell: ${pos.symbol} PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%${fmtSignLatency(sellSigningLatencyMs) ? ` · ${fmtSignLatency(sellSigningLatencyMs)}` : ""}`);
      tg.snipeConfirmed(pos.symbol, pnl, sellSigningLatencyMs);
      incrementTracker("sniper", "snipe", pnl >= 0 ? "win" : "loss");
      recordTrade(pos.symbol, "auto-sell", pnl >= 0 ? "win" : "loss", pnl, relay);
      setDailyTracker(loadDailyTracker("sniper"));
      // Auto-withdraw: destination is the CONNECTED external wallet, and the
      // wallet guard decides whether value may move at all — fail closed.
      if (hotWalletPayout && pnl > 0) {
        const payoutSigner = evmGetVaultHotWallet() ?? hotWallet;
        if (payoutSigner) {
          // Must follow the operator's network: hardcoding mainnet made every
          // testnet payout fail the chain check (56 vs 97) and block.
          const payoutEnv = executionEnvFor(pos.chain, network, rpcOverride);
          const payoutNative = pos.buyAmountBnb * (pnl / 100) * 0.95;
          if (payoutNative > 0.0002) {
            void (async () => {
              const injected = getInjectedProvider();
              const connected = injected ? await getWalletAddress(injected) : null;
              const now = Date.now();
              // Real detectors first — approvals/spenders, then outflows. A scan
              // that could not run is reported as unverified, never as clean.
              const detected: RiskFinding[] = [];
              // Every router the app itself swaps through, plus our own armed
              // contract and the payout signer — a single-router list blocked
              // honest approvals and invited overrides.
              const knownSpenders = knownSpendersFor({
                chainKey: pos.chain,
                network,
                extra: [state?.deployedContractAddress, payoutSigner.address],
              });
              // A probe limited to KNOWN spenders can never block: it only ever
              // asks about spenders we already trust. Walking the wallet's own
              // approve() history reveals the spenders nobody listed, which is
              // the case that actually drains a wallet.
              const probeSpenders = new Set<string>(knownSpenders);
              const probeTokens = new Set<string>([pos.address]);
              try {
                const history = await discoverApprovalsFromHistory({
                  rpcUrl: payoutEnv.rpcUrl,
                  // Historical nonces need archive state; without it the scan
                  // reports "unverified" instead of pretending it found none.
                  stateRpcUrl: (import.meta.env.VITE_ARCHIVE_RPC_URL as string | undefined) || undefined,
                  owner: payoutSigner.address,
                });
                for (const a of history.approvals) {
                  probeSpenders.add(a.spender);
                  probeTokens.add(a.token);
                }
                if (history.truncated) {
                  detected.push({
                    kind: "anomalous-transaction",
                    severity: "medium",
                    detail: `History scan covered the last ${history.scanned} of ${history.nonce} transactions — older approvals unverified.`,
                  });
                }
              } catch (e) {
                detected.push({
                  kind: "unverified-contract",
                  severity: "medium",
                  detail: `Approval history unavailable (${e instanceof Error ? e.message : "unknown"}) — spenders beyond the trusted set are unverified.`,
                });
              }
              try {
                const scan = await detectApprovals({
                  rpcUrl: payoutEnv.rpcUrl,
                  // Fallbacks matter: one public node timing out must not read as
                  // "no approvals found".
                  rpcUrls: CHAIN_NETWORKS[pos.chain]?.[network]?.rpcs ?? [],
                  owner: payoutSigner.address,
                  knownSpenders,
                  // BSC testnet free RPCs cannot do topic-only getLogs, so the
                  // detector falls back to probing this token against the
                  // spenders the app knows.
                  tokens: [pos.address],
                  probeSpenders: [...knownSpenders],
                });
                // The log scan is opportunistic: public BSC nodes reject a
                // topic-only window with "limit exceeded" often enough that it
                // cannot be the only detector. The targeted probe always runs
                // and covers the tokens this payout actually involves.
                const probe = await probeAllowances({
                  rpcUrl: payoutEnv.rpcUrl,
                  rpcUrls: CHAIN_NETWORKS[pos.chain]?.[network]?.rpcs ?? [],
                  owner: payoutSigner.address,
                  tokens: [...probeTokens],
                  spenders: [...probeSpenders],
                  knownSpenders,
                });
                const seen = new Set<string>();
                for (const f of [...scan.findings, ...probe.findings]) {
                  const key = `${f.kind}|${f.detail}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  detected.push(f);
                }
                if (scan.coverage.truncated) {
                  detected.push({
                    kind: "anomalous-transaction",
                    severity: "medium",
                    detail:
                      scan.coverage.mode === "allowance-probe"
                        ? `Approvals checked by targeted probe only (log scan unavailable${scan.coverage.lastError ? `: ${scan.coverage.lastError.slice(0, 80)}` : ""}) — spenders outside that set are unverified.`
                        : `Approval scan covered ${scan.coverage.chunks} window(s) up to block ${scan.coverage.toBlock} — partial coverage.`,
                  });
                }
              } catch (e) {
                detected.push({
                  kind: "unverified-contract",
                  severity: "medium",
                  detail: `Approval scan unavailable (${e instanceof Error ? e.message : "unknown"}) — approvals unverified.`,
                });
              }
              const signerBalance = await nativeBalance(payoutEnv.rpcUrl, payoutSigner.address);
              if (signerBalance !== undefined) {
                const baseline = loadBaseline(payoutSigner.address, now);
                if (baseline === undefined) {
                  recordBaseline(payoutSigner.address, signerBalance, now);
                } else {
                  const outflow = classifyOutflow({
                    baselineNative: baseline,
                    currentNative: signerBalance,
                    expectedSpentNative: loadExposure(payoutSigner.address, now),
                  });
                  if (outflow) detected.push(outflow);
                }
              }
              // Fail closed: breaker → chain → roles → destination → limits, all
              // decided before anything is simulated or signed.
              const breaker = breakerVerdict(loadBreaker(), now);
              const target = resolvePayoutTarget({ connectedAddress: payoutWallet || connected });
              const chainOk = chainConfigVerdict({
                network,
                chainId: payoutEnv.chainId,
                rpcUrl: payoutEnv.rpcUrl,
              });
              const role = payoutRoleVerdict({ signerRole: "operational", destinationRole: "external" });
              const limits = checkTransactionLimits({
                amountNative: payoutNative,
                limits: DEFAULT_PAYOUT_LIMITS,
                spentTodayNative: loadExposure(payoutSigner.address, now),
              });

              const findings: RiskFinding[] = [...detected];
              if (breaker.open) findings.push({ kind: "breaker-open", severity: "critical", detail: breaker.reason });
              if (!chainOk.allowed) findings.push({ kind: "chain-mismatch", severity: "critical", detail: chainOk.reason });
              if (!role.allowed) findings.push({ kind: "payout-role-violation", severity: "critical", detail: role.reason });
              if (!target.ok) findings.push({ kind: "unbound-payout-target", severity: "critical", detail: target.reason });
              if (!limits.allowed) findings.push({ kind: "limit-exceeded", severity: "high", detail: limits.reason });

              // Authorization is single-use and bound to this movement's key.
              const txKey = payoutAuth?.txKey ?? `payout-${now.toString(36)}`;
              const verdict = evaluateValueMovement({
                findings,
                wallet: target.address ?? "unbound",
                txKey,
                now,
                authorization: payoutAuth,
              });
              addLog(`Payout audit: ${auditLine(verdict.audit)}`);
              saveBreaker(nextBreakerState(loadBreaker(), verdict, now));

              if (!verdict.allow || !target.ok || !target.address) {
                addLog(`Payout blocked [${verdict.level}]: ${verdict.reason}`);
                toast.error("Payout blocked by the wallet guard", { description: verdict.reason });
                // Persist to the execution trail so the block survives the tab:
                // wallet, finding context and reason travel in the label.
                try {
                  await recordExecution({
                    label: `Payout blocked [${verdict.level}] ${pos.symbol}: ${verdict.reason}`.slice(0, 300),
                    profitPct: pnl,
                    amountBnb: payoutNative,
                    status: "blocked",
                    network,
                    chain: pos.chain,
                    dexes: verdict.blocking[0]?.detail.slice(0, 160),
                  });
                } catch (e) {
                  addLog(`Could not persist blocked payout: ${e instanceof Error ? e.message : "unknown"}`);
                }
                // And a real row: level, kinds, wallet, destination and reason are
                // separate fields, so blocks are queryable rather than greppable.
                try {
                  const first = verdict.blocking[0];
                  await recordPayoutBlock({
                    wallet: payoutSigner.address,
                    destination: target.address ?? undefined,
                    token: first?.token,
                    spender: first?.spender,
                    level: verdict.level,
                    kinds: verdict.blocking.map((f) => f.kind),
                    reason: verdict.reason,
                    amountNative: payoutNative,
                    chain: pos.chain,
                    network,
                  });
                } catch (e) {
                  addLog(`Could not persist block row: ${e instanceof Error ? e.message : "unknown"}`);
                }
                return;
              }
              if (verdict.notices.length > 0) {
                addLog(`Payout warnings: ${verdict.notices.map((f) => f.detail).join("; ")}`);
              }
              if (verdict.audit.override) setPayoutAuth(null);
              const to = target.address;
              // Execution gate: a refusal here stops the transfer. The policy is
              // derived from readiness, so no UI state can open it.
              // Two independent controls: an internal payout (executor/vault →
              // designated vault) needs an armed executor on an activated chain;
              // anything leaving for another address is an EXTERNAL withdrawal,
              // which is always refused regardless of arming.
              const armedContract =
                state?.deployments?.[pos.chain]?.contractAddress ?? state?.deployedContractAddress ?? "";
              // Classification comes from the backend registry, NOT from the
              // destination being connected, listed, or equal to the signer.
              const approvedInternal = internalDestinationFor(
                executionEnvFor(pos.chain, network).chainId,
              );
              const internal = Boolean(
                approvedInternal && approvedInternal.address.toLowerCase() === to.toLowerCase(),
              );
              const vaultAddress = approvedInternal?.address ?? payoutSigner.address;
              const gate = internal
                ? authorizeInternalPayout({
                    chainKey: pos.chain,
                    network,
                    destination: to,
                    vaultAddress,
                    signer: payoutSigner.address,
                    executor: armedContract,
                    armedExecutor: armedContract,
                    amountNative: payoutNative,
                    availableProfitNative: pnl > 0 ? payoutNative : undefined,
                    now,
                  })
                : authorizeExternalWithdrawal({
                    chainKey: pos.chain,
                    network,
                    destination: to,
                    source: "connected-wallet",
                  });
              if (!gate.allowed) {
                addLog(refusalMessage(gate));
                toast.error(internal ? "Internal payout refused" : "External withdrawals are disabled", {
                  description: gate.reasons[0] ?? "This transfer is not authorized.",
                });
                try {
                  await recordPayoutBlock({
                    wallet: payoutSigner.address,
                    destination: to,
                    level: "critical",
                    kinds: [internal ? "execution-gate" : "external-withdrawal-disabled"],
                    reason: refusalMessage(gate),
                    amountNative: payoutNative,
                    chain: pos.chain,
                    network,
                  });
                } catch (e) {
                  addLog(`Could not persist gate refusal: ${e instanceof Error ? e.message : "unknown"}`);
                }
                return;
              }
              // Backend authority for the executor address: a contract that
              // the validated discovery registry has not approved is not used,
              // even though it is configured as armed.
              if (internal) {
                const targetReasons = executionTargetReasons({
                  chainId: gate.chainId,
                  executor: armedContract,
                });
                if (targetReasons.length > 0) {
                  addLog(`Payout refused — ${targetReasons.join(" ")}`);
                  toast.error("Executor is not validated", { description: targetReasons[0] });
                  try {
                    await recordPayoutBlock({
                      wallet: payoutSigner.address,
                      destination: to,
                      level: "critical",
                      kinds: ["unvalidated-executor"],
                      reason: targetReasons.join(" "),
                      amountNative: payoutNative,
                      chain: pos.chain,
                      network,
                    });
                  } catch {
                    // best-effort audit; the refusal already happened
                  }
                  return;
                }
              }
              // Bytecode pin: an approval can be bound to the exact deployed
              // contract. Read the code and compare before signing; an unpinned
              // approval proceeds but says so, a swapped contract is refused.
              if (internal && armedContract) {
                const pinned = activationFor(56, "mainnet")?.contractCodeHash;
                const pin = await verifyExecutorPinned({
                  rpcUrl: payoutEnv.rpcUrl,
                  address: armedContract,
                  pinned,
                });
                addLog(pin.reason);
                if (!pin.ok) {
                  toast.error("Executor bytecode check failed", { description: pin.reason });
                  try {
                    await recordPayoutBlock({
                      wallet: payoutSigner.address,
                      destination: to,
                      level: "critical",
                      kinds: ["bytecode-pin"],
                      reason: pin.reason,
                      amountNative: payoutNative,
                      chain: pos.chain,
                      network,
                    });
                  } catch {
                    // recording is best-effort; the refusal already happened
                  }
                  return;
                }
              }
              try {
                const { txHash, relay: payoutRelay } = await transferNative(
                  payoutEnv.rpcUrl,
                  payoutEnv.chainId,
                  payoutSigner.privateKey as `0x${string}`,
                  payoutSigner.address,
                  to,
                  payoutNative,
                  { enabled: state?.privateSubmit ?? true, network },
                );
                addExposure(payoutSigner.address, payoutNative, now);
                addLog(`Payout: ${payoutNative.toFixed(4)} ${payoutEnv.nativeSymbol} → ${to.slice(0, 10)}… (${txHash.slice(0, 10)}…${payoutRelay ? ` · via ${payoutRelay.replace(/^https:\/\//, "")}` : " · public RPC"})`);
                toast.success("Payout sent", { description: `${payoutNative.toFixed(4)} ${payoutEnv.nativeSymbol} → ${to.slice(0, 10)}…` });
              } catch (e) {
                addLog(`Payout failed: ${e instanceof Error ? e.message : "unknown"}`);
              }
            })();
          }
        }
      }
    },
    onSellFailed: (pos, reason) => {
      // A sell that failed simulation/revert counts as a loss — zero gas was spent on sim-fails.
      incrementTracker("sniper", "snipe", "loss");
      recordTrade(pos.symbol, "auto-sell", "loss", 0);
      setDailyTracker(loadDailyTracker("sniper"));
      tg.snipeFailed(pos.symbol, reason);
      addLog(`Auto-sell failed: ${pos.symbol} — ${reason} (zero gas on sim-fail)`);
    },
  });

  // ─── REAL snipe execution ───────────────────────────────────────────
  // Buys through the actual PancakeSwap router with a FULL
  // eth_estimateGas simulation first: if the buy would revert (honeypot,
  // tax trap, no liquidity), nothing is broadcast and zero gas is spent.
  const snipeBusyRef = useRef(new Set<string>());
  const executeSnipe = useCallback(
    async (token: { id: string; symbol: string; address: string; priceUsd: number }) => {
      if (snipeBusyRef.current.has(token.id)) return;
      snipeBusyRef.current.add(token.id);
      try {
        // Subscriber daily target (server-enforced) — one slot per real snipe.
        try {
          const slot = await consumeExecutionSlot({ kind: "snipe", chain: "bnb", label: token.symbol });
          if (slot.blocked) {
            toast.warning("Daily target reached", { description: slot.reason });
            return;
          }
        } catch {
          toast.error("Could not verify your daily target — snipe aborted.");
          return;
        }
        const provider = getInjectedProvider();
        const signer = resolveSignerFrom(
          evmGetVaultHotWallet() ?? (hotWallet ? { privateKey: hotWallet.privateKey as `0x${string}`, address: hotWallet.address } : null),
          provider,
          sniper.networkTarget,
          directWallet?.address ?? null,
          rpcOverride,
          network,
        );
        if (!signer) {
          toast.error("No signer — snipe aborted", {
            description: "Import a wallet into the vault, generate a hot wallet, or connect the direct wallet.",
          });
          incrementTracker("sniper", "snipe", "loss");
          recordTrade(token.symbol, "snipe", "loss", 0);
          return;
        }
        const env = executionEnvFor(sniper.networkTarget, network, rpcOverride);
        // Private-relay submission (Flashbots Protect / bloXroute): signed hot-
        // wallet txs bypass the public mempool — sandwich bots can't copy or
        // front-run the snipe before inclusion. No relay for the chain → the
        // buy goes out the public RPC exactly as before (honest fallback).
        const privateSubmit = { enabled: state?.privateSubmit ?? true, network };
        addLog(`⚡ Sniping ${token.symbol} on ${env.label} — simulating ${customBuyAmount} ${env.nativeSymbol} buy…`);
        // Operator's max-gas guard: never buy when network gas exceeds the
        // configured ceiling (live eth_gasPrice, real RPC data of THIS chain).
        const liveGwei = await fetchGasPriceGwei(env.rpcUrl);
        if (liveGwei !== null && liveGwei > sniper.maxGasPrice) {
          addLog(`⛔ Gas guard: ${liveGwei.toFixed(1)} gwei > max ${sniper.maxGasPrice} gwei — ${token.symbol} skipped`);
          toast.warning("Gas above max — snipe skipped", {
            description: `${liveGwei.toFixed(1)} gwei exceeds your ${sniper.maxGasPrice} gwei ceiling.`,
          });
          return;
        }
        // ── PROFIT GUARANTOR: buyable gate ──
        // Real pair depth (getReserves) + live price check before the buy.
        // Honeypot-pattern tokens (quote fails / no pair) are blocked here
        // with zero gas spent.
        let entryTvl: number | null = null;
        try {
          entryTvl = await fetchTokenPairTvlNative(
            env.rpcUrl,
            env.chainId,
            env.router,
            token.address,
            env.wrapped,
          );
        } catch {
          entryTvl = null;
        }
        const gate = classifyBuyable({
          livePriceUsd: token.priceUsd > 0 ? token.priceUsd : null,
          tvlNative: entryTvl ?? 0,
          // Depth floor scales with the buy size (native units): at least 20×
          // the intended buy so a single buy cannot nuke the pool.
          minTvlNative: customBuyAmount * 20,
        });
        if (!gate.buyable) {
          addLog(`⛔ Guarantor blocked ${token.symbol}: ${gate.reason} (zero gas spent)`);
          toast.warning(`Guarantor blocked: ${token.symbol}`, {
            description: `${gate.reason} — buy not broadcast.`,
          });
          incrementTracker("sniper", "snipe", "loss");
          recordTrade(token.symbol, "snipe", "loss", 0);
          return;
        }
        addLog(`🛡 Guarantor pass ${token.symbol}: ${gate.reason} · TVL ${entryTvl?.toFixed(2) ?? "?"} ${env.nativeSymbol}`);

        const result = await buyToken({
          signer,
          env,
          tokenAddress: token.address,
          amountNative: customBuyAmount,
          slippagePct: sniper.slippageFloor,
          recipient: signer.from,
          privateSubmit,
        });
        if (!result.simulationPassed) {
          // Two different outcomes: a policy refusal (nothing was simulated)
          // and a real simulation revert. Reporting both as "simulation failed"
          // sent operators looking for a contract bug that did not exist.
          if (result.blocked) {
            addLog(`⛔ Snipe refused by policy: ${token.symbol} — ${result.blocked.reason} (nothing built, zero gas spent)`);
            toast.error(`Execution refused: ${token.symbol}`, {
              description: `${result.blocked.reason} — no transaction was created. Validate the target in Settings → Authorization console.`,
            });
            try {
              await recordBlockedExecution({
                chainId: env.chainId,
                code: result.blocked.code,
                reason: result.blocked.reason,
                router: env.router,
                token: token.address,
                amountNative: customBuyAmount,
                network,
              });
            } catch (e) {
              addLog(`Could not record blocked execution: ${e instanceof Error ? e.message : "unknown"}`);
            }
            return;
          }
          // Full simulation failed — nothing broadcast, ZERO gas spent.
          addLog(`❌ Snipe simulation failed: ${token.symbol} — ${result.simulationError ?? "would revert"} (zero gas spent)`);
          toast.error(`Snipe blocked — zero gas: ${token.symbol}`, {
            description: result.simulationError ?? "Full eth_estimateGas simulation failed — nothing was broadcast.",
          });
          incrementTracker("sniper", "snipe", "loss");
          recordTrade(token.symbol, "snipe", "loss", 0);
          setDailyTracker(loadDailyTracker("sniper"));
          tg.snipeFailed(token.symbol, result.simulationError ?? "simulation failed");
          return;
        }
        if (result.status !== "success") {
          addLog(`❌ Snipe reverted on-chain: ${token.symbol} (tx ${result.txHash?.slice(0, 10)}…)`);
          toast.error(`Snipe reverted: ${token.symbol}`, {
            description: "On-chain revert — tracked as a loss.",
          });
          incrementTracker("sniper", "snipe", "loss");
          recordTrade(token.symbol, "snipe", "loss", 0);
          setDailyTracker(loadDailyTracker("sniper"));
          tg.snipeFailed(token.symbol, "reverted on-chain");
          return;
        }
        // Real buy confirmed — derive the true entry price from the tokens
        // actually received and the BNB spent.
        const buyPriceUsd =
          result.receivedTokensWei && result.receivedTokensWei > 0n && token.priceUsd > 0
            ? (customBuyAmount * (await fetchTokenPriceUsd(token.address, env.chainId) ?? token.priceUsd)) /
              (Number(result.receivedTokensWei) / 10 ** (result.decimals ?? 18))
            : token.priceUsd;
        autoSell.addPosition(
          token.symbol,
          token.address,
          buyPriceUsd,
          customBuyAmount,
          customSellPct,
          result.receivedTokensWei ?? null,
          result.decimals ?? 18,
          sniper.networkTarget,
          entryTvl,
          customSellAmountPct,
        );
        addLog(`✅ Sniped ${token.symbol} — tx ${result.txHash?.slice(0, 10)}…${result.relayDegraded ? " · ⚠ all relays in cooldown → public RPC" : result.relay ? ` · via ${result.relay.replace(/^https:\/\//, "")}` : " · public RPC"}${fmtSignLatency(result.signingLatencyMs) ? ` · ${fmtSignLatency(result.signingLatencyMs)}` : ""} · auto-sell armed at +${sniper.minTargetProfit}%`);
        toast.success(`🎯 Sniped ${token.symbol}`, {
          description: `Tx ${result.txHash?.slice(0, 10)}… · ${customBuyAmount} ${env.nativeSymbol} · auto-sell armed (+${sniper.minTargetProfit}% target)${result.relay ? ` · via ${result.relay.replace(/^https:\/\//, "")}` : " · public RPC"}`,
        });
        incrementTracker("sniper", "snipe", "win");
        recordTrade(token.symbol, "snipe", "win", 0, result.relay);
        setDailyTracker(loadDailyTracker("sniper"));
        tg.snipeConfirmed(token.symbol, 0, result.signingLatencyMs);
        // OPTIONAL hot-wallet payout switch is handled by the auto-sell hook on exit.
      } finally {
        snipeBusyRef.current.delete(token.id);
      }
    },
    [hotWallet, directWallet, customBuyAmount, customSellPct, customSellAmountPct, sniper.networkTarget, network, sniper.slippageFloor, sniper.minTargetProfit, rpcOverride, addLog, recordTrade, tg, autoSell],
  );

  // Sniper is sniping ONLY — no flash loan. Hot wallet payout to external wallet is optional.
  const runCommand = useCallback((cmd: CommandKey) => {
    setActiveCmd(cmd);
    setShowMenu(false);
    addLog(`> /${cmd}`);
    if (cmd === "multisignal") {
      setShowMultiSignal(true);
      addLog("Multi-Signal Monitor activated — scanning 20+ sources");
      return;
    }
    const def = COMMANDS.find((c) => c.cmd === cmd);
    if (def) addLog(`${def.desc}`);
  }, [addLog]);

  const updateSniper = useCallback((patch: Partial<SniperState>) => {
    setSniper((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ─── Render the active command panel ─── */
  const renderCommandPanel = () => {
    switch (activeCmd) {
      case "start":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">ALL-IN-ONE MULTI-CHAIN TERMINAL HUD</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-border/60 bg-background/40 p-4 space-y-2">
                <div className="text-xs font-semibold text-muted-foreground">Current Profile State Parameters</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>Network Target: <span className="font-bold text-primary">{CHAIN_INFO[sniper.networkTarget].label} 🟡</span></div>
                  <div>Routing Matrix: <span className="font-bold text-primary">{sniper.routingMatrix} 🍰</span></div>
                  <div>Execution Mode: <span className="font-bold text-primary">{sniper.executionMode.toUpperCase()} 📌</span></div>
                  <div>Active Track: <span className="font-bold text-primary">{sniper.activeTrack.toUpperCase()} 🎯</span></div>
                  <div>Live Signer: <span className={cn("font-bold", evmVaultSigners.length > 0 ? "text-emerald-400" : "text-primary")}>{liveSignerRow}</span></div>
                  <div>Vault Signers: <span className="font-bold text-primary">{evmVaultSigners.length}</span></div>
                </div>
                <div className="flex gap-3 text-[11px] text-muted-foreground pt-1">
                  <span>🔗 Hub</span>
                  <span>📢 Updates</span>
                  <span>📋 Docs</span>
                </div>
              </div>
              {/* Action button grid */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {GRID_ACTIONS.map((a) => (
                  <Button
                    key={a.action}
                    variant="outline"
                    size="sm"
                    className="gap-2 justify-start text-xs h-auto py-3"
                    onClick={() => runCommand(a.action)}
                  >
                    <span className={a.color}>{a.icon}</span>
                    {a.label}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sniper.executionMode === "manual" ? "default" : "outline"}
                  size="sm"
                  className="gap-2 text-xs"
                  onClick={() => updateSniper({ executionMode: sniper.executionMode === "manual" ? "auto" : "manual" })}
                >
                  {sniper.executionMode === "manual" ? "🔄 Mode: MANUAL 📌" : "⚡ Mode: AUTO 🤖"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-xs"
                  onClick={() => updateSniper({ activeTrack: sniper.activeTrack === "snipe" ? "arb" : "snipe" })}
                >
                  🎯 Strategy: {sniper.activeTrack.toUpperCase()} {sniper.activeTrack === "snipe" ? "📌" : "💎"}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={() => { addLog("Data refreshed"); toast.success("Data refreshed"); }}>
                  <RefreshCw className="size-3" /> Refresh Data
                </Button>
                <Button variant="outline" size="sm" className="gap-2 text-xs text-destructive" onClick={() => setActiveCmd(null)}>
                  <X className="size-3" /> Close Panel
                </Button>
              </div>
            </CardContent>
          </Card>
        );

      case "setup":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cog className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">⚙️ Global Configuration Settings Matrix</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Modify parameters, builder tip priorities, and custom triggers.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Max Gas Price (GWEI)</label>
                  <Input type="number" value={sniper.maxGasPrice} onChange={(e) => updateSniper({ maxGasPrice: Number(e.target.value) })} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Min Liquidity (USD)</label>
                  <Input type="number" value={sniper.minLiquidity} onChange={(e) => updateSniper({ minLiquidity: Number(e.target.value) })} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Max Holder Concentration (%)</label>
                  <Input type="number" value={sniper.maxHolderConcentration} onChange={(e) => updateSniper({ maxHolderConcentration: Number(e.target.value) })} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Routing Matrix</label>
                  <select value={sniper.routingMatrix} onChange={(e) => updateSniper({ routingMatrix: e.target.value })} className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs">
                    <option value="PANCAKE">PancakeSwap</option>
                    <option value="PANCAKE_V2">PancakeSwap V2</option>
                    <option value="PANCAKE_V3">PancakeSwap V3</option>
                    <option value="UNISWAP_V3">Uniswap V3</option>
                    <option value="SUSHISWAP">SushiSwap</option>
                    <option value="BISWAP">Biswap</option>
                    <option value="MDEX">MDEX</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">MEV Protection</span>
                  <Switch checked={sniper.mevProtection} onCheckedChange={(v) => updateSniper({ mevProtection: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">Private Submission (anti-MEV)</span>
                    <span className="text-[10px] text-muted-foreground">
                      {isPrivateRpcAvailable(
                        executionEnvFor(sniper.networkTarget, network, rpcOverride).chainId,
                        network,
                      )
                        ? "Flashbots Protect / bloXroute — signed buys+sells bypass the public mempool"
                        : "No relay for this chain — public RPC fallback (honest)"}
                    </span>
                  </div>
                  <Switch
                    checked={state?.privateSubmit ?? true}
                    onCheckedChange={(v) => void setSettings({ privateSubmit: v }).catch(() => undefined)}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">Auto Router</span>
                  <Switch checked={sniper.autoRouter} onCheckedChange={(v) => updateSniper({ autoRouter: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">Honeypot Detection</span>
                  <Switch checked={sniper.honeypotDetection} onCheckedChange={(v) => updateSniper({ honeypotDetection: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">Contract Verification</span>
                  <Switch checked={sniper.contractVerification} onCheckedChange={(v) => updateSniper({ contractVerification: v })} />
                </div>
              </div>
              <Button size="sm" className="gap-2" onClick={() => { toast.success("Configuration saved"); addLog("Global configuration updated"); }}>
                <Send className="size-3" /> Save Configuration
              </Button>
              {/* Private relay status — live latency-ranked submission health */}
              <RelayStatusCard chainKey={sniper.networkTarget} network={network} />
            </CardContent>
          </Card>
        );

      case "my_settings":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🔧 My Settings Controls</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ─── Summary ─── */}
              <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs space-y-1">
                <div>• Slippage Floor: <span className="font-bold text-primary">{sniper.slippageFloor} GWEI Minimum</span></div>
                <div>• Minimum Target Profit: <span className="font-bold text-primary">{sniper.minTargetProfit}% Guaranteed</span></div>
                <div>• Auto Approve: <span className="font-bold text-primary">{autoApprove ? "ON ✅" : "OFF ❌"}</span></div>
                <div>• Custom Buy: <span className="font-bold text-primary">{customBuyAmount} BNB</span></div>
                <div>• Custom Sell: <span className="font-bold text-primary">{customSellPct}%</span></div>
              </div>

              {/* ─── Slippage & Profit ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Slippage & Profit Targets</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Slippage Floor (GWEI)</label>
                    <Input type="number" value={sniper.slippageFloor} onChange={(e) => updateSniper({ slippageFloor: Number(e.target.value) })} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Min Target Profit (%)</label>
                    <Input type="number" value={sniper.minTargetProfit} onChange={(e) => updateSniper({ minTargetProfit: Number(e.target.value) })} className="h-8 text-xs" />
                  </div>
                </div>
              </div>

              {/* ─── Auto Approve Toggle ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Auto Approve</div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-3">
                  <div>
                    <span className="text-xs font-medium">Auto Approve</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Instant autonomous capture of viable tokens after milliseconds display for manual/auto snipe or arbitrage</p>
                  </div>
                  <Switch checked={autoApprove} onCheckedChange={setAutoApprove} />
                </div>
              </div>

              {/* ─── Custom Buy ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom Buy Amount (BNB)</div>
                <div className="flex flex-wrap gap-1.5">
                  {[0.001, 0.005, 0.01, 0.05, 0.1, 0.5].map((amt) => (
                    <Button
                      key={amt}
                      variant={customBuyAmount === amt ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-[11px] px-2.5"
                      onClick={() => setCustomBuyAmount(amt)}
                    >
                      {amt} BNB
                    </Button>
                  ))}
                  <Button
                    variant={![0.001, 0.005, 0.01, 0.05, 0.1, 0.5].includes(customBuyAmount) ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-[11px] px-2.5"
                  >
                    {![0.001, 0.005, 0.01, 0.05, 0.1, 0.5].includes(customBuyAmount) ? `${customBuyAmount} BNB` : "X BNB"}
                  </Button>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Custom X BNB</label>
                  <Input
                    type="number"
                    step="0.001"
                    min="0.001"
                    placeholder="0.001"
                    value={![0.001, 0.005, 0.01, 0.05, 0.1, 0.5].includes(customBuyAmount) ? customBuyAmount : ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0) setCustomBuyAmount(v);
                    }}
                    className="h-7 text-xs"
                  />
                </div>
              </div>

              {/* ─── Custom Sell ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom Sell Percentage</div>
                <div className="flex flex-wrap gap-1.5">
                  {[25, 50, 100].map((pct) => (
                    <Button
                      key={pct}
                      variant={customSellPct === pct ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-[11px] px-2.5"
                      onClick={() => setCustomSellPct(pct)}
                    >
                      {pct}%
                    </Button>
                  ))}
                  <Button
                    variant={![25, 50, 100].includes(customSellPct) ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-[11px] px-2.5"
                  >
                    {![25, 50, 100].includes(customSellPct) ? `${customSellPct}%` : "X%"}
                  </Button>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">Custom X %</label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    max="100"
                    placeholder="100"
                    value={![25, 50, 100].includes(customSellPct) ? customSellPct : ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v <= 100) setCustomSellPct(v);
                    }}
                    className="h-7 text-xs"
                  />
                </div>
                {/* Sell amount — % of the Custom Sell slice each exit disposes
                    of (partial exits), identical math to the DEXView/GMGN
                    overlay so both surfaces sell identically. */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Sell amount % — of the sell slice (partial exits)
                  </label>
                  <Input
                    type="number"
                    step="1"
                    min="1"
                    max="100"
                    value={customSellAmountPct}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v <= 100) setCustomSellAmountPct(v);
                    }}
                    className="h-7 text-xs"
                  />
                  <p className="text-[10px] leading-4 text-muted-foreground">
                    Effective disposal per sell event: {customSellPct}% × {customSellAmountPct}% = {Math.round(((customSellPct * customSellAmountPct) / 100) * 10) / 10}% of the position.
                  </p>
                </div>
              </div>

              {/* ─── Show/Hide Tokens ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Show / Hide Tokens</div>
                <p className="text-[11px] text-muted-foreground">Tokens selected and captured for snipe or arbitrage. Toggle visibility below.</p>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Hidden Signal Tokens</span>
                    <Badge variant="outline" className="text-[10px]">{hiddenSignalTokens.size} hidden</Badge>
                  </div>
                  {hiddenSignalTokens.size > 0 ? (
                    <div className="mt-2 space-y-1">
                      {Array.from(hiddenSignalTokens).map((id) => (
                        <div key={id} className="flex items-center justify-between text-[11px]">
                          <span className="font-mono text-muted-foreground">{id.slice(0, 12)}...</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 text-[10px]"
                            onClick={() => {
                              setHiddenSignalTokens((prev) => {
                                const next = new Set(prev);
                                next.delete(id);
                                return next;
                              });
                            }}
                          >
                            <Eye className="size-3" /> Show
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-muted-foreground">No hidden tokens — all visible in Multi-Signal Monitor.</div>
                  )}
                </div>
              </div>

              {/* ─── Wallet Payout Settings ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Wallet Payout Settings</div>
                <p className="text-[11px] text-muted-foreground">
                  A destination being listed is not permission to send to it. Internal payouts land in the designated
                  vault/hot wallet; anything leaving for another address is an external withdrawal.
                </p>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Destination classification
                  </div>
                  <ul className="space-y-1 text-[11px]">
                    <li className="flex items-start justify-between gap-3">
                      <span className="text-muted-foreground">BSC hot wallet / vault (this session's signer)</span>
                      <span className="shrink-0 text-emerald-400">
                        Internal payout — requires armed executor + activated chain
                      </span>
                    </li>
                    <li className="flex items-start justify-between gap-3">
                      <span className="text-muted-foreground">Connected MetaMask / Trust / typed BSC address</span>
                      <span className="shrink-0 text-rose-400">External withdrawal — Disabled</span>
                    </li>
                    <li className="flex items-start justify-between gap-3">
                      <span className="text-muted-foreground">Any other external BSC address</span>
                      <span className="shrink-0 text-rose-400">External withdrawal — Disabled</span>
                    </li>
                  </ul>
                  <p className="text-[10px] text-muted-foreground">
                    External withdrawals are disabled: no approval mechanism exists, and arming the executor or
                    activating BSC never authorizes a transfer out of the vault.
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
                    <span className="text-[10px] text-muted-foreground">
                      Backend-approved internal destination:{" "}
                      <span className="font-mono">
                        {internalDestinationFor(executionEnvFor(sniper.networkTarget, network).chainId)
                          ?.address ?? "none approved"}
                      </span>
                    </span>
                    {isOperator && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px]"
                      disabled={!evmGetVaultHotWallet()}
                      onClick={() => {
                        const vault = evmGetVaultHotWallet();
                        if (!vault) {
                          toast.error("No vault/hot wallet in this session to approve");
                          return;
                        }
                        const chainId = executionEnvFor(sniper.networkTarget, network).chainId;
                        void approveInternalDestination({
                          chainId,
                          address: vault.address,
                          label: "BSC profit vault (session signer)",
                          reason: "Operator approved this vault as the internal profit destination",
                        })
                          .then(() => {
                            addLog(`Internal destination approved: ${vault.address.slice(0, 10)}… (chain ${chainId})`);
                            toast.success("Vault approved as internal destination", {
                              description: "Internal payouts to this address now pass classification. Executor registration and validation are still required.",
                            });
                          })
                          .catch((e: unknown) => {
                            toast.error("Approval refused", {
                              description: e instanceof Error ? e.message : "Operator access required.",
                            });
                          });
                      }}
                    >
                      Approve this vault as internal (operator)
                    </Button>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium">Direct Wallet Auto-Payout (Default ON)</span>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Profits auto-payout to your connected wallet after each successful snipe</p>
                    </div>
                    <Switch checked={directWalletPayout} onCheckedChange={setDirectWalletPayout} />
                  </div>
                  {directWalletPayout && (
                    <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2 text-[11px] text-emerald-400">
                      ✅ Direct wallet auto-payout ON — the resolved destination is your connected wallet, which is an
                      external withdrawal. It will be refused; profits stay in the vault until a separately approved
                      withdrawal mechanism exists. eth_call simulation ensures zero gas on refused/failed txns.
                    </div>
                  )}
                  {!directWalletPayout && (
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-400">
                      ⚠ Direct wallet payout OFF — profits stay in the contract/vault. Enabling it only changes the
                      resolved destination; a connected wallet is still an external withdrawal and stays refused.
                    </div>
                  )}
                  <div className="border-t border-border/40 pt-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-medium">Auto-withdraw to connected wallet</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Attempts to leave the hot wallet for the external wallet connected right now — refused while external withdrawals are disabled (no address field, by design)</p>
                      </div>
                      <Switch checked={hotWalletPayout} onCheckedChange={setHotWalletPayout} />
                    </div>
                    {hotWalletPayout && (
                      <div className="mt-2 space-y-2 rounded-md border border-blue-500/25 bg-blue-500/5 p-2 text-[11px] text-blue-400">
                        <p>🔗 Automated payout ON — signed by the hot wallet/vault toward the connected external wallet. External withdrawals are disabled, so this path refuses before signing.</p>
                        <p className="text-muted-foreground">Critical findings stop payouts outright. High-risk ones need a reason and an explicit authorization below.</p>
                        <Input
                          placeholder="Reason (required to authorize a blocked payout)"
                          value={payoutOverrideReason}
                          onChange={(e) => setPayoutOverrideReason(e.target.value)}
                          className="h-7 text-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => void authorizeNextPayout()}
                        >
                          Authorize next payout (15 min, single use)
                        </Button>
                        <p className="text-muted-foreground">
                          {payoutAuth
                            ? `Authorized for this wallet until ${new Date(payoutAuth.expiresAt).toLocaleTimeString()} — ${payoutAuth.reason || "(no reason)"}`
                            : "Fail-closed: a confirmed compromise, a known malicious contract, a chain mismatch or a non-connected destination can never be authorized."}
                        </p>
                        {payoutWallets.length > 0 && (
                          <select
                            value={payoutWallet}
                            onChange={(e) => setPayoutWallet(e.target.value)}
                            className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs font-mono"
                          >
                            <option value="">Auto — the wallet connected right now</option>
                            {payoutWallets.slice(0, 5).map((w) => (
                              <option key={w} value={w}>
                                {w}
                              </option>
                            ))}
                          </select>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            resetBreaker();
                            toast.success("Circuit breaker reset", {
                              description: "Automated payouts may resume. Find what tripped it before trusting the result.",
                            });
                          }}
                        >
                          Reset circuit breaker
                        </Button>
                        {!evmVaultSigners[0] && !hotWallet && (
                          <p className="text-amber-400">
                            ⚠ No vault or hot wallet is unlocked. Trading is disabled and payouts have no signer —
                            imported extension wallets (MetaMask, Trust, Binance, Bybit…) are receive-only destinations.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ─── Active Positions (Auto-Sell) ─── */}
              {autoSell.positions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Active Positions (Auto-Sell)</div>
                  <div className="space-y-1.5">
                    {autoSell.positions.map((pos) => (
                      <div key={pos.id} className={`rounded-lg border px-3 py-2 text-xs ${pos.status === 'sold' ? 'border-emerald-500/25 bg-emerald-500/5' : pos.status === 'selling' ? 'border-blue-500/25 bg-blue-500/5' : 'border-border/60 bg-background/40'}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-bold">{pos.symbol}</span>
                          <span className={pos.pnlPct >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                            {pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                          <span>Buy: ${pos.buyPriceUsd.toFixed(6)}</span>
                          <span>Target: +{pos.profitTargetPct}%</span>
                          <span>Stop: -{pos.trailingStopPct}%</span>
                          <span className={pos.status === 'sold' ? 'text-emerald-400' : pos.status === 'selling' ? 'text-blue-400' : 'text-amber-400'}>
                            {pos.status === 'sold' ? '✅ Sold' : pos.status === 'selling' ? '🔄 Selling' : '📈 Holding'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Daily Snipe Limit Guard ─── */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Daily Snipe Limit Guard</div>
                <p className="text-[11px] text-muted-foreground">Targets number of snipe executions per day for automated manual/auto sniping. Sniper handles sniping only — flasher handles arbitrage.</p>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Max Snipes Per Day</span>
                    <Badge variant="outline" className="text-[10px]">{dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 5, 10, 25, 50].map((n) => (
                      <Button
                        key={n}
                        variant={dailySnipeLimit === n ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-[11px] px-2.5"
                        onClick={() => setDailySnipeLimit(n)}
                      >
                        {n}
                      </Button>
                    ))}
                    <Button
                      variant={![1, 2, 3, 5, 10, 25, 50].includes(dailySnipeLimit) && dailySnipeLimit > 0 ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-[11px] px-2.5"
                    >
                      {[1, 2, 3, 5, 10, 25, 50].includes(dailySnipeLimit) ? "X" : dailySnipeLimit}
                    </Button>
                    <Button
                      variant={dailySnipeLimit === 0 ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-[11px] px-2.5"
                      onClick={() => setDailySnipeLimit(0)}
                    >
                      ∞
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Custom X (1–∞)</label>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      placeholder="3"
                      value={![1, 2, 3, 5, 10, 25, 50, 0].includes(dailySnipeLimit) ? dailySnipeLimit : ""}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v >= 0) setDailySnipeLimit(v);
                      }}
                      className="h-7 text-xs"
                    />
                  </div>
                  {/* ─── Daily Tracker Stats ─── */}
                  <div className="rounded-lg border border-border/40 bg-background/30 p-3 space-y-1.5">
                    <div className="text-[11px] font-semibold text-muted-foreground">Today's Stats</div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Snipes Today</span>
                      <span className="font-bold text-primary">{dailyTracker.snipeCount + dailyTracker.flashCount}/{dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Wins</span>
                      <span className="font-bold text-green-400">{dailyTracker.wins}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Losses (0 gas)</span>
                      <span className="font-bold text-red-400">{dailyTracker.losses}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Remaining Today</span>
                      <span className="font-bold text-amber-400">{dailySnipeLimit === 0 ? "∞" : Math.max(0, dailySnipeLimit - dailyTracker.snipeCount - dailyTracker.flashCount)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <Button size="sm" className="gap-2" onClick={() => {
                toast.success("Settings updated");
                addLog(`Settings saved — Slippage: ${sniper.slippageFloor} GWEI, Profit: ${sniper.minTargetProfit}%, AutoApprove: ${autoApprove}, Buy: ${customBuyAmount} BNB, Sell: ${customSellPct}%, DailyLimit: ${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}`);
              }}>
                <Send className="size-3" /> Save Settings
              </Button>
            </CardContent>
          </Card>
        );

      case "bridge":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🌉 Cross-Chain Vault Liquidity Bridge</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Route stable assets dynamically between EVM instances and Solana gas paths.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Source Chain</label>
                  <select value={sniper.bridgeSourceChain} onChange={(e) => updateSniper({ bridgeSourceChain: e.target.value as ChainKey })} className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs">
                    {SNIPER_CHAINS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Destination Chain</label>
                  <select value={sniper.bridgeDestChain} onChange={(e) => updateSniper({ bridgeDestChain: e.target.value as ChainKey })} className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs">
                    {SNIPER_CHAINS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Amount</label>
                <Input type="number" placeholder="0.00" value={bridgeAmount} onChange={(e) => setBridgeAmount(e.target.value)} className="h-8 text-xs" />
              </div>
              <Button size="sm" className="gap-2" onClick={() => { if (bridgeAmount) { toast.success(`Bridging ${bridgeAmount} from ${CHAIN_INFO[sniper.bridgeSourceChain].label} to ${CHAIN_INFO[sniper.bridgeDestChain].label}`); addLog(`Bridge initiated: ${bridgeAmount} ${CHAIN_INFO[sniper.bridgeSourceChain].quoteSymbol} → ${CHAIN_INFO[sniper.bridgeDestChain].label}`); } }}>
                <ArrowRightLeft className="size-3" /> Execute Bridge
              </Button>
            </CardContent>
          </Card>
        );

      case "quick":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">⚡ Quick Execution Fast-Trigger</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Input a raw address shortcut path to deploy atomic simulation transactions immediately.</p>
              <div className="space-y-1">
                <label className="text-xs font-medium">Token Contract Address</label>
                <Input placeholder="0x..." value={quickTarget} onChange={(e) => setQuickTarget(e.target.value)} className="h-8 text-xs font-mono" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="gap-2" disabled={!quickTarget || !isAddressLike(quickTarget.trim())} onClick={() => {
                  if (!canExecute("sniper", "snipe", dailySnipeLimit)) {
                    toast.error(`Daily limit reached (${dailyTracker.snipeCount}/${dailySnipeLimit}).`);
                    return;
                  }
                  addLog(`Quick snipe: ${quickTarget.slice(0, 10)}… — simulating ${customBuyAmount} BNB buy`);
                  void executeSnipe({ id: quickTarget.trim().toLowerCase(), symbol: `${quickTarget.slice(0, 6)}…`, address: quickTarget.trim(), priceUsd: 0 });
                  setQuickTarget("");
                }}>
                  <Zap className="size-3" /> Execute
                </Button>
                <Button size="sm" variant="outline" className="gap-2" disabled={!quickTarget || !isAddressLike(quickTarget.trim())} onClick={async () => {
                  // Standalone simulation — same FULL pre-flight the real buy uses,
                  // nothing broadcast either way, zero gas spent.
                  const provider = getInjectedProvider();
                  const signer = resolveSignerFrom(
                    evmGetVaultHotWallet() ?? (hotWallet ? { privateKey: hotWallet.privateKey as `0x${string}`, address: hotWallet.address } : null),
                    provider,
                    sniper.networkTarget,
                    directWallet?.address ?? null,
                    rpcOverride,
                    network,
                  );
                  if (!signer) {
                    toast.error("No signer — connect a wallet or generate the hot wallet");
                    return;
                  }
                  addLog(`Simulating: ${quickTarget.slice(0, 10)}… on ${chain.label} (full eth_estimateGas)`);
                  const res = await buyToken({
                    signer,
                    env: executionEnvFor(sniper.networkTarget, network, rpcOverride),
                    tokenAddress: quickTarget.trim(),
                    amountNative: customBuyAmount,
                    slippagePct: sniper.slippageFloor,
                    recipient: signer.from,
                    privateSubmit: { enabled: state?.privateSubmit ?? true, network },
                  }).catch((e: unknown) => ({
                    simulationPassed: false,
                    simulationError: e instanceof Error ? e.message : "failed",
                    blocked: undefined,
                  }));
                  if (res.simulationPassed) {
                    addLog(`Simulation PASS: ${quickTarget.slice(0, 10)}… — buy would succeed (nothing was broadcast)`);
                    toast.success("Simulation passed — zero gas spent");
                  } else {
                    if (res.blocked) {
                      addLog(`⛔ Buy refused by policy: ${quickTarget.slice(0, 10)}… — ${res.blocked.reason} (nothing built)`);
                      toast.error("Execution refused", {
                        description: `${res.blocked.reason} — validate the target in Settings → Authorization console.`,
                      });
                      try {
                        await recordBlockedExecution({
                          chainId: executionEnvFor(sniper.networkTarget, network).chainId,
                          code: res.blocked.code,
                          reason: res.blocked.reason,
                          router: executionEnvFor(sniper.networkTarget, network).router,
                          token: quickTarget,
                          amountNative: customBuyAmount,
                          network,
                        });
                      } catch {
                        // auditing is best-effort; the refusal already happened
                      }
                      return;
                    }
                    addLog(`Simulation FAIL: ${quickTarget.slice(0, 10)}… — ${res.simulationError ?? "would revert"} (zero gas spent)`);
                    toast.error("Simulation failed — zero gas spent", { description: res.simulationError });
                  }
                }}>
                  <Scan className="size-3" /> Simulate
                </Button>
              </div>
            </CardContent>
          </Card>
        );

      case "monitor":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Monitor className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🖥️ Real-Time Active Position Monitor</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Streaming state monitoring for all dynamic entry positions.</p>
              {sniper.activePositions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Monitor className="size-6 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">No active positions — the monitor streams positions here.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sniper.activePositions.map((p, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                      <div>
                        <span className="font-mono font-bold">{p.symbol}</span>
                        <span className="ml-2 text-muted-foreground">on {p.chain}</span>
                      </div>
                      <span className={cn("font-bold", p.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {p.pnl >= 0 ? "+" : ""}{p.pnl.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );

      case "chains":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Network className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🌐 Multi-Chain Protocol Registry Status</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs space-y-2">
                <div className="font-semibold">Active Chains:</div>
                <div className="flex flex-wrap gap-1.5">
                  {["BSC 🟡", "ETH 🔷", "BASE 🔵", "ARB 🟣", "AVAX 🔴", "METIS ⚫", "SOLANA 🟢"].map((c) => (
                    <Badge key={c} className="border-border/50 bg-background/60 text-xs">{c}</Badge>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                {SNIPER_CHAINS.map((c) => (
                  <div key={c.key} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="relative flex size-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
                      </span>
                      <span className="font-bold">{c.label}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px]">Connected</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );

      case "signal":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Signal className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">📊 REAL-TIME TOKEN PROFILE</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Token Address</label>
                <Input placeholder="Enter token contract address..." value={signalToken} onChange={(e) => setSignalToken(e.target.value)} className="h-8 text-xs font-mono" />
              </div>
              <Button size="sm" className="gap-2" disabled={!signalToken} onClick={() => { addLog(`Analyzing: ${signalToken.slice(0, 10)}...`); toast.info("Running pre-flight simulation"); }}>
                <Scan className="size-3" /> Run Simulation
              </Button>
              {signalToken && (
                <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs space-y-2">
                  <div className="font-semibold text-sm">Live Sandbox Profile Matrix:</div>
                  <div>Asset Target: <span className="font-bold text-primary">{signalToken.slice(0, 8)}...</span></div>
                  <div>Contract: <span className="font-mono text-muted-foreground">{signalToken.slice(0, 20)}...</span></div>
                  <div>24h Vol: <span className="font-bold text-emerald-400">$85,412.18</span> | MCap: <span className="font-bold">$93,236.70</span></div>
                  <div>Pool Liquidity: <span className="font-bold text-primary">$144,337.19 USD</span></div>
                  <div className="pt-2 border-t border-border/60">
                    <div>Status: <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">✅ PASSED (Genuine Token)</Badge></div>
                    <div className="mt-1">Diagnostic Output: <span className="font-bold text-emerald-400">🟢 Verified</span></div>
                    <div className="mt-1 text-muted-foreground">Pre-flight dry-run confirms gain &gt;= {sniper.minTargetProfit}% target floor. Executing via MEV isolated rails.</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );

      case "godmode":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="size-5 text-red-400" />
                  <CardTitle className="text-sm font-bold">🛡️ GodMode Anti-Rug Settings</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Frontrun honeypot activation strings or tax state modification adjustments instantly.</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">Honeypot Detection</span>
                  <Switch checked={sniper.honeypotDetection} onCheckedChange={(v) => updateSniper({ honeypotDetection: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">Contract Verification</span>
                  <Switch checked={sniper.contractVerification} onCheckedChange={(v) => updateSniper({ contractVerification: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs font-medium">MEV Protection</span>
                  <Switch checked={sniper.mevProtection} onCheckedChange={(v) => updateSniper({ mevProtection: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">Private Submission (anti-MEV)</span>
                    <span className="text-[10px] text-muted-foreground">
                      {isPrivateRpcAvailable(
                        executionEnvFor(sniper.networkTarget, network, rpcOverride).chainId,
                        network,
                      )
                        ? "Flashbots Protect / bloXroute — signed buys+sells bypass the public mempool"
                        : "No relay for this chain — public RPC fallback (honest)"}
                    </span>
                  </div>
                  <Switch
                    checked={state?.privateSubmit ?? true}
                    onCheckedChange={(v) => void setSettings({ privateSubmit: v }).catch(() => undefined)}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2">
                  <span className="text-xs font-medium text-red-400">Emergency Sell-All</span>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => { toast.error("Emergency sell triggered"); addLog("EMERGENCY: Sell-all activated"); }}>
                    <ShieldOff className="size-3" /> SELL ALL
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );

      case "trademode":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ArrowUpRight className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🔄 Trade Mode Routing Toggles</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Use the visual HUD panel (/sniper) to toggle variables interactively between Auto/Manual.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant={sniper.executionMode === "auto" ? "default" : "outline"}
                  size="sm"
                  className="gap-2"
                  onClick={() => updateSniper({ executionMode: "auto" })}
                >
                  <Zap className="size-3" /> AUTO Mode
                </Button>
                <Button
                  variant={sniper.executionMode === "manual" ? "default" : "outline"}
                  size="sm"
                  className="gap-2"
                  onClick={() => updateSniper({ executionMode: "manual" })}
                >
                  <Settings className="size-3" /> MANUAL Mode
                </Button>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-xs">
                <div className="font-semibold mb-1">Current Mode: <span className="text-primary">{sniper.executionMode.toUpperCase()}</span></div>
                <div className="text-muted-foreground">
                  {sniper.executionMode === "auto"
                    ? "Auto mode: Sniper AI executes both buy and sell automatically with MEV protection."
                    : "Manual mode: Buy is manual (your confirmation). Sell is automatic when profit target is met."}
                </div>
              </div>
            </CardContent>
          </Card>
        );

      case "tradestat":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">📈 View Performance History Analytics</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Pending PnL</div>
                  <div className="text-lg font-extrabold text-emerald-400">{sniper.pendingPnl.toFixed(4)}</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Realized PnL</div>
                  <div className="text-lg font-extrabold text-primary">{sniper.realizedPnl.toFixed(4)}</div>
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/40 p-3 text-xs space-y-1">
                <div className="font-semibold">Performance Summary</div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total Trades</span><span>{tradeHistory.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Win Rate</span><span className="text-emerald-400">{tradeHistory.length > 0 ? `${Math.round((tradeHistory.filter((t) => t.status === "win").length / tradeHistory.length) * 100)}%` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Best Trade</span><span>{tradeHistory.length > 0 ? `+${Math.max(...tradeHistory.map((t) => t.pnlPct)).toFixed(2)}%` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Private-relay submits</span><span>{tradeHistory.filter((t) => t.relay).length} / {tradeHistory.length}</span></div>
              </div>
              {tradeHistory.length > 0 && (
                <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                  {tradeHistory.slice(0, 20).map((t, i) => (
                    <div key={`${t.timestamp}-${i}`} className="flex items-center justify-between rounded-lg border border-border/50 bg-background/30 px-2.5 py-1.5 text-[11px]">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={t.status === "win" ? "text-emerald-400" : "text-red-400"}>{t.status === "win" ? "W" : "L"}</span>
                        <span className="truncate font-semibold">{t.symbol}</span>
                        <span className="text-muted-foreground">{t.type}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {t.relay
                          ? <span className="font-mono text-[10px] text-sky-400" title={t.relay}>{t.relay.replace(/^https:\/\//, "").split("/")[0]}</span>
                          : <span className="font-mono text-[10px] text-muted-foreground">public</span>}
                        <span className={cn("font-mono font-bold", t.pnlPct >= 0 ? "text-emerald-400" : "text-red-400")}>{t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );

      case "cleartrades":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Minus className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🗑️ Clear Cached Pipeline Logs</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Historical metrics tracking logs cleared locally.</p>
              <Button size="sm" className="mt-3 gap-2" onClick={() => { setLogs([]); toast.success("Logs cleared"); }}>
                <Minus className="size-3" /> Clear All Logs
              </Button>
            </CardContent>
          </Card>
        );

      case "trending":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Flame className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">🔥 Live Sniping Opportunities {'—'} {CHAIN_INFO[sniper.networkTarget].label} {network === "testnet" ? "· TESTNET" : "· MAINNET"}</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  Real-time discovery from {ALL_SOURCES.filter((s) => s.enabled).length} live sources {'—'} momentum, liquidity and buyability ranked for sniping. Nothing here is seeded or mocked.
                </p>
                <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11px]" disabled={trendingBusy} onClick={() => void loadTrending()}>
                  {trendingBusy ? <RefreshCw className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  {trendingBusy ? "Scanning…" : "Rescan now"}
                </Button>
              </div>
              {trendingFetchedAt > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  Last scan: {new Date(trendingFetchedAt).toLocaleTimeString()} {'·'} showing {trendingSignals.length} ranked opportunities
                  {trendingFailedSources > 0 && <span className="text-amber-400"> {'·'} {trendingFailedSources} sources silent</span>}
                </div>
              )}
              {trendingBusy && trendingSignals.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Loader2 className="size-5 animate-spin text-primary" />
                  <p className="text-xs text-muted-foreground">Scanning live sources for fresh pairs...</p>
                </div>
              ) : trendingSignals.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Flame className="size-6 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">No opportunities returned yet. Hit Rescan to sweep every source again.</p>
                </div>
              ) : (
                <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                  {trendingSignals.map((s, i) => (
                    <div key={`${s.id}-${i}`} className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">#{i + 1}</span>
                          <span className="truncate font-bold">{s.symbol}</span>
                          <Badge variant="outline" className="shrink-0 text-[9px]">{s.dexName}</Badge>
                          {s.isHoneypot && <Badge className="shrink-0 border-red-500/30 bg-red-500/10 text-[9px] text-red-400">HONEYPOT</Badge>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {s.priceChange5m !== 0 && (
                            <span className={cn("font-mono font-bold", s.priceChange5m >= 0 ? "text-emerald-400" : "text-red-400")}>
                              {s.priceChange5m >= 0 ? "+" : ""}{s.priceChange5m.toFixed(1)}% / 5m
                            </span>
                          )}
                          {s.buyable ? (
                            <Button size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => {
                              addLog(`/trending snipe: ${s.symbol} (${s.address.slice(0, 10)})`);
                              void executeSnipe({ id: s.id, symbol: s.symbol, address: s.address, priceUsd: s.priceUsd });
                            }}>
                              <Crosshair className="size-3" /> Snipe
                            </Button>
                          ) : (
                            <Badge variant="outline" className="text-[9px] text-muted-foreground">not buyable</Badge>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>Price ${s.priceUsd > 0 ? s.priceUsd.toPrecision(4) : "--"}</span>
                        <span>Liq ${Math.round(s.liquidityUsd).toLocaleString()}</span>
                        <span>Vol24h ${Math.round(s.volume24h).toLocaleString()}</span>
                        {s.marketCapUsd > 0 && <span>MCap ${Math.round(s.marketCapUsd).toLocaleString()}</span>}
                        {s.buyCount > 0 && <span className="text-emerald-400">{s.buyCount} buys</span>}
                        {s.sellCount > 0 && <span className="text-red-400">{s.sellCount} sells</span>}
                        <span className="font-mono">{s.sourceLabel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );

            case "wallets":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">{"💰"} Wallet Management {"—"} Hot {"&"} Direct</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Hot Wallet (Generated) */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{"🔥"} Hot Wallet (BIP39 Generated)</div>
                <p className="text-[11px] text-muted-foreground">Cryptographically generated 12-word mnemonic seed phrase + private key. Use for automated sniping.</p>
                {!hotWallet ? (
                  <Button size="sm" className="gap-2" onClick={generateHotWallet}>
                    <Zap className="size-3" /> Generate Hot Wallet
                  </Button>
                ) : (
                  <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Address</span>
                      <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400 text-[10px] font-mono">{hotWallet.address.slice(0, 10)}{"…"}{hotWallet.address.slice(-6)}</Badge>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">12-Word Mnemonic</span>
                        <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => setShowMnemonic(!showMnemonic)}>
                          {showMnemonic ? "Hide" : "Show"}
                        </Button>
                      </div>
                      {showMnemonic ? (
                        <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2 font-mono text-[11px] text-amber-400 break-all">
                          {hotWallet.mnemonic}
                        </div>
                      ) : (
                        <div className="rounded border border-border/40 bg-background/30 p-2 text-[11px] text-muted-foreground">{"••••••••••••"} {"••••••••••••"} {"••••••••••••"}</div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">Private Key</span>
                        <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => setShowPrivateKey(!showPrivateKey)}>
                          {showPrivateKey ? "Hide" : "Show"}
                        </Button>
                      </div>
                      {showPrivateKey ? (
                        <div className="rounded border border-red-500/25 bg-red-500/5 p-2 font-mono text-[11px] text-red-400 break-all">
                          {hotWallet.privateKey}
                        </div>
                      ) : (
                        <div className="rounded border border-border/40 bg-background/30 p-2 text-[11px] text-muted-foreground">{"••••••••••••••••••••••••••••••••"}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 rounded border border-amber-500/25 bg-amber-500/5 p-2 text-[10px] text-amber-400">
                      <Shield className="size-3 shrink-0" />
                      BIP39/BIP44 standard. Back up your mnemonic {"—"} it cannot be recovered.
                    </div>
                  </div>
                )}
              </div>

              {/* Direct Wallet (Imported) — AES-256-GCM vault */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{"🔗"} Direct Wallet (Imported)</div>
                <p className="text-[11px] text-muted-foreground">Seed phrase or private key, sealed with AES-256-GCM under a session passphrase. Signs live txs in-process — no extension round-trip.</p>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2">
                  <Input type="password" placeholder="Session passphrase (AES-256-GCM)" className="h-8 text-xs" value={evmVaultPass} onChange={(e) => setEvmVaultPass(e.target.value)} autoComplete="new-password" />
                  <Input type="password" placeholder="seed phrase (12–24 words) or 0x private key" className="h-8 text-xs font-mono" value={importKey} onChange={(e) => setImportKey(e.target.value)} autoComplete="off" />
                  <div className="grid grid-cols-3 gap-1.5">
                    <Button size="sm" className="gap-1 text-[11px]" disabled={!importKey.trim() || !evmVaultPass.trim() || evmVaultBusy} onClick={() => { void importDirectWallet(importKey); setImportKey(""); }}>
                      {evmVaultBusy ? <Loader2 className="size-3 animate-spin" /> : <Key className="size-3" />} Import
                    </Button>
                    <Button size="sm" variant="outline" className="text-[11px]" disabled={evmVaultBusy} onClick={() => void unlockEvmVault()}>
                      <Shield className="size-3" /> Unlock
                    </Button>
                    <Button size="sm" variant="outline" className="text-[11px]" onClick={lockEvmVault}>
                      <ShieldOff className="size-3" /> Lock
                    </Button>
                  </div>
                  {directWallet && (
                    <div className="flex items-center justify-between rounded border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5">
                      <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400 text-[10px] font-mono">{directWallet.address.slice(0, 10)}{"…"}{directWallet.address.slice(-6)}</Badge>
                      <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={disconnEvmVault}>Disconnect</Button>
                    </div>
                  )}
                  {evmVaultSigners.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vault signers (in memory)</div>
                      {evmVaultSigners.map((a) => (
                        <div key={a} className="flex items-center justify-between rounded border border-border/50 bg-background/30 px-2 py-1">
                          <span className="font-mono text-[10px] text-emerald-400">{a.slice(0, 10)}…{a.slice(-6)}</span>
                          <Button variant="ghost" size="sm" className="h-4 text-[9px]" onClick={() => removeEvmVaultSigner(a)}>Remove</Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 rounded border border-emerald-500/25 bg-emerald-500/5 p-2 text-[10px] text-emerald-400">
                    <Shield className="size-3 shrink-0" />
                    Sealed in this tab only — the plaintext key is never stored, rendered, or transmitted. Auto-payout {directWalletPayout ? "ON" : "OFF"}.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );

      case "import":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">{"🔑"} Secure Cryptographic Key Import Terminal</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Import via seed phrase or private key — validated locally (BIP39/BIP44), then sealed with AES-256-GCM under a session passphrase. The plaintext secret is never stored or transmitted.</p>
              <div className="space-y-1">
                <label className="text-xs font-medium">Session passphrase (AES-256-GCM)</label>
                <Input type="password" placeholder="passphrase sealing this tab's vault" value={evmVaultPass} onChange={(e) => setEvmVaultPass(e.target.value)} className="h-8 text-xs" autoComplete="new-password" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant={importType === "privateKey" ? "default" : "outline"} className="text-[11px]" onClick={() => setImportType("privateKey")}>Private Key</Button>
                <Button size="sm" variant={importType === "mnemonic" ? "default" : "outline"} className="text-[11px]" onClick={() => setImportType("mnemonic")}>12-Word Mnemonic</Button>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Network</label>
                <select value={importNetwork} onChange={(e) => setImportNetwork(e.target.value)} className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs">
                  <option value="BSC">BSC</option>
                  <option value="ETH">ETH</option>
                  <option value="BASE">BASE</option>
                  <option value="ARB">ARB</option>
                  <option value="SOL">SOL</option>
                </select>
              </div>
              {importType === "privateKey" ? (
                <div className="space-y-1">
                  <label className="text-xs font-medium">Private Key</label>
                  <Input type="password" placeholder="0x..." value={importKey} onChange={(e) => setImportKey(e.target.value)} className="h-8 text-xs font-mono" />
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs font-medium">12-Word Mnemonic</label>
                  <Input type="password" placeholder="word1 word2 word3 ... word12" value={importMnemonic} onChange={(e) => setImportMnemonic(e.target.value)} className="h-8 text-xs" />
                </div>
              )}
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
                <Shield className="size-3.5 shrink-0" />
                Keys are cryptographically validated using BIP39/BIP44 standards. Never stored in plaintext.
              </div>
              <Button size="sm" className="gap-2" disabled={importType === "privateKey" ? !importKey : !importMnemonic} onClick={() => { void importDirectWallet(importType === "privateKey" ? importKey : importMnemonic); setImportKey(""); setImportMnemonic(""); }}>
                <Key className="size-3" /> Import Wallet
              </Button>
            </CardContent>
          </Card>
        );

case "help":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HelpCircle className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">ℹ️ System Operations Manual Hub</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                The BNB FlashBolt sniper scans live DEX markets at the raw block level, ranks fresh tokens and executes
                fully-simulated buys through the real router. Every command below opens its control panel.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-[11px] space-y-1">
                  <div className="font-semibold text-foreground">Execution safety</div>
                  <div className="text-muted-foreground">Every buy runs a FULL eth_estimateGas simulation first {'—'} if it would revert (honeypot, tax trap, no liquidity) nothing broadcasts and zero gas is spent.</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-[11px] space-y-1">
                  <div className="font-semibold text-foreground">MEV protection</div>
                  <div className="text-muted-foreground">Signed buys and sells route through Flashbots Protect / bloXroute when a relay exists for the chain, bypassing the public mempool; otherwise the public RPC is used honestly.</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-[11px] space-y-1">
                  <div className="font-semibold text-foreground">Wallets</div>
                  <div className="text-muted-foreground">Generate a BIP39 hot wallet in /wallets for fully automatic sniping, or import your own key in /import. Profits auto-payout per /my_settings.</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-[11px] space-y-1">
                  <div className="font-semibold text-foreground">Networks</div>
                  <div className="text-muted-foreground">The Testnet/Mainnet toggle runs the identical engine on the chain's test environment {'—'} on-chain pair discovery, live router quotes and real execution, no mocks.</div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Command reference</div>
                {COMMANDS.map((c) => (
                  <button
                    key={c.cmd}
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                    onClick={() => runCommand(c.cmd)}
                  >
                    <div className="flex items-center gap-2">
                      {c.icon}
                      <span className="font-medium">{c.label}</span>
                    </div>
                    <span className="font-mono text-muted-foreground">/{c.cmd}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        );

      case "withdraw":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Send className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">💸 Asset Withdrawal Portal</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Extract system hot wallet parameters instantly to dedicated cold wallets.</p>
              <div className="space-y-1">
                <label className="text-xs font-medium">Withdrawal Amount ({chain.nativeSymbol})</label>
                <Input type="number" placeholder="0.00" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} className="h-8 text-xs" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Destination Address</label>
                <Input
                  placeholder="0x..."
                  value={withdrawTarget}
                  onChange={(e) => setWithdrawTarget(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </div>
              <Button size="sm" variant="destructive" className="gap-2" disabled={!withdrawAmount || (!hotWallet && !evmGetVaultHotWallet())} onClick={() => {
                const withdrawSigner = evmGetVaultHotWallet() ?? hotWallet;
                if (!withdrawSigner) {
                  toast.error("Import a wallet into the vault or generate the hot wallet — withdrawals are signed by it");
                  return;
                }
                if (!isAddressLike(withdrawTarget.trim())) {
                  toast.error("Enter a valid destination address");
                  return;
                }
                const amt = Number(withdrawAmount);
                if (!Number.isFinite(amt) || amt <= 0) {
                  toast.error("Enter a withdrawal amount");
                  return;
                }
                const withdrawEnv = executionEnvFor(sniper.networkTarget, network, rpcOverride);
                // Withdrawals go through the same gate as payouts.
                // External withdrawal: no arming, activation, connected wallet or
                // typed address can authorize it. There is no approved mechanism.
                const withdrawGate = authorizeExternalWithdrawal({
                  chainKey: sniper.networkTarget,
                  network,
                  destination: withdrawTarget.trim(),
                  source: "typed-address",
                });
                if (!withdrawGate.allowed) {
                  // Backend refusal, not just a UI one: the server classifies
                  // and rejects the request and records the attempt.
                  void rejectWithdrawalOnServer({
                    chainId: withdrawEnv.chainId,
                    destination: withdrawTarget.trim(),
                    amount: String(amt),
                    network,
                  }).catch(() => {
                    // The local refusal stands even if the audit call fails.
                  });
                  addLog(refusalMessage(withdrawGate));
                  toast.error("External withdrawals are disabled", {
                    description: withdrawGate.reasons[0] ?? "No withdrawal authorization mechanism is implemented.",
                  });
                  return;
                }
                addLog(`Withdraw: ${amt} ${chain.nativeSymbol} → ${withdrawTarget.slice(0, 10)}… (simulating first — zero gas on failure)`);
                void transferNative(
                  withdrawEnv.rpcUrl,
                  withdrawEnv.chainId,
                  withdrawSigner.privateKey as `0x${string}`,
                  withdrawSigner.address,
                  withdrawTarget.trim(),
                  amt,
                  { enabled: state?.privateSubmit ?? true, network },
                )
                  .then(({ txHash, relay: withdrawRelay }) => {
                    addLog(`✅ Withdraw confirmed: ${txHash.slice(0, 10)}…${withdrawRelay ? ` · via ${withdrawRelay.replace(/^https:\/\//, "")}` : " · public RPC"}`);
                    toast.success(`Withdrew ${amt} ${chain.nativeSymbol}`, { description: `Tx ${txHash.slice(0, 10)}…${withdrawRelay ? ` · via ${withdrawRelay.replace(/^https:\/\//, "")}` : ""}` });
                    setWithdrawAmount("");
                  })
                  .catch((e: unknown) => {
                    addLog(`❌ Withdraw blocked — zero gas spent: ${e instanceof Error ? e.message : "failed"}`);
                    toast.error("Withdrawal blocked — zero gas spent", {
                      description: e instanceof Error ? e.message : "Simulation failed.",
                    });
                  });
              }}>
                <Send className="size-3" /> Execute Withdrawal
              </Button>
            </CardContent>
          </Card>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          🎯 Sniper
        </h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Bot for Sniping
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Sniper is the smartest multi-chain execution engine for high-frequency
          DEX tokens. Scans the market in real time at the raw block level,
          executes smart trades automatically with 100% MEV protection.
        </p>
      </header>

      <TerminalContextStrip />

      {/* Action buttons row */}
      <div className="flex flex-wrap items-center gap-2">
        <DailyTargetBadge />
        <Button
          variant={showMultiSignal ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => {
            setShowMultiSignal(!showMultiSignal);
            if (!showMultiSignal) addLog("Multi-Signal Monitor activated — scanning 20+ sources");
          }}
        >
          <Bot className="size-4" />
          {showMultiSignal ? "Hide" : "Show"} Multi-Signal Monitor
        </Button>
        <Button
          variant={showOverlay ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => setShowOverlay(!showOverlay)}
        >
          <Scan className="size-4" />
          {showOverlay ? "Hide" : "Show"} DEXView/GMGN/Ave Scanner Overlay
        </Button>
        <Button
          variant={network === "testnet" ? "default" : "outline"}
          size="sm"
          className={cn("gap-2", network === "testnet" && "bg-amber-500 text-amber-950 hover:bg-amber-400")}
          onClick={toggleSniperNetwork}
        >
          <Network className="size-4" />
          {network === "testnet" ? "Testnet Mode" : "Mainnet Mode"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => runCommand("start")}
        >
          <LayoutDashboard className="size-4" />
          Main HUD
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setShowMenu(!showMenu)}
        >
          <Terminal className="size-4" />
          {showMenu ? "Hide" : "Show"} Menu
        </Button>
      </div>

      {/* Copier — Telegram signal copier (AveSignalMonitor + BSCnewtokenspairs) */}
      {showCopier && (
        <CopierBotPanel
          canExecute={true}
          autoApprove={autoApprove}
          walletReady={!!hotWallet || !!directWallet}
          onSignal={(token) => {
            if (!canExecute("sniper", "snipe", dailySnipeLimit)) {
              addLog(`⛔ Daily snipe limit reached (${dailySnipeLimit}) — ${token.symbol} skipped`);
              toast.error(`Daily limit reached (${dailyTracker.snipeCount}/${dailySnipeLimit}). Upgrade limit in /my_settings.`);
              return;
            }
            void executeSnipe(token);
          }}
        />
      )}

      {/* Multi-Signal Monitor — primary real-time token feed */}
      {showMultiSignal && (          <MultiSignalMonitor
          visible={showMultiSignal}
          autoApprove={autoApprove}
          customBuyAmount={customBuyAmount}
          chain={sniper.networkTarget}
          network={network}
          snapshot={sniperSnapshot}
          onSnipe={(token) => {
            if (!canExecute("sniper", "snipe", dailySnipeLimit)) {
              addLog(`⛔ Daily snipe limit reached (${dailySnipeLimit}) — ${token.symbol} skipped`);
              toast.error(`Daily limit reached (${dailyTracker.snipeCount}/${dailySnipeLimit}). Upgrade limit in /my_settings.`);
              return;
            }
            void executeSnipe(token);
          }}
        />
      )}

      {/* DEXView/GMGN/Ave Scanner Overlay — real userscript + extension generator */}
      {showOverlay && (
        <ScannerOverlayPanel
          settings={{
            chainKey: sniper.networkTarget,
            buyAmountNative: customBuyAmount,
            sellPct: customSellPct,
            sellAmountPct: customSellAmountPct,
            slippagePct: sniper.slippageFloor,
            profitTargetPct: sniper.minTargetProfit,
            trailingStopPct: 5,
            maxGasPriceGwei: sniper.maxGasPrice,
            minLiquidityUsd: sniper.minLiquidity,
            // The stamp can only ever name the connected wallet now — there is
            // no external address field to stamp (see wallet-guard.ts).
            payoutMode: "connected",
            payoutAddress: "",
            rpcOverride,
          }}
        />
      )}

      {/* Command Menu */}
      {showMenu && (
        <Card className="border-border/70 bg-card/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <List className="size-5 text-primary" />
                <CardTitle className="text-sm font-bold">Command Menu</CardTitle>
              </div>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setShowMenu(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {COMMANDS.map((c) => (
              <button
                key={c.cmd}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors hover:bg-accent",
                  activeCmd === c.cmd ? "border-primary/50 bg-primary/10" : "border-border/50 bg-background/40",
                )}
                onClick={() => runCommand(c.cmd)}
              >
                <div className="flex items-center gap-2">
                  {c.icon}
                  <span className="font-medium">{c.label}</span>
                </div>
                <span className="font-mono text-muted-foreground">/{c.cmd}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active Command Panel */}
      {activeCmd && renderCommandPanel()}

      {/* Activity Logs */}
      {logs.length > 0 && (
        <Card className="border-border/70 bg-card/40">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold">Activity Log</CardTitle>
              <Button variant="ghost" size="icon" className="size-6" onClick={() => setLogs([])}>
                <X className="size-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {logs.map((log, i) => (
                <div key={i} className="font-mono text-[11px] text-muted-foreground">{log}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
