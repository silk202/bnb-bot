/**
 * Token validation.
 *
 * A token is only usable if it answers as an ERC-20 on THIS chain: `decimals`
 * must be sane, `symbol` must decode, and `balanceOf` must not revert. Symbols
 * are not identity — the pair check in dex-validator is what ties a token to
 * real liquidity.
 */
import type { ValidationOutcome } from "../registry/chain-types";

export interface TokenProbe {
  call(to: string, data: string): Promise<string>;
}

export const SELECTOR_DECIMALS = "0x313ce567";
export const SELECTOR_SYMBOL = "0x95d89b41";
export const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_ALLOWANCE = "0xdd62ed3e";

const pad = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const decodeSymbol = (hex: string): string | undefined => {
  const body = hex.slice(2);
  if (body.length < 128) return undefined;
  const length = Number.parseInt(body.slice(64, 128), 16);
  if (!Number.isFinite(length) || length <= 0 || length > 64) return undefined;
  const data = body.slice(128, 128 + length * 2);
  try {
    return Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return undefined;
  }
};

export async function validateTokens(args: {
  probe: TokenProbe;
  tokens: string[];
  owner?: string;
}): Promise<ValidationOutcome[]> {
  if (args.tokens.length === 0) {
    return [{ requirement: "tokens", result: "pending", detail: "No token registry configured for this network." }];
  }
  const failures: string[] = [];
  const ok: string[] = [];

  for (const token of args.tokens) {
    try {
      const decimalsHex = await args.probe.call(token, SELECTOR_DECIMALS);
      const decimals = Number.parseInt(decimalsHex.slice(-2) === "00" ? decimalsHex.slice(2, 66) : decimalsHex.slice(2, 66), 16);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
        failures.push(`${token}: implausible decimals`);
        continue;
      }
      const symbolHex = await args.probe.call(token, SELECTOR_SYMBOL);
      if (!decodeSymbol(symbolHex)) {
        failures.push(`${token}: symbol() did not decode`);
        continue;
      }
      if (args.owner) {
        await args.probe.call(token, `${SELECTOR_BALANCE_OF}${pad(args.owner)}`);
      }
      ok.push(token);
    } catch (e) {
      failures.push(`${token}: ${e instanceof Error ? e.message : "call failed"}`);
    }
  }

  if (failures.length > 0) {
    return [
      {
        requirement: "tokens",
        result: "fail",
        detail: `${failures.length}/${args.tokens.length} token(s) unusable: ${failures.slice(0, 3).join("; ")}`,
      },
    ];
  }
  return [
    {
      requirement: "tokens",
      result: "pass",
      detail: `${ok.length} token(s) answered decimals/symbol${args.owner ? " (balanceOf checked)" : ""}.`,
    },
  ];
}

/** Allowance probe used by the wallet guard for spenders on this chain. */
export const allowanceCallData = (owner: string, spender: string): string =>
  `${SELECTOR_ALLOWANCE}${pad(owner)}${pad(spender)}`;
