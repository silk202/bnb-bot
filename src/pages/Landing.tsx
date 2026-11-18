import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  Check,
  Coins,
  Download,
  FileCode2,
  Gauge,
  Grid3x3,
  Lock,
  Play,
  Radio,
  Repeat,
  ScanLine,
  Shield,
  ShieldCheck,
  Sparkles,
  Timer,
  Wallet,
  WifiOff,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import logo from "@/assets/logo.svg";
import { DesktopAppsDialog } from "@/components/DesktopAppsDialog";
import { ShcsCredit } from "@/components/ShcsCredit";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { SubscriberGatePopup } from "@/components/SubscriberGatePopup";
import { getGrant } from "@/lib/gate";
import { WorldClock } from "@/components/WorldClock";
import { Button } from "@/components/ui/button";
import { useLiveFeed } from "@/hooks/use-live-feed";
import {
  DEFAULT_FEED_SETTINGS,
  HONEY_POT_MIN_LIQUIDITY_USD,
  HONEY_POT_MIN_PROFIT_PCT,
  isHoneyPot,
} from "@/lib/flashbolt";

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.6, ease: "easeOut" as const },
};

const TERMINAL_PATH = "/auth?returnTo=/terminal";

function Eyebrow({ children }: { children: React.ReactNode }) {

  return (
    <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
      {children}
    </p>
  );
}

