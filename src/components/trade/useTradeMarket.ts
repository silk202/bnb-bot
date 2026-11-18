// Live market feed for the FlashBolt Trade terminal.
//
// The backend `trade.getMarket` action refreshes the CoinGecko + FX cache
// (60s TTL, stale-safe); `trade.peekMarket` reactively serves the cached
// prices to the UI. This hook drives the refresh cadence and exposes a
// single `prices` map plus USD⇄local rates.

import { useAction, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { TradePriceMap } from "@/convex/tradeAssets";

const REFRESH_MS = 60_000;

export function useTradeMarket() {
  const peek = useQuery(api.trade.peekMarket, {});
  const refresh = useAction(api.trade.getMarket);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inflight = useRef(false);

  const doRefresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      await refresh({});
      setError(null);
      setStale(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Market feed unavailable");
      setStale(true);
    } finally {
      inflight.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    void doRefresh();
    const t = setInterval(() => void doRefresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [doRefresh]);

  const prices: TradePriceMap | null = peek?.prices ?? null;

  return {
    prices,
    ts: peek?.ts ?? null,
    stale: stale || (peek ? Date.now() - peek.ts > 120_000 : false),
    error,
    refresh: doRefresh,
  };
}
