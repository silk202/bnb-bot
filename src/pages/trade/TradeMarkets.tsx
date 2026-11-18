// FlashBolt Trade — Markets page.
//
// Hot / Gainers / Losers tabs over the live price map (identical pattern to
// the reference exchange), with per-user ⭐ favorites persisted in Convex.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { api } from "@/convex/_generated/api";
import { Input } from "@/components/ui/input";
import { useTradeMarket } from "@/components/trade/useTradeMarket";
import { TRADE_PAIRS, currencySymbol, fmtTradeAmount } from "@/convex/tradeAssets";
import { Star, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";

type Tab = "hot" | "gainers" | "losers";
type Row = { base: string; quote: string; venue: string; price: number; pct: number };

export default function TradeMarkets() {
  const navigate = useNavigate();
  const { prices } = useTradeMarket();
  const [tab, setTab] = useState<Tab>("hot");
  const [search, setSearch] = useState("");
  const favorites = useQuery(api.trade.listFavorites, {}) as string[] | undefined;
  const toggleFav = useMutation(api.trade.toggleFavorite);

  const rows: Row[] = useMemo(() => {
    return TRADE_PAIRS.map(([base, quote, venue]) => {
      const pb = prices?.[base];
      const pq = prices?.[quote];
      const price = pb && pq ? pb.usd / pq.usd : 0;
      return { base, quote, venue, price, pct: pb?.change24hPct ?? 0 };
    }).filter((r) => r.price > 0);
  }, [prices]);

  const favSet = new Set(favorites ?? []);
  const searched = search.trim()
    ? rows.filter((r) =>
        (r.base + "/" + r.quote).toLowerCase().includes(search.trim().toLowerCase()),
      )
    : rows;

  const hot = searched.filter((r) => favSet.has(`${r.base}/${r.quote}`));
  const byChange = [...searched].sort((a, b) => b.pct - a.pct);
  const gainers = byChange.filter((r) => r.pct > 0).slice(0, 12);
  const losers = [...byChange].reverse().filter((r) => r.pct < 0).slice(0, 12);
  const shown = tab === "hot" ? hot : tab === "gainers" ? gainers : losers;

  const star = async (pair: string) => {
    try {
      const res = await toggleFav({ pair });
      toast.success(res.favorited ? `${pair} added to favorites` : `${pair} removed from favorites`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update favorites");
    }
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          className="h-11 rounded-full bg-muted/50 pl-10"
        />
        <span className="pointer-events-none absolute left-3.5 top-3.5 text-muted-foreground">⌕</span>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-5 border-b border-border/60 pb-1 text-sm">
        {(["hot", "gainers", "losers"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "relative pb-2 font-semibold capitalize transition-colors " +
              (tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground")
            }
          >
            {t === "hot" ? "Favorites" : t}
            {tab === t && (
              <span className="absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Name</span>
        <span>Last Price</span>
        <span>Change</span>
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {shown.length === 0 && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            {tab === "hot"
              ? "No favorites yet — tap the star on any pair to pin it here."
              : "No pairs in this range right now."}
          </div>
        )}
        {shown.map((r) => {
          const pair = `${r.base}/${r.quote}`;
          const up = r.pct >= 0;
          return (
            <div
              key={pair}
              className="flex items-center gap-2 rounded-xl border border-border/50 bg-card/40 px-3 py-3 transition-colors hover:border-primary/40"
            >
              <button
                type="button"
                onClick={() => void star(pair)}
                className="text-muted-foreground transition-colors hover:text-primary"
                aria-label={`${favSet.has(pair) ? "Remove" : "Add"} ${pair} ${favSet.has(pair) ? "from" : "to"} favorites`}
              >
                <Star className={"size-4 " + (favSet.has(pair) ? "fill-primary text-primary" : "")} />
              </button>
              <button
                type="button"
                onClick={() => navigate(`/trade-terminal/trade?pair=${r.base}${r.quote}`)}
                className="flex min-w-0 flex-1 items-center justify-between text-left"
              >
                <span className="min-w-0">
                  <span className="text-sm font-bold">
                    {r.base}
                    <span className="text-xs font-normal text-muted-foreground">/{r.quote}</span>
                  </span>
                  <span className="ml-2 text-[10px] text-muted-foreground">{r.venue}</span>
                </span>
                <span className="text-sm tabular-nums">
                  {currencySymbol(r.quote) || (r.quote === "USDT" ? "$" : "")}{
                    fmtTradeAmount(r.price, r.quote === "USDT" ? 4 : 2)
                  }
                </span>
                <span className={"flex w-20 items-center justify-end gap-1 text-xs font-semibold " + (up ? "text-emerald-500" : "text-red-500")}>
                  {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                  {up ? "+" : ""}
                  {r.pct.toFixed(2)}%
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {!prices && <div className="py-6 text-center text-xs text-muted-foreground">Loading live prices…</div>}
    </div>
  );
}
