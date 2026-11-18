/**
 * SOL FlashBolt — position exit engine (PURE, deterministic, fully tested).
 *
 * Turns the sniper's three /settings values into an honest exit decision:
 *   · profitTargetPct  — the take-profit level
 *   · sellAmountPct    — the slice sold AT the target (e.g. 100 = full exit)
 *   · trailingStopPct  — give-back from the peak that closes the remainder
 *
 * Every input is REAL (entry cost basis, live Jupiter quote of the actual
 * on-chain balance, observed peak) and every output is an executable
 * instruction — nothing here guesses, mocks, or fabricates fills.
 */
export interface PositionInput {
  /** SOL (lamports) actually spent to open the position. */
  entryLamports: number;
  /** Token raw units currently held on-chain (from getTokenAccountsByOwner). */
  balanceRaw: string;
  /** Real Jupiter quote: selling the FULL balance returns this many lamports. */
  /** Null = no route / quote failed → honest hold. */
  sellOutLamports: number | null;
  /** Peak net ROI % observed since entry (feeds the trailing stop). */
  peakRoiPct: number;
  /** /settings: take-profit level in percent (e.g. 12 → +12%). */
  profitTargetPct: number;
  /** /settings: percent of the position sold at the target (0–100). */
  sellAmountPct: number;
  /** /settings: trailing stop give-back in percent from the peak. */
  trailingStopPct: number;
}

export type ExitReason = "profit_target" | "trailing_stop" | "stop_loss_floor" | "none";

export interface ExitDecision {
  /** Whether a sell should fire right now. */
  shouldExit: boolean;
  /** Why — honest label for the ledger row / toast. */
  reason: ExitReason;
  /** Token raw units to sell (clamped to the real balance). */
  amountRaw: string;
  /** Current net ROI % at the live quote. */
  currentRoiPct: number;
  /** Updated peak to carry into the next evaluation. */
  newPeakRoiPct: number;
}

const ZERO: ExitDecision = {
  shouldExit: false,
  reason: "none",
  amountRaw: "0",
  currentRoiPct: 0,
  newPeakRoiPct: 0,
};

/**
 * Decide the exit for one evaluation tick. Pure: same inputs → same output.
 * ROI is computed against the REAL entry cost and the REAL sell quote —
 * no "typical first-leg move" fabrication anywhere.
 */
export function decideExit(input: PositionInput): ExitDecision {
  const {
    entryLamports,
    balanceRaw,
    sellOutLamports,
    peakRoiPct,
    profitTargetPct,
    sellAmountPct,
    trailingStopPct,
  } = input;

  const balance = BigInt(balanceRaw || "0");
  if (balance <= 0n || sellOutLamports === null || entryLamports <= 0) {
    return { ...ZERO, newPeakRoiPct: peakRoiPct };
  }

  // Real net: full-balance sell proceeds minus the entry cost.
  const sellOut = sellOutLamports;
  const netLamports = sellOut - entryLamports;
  const roiPct = entryLamports > 0 ? (netLamports / entryLamports) * 100 : 0;
  const newPeak = Math.max(peakRoiPct, roiPct);

  const scale = (fraction: number): string => {
    const raw = (balance * BigInt(Math.round(Math.min(100, Math.max(0, fraction)) * 100))) / 10_000n;
    return raw.toString();
  };

  // 1) Take-profit: ROI at/above target → sell the configured slice.
  if (profitTargetPct > 0 && roiPct >= profitTargetPct) {
    const fraction = sellAmountPct <= 0 ? 100 : sellAmountPct;
    return {
      shouldExit: true,
      reason: "profit_target",
      amountRaw: scale(fraction),
      currentRoiPct: roiPct,
      newPeakRoiPct: newPeak,
    };
  }

  // 2) Trailing stop: peak was meaningful and gave back the configured %.
  if (
    trailingStopPct > 0 &&
    newPeak >= trailingStopPct && // never trail from a peak that never paid
    roiPct <= newPeak - trailingStopPct
  ) {
    return {
      shouldExit: true,
      reason: "trailing_stop",
      amountRaw: balance.toString(), // the remainder exits whole
      currentRoiPct: roiPct,
      newPeakRoiPct: newPeak,
    };
  }

  return {
    shouldExit: false,
    reason: "none",
    amountRaw: "0",
    currentRoiPct: roiPct,
    newPeakRoiPct: newPeak,
  };
}
