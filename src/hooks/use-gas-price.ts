import { useEffect, useState } from "react";
import { fetchGasPriceGwei } from "@/lib/chain";

/**
 * Live gas price (gwei) polled from the real RPC of the active chain
 * (`eth_gasPrice`). Refreshes every 30s and on demand via `refreshKey`.
 * Returns null while unknown so the UI degrades honestly instead of
 * fabricating a price.
 */
export function useGasPrice(
  rpcUrl: string | null,
  refreshKey = 0,
): { gasPriceGwei: number | null } {
  const [gasPriceGwei, setGasPriceGwei] = useState<number | null>(null);

  useEffect(() => {
    if (!rpcUrl) return;
    let cancelled = false;
    const fetchIt = async () => {
      const value = await fetchGasPriceGwei(rpcUrl);
      if (!cancelled && value !== null) setGasPriceGwei(value);
    };
    void fetchIt();
    const timer = setInterval(() => void fetchIt(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpcUrl, refreshKey]);

  return { gasPriceGwei };
}
