import { describe, expect, test } from "bun:test";
import {
  ARB_LABEL_PREFIX,
  EXECUTION_METHODS,
  classifyExecutionMethod,
  type ExecutionMethod,
} from "../execution-method";

describe("execution-method taxonomy", () => {
  test("the three real discovery methods are the whole taxonomy", () => {
    expect(EXECUTION_METHODS).toEqual([
      "triangular",
      "cross-chain",
      "statistical",
    ]);
  });

  test("explicit persisted method wins, valid values pass through", () => {
    for (const m of EXECUTION_METHODS) {
      expect(classifyExecutionMethod(m, "anything")).toBe(m);
    }
  });

  test("unknown persisted methods fall through to the label rule (never guessed)", () => {
    expect(classifyExecutionMethod("voodoo", "WBNB → PCS → CAKE → WBNB")).toBeUndefined();
    expect(classifyExecutionMethod("", "WBNB → PCS → CAKE → WBNB")).toBeUndefined();
    expect(classifyExecutionMethod(undefined, "WBNB → PCS → CAKE → WBNB")).toBeUndefined();
  });

  test("historical ARB-labeled rows classify as statistical from the real prefix", () => {
    expect(classifyExecutionMethod(undefined, "ARB CAKE (triangular)")).toBe("statistical");
    expect(classifyExecutionMethod(undefined, `${ARB_LABEL_PREFIX} DOGE (statistical)`)).toBe(
      "statistical",
    );
  });

  test("the label rule needs the exact prefix with a trailing space", () => {
    expect(classifyExecutionMethod(undefined, "ARBITRUM route")).toBeUndefined();
    expect(classifyExecutionMethod(undefined, "arb CAKE (triangular)")).toBeUndefined();
    expect(classifyExecutionMethod(undefined, "ARB ")).toBe("statistical");
    expect(classifyExecutionMethod(undefined, "ARB")).toBeUndefined();
  });

  test("explicit method beats the label prefix", () => {
    expect(classifyExecutionMethod("cross-chain", "ARB CAKE (triangular)")).toBe("cross-chain");
  });

  test("type-level: only the taxonomy's members are assignable", () => {
    const m: ExecutionMethod = "triangular";
    expect(m).toBe("triangular");
  });
});
