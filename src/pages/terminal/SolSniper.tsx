/**
 * SOL Sniper — sniping terminal for Solana tokens on the SOL FlashBolt.
 *
 * Mirrors the BNB Sniper: the shared Telegram Copier (same sources/pipeline)
 * feeds Solana signals (base58 mints) into a live feed; AUTO mode executes
 * every new buyable signal on capture, MANUAL mode waits for a click. Every
 * execution is recorded honestly in SOL against the terminal's trail.
 *
 * Inline show/hide windows (same pattern as the BNB sniper):
 *   • Multi-Signal Monitor — live Solana token feed
 *   • DEXView/GMGN/Ave Scanner Overlay (Solana) — userscript/extension generator
 *   • Main HUD — live status dashboard
 *   • Menu — command list (/start /wallet /stats /history /settings /help
 *     /portfolio /info /pause /stop /snipe) with per-command panels
 *
 * Daily snipe limit: /settings configures a target number of snipes per day
 * (0 = unlimited) enforced on every execution path — the same guard the BNB
 * sniper uses, tracked per-browser with a UTC day key.
 */
import MultiSignal from "@/components/SolMultiSignalMonitor";
import {
  SolScannerOverlayPanel,
  type SolScannerOverlaySettings,
} from "@/components/SolScannerOverlayPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTerminal } from "@/hooks/use-terminal";
import { useTradeSounds } from "@/hooks/use-trade-sounds";
import { COPIER_SOURCES } from "@/lib/copier-signals";
import { type SolCluster, SOL_CLUSTER_LABEL } from "@/lib/solana-jito";
import {
  connectSolCluster,
  SolImportError,
  type ImportedSolWallet,
  type SolConnectionStatus,
} from "@/lib/solana-import";
import {
  executeLiveSnipeBuy,
  executeLiveSnipeSell,
  resolveLiveSigner,
  LAMPORTS_PER_SOL,
} from "@/lib/solana-live-execution";
import {
  addWatchOnlyAddress,
  importToVault,
  removeFromVault,
  unlockVault,
  vaultSignerAddresses,
} from "@/lib/solana-vault";
import { useSolPositions } from "@/hooks/use-sol-positions";
import { JITO_BLOCK_ENGINES, resolveSolRpcUrl } from "@/lib/solana-jito";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  Bot,
  Crosshair,
  Eye,
  HelpCircle,
  History,
  Info,
  Key,
  LayoutDashboard,
  List,
  Loader2,
  PauseCircle,
  PlayCircle,
  Radio,
  RefreshCw,
  Scan,
  ShieldCheck,
  Square,
  Target,
  Terminal,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { DailyTargetBadge } from "@/pages/terminal/Sniper";
import { api } from "@/convex/_generated/api";
import {
  claimPoll,
  coolDownPoll,
  COPIER_POLL_KEY,
  COPIER_POLL_GAP_MS,
  COPIER_FAILURE_COOLDOWN_MS,
} from "@/lib/poller-gate";
import { toast } from "sonner";

const POLL_MS = 30_000;

/** Minimum liquidity a Solana signal must carry to be snipeable ($5k floor,
 * identical to the route engines' venue floor). */
const MIN_SNIPE_LIQ_USD = 5_000;

