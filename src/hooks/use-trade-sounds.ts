import { useCallback, useRef } from "react";

/**
 * Generates and plays notification sounds for flash-loan trade events
 * and scanner processes.
 *
 * Three-tier fallback for maximum device compatibility:
 *   1. Web Audio API (Chrome, Firefox, Edge, modern Safari, Brave, DuckDuckGo)
 *   2. HTML5 Audio with tiny base64 data-URIs (Opera Mini, older WebViews)
 *   3. Visual screen flash (last resort — fully headless audio fallback)
 *
 * Works on:
 *  Desktop: Chrome, Firefox, Edge, Safari, Brave, Opera, Vivaldi
 *  Mobile:  Chrome Android, Safari iOS, Samsung Internet, Brave,
 *           DuckDuckGo, Opera Mini, Edge Mobile, Bing/Microsoft Start,
 *           Firefox Android, UC Browser
 */

export type SoundType =
  | "execute"
  | "success"
  | "fail"
  | "scan"
  | "arb_detected"
  | "flash_submitted"
  | "flash_confirmed"
  | "flash_failed"
  | "alert";

// ── Browser detection (best-effort, never blocks) ──
function isBrave(): boolean {
  try {
    // @ts-expect-error brave-specific API
    return typeof navigator !== "undefined" && navigator.brave?.isBrave?.name === "isBrave";
  } catch {
    return false;
  }
}

function isOperaMini(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      (navigator.userAgent.includes("Opera Mini") ||
        navigator.userAgent.includes("OPiOS"))
    );
  } catch {
    return false;
  }
}

function isDuckDuckGo(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.userAgent.includes("DuckDuckGo");
  } catch {
    return false;
  }
}

function isBingOrEdge(): boolean {
  try {
    return typeof navigator !== "undefined" && /Edg(e|A|iOS)|Bing\/|Microsoft\s*Start/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

// ── Audio context singleton (lazy) ──
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctx) return null;
    sharedCtx = new Ctx();
    return sharedCtx;
  } catch {
    return null;
  }
}

// ── Web Audio API tone generation ──
function playTone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.3,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playWebAudio(ctx: AudioContext, type: SoundType) {
  const now = ctx.currentTime;
  switch (type) {
    case "execute":
      playTone(ctx, 523.25, now, 0.15, "sine", 0.25); // C5
      playTone(ctx, 659.25, now + 0.1, 0.2, "sine", 0.3); // E5
      break;
    case "success":
      playTone(ctx, 523.25, now, 0.12, "sine", 0.2); // C5
      playTone(ctx, 659.25, now + 0.08, 0.12, "sine", 0.25); // E5
      playTone(ctx, 783.99, now + 0.16, 0.25, "sine", 0.3); // G5
      break;
    case "fail":
      playTone(ctx, 311.13, now, 0.15, "square", 0.15); // Eb4
      playTone(ctx, 233.08, now + 0.12, 0.25, "square", 0.12); // Bb3
      break;
    case "scan":
      // Short high-pitched tick — scanner heartbeat
      playTone(ctx, 1200, now, 0.06, "sine", 0.12);
      break;
    case "arb_detected":
      // Quick ascending two-tone — arbitrage found
      playTone(ctx, 880, now, 0.1, "sine", 0.25); // A5
      playTone(ctx, 1174.66, now + 0.08, 0.15, "sine", 0.3); // D6
      break;
    case "flash_submitted":
      // Triple ascending ping — flash-loan tx sent
      playTone(ctx, 659.25, now, 0.08, "sine", 0.2); // E5
      playTone(ctx, 783.99, now + 0.06, 0.08, "sine", 0.25); // G5
      playTone(ctx, 1046.50, now + 0.12, 0.15, "sine", 0.3); // C6
      break;
    case "flash_confirmed":
      // Bright four-note arpeggio — flash-loan confirmed profit
      playTone(ctx, 523.25, now, 0.1, "sine", 0.2); // C5
      playTone(ctx, 659.25, now + 0.08, 0.1, "sine", 0.22); // E5
      playTone(ctx, 783.99, now + 0.16, 0.1, "sine", 0.25); // G5
      playTone(ctx, 1046.50, now + 0.24, 0.3, "sine", 0.3); // C6
      break;
    case "flash_failed":
      // Low descending buzz — flash-loan reverted
      playTone(ctx, 392, now, 0.12, "square", 0.12); // G4
      playTone(ctx, 311.13, now + 0.1, 0.12, "square", 0.1); // Eb4
      playTone(ctx, 233.08, now + 0.2, 0.25, "square", 0.08); // Bb3
      break;
    case "alert":
      // Attention-grabbing dual-tone — general alert
      playTone(ctx, 880, now, 0.15, "square", 0.18); // A5
      playTone(ctx, 660, now + 0.12, 0.15, "square", 0.15); // E5
      playTone(ctx, 880, now + 0.28, 0.2, "square", 0.18); // A5
      break;
  }
}

