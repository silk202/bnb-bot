import { api } from "@/convex/_generated/api";
import { useAction } from "convex/react";
import { Play, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Reusable narrated explainer ("short video" with a humanistic avatar) used
 * on the gate page and the signals dashboard.
 *
 * Narration channel: Cartesia TTS (sonic-3.5) through a server-side action
 * with a content-addressed cache — the audio is generated ONCE per script and
 * every replay serves the cached file, so the free plan's quota is never
 * consumed twice no matter how often the video is played. When the
 * CARTESIA_API_KEY is not configured, the browser's Web Speech engine is used
 * as an honest fallback. No simulated backend data anywhere.
 */

export function AvatarFace({ speaking }: { speaking: boolean }) {
  const [blink, setBlink] = useState(false);
  const [mouth, setMouth] = useState<"open" | "mid" | "closed">("closed");

  useEffect(() => {
    const blinkTimer = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 140);
    }, 3200);
    return () => clearInterval(blinkTimer);
  }, []);

  // Lip sync while speaking — mouth position cycles rapidly.
  useEffect(() => {
    if (!speaking) {
      setMouth("closed");
      return;
    }
    const mouthTimer = setInterval(() => {
      setMouth((m) => (m === "open" ? "mid" : m === "mid" ? "closed" : "open"));
    }, 180);
    return () => clearInterval(mouthTimer);
  }, [speaking]);

  const mouthHeight = mouth === "open" ? 22 : mouth === "mid" ? 12 : 4;

  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden>
      {/* halo */}
      <circle cx="100" cy="100" r="86" fill="none" stroke="url(#haloGrad)" strokeWidth="2" opacity="0.5" />
      <defs>
        <radialGradient id="haloGrad" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#ffd98f" />
          <stop offset="100%" stopColor="#e05a00" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="skinGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffd9b3" />
          <stop offset="100%" stopColor="#f0b489" />
        </linearGradient>
      </defs>

      {/* shoulders */}
      <path d="M 34,200 C 40,150 66,128 100,128 C 134,128 160,150 166,200 Z" fill="#2d323e" />
      <path d="M 78,158 L 100,176 L 122,158" fill="none" stroke="#e61b6f" strokeWidth="4" strokeLinecap="round" />

      {/* neck */}
      <rect x="88" y="120" width="24" height="20" rx="6" fill="#e8b48d" />

      {/* head */}
      <ellipse cx="100" cy="82" rx="42" ry="48" fill="url(#skinGrad)" />

      {/* hair */}
      <path d="M 58,70 C 56,30 84,14 106,14 C 130,14 148,34 146,58 C 138,30 112,22 96,26 C 80,30 64,46 58,70 Z" fill="#3a3f4b" />
      <circle cx="128" cy="26" r="16" fill="#3a3f4b" />

      {/* eyes (blink by flattening) */}
      <g>
        <ellipse cx="84" cy="78" rx="7" ry={blink ? 1 : 7} fill="#1b1e24" />
        <ellipse cx="116" cy="78" rx="7" ry={blink ? 1 : 7} fill="#1b1e24" />
      </g>

      {/* brows */}
      <path d="M 74,66 Q 84,60 94,64" fill="none" stroke="#3a3f4b" strokeWidth="3" strokeLinecap="round" />
      <path d="M 106,64 Q 116,60 126,66" fill="none" stroke="#3a3f4b" strokeWidth="3" strokeLinecap="round" />

      {/* nose */}
      <path d="M 98,84 Q 100,94 104,94" fill="none" stroke="#d99a6a" strokeWidth="2.5" strokeLinecap="round" />

      {/* animated mouth */}
      <path
        d={`M 90,${104 - mouthHeight / 2} Q 100,${104 + mouthHeight / 2} 110,${104 - mouthHeight / 2}`}
        fill="none"
        stroke="#a83a44"
        strokeWidth="3.5"
        strokeLinecap="round"
      />

      {/* cheeks */}
      <circle cx="70" cy="94" r="6" fill="#f2a07e" opacity="0.45" />
      <circle cx="130" cy="94" r="6" fill="#f2a07e" opacity="0.45" />
    </svg>
  );
}

