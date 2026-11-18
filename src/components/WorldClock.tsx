import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  UTC_OFFSETS,
  UTC_OFFSET_STORAGE_KEY,
  offsetLabel,
  readStoredOffset,
  utcShifted,
} from "@/lib/utc-clock";

/**
 * Real-time world clock — the visitor's actual device clock shifted into a
 * selectable UTC offset, ticking every second. Time renders as 00:00:00 with
 * the date as MMM:DD:YYYY beneath it (e.g. AUG:09:2026), and a dropdown arrow
 * next to UTC picks an offset from UTC-12 … UTC+14 (persisted across pages).
 * No simulation: it is always the real clock, just displayed in the chosen
 * timezone.
 */
export function WorldClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  const [offset, setOffset] = useState<number>(() => readStoredOffset());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(UTC_OFFSET_STORAGE_KEY, String(offset));
  }, [offset]);

  const { time, date } = utcShifted(now, offset);

  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-primary/25 bg-primary/8 px-2.5 py-1.5 font-mono leading-tight",
        className,
      )}
      aria-label="Real-time world clock"
    >
      <span className="flex items-center gap-1 text-sm font-bold tabular-nums tracking-[0.14em] text-foreground">
        {time}
        <Select
          value={String(offset)}
          onValueChange={(value) => setOffset(Number(value))}
        >
          <SelectTrigger
            aria-label="UTC offset"
            className="h-5 w-auto gap-0.5 border-0 bg-transparent p-0 pr-0.5 text-[10px] font-bold tracking-normal text-primary shadow-none focus:ring-0 focus-visible:ring-0"
          >
            <SelectValue>{offsetLabel(offset)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" className="max-h-64">
            {UTC_OFFSETS.map((o) => (
              <SelectItem key={o} value={String(o)}>
                {offsetLabel(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <span className="mt-0.5 text-[10px] font-bold tracking-[0.2em] text-primary">
        {date}
      </span>
    </div>
  );
}
