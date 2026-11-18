import { motion } from "framer-motion";
import { ArrowLeft, Radar } from "lucide-react";
import { Link } from "react-router";
import logo from "@/assets/logo.svg";
import { ShcsCredit } from "@/components/ShcsCredit";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WhatsAppChannelButton } from "@/components/WhatsAppChannelButton";
import { WorldClock } from "@/components/WorldClock";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      {/* backdrop decorations */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-[380px] w-[620px] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
        <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="FlashBolt" width={32} height={32} className="rounded-full" />
            <span className="text-lg font-bold tracking-tight text-foreground">
              Flash<span className="text-primary">Bolt</span>
            </span>
          </Link>
          <div className="flex items-center gap-2.5">
            <WorldClock className="hidden sm:flex" />
            <WhatsAppChannelButton />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative flex flex-1 items-center justify-center px-5">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mx-auto max-w-xl text-center"
        >
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
            <Radar className="size-6" />
          </div>
          <p className="mt-6 font-mono text-sm font-bold uppercase tracking-[0.28em] text-primary">
            Error 404
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">
            Route not found
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-muted-foreground">
            The scanner couldn&apos;t find that page on BNB Smart Chain. The
            spread may have moved — head back to the terminal and keep scanning.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition-all hover:brightness-110 glow-amber"
            >
              <ArrowLeft className="size-4" />
              Back to landing
            </Link>
            <Link
              to="/auth?returnTo=/terminal"
              className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/40 px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              Open the terminal
            </Link>
          </div>
        </motion.div>
      </main>

      {/* Footer */}
      <footer className="relative border-t border-border/60 py-3">
        <ShcsCredit />
      </footer>
    </div>
  );
}
