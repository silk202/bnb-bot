/**
 * DEX + flash-loan validation.
 *
 * Liquidity is proven by asking the factory for a pair that actually exists —
 * a token list alone proves nothing. Flash-loan sources are validated by code
 * presence on the right chain; the amount available is a runtime property and is
 * reported as unknown rather than guessed.
 */
import type { ValidationOutcome } from "../registry/chain-types";

export interface DexProbe {
  call(to: string, data: string): Promise<string>;
  code(address: string): Promise<string>;
}

/** Uniswap/Pancake V2 factory: getPair(address,address) */
export const SELECTOR_GET_PAIR = "0xe6a43905";

const pad = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const ZERO = `0x${"0".repeat(64)}`;

export async function validateDex(args: {
  probe: DexProbe;
  factory?: string;
  wrapped?: string;
  tokens: string[];
}): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = [];

  if (!args.factory || !args.wrapped) {
    outcomes.push({
      requirement: "liquidity",
      result: "pending",
      detail: "No factory/wrapped-native pair to query on this network.",
    });
  } else if (args.tokens.length === 0) {
    outcomes.push({
      requirement: "liquidity",
      result: "pending",
      detail: "Factory is known but no tokens are configured to check a real pool.",
    });
  } else {
    const missing: string[] = [];
    const found: string[] = [];
    for (const token of args.tokens) {
      try {
        const pair = await args.probe.call(args.factory, `${SELECTOR_GET_PAIR}${pad(args.wrapped)}${pad(token)}`);
        if (pair.toLowerCase() === ZERO) missing.push(token);
        else found.push(token);
      } catch (e) {
        missing.push(`${token} (${e instanceof Error ? e.message : "call failed"})`);
      }
    }
    outcomes.push({
      requirement: "liquidity",
      result: missing.length === 0 ? "pass" : "fail",
      detail:
        missing.length === 0
          ? `${found.length} pool(s) exist against the wrapped native token.`
          : `No pool for: ${missing.slice(0, 3).join(", ")}`,
    });
  }

  return outcomes;
}

export async function validateFlashLoans(args: {
  probe: DexProbe;
  lenders: string[];
}): Promise<ValidationOutcome> {
  if (args.lenders.length === 0) {
    return {
      requirement: "flashloan",
      result: "pending",
      detail: "No flash-loan provider recorded for this network — adapter unsupported here.",
    };
  }
  const verified: string[] = [];
  const broken: string[] = [];
  for (const lender of args.lenders) {
    try {
      const code = await args.probe.code(lender);
      if (code && code !== "0x") verified.push(lender);
      else broken.push(lender);
    } catch {
      broken.push(lender);
    }
  }
  if (verified.length === 0) {
    return {
      requirement: "flashloan",
      result: "fail",
      detail: `None of the ${args.lenders.length} recorded lender(s) have code on this chain.`,
    };
  }
  return {
    requirement: "flashloan",
    result: "pass",
    detail: `${verified.length}/${args.lenders.length} lender(s) have code (available liquidity is a runtime property, not asserted here).${broken.length ? ` No code at: ${broken.slice(0, 2).join(", ")}` : ""}`,
  };
}
