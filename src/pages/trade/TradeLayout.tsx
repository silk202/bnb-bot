// FlashBolt Trade terminal shell.
//
// Operator-only exchange terminal: top bar + bottom navigation
// (Home · Markets · Trade · Earn · Wallet). The route stays behind the
// standard RequireAuth; this layout additionally enforces the operator-only
// rule: operator sign-in and "continue as guest" sessions get in, while
// gate-granted SUBSCRIBERS are excluded (FlashBolt Trade never appears for
// them in the chooser either).

import { AccountMenu } from "@/components/AccountMenu";
import { Badge } from "@/components/ui/badge";
import { BotStatusChip } from "@/components/BotStatusChip";
import { EnginePulse } from "@/components/EnginePulse";
import { WorldClock } from "@/components/WorldClock";
import { useTradeMarket } from "@/components/trade/useTradeMarket";
import { useAuth } from "@/hooks/use-auth";
import { getGrant } from "@/lib/gate";
import {
  ArrowLeftRight,
  BarChart3,
  Home,
  PiggyBank,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Wallet2,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { TRADE_PAIRS, fmtTradeUsd } from "@/convex/tradeAssets";

const NAV = [
  { to: "/trade-terminal", label: "Home", icon: Home, end: true },
  { to: "/trade-terminal/markets", label: "Markets", icon: BarChart3, end: false },
  { to: "/trade-terminal/trade", label: "Trade", icon: ArrowLeftRight, end: false },
  { to: "/trade-terminal/earn", label: "Earn", icon: PiggyBank, end: false },
  { to: "/trade-terminal/wallet", label: "Wallet", icon: Wallet2, end: false },
] as const;

export default function TradeLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { prices, stale, refresh } = useTradeMarket();
  // Operator-only access: operator sign-in and guest sessions carry either
  // an "operator" gate grant or NO grant at all (they authenticated at
  // /auth). Subscribers carry role "subscriber" and are excluded.
  const [grantBlocked] = useState(() => getGrant()?.role === "subscriber");
  const isTradeAllowed = !grantBlocked;

  // Live movers strip (top gainer + top loser over all pairs).
  const movers = TRADE_PAIRS.map(([b, q]) => {
    const p = prices?.[b];
    return p ? { pair: `${b}/${q}`, pct: p.change24hPct } : null;
  })
    .filter((x): x is { pair: string; pct: number } => x !== null)
    .sort((a, b) => b.pct - a.pct);
  const top = movers[0];
  const bottom = movers[movers.length - 1];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* 24/7 engine pulse: scan ticks + arb stings anywhere in the Trade
          shell, plus fill narration (no NotificationsBell here — the pulse
          is this shell's narrator, with withFillNarration enabled). */}
      <EnginePulse withFillNarration />
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => navigate("/trade-terminal")}
            className="flex items-center gap-2"
            aria-label="FlashBolt Trade home"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/15">
              <ArrowLeftRight className="size-4 text-primary" />
            </span>
            <span className="text-sm font-extrabold tracking-tight">
              Flash<span className="text-primary">Bolt</span> Trade
            </span>
            <Badge variant="outline" className="text-[9px] uppercase">
              Operator only
            </Badge>
          </button>
          <div className="ml-auto flex items-center gap-2">
            {/* World clock (UTC, selectable offset) — visible from 440px
                up, matching the other terminals' narrow-screen treatment so
                the header row never overflows on small phones. */}
            <WorldClock className="hidden scale-90 min-[440px]:flex" />
            {isTradeAllowed && <BotStatusChip />}
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-full border border-border/70 p-2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Refresh market prices"
            >
              <RefreshCw className={"size-3.5" + (stale ? " animate-spin text-amber-500" : "")} />
            </button>
            <AccountMenu />
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 overflow-x-auto px-4 pb-2 text-[10px] text-muted-foreground">
          {top ? (
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="size-3 text-emerald-500" />
              {top.pair} <span className="font-semibold text-emerald-500">+{top.pct.toFixed(2)}%</span>
            </span>
          ) : (
            <span>Loading live prices…</span>
          )}
          {bottom && bottom.pair !== top?.pair ? (
            <span className="inline-flex items-center gap-1">
              <TrendingDown className="size-3 text-red-500" />
              {bottom.pair} <span className="font-semibold text-red-500">{bottom.pct.toFixed(2)}%</span>
            </span>
          ) : null}
          <span className="ml-auto hidden sm:inline">
            Signed in as {user?.email ?? "guest"} · operator session
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-4">
        {isTradeAllowed ? (
          <Outlet />
        ) : (
          <div className="mx-auto mt-16 max-w-md rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
            <ShieldAlert className="mx-auto size-8 text-amber-500" />
            <h2 className="mt-3 text-base font-bold">Operator access only</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              FlashBolt Trade is reserved for operator sign-in and "continue as guest" sessions.
              Subscriber accounts use the BNB and SOL FlashBolt terminals instead.
            </p>
            <button
              type="button"
              onClick={() => navigate("/terminal")}
              className="mt-4 rounded-full border border-border/70 px-4 py-2 text-xs font-semibold transition-colors hover:border-primary/50"
            >
              Back to BNB FlashBolt
            </button>
          </div>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-5">
          {NAV.map(({ to, label, icon: Icon, end }) => {
            const active = end ? location.pathname === to : location.pathname.startsWith(to);
            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={
                  "flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors " +
                  (active ? "text-primary" : "text-muted-foreground hover:text-foreground")
                }
              >
                <Icon className="size-5" />
                {label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
