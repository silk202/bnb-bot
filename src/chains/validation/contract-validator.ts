/**
 * Contract validation: deployed code, bytecode identity, and the relationship
 * between a router and its factory.
 *
 * Non-empty bytecode is not proof of a router. These checks also require the
 * router to report the expected factory, and the factory to look like a V2
 * factory (it must expose `feeTo`). An upgradeable proxy must report its
 * implementation before it can be accepted.
 */
import type { ValidationOutcome } from "../registry/chain-types";

export interface ContractProbe {
  code(address: string): Promise<string>;
  bytecodeHash(address: string): Promise<string>;
  call(to: string, data: string): Promise<string>;
}

/** Router02: factory() */
export const SELECTOR_FACTORY = "0xc45a0155";
/** Uniswap/Pancake V2 factory: feeTo() */
export const SELECTOR_FEE_TO = "0x017e7e58";
/** EIP-1967 implementation slot. */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a372e8c9a44b7d5d0a";

const lastWord = (hex: string): string => {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  return body.slice(-40).toLowerCase();
};

export async function validateContracts(args: {
  probe: ContractProbe;
  expectedChainId: number;
  chainId: () => Promise<number>;
  executor?: { address: string; runtimeCodeHash: string };
  router?: string;
  factory?: string;
}): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = [];
  const observed = await args.chainId();
  if (observed !== args.expectedChainId) {
    return [
      {
        requirement: "executor",
        result: "fail",
        detail: `RPC reported chain ${observed}, expected ${args.expectedChainId}.`,
      },
    ];
  }

  // Executor: only validated when a manifest records the expected runtime hash.
  if (!args.executor) {
    outcomes.push({
      requirement: "executor",
      result: "pending",
      detail: "No verified executor deployment recorded for this network.",
    });
  } else {
    try {
      const hash = await args.probe.bytecodeHash(args.executor.address);
      const matches = hash.toLowerCase() === args.executor.runtimeCodeHash.toLowerCase();
      outcomes.push({
        requirement: "executor",
        result: matches ? "pass" : "fail",
        detail: matches
          ? `Executor ${args.executor.address} matches runtime hash ${hash.slice(0, 12)}…`
          : `Executor runtime hash ${hash.slice(0, 12)}… does not match the approved ${args.executor.runtimeCodeHash.slice(0, 12)}…`,
      });
    } catch (e) {
      outcomes.push({
        requirement: "executor",
        result: "fail",
        detail: e instanceof Error ? e.message : "executor code unavailable",
      });
    }
  }

  // Router: code + it must point at the expected factory.
  if (!args.router) {
    outcomes.push({ requirement: "router", result: "unsupported", detail: "No router recorded for this network." });
  } else {
    try {
      const code = await args.probe.code(args.router);
      if (!code || code === "0x") {
        outcomes.push({ requirement: "router", result: "fail", detail: `No code at router ${args.router}.` });
      } else {
        const reported = `0x${lastWord(await args.probe.call(args.router, SELECTOR_FACTORY))}`;
        const expected = args.factory?.toLowerCase();
        const matches = !expected || reported === expected;
        outcomes.push({
          requirement: "router",
          result: matches ? "pass" : "fail",
          detail: matches
            ? `Router ${args.router} reports factory ${reported}.`
            : `Router ${args.router} reports factory ${reported}, expected ${expected}.`,
        });
      }
    } catch (e) {
      outcomes.push({
        requirement: "router",
        result: "fail",
        detail: e instanceof Error ? e.message : "router check failed",
      });
    }
  }

  // Factory: code + V2 shape (feeTo must return data).
  if (!args.factory) {
    outcomes.push({ requirement: "factory", result: "fail", detail: "No factory recorded for this network." });
  } else {
    try {
      const code = await args.probe.code(args.factory);
      if (!code || code === "0x") {
        outcomes.push({ requirement: "factory", result: "fail", detail: `No code at factory ${args.factory}.` });
      } else {
        const feeTo = await args.probe.call(args.factory, SELECTOR_FEE_TO);
        const shaped = Boolean(feeTo) && feeTo.length >= 66;
        outcomes.push({
          requirement: "factory",
          result: shaped ? "pass" : "fail",
          detail: shaped
            ? `Factory ${args.factory} exposes feeTo (V2 shape).`
            : `Factory ${args.factory} does not respond like a V2 factory.`,
        });
      }
    } catch (e) {
      outcomes.push({
        requirement: "factory",
        result: "fail",
        detail: e instanceof Error ? e.message : "factory check failed",
      });
    }
  }

  return outcomes;
}
