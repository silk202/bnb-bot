import { describe, expect, test } from "bun:test";
import {
  FALLBACK,
  getSupportAnswer,
} from "@/lib/support-bot";

describe("support-bot", () => {
  test("greeting returns the greeting topic", () => {
    expect(getSupportAnswer("hi there").topicId).toBe("greeting");
    expect(getSupportAnswer("Hello!").topicId).toBe("greeting");
  });

  test("thanks is acknowledged", () => {
    expect(getSupportAnswer("thanks a lot").topicId).toBe("thanks");
  });

  test("deploy question maps to the deploy topic", () => {
    const answer = getSupportAnswer("how do I deploy my contract?");
    expect(answer.topicId).toBe("deploy");
    expect(answer.answer).toContain("auto-compiles");
  });

  test("wallet connect problem maps to the wallets topic", () => {
    const answer = getSupportAnswer("my wallet won't connect to the terminal");
    expect(answer.topicId).toBe("wallets");
    expect(answer.answer).toContain("EIP-1193");
  });

  test("verify on bscscan maps to the verify topic", () => {
    const answer = getSupportAnswer("how do I verify the contract on BscScan?");
    expect(answer.topicId).toBe("verify");
    expect(answer.answer).toContain("BSCSCAN_API_KEY");
  });

  test("history receipt question maps to the history topic", () => {
    const answer = getSupportAnswer("where can I see the transaction receipt?");
    expect(answer.topicId).toBe("history-receipts");
    expect(answer.answer).toContain("explorer");
  });

  test("gas / rpc question maps to the gas topic", () => {
    const answer = getSupportAnswer("gas price is too high, can I use a private RPC?");
    expect(answer.topicId).toBe("gas");
    expect(answer.answer).toContain("effectiveRpc");
  });

  test("chain switching maps to the multi-chain topic", () => {
    const answer = getSupportAnswer("how do I switch from BNB to Arbitrum?");
    expect(answer.topicId).toBe("multi-chain");
    expect(answer.answer).toContain("top centre");
  });

  test("telegram alerts map to the telegram topic", () => {
    const answer = getSupportAnswer("can I get alerts on telegram?");
    expect(answer.topicId).toBe("telegram");
    expect(answer.answer).toContain("TELEGRAM_BOT_TOKEN");
  });

  test("pnl question maps to the pnl topic", () => {
    const answer = getSupportAnswer("show me my profit and loss overview");
    expect(answer.topicId).toBe("pnl");
    expect(answer.answer).toContain("net of the real gas paid");
  });

  test("problem reports route to troubleshooting", () => {
    const answer = getSupportAnswer("the bot is not working, it keeps failing");
    expect(answer.topicId).toBe("troubleshooting");
    expect(answer.answer).toContain("Common causes");
  });

  test("setup question maps to the setup-local topic", () => {
    const answer = getSupportAnswer("how do I run flashbolt locally?");
    expect(answer.topicId).toBe("setup-local");
    expect(answer.answer).toContain("bun install");
  });

  test("env / keys question maps to the env-keys topic", () => {
    const answer = getSupportAnswer("where do I put my API keys and env vars?");
    expect(answer.topicId).toBe("env-keys");
    expect(answer.answer).toContain("Keys/API keys");
  });

  test("mirror packaging question maps to the mirror-package topic", () => {
    const answer = getSupportAnswer("how do I package the mirror zip for project 2?");
    expect(answer.topicId).toBe("mirror-package");
    expect(answer.answer).toContain("package:mirror");
  });

  test("version question maps to the version-release topic", () => {
    const answer = getSupportAnswer("what version of the app is this?");
    expect(answer.topicId).toBe("version-release");
    expect(answer.answer).toContain("CHANGELOG");
  });

  test("ai model question maps to the ai-support topic", () => {
    const answer = getSupportAnswer("does support use an AI model?");
    expect(answer.topicId).toBe("ai-support");
    expect(answer.answer).toContain("SAMBANOVA_API_KEY");
  });

  test("asking for a human maps to the human-help topic", () => {
    const answer = getSupportAnswer("I want to talk to a real support agent");
    expect(answer.topicId).toBe("human-help");
    expect(answer.answer).toContain("ticket");
  });

  test("ticket escalation phrase maps to the human-help topic", () => {
    expect(getSupportAnswer("please escalate this to a human").topicId).toBe(
      "human-help",
    );
  });

  test("unrelated gibberish falls back honestly", () => {
    const answer = getSupportAnswer("quarkonium flux capacitor recipes");
    expect(answer.topicId).toBe("fallback");
    expect(answer.answer).toContain("won't guess");
  });

  test("empty query falls back", () => {
    expect(getSupportAnswer("   ").topicId).toBe("fallback");
    expect(FALLBACK.topicId).toBe("fallback");
  });
});