export function NarratedExplainer({
  scriptLines,
  title,
  description,
  dialogTitle,
  playLabel = "Play short video",
}: {
  scriptLines: string[];
  title: string;
  description: string;
  dialogTitle: string;
  playLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [lineIndex, setLineIndex] = useState(0);
  const [supported, setSupported] = useState(false);
  // Cartesia channel state
  const generateSpeech = useAction(api.tts.generateSpeech);
  const [ttsUrl, setTtsUrl] = useState<string | null>(null);
  const [ttsCached, setTtsCached] = useState(false);
  const [ttsActive, setTtsActive] = useState(false);
  // Bumped on every play so replaying the SAME cached URL restarts playback
  // (React skips re-render when state is unchanged).
  const [playToken, setPlayToken] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const captionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const fullScript = useMemo(
    () => scriptLines.join(" "),
    [scriptLines],
  );

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        typeof window.speechSynthesis.speak === "function",
    );
  }, []);

  const clearCaptionTimer = () => {
    if (captionTimerRef.current) {
      clearInterval(captionTimerRef.current);
      captionTimerRef.current = null;
    }
  };

  const stopSpeaking = () => {
    clearCaptionTimer();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
    setLineIndex(0);
  };

  /** Captions-only walkthrough (muted / unsupported device). */
  const timedCaptions = () => {
    clearCaptionTimer();
    setSpeaking(true);
    let i = 0;
    captionTimerRef.current = setInterval(() => {
      i += 1;
      setLineIndex(i);
      if (i >= scriptLines.length - 1) {
        clearCaptionTimer();
        setTimeout(() => {
          setSpeaking(false);
          setLineIndex(0);
        }, 1200);
      }
    }, 2800);
  };

  /** Browser Web Speech fallback (used when Cartesia is not configured). */
  const playWebSpeech = () => {
    if (!supported) {
      timedCaptions();
      return;
    }
    stopSpeaking();
    const utterance = new SpeechSynthesisUtterance(fullScript);
    utterance.rate = 1;
    utterance.pitch = 1.05;
    utteranceRef.current = utterance;
    let i = 0;
    utterance.onboundary = () => {
      const progress = Math.min(i + 1, scriptLines.length - 1);
      setLineIndex(progress);
      i += 1;
    };
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      setSpeaking(false);
      setLineIndex(0);
    };
    window.speechSynthesis.speak(utterance);
  };

  /**
   * Play the explainer. Opens the popup first — the cached audio element
   * lives inside the dialog, so playback can only start once it is mounted.
   * Cartesia first (cached — the API is only called once per script); if the
   * key is missing or the call fails, the Web Speech engine takes over
   * honestly.
   */
  const play = async () => {
    setOpen(true);
    if (muted) {
      setTtsActive(false);
      timedCaptions();
      return;
    }
    stopSpeaking();
    const result = await generateSpeech({ text: fullScript }).catch(() => null);
    if (result?.ok && result.url) {
      setTtsActive(true);
      setTtsCached(Boolean(result.cached));
      setTtsUrl(result.url);
      setPlayToken((t) => t + 1);
      setSpeaking(true);
    } else {
      setTtsActive(false);
      playWebSpeech();
    }
  };

  // Kick off the cached audio once the URL is ready (and on every replay via
  // playToken), with captions timed to the real audio duration.
  useEffect(() => {
    if (!ttsUrl) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    const startPlayback = () => {
      audio.play().catch(() => {
        // playback blocked or URL expired — fall back to Web Speech
        setTtsActive(false);
        playWebSpeech();
      });
    };
    const onLoaded = () => {
      const duration = audio.duration;
      if (Number.isFinite(duration) && duration > 0) {
        clearCaptionTimer();
        const perLine = (duration * 1000) / scriptLines.length;
        let i = 0;
        captionTimerRef.current = setInterval(() => {
          i += 1;
          setLineIndex(i);
          if (i >= scriptLines.length - 1) {
            clearCaptionTimer();
          }
        }, perLine);
      }
      startPlayback();
    };
    const onEnded = () => {
      clearCaptionTimer();
      setSpeaking(false);
      setLineIndex(0);
    };
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnded);
    // Some browsers fire `canplay` before `loadedmetadata` on cached files.
    if (audio.readyState >= 1) {
      startPlayback();
    }
    return () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnded);
      clearCaptionTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsUrl, playToken]);

  useEffect(() => {
    return () => {
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      if (next) stopSpeaking();
      return next;
    });
  };

  return (
    <section className="space-y-2">
      <div className="group relative overflow-hidden rounded-2xl border border-border/70 bg-card/50 p-5 shadow-xl sm:p-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
          <div className="relative h-28 w-28 shrink-0 sm:h-32 sm:w-32">
            <AvatarFace speaking={open && speaking} />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <h3 className="flex items-center justify-center gap-2 text-lg font-bold sm:justify-start">
              <Play className="size-4 text-primary" />
              {title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            <div className="mt-3 flex items-center justify-center gap-2 sm:justify-start">
              <Button onClick={() => void play()}>
                <Play className="mr-2 size-4" />
                {playLabel}
              </Button>
              <Button variant="ghost" size="icon" onClick={toggleMute} title={muted ? "Unmute narration" : "Mute narration"}>
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(next) => {
        setOpen(next);
        if (!next) stopSpeaking();
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="size-4 text-primary" />
              {dialogTitle}
            </DialogTitle>
            <DialogDescription>
              {ttsActive
                ? "Real Cartesia narration plays alongside the avatar — cached, so replays never cost quota."
                : muted || !supported
                  ? "Captions only — narration is muted or unavailable on this device."
                  : "Real narration plays alongside the avatar. Mute it to read the captions instead."}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-border/70 bg-gradient-to-b from-primary/5 to-transparent p-6">
            <div className="mx-auto h-44 w-44 sm:h-52 sm:w-52">
              <AvatarFace speaking={speaking} />
            </div>
          </div>

          {/* Caption track */}
          <div className="min-h-[72px] rounded-xl border border-border/60 bg-background/70 p-4">
            <p className="text-sm leading-relaxed text-foreground/90">
              {scriptLines[lineIndex]}
            </p>
          </div>

          {/* Cached audio element — the same file plays on every replay */}
          {ttsUrl && (
            <audio
              ref={audioRef}
              src={ttsUrl}
              preload="auto"
              className="hidden"
              aria-hidden
            />
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
            >
              <X className="mr-1.5 size-4" />
              Close
            </Button>
            <Button
              variant="outline"
              onClick={toggleMute}
              disabled={!supported && !ttsActive}
            >
              {muted ? <Volume2 className="mr-1.5 size-4" /> : <VolumeX className="mr-1.5 size-4" />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button onClick={() => void play()} disabled={speaking}>
              {speaking ? "Playing…" : "Replay"}
            </Button>
          </div>

          {/* Voice attribution beneath the popup — honest channel + cache state */}
          <div className="flex items-center justify-between border-t border-border/60 px-1 pt-2">
            <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              {ttsActive ? (
                <>
                  <Volume2 className="size-3.5" />
                  Voice: Sonic 3.5 · Cartesia
                  {ttsCached && (
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-400">
                      cached
                    </span>
                  )}
                </>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Volume2 className="size-3.5" />
                  {supported ? "Browser voice" : "Captions only"}
                </span>
              )}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
