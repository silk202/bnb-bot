import { api } from "@/convex/_generated/api";
import { useAction, useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/copy-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  FALLBACK,
  GREETING,
  QUICK_TOPICS,
  getSupportAnswer,
  type SupportAnswer,
} from "@/lib/support-bot";
import { cn } from "@/lib/utils";
import {
  Bot,
  Check,
  Copy,
  Send,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

type MessageSource = "user" | "greeting" | "kb" | "ai" | "fallback";

interface ChatMessage {
  role: "user" | "bot";
  text: string;
  source?: MessageSource;
  ts?: number;
}

interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  modelLabel: string;
}

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Small SambaNova-style mark shown next to the model name in the footer. */
function SambaMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id="samba-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4F8CFF" />
          <stop offset="100%" stopColor="#7B5CFF" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="url(#samba-g)" />
      <path
        d="M12 5.5 13.9 10.1 18.5 12 13.9 13.9 12 18.5 10.1 13.9 5.5 12 10.1 10.1Z"
        fill="#fff"
      />
    </svg>
  );
}

/**
 * Free built-in support assistant. Instant answers come from the FlashBolt
 * knowledge base; open-ended ones come from a real free AI model (Llama 3.3
 * 70B on SambaNova Cloud) via a server-side Convex action. Asking for a
 * human creates a real support ticket from the conversation. The transcript
 * persists per user, and nothing is mocked or simulated.
 */
