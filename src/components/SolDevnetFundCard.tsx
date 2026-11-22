/**
 * Devnet funding card — the honest path to test SOL on the SOL terminal.
 *
 * There is no in-app claim: the official faucet is a GitHub-gated web page
 * (up to two requests every eight hours) and the cluster's RPC faucet is
 * closed — `requestAirdrop` answers HTTP 410, which is also why a bare
 * `solana airdrop` against api.devnet.solana.com fails. So this card does the
 * three things the app can actually do:
 *
 *   1. show the address that needs funding (the armed signer, or an honest
 *      "no wallet" state),
 *   2. read its REAL devnet balance over the same RPC execution uses, and
 *   3. link the official faucet and quote its exact limit — never a promise
 *      that the app will fund anything for the operator.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveSolRpcUrl, type SolCluster } from "@/lib/solana-jito";
import { resolveLiveSigner, solRpcCall } from "@/lib/solana-live-execution";
import { Check, Coins, Copy, ExternalLink, RefreshCw, Wallet } from "lucide-react";

/** The official devnet faucet — a web page, not an API. */
export const SOL_DEVNET_FAUCET_URL = "https://faucet.solana.com";
/** Its documented limit, as the faucet states it. */
export const SOL_DEVNET_FAUCET_LIMIT = "up to 2 requests every 8 hours";
/** The exact refusal the cluster RPC returns for `requestAirdrop`. */
export const SOL_RPC_FAUCET_CLOSED =
  'requestAirdrop → HTTP 410 {"code":410,"message":"The RPC faucet is closed on this cluster. Request test SOL at https://faucet.solana.com"}';

const LAMPORTS = 1_000_000_000;

export function SolDevnetFundCard({
  cluster,
  rpcOverride,
}: {
  cluster: SolCluster;
  rpcOverride?: string;
}) {
  const devnet = cluster === "testnet";
  const rpcUrl = resolveSolRpcUrl(cluster, { [cluster]: rpcOverride ?? "" });
  const [address, setAddress] = useState<string | null>(null);
  const [lamports, setLamports] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"address" | "command" | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const read = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const signer = await resolveLiveSigner();
      const owner = signer?.publicKey?.toString() ?? null;
      setAddress(owner);
      if (!owner) {
        setLamports(null);
        return;
      }
      const balance = await solRpcCall<number>(rpcUrl, "getBalance", [owner]);
      setLamports(typeof balance === "number" ? balance : null);
    } catch (err) {
      setLamports(null);
      setError(err instanceof Error ? err.message : "RPC read failed");
    } finally {
      setLoading(false);
    }
  }, [rpcUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled || !devnet) return;
      await read();
    })();
    return () => {
      cancelled = true;
    };
  }, [devnet, read]);

  // Coming back from the faucet page is the moment the balance changes, so
  // re-read it when the tab becomes visible again instead of making the
  // operator guess whether "Re-check balance" is still needed.
  useEffect(() => {
    if (!devnet) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [devnet, read]);

  if (!devnet) return null;

  const sol = lamports === null ? null : lamports / LAMPORTS;
  const cliCommand = address ? `solana airdrop 2 ${address} --url devnet` : null;

  const copy = async (kind: "address" | "command", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 2000);
      toast.success(
        kind === "address" ? "Devnet wallet address copied" : "CLI command copied",
        { description: text },
      );
    } catch {
      toast.error("Copy failed", {
        description: "Your browser blocked clipboard access — select the text instead.",
      });
    }
  };

  return (
    <Card className="border-border/70 bg-card/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Coins className="size-4 text-primary" />
          Devnet SOL funding
          <Badge variant="outline" className="text-[10px]">
            test SOL only
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 font-mono text-[10px]">
          <div className="flex items-start justify-between gap-3">
            <span className="text-muted-foreground">Wallet</span>
            <span className="flex min-w-0 items-start gap-1">
              <span className="break-all text-right text-foreground/90">
                {address ?? "no signer armed — import or connect a wallet"}
              </span>
              {address && (
                <button
                  type="button"
                  aria-label="Copy devnet wallet address"
                  title="Copy address"
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => void copy("address", address)}
                >
                  {copied === "address" ? (
                    <Check className="size-3 text-emerald-400" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              )}
            </span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-muted-foreground">Devnet balance</span>
            <span className="text-right text-foreground/90">
              {loading
                ? "reading…"
                : sol === null
                  ? "unknown"
                  : `${sol.toFixed(4)} SOL`}
            </span>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] leading-4 text-amber-400">
            Balance read failed — {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-7 text-[10px]">
            <a href={SOL_DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">
              Official faucet <ExternalLink className="ml-1 size-3" />
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[10px]"
            disabled={loading}
            onClick={() => void read()}
          >
            <RefreshCw className={loading ? "mr-1 size-3 animate-spin" : "mr-1 size-3"} />
            Re-check balance
          </Button>
          <Badge variant="outline" className="text-[10px]">
            {SOL_DEVNET_FAUCET_LIMIT}
          </Badge>
        </div>

        <p className="text-[10px] leading-4 text-muted-foreground">
          FlashBolt cannot claim devnet SOL for you: the faucet is GitHub-gated in
          the browser, and the cluster&apos;s RPC faucet is closed —{" "}
          <span className="font-mono">{SOL_RPC_FAUCET_CLOSED}</span>. A bare{" "}
          <span className="font-mono">solana airdrop</span> uses that same RPC and
          fails the same way, so the faucet page (or a local validator) is the
          only working path. Nothing here is simulated:{" "}
          {address
            ? "the balance above is a live "
            : "once a wallet is armed, the balance above is a live "}
          <span className="font-mono">getBalance</span> on{" "}
          <span className="font-mono">{rpcUrl}</span>.
        </p>

        <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
          <Wallet className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words font-mono text-[10px] text-muted-foreground">
            {address ? (
              <>
                {"solana airdrop 2 "}
                <span className="break-all">{address}</span>
                {" --url devnet   # only if your RPC still serves the faucet"}
              </>
            ) : (
              "arm a wallet to see the exact CLI command for its address"
            )}
          </span>
          {cliCommand && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 shrink-0 gap-1 px-1.5 text-[10px]"
              aria-label="Copy the solana airdrop command"
              title="Copy command (without the comment)"
              onClick={() => void copy("command", cliCommand)}
            >
              {copied === "command" ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied === "command" ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default SolDevnetFundCard;