describe("support-bot — Solana terminal coverage", () => {
  test("SOL terminal question maps to the sol-terminal topic", () => {
    const answer = getSupportAnswer("how does the Solana sniper work?");
    expect(answer.topicId).toBe("sol-terminal");
    expect(answer.answer).toContain("Jupiter");
  });

  test("flash-loan balance question maps to the sol-arb-balance topic with the real math", () => {
    const answer = getSupportAnswer("do I have enough SOL for a 5 SOL flash loan?");
    expect(answer.topicId).toBe("sol-arb-balance");
    expect(answer.answer).toContain("5.005 SOL");
    expect(answer.answer).toContain("0.005 SOL");
    // Wallet-fit: oversized clips shrink to what the wallet can front.
    expect(answer.answer).toContain("0.056 SOL clip");
    expect(answer.answer).toContain("0.055 SOL total");
  });

  test("how much SOL question routes to the balance topic", () => {
    expect(getSupportAnswer("how much SOL do I need?").topicId).toBe("sol-arb-balance");
  });

  test("session passphrase question maps to the sol-wallets topic", () => {
    const answer = getSupportAnswer("what do I put in the session passphrase?");
    expect(answer.topicId).toBe("sol-wallets");
    expect(answer.answer).toContain("AES-256-GCM");
  });

  test("phantom import question routes to sol-wallets over the BNB wallets topic", () => {
    const answer = getSupportAnswer("how do I import a phantom wallet?");
    expect(answer.topicId).toBe("sol-wallets");
    expect(answer.answer).toContain("BIP39");
  });

  test("connect wallet on solana routes to sol-wallets", () => {
    expect(getSupportAnswer("connect a wallet on solana").topicId).toBe("sol-wallets");
  });

  test("max loan question maps to the sol-strategy topic", () => {
    const answer = getSupportAnswer("what is the max loan on Solana?");
    expect(answer.topicId).toBe("sol-strategy");
    expect(answer.answer).toContain("0.05–50 SOL");
  });

  test("generic BNB wallet question still routes to the BNB wallets topic", () => {
    expect(getSupportAnswer("my wallet won't connect to the terminal").topicId).toBe("wallets");
  });

  test("BNB slippage question still routes to the BNB strategy topic", () => {
    expect(getSupportAnswer("change the slippage setting").topicId).toBe("strategy");
  });
});

describe("support-bot — funding guidance", () => {
  test("funding question routes to the funding topic with network guidance", () => {
    const answer = getSupportAnswer("how do I fund my wallet?");
    expect(answer.topicId).toBe("funding");
    expect(answer.answer).toContain("BNB Smart Chain");
    expect(answer.answer).toContain("Solana");
  });

  test("exchange-withdrawal network question routes to funding", () => {
    const answer = getSupportAnswer("which network do I pick when withdrawing from an exchange");
    expect(answer.topicId).toBe("funding");
    expect(answer.answer).toContain("same network");
  });

  test("payout question still routes to auto-payout, not funding", () => {
    expect(getSupportAnswer("where do my profits get paid out").topicId).toBe("auto-payout");
  });

  test("wallet-connection question still routes to wallets, not funding", () => {
    expect(getSupportAnswer("my metamask will not connect").topicId).toBe("wallets");
  });
});