export function SupportChat({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const history = useQuery(api.support.listSupportMessages, { limit: 50 });
  const saveMessage = useMutation(api.support.saveSupportMessage);
  const clearHistory = useMutation(api.support.clearSupportHistory);
  const createTicket = useMutation(api.support.createSupportTicket);
  const chatWithAi = useAction(api.support.chatWithAi);
  const aiStatus = useAction(api.support.aiSupportStatus);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "bot", text: GREETING.answer, source: "greeting", ts: Date.now() },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [engine, setEngine] = useState<AiStatus | null>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const seededRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Load the persisted transcript exactly once (per mounted session).
  useEffect(() => {
    if (seededRef.current || history === undefined) return;
    seededRef.current = true;
    if (history.length > 0) {
      setMessages(
        history.map((row) => ({
          role: row.role,
          text: row.text,
          source: row.source,
          ts: row._creationTime,
        })),
      );
    }
  }, [history]);

  // Which engine is active — drives the footer badge (real env check).
  useEffect(() => {
    if (engine !== null) return;
    aiStatus()
      .then((status) => setEngine(status))
      .catch(() => setEngine(null));
  }, [aiStatus, engine]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, typing]);

  const copyMessage = (index: number, text: string) => {
    // Silent success (the check icon is the feedback), but a blocked clipboard
    // is reported — the message bubble used to pretend it had copied.
    void copyText(text, { silent: true }).then((ok) => {
      if (!ok) return;
      setCopiedAt(index);
      window.setTimeout(() => setCopiedAt(null), 1400);
    });
  };

  const botReply = (text: string, source: MessageSource) => {
    setMessages((prev) => [...prev, { role: "bot", text, source, ts: Date.now() }]);
    setTyping(false);
    saveMessage({ role: "bot", text, source }).catch(() => undefined);
  };

  /** Escalate: persist a real ticket + ping the configured channel. */
  const handleTicket = async (kbAnswer: SupportAnswer, query: string) => {
    const transcript = messagesRef.current.map((m) => ({
      role: m.role,
      text: m.text,
    }));
    const reply = await createTicket({ summary: query, transcript }).catch(
      () => null,
    );
    if (!reply) {
      botReply(
        `${kbAnswer.answer} The ticket could not be saved right now — please try again in a moment.`,
        "kb",
      );
      return;
    }
    botReply(
      `Ticket ${reply.reference} created — a human can pick this up with the full transcript (${transcript.length} message${transcript.length === 1 ? "" : "s"}).`,
      "kb",
    );
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || typing) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", text, source: "user", ts: Date.now() },
    ]);
    setInput("");
    setTyping(true);
    saveMessage({ role: "user", text, source: "user" }).catch(() => undefined);

    // 1. Knowledge base answers instantly when confident.
    const answer = getSupportAnswer(text);
    if (answer.topicId === "human-help") {
      await handleTicket(answer, text);
      return;
    }
    if (answer.topicId !== "fallback") {
      window.setTimeout(() => botReply(answer.answer, "kb"), 360);
      return;
    }

    // 2. Otherwise ask the real free AI model.
    try {
      const result = await chatWithAi({
        query: text,
        history: messagesRef.current.slice(-10).map((m) => ({
          role: m.role,
          text: m.text,
        })),
      });
      if (result.ok) {
        botReply(result.text, "ai");
        return;
      }
      if (!result.enabled) {
        const model = engine?.modelLabel ?? "Llama 3.3 70B";
        const provider = engine?.provider ?? "SambaNova";
        botReply(
          `${FALLBACK.answer} The optional AI assistant (${model} on ${provider}) is not configured — add SAMBANOVA_API_KEY in the Keys tab to enable open-ended answers.`,
          "fallback",
        );
        return;
      }
      botReply(
        `${FALLBACK.answer} The AI assistant hit an error: ${result.description}.`,
        "fallback",
      );
    } catch {
      botReply(`${FALLBACK.answer} The AI assistant could not be reached.`, "fallback");
    }
  };

  const handleClear = async () => {
    setMessages([{ role: "bot", text: GREETING.answer, source: "greeting", ts: Date.now() }]);
    try {
      await clearHistory();
    } catch {
      // Local clear stands even if the server call fails.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(680px,90vh)] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-5 py-4 text-left">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Bot className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base">FlashBolt Support</DialogTitle>
              <DialogDescription className="text-xs">
                Free assistant trained on how FlashBolt works
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        >
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div
                key={index}
                className={cn("group flex items-end gap-2", isUser && "flex-row-reverse")}
              >
                <div
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full",
                    isUser
                      ? "bg-primary/20 text-primary"
                      : "border border-border/70 bg-card text-muted-foreground",
                  )}
                >
                  {isUser ? (
                    <UserRound className="size-3.5" />
                  ) : (
                    <Bot className="size-3.5" />
                  )}
                </div>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-5",
                    isUser
                      ? "rounded-br-sm bg-primary text-primary-foreground"
                      : "rounded-bl-sm border border-border/70 bg-card text-foreground",
                  )}
                >
                  <p>{message.text}</p>
                  <div
                    className={cn(
                      "mt-1 flex items-center gap-2",
                      isUser ? "justify-end" : "justify-between",
                    )}
                  >
                    {message.role === "bot" && message.source === "ai" && (
                      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-primary">
                        <SambaMark /> AI answer
                      </span>
                    )}
                    {message.ts && (
                      <span className="font-mono text-[9px] opacity-60">
                        {formatTime(message.ts)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyMessage(index, message.text)}
                  aria-label="Copy message"
                  className="size-6 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                >
                  {copiedAt === index ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              </div>
            );
          })}
          {typing && (
            <div className="flex items-end gap-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground">
                <Bot className="size-3.5" />
              </div>
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-border/70 bg-card px-3.5 py-2.5">
                <Sparkles className="size-3.5 animate-pulse text-primary" />
                <span className="text-xs text-muted-foreground">answering…</span>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border/60 p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK_TOPICS.map((topic) => (
              <button
                key={topic.query}
                type="button"
                onClick={() => void send(topic.query)}
                disabled={typing}
                className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-50"
              >
                {topic.label}
              </button>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                user?.email
                  ? `Ask anything${user.email ? " · " + user.email.split("@")[0] : ""}…`
                  : "Ask anything about FlashBolt…"
              }
              className="h-9 flex-1"
              aria-label="Ask the support assistant"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || typing}
              aria-label="Send"
            >
              <Send className="size-4" />
            </Button>
          </form>
        </div>

        {/* Engine footer — the free model name + mark beneath the popup */}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-1.5">
          <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            {engine?.enabled ? <SambaMark /> : <Bot className="size-3.5" />}
            {engine?.enabled
              ? `${engine.modelLabel} · ${engine.provider}`
              : "Local knowledge base"}
          </span>
          <button
            type="button"
            onClick={() => void handleClear()}
            className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-destructive"
          >
            <Trash2 className="size-3" />
            Clear chat
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
