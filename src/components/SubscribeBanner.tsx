import { Play } from "lucide-react";

/**
 * Thumbnail banner — recreated faithfully from the uploaded advertisement
 * artwork: white left half, dark slate right half, magenta zig-zag divider,
 * the four stacked headline words and a vector bust with glasses (the photo
 * was not available as a file in the workspace, so the figure is drawn).
 */
export function SubscribeBanner({ onSubscribe }: { onSubscribe: () => void }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/70 shadow-xl">
      {/* Base artwork */}
      <div className="relative aspect-[16/9] w-full select-none sm:aspect-[16/7]">
        {/* White left half + dark right half */}
        <div className="absolute inset-0 bg-white dark:bg-zinc-100" />
        <div
          className="absolute inset-y-0 right-0 w-[52%]"
          style={{ backgroundColor: "#2d323e" }}
        />

        {/* Magenta zig-zag divider */}
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 640 400"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d="M 372,0 L 412,40 L 372,80 L 412,120 L 372,160 L 412,200 L 372,240 L 412,280 L 372,320 L 412,360 L 372,400 L 640,400 L 640,0 Z"
            fill="#e61b6f"
          />
        </svg>

        {/* 2x4 dot grid, top center-left */}
        <div className="absolute left-[22%] top-[7%] grid grid-cols-4 gap-1.5 opacity-80">
          {Array.from({ length: 8 }).map((_, i) => (
            <span
              key={i}
              className="size-1.5 rounded-full"
              style={{ backgroundColor: "#196127" }}
            />
          ))}
        </div>

        {/* Headline stack */}
        <div className="absolute left-[6%] top-[16%] flex flex-col leading-none">
          <span
            className="text-2xl font-black tracking-tight sm:text-4xl"
            style={{ color: "#196127" }}
          >
            ONLINE
          </span>
          <span
            className="text-3xl font-black tracking-tight sm:text-5xl"
            style={{ color: "#6b2d75" }}
          >
            TRIANGULAR
          </span>
          <span
            className="text-3xl font-black tracking-tight sm:text-5xl"
            style={{ color: "#6b2d75" }}
          >
            ARBITRAGE
          </span>
          <span
            className="text-4xl font-black tracking-tight sm:text-6xl"
            style={{ color: "#f00b51" }}
          >
            TRADING
          </span>
        </div>

        {/* Vector bust with glasses (stands in for the original photo) */}
        <svg
          className="absolute bottom-0 right-[6%] h-[92%]"
          viewBox="0 0 220 260"
          aria-hidden
        >
          {/* shoulders */}
          <path
            d="M 20,260 C 30,190 70,160 110,160 C 150,160 190,190 200,260 Z"
            fill="#f4f5f7"
          />
          {/* neck */}
          <rect x="96" y="140" width="28" height="34" rx="8" fill="#e8e9ec" />
          {/* head */}
          <ellipse cx="110" cy="92" rx="46" ry="54" fill="#f4f5f7" />
          {/* hair bun */}
          <circle cx="140" cy="46" r="22" fill="#3a3f4b" />
          <path
            d="M 64,78 C 60,40 96,26 122,30 C 128,31 128,48 122,50 C 96,54 76,64 76,84 Z"
            fill="#3a3f4b"
          />
          {/* glasses */}
          <circle cx="92" cy="96" r="16" fill="none" stroke="#1b1e24" strokeWidth="5" />
          <circle cx="130" cy="96" r="16" fill="none" stroke="#1b1e24" strokeWidth="5" />
          <path d="M 108,94 L 114,94" stroke="#1b1e24" strokeWidth="5" />
          {/* smile */}
          <path
            d="M 98,116 Q 112,128 124,116"
            fill="none"
            stroke="#b2434f"
            strokeWidth="4"
            strokeLinecap="round"
          />
          {/* blazer lapel */}
          <path
            d="M 88,168 L 110,196 L 132,168"
            fill="none"
            stroke="#d7d9de"
            strokeWidth="5"
          />
          <rect x="104" y="196" width="12" height="30" rx="3" fill="#1b1e24" />
        </svg>
      </div>

      {/* Subscribe NOW button (clickable) */}
      <button
        type="button"
        onClick={onSubscribe}
        className="absolute bottom-[8%] left-[6%] inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#3a3f4b] px-4 py-2 text-sm font-bold text-white shadow-lg transition-all hover:scale-105 hover:bg-[#2d323e] active:scale-95 sm:px-6 sm:py-3 sm:text-base"
      >
        <span className="inline-flex size-6 items-center justify-center rounded bg-[#f00b51]">
          <Play className="size-3.5 fill-white text-white" />
        </span>
        SUBSCRIBE NOW
      </button>
    </div>
  );
}
