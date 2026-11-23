/**
 * `redactRpcUrl` — provider credentials never travel with an error message.
 */
import { describe, expect, test } from "bun:test";
import { redactRpcUrl } from "../redact";

describe("redactRpcUrl — endpoints without their credentials", () => {
  test("a plain public endpoint survives", () => {
    expect(redactRpcUrl("https://api.devnet.solana.com")).toBe("https://api.devnet.solana.com/");
  });

  test("a query-string API key never survives", () => {
    const out = redactRpcUrl("https://mainnet.helius-rpc.com/?api-key=1f2e3d4c-5b6a-9c8d");
    expect(out).not.toContain("1f2e3d4c");
    expect(out).toBe("https://mainnet.helius-rpc.com/?***");
  });

  test("a key in the path is masked, a short route is kept", () => {
    expect(redactRpcUrl("https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOp")).toBe(
      "https://solana-mainnet.g.alchemy.com/v2/***",
    );
    expect(redactRpcUrl("https://rpc.example.com/bsc")).toBe("https://rpc.example.com/bsc");
  });

  test("userinfo credentials are dropped, the host is kept", () => {
    expect(redactRpcUrl("https://user:secret@rpc.example.com/path")).toBe(
      "https://rpc.example.com/path",
    );
  });

  test("something that is not a URL is never echoed back", () => {
    expect(redactRpcUrl("supersecretkey")).toBe("(unreadable RPC URL)");
    expect(redactRpcUrl("")).toBe("(unreadable RPC URL)");
  });
});
