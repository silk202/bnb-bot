import {
  Bot,
  Code,
  Crosshair,
  FileCode2,
  History,
  LayoutDashboard,
  LogOut,
  Radar,
  Satellite,
  Settings2,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { BotStatusChip } from "@/components/BotStatusChip";
import { ChainSwitcher } from "@/components/ChainSwitcher";
import { EnginePulse } from "@/components/EnginePulse";
import { NotificationsBell } from "@/components/NotificationsBell";
import { OperatorConsole } from "@/components/OperatorConsole";
import { ShcsCredit } from "@/components/ShcsCredit";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { WorldClock } from "@/components/WorldClock";
import { useQuery } from "convex/react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { ActivationHydrator } from "@/components/ActivationHydrator";
import { DiscoveryHydrator } from "@/components/DiscoveryHydrator";
import logo from "@/assets/logo.svg";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { TerminalProvider, useTerminal } from "@/hooks/use-terminal";
import { CHAIN_INFO, isBscChain } from "@/lib/flashbolt";
import { getGrant } from "@/lib/gate";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/terminal", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/terminal/scanner", label: "Scanner", icon: Radar, end: false },
  { to: "/terminal/bot", label: "🔥 Flasher", icon: Bot, end: false },
  { to: "/terminal/sniper", label: "🎯 Sniper", icon: Crosshair, end: false },
  { to: "/terminal/strategy", label: "Strategy", icon: SlidersHorizontal, end: false },
  { to: "/terminal/wallets", label: "Wallets", icon: Wallet, end: false },
  { to: "/terminal/contract", label: "Contract", icon: FileCode2, end: false },
  { to: "/terminal/history", label: "History", icon: History, end: false },
  { to: "/terminal/signals", label: "Signals", icon: Satellite, end: false },
];

// Operator-only nav tail — Settings (incl. GitHub Sync) never shows for
// subscribers. Rendered after the shared NAV_ITEMS in both sidebars.
const OPERATOR_NAV_ITEM = {
  to: "/terminal/settings",
  label: "Settings",
  icon: Settings2,
  end: false,
};

function SidebarNav() {
  const { state } = useTerminal();
  const chainKey = state?.chainKey ?? "bsc";
  const armedAddress =
    state?.deployments?.[chainKey]?.contractAddress ??
    state?.deployedContractAddress;
  return (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
      ))}
      {getGrant()?.role !== "subscriber" && (
        <>
          <NavLink
            to={OPERATOR_NAV_ITEM.to}
            end={OPERATOR_NAV_ITEM.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <OPERATOR_NAV_ITEM.icon className="size-4" />
            {OPERATOR_NAV_ITEM.label}
          </NavLink>
          <NavLink
            to="/download"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <Code className="size-4" />
            Source Code
          </NavLink>
        </>
      )}
      <div className="mt-4 rounded-xl border border-border/60 bg-card/40 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <span className="relative flex size-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                state?.botRunning ? "bg-emerald-400" : "bg-muted-foreground",
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                state?.botRunning ? "bg-emerald-400" : "bg-muted-foreground",
              )}
            />
          </span>
          {state?.botRunning ? "Bot running" : "Bot paused"}
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          {state?.mode === "live" ? "Live on chain" : "Paper mode"} · scan every{" "}
          {state?.cadence ?? 15}s
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {CHAIN_INFO[state?.chainKey ?? "bsc"].label}
          {isBscChain(state?.chainKey) && state?.network === "testnet"
            ? " (testnet)"
            : ""}{" "}
          · {state?.autoPayout ? "auto-payout on" : "auto-payout off"}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {armedAddress
            ? "contract armed · live ready"
            : "no contract yet · paper only"}
        </p>
      </div>
    </nav>
  );
}

function Sidebar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border/60 bg-background/70 backdrop-blur-xl lg:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <img src={logo} alt="FlashBolt" width={30} height={30} className="rounded-full" />
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-tight">
            Flash<span className="text-primary">Bolt</span>
          </div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Terminal
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        <SidebarNav />
      </div>

      <div className="border-t border-border/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Terminal settings
          </span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <span className="text-sm font-bold">
              {(user?.email ?? "T").slice(0, 1).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-semibold text-foreground">
              Signed in as {user?.email?.split("@")[0] ?? "terminal operator"}
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive"
            >
              <LogOut className="size-3" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MobileTopNav() {
  return (
    <div className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-xl lg:hidden">
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <img src={logo} alt="FlashBolt" width={26} height={26} className="rounded-full" />
        <span className="text-sm font-bold">
          Flash<span className="text-primary">Bolt</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <WorldClock className="hidden scale-90 min-[440px]:flex" />
          <NotificationsBell />
          <BotStatusChip />
          <WhatsAppChannelButton />
          <AccountMenu />
          <ThemeToggle />
        </span>
      </div>
      <nav className="flex items-center gap-1 overflow-x-auto px-3 py-2.5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <item.icon className="size-3.5" />
            {item.label}
          </NavLink>
        ))}
        {getGrant()?.role !== "subscriber" && (
          <NavLink
            to={OPERATOR_NAV_ITEM.to}
            end={OPERATOR_NAV_ITEM.end}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <OPERATOR_NAV_ITEM.icon className="size-3.5" />
            {OPERATOR_NAV_ITEM.label}
          </NavLink>
        )}
        <ChainSwitcher className="ml-auto shrink-0" />
      </nav>
    </div>
  );
}

export default function TerminalLayout() {
  // The operator console appears ONLY for the terminal operator — whether they
  // signed in with the operator email (verified server-side against the hidden
  // operator email hash) or entered the terminal as a guest after passing the
  // operator gate. It never appears on a subscriber's terminal page.
  const grant = getGrant();
  const operatorCheck = useQuery(api.gate.isOperatorUser);
  const showOperatorConsole =
    grant?.role === "operator" || operatorCheck?.isOperator === true;

  return (
    <TerminalProvider>
      {/* Backend activation rows → execution gate. Mounted once here so every
          terminal page (sniper, scanner, settings) reads the same approval. */}
      <ActivationHydrator />
      {/* Backend-validated RPC endpoints + addresses → ordering and checks. */}
      <DiscoveryHydrator />
      <div className="flex min-h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <MobileTopNav />
          <EnginePulse />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-5 sm:py-8">
            {/* Top bar: chain switcher centred, world clock + date first, whatsapp + account menu after it */}
            <div className="hidden items-center gap-3 pb-4 lg:grid lg:grid-cols-3">
              <div />
              <div className="flex justify-center">
                <ChainSwitcher />
              </div>
              <div className="flex items-center justify-end gap-2.5">
                <WorldClock />
                <NotificationsBell />
                <BotStatusChip />
                <WhatsAppChannelButton />
                <AccountMenu />
              </div>
            </div>
            <Outlet />
            {showOperatorConsole && (
              <section className="mt-8">
                <OperatorConsole />
              </section>
            )}
          </main>
          <footer className="border-t border-border/60 px-5 py-3">
            <ShcsCredit />
          </footer>
        </div>
      </div>
    </TerminalProvider>
  );
}