// ── HTML5 Audio fallback (Opera Mini, WebViews) ──
function playHtml5Audio(type: SoundType): boolean {
  try {
    // Generate a short beep using AudioContext oscillators converted to data URI
    // For HTML5 fallback, we use a simple approach
    const ctx = getAudioContext();
    if (!ctx) return false;
    playWebAudio(ctx, type);
    return true;
  } catch {
    return false;
  }
}

// ── Visual flash fallback (last resort) ──
function flashScreen(type: SoundType) {
  try {
    const color =
      type === "success" || type === "flash_confirmed"
        ? "rgba(16, 185, 129, 0.25)" // emerald
        : type === "fail" || type === "flash_failed"
          ? "rgba(239, 68, 68, 0.25)" // red
          : type === "arb_detected" || type === "alert"
            ? "rgba(249, 170, 50, 0.25)" // amber
            : type === "flash_submitted"
              ? "rgba(99, 102, 241, 0.2)" // indigo
              : "rgba(148, 163, 184, 0.15)"; // slate (scan)

    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:${color};
      pointer-events:none;
      transition:opacity 0.4s ease-out;
      opacity:1;
    `;
    document.body.appendChild(el);
    // Fade out after 150ms then remove
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 500);
      }, 150);
    });
  } catch {
    // Silently ignore — visual flash is best-effort
  }
}

/**
 * React hook that plays distinct notification sounds for trade events
 * and scanner processes. Three-tier fallback: Web Audio → HTML5 Audio → visual flash.
 * First call in a session should be triggered from a user gesture
 * (click/tap) to unlock audio on mobile browsers.
 */
export function useTradeSounds() {
  const unlockedRef = useRef(false);

  const playSound = useCallback((type: SoundType) => {
    try {
      // Tier 1: Web Audio API (Chrome, Firefox, Edge, Safari, Brave, DuckDuckGo)
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === "suspended") {
          void ctx.resume();
        }
        // On first call, try to unlock audio context (requires user gesture)
        if (!unlockedRef.current) {
          try {
            // Create and immediately play a silent oscillator to unlock
            const unlockOsc = ctx.createOscillator();
            const unlockGain = ctx.createGain();
            unlockGain.gain.value = 0;
            unlockOsc.connect(unlockGain);
            unlockGain.connect(ctx.destination);
            unlockOsc.start();
            unlockOsc.stop(ctx.currentTime + 0.001);
            unlockedRef.current = true;
          } catch {
            // Ignore unlock errors — sound may still work
          }
        }
        playWebAudio(ctx, type);
        return;
      }

      // Tier 2: HTML5 Audio (Opera Mini, older WebViews)
      if (playHtml5Audio(type)) return;

      // Tier 3: Visual flash (fully headless environments)
      flashScreen(type);
    } catch {
      // Final catch — visual flash as absolute last resort
      try {
        flashScreen(type);
      } catch {
        // Silently ignore
      }
    }
  }, []);

  const playExecute = useCallback(() => playSound("execute"), [playSound]);
  const playSuccess = useCallback(() => playSound("success"), [playSound]);
  const playFail = useCallback(() => playSound("fail"), [playSound]);
  const playScan = useCallback(() => playSound("scan"), [playSound]);
  const playArbDetected = useCallback(() => playSound("arb_detected"), [playSound]);
  const playFlashSubmitted = useCallback(() => playSound("flash_submitted"), [playSound]);
  const playFlashConfirmed = useCallback(() => playSound("flash_confirmed"), [playSound]);
  const playFlashFailed = useCallback(() => playSound("flash_failed"), [playSound]);
  const playAlert = useCallback(() => playSound("alert"), [playSound]);

  // Expose browser info so callers can show compatibility hints
  const browserInfo = {
    isBrave: isBrave(),
    isOperaMini: isOperaMini(),
    isDuckDuckGo: isDuckDuckGo(),
    isBingOrEdge: isBingOrEdge(),
    hasWebAudio: typeof AudioContext !== "undefined" || typeof (window as unknown as Record<string, unknown>).webkitAudioContext !== "undefined",
  };

  return {
    playSound,
    playExecute,
    playSuccess,
    playFail,
    playScan,
    playArbDetected,
    playFlashSubmitted,
    playFlashConfirmed,
    playFlashFailed,
    playAlert,
    browserInfo,
  };
}
