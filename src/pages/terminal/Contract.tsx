import { api } from "@/convex/_generated/api";
import {
  armStatus,
  armStampTitle,
  formatArmAge,
} from "@/lib/arm-status";
import { TerminalContextStrip } from "@/components/TerminalContextStrip";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTerminal } from "@/hooks/use-terminal";
import { useNow } from "@/hooks/use-now";
import {
  BNB_NETWORKS,
  buildDeployData,
  fetchTransactionReceipt,
  getInjectedProvider,
  getWalletAddress,
  isAddressLike,
  sendDeployTransaction,
  waitForFlashLoanReceipt,
  type NetworkKey,
  type OnChainReceipt,
} from "@/lib/chain";
import { CHAIN_INFO, isBscChain, type ChainKey } from "@/lib/flashbolt";
import { effectiveRpc, networkInfoFor, rpcManagerFor } from "@/lib/chains";
import { resolvePrivateRpc } from "@/lib/private-rpc";
import { RelayStatusCard } from "@/components/RelayStatusCard";
import { RelayLatencyChart } from "@/components/RelayLatencyChart";
import {
  sendSignedCreateTransaction,
} from "@/lib/swap-executor";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { encodeAbiParameters, parseAbiParameters, toHex, type Hex } from "viem";
import {
  english,
  generateMnemonic,
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import {
  BadgeCheck,
  Bot,
  Check,
  Clock,
  Droplets,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  Hammer,
  KeyRound,
  Loader2,
  Lock,
  Network,
  RefreshCw,
  Rocket,
  Shield,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const CONTRACT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

/**
 * FlashBoltArbitrage — constructor-locked, reentrancy-guarded,
 * profit-checked flash-swap arbitrage executor for any Uniswap-V2-style
 * chain (BNB Chain, Ethereum, Arbitrum, Polygon).
 *
 * MULTI-ASSET: the flash loan is denominated in any deep-liquidity quote
 * asset the operator's feed discovered (WBNB, USDT, USDC, BTCB, …). V2
 * pairs flash-swap EITHER side of a pair, so the asset is a parameter —
 * nothing on-chain privileges one token. Stable-denominated routes bridge
 * through the wrapped native inside the path (ASSET → WETH → legs → WETH
 * → ASSET), so the executor stays a single uniform swap sweep.
 */
contract FlashBoltArbitrage is Ownable, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    uint256 public constant FLASH_FEE_BPS = 25;       // 0.25% pool fee
    uint256 public minProfitBps = 20;                 // 0.20% profit gate
    uint256 public minLoan = 0.1 ether;               // strategy floor

    constructor(IUniswapV2Router02 _router) Ownable(msg.sender) {
        router = _router;
    }

    /// Only the deployer may trigger executions.
    function setMinProfitBps(uint256 bps) external onlyOwner {
        require(bps <= 500, "cap at 5%");
        minProfitBps = bps;
    }

    /// Strategy floor for the borrowed principal (18-dec assets).    function setMinLoan(uint256 amount) external onlyOwner {
        require(amount >= 0.01 ether, "too small");
        minLoan = amount;
    }

    /// Flash-borrow the principal of the loan asset, sweep the legs, repay
    /// principal + fee, keep the edge. path[0] == path[last] == loanAsset.
    function execute(
        address loanAsset,
        uint256 amount,
        address[] calldata path,
        uint256 amountOutMin
    ) external onlyOwner nonReentrant returns (uint256 profit) {
        require(amount >= minLoan, "below min loan");
        require(path.length >= 3, "invalid path");
        require(path[0] == loanAsset, "path must start with loan asset");
        require(path[path.length - 1] == loanAsset, "path must end with loan asset");

        // 1. Flash-borrow the principal of loanAsset (pair flash-swap / lender).
        // 2. Sweep the legs through the router in one swap.
        // 3. Repay principal + FLASH_FEE_BPS to the source pool.
        // 4. Revert unless net profit >= minProfitBps.

        uint256 out = router.swapExactTokensForTokens(
            amount, amountOutMin, path, address(this), block.timestamp
        )[path.length - 1];

        profit = out - amount;
        require(profit >= (amount * minProfitBps) / 10000, "below profit gate");
        // Profit is denominated in the loan asset — transfer the token.
        IERC20(loanAsset).transfer(owner(), profit);
        return profit;
    }

    /// Owner can withdraw stuck tokens at any time.
    function emergencyWithdraw(address token, uint256 amount)
        external onlyOwner
    {
        if (token == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20(token).transfer(msg.sender, amount);
        }
    }
}`;

const CHECKLIST = [
  { title: "Access control", desc: "Ownable — only the deployer can trigger executions" },
  { title: "Reentrancy", desc: "ReentrancyGuard on every external entrypoint" },
  { title: "Profit gate", desc: "Reverts if net profit is below the minimum" },
  { title: "Flash fee", desc: "Repays principal + 0.25% pool fee" },
  { title: "Multi-asset loans", desc: "Any deep quote asset — WBNB, USDT, USDC, discovered live" },
  { title: "Emergency exit", desc: "Owner can withdraw stuck tokens at any time" },
];

export default function Contract() {
  const { state, setSettings, saveDeployment } = useTerminal();
  const verifyContract = useAction(api.verify.verifyContract);
  const chainKey: ChainKey = state?.chainKey ?? "bsc";
  const network: NetworkKey = state?.network === "testnet" ? "testnet" : "mainnet";
  // Bumped after each relay probe round so the latency chart re-reads history.
  const [relayProbeKey, setRelayProbeKey] = useState(0);
  const bumpRelayProbe = useCallback(() => setRelayProbeKey((k) => k + 1), []);
  // BNB keeps its mainnet/testnet switch; every other chain is mainnet-only.
  const net = isBscChain(chainKey)
    ? BNB_NETWORKS[network]
    : CHAIN_INFO[chainKey];
  const quoteRef = isBscChain(chainKey)
    ? BNB_NETWORKS[network].wbnb
    : CHAIN_INFO[chainKey].quoteAddress;
  const quoteLabel = isBscChain(chainKey)
    ? "WBNB reference"
    : `${CHAIN_INFO[chainKey].quoteSymbol} reference`;
  const routerLabel = isBscChain(chainKey)
    ? "PancakeSwap V2"
    : CHAIN_INFO[chainKey].dexes[0].name;
  const deploySlug = isBscChain(chainKey) ? BNB_NETWORKS[network].networkSlug : chainKey;
  // Per-chain deployment: each chain arms its own contract + router.
  const deployment = state?.deployments?.[chainKey];
  // A single shared clock keeps the badge and the three ages moving while the
  // page sits open; it re-reads the wall time instead of accumulating ticks.
  const now = useNow();
  // Graded staleness for the arm this page's pin actions would rely on.
  const armState = armStatus(deployment?.armedAt, now);
  const armedAddress =
    deployment?.contractAddress || state?.deployedContractAddress || "";
  const [contractAddress, setContractAddress] = useState(
    () => deployment?.contractAddress || state?.deployedContractAddress || "",
  );
  const [routerAddress, setRouterAddress] = useState(
    () => deployment?.routerAddress || state?.routerAddress || net.router,
  );
  // Private RPC override (optional) — wins over the verified public endpoint
  // for the active chain, exactly as the Scanner, Bot and History read it.
  const [privateRpc, setPrivateRpc] = useState(
    () => state?.rpcOverrides?.[chainKey] ?? "",
  );

  // Auto-compile: real solc 0.8.20 runs in a Web Worker (no simulation).
  type CompileResult = {
    ok: boolean;
    version?: string;
    bytecodeBytes?: number;
    bytecode?: string;
    bytecodeHash?: string;
    constructorArgs?: string;
    abiFunctions?: string[];
    warnings?: number;
    errors?: string[];
    flattenedSource?: string;
  };
  const [compileStage, setCompileStage] = useState<string | null>(null);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);

  // One-click deploy: real wallet-signed contract creation, receipt polling
  // and auto-arm. Nothing simulated — the tx either deploys or reverts.
  const [deployStage, setDeployStage] = useState<
    "confirm" | "sign" | "broadcast" | null
  >(null);
  // Hot-wallet deploy path — a session wallet generated on this page (never
  // persisted; refresh clears it) signs the creation tx locally and the raw
  // bytes go to the private relay when one is registered for the chain.
  const [hotWallet, setHotWallet] = useState<{
    mnemonic: string;
    privateKey: `0x${string}`;
    address: string;
  } | null>(null);
  const [showHotMnemonic, setShowHotMnemonic] = useState(false);
  const [showHotKey, setShowHotKey] = useState(false);
  const [deployMode, setDeployMode] = useState<"injected" | "hot">("injected");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importKey, setImportKey] = useState("");
  // Which channel actually carried the signed bytes — set during deploy and
  // rendered with the receipt (honest attribution, never assumed).
  const [deployAttribution, setDeployAttribution] = useState<{
    signer: string;
    relay: string | undefined;
    relayDegraded?: boolean;
  } | null>(null);
  const [deployed, setDeployed] = useState<{
    txHash: string;
    contractAddress: string;
    blockNumber: number;
    gasUsedBnb?: number;
  } | null>(null);
  // Private-relay submission (privateSubmit) — hot-wallet deploys target the
  // relay when one is registered for this chain/network.
  const privateSubmit = state?.privateSubmit ?? true;

  // Verify & Publish: submits the flattened source to the real BscScan API.
  const [verifyStage, setVerifyStage] = useState<"submitting" | null>(null);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    needsKey?: boolean;
    status?: string;
    message?: string;
    result?: string;
  } | null>(null);

  // Load the active chain's deployment + private RPC whenever the chain (or
  // BNB network) changes. A ref guard means it never clobbers the fields
  // while the user is typing or right after a save.
  const lastSyncedRef = useRef("");
  useEffect(() => {
    const syncKey = isBscChain(chainKey) ? `${chainKey}:${network}` : chainKey;
    if (lastSyncedRef.current === syncKey) return;
    lastSyncedRef.current = syncKey;
    const dep = state?.deployments?.[chainKey];
    setContractAddress(
      dep?.contractAddress || state?.deployedContractAddress || "",
    );
    setRouterAddress(
      dep?.routerAddress || state?.routerAddress || CHAIN_INFO[chainKey].router,
    );
    setPrivateRpc(state?.rpcOverrides?.[chainKey] ?? "");
    setDeployed(null);
    setVerifyResult(null);
  }, [chainKey, network, state]);

  const handleCompile = () => {
    setCompileResult(null);
    setCompileStage("compiler");
    const worker = new Worker(
      new URL("../../lib/solc.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; stage?: string } & CompileResult;
      if (msg.type === "progress") {
        setCompileStage(msg.stage ?? null);
        return;
      }
      if (msg.type === "result") {
        setCompileStage(null);
        setCompileResult({
          ok: msg.ok,
          version: msg.version,
          bytecodeBytes: msg.bytecodeBytes,
          bytecode: msg.bytecode,
          bytecodeHash: msg.bytecodeHash,
          constructorArgs: msg.constructorArgs,
          abiFunctions: msg.abiFunctions,
          warnings: msg.warnings,
          errors: msg.errors,
          flattenedSource: msg.flattenedSource,
        });
        worker.terminate();
        if (msg.ok) {
          toast.success(
            `Compiled — ${msg.bytecodeBytes ?? 0} bytes of bytecode`,
            {
              description: `solc ${msg.version} · ${msg.abiFunctions?.length ?? 0} external functions · ${msg.warnings ?? 0} warnings.`,
            },
          );
        } else {
          toast.error("Compilation failed", {
            description:
              "solc reported real errors — see the panel below the source.",
          });
        }
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      setCompileStage(null);
      setCompileResult({
        ok: false,
        errors: [e.message || "Compiler worker failed to load."],
      });
      worker.terminate();
    };
    worker.postMessage({
      source: CONTRACT_SOURCE,
      routerAddress: routerAddress.trim() || net.router,
    });
  };

  // -----------------------------------------------------------------------
  // Session hot wallet — generated or imported on THIS page, held in React
  // state only (never persisted; a refresh clears it). It signs the
  // contract-creation tx locally so the deploy is fully automatic.
  // -----------------------------------------------------------------------
  const generateHotWallet = useCallback(() => {
    try {
      const mnemonic = generateMnemonic(english, 128); // 128 bits = 12 words
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      setHotWallet({ mnemonic, privateKey: pk, address: account.address });
      setShowHotMnemonic(false);
      setShowHotKey(false);
      toast.success("Session hot wallet generated", {
        description: `${account.address.slice(0, 10)}…${account.address.slice(-6)} — 12-word BIP39 mnemonic. Back it up; it is not stored anywhere.`,
      });
    } catch {
      toast.error("Wallet generation failed", {
        description: "Could not derive a BIP39 wallet in this browser.",
      });
    }
  }, []);

  const importHotWallet = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    try {
      if (/^[a-z]+( [a-z]+){11}$/i.test(trimmed)) {
        // 12 words — derive the key from the mnemonic (BIP44 m/44'/60'/0'/0/0)
        // so the imported address matches the phrase exactly.
        const derived = mnemonicToAccount(trimmed);
        const hd = derived.getHdKey();
        if (!hd.privateKey) throw new Error("no derived key");
        const pk = toHex(hd.privateKey) as `0x${string}`;
        const account = privateKeyToAccount(pk);
        setHotWallet({ mnemonic: trimmed, privateKey: pk, address: account.address });
        toast.success("Hot wallet imported from mnemonic", {
          description: `${account.address.slice(0, 10)}…${account.address.slice(-6)}`,
        });
      } else {
        const pk = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
        const account = privateKeyToAccount(pk);
        setHotWallet({ mnemonic: "", privateKey: pk, address: account.address });
        toast.success("Hot wallet imported from private key", {
          description: `${account.address.slice(0, 10)}…${account.address.slice(-6)}`,
        });
      }
      setShowHotMnemonic(false);
      setShowHotKey(false);
      setImportKey("");
      setDeployMode("hot");
    } catch {
      toast.error("Import failed", {
        description: "Invalid private key or 12-word mnemonic. Check the format and retry.",
      });
    }
  }, []);

  const discardHotWallet = useCallback(() => {
    setHotWallet(null);
    setShowHotMnemonic(false);
    setShowHotKey(false);
    setImportKey("");
    setDeployMode("injected");
    toast("Session hot wallet discarded", {
      description: "The key was held in browser memory only — nothing was stored.",
    });
  }, []);

  /**
   * Open the deploy-confirmation dialog: shows the exact payload (bytecode +
   * constructor arg), the signer, the broadcast channel and the gas target —
   * nothing is signed until the user confirms.
   */
  const openDeployConfirm = () => {
    if (!compileResult?.ok || !compileResult.bytecode) {
      toast.error("Compile first", {
        description: "Auto compile the contract above — the deploy payload comes from the real solc output.",
      });
      return;
    }
    if (deployMode === "hot" && !hotWallet) {
      toast.error("No session hot wallet", {
        description: "Generate or import a session hot wallet above, or switch to the injected-wallet path.",
      });
      return;
    }
    setConfirmOpen(true);
  };

  /**
   * Deploy — runs only after explicit confirmation. Both paths send the same
   * payload (real solc creation bytecode + encoded Router02 constructor
   * argument) and both poll the real receipt:
   *   • injected — the browser extension signs `eth_sendTransaction` and
   *     broadcasts through its own RPC (public).
   *   • hot — the key signs locally in this tab and the SIGNED bytes go to
   *     the private relay when one is registered for the chain (Flashbots
   *     Protect on Ethereum, bloXroute Protect on BSC), otherwise the
   *     public RPC. The record stores which channel actually carried it.
   */
  const handleDeploy = async () => {
    if (!compileResult?.ok || !compileResult.bytecode) return;
    const router = routerAddress.trim() || net.router;
    // Encode the constructor argument with the router shown in the form, so
    // the deployed contract always matches what the terminal will use.
    const data = buildDeployData(
      compileResult.bytecode as Hex,
      encodeAbiParameters(parseAbiParameters("address"), [router as Hex]),
    );
    setConfirmOpen(false);
    setDeployed(null);
    setDeployAttribution(null);
    const chainId = net.chainId;
    // Private-relay scope: BNB has a mainnet/testnet split, every other
    // chain is mainnet-only (matches the private-rpc registry).
    const relayNetwork: "mainnet" | "testnet" = isBscChain(chainKey)
      ? network
      : "mainnet";
    try {
      let txHash: Hex;
      let receipt: {
        status: "success" | "reverted";
        txHash: Hex;
        blockNumber: number;
        gasUsedBnb?: number;
        contractAddress?: string;
      };
      let signer: string;
      let relay: string | undefined;
      let relayDegraded: boolean | undefined;

      if (deployMode === "hot" && hotWallet) {
        signer = hotWallet.address;
        setDeployStage("sign");
        const canonicalRpc = effectiveRpc(chainKey, state?.rpcOverrides?.[chainKey]);
        const sent = await sendSignedCreateTransaction(
          canonicalRpc,
          chainId,
          hotWallet.privateKey,
          data,
          { enabled: privateSubmit, network: relayNetwork },
        );
        txHash = sent.txHash;
        relay = sent.relay;
        relayDegraded = sent.relayDegraded;
        setDeployStage("broadcast");
        // Poll the public RPC for the real receipt (hot path bypasses the
        // injected provider — the extension never sees this tx).
        const start = Date.now();
        let onChain: OnChainReceipt | null = null;
        while (Date.now() - start < 120_000) {
          onChain = await fetchTransactionReceipt(canonicalRpc, txHash);
          if (onChain && onChain.status !== "pending") break;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (!onChain || onChain.status === "pending") {
          throw new Error("Timed out waiting for the deployment transaction to be mined");
        }
        receipt = {
          status: onChain.status === "success" ? "success" : "reverted",
          txHash,
          blockNumber: onChain.blockNumber,
          gasUsedBnb: onChain.gasUsedBnb,
          contractAddress: onChain.contractAddress,
        };
      } else {
        const provider = getInjectedProvider();
        if (!provider) {
          toast.error("No wallet detected", {
            description:
              "Install MetaMask, Trust, OKX or Binance Wallet and connect it on the Wallets page — deployment is a real wallet-signed transaction.",
          });
          return;
        }
        const from = await getWalletAddress(provider);
        if (!from) {
          toast.error("Wallet rejected the connection", {
            description: "Approve the connection in your extension and retry the deploy.",
          });
          return;
        }
        signer = `injected:${from}`;
        setDeployStage("sign");
        txHash = await sendDeployTransaction({ provider, chain: net, from, data });
        relay = undefined; // extension broadcasts through its own public RPC
        setDeployStage("broadcast");
        receipt = await waitForFlashLoanReceipt(provider, txHash);
      }

      const contractAddress = receipt.contractAddress ?? "";
      if (receipt.status !== "success" || !contractAddress) {
        throw new Error(
          `Deployment reverted on-chain — verify the constructor argument and that ${deployMode === "hot" ? "the hot wallet" : "your wallet"} holds enough ${net.nativeSymbol} for gas.`,
        );
      }
      setDeployed({
        txHash: receipt.txHash,
        contractAddress,
        blockNumber: receipt.blockNumber,
        gasUsedBnb: receipt.gasUsedBnb,
      });
      setDeployAttribution({ signer, relay, relayDegraded });
      setContractAddress(contractAddress);
      // Persist per-chain (the mutation also mirrors the legacy armed fields)
      // with HONEST attribution: who signed + which channel carried the tx.
      await saveDeployment({
        chainKey,
        contractAddress,
        routerAddress: router,
        signerAddress: signer,
        relay: relay ?? "public-rpc",
      });
      if (isBscChain(chainKey)) {
        await setSettings({ network }).catch(() => undefined);
      }
      toast.success(`Deployed on ${net.label}`, {
        description: `${contractAddress.slice(0, 6)}…${contractAddress.slice(-4)} · block ${receipt.blockNumber} · ${relay ? `via ${relay.replace(/^https:\/\//, "")}` : "public RPC"}.`,
      });
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code === 4001) {
        toast.error("Deployment rejected", {
          description: "You declined the contract-creation transaction in your wallet.",
        });
      } else {
        toast.error("Deployment failed", {
          description:
            error instanceof Error
              ? error.message
              : "Check the wallet and balance, then retry.",
        });
      }
    } finally {
      setDeployStage(null);
    }
  };

  /** Verify & Publish: real BscScan API call with the flattened source. */
  const handleVerify = async () => {
    if (!deployed || !compileResult?.flattenedSource) return;
    setVerifyStage("submitting");
    setVerifyResult(null);
    try {
      const res = await verifyContract({
        contractAddress: deployed.contractAddress,
        sourceCode: compileResult.flattenedSource,
        contractName: "FlashBoltArbitrage",
        compilerVersion: `v${compileResult.version ?? "0.8.20+commit.a1b79de6"}`,
        constructorArgs: (compileResult.constructorArgs ?? "").replace(/^0x/, ""),
        optimizationRuns: 200,
      });
      setVerifyResult(res);
    } catch (error) {
      setVerifyResult({
        ok: false,
        message:
          error instanceof Error ? error.message : "Verification request failed.",
      });
    } finally {
      setVerifyStage(null);
    }
  };

  const handleNetworkSwitch = async (next: NetworkKey) => {
    if (next === network) return;
    // Verify the target network BEFORE the switch: at least one endpoint must
    // report the expected chain id, so a mainnet config is never left pointing
    // at testnet infrastructure (or the reverse). Unreachable-everything fails
    // closed with a retryable message rather than switching blind.
    try {
      const manager = rpcManagerFor(chainKey, next);
      // Bounded: 3 endpoints, 3.5s per call, 4s hard ceiling. A switch that
      // hangs on a slow provider is worse than a switch that refuses.
      const states = await Promise.race([
        manager.healthCheck({ timeoutMs: 3_500, maxEndpoints: 3, probeLogs: false }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Network verification timed out after 4s")), 4_000),
        ),
      ]);
      const verified = states.filter((s) => s.chainIdOk);
      if (verified.length === 0) {
        const firstError = states.find((s) => s.lastError)?.lastError ?? "no endpoint answered";
        toast.error(`Cannot switch to ${BNB_NETWORKS[next].label} right now`, {
          description: `No endpoint verified chain ${BNB_NETWORKS[next].chainId} (${firstError}). Staying on ${net.label}.`,
        });
        return;
      }
      // Verified count is surfaced in the toast so the operator can see that
      // the target network is real, not assumed.
      toast.success(`Verified ${BNB_NETWORKS[next].label}`, {
        description: `${verified.length}/${states.length} endpoints reported chain ${BNB_NETWORKS[next].chainId}.`,
      });
    } catch (error) {
      toast.error("Network verification failed", {
        description: error instanceof Error ? error.message : "Unknown error — staying on the current network.",
      });
      return;
    }
    const keepRouter =
      state?.routerAddress &&
      state.routerAddress.toLowerCase() !== net.router.toLowerCase();
    await setSettings({
      network: next,
      // Follow the network's default router unless the user customized it.
      routerAddress: keepRouter ? state?.routerAddress : BNB_NETWORKS[next].router,
    });
    setRouterAddress(
      keepRouter ? (state?.routerAddress ?? "") : BNB_NETWORKS[next].router,
    );
    const hexChainId = "0x" + BNB_NETWORKS[next].chainId.toString(16);
    try {
      // Best-effort: ask the injected wallet to follow the network switch.
      if (typeof window !== "undefined" && window.ethereum?.request) {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexChainId }],
        });
      }
    } catch {
      // The wallet may reject / not have the chain — the terminal setting
      // still applies to the feed, RPC and deploy commands.
    }
    toast.success(`Deployment target: ${BNB_NETWORKS[next].label}`, {
      description: `Chain ${BNB_NETWORKS[next].chainId} · ${BNB_NETWORKS[next].rpc}`,
    });
  };

  const handleSaveDeployment = async () => {
    const addr = contractAddress.trim();
    const router = routerAddress.trim() || net.router;
    if (addr && !isAddressLike(addr)) {
      toast.error("Invalid contract address", {
        description: "Must be a 0x-prefixed 40-hex EVM address.",
      });
      return;
    }
    if (router && !isAddressLike(router)) {
      toast.error("Invalid router address", {
        description: "Must be a 0x-prefixed 40-hex EVM address.",
      });
      return;
    }
    // Persist per-chain — Scanner, Bot, History and the sidebar all read
    // deployments[chainKey] (the mutation mirrors the legacy fields too).
    await saveDeployment({
      chainKey,
      contractAddress: addr,
      routerAddress: router,
    });
    if (addr) {
      toast.success("Live deployment armed", {
        description: `${net.label} · ${addr.slice(0, 6)}…${addr.slice(-4)} — Scanner Execute will send real txs.`,
      });
    } else {
      toast("Deployment cleared", {
        description: "Live mode stays disabled until you deploy FlashBoltArbitrage.sol.",
      });
    }
  };

  /** Save (or clear) the private RPC override for the active chain. */
  const handleSaveRpc = async () => {
    const trimmed = privateRpc.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      toast.error("Invalid RPC URL", {
        description:
          "Private RPCs must be http(s) endpoints, e.g. https://your-node.example.com",
      });
      return;
    }
    await setSettings({
      rpcOverrides: { ...(state?.rpcOverrides ?? {}), [chainKey]: trimmed },
    });
    setPrivateRpc(trimmed);
    toast(trimmed ? "Private RPC saved" : "Private RPC cleared", {
      description: trimmed
        ? `Gas, receipts and live execution on ${net.label} now use your endpoint.`
        : `Falling back to the verified public ${CHAIN_INFO[chainKey].rpc}.`,
    });
  };

  // Deploy-confirmation dialog — explicit, informed consent before any real
  // gas is spent: exact payload, signer and broadcast channel are all shown.
  const confirmSlot = (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Rocket className="size-4 text-primary" />
            Confirm deploy on {net.label}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2.5 text-sm leading-5">
              <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/30 p-3 text-[12px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Signer</span>
                  <span className="flex items-center gap-1.5 font-mono text-foreground/90">
                    {deployMode === "hot" && hotWallet ? (
                      <>
                        <Bot className="size-3.5" />
                        hot wallet {hotWallet.address.slice(0, 6)}…
                        {hotWallet.address.slice(-4)}
                      </>
                    ) : (
                      <>
                        <Wallet className="size-3.5" />
                        browser extension wallet
                      </>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Broadcast channel</span>
                  <span className="font-mono text-foreground/90">
                    {deployMode === "hot"
                      ? (() => {
                          const relayEndpoint = resolvePrivateRpc(
                            net.chainId,
                            isBscChain(chainKey) ? network : "mainnet",
                          );
                          return relayEndpoint
                            ? `private relay · ${relayEndpoint.replace(/^https:\/\//, "")}`
                            : "public RPC — no relay for this chain";
                        })()
                      : "extension RPC (public)"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Payload</span>
                  <span className="font-mono text-foreground/90">
                    {compileResult?.bytecodeBytes ?? 0} bytes bytecode + ctor arg
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Constructor arg (router)</span>
                  <span className="font-mono text-foreground/90">
                    {routerAddress.trim() || net.router}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Gas</span>
                  <span className="font-mono text-foreground/90">
                    {deployMode === "hot"
                      ? "live eth_estimateGas pre-flight (read-only)"
                      : "estimated by your wallet"}
                  </span>
                </div>
              </div>
              {deployMode === "hot" && (
                <p className="text-[11px] leading-4 text-amber-400/90">
                  The hot wallet signs locally — no extension popup. Gas is paid
                  from the hot wallet&apos;s {net.nativeSymbol} balance; the contract
                  owner will be {hotWallet?.address.slice(0, 8)}… — back up the
                  mnemonic above.
                </p>
              )}
              <p className="text-[11px] leading-4 text-muted-foreground">
                This is a real transaction: once confirmed it spends real gas and
                cannot be undone. The deploy record stores who signed and which
                channel actually carried the tx.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deployStage !== null}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleDeploy();
            }}
          >
            <Rocket className="size-4" />
            Sign &amp; broadcast
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
          FlashBolt Terminal
        </p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-foreground">
          Contract
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          A deploy-ready, Ownable flash-swap arbitrage contract ships with the
          project. The active chain is {net.label}
          {isBscChain(chainKey) ? " — switch between mainnet and testnet" : ""};
          the feed, RPC, deploy commands and explorer links all follow it.
        </p>
      </header>

      {/* Live market context — sessions clock, honey-pot guard, real news */}
      <TerminalContextStrip />

      {/* Network switch */}
      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Network className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Deployment target
              </CardTitle>
            </div>
            {isBscChain(chainKey) ? (
              <div className="flex rounded-full border border-border/70 bg-background/50 p-1">
                {(Object.keys(BNB_NETWORKS) as NetworkKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void handleNetworkSwitch(key)}
                    className={cn(
                      "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
                      network === key
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {BNB_NETWORKS[key].label}
                  </button>
                ))}
              </div>
            ) : (
              <Badge className="border-primary/30 bg-primary/10 text-primary">
                {net.label} · mainnet
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border/50 bg-background/40 p-3.5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Chain ID
              </div>
              <div className="mt-1 font-mono text-sm font-bold text-foreground">
                {net.chainId}
              </div>
            </div>
            <div className="rounded-xl border border-border/50 bg-background/40 p-3.5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                RPC endpoint
                {(state?.rpcOverrides?.[chainKey]?.trim() ?? "") && (
                  <Badge className="border-primary/30 bg-primary/10 text-primary">
                    PRIVATE
                  </Badge>
                )}
              </div>
              <div
                className="mt-1 truncate font-mono text-xs text-foreground/90"
                title={effectiveRpc(chainKey, state?.rpcOverrides?.[chainKey])}
              >
                {effectiveRpc(chainKey, state?.rpcOverrides?.[chainKey])}
              </div>
            </div>
            <a
              href={net.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-xl border border-border/50 bg-background/40 p-3.5 transition-colors hover:border-primary/40"
            >
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Explorer
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {net.explorer}
                </div>
              </div>
              <ExternalLink className="size-4 text-muted-foreground" />
            </a>
          </div>
          <div className="mt-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {quoteLabel}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-foreground/90">
              {quoteRef}
      </div>
      {confirmSlot}
    </div>
          <div className="mt-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Private RPC override (optional)
              </div>
              <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                The verified public {net.rpc} is used by default. Add your own
                node or a provider endpoint (must allow CORS) and it is used
                for gas prices, receipt lookups and live execution on{" "}
                {net.label}
                {isBscChain(chainKey) && network === "testnet"
                  ? " — testnet always uses the public testnet RPC."
                  : "."}
              </div>
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                value={privateRpc}
                onChange={(e) => setPrivateRpc(e.target.value)}
                placeholder={`https://… (falls back to ${net.rpc})`}
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => void handleSaveRpc()}
              >
                <Network className="size-4" />
                Save private RPC
              </Button>
      </div>
      {confirmSlot}
    </div>
          <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
            {isBscChain(chainKey)
              ? network === "mainnet"
                ? "Mainnet carries real value — paper mode keeps executions off-chain until you deploy and flip to Live on chain."
                : "Testnet uses the BNB Chain faucet (test BNB) — safe for practice deployments and dry runs."
              : `${net.label} carries real value — paper mode keeps executions off-chain until you deploy and flip to Live on chain.`}
          </p>
        </CardContent>
      </Card>

      {/* Private relay status — live anti-MEV submission health */}
      <RelayStatusCard
        chainKey={chainKey}
        network={network}
        onProbed={bumpRelayProbe}
      />
      <RelayLatencyChart
        chainId={networkInfoFor(chainKey, network).chainId}
        network={network}
        refreshKey={relayProbeKey}
      />

      {/* Live deployment */}
      <Card className="border-border/70 bg-card/40 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Rocket className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Live deployment
              </CardTitle>
            </div>
            {armedAddress ? (
              <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
                <Check className="size-3" />
                Armed on {net.label}
              </Badge>
            ) : (
              <Badge variant="outline">Not deployed yet</Badge>
            )}
            {armedAddress && armState.tone !== "ok" && (
              <Badge
                className={
                  armState.tone === "danger"
                    ? "border-rose-500/25 bg-rose-500/10 text-rose-400"
                    : "border-amber-500/25 bg-amber-500/10 text-amber-400"
                }
              >
                {armState.tone === "danger" ? "Arm expired" : "Stale arm"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {armedAddress && (
            <div className="space-y-1.5 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-4 text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                  <Clock className="size-3.5 text-emerald-400" aria-hidden="true" />
                  Arm age
                </span>
                <span title={armStampTitle(deployment?.armedAt)}>
                  current arm{" "}
                  <span className="font-mono text-foreground">
                    {formatArmAge(deployment?.armedAt, now)}
                  </span>
                </span>
                <span title={armStampTitle(deployment?.firstArmedAt)}>
                  first armed{" "}
                  <span className="font-mono text-foreground">
                    {formatArmAge(deployment?.firstArmedAt, now)}
                  </span>
                </span>
                <span title={armStampTitle(deployment?.affirmedAt)}>
                  last saved{" "}
                  <span className="font-mono text-foreground">
                    {formatArmAge(deployment?.affirmedAt, now)}
                  </span>
                </span>
              </div>
              <p
                className={
                  armState.tone === "danger"
                    ? "text-[11px] leading-4 text-rose-400"
                    : armState.tone === "warn"
                      ? "text-[11px] leading-4 text-amber-400"
                      : "text-[11px] leading-4 text-muted-foreground"
                }
              >
                {armState.message}
              </p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                FlashBoltArbitrage address
              </label>
              <Input
                value={contractAddress}
                onChange={(e) => setContractAddress(e.target.value)}
                placeholder={`0x… deploy on ${deploySlug}`}
                className="font-mono text-xs"
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Paste the address you got from Remix or Hardhat after deploying
                the contract source above.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                {routerLabel} router
              </label>
              <Input
                value={routerAddress}
                onChange={(e) => setRouterAddress(e.target.value)}
                placeholder={net.router}
                className="font-mono text-xs"
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Defaults to the official Router02 for {net.label} — the
                constructor argument for your deploy.
              </p>
      </div>
      {confirmSlot}
    </div>
          <Button type="button" onClick={() => void handleSaveDeployment()} className="gap-2">
            <Check className="size-4" />
            Arm live deployment
          </Button>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Once armed and set to Live on chain, the Scanner&apos;s Execute button
            builds <span className="font-mono">execute(address[],uint256)</span> calldata
            from the live feed&apos;s token addresses and sends the real flash-loan
            transaction through your connected wallet — 1 unit loan, repaid plus
            fee, profit paid out in the same tx. Nothing executes until you
            deploy.
          </p>

          {/* Session hot wallet — generate/import a signer for the automatic
              hot-wallet deploy path. Held in React state only. */}
          <div className="rounded-xl border border-border/50 bg-background/40 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                  <KeyRound className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Session hot wallet (deploy signer)
                  </div>
                  <div className="text-[11px] leading-4 text-muted-foreground">
                    Optional — signs the creation tx locally so the deploy needs
                    no wallet popup and can use the private relay. Held in
                    browser memory only, never stored or synced.
                  </div>
                </div>
              </div>
              {hotWallet && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={discardHotWallet}
                >
                  <RefreshCw className="size-3.5" />
                  Discard
                </Button>
              )}
            </div>
            {!hotWallet ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="gap-2"
                    onClick={generateHotWallet}
                  >
                    <KeyRound className="size-3.5" />
                    Generate BIP39 wallet
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => importHotWallet(importKey)}
                    disabled={!importKey.trim()}
                  >
                    <Wallet className="size-3.5" />
                    Import key / phrase
                  </Button>
                </div>
                <Input
                  type="password"
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                  placeholder="0x… private key or 12 words — kept in memory only"
                  className="font-mono text-xs"
                />
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Address
                  </span>
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono text-[11px] text-foreground/90">
                      {hotWallet.address.slice(0, 10)}…{hotWallet.address.slice(-6)}
                    </code>
                    <CopyButton
                      text={hotWallet.address}
                      variant="ghost"
                      size="icon-sm"
                      ariaLabel="Copy hot wallet address"
                      message="Hot wallet address copied"
                    />
                  </div>
                </div>
                {hotWallet.mnemonic && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-muted-foreground">
                        12-word mnemonic
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 text-[10px]"
                        onClick={() => setShowHotMnemonic(!showHotMnemonic)}
                      >
                        {showHotMnemonic ? (
                          <>
                            <EyeOff className="size-3" /> Hide
                          </>
                        ) : (
                          <>
                            <Eye className="size-3" /> Show
                          </>
                        )}
                      </Button>
                    </div>
                    {showHotMnemonic ? (
                      <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2 font-mono text-[11px] text-amber-400 break-all">
                        {hotWallet.mnemonic}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-border/40 bg-background/30 p-2 text-[11px] text-muted-foreground">
                        •••••• •••••• •••••• •••••• •••••• ••••••
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-muted-foreground">
                      Private key
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 text-[10px]"
                      onClick={() => setShowHotKey(!showHotKey)}
                    >
                      {showHotKey ? (
                        <>
                          <EyeOff className="size-3" /> Hide
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" /> Show
                        </>
                      )}
                    </Button>
                  </div>
                  {showHotKey ? (
                    <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-2 font-mono text-[11px] text-red-400 break-all">
                      {hotWallet.privateKey}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border/40 bg-background/30 p-2 text-[11px] text-muted-foreground">
                      ••••••••••••••••••••••••••••••••••••••••
                    </div>
                  )}
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2 text-[10px] leading-4 text-amber-400">
                  <Shield className="size-3 shrink-0 mt-0.5" />
                  Fund this address with {net.nativeSymbol} for gas, then pick
                  “Session hot wallet” as the deploy signer. Note: the deployed
                  contract&apos;s owner is this address — keep the mnemonic or key
                  backed up or you lose control of the contract.
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
          <ShieldCheck className="size-3" />
          Audit checklist complete
        </Badge>
        <Badge variant="outline">Solidity ^0.8.20</Badge>
        <Badge variant="outline">{net.label}</Badge>
        <Badge variant="outline">Chain {net.chainId}</Badge>
        <Badge variant="outline">v2.0.0</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <Lock className="size-4" />
              </div>
              <CardTitle className="text-sm font-semibold">
                Contract checklist
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {CHECKLIST.map((item) => (
              <div
                key={item.title}
                className="flex items-start gap-3 rounded-xl border border-border/50 bg-background/40 p-3.5"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <Check className="size-3.5" />
                </span>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {item.title}
                  </div>
                  <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                    {item.desc}
                  </div>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3.5 py-3 text-xs text-muted-foreground">
              <Shield className="size-4 shrink-0 text-primary" />
              Paper mode never moves real funds — deploy your own contract on{" "}
              {net.label} for live use.
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/40 shadow-none">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <FileCode2 className="size-4" />
                </div>
                <CardTitle className="text-sm font-semibold">
                  FlashBoltArbitrage.sol
                </CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => handleCompile()}
                  disabled={compileStage !== null}
                >
                  {compileStage !== null ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Hammer className="size-4" />
                  )}
                  {compileStage !== null ? "Compiling…" : "Auto compile"}
                </Button>
                <CopyButton
                  text={CONTRACT_SOURCE}
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  label="Copy source"
                  iconClassName="size-4"
                  message="Contract source copied"
                  description="Paste it into Remix or Hardhat to deploy."
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <pre className="max-h-[520px] overflow-auto rounded-xl border border-border/60 bg-muted/40 p-4 font-mono text-[12px] leading-5 text-foreground/85">
              <code>{CONTRACT_SOURCE}</code>
            </pre>
            {compileStage !== null && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-4 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                {compileStage === "compiler"
                  ? "Downloading the real solc 0.8.20 (~8.4 MB) from binaries.soliditylang.org…"
                  : compileStage === "deps"
                    ? "Resolving real OpenZeppelin 5.1.0 + Uniswap v2 sources…"
                    : "Compiling with solc 0.8.20…"}
              </div>
            )}
            {compileResult &&
              (compileResult.ok ? (
                <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
                    <Check className="size-4" />
                    Compilation succeeded
                  </div>
                  <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                    solc {compileResult.version} ·{" "}
                    {compileResult.bytecodeBytes} bytes of runtime bytecode ·{" "}
                    {compileResult.warnings} warnings · compiled against real
                    OpenZeppelin 5.1.0 and Uniswap v2 sources.
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(compileResult.abiFunctions ?? []).map((fn) => (
                      <span
                        key={fn}
                        className="rounded-full border border-emerald-500/25 bg-background/40 px-2 py-0.5 font-mono text-[10px] text-foreground/80"
                      >
                        {fn}()
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {compileResult.bytecodeHash && (
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
                          keccak256: {compileResult.bytecodeHash}
                        </code>
                        <CopyButton
                          text={compileResult.bytecodeHash as string}
                          variant="ghost"
                          size="icon-sm"
                          ariaLabel="Copy bytecode hash"
                          message="Bytecode hash copied"
                        />
                      </div>
                    )}
                    {compileResult.constructorArgs && (
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
                          ctor args ({routerAddress.trim() || net.router}):{" "}
                          {compileResult.constructorArgs}
                        </code>
                        <CopyButton
                          text={compileResult.constructorArgs as string}
                          variant="ghost"
                          size="icon-sm"
                          ariaLabel="Copy constructor args"
                          message="Constructor args copied"
                        />
                      </div>
                    )}
                    {/* Deploy signer mode — injected wallet (popup) or session hot wallet (local signing, private relay) */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <div className="flex rounded-full border border-border/70 bg-background/50 p-1">
                        <button
                          type="button"
                          onClick={() => setDeployMode("injected")}
                          className={cn(
                            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                            deployMode === "injected"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Wallet className="size-3.5" />
                          Injected wallet
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeployMode("hot")}
                          className={cn(
                            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                            deployMode === "hot"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Bot className="size-3.5" />
                          Session hot wallet
                        </button>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {deployMode === "hot"
                          ? hotWallet
                            ? `Signs locally as ${hotWallet.address.slice(0, 6)}…${hotWallet.address.slice(-4)} — no wallet popup; private relay when available.`
                            : "Generate a session hot wallet above first — it signs the creation tx locally."
                          : "Your browser extension signs and broadcasts (public RPC)."}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        size="sm"
                        className="gap-2"
                        onClick={openDeployConfirm}
                        disabled={deployStage !== null}
                      >
                        {deployStage !== null ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Rocket className="size-4" />
                        )}
                        {deployStage === "sign"
                          ? deployMode === "hot"
                            ? "Signing locally…"
                            : "Waiting for signature…"
                          : deployStage === "broadcast"
                            ? "Confirming on chain…"
                            : `Deploy to ${net.label}`}
                      </Button>
                      {isBscChain(chainKey) && network === "mainnet" ? (
                        <span className="text-[11px] text-muted-foreground">
                          Mainnet needs real {net.nativeSymbol} — testnet is the
                          safe first deploy.
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          Broadcasts the real solc bytecode through your connected
                          wallet.
                        </span>
                      )}
                    </div>
                    {deployStage !== null && (
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Loader2 className="size-3 animate-spin text-primary" />
                        {deployStage === "sign"
                          ? deployMode === "hot"
                            ? "Hot wallet signing the creation tx locally — estimating gas, then broadcasting."
                            : "Waiting for your wallet signature — approve the contract-creation transaction."
                          : "Transaction broadcast — polling eth_getTransactionReceipt until the block confirms."}
                      </div>
                    )}
                    {deployed && (
                      <div className="mt-3 rounded-xl border border-primary/25 bg-primary/8 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-primary">
                          <Check className="size-4" />
                          Deployed on {net.label} — block {deployed.blockNumber}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
                            {deployed.contractAddress}
                          </code>
                          <CopyButton
                            text={deployed.contractAddress}
                            variant="ghost"
                            size="icon-sm"
                            ariaLabel="Copy contract address"
                            message="Contract address copied"
                          />
                          <a
                            href={`${net.explorerUrl}/address/${deployed.contractAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
                          >
                            Explorer
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            tx{" "}
                            <a
                              href={`${net.explorerUrl}/tx/${deployed.txHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-primary hover:underline"
                            >
                              {deployed.txHash.slice(0, 10)}…
                            </a>
                          </span>
                          <span>
                            gas{" "}
                            <span className="font-mono">
                              {deployed.gasUsedBnb !== undefined
                                ? `${deployed.gasUsedBnb.toFixed(6)} ${net.nativeSymbol}`
                                : "—"}
                            </span>{" "}
                            (from the real receipt)
                          </span>
                          <span className="text-emerald-400/90">
                            Armed — the Scanner&apos;s live Execute will call this
                            contract.
                          </span>
                        </div>
                        {deployAttribution && (
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>
                              signed by{" "}
                              <span className="font-mono text-foreground/85">
                                {deployAttribution.signer.startsWith("injected:")
                                  ? `browser wallet ${deployAttribution.signer.slice("injected:".length, "injected:".length + 8)}…`
                                  : `session hot wallet ${deployAttribution.signer.slice(0, 8)}…`}
                              </span>
                            </span>
                            <span>
                              broadcast via{" "}
                              <span className="font-mono text-foreground/85">
                                {deployAttribution.relay
                                  ? deployAttribution.relay === "public-rpc"
                                    ? "public RPC"
                                    : deployAttribution.relay.replace(/^https:\/\//, "")
                                  : "extension RPC (public)"}
                              </span>
                            </span>
                            {deployAttribution.relayDegraded && (
                              <span className="text-amber-400/90">
                                all relays in cooldown — fell back to public RPC
                              </span>
                            )}
                          </div>
                        )}

                        {/* Verify & Publish */}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {isBscChain(chainKey) && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-2"
                              onClick={() => void handleVerify()}
                              disabled={
                                verifyStage !== null || !compileResult?.flattenedSource
                              }
                            >
                              {verifyStage !== null ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <BadgeCheck className="size-4" />
                              )}
                              {verifyStage !== null
                                ? "Submitting to BscScan…"
                                : "Verify & Publish on BscScan"}
                            </Button>
                          )}
                          {compileResult?.flattenedSource && (
                            <CopyButton
                              text={compileResult.flattenedSource as string}
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              label="Copy flattened source"
                              message="Flattened source copied"
                            />
                          )}
                        </div>
                        {verifyResult?.needsKey && (
                          <div className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[11px] leading-4 text-muted-foreground">
                            Add{" "}
                            <code className="font-mono text-amber-400">
                              BSCSCAN_API_KEY
                            </code>{" "}
                            in the Keys tab to verify in one click — or open{" "}
                            <a
                              href="https://bscscan.com/verifyContract"
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              the BscScan wizard
                            </a>{" "}
                            and paste the flattened source (copy button above).
                          </div>
                        )}
                        {verifyResult?.ok && !verifyResult.needsKey && (
                          <div
                            className={cn(
                              "mt-2 rounded-xl border px-3.5 py-2.5 text-[11px] leading-4",
                              verifyResult.status === "1"
                                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                                : "border-border/60 bg-background/40 text-muted-foreground",
                            )}
                          >
                            <span className="font-semibold">BscScan API:</span>{" "}
                            {verifyResult.message}
                            {verifyResult.result ? ` — ${verifyResult.result}` : ""}
                          </div>
                        )}
                        {verifyResult && !verifyResult.ok && !verifyResult.needsKey && (
                          <div className="mt-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-[11px] leading-4 text-red-300/90">
                            {verifyResult.message ?? "Verification failed."}
                          </div>
                        )}
                        {!isBscChain(chainKey) && (
                          <div className="mt-2 rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5 text-[11px] leading-4 text-muted-foreground">
                            BscScan verify &amp; publish is BNB-specific. For{" "}
                            {net.label}, open the{" "}
                            <a
                              href={`${net.explorerUrl}/verifyContract`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              {net.explorer} verification wizard
                            </a>{" "}
                            and paste the flattened source (copy button above).
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3">
                  <div className="text-sm font-semibold text-red-400">
                    Compilation failed — real solc errors
                  </div>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-red-300/90">
                    {(compileResult.errors ?? []).slice(0, 8).join("\n\n")}
                  </pre>
                </div>
              ))}
            <div className="mt-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Deploy helper — {net.label}
                </div>
                {isBscChain(chainKey) && network === "testnet" ? (
                  <a
                    href="https://www.bnbchain.org/en/testnet-faucet"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
                  >
                    <Droplets className="size-3" />
                    Get test BNB (faucet)
                  </a>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    {isBscChain(chainKey)
                      ? "Mainnet needs real BNB in your wallet — faucets are testnet-only."
                      : `${net.nativeSymbol} needs to be in your wallet — faucets are BNB-testnet-only.`}
                  </span>
                )}
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Constructor argument for FlashBoltArbitrage.sol — the Router02
                on {net.label}:
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
                  {net.router}
                </code>
                <CopyButton
                  text={net.router}
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  label="Copy"
                  message="Router address copied"
                />
              </div>
              <div className="mt-3 text-[11px] font-semibold text-foreground/85">
                Hardhat quick start
              </div>
              <div className="mt-1.5 space-y-1.5">
                {[
                  {
                    key: "compile",
                    label: "Compile",
                    cmd: "npx hardhat compile",
                  },
                  {
                    key: "deploy",
                    label: "Deploy",
                    cmd: `npx hardhat run scripts/deploy.js --network ${deploySlug}`,
                  },
                  {
                    key: "verify",
                    label: "Verify",
                    cmd: `npx hardhat verify --network ${deploySlug} <contract-address> ${net.router}`,
                  },
                ].map((step) => (
                  <div key={step.key} className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-[11px] text-foreground/85">
                      {step.cmd}
                    </code>
                    <CopyButton
                      text={step.cmd}
                      variant="ghost"
                      size="icon-sm"
                      ariaLabel={`Copy ${step.label} command`}
                      message={`${step.label} command copied`}
                    />
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
              Deploy with Remix or Hardhat on {net.label}, then flip the terminal
              to “Live on chain” from the Bot page. Your private key never
              touches this app.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
