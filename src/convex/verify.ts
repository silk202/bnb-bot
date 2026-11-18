import { v } from "convex/values";
import { action } from "./_generated/server";

/**
 * Real "verify & publish" on BscScan.
 *
 * POSTs the flattened contract source (produced by the compiler worker from
 * the real fetched OpenZeppelin / Uniswap sources) to the official BscScan
 * API. Requires a BscScan API key: paste `BSCSCAN_API_KEY` into the project
 * Keys tab. When no key is configured the action honestly reports
 * `needsKey` — the UI then hands over the flattened source for the manual
 * wizard instead of pretending to verify.
 */
export const verifyContract = action({
  args: {
    contractAddress: v.string(),
    sourceCode: v.string(),
    contractName: v.string(),
    compilerVersion: v.string(),
    constructorArgs: v.string(),
    optimizationRuns: v.number(),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.BSCSCAN_API_KEY;
    if (!apiKey) {
      return { ok: false, needsKey: true, message: "BSCSCAN_API_KEY is not configured." };
    }
    try {
      const body = new URLSearchParams({
        module: "contract",
        action: "verifysourcecode",
        apikey: apiKey,
        contractaddress: args.contractAddress,
        sourceCode: args.sourceCode,
        contractname: args.contractName,
        compilerversion: args.compilerVersion,
        constructorArguArguments: args.constructorArgs.replace(/^0x/, ""),
        optimizationUsed: "1",
        runs: String(Math.max(1, Math.min(100000, args.optimizationRuns))),
        licenseType: "3", // MIT — matches the contract's SPDX header
      });
      const res = await fetch("https://api.bscscan.com/api", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        return {
          ok: false,
          needsKey: false,
          message: `BscScan API HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        status?: string;
        message?: string;
        result?: string;
      };
      return {
        ok: true,
        needsKey: false,
        status: data.status ?? "0",
        message: data.message ?? "Unknown response",
        result: data.result ?? "",
      };
    } catch (error) {
      return {
        ok: false,
        needsKey: false,
        message: error instanceof Error ? error.message : "Verification request failed",
      };
    }
  },
});