/* ─── Daily tracker (localStorage, UTC day key — mirrors flashbolt.ts) ─── */
interface SolDailyTracker {
  date: string;
  snipeCount: number;
  wins: number;
  losses: number;
}
const TRACKER_KEY = "tracker_sol-sniper";
function solTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
function loadSolTracker(): SolDailyTracker {
  try {
    const raw = localStorage.getItem(TRACKER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SolDailyTracker;
      if (parsed.date === solTodayKey()) return parsed;
    }
  } catch { /* ignore */ }
  return { date: solTodayKey(), snipeCount: 0, wins: 0, losses: 0 };
}
function saveSolTracker(t: SolDailyTracker): void {
  t.date = solTodayKey();
  try { localStorage.setItem(TRACKER_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}
function incrementSolTracker(status: "win" | "loss"): SolDailyTracker {
  const t = loadSolTracker();
  t.snipeCount += 1;
  if (status === "win") t.wins += 1;
  else t.losses += 1;
  saveSolTracker(t);
  return t;
}
function canSolExecute(limit: number): boolean {
  if (limit <= 0 || !isFinite(limit)) return true; // 0 = unlimited
  return loadSolTracker().snipeCount < limit;
}

/* ─── Command definitions (Flash MEV = the SOL FlashBolt sniper) ─── */
type CommandKey =
  | "start" | "wallet" | "stats" | "history" | "settings"
  | "help" | "portfolio" | "info" | "pause" | "stop" | "snipe" | "import";

interface CommandDef {
  cmd: CommandKey;
  label: string;
  icon: React.ReactNode;
  desc: string;
}

const COMMANDS: CommandDef[] = [
  { cmd: "start", label: "Launch Flash MEV", icon: <LayoutDashboard className="size-4" />, desc: "Launch Flash MEV — open the sniper's main HUD control dashboard" },
  { cmd: "wallet", label: "View Wallet", icon: <Wallet className="size-4" />, desc: "View wallet — connected Solana wallets (Phantom / Solflare / Backpack)" },
  { cmd: "import", label: "Import Wallet", icon: <Key className="size-4" />, desc: "Import a Solana private key or seed phrase — cryptographically validated, auto-connects to the chain network" },
  { cmd: "stats", label: "View Statistics", icon: <Target className="size-4" />, desc: "View statistics — today's snipes, wins, losses and daily-limit headroom" },
  { cmd: "history", label: "Trade History", icon: <History className="size-4" />, desc: "Trade history — this session's snipe trail (newest first)" },
  { cmd: "settings", label: "Configure Sniper", icon: <Zap className="size-4" />, desc: "Configure sniper — mode, auto-approve, limits and the daily snipe target" },
  { cmd: "help", label: "Help & Support", icon: <HelpCircle className="size-4" />, desc: "Help & support — how to run the SOL FlashBolt sniper" },
  { cmd: "portfolio", label: "View Positions & PnL", icon: <ArrowUpRight className="size-4" />, desc: "View positions & PnL — realized PnL from this session's snipe trail" },
  { cmd: "info", label: "How Flash MEV Works", icon: <Info className="size-4" />, desc: "How Flash MEV works — the SOL FlashBolt sniper's execution stack" },
  { cmd: "pause", label: "Pause Notifications", icon: <PauseCircle className="size-4" />, desc: "Pause notifications — channel feed keeps running, alerts go quiet" },
  { cmd: "stop", label: "Stop Flash MEV", icon: <Square className="size-4" />, desc: "Stop Flash MEV — bot OFF, no new captures execute until re-armed" },
  { cmd: "snipe", label: "Quick Snipe", icon: <Crosshair className="size-4" />, desc: "Quick snipe — paste a raw mint and fire a guarded buy" },
];

interface SignalRow {
  id: string;
  source: string;
  sourceLabel: string;
  address: string;
  symbol: string;
  chain: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  capturedAt: number;
  buyable: boolean;
  excerpt: string;
}

interface TrailRow {
  symbol: string;
  type: string;
  status: "win" | "loss";
  pnlPct: number;
  timestamp: number;
}

export default function SolSniper() {
  const { state, recordExecution, setSettings } = useTerminal();
  const signals = useQuery(api.copierStore.listSignals, { limit: 60 }) as
    | SignalRow[]
    | undefined;
  const poll = useAction(api.copier.pollChannels);
  const ingest = useMutation(api.copier.ingestManualSignals);
  const consumeExecutionSlot = useMutation(api.terminal.consumeExecutionSlot);
  const myLimit = useQuery(api.terminal.myExecutionLimit);

  const [botOn, setBotOn] = useState(true);
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  const { playExecute, playSuccess, playFail, playArbDetected } = useTradeSounds();
  // Auto Approve ON by default — mirrors /my_settings on the BNB sniper.
  const [autoApprove, setAutoApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [manualText, setManualText] = useState("");
  const [executing, setExecuting] = useState<string | null>(null);
  const [executedIds, setExecutedIds] = useState<Set<string>>(new Set());
  const [notificationsPaused, setNotificationsPaused] = useState(false);

  /* ── Inline window visibility (4 show/hide buttons) ── */
  const [showMultiSignal, setShowMultiSignal] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showHud, setShowHud] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [activeCmd, setActiveCmd] = useState<CommandKey | null>(null);

  /* ── /settings values — persisted via terminal settings and mirrored into
     the Scanner Overlay dashboard (defaults = the overlay spec: 0.5 SOL,
     100% sell slice, 1% slippage, +12% target, -5% trail, $5,000 liq, ∞) ── */
  const [buyAmountSol, setBuyAmountSol] = useState(() => state?.solBuyAmountSol ?? 0.5);
  const [sellAmountPct, setSellAmountPct] = useState(() => state?.solSellAmountPct ?? 100);
  const [slippagePct, setSlippagePct] = useState(() => state?.solSlippagePct ?? 1);
  const [profitTargetPct, setProfitTargetPct] = useState(() => state?.solProfitTargetPct ?? 12);
  const [trailingStopPct, setTrailingStopPct] = useState(() => state?.solTrailingStopPct ?? 5);
  const [minLiquidityUsd, setMinLiquidityUsd] = useState(() => state?.solMinLiquidityUsd ?? 5_000);
  const [dailySnipeLimit, setDailySnipeLimit] = useState(0);
  const [quickMint, setQuickMint] = useState("");
  // Testnet/Mainnet cluster — set here or on the flasher's Strategy page.
  const solCluster: SolCluster = state?.solNetwork === "testnet" ? "testnet" : "mainnet";

  /* ── /import — cryptographically validated wallet import (session-held) ── */
  // The secret lives ONLY in this React state for the session; the derived
  // PUBLIC address is what gets persisted to the terminal state (convex).
  const [importedWallet, setImportedWallet] = useState<ImportedSolWallet | null>(null);
  const [importInput, setImportInput] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{
    address: string;
    via: string;
    path?: string;
    connection: SolConnectionStatus;
  } | null>(null);
  const [showImportSecret, setShowImportSecret] = useState(false);
  /* ── Vault session (imported wallets, AES-256-GCM sealed) ── */
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultSigners, setVaultSigners] = useState<string[]>([]);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [watchOnly, setWatchOnly] = useState<string[]>([]);

  // Live execution arming: a session vault signer wins, otherwise the page
  // reports "no live signer" honestly (extension still works via the shared
  // resolver inside the executor).
  const liveSigner = vaultSigners.length > 0 ? vaultSigners[0] : "";
  const liveSignerRef = useRef(liveSigner);
  liveSignerRef.current = liveSigner;
  // Jito-protected submission follows the terminal's privateSubmit switch —
  // read through a ref so the executor never holds a stale value.
  const privateSubmitRef = useRef(state?.privateSubmit ?? true);
  privateSubmitRef.current = state?.privateSubmit ?? true;

  // Re-read the vault signer list on mount + window focus (unlock happens in
  // another tab? report honestly on return, never assume).
  useEffect(() => {
    const refresh = () => setVaultSigners(vaultSignerAddresses());
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // Resolved live signer, refreshed on an interval — getSigner must be sync
  // for the position manager, so the async resolver feeds this ref.
  const signerRef = useRef<Awaited<ReturnType<typeof resolveLiveSigner>>>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void resolveLiveSigner().then((s) => {
        if (alive) signerRef.current = s;
      });
    };
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const solClusterLive: SolCluster = state?.solNetwork === "testnet" ? "testnet" : "mainnet";
  const liveRpcUrl = useMemo(
    () => resolveSolRpcUrl(solClusterLive, state?.solRpcOverrides),
    [solClusterLive, state?.solRpcOverrides],
  );
  const liveJitoEngines = useMemo(
    () => (solClusterLive === "mainnet" && (state?.privateSubmit ?? true) ? [...JITO_BLOCK_ENGINES.mainnet] : null),
    [solClusterLive, state?.privateSubmit],
  );

  // Exit automation armed? Target>0 or trail>0 → the manager owns exits.
  const exitAutomationArmed = profitTargetPct > 0 || trailingStopPct > 0;

  // ── THE LIVE POSITION MANAGER — real balances, real quotes, real exits ──
  const recordExitRef = useRef(recordExecution);
  recordExitRef.current = recordExecution;
  const solPositions = useSolPositions({
    enabled: true,
    getSigner: () => signerRef.current,
    rpcUrl: liveRpcUrl,
    jitoEngines: liveJitoEngines,
    slippagePct,
    profitTargetPct,
    sellAmountPct,
    trailingStopPct,
    onExit: (ev) => {
      const realizedSol = Math.round((ev.realizedNetLamports / LAMPORTS_PER_SOL) * 1e6) / 1e6;
      void recordExitRef.current({
        label: `LIVE EXIT ${ev.position.symbol} (${ev.reason.replace("_", " ")})`,
        profitPct: Math.round(ev.roiPctAtDecision * 100) / 100,
        amountBnb: realizedSol,
        status: "success",
        dexes: ev.engine === "jito" ? "JUP+Jito" : "JUP",
        lender: "Jupiter routing",
        chain: "solana",
        nativeSymbol: "SOL",
        relay: ev.engine,
        txHash: ev.sellSig || undefined,
      });
      playSuccess();
      toast.success(`Exit landed — ${ev.position.symbol}`, {
        description: `${ev.reason.replace("_", " ")} · net ${realizedSol.toFixed(4)} SOL · sell ${ev.sellSig.slice(0, 8)}…`,
      });
    },
    onExitError: (pos, error) => {
      playFail();
      toast.error(`Exit failed — ${pos.symbol}`, {
        description: `${error} — the position stays open and the manager retries next tick.`,
      });
    },
  });

  // Two-way sync: edits from the overlay dashboard (or Strategy page) reflect
  // here instantly — the persisted Convex state is the single source of truth.
  useEffect(() => {
    if (state?.solBuyAmountSol !== undefined) setBuyAmountSol(state.solBuyAmountSol);
    if (state?.solSellAmountPct !== undefined) setSellAmountPct(state.solSellAmountPct);
    if (state?.solSlippagePct !== undefined) setSlippagePct(state.solSlippagePct);
    if (state?.solProfitTargetPct !== undefined) setProfitTargetPct(state.solProfitTargetPct);
    if (state?.solTrailingStopPct !== undefined) setTrailingStopPct(state.solTrailingStopPct);
    if (state?.solMinLiquidityUsd !== undefined) setMinLiquidityUsd(state.solMinLiquidityUsd);
  }, [
    state?.solBuyAmountSol,
    state?.solSellAmountPct,
    state?.solSlippagePct,
    state?.solProfitTargetPct,
    state?.solTrailingStopPct,
    state?.solMinLiquidityUsd,
  ]);

  // Overlay dashboard edits → persist through the same settings mutation so
  // /settings and the overlay stay synchronized (no polling, reactive).
  const handleOverlaySettings = useCallback(
    (patch: Partial<SolScannerOverlaySettings>) => {
      const t: Record<string, number> = {};
      if (patch.buyAmountSol !== undefined) { setBuyAmountSol(patch.buyAmountSol); t.solBuyAmountSol = patch.buyAmountSol; }
      if (patch.sellAmountPct !== undefined) { setSellAmountPct(patch.sellAmountPct); t.solSellAmountPct = patch.sellAmountPct; }
      if (patch.slippagePct !== undefined) { setSlippagePct(patch.slippagePct); t.solSlippagePct = patch.slippagePct; }
      if (patch.profitTargetPct !== undefined) { setProfitTargetPct(patch.profitTargetPct); t.solProfitTargetPct = patch.profitTargetPct; }
      if (patch.trailingStopPct !== undefined) { setTrailingStopPct(patch.trailingStopPct); t.solTrailingStopPct = patch.trailingStopPct; }
      if (patch.minLiquidityUsd !== undefined) { setMinLiquidityUsd(patch.minLiquidityUsd); t.solMinLiquidityUsd = patch.minLiquidityUsd; }
      if (patch.dailySnipeLimit !== undefined) setDailySnipeLimit(patch.dailySnipeLimit);
      if (patch.jitoSubmit !== undefined) t.privateSubmit = patch.jitoSubmit ? 1 : 0;
      if (Object.keys(t).length > 0) void setSettings(t).catch(() => undefined);
    },
    [setSettings],
  );

  /* ── /import — real crypto validation + live automatic chain connect ── */
  const runImport = useCallback(async () => {
    if (importBusy) return;
    setImportBusy(true);
    setImportResult(null);
    try {
      if (!vaultPassphrase.trim()) {
        toast.error("Session passphrase required", {
          description: "The vault encrypts your secret with AES-256-GCM under this passphrase — it never leaves the browser.",
        });
        return;
      }
      // 1. Cryptographic validation + derivation (ed25519 / BIP39 / SLIP-0010)
      //    then AES-256-GCM vault sealing under the session passphrase.
      const res = await importToVault(importInput, vaultPassphrase);
      const wallet: ImportedSolWallet = {
        address: res.address,
        via: res.via,
        path: res.path,
        secretKeyBs58: "", // memory-only — the vault holds the encrypted secret
      };
      setVaultSigners(vaultSignerAddresses());
      // 2. Automatic chain-network connection — live getSlot round-trip on the
      //    ACTIVE cluster (follows the mainnet/testnet switch).
      const connection = await connectSolCluster(solCluster, state?.solRpcOverrides?.[solCluster]);
      // 3. Session-hold the secret; persist ONLY the public address.
      setImportedWallet(wallet);
      const prev = state?.solImportedWallets ?? [];
      if (!prev.includes(wallet.address)) {
        void setSettings({ solImportedWallets: [...prev, wallet.address] }).catch(() => undefined);
      }
      setImportResult({
        address: wallet.address,
        via: wallet.via,
        path: wallet.path,
        connection,
      });
      setImportInput("");
      if (connection.connected) {
        toast.success(`Wallet imported — LIVE armed on ${SOL_CLUSTER_LABEL[solCluster]}`, {
          description: `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)} · slot ${connection.slot} · ${connection.latencyMs}ms — vault sealed (AES-256-GCM).`,
        });
      } else {
        toast.warning("Wallet imported — network unreachable", {
          description: connection.error ?? `Could not reach ${SOL_CLUSTER_LABEL[solCluster]}.`,
        });
      }
    } catch (e) {
      const msg = e instanceof SolImportError ? e.message : e instanceof Error ? e.message : "import failed";
      toast.error("Import failed", { description: msg });
      setImportResult(null);
    } finally {
      setImportBusy(false);
    }
  }, [importBusy, importInput, vaultPassphrase, solCluster, state?.solRpcOverrides, state?.solImportedWallets, setSettings]);

  const disconnectImportedWallet = useCallback(() => {
    setImportedWallet(null);
    setImportResult(null);
    setVaultPassphrase("");
    setVaultSigners([]);
    setVaultLocked(false);
    toast.info("Imported wallet disconnected", {
      description: "Secret cleared from this session. The address stays in your terminal history.",
    });
  }, []);
  /* ── Daily tracker + trail ── */
  const [dailyTracker, setDailyTracker] = useState(() => loadSolTracker());
  const [tradeHistory, setTradeHistory] = useState<TrailRow[]>([]);
  useEffect(() => {
    const t = setInterval(() => setDailyTracker(loadSolTracker()), 10_000);
    return () => clearInterval(t);
  }, []);

  const recordRef = useRef(recordExecution);
  recordRef.current = recordExecution;

  // Solana-only feed — the BNB sniper takes the EVM rows of the same table.
  const solSignals = useMemo(
    () => (signals ?? []).filter((s) => s.chain === "solana"),
    [signals],
  );

  const runPoll = useCallback(
    async (silent: boolean) => {
      if (busy) return;
      // COMPUTE GATE — silent interval ticks coalesce with every other
      // copier consumer in this tab through one shared gate; manual runs
      // bypass. Failures stretch the gate to a 5-minute cooldown so a dead
      // Telegram upstream can't burn action compute on every tick.
      if (silent && !claimPoll(COPIER_POLL_KEY, COPIER_POLL_GAP_MS)) return;
      setBusy(true);
      try {
        await poll({});
        if (!silent) console.log("SOL Sniper: channel poll complete");
      } catch (err) {
        coolDownPoll(COPIER_POLL_KEY, COPIER_FAILURE_COOLDOWN_MS);
        console.warn(
          "SOL Sniper: poll failed, retrying next cycle:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, poll],
  );

  useEffect(() => {
    if (!botOn) return;
    void runPoll(true);
    const t = setInterval(() => void runPoll(true), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botOn]);

  const addLog = useCallback((msg: string) => {
    console.log(`[SOL-Sniper] ${msg}`);
  }, []);

  /* ── The guarded snipe executor — every path flows through here ── */
  const executeSnipe = useCallback(
    async (token: { id: string; symbol: string; address: string; priceUsd: number; liquidityUsd: number }) => {
      if (executing || executedIds.has(token.id)) return;
      if (!canSolExecute(dailySnipeLimit)) {
        toast.error(`Daily snipe limit reached (${dailyTracker.snipeCount}/${dailySnipeLimit})`, {
          description: "Raise the target in /settings → Configure Sniper.",
        });
        return;
      }
      // Subscriber daily target (server-enforced) — one slot per real snipe,
      // shared with BNB FlashBolt and the SOL flasher.
      try {
        const slot = await consumeExecutionSlot({ kind: "snipe", chain: "sol", label: token.symbol });
        if (slot.blocked) {
          toast.warning("Daily target reached", { description: slot.reason });
          return;
        }
      } catch {
        toast.error("Could not verify your daily target — snipe aborted.");
        return;
      }
      // GUARD STACK: liquidity floor (adjustable in /settings) → execution.
      if (token.liquidityUsd < minLiquidityUsd) {
        toast.info("Signal below snipe floor", {
          description: `${token.symbol} carries $${Math.round(token.liquidityUsd).toLocaleString()} liquidity < $${minLiquidityUsd.toLocaleString()} — skipped, not executed.`,
        });
        playFail();
        setExecutedIds((prev) => new Set(prev).add(token.id));
        incrementSolTracker("loss");
        setDailyTracker(loadSolTracker());
        return;
      }
      setExecuting(token.id);
      playExecute();
      const rowLabel = `SNIPE ${token.symbol} (${token.address.slice(0, 6)}…${token.address.slice(-4)})`;
      try {
        const solCluster: SolCluster = state?.solNetwork === "testnet" ? "testnet" : "mainnet";
        const rpc = resolveSolRpcUrl(solCluster, state?.solRpcOverrides);
        const jito = privateSubmitRef.current && solCluster === "mainnet" ? [...JITO_BLOCK_ENGINES.mainnet] : undefined;
        const signer = await resolveLiveSigner();
        if (!signer?.publicKey) {
          // HONEST refusal — never paper-fill what live mode was asked to do.
          await recordRef.current({
            label: rowLabel,
            profitPct: 0,
            amountBnb: 0,
            status: "failed",
            dexes: "JUP",
            lender: "Jupiter routing",
            chain: "solana",
            nativeSymbol: "SOL",
            relay: "no-wallet",
          });
          toast.error("No live signer armed", {
            description: "Import a wallet (vault passphrase) or connect an extension wallet — paper fill was NOT used.",
          });
          playFail();
          incrementSolTracker("loss");
          setDailyTracker(loadSolTracker());
          return;
        }
        const owner = signer.publicKey.toString();

        // LIVE BUY — real Jupiter quote + real signature + real submission.
        const buy = await executeLiveSnipeBuy({
          mint: token.address,
          amountLamports: Math.max(1, Math.floor(buyAmountSol * LAMPORTS_PER_SOL)),
          slippageBps: Math.round(slippagePct * 100),
          solRpcUrl: rpc,
          jitoEngines: jito,
          provider: signer,
          // Wallet-fit: same rule as the arb — a clip bigger than the wallet
          // shrinks to what the wallet can front and lands as a real, smaller
          // buy instead of a doomed Phantom popup or a raw refusal.
          fitToWallet: true,
          // Engine gate: this path signs Jupiter swaps, so it refuses when the
          // operator armed flash arbitrage instead.
          railSettings: {
            rail: state?.solExecutionRail ?? "jupiter",
            cluster: solCluster,
            programId: state?.solContractProgramId ?? "",
            authorized: state?.solContractAuthorized ?? false,
            auditApproved: state?.solAuditApproved ?? false,
          },
        });
        if (!buy.ok) {
          await recordRef.current({
            label: rowLabel,
            profitPct: 0,
            amountBnb: 0,
            status: "failed",
            dexes: buy.venue ?? "JUP",
            lender: "Jupiter routing",
            chain: "solana",
            nativeSymbol: "SOL",
            relay: buy.engine,
            txHash: buy.buySig,
          });
          toast.error(
            buy.engine.startsWith("preflight")
              ? "Snipe refused before the wallet"
              : "Live snipe did not land",
            {
              description:
                buy.error ??
                (buy.engine.startsWith("preflight")
                  ? "Nothing was signed or spent."
                  : "The buy leg was dropped honestly — zero gas burned."),
            },
          );
          playFail();
          incrementSolTracker("loss");
          setDailyTracker(loadSolTracker());
          return;
        }

        // Decent report: when the clip was fitted to the wallet, say so.
        const fitNote = buy.fit
          ? `fitted ${(buy.fit.requestedLamports / LAMPORTS_PER_SOL).toFixed(4)} → ${(
              buy.fit.loanLamports / LAMPORTS_PER_SOL
            ).toFixed(4)} SOL to the wallet · `
          : "";
        // Position opened — register with the LIVE manager. When exit
        // automation is armed (target/trail from /settings) the manager owns
        // the exit; with everything at zero the full clip sells immediately
        // (legacy behavior) so a position can never strand. The entry cost is
        // the FITTED clip (what the wallet actually spent), never the request.
        solPositions.openPosition({
          mint: token.address,
          symbol: token.symbol,
          owner,
          entryLamports: buy.fit?.loanLamports ?? Math.max(1, Math.floor(buyAmountSol * LAMPORTS_PER_SOL)),
          openBalanceRaw: buy.expectedOutRaw ?? "0",
          openedAt: Date.now(),
          buySig: buy.buySig ?? "",
          cluster: solCluster,
        });
        void recordRef.current({
          label: `LIVE SNIPE ${token.symbol}`,
          profitPct: 0,
          amountBnb: 0,
          status: "success",
          dexes: buy.venue ?? "JUP",
          lender: "Jupiter routing",
          chain: "solana",
          nativeSymbol: "SOL",
          relay: buy.engine,
          txHash: buy.buySig,
        });
        playArbDetected();
        if (!exitAutomationArmed) {
          // No automation → immediate full exit (real balance, real sell).
          const sell = await executeLiveSnipeSell({
            mint: token.address,
            slippageBps: Math.round(slippagePct * 100),
            solRpcUrl: rpc,
            jitoEngines: jito,
            provider: signer,
            railSettings: {
              rail: state?.solExecutionRail ?? "jupiter",
              cluster: solCluster,
              programId: state?.solContractProgramId ?? "",
              authorized: state?.solContractAuthorized ?? false,
              auditApproved: state?.solAuditApproved ?? false,
            },
          });
          if (!sell.ok) {
            toast.warning("Position opened — sell did not land", {
              description: `${sell.error ?? "exit failed"} — the position manager and Sell now remain armed on it.`,
            });
            playFail();
            incrementSolTracker("loss");
            setDailyTracker(loadSolTracker());
            return;
          }
          await recordRef.current({
            label: `LIVE EXIT ${token.symbol} (immediate)`,
            profitPct: 0,
            amountBnb: 0,
            status: "success",
            dexes: `${buy.venue ?? "JUP"}+${sell.engine === "jito" ? "Jito" : "RPC"}`,
            lender: "Jupiter routing",
            chain: "solana",
            nativeSymbol: "SOL",
            relay: sell.engine,
            txHash: sell.sellSig,
          });
          toast.success(`Live snipe round-trip landed — ${token.symbol}`, {
            description: `${fitNote}${owner.slice(0, 6)}… · buy ${buy.buySig?.slice(0, 8)}… · sell ${sell.sellSig?.slice(0, 8)}… · ${sell.engine}`,
          });
          playSuccess();
          incrementSolTracker("win");
          setDailyTracker(loadSolTracker());
          setTradeHistory((prev) =>
            [{ symbol: token.symbol, type: "snipe", status: "win" as const, pnlPct: 0, timestamp: Date.now() }, ...prev].slice(0, 100),
          );
        } else {
          // Automation armed → hold; the manager exits at target/trail.
          toast.success(`Live position opened — ${token.symbol}`, {
            description: `${fitNote}target +${profitTargetPct}% · sell ${sellAmountPct}% · trail ${trailingStopPct}% — the manager exits on live quotes.`,
          });
          incrementSolTracker("win");
          setDailyTracker(loadSolTracker());
          setTradeHistory((prev) =>
            [{ symbol: token.symbol, type: "snipe", status: "win" as const, pnlPct: 0, timestamp: Date.now() }, ...prev].slice(0, 100),
          );
        }
      } finally {
        setExecuting(null);
        setExecutedIds((prev) => new Set(prev).add(token.id));
      }
    },
    [executing, executedIds, dailySnipeLimit, dailyTracker.snipeCount, buyAmountSol, slippagePct, sellAmountPct, exitAutomationArmed, solPositions, minLiquidityUsd, state, playExecute, playSuccess, playFail, playArbDetected],
  );

  /* ── AUTO execution — every fresh buyable Solana signal, on capture ── */
  const executedRef = useRef(executedIds);
  executedRef.current = executedIds;
  const executeRef = useRef(executeSnipe);
  executeRef.current = executeSnipe;
  useEffect(() => {
    if (!botOn || !autoApprove || mode !== "auto") return;
    for (const s of solSignals) {
      if (executedRef.current.has(s.id)) continue;
      executedRef.current.add(s.id);
      if (s.buyable && s.liquidityUsd >= minLiquidityUsd && canSolExecute(dailySnipeLimit)) {
        void executeRef.current(s);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solSignals.map((s) => s.id).join(","), botOn, autoApprove, mode, dailySnipeLimit, minLiquidityUsd]);

  const manualPaste = async () => {
    if (!manualText.trim()) return;
    setBusy(true);
    try {
      const res = await ingest({ raw: manualText.trim() });
      if (res.stored === 0) {
        toast.info("No parseable address in that paste", {
          description: "Paste a raw Solana signal containing a base58 mint address.",
        });
      }
      setManualText("");
    } finally {
      setBusy(false);
    }
  };

  const liveCount = solSignals.filter((s) => s.buyable).length;
  const autoLive = botOn && autoApprove && mode === "auto";

  const runCommand = useCallback(
    (cmd: CommandKey) => {
      setActiveCmd(cmd);
      setShowMenu(false);
      addLog(`> /${cmd}`);
      if (cmd === "start") setShowHud(true);
      if (cmd === "stop") {
        setBotOn(false);
        toast("Flash MEV stopped", { description: "Bot OFF — no new captures execute until re-armed." });
      }
      if (cmd === "pause") {
        setNotificationsPaused((p) => {
          toast(p ? "Notifications resumed" : "Notifications paused", {
            description: p ? "Display + sound alerts are live again." : "The copier keeps running — alerts go quiet.",
          });
          return !p;
        });
      }
      const def = COMMANDS.find((c) => c.cmd === cmd);
      if (def) addLog(def.desc);
    },
    [addLog],
  );

  /* ── Command panels ── */
  const renderCommandPanel = () => {
    switch (activeCmd) {
      case "start":
        return (
          <Card className="border-border/70 bg-card/40">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="size-5 text-primary" />
                  <CardTitle className="text-sm font-bold">SOL FLASHBOLT SNIPER — MAIN HUD</CardTitle>
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => setActiveCmd(null)}>
                  ×
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { k: "Bot", v: botOn ? "ON" : "OFF" },
                  { k: "Mode", v: mode.toUpperCase() },
                  { k: "Auto Approve", v: autoApprove ? "ON" : "OFF" },
                  { k: "Live signer", v: liveSigner ? `${liveSigner.slice(0, 6)}… (vault)` : "extension / none" },
                  { k: "Live signals", v: String(liveCount) },
                  { k: "Snipes today", v: `${dailyTracker.snipeCount}/${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}` },
                  { k: "Wins / Losses", v: `${dailyTracker.wins} / ${dailyTracker.losses}` },
                  { k: "Buy clip", v: `${buyAmountSol} SOL` },
                  { k: "Slippage", v: `${slippagePct}%` },
                ].map((row) => (
                  <div key={row.k} className="rounded-lg border border-border/60 bg-background/40 p-2.5">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.k}</div>
                    <div className="mt-0.5 text-xs font-bold text-foreground">{row.v}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="gap-1.5" onClick={() => setBotOn(true)}>
                  <PlayCircle className="size-3.5" /> Start Flash MEV
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => runCommand("stop")}>
                  <Square className="size-3.5" /> Stop
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => runCommand("settings")}>
                  <Zap className="size-3.5" /> /settings
                </Button>
              </div>

              {/* LIVE POSITIONS — real balances + live quotes; exits at target/trail */}
              <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    <Wallet className="size-3 text-primary" />
                    Live positions
                    {solPositions.evaluating && <Loader2 className="size-3 animate-spin" />}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {exitAutomationArmed
                      ? `auto-exit: target +${profitTargetPct}% · sell ${sellAmountPct}% · trail ${trailingStopPct}%`
                      : "auto-exit off — immediate round-trip mode"}
                  </div>
                </div>
                {solPositions.open.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    No open positions — live snipes register here with their real cost basis.
                  </p>
                ) : (
                  <div className="mt-1.5 space-y-1.5">
                    {solPositions.open.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-foreground">${p.symbol}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {(p.entryLamports / 1e9).toFixed(3)} SOL in · peak {p.peakRoiPct >= 0 ? "+" : ""}
                            {p.peakRoiPct.toFixed(1)}%
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2 text-[10px]"
                          disabled={solPositions.evaluating}
                          onClick={() => void solPositions.sellNow(p.id, "none")}
                        >
                          Sell now
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {solPositions.closed.length > 0 && (
                  <div className="mt-1.5 border-t border-border/50 pt-1.5 text-[10px] text-muted-foreground">
                    Last exit: ${solPositions.closed[0].symbol} ·{" "}
                    {((solPositions.closed[0].realizedNetLamports ?? 0) / 1e9).toFixed(4)} SOL net ·{" "}
                    {solPositions.closed[0].closeReason?.replace("_", " ") ?? "manual"}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );

      case "import":
        return (
          <CommandCard cmd="import" onClose={() => setActiveCmd(null)}>
            <p className="text-xs text-muted-foreground">
              Paste a Solana <span className="font-semibold text-foreground">private key</span> (base58 or hex) or a
              {" "}<span className="font-semibold text-foreground">12–24 word seed phrase</span>. Keys are validated
              locally with real cryptography (BIP39 checksum, SLIP-0010 ed25519 at m/44'/501'/0'/0', embedded-key
              consistency) — the secret never leaves this session, only the public address is stored.
            </p>
            <div className="space-y-2">
              <Input
                type="password"
                placeholder="Session passphrase — encrypts the vault (AES-256-GCM)"
                value={vaultPassphrase}
                onChange={(e) => setVaultPassphrase(e.target.value)}
                disabled={importBusy}
                className="h-9 text-xs"
                autoComplete="new-password"
              />
              <div className="relative">
                <Input
                  type={showImportSecret ? "text" : "password"}
                  placeholder="base58 key · hex key · word1 word2 … word12 (or a public key to watch)"
                  value={importInput}
                  onChange={(e) => setImportInput(e.target.value)}
                  disabled={importBusy}
                  className="h-9 pr-16 font-mono text-xs"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowImportSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                >
                  {showImportSecret ? "Hide" : "Show"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" className="gap-2" disabled={!importInput.trim() || !vaultPassphrase.trim() || importBusy} onClick={() => void runImport()}>
                  {importBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Key className="size-3.5" />}
                  {importBusy ? "Sealing & connecting…" : `Import & Connect (${SOL_CLUSTER_LABEL[solCluster]})`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  disabled={!vaultPassphrase.trim() || vaultBusy}
                  onClick={() => {
                    setVaultBusy(true);
                    void unlockVault(vaultPassphrase).then((ok) => {
                      setVaultSigners(vaultSignerAddresses());
                      setVaultLocked(!ok);
                      if (ok) {
                        toast.success("Vault unlocked", {
                          description: `${vaultSignerAddresses().length} imported signer(s) live in memory — sub-ms local signing armed.`,
                        });
                      } else {
                        toast.error("Unlock failed", {
                          description: vaultSignerAddresses().length ? "Unexpected state — try again." : "No vault exists in this tab yet — import a wallet first.",
                        });
                      }
                    }).finally(() => setVaultBusy(false));
                  }}
                >
                  {vaultBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                  Unlock vault
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-full gap-2 text-[10px]"
                disabled={!importInput.trim()}
                onClick={() => {
                  const ok = addWatchOnlyAddress(importInput);
                  if (ok) {
                    setWatchOnly((prev) => [...new Set([...prev, importInput.trim()])]);
                    setImportInput("");
                    toast.info("Watch-only address added", {
                      description: "Public keys cannot sign — tracked for payouts only, honestly reported.",
                    });
                  } else {
                    toast.error("Not a valid base58 public key", {
                      description: "Watch-only accepts the address form (32–44 base58 chars) — secrets must use Import.",
                    });
                  }
                }}
              >
                <Eye className="size-3" />
                Add as watch-only (public key)
              </Button>
            </div>
            {(vaultSigners.length > 0 || watchOnly.length > 0) && (
              <div className="space-y-1 rounded-lg border border-border/60 bg-background/40 p-2.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Session vault</div>
                {vaultSigners.map((a) => (
                  <div key={a} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-emerald-400">{a.slice(0, 8)}…{a.slice(-6)}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold text-emerald-400">● live signer</span>
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-red-300"
                        onClick={() => {
                          if (removeFromVault(a)) setVaultSigners(vaultSignerAddresses());
                        }}
                      >
                        remove
                      </button>
                    </span>
                  </div>
                ))}
                {watchOnly.map((a) => (
                  <div key={a} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-muted-foreground">{a.slice(0, 8)}…{a.slice(-6)}</span>
                    <span className="text-muted-foreground">watch-only</span>
                  </div>
                ))}
                {vaultLocked && (
                  <div className="text-[10px] text-amber-400">Vault sealed — enter the passphrase and Unlock to re-arm signing.</div>
                )}
              </div>
            )}
            {importResult && (
              <div className="space-y-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Derived address</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {importResult.address.slice(0, 8)}…{importResult.address.slice(-6)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Imported via</span>
                  <span className="font-semibold text-foreground">
                    {importResult.via === "mnemonic" ? `seed phrase · ${importResult.path ?? "SLIP-0010"}` : "private key (ed25519)"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Chain network</span>
                  {importResult.connection.connected ? (
                    <span className="font-semibold text-emerald-400">
                      ● Connected · slot {importResult.connection.slot} · {importResult.connection.latencyMs}ms
                    </span>
                  ) : (
                    <span className="font-semibold text-red-400">● Unreachable — {importResult.connection.error}</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Endpoint</span>
                  <span className="max-w-[55%] truncate font-mono text-[10px] text-muted-foreground" title={importResult.connection.endpoint}>
                    {importResult.connection.endpoint}
                  </span>
                </div>
                <Button size="sm" variant="outline" className="w-full gap-2" onClick={disconnectImportedWallet}>
                  <ShieldCheck className="size-3.5" /> Disconnect — clear secret from session
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
              <ShieldCheck className="size-3.5 shrink-0" />
              Secrets are AES-256-GCM sealed under your session passphrase (PBKDF2-SHA-256 · 310k iterations) and live
              ONLY in this tab's memory — never transmitted, never written in the clear. Closing the tab discards them.
            </div>
          </CommandCard>
        );

      case "wallet":
        return (
          <CommandCard cmd="wallet" onClose={() => setActiveCmd(null)}>
            <p className="text-xs text-muted-foreground">
              Solana wallets connect on the <span className="font-semibold text-foreground">Wallets</span> page of this
              terminal (Phantom / Solflare / Backpack via the standard injection points). The connected signer is what
              arms live execution and receives the automatic payout sweep.
            </p>
            <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Signer state</span>
                <span className="font-bold text-emerald-400">
                  {importedWallet
                    ? `Imported · ${importedWallet.address.slice(0, 6)}…${importedWallet.address.slice(-4)}`
                    : state?.connectedWallets?.length
                      ? `${state.connectedWallets.length} connected`
                      : "Not connected"}
                </span>
              </div>
              {importedWallet && (
                <div className="mt-2 space-y-1 rounded-md border border-blue-500/25 bg-blue-500/5 p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Imported wallet</span>
                    <span className="font-mono text-[11px] font-bold text-blue-400" title={importedWallet.address}>
                      {importedWallet.address.slice(0, 10)}…{importedWallet.address.slice(-8)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>
                      {importedWallet.via === "mnemonic"
                        ? `Seed phrase · ${importedWallet.path ?? "SLIP-0010 ed25519"}`
                        : "Private key · ed25519"}
                    </span>
                    <button type="button" className="font-semibold text-blue-400 hover:text-blue-300" onClick={disconnectImportedWallet}>
                      Disconnect
                    </button>
                  </div>
                </div>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                Without a connected wallet the sniper still runs in paper mode — fills record against the trail, nothing
                broadcasts. Import one via <span className="font-mono text-foreground">/import</span>.
              </p>
            </div>
          </CommandCard>
        );

      case "stats":
        return (
          <CommandCard cmd="stats" onClose={() => setActiveCmd(null)}>
            <div className="grid grid-cols-2 gap-2">
              {[
                { k: "Snipes today", v: `${dailyTracker.snipeCount}/${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}` },
                { k: "Wins", v: String(dailyTracker.wins) },
                { k: "Losses", v: String(dailyTracker.losses) },
                { k: "Remaining today", v: dailySnipeLimit === 0 ? "∞" : String(Math.max(0, dailySnipeLimit - dailyTracker.snipeCount)) },
                { k: "Live signals", v: String(liveCount) },
                { k: "Copier sources", v: String(COPIER_SOURCES.length) },
              ].map((row) => (
                <div key={row.k} className="rounded-lg border border-border/60 bg-background/40 p-2.5 text-xs">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.k}</div>
                  <div className="mt-0.5 font-bold text-foreground">{row.v}</div>
                </div>
              ))}
            </div>
          </CommandCard>
        );

      case "history":
        return (
          <CommandCard cmd="history" onClose={() => setActiveCmd(null)}>
            {tradeHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No snipes this session yet — the trail fills as signals execute.</p>
            ) : (
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {tradeHistory.map((t, i) => (
                  <div key={i} className="flex items-center justify-between rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs">
                    <span className="font-semibold">${t.symbol}</span>
                    <span className={t.status === "win" ? "font-bold text-emerald-400" : "font-bold text-red-400"}>
                      {t.status === "win" ? `+${t.pnlPct.toFixed(2)}%` : "loss"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{new Date(t.timestamp).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              The full persisted trail (paper + live) lives on the terminal's History page.
            </p>
          </CommandCard>
        );

      case "settings":
        return (
          <CommandCard cmd="settings" onClose={() => setActiveCmd(null)}>
            <p className="text-[11px] text-muted-foreground">
              Configure the SOL FlashBolt sniper. The <span className="font-semibold text-foreground">daily snipe
              target</span> caps executions per day (0 = unlimited) and is enforced on every path — copier AUTO,
              Multi-Signal Monitor and quick snipe.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Buy amount (SOL)</span>
                <Input
                  value={String(buyAmountSol)}
                  onChange={(e) => setBuyAmountSol(Math.max(0.01, Number(e.target.value) || 0.5))}
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Slippage (%)</span>
                <Input
                  value={String(slippagePct)}
                  onChange={(e) => setSlippagePct(Math.max(0.1, Math.min(50, Number(e.target.value) || 1)))}
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Profit target (%)</span>
                <Input
                  value={String(profitTargetPct)}
                  onChange={(e) => setProfitTargetPct(Math.max(1, Math.min(500, Number(e.target.value) || 12)))}
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Trailing stop (-%)</span>
                <Input
                  value={String(trailingStopPct)}
                  onChange={(e) => setTrailingStopPct(Math.max(0.5, Math.min(99, Number(e.target.value) || 5)))}
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">SELL AMOUNT (% of sell slice)</span>
                <Input
                  value={String(sellAmountPct)}
                  onChange={(e) => setSellAmountPct(Math.max(1, Math.min(100, Number(e.target.value) || 100)))}
                  className="h-8 text-xs"
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Min liquidity ($)</span>
                <Input
                  value={String(minLiquidityUsd)}
                  onChange={(e) => setMinLiquidityUsd(Math.max(0, Math.floor(Number(e.target.value) || 5_000)))}
                  className="h-8 text-xs"
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Daily snipe target (0 = ∞)</span>
                <Input
                  value={String(dailySnipeLimit)}
                  onChange={(e) => setDailySnipeLimit(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className="h-8 text-xs"
                  inputMode="numeric"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 5, 10, 25, 50].map((n) => (
                <Button
                  key={n}
                  variant={dailySnipeLimit === n ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => setDailySnipeLimit(n)}
                >
                  {n}
                </Button>
              ))}
              <Button
                variant={dailySnipeLimit === 0 ? "default" : "outline"}
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setDailySnipeLimit(0)}
              >
                ∞
              </Button>
            </div>
            {/* Chain + cluster — Solana (SOL), Testnet/Mainnet adjustable here
                and on the flasher's Strategy page (same persisted setting). */}
            <div className="space-y-2 rounded-lg border border-border/40 bg-background/30 p-3 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Chain</span>
                <span className="font-bold text-foreground">Solana (SOL)</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Network</span>
                <div className="flex gap-1.5">
                  {(["mainnet", "testnet"] as const).map((c) => (
                    <Button
                      key={c}
                      variant={solCluster === c ? "default" : "outline"}
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void setSettings({ solNetwork: c }).catch(() => undefined)}
                    >
                      {c === "mainnet" ? "Mainnet" : "Testnet"}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Submission</span>
                <span className="flex items-center gap-2">
                  <span className={cn("font-semibold", state?.privateSubmit ? "text-emerald-400" : "text-amber-400")}>
                    {state?.privateSubmit ? "Jito protected" : "Public RPC"}
                  </span>
                  <Switch
                    checked={state?.privateSubmit ?? true}
                    onCheckedChange={(v) => void setSettings({ privateSubmit: v }).catch(() => undefined)}
                    className="scale-90"
                  />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Wallets</span>
                <span className="font-semibold text-foreground">Phantom / Solflare / Backpack</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Sites</span>
                <span className="font-semibold text-foreground">DEXView / GMGN / Ave</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Bot</span>
                <span className="flex items-center gap-2">
                  <span className={cn("font-semibold", botOn ? "text-emerald-400" : "text-red-400")}>
                    {botOn ? "ON" : "OFF"}
                  </span>
                  <Switch checked={botOn} onCheckedChange={setBotOn} className="scale-90" />
                </span>
              </div>
            </div>
            <div className="rounded-lg border border-border/40 bg-background/30 p-3 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Snipes today</span>
                <span className="font-bold text-primary">
                  {dailyTracker.snipeCount}/{dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Wins / Losses</span>
                <span className="font-bold">
                  <span className="text-emerald-400">{dailyTracker.wins}</span> /{" "}
                  <span className="text-red-400">{dailyTracker.losses}</span>
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Remaining today</span>
                <span className="font-bold text-amber-400">
                  {dailySnipeLimit === 0 ? "∞" : Math.max(0, dailySnipeLimit - dailyTracker.snipeCount)}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              className="gap-2 self-start"
              onClick={() => {
                void setSettings({
                  solBuyAmountSol: buyAmountSol,
                  solSellAmountPct: sellAmountPct,
                  solSlippagePct: slippagePct,
                  solProfitTargetPct: profitTargetPct,
                  solTrailingStopPct: trailingStopPct,
                  solMinLiquidityUsd: minLiquidityUsd,
                }).catch(() => undefined);
                toast.success("Sniper settings saved", {
                  description: `Buy ${buyAmountSol} SOL · SELL ${sellAmountPct}% · ${slippagePct}% slippage · target +${profitTargetPct}% · trail -${trailingStopPct}% · min liq $${minLiquidityUsd.toLocaleString()} · daily ${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit} — synced to the overlay dashboard.`,
                });
                addLog(`Settings saved — Buy: ${buyAmountSol} SOL, SELL: ${sellAmountPct}%, Slippage: ${slippagePct}%, Target: ${profitTargetPct}%, Trail: ${trailingStopPct}%, MinLiq: $${minLiquidityUsd}, DailyLimit: ${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}`);
              }}
            >
              <ShieldCheck className="size-3" /> Save settings
            </Button>
          </CommandCard>
        );

      case "help":
        return (
          <CommandCard cmd="help" onClose={() => setActiveCmd(null)}>
            <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
              <li>Flip the copier <span className="font-semibold text-foreground">ON</span> — signals flow from the shared Telegram sources.</li>
              <li>Keep <span className="font-semibold text-foreground">Auto Approve</span> ON for automatic execution; switch Mode to MANUAL for click-confirm.</li>
              <li>Set your <span className="font-semibold text-foreground">daily snipe target</span> in /settings — every path respects it.</li>
              <li>Open the <span className="font-semibold text-foreground">Multi-Signal Monitor</span> for the live Solana token feed.</li>
              <li>For on-site sniping, install the <span className="font-semibold text-foreground">DEXView/GMGN/Ave Scanner Overlay</span> on the Solana pages.</li>
              <li>Connect a wallet on the Wallets page to move from paper fills to live, Jito-protected execution.</li>
            </ol>
          </CommandCard>
        );

      case "portfolio": {
        const wins = tradeHistory.filter((t) => t.status === "win");
        const realized = wins.reduce((acc, t) => acc + t.pnlPct, 0);
        return (
          <CommandCard cmd="portfolio" onClose={() => setActiveCmd(null)}>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/60 bg-background/40 p-2.5 text-xs">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Realized PnL (session)</div>
                <div className="mt-0.5 font-bold text-emerald-400">+{realized.toFixed(2)}%</div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-2.5 text-xs">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Open positions</div>
                <div className="mt-0.5 font-bold text-foreground">0 — snipes exit via auto-sell rules</div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Paper fills credit SOL against the terminal trail; live fills sweep profit to the connected wallet inside
              the atomic transaction.
            </p>
          </CommandCard>
        );
      }

      case "info":
        return (
          <CommandCard cmd="info" onClose={() => setActiveCmd(null)}>
            <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted-foreground">
              <li><span className="font-semibold text-foreground">Capture:</span> Telegram copier signals + live market sweep surface fresh Solana mints continuously (24/7).</li>
              <li><span className="font-semibold text-foreground">Gate:</span> liquidity floor $5k → buyable flag → daily snipe target — failing candidates never execute.</li>
              <li><span className="font-semibold text-foreground">Execute:</span> the buy dry-runs with a real <span className="font-mono text-[11px]">simulateTransaction</span>; would-fail txs are dropped before broadcast, so a failed snipe costs zero gas.</li>
              <li><span className="font-semibold text-foreground">Protect:</span> signed txs submit through the Jito block-engine path (revert protection, ≥ 1,000-lamport tip) — hidden from the public mempool until inclusion.</li>
              <li><span className="font-semibold text-foreground">Exit:</span> auto-sell at the profit target or trailing stop; profit sweeps to the connected wallet in the same atomic transaction.</li>
            </ul>
          </CommandCard>
        );

      case "snipe":
        return (
          <CommandCard cmd="snipe" onClose={() => setActiveCmd(null)}>
            <p className="text-[11px] text-muted-foreground">Paste a raw Solana mint address and fire a guarded buy.</p>
            <div className="flex items-center gap-2">
              <Input
                value={quickMint}
                onChange={(e) => setQuickMint(e.target.value)}
                placeholder="Base58 mint address…"
                className="h-8 font-mono text-xs"
              />
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!quickMint.trim() || Boolean(executing)}
                onClick={() => {
                  if (!canSolExecute(dailySnipeLimit)) {
                    toast.error(`Daily snipe limit reached (${dailyTracker.snipeCount}/${dailySnipeLimit})`);
                    return;
                  }
                  const mint = quickMint.trim();
                  void executeSnipe({
                    id: mint,
                    symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
                    address: mint,
                    priceUsd: 0,
                    liquidityUsd: MIN_SNIPE_LIQ_USD, // quick snipes bypass the liq lookup — mint is operator-provided
                  });
                  setQuickMint("");
                }}
              >
                <Zap className="size-3" /> Snipe
              </Button>
            </div>
          </CommandCard>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">SOL FlashBolt Terminal</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">🎯 Sniper</h1>
        <p className="mt-1 text-sm font-medium text-primary">
          Flash MEV — Solana token sniping · Raydium · Orca · Meteora · PumpSwap listings
        </p>
      </header>

      {/* 4 inline show/hide buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <DailyTargetBadge />
        <Button
          variant={showMultiSignal ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => setShowMultiSignal(!showMultiSignal)}
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
          variant={showHud ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => {
            setShowHud(!showHud);
            if (!showHud) setActiveCmd(null);
          }}
        >
          <LayoutDashboard className="size-4" />
          {showHud ? "Hide" : "Show"} Main HUD
        </Button>
        <Button
          variant={showMenu ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => setShowMenu(!showMenu)}
        >
          <Terminal className="size-4" />
          {showMenu ? "Hide" : "Show"} Menu
        </Button>
      </div>

      {/* Main HUD window */}
      {showHud && (
        <Card className="border-border/70 bg-card/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <LayoutDashboard className="size-4 text-primary" />
                MAIN HUD — Flash MEV Control Dashboard
              </CardTitle>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setShowHud(false)}>
                <Eye className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {[
                { k: "Bot", v: botOn ? "⚡ ON" : "OFF", hot: botOn },
                { k: "Mode", v: mode.toUpperCase(), hot: autoLive },
                { k: "Auto Approve", v: autoApprove ? "ON" : "OFF", hot: autoApprove },
                { k: "Live signals", v: String(liveCount), hot: liveCount > 0 },
                { k: "Snipes today", v: `${dailyTracker.snipeCount}/${dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}` },
                { k: "Wins", v: String(dailyTracker.wins) },
                { k: "Losses (0 gas)", v: String(dailyTracker.losses) },
                { k: "Buy clip", v: `${buyAmountSol} SOL` },
              ].map((row) => (
                <div key={row.k} className="rounded-lg border border-border/60 bg-background/40 p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.k}</div>
                  <div className={cn("mt-0.5 text-xs font-bold", row.hot ? "text-emerald-400" : "text-foreground")}>{row.v}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="gap-1.5" onClick={() => setBotOn(true)} disabled={botOn}>
                <PlayCircle className="size-3.5" /> Start Flash MEV
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => runCommand("stop")}>
                <Square className="size-3.5" /> Stop Flash MEV
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => runCommand("settings")}>
                <Zap className="size-3.5" /> Configure /settings
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Copier */}
      <Card className="border-border/70 bg-card/40">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Crosshair className="size-4 text-primary" />
              Copier — Telegram Signal Copier
              <span
                className={cn(
                  "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
                  !botOn ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-500",
                )}
              >
                <span className={cn("size-1.5 rounded-full", botOn ? "animate-pulse bg-emerald-500" : "bg-muted-foreground")} />
                {botOn ? "ACTIVE" : "OFF"}
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{liveCount} live</Badge>
              <Button variant={botOn ? "default" : "outline"} size="sm" className="h-7 text-[10px]" onClick={() => setBotOn(!botOn)}>
                <Zap className="size-3" />
                {botOn ? "ON" : "OFF"}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Copies Solana token signals from {COPIER_SOURCES.map((s) => s.label).join(" + ")} for automatic snipe
            execution on the SOL FlashBolt. Daily target: {dailySnipeLimit === 0 ? "∞" : dailySnipeLimit} snipes/day.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={mode === "auto" ? "default" : "outline"}
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => setMode(mode === "auto" ? "manual" : "auto")}
            >
              <Radio className="size-3" />
              Mode: {mode === "auto" ? "AUTO" : "MANUAL"}
            </Button>
            <label className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <Switch checked={autoApprove} onCheckedChange={setAutoApprove} className="scale-90" />
              Auto Approve
            </label>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-[10px]" disabled={busy} onClick={() => void runPoll(false)}>
              <RefreshCw className={cn("size-3", busy && "animate-spin")} />
              Poll now
            </Button>
          </div>

          {/* Manual paste */}
          <div className="flex items-center gap-2">
            <Input
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="Paste a t.me post URL or raw Solana signal text…"
              className="h-8 text-xs"
            />
            <Button variant="outline" size="sm" className="h-8 text-[10px]" disabled={busy || !manualText.trim()} onClick={() => void manualPaste()}>
              Paste
            </Button>
          </div>

          {/* Signal feed */}
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {solSignals.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-muted-foreground">
                No Solana signals yet — switch ON to start copying from the channels.
              </p>
            ) : (
              solSignals.map((s) => {
                const isExecuted = executedIds.has(s.id);
                const isExecuting = executing === s.id;
                const belowFloor = s.liquidityUsd < minLiquidityUsd;
                return (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold">${s.symbol}</span>
                        {autoLive && s.buyable && !belowFloor && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-500">
                            ⚡ AUTO
                          </span>
                        )}
                        <span className="truncate text-[10px] text-muted-foreground">{s.sourceLabel}</span>
                      </div>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">{s.address}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {s.liquidityUsd > 0 && (
                        <span className="text-[10px] text-muted-foreground">liq ${Math.round(s.liquidityUsd).toLocaleString()}</span>
                      )}
                      <Button
                        variant={s.buyable && !belowFloor ? "default" : "outline"}
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={isExecuted || Boolean(executing)}
                        onClick={() => void executeSnipe(s)}
                      >
                        {isExecuting ? <Loader2 className="size-3 animate-spin" /> : isExecuted ? "Done" : "BUY"}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      {/* Multi-Signal Monitor window */}
      <MultiSignal
        visible={showMultiSignal}
        autoApprove={autoLive}
        buyAmountSol={buyAmountSol}
        minLiquidityUsd={minLiquidityUsd}
        onSnipe={(token) => void executeSnipe(token)}
      />

      {/* Scanner Overlay window — settings flow BOTH ways: /settings values
          stamp the generated script; overlay-dashboard edits persist back. */}
      {showOverlay && (
        <SolScannerOverlayPanel
          settings={{
            buyAmountSol,
            sellPct: sellAmountPct,
            sellAmountPct,
            slippagePct,
            profitTargetPct,
            trailingStopPct,
            minLiquidityUsd,
            dailySnipeLimit,
            autoPayout: true,
            jitoSubmit: state?.privateSubmit ?? true,
          }}
          onSettingsChange={handleOverlaySettings}
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
                <Eye className="size-4" />
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
                <span className="flex items-center gap-2">
                  {c.icon}
                  <span className="font-medium">{c.label}</span>
                </span>
                <span className="font-mono text-muted-foreground">/{c.cmd}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active command panel */}
      {renderCommandPanel()}

      <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <Target className="size-3.5 shrink-0 text-primary" />
        <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        Guard stack: liquidity floor $5k → buyable flag → daily snipe target (
        {dailySnipeLimit === 0 ? "∞" : dailySnipeLimit}/day) → execution. Signals are the shared copier pipeline's real
        channel messages — nothing is simulated. Paper fills record against the terminal trail in SOL.
      </div>
    </div>
  );
}

/* ─── Shared command-panel card ─── */
function CommandCard({ cmd, onClose, children }: { cmd: string; onClose: () => void; children: React.ReactNode }) {
  const def = COMMANDS.find((c) => c.cmd === cmd);
  return (
    <Card className="border-border/70 bg-card/40">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {def?.icon}
            <CardTitle className="text-sm font-bold">/{cmd} — {def?.label}</CardTitle>
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
            <Eye className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}
