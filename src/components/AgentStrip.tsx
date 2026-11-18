/**
 * AI Agent Strip + vote dots + consensus badge — shared UI for the
 * FlashBolt Scanner (flasher) and Sniper multi-signal monitor.
 *
 * Renders the 21 AI agent determinant chips (Gemini, Llama, ChatGPT, Grok,
 * Claude, Cursor, OpenAI, DeepSeek, GLM 5.3 Flash, Mimo 2.5, Muse Spark 1.2,
 * Solar, Lessie, Kimi K2.7, Kimi K3, Vly, Codex, Devin, Meta, Veo, NNI),
 * a per-route/per-token vote dot strip, and the ensemble consensus badge.
 */
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  AGENT_COUNT,
  agentChips,
  agentVoteClass,
  consensusBadgeClass,
  CAPTURE_PROFILES,
  type Consensus,
} from "@/lib/ai-agent-determinants";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────────
 * AgentChipStrip — the 21 agent chips, shown once per panel header
 * ──────────────────────────────────────────────────────────────────────────── */

export const AgentChipStrip = memo(function AgentChipStrip({ className }: { className?: string }) {
  const chips = agentChips();
  const profiles = new Map(CAPTURE_PROFILES.map((p) => [p.agentId, p]));
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        🤖 AI agents ({AGENT_COUNT}) — individual discovery + scoring
      </span>
      {chips.map((chip) => {
        const p = profiles.get(chip.id);
        const title = p
          ? `${chip.name} — captures new listings ≤ ${p.maxListingAgeHours}h · priority: ${p.priorityFeature} ≥ ${p.captureThreshold} · then scores every candidate`
          : chip.name;
        return (
          <span
            key={chip.id}
            title={title}
            className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-background/40 px-1.5 py-0.5 text-[9px] font-semibold text-foreground/80"
          >
            <span className="size-1.5 rounded-full" style={{ background: chip.color }} />
            {chip.short}
          </span>
        );
      })}
    </div>
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * AgentVoteDots — 21 colored vote dots for one route/token row
 * ──────────────────────────────────────────────────────────────────────────── */

export function AgentVoteDots({ scores, max = 21 }: { scores: Array<{ agentId: string; score: number; verdict: string }>; max?: number }) {
  if (scores.length === 0) return null;
  const chipMap = new Map(agentChips().map((c) => [c.id, c]));
  const shown = scores.slice(0, max);
  return (
    <span className="inline-flex items-center gap-[3px]" title={shown.map((s) => {
      const chip = chipMap.get(s.agentId);
      return `${chip?.name ?? s.agentId}: ${s.score} ${s.verdict}`;
    }).join(" · ")}>
      {shown.map((s) => {
        const chip = chipMap.get(s.agentId);
        return (
          <span
            key={s.agentId}
            className={cn("size-1.5 rounded-full", agentVoteClass(s.score))}
            style={{ background: chip?.color, opacity: 0.35 + (s.score / 100) * 0.65 }}
          />
        );
      })}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ConsensusBadge — ensemble consensus badge for one row
 * ──────────────────────────────────────────────────────────────────────────── */

export function ConsensusBadge({ consensus, label = "AI" }: { consensus: Consensus; label?: string }) {
  return (
    <Badge
      className={cn("gap-1 border text-[9px] font-bold uppercase", consensusBadgeClass(consensus))}
      title={`${consensus.agreeing}/${consensus.total} agents agree · ${consensus.latencyMs.toFixed(3)}ms ensemble`}
    >
      {label} {consensus.consensus}
      <span className="font-mono opacity-70">
        {consensus.agreeing}/{consensus.total}
      </span>
    </Badge>
  );
}
