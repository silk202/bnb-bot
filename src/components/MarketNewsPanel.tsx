import { useAction } from "convex/react";
import { Newspaper, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

/** Real-headline filter categories — substring matches against live RSS titles. */
const CATEGORIES: { key: string; label: string; test: (t: string) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  {
    key: "flash",
    label: "Flash loans",
    test: (t) => /flash ?loan|flashloan|arbitrage|sandwich|mev/i.test(t),
  },
  {
    key: "defi",
    label: "DeFi / DEX",
    test: (t) =>
      /defi|dex|decentralized|amm|liquidity|swap|pancake|uniswap|pools/i.test(t),
  },
  {
    key: "assets",
    label: "BTC · ETH · BNB",
    test: (t) =>
      /\bbtc\b|bitcoin|\beth\b|ethereum|\bbnb\b|binance|smart chain/i.test(t),
  },
  {
    key: "chain",
    label: "On-chain",
    test: (t) =>
      /on-?chain|gas fee|gas price|gas|transaction|txn|layer ?2|rpc/i.test(t),
  },
];

function fmtPubDate(pubDate: string): string {
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) return "";
  const diff = Date.now() - parsed.getTime();
  if (diff >= 0 && diff < 3600_000) {
    return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
  }
  if (diff >= 0 && diff < 86_400_000) {
    return `${Math.floor(diff / 3600_000)}h ago`;
  }
  return parsed.toLocaleDateString();
}

/**
 * Market news — real published headlines from CoinDesk, CoinTelegraph and
 * Decrypt, fetched server-side by the news action (RSS, cached 10 min) and
 * filtered by the live category chips. Every item links to the real article;
 * nothing is generated or simulated.
 */
export function MarketNewsPanel() {
  const loadNews = useAction(api.news.getMarketNews);
  const [data, setData] = useState<{
    items: { source: string; title: string; link: string; pubDate: string; summary: string }[];
    fetchedAt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadNews();
      setData({ items: result.items, fetchedAt: result.fetchedAt });
    } catch (e) {
      setError(e instanceof Error ? e.message : "News feed unreachable");
    } finally {
      setLoading(false);
    }
  }, [loadNews]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0];
  const items = useMemo(
    () => (data?.items ?? []).filter((item) => active.test(item.title)),
    [data, active],
  );

  return (
    <div className="rounded-2xl border border-border/70 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Newspaper className="size-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">Market news</div>
            <p className="text-[11px] text-muted-foreground">
              real RSS headlines · CoinDesk · CoinTelegraph · Decrypt
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/50 px-3 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          {loading ? "Fetching…" : "Refresh"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory(c.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
              category === c.key
                ? "border-primary/40 bg-primary/12 text-primary"
                : "border-border/60 bg-background/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[11px] text-amber-400">
          {error}
        </p>
      ) : data === null ? (
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-xl bg-muted/40"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-3 rounded-xl border border-border/50 bg-background/40 px-3.5 py-2.5 text-[11px] text-muted-foreground">
          No headlines match this filter right now — real feeds only, nothing
          fabricated.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 lg:grid-cols-2">
          {items.slice(0, 8).map((item, i) => (
            <li key={`${item.link}-${i}`}>
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="group flex h-full flex-col rounded-xl border border-border/50 bg-background/40 px-3.5 py-3 transition-colors hover:border-primary/40"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {item.source}
                  </span>
                  {fmtPubDate(item.pubDate) && (
                    <span className="text-[10px] text-muted-foreground">
                      {fmtPubDate(item.pubDate)}
                    </span>
                  )}
                </div>
                <span className="mt-1.5 line-clamp-2 text-xs font-semibold leading-4 text-foreground group-hover:text-primary">
                  {item.title}
                </span>
                {item.summary && (
                  <span className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {item.summary}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
        {data
          ? `Fetched ${new Date(data.fetchedAt).toLocaleTimeString()} · headlines cached 10 minutes to keep the public feeds light.`
          : "Headlines are fetched server-side from the public RSS feeds."}
      </p>
    </div>
  );
}
