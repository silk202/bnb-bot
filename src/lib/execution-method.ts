/**
 * Execution-method taxonomy shared by the scanner, the Convex trail and the
 * Overview stats — one source of truth, zero dependencies.
 *
 * How each real edge is found:
 *  - "triangular"   same-chain cross-DEX triangle (the classic flasher loop)
 *  - "cross-chain"  same-asset spread across chains, executed on the
 *                   selected chain (the spread adapter's routes)
 *  - "statistical"  discovery-pipeline signal (ARB-labeled auto-arb rows)
 *
 * The trail label prefix is part of the PERSISTED record: historical
 * rows were written with it, so classification of old data reads the same
 * real evidence every writer used — no retroactive invention.
 */
export type ExecutionMethod = "triangular" | "cross-chain" | "statistical";

export const EXECUTION_METHODS: readonly ExecutionMethod[] = [
  "triangular",
  "cross-chain",
  "statistical",
];

/** The real label prefix the scanner stamps on discovery auto-arb rows. */
export const ARB_LABEL_PREFIX = "ARB";

/**
 * Classify an execution row. Explicit persisted `method` wins; historical
 * rows fall back to their real label prefix ("ARB …" ⇒ statistical). Returns
 * undefined when neither evidence source exists — never guesses.
 */
export function classifyExecutionMethod(
  method: string | undefined,
  label: string,
): ExecutionMethod | undefined {
  if (method && (EXECUTION_METHODS as readonly string[]).includes(method)) {
    return method as ExecutionMethod;
  }
  if (label.startsWith(`${ARB_LABEL_PREFIX} `)) return "statistical";
  return undefined;
}
