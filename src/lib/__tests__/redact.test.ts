/**
 * `redactRpcUrl` — provider credentials never travel with an error message.
 */
import { describe, expect, test } from "bun:test";
import { redactRpcUrl } from "../redact";

describe("redactRpcUrl — endpoints without their credentials", () => {
  test("a plain public endpoint survives", () => {
    expect(redactRpcUrl("https://api.devnet.solana.com")).toBe("https://api.devnet.solana.com/");
  });

  test("a query-string API key never survives, its name does", () => {
    const out = redactRpcUrl("https://mainnet.helius-rpc.com/?api-key=1f2e3d4c-5b6a-9c8d");
    expect(out).not.toContain("1f2e3d4c");
    expect(out).toBe("https://mainnet.helius-rpc.com/?api-key=***");
  });

  test("every query value is masked, including ones with innocuous names", () => {
    const out = redactRpcUrl("https://rpc.example.com/bsc?cluster=devnet&x=1f2e3d4c5b6a");
    expect(out).toBe("https://rpc.example.com/bsc?cluster=***&x=***");
  });

  test("a key in the path is masked, a short route is kept", () => {
    expect(redactRpcUrl("https://solana-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOp")).toBe(
      "https://solana-mainnet.g.alchemy.com/v2/***",
    );
    expect(redactRpcUrl("https://rpc.example.com/bsc")).toBe("https://rpc.example.com/bsc");
  });

  test("a real route longer than the old 12-char cutoff is no longer over-redacted", () => {
    // Length alone used to mask these, hiding which endpoint failed.
    expect(redactRpcUrl("https://api.mainnet-beta.solana.com/solana-mainnet")).toBe(
      "https://api.mainnet-beta.solana.com/solana-mainnet",
    );
    expect(redactRpcUrl("https://rpc.example.com/mainnet-beta")).toBe(
      "https://rpc.example.com/mainnet-beta",
    );
  });

  test("key SHAPES are masked even when short: hex, uuid, mixed case, named keys", () => {
    expect(redactRpcUrl("https://rpc.example.com/1f2e3d4c5b6a9c8d")).toBe(
      "https://rpc.example.com/***",
    );
    expect(redactRpcUrl("https://rpc.example.com/1f2e3d4c-5b6a-9c8d-8e7f-1a2b3c4d5e6f")).toBe(
      "https://rpc.example.com/***",
    );
    expect(redactRpcUrl("https://rpc.example.com/my-secret-gateway")).toBe(
      "https://rpc.example.com/***",
    );
    expect(redactRpcUrl("https://rpc.example.com/eyJhbGciOiJIUzI1NiJ9abcdefgh")).toBe(
      "https://rpc.example.com/***",
    );
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