function LiveRouteFeed() {
  const feed = useLiveFeed({ settings: DEFAULT_FEED_SETTINGS, cadence: 15 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
  
  return () => clearInterval(timer);
  }, []);

  const routes = feed.routes.slice(0, 5);


  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/40 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-wide">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-red-500" />
          </span>
          <span className="text-foreground/90">LIVE ROUTE FEED</span>
        </div>
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 font-semibold text-emerald-400">
            <span className="inline-flex size-1.5 rounded-full bg-emerald-400" />
            REAL DATA
          </span>
          {feed.lender && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-semibold text-primary">
              lender: {feed.lender}
            </span>
          )}
        </div>
      </div>

      {feed.error ? (
        <div className="flex flex-wrap items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
          <WifiOff className="size-4 shrink-0" />
          <span>
            Market feed unreachable — {feed.error}. Prices stream live from
            DexScreener.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            onClick={() => feed.rescan()}
          >
            Retry
          </Button>
        </div>
      ) : feed.loading && routes.length === 0 ? (
        <div className="space-y-3 px-5 py-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      ) : routes.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          No live edge above the 0.20% floor right now — the scanner re-checks
          the BNB Chain order book every 15 seconds.
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {routes.map((route) => (
            <motion.div
              key={route.id}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4 }}
              className="flex items-center gap-3 px-5 py-3 text-[13px]"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono">
                {route.legs.map((leg, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    <span
                      className={
                        i % 2 === 1
                          ? "font-semibold text-primary"
                          : "text-foreground/90"
                      }
                    >
                      {leg}
                    </span>
                    {i < route.legs.length - 1 && (
                      <span className="text-muted-foreground/50">→</span>
                    )}
                  </span>
                ))}
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className="hidden rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
                  {route.lender}
                </span>
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  TTL{" "}
                  {Math.max(
                    0,
                    Math.ceil(
                      ((feed.lastScan ?? now) + route.ttlSeconds * 1000 - now) /
                        1000,
                    ),
                  )}
                  s
                </span>
                <span className="font-mono text-sm font-bold text-amber-400">
                  +{route.profitPct.toFixed(2)}%
                </span>
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function HoneyPotFeed() {
  const feed = useLiveFeed({ settings: DEFAULT_FEED_SETTINGS, cadence: 15 });
  const honey = useMemo(
    () => feed.routes.filter((route) => isHoneyPot(route)),
    [feed.routes],
  );


  return (
    <div className="overflow-hidden rounded-2xl border border-amber-500/25 bg-card/40 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 px-5 py-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-amber-400">
          <Sparkles className="size-4" />
          HONEY POT SCANNER
        </div>
        <div className="text-xs font-medium text-muted-foreground">
          ≥{HONEY_POT_MIN_PROFIT_PCT}% net edge &amp; ≥$
          {(HONEY_POT_MIN_LIQUIDITY_USD / 1000).toFixed(0)}k liquidity ·{" "}
          <span className="text-amber-400">{honey.length} live</span>
        </div>
      </div>

      {feed.error ? (
        <div className="flex flex-wrap items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
          <WifiOff className="size-4 shrink-0" />
          <span>
            Market feed unreachable — {feed.error}. Prices stream live from
            DexScreener.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            onClick={() => feed.rescan()}
          >
            Retry
          </Button>
        </div>
      ) : feed.loading && honey.length === 0 ? (
        <div className="space-y-3 px-5 py-6">
          {[0, 1].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      ) : honey.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          No route clears the honey-pot bar right now (≥
          {HONEY_POT_MIN_PROFIT_PCT}% net and ≥$
          {(HONEY_POT_MIN_LIQUIDITY_USD / 1000).toFixed(0)}k liquidity) — the
          scanner re-checks the BNB Chain order book every 15 seconds.
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {honey.map((route) => (
            <motion.div
              key={route.id}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4 }}
              className="flex items-center gap-3 px-5 py-3 text-[13px]"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono">
                {route.legs.map((leg, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    <span
                      className={
                        i % 2 === 1
                          ? "font-semibold text-primary"
                          : "text-foreground/90"
                      }
                    >
                      {leg}
                    </span>
                    {i < route.legs.length - 1 && (
                      <span className="text-muted-foreground/50">→</span>
                    )}
                  </span>
                ))}
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className="hidden rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400 sm:inline">
                  <Sparkles className="mr-1 inline size-3" />
                  honey
                </span>
                <span className="hidden rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
                  {route.lender}
                </span>
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  $
                  {route.liquidityUsd >= 1_000_000
                    ? `${(route.liquidityUsd / 1_000_000).toFixed(1)}M`
                    : `${Math.round(route.liquidityUsd / 1000)}k`}{" "}
                  liq
                </span>
                <span className="font-mono text-sm font-bold text-amber-400">
                  +{route.profitPct.toFixed(2)}%
                </span>
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlowStep({
  index,
  icon,
  title,
  children,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {

  return (
    <motion.div {...fadeUp} className="group relative">
      <div className="flex h-full flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 p-5 transition-colors hover:border-primary/40">
        <div className="flex items-center justify-between">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary transition-transform group-hover:scale-110">
            {icon}
          </div>
          <span className="font-mono text-xs text-muted-foreground/60">
            0{index + 1}
          </span>
        </div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{children}</p>
      </div>
    </motion.div>
  );
}

function CapabilityCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {

  return (
    <motion.div {...fadeUp} className="group">
      <div className="flex h-full flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 p-5 transition-all hover:border-primary/40 hover:bg-card/70">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {icon}
        </div>
        <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{children}</p>
      </div>
    </motion.div>
  );
}

const WALLETS = [
  {
    name: "MetaMask",
    desc: "The classic browser wallet",
    color: "bg-gradient-to-br from-amber-400 to-orange-500",
    glyph: "M",
  },
  {
    name: "Trust Wallet",
    desc: "Mobile-first, injected on desktop",
    color: "bg-gradient-to-br from-sky-400 to-blue-600",
    glyph: "T",
  },
  {
    name: "OKX Wallet",
    desc: "OKX Web3 extension",
    color: "bg-zinc-700",
    glyph: "•",
  },
  {
    name: "Binance Wallet",
    desc: "Binance&apos;s native wallet",
    color: "bg-gradient-to-br from-yellow-300 to-amber-500",
    glyph: "B",
  },
];

const CONTRACT_CHECKLIST = [
  {
    title: "Access control",
    desc: "Ownable — only the deployer can trigger executions",
  },
  {
    title: "Reentrancy",
    desc: "ReentrancyGuard on every external entrypoint",
  },
  {
    title: "Profit gate",
    desc: "Reverts if net profit is below the minimum",
  },
  {
    title: "Flash fee",
    desc: "Repays principal + 0.25% PancakeSwap fee",
  },
  {
    title: "Emergency exit",
    desc: "Owner can withdraw stuck tokens at any time",
  },
];

export default function Landing() {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [gatePopupOpen, setGatePopupOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const grant = getGrant();
  const isOperator = grant?.role === "operator";

  /** Intercept clicks on subscriber terminal links — show permit gate popup first. */
  const handleSubscriberNav = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    if (isOperator) {
      // Operators go straight to auth/terminal — no subscriber gate needed
      window.location.href = path;
      return;
    }
    setPendingNav(path);
    setGatePopupOpen(true);
  };

  const handleGateSuccess = () => {
    if (pendingNav) {
      window.location.href = pendingNav;
      setPendingNav(null);
    }
  };


  return (
    <div className="relative min-h-screen scroll-smooth bg-background text-foreground">
      {/* backdrop decorations */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-primary/10 blur-[140px]" />
        <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="FlashBolt" width={34} height={34} className="rounded-full" />
            <span className="text-lg font-bold tracking-tight text-foreground">
              Flash<span className="text-primary">Bolt</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#flow" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#capabilities" className="transition-colors hover:text-foreground">Features</a>
            <a href="#wallets" className="transition-colors hover:text-foreground">Wallets</a>
            <a href="#security" className="transition-colors hover:text-foreground">Security</a>
          </nav>
          <div className="flex items-center gap-2.5">
            <WorldClock className="hidden md:flex" />
            <WhatsAppChannelButton />
            <ThemeToggle />
            <a
              href={TERMINAL_PATH}
              onClick={(e) => handleSubscriberNav(e, TERMINAL_PATH)}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110 glow-amber"
            >
              Launch terminal
              <ArrowRight className="size-4" />
            </a>
          </div>
        </div>
      </header>

      <main className="relative">
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-5 pt-20 pb-14 text-center sm:pt-28">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mx-auto inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground"
          >
            <span className="flex size-4 items-center justify-center rounded bg-emerald-500/20 text-emerald-400">
              <Check className="size-3" />
            </span>
            BNB Smart Chain • Live Multi-DEX Spreads • Paper Mode
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08 }}
            className="mx-auto mt-7 max-w-4xl text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
          >
            <span className="text-foreground">Flash-loan arbitrage,</span>
            <br />
            <span className="text-flash-gradient">executed in one</span>
            <br />
            <span className="text-flash-gradient">transaction.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16 }}
            className="mx-auto mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg"
          >
            A BNB Chain arbitrage terminal with a hard 1 BNB minimum loan. Scan
            real multi-DEX spreads across five AMMs, borrow from a rotating set
            of flash-loan lenders, and keep the keys to your wallet — and to
            your funds.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.24 }}
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <a
              href={TERMINAL_PATH}
              onClick={(e) => handleSubscriberNav(e, TERMINAL_PATH)}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition-all hover:brightness-110 glow-amber"
            >
              <Zap className="size-4 fill-current" />
              Launch the terminal
            </a>
            <a
              href="#flow"
              className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/40 px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              See how it works
            </a>
          </motion.div>

          {/* Metric strip */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.32 }}
            className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/60 sm:grid-cols-4"
          >
            {[
              { value: "1 BNB", label: "min loan" },
              { value: "0.25%", label: "flash fee" },
              { value: "5", label: "BNB DEXs" },
              { value: "15s", label: "scan cadence" },
            ].map((stat) => (
              <div key={stat.label} className="bg-card/60 px-5 py-5 text-left">
                <div className="text-2xl font-extrabold text-amber-400">
                  {stat.value}
                </div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {stat.label}
                </div>
              </div>
            ))}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.4 }}
            className="mx-auto mt-8 max-w-4xl text-left"
          >
            <LiveRouteFeed />
          </motion.div>
        </section>

        {/* Honey-pot scanner */}
        <section className="mx-auto max-w-6xl scroll-mt-20 px-5 pb-20">
          <motion.div {...fadeUp} className="mx-auto max-w-4xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Eyebrow>Honey pots</Eyebrow>
              <span className="text-xs text-muted-foreground">
                Only genuinely high-profit routes with real high liquidity
              </span>
            </div>
            <HoneyPotFeed />
          </motion.div>
        </section>

        {/* The Flow */}
        <section id="flow" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20">
          <motion.div {...fadeUp} className="max-w-2xl">
            <Eyebrow>The Flow</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              One atomic transaction, zero collateral
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              A flash loan lets you borrow without posting collateral — as long
              as the loan is repaid within the same block. That&apos;s the whole
              arbitrage engine in four steps.
            </p>
          </motion.div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FlowStep
              index={0}
              icon={<Repeat className="size-5" />}
              title="Flash-borrow 1+ BNB"
            >
              Each scan run pulls the loan from a different lender — Aave V3,
              Venus, dForce, Radiant or PancakeSwap — no collateral, repaid
              inside the same transaction. The minimum loan is 1 BNB.
            </FlowStep>
            <FlowStep
              index={1}
              icon={<Grid3x3 className="size-5" />}
              title="Sweep the DEX spread"
            >
              The engine hunts live price gaps across PancakeSwap, Biswap,
              MDEX, ApeSwap and BabySwap, routing triangular paths through the
              cheapest legs automatically.
            </FlowStep>
            <FlowStep
              index={2}
              icon={<Coins className="size-5" />}
              title="Repay + keep the profit"
            >
              The borrowed amount plus the 0.25% flash fee is returned to the
              pool. Anything left over is pure arbitrage profit, auto-paid to
              your wallet in the same flow.
            </FlowStep>
            <FlowStep
              index={3}
              icon={<ShieldCheck className="size-5" />}
              title="Guardrails on every leg"
            >
              Min-profit checks, slippage caps, MEV risk scoring and a
              reentrancy guard protect every execution — nothing executes
              unless it clears the bar.
            </FlowStep>
          </div>
        </section>

        {/* Capabilities */}
        <section id="capabilities" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <Eyebrow>Capabilities</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Built like a trading desk, not a demo
            </h2>
            <div className="mt-7 flex items-center justify-center gap-6">
              {[
                { icon: <ScanLine className="size-5" />, label: "Scan" },
                { icon: <Repeat className="size-5" />, label: "Sweep" },
                { icon: <Play className="size-5" />, label: "Execute" },
                { icon: <ShieldCheck className="size-5" />, label: "Guard" },
              ].map((chip) => (
                <div
                  key={chip.label}
                  className="flex flex-col items-center gap-2"
                >
                  <div className="flex size-14 items-center justify-center rounded-full border border-primary/35 bg-primary/10 text-primary transition-all hover:scale-105 hover:bg-primary/20">
                    {chip.icon}
                  </div>
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {chip.label}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CapabilityCard icon={<Gauge className="size-4" />} title="15-second scan cadence">
              The terminal re-scans live BNB Chain pair prices on a 15s loop
              and auto-expires stale opportunities after 90s, just like real
              MEV markets.
            </CapabilityCard>
            <CapabilityCard icon={<Timer className="size-4" />} title="90s opportunity TTL">
              Every route carries an expiry. If it doesn&apos;t clear your
              profitability floor before the clock runs out, it&apos;s dropped — no
              stale fills.
            </CapabilityCard>
            <CapabilityCard icon={<Wallet className="size-4" />} title="Non-custodial wallet layer">
              Connect MetaMask, Trust Wallet, OKX or Binance Wallet over
              EIP-1193. Private keys never leave your extension — and the app
              never touches them.
            </CapabilityCard>
            <CapabilityCard icon={<Activity className="size-4" />} title="Live data, paper execution">
              Real DexScreener market data feeds both paper and live modes. Train
              your strategy against the actual order book before risking a
              single real BNB.
            </CapabilityCard>
            <CapabilityCard icon={<Shield className="size-4" />} title="MEV-secure routing">
              Routes are scored for front-running and sandwich risk. Flip the
              MEV guard on and high-risk opportunities never make it to your
              feed.
            </CapabilityCard>
            <CapabilityCard icon={<FileCode2 className="size-4" />} title="Auditable Solidity contract">
              A deploy-ready, Ownable flash-swap arbitrage contract ships with
              the project — constructor-locked, reentrancy-guarded,
              profit-checked, mainnet or testnet.
            </CapabilityCard>
          </div>
        </section>

        {/* Wallets */}
        <section id="wallets" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <Eyebrow>Bring your own wallet</Eyebrow>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Four wallets, one EIP-1193 connector
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              No custodial accounts, no seed phrases pasted anywhere. Connect
              your extension, read your balance, and the terminal does the
              rest.
            </p>
          </motion.div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {WALLETS.map((wallet) => (
              <motion.div
                key={wallet.name}
                {...fadeUp}
                className="flex flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card/40 p-6 text-center transition-all hover:border-primary/40"
              >
                <div
                  className={`flex size-12 items-center justify-center rounded-full text-lg font-extrabold text-white shadow-lg ${wallet.color}`}
                >
                  {wallet.glyph}
                </div>
                <div>
                  <div className="font-semibold text-foreground">
                    {wallet.name}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {wallet.desc}
                  </div>
                </div>
                <span className="mt-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-400">
                  <Check className="size-3" />
                  EIP-1193 ready
                </span>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Security */}
        <section id="security" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20">
          <div className="grid gap-6 lg:grid-cols-2">
            <motion.div {...fadeUp} className="flex flex-col justify-center">
              <Eyebrow>Security Posture</Eyebrow>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                Keys stay yours. The contract is the only trust anchor.
              </h2>
              <ul className="mt-7 space-y-4">
                {[
                  "No private keys, seeds or mnemonics are ever stored or transmitted",
                  "All server mutations require authentication and scope reads to your account",
                  "Contract uses Ownable + ReentrancyGuard with a min-profit execution gate",
                  "Paper mode never moves real BNB — live mode only after you deploy your own contract",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-[15px] text-foreground/90">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                      <Check className="size-3.5" />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
              <a
                href={TERMINAL_PATH}
                onClick={(e) => handleSubscriberNav(e, TERMINAL_PATH)}
                className="group mt-8 inline-flex w-fit items-center gap-2 text-sm font-bold text-primary"
              >
                Open the terminal
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </a>
            </motion.div>

            <motion.div {...fadeUp} className="rounded-2xl border border-border/70 bg-card/50 p-6">
              <div className="flex items-center gap-2.5">
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Lock className="size-4" />
                </div>
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-foreground">
                  Contract Checklist
                </h3>
              </div>
              <div className="mt-5 space-y-3">
                {CONTRACT_CHECKLIST.map((item) => (
                  <div
                    key={item.title}
                    className="flex items-start gap-3 rounded-xl border border-border/50 bg-background/40 p-3.5"
                  >
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Shield className="size-4" />
                    </div>
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
              </div>
              <a
                href={TERMINAL_PATH}
                onClick={(e) => handleSubscriberNav(e, TERMINAL_PATH)}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-bold text-primary-foreground transition-all hover:brightness-110 glow-amber"
              >
                <Wallet className="size-4" />
                Connect wallet in the terminal
              </a>
            </motion.div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="relative mx-auto max-w-6xl px-5 pb-24 pt-8 text-center">
          <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-72 max-w-3xl rounded-full bg-primary/12 blur-[120px]" />
          <motion.div {...fadeUp} className="relative">
            <h2 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              <span className="text-foreground">The spread won&apos;t wait.</span>
              <br />
              <span className="text-flash-gradient">Neither should you.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              Spin up the terminal in seconds — 1 BNB minimum loan, five DEXes,
              rotating flash-loan lenders, and a deploy-ready arbitrage
              contract.
            </p>
            <a
              href={TERMINAL_PATH}
              onClick={(e) => handleSubscriberNav(e, TERMINAL_PATH)}
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 text-sm font-bold text-primary-foreground transition-all hover:brightness-110 glow-amber"
            >
              <Radio className="size-4" />
              Launch the terminal
            </a>
          </motion.div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <img src={logo} alt="" width={26} height={26} className="rounded-full" />
            <span className="text-sm text-muted-foreground">
              FlashBolt — BNB Chain flash-loan arbitrage terminal
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Real market data — paper execution until you deploy your contract.
            </span>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-400">
              BNB Smart Chain
            </span>
          </div>
        </div>
        <div className="border-t border-border/40 py-4">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDesktopOpen(true)}
              className="gap-2 rounded-full px-5"
            >
              <Download className="size-4" />
              Desktop apps
            </Button>
            <ShcsCredit />
          </div>
        </div>
      </footer>

      {/* Desktop apps window — subscribers see the per-OS activation window;
          operators enter the email they registered on the auth page (or
          Continue as guest) — no activation password, and every guest click
          emails a periodic code to the operator's default address. */}
      <DesktopAppsDialog open={desktopOpen} onOpenChange={setDesktopOpen} />
      {!isOperator && (
        <SubscriberGatePopup
          open={gatePopupOpen}
          onOpenChange={setGatePopupOpen}
          onSuccess={handleGateSuccess}
        />
      )}
    </div>
  );
}
