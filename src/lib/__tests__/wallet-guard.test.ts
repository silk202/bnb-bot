import { describe, expect, test } from "bun:test";
import {
  arbitrageSignerVerdict,
  auditLine,
  breakerVerdict,
  chainConfigVerdict,
  checkTransactionLimits,
  contractArmVerdict,
  DEFAULT_LEVEL,
  evaluateValueMovement,
  nextBreakerState,
  payoutRoleVerdict,
  resolvePayoutTarget,
  tradeSignerVerdict,
  DEFAULT_PAYOUT_LIMITS,
  type OverrideAuthorization,
  type RiskFinding,
} from "../wallet-guard";

const WALLET = "0x944c4c7b3c1a5e4a0b0a1c2d3e4f5a6b7c8d11fa";
const TX = "payout:pos-1";
const NOW = 1_800_000_000_000;

const finding = (kind: RiskFinding["kind"], severity: RiskFinding["severity"] = "low"): RiskFinding => ({
  kind,
  severity,
  detail: `${kind} detail`,
});

const auth = (over: Partial<OverrideAuthorization> = {}): OverrideAuthorization => ({
  operatorId: "terminal-operator",
  reason: "investigated the allowance and it belongs to the router",
  wallet: WALLET,
  txKey: TX,
  issuedAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  ...over,
});

const run = (findings: RiskFinding[], authorization?: OverrideAuthorization | null) =>
  evaluateValueMovement({ findings, wallet: WALLET, txKey: TX, now: NOW, authorization });

describe("levels", () => {
  test("a kind cannot be graded below its default level", () => {
    expect(DEFAULT_LEVEL["drainable-approval"]).toBe("high");
    const v = run([finding("drainable-approval", "low")]);
    expect(v.allow).toBe(false);
    expect(v.level).toBe("high");
  });

  test("low-risk findings are allowed and only logged", () => {
    const v = run([finding("benign-deviation")]);
    expect(v.allow).toBe(true);
    expect(v.logged).toHaveLength(1);
    expect(v.notices).toHaveLength(0);
  });

  test("medium-risk findings are allowed with a warning", () => {
    const v = run([finding("unusual-gas")]);
    expect(v.allow).toBe(true);
    expect(v.notices).toHaveLength(1);
    expect(v.reason).toContain("investigate");
  });

  test("high-risk blocks pending investigation", () => {
    const v = run([finding("honeypot-token")]);
    expect(v.allow).toBe(false);
    expect(v.requiresOverride).toBe(true);
    expect(v.hardBlock).toBe(false);
    expect(v.tripBreaker).toBe(false);
  });
});

describe("level 1 hard blocks are final", () => {
  for (const kind of [
    "confirmed-compromise",
    "malicious-contract",
    "unauthorized-outflow",
    "malicious-approval",
    "unbound-payout-target",
    "non-vault-arbitrage-signer",
    "external-wallet-signer",
  ] as const) {
    test(`${kind} cannot be authorized`, () => {
      const v = run([finding(kind)], auth());
      expect(v.allow).toBe(false);
      expect(v.hardBlock).toBe(true);
      expect(v.requiresOverride).toBe(false);
      expect(v.tripBreaker).toBe(true);
    });
  }
});

describe("authorization requirements", () => {
  test("a valid authorization unlocks a high-risk block", () => {
    const v = run([finding("drainable-approval")], auth());
    expect(v.allow).toBe(true);
    expect(v.audit.decision).toBe("allow");
    expect(v.audit.override?.operatorId).toBe("terminal-operator");
  });

  const cases: [string, Partial<OverrideAuthorization>][] = [
    ["no operator identity", { operatorId: "  " }],
    ["a short reason", { reason: "ok" }],
    ["a different wallet", { wallet: "0x0000000000000000000000000000000000000001" }],
    ["a different transaction", { txKey: "payout:other" }],
    ["an expired window", { issuedAt: NOW - 120_000, expiresAt: NOW - 1000 }],
    ["a window longer than 15 minutes", { issuedAt: NOW - 1000, expiresAt: NOW + 30 * 60_000 }],
    ["a not-yet-valid window", { issuedAt: NOW + 5000, expiresAt: NOW + 60_000 }],
  ];
  for (const [label, over] of cases) {
    test(`refuses ${label}`, () => {
      const v = run([finding("unexplained-outflow")], auth(over));
      expect(v.allow).toBe(false);
      expect(v.requiresOverride).toBe(true);
    });
  }

  test("refuses when no authorization is supplied at all", () => {
    const v = run([finding("unverified-token")], null);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("no operator authorization");
  });
});

describe("audit record", () => {
  test("is canonical and carries the decision, levels and override", () => {
    const v = run([finding("drainable-approval")], auth());
    const line = auditLine(v.audit);
    const parsed = JSON.parse(line);
    expect(parsed.wallet).toBe(WALLET);
    expect(parsed.txKey).toBe(TX);
    expect(parsed.findings[0].kind).toBe("drainable-approval");
    expect(parsed.override.reason).toContain("investigated");
    expect(line).toBe(auditLine(v.audit));
  });
});

describe("transaction limits", () => {
  test("allows inside both limits", () => {
    const r = checkTransactionLimits({ amountNative: 0.1, limits: DEFAULT_PAYOUT_LIMITS, spentTodayNative: 0 });
    expect(r.allowed).toBe(true);
  });

  test("refuses above the per-transaction cap", () => {
    const r = checkTransactionLimits({ amountNative: 0.6, limits: DEFAULT_PAYOUT_LIMITS, spentTodayNative: 0 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Per-transaction");
  });

  test("refuses above the remaining daily exposure", () => {
    const r = checkTransactionLimits({ amountNative: 0.4, limits: DEFAULT_PAYOUT_LIMITS, spentTodayNative: 4.8 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Daily exposure");
  });

  test("refuses non-positive or non-finite amounts", () => {
    expect(checkTransactionLimits({ amountNative: 0, limits: DEFAULT_PAYOUT_LIMITS, spentTodayNative: 0 }).allowed).toBe(false);
    expect(checkTransactionLimits({ amountNative: Number.NaN, limits: DEFAULT_PAYOUT_LIMITS, spentTodayNative: 0 }).allowed).toBe(false);
  });
});

describe("circuit breaker", () => {
  test("closed when nothing tripped", () => {
    expect(breakerVerdict({ trippedAt: null }, NOW).open).toBe(false);
    expect(breakerVerdict(null, NOW).open).toBe(false);
  });

  test("a critical verdict trips it and it stays open", () => {
    const v = run([finding("confirmed-compromise")]);
    const tripped = nextBreakerState({ trippedAt: null }, v, NOW);
    expect(tripped.trippedAt).toBe(NOW);
    expect(breakerVerdict(tripped, NOW + 1).open).toBe(true);
    expect(breakerVerdict(tripped, NOW + 1).reason).toContain("Resume deliberately");
  });

  test("high-risk does not trip it", () => {
    const v = run([finding("honeypot-token")]);
    expect(v.tripBreaker).toBe(false);
    expect(nextBreakerState({ trippedAt: null }, v, NOW).trippedAt).toBeNull();
  });
});

describe("wallet isolation", () => {
  test("operational wallet may pay an external destination", () => {
    expect(payoutRoleVerdict({ signerRole: "operational", destinationRole: "external" }).allowed).toBe(true);
  });

  test("operational wallet may pay treasury or reserve", () => {
    expect(payoutRoleVerdict({ signerRole: "operational", destinationRole: "treasury" }).allowed).toBe(true);
    expect(payoutRoleVerdict({ signerRole: "operational", destinationRole: "reserve" }).allowed).toBe(true);
  });

  test("an external wallet never signs a payout", () => {
    expect(payoutRoleVerdict({ signerRole: "external", destinationRole: "treasury" }).allowed).toBe(false);
  });

  test("a payout must leave the operational wallet", () => {
    expect(payoutRoleVerdict({ signerRole: "operational", destinationRole: "operational" }).allowed).toBe(false);
  });
});

describe("payout destination", () => {
  test("pays the connected wallet", () => {
    expect(resolvePayoutTarget({ connectedAddress: WALLET })).toEqual({
      ok: true,
      address: WALLET,
      reason: expect.stringContaining("connected external wallet"),
    });
  });

  test("refuses nothing connected, garbage, or a different saved address", () => {
    expect(resolvePayoutTarget({}).ok).toBe(false);
    expect(resolvePayoutTarget({ connectedAddress: "0x12" }).ok).toBe(false);
    expect(
      resolvePayoutTarget({ connectedAddress: WALLET, requestedAddress: "0x0000000000000000000000000000000000000002" }).ok,
    ).toBe(false);
  });
});

describe("signer rules", () => {
  test("arbitrage: vault/hot that owns the contract only", () => {
    expect(arbitrageSignerVerdict("vault", { ownsContract: true }).allowed).toBe(true);
    expect(arbitrageSignerVerdict("hot", { ownsContract: false }).allowed).toBe(false);
    expect(arbitrageSignerVerdict("injected", { ownsContract: true }).allowed).toBe(false);
    expect(arbitrageSignerVerdict("none", { ownsContract: true }).allowed).toBe(false);
  });

  test("trades: vault/hot only, external wallets are receive-only", () => {
    expect(tradeSignerVerdict("vault").allowed).toBe(true);
    expect(tradeSignerVerdict("hot").allowed).toBe(true);
    expect(tradeSignerVerdict("injected").allowed).toBe(false);
    expect(tradeSignerVerdict("none").allowed).toBe(false);
  });

  test("contract arming refuses an injected deploy", () => {
    expect(contractArmVerdict(`injected:${WALLET}`).allowed).toBe(false);
    expect(contractArmVerdict(WALLET).allowed).toBe(true);
    expect(contractArmVerdict(undefined).notice).toBeTruthy();
  });
});

describe("chain validation", () => {
  test("mainnet and testnet chainIds are checked independently", () => {
    expect(chainConfigVerdict({ network: "mainnet", chainId: 56, rpcUrl: "https://rpc.example" }).allowed).toBe(true);
    expect(chainConfigVerdict({ network: "testnet", chainId: 97, rpcUrl: "https://rpc.example" }).allowed).toBe(true);
    expect(chainConfigVerdict({ network: "mainnet", chainId: 97, rpcUrl: "https://rpc.example" }).allowed).toBe(false);
    expect(chainConfigVerdict({ network: "testnet", chainId: 56, rpcUrl: "https://rpc.example" }).allowed).toBe(false);
  });

  test("a non-http RPC is refused", () => {
    expect(chainConfigVerdict({ network: "mainnet", chainId: 56, rpcUrl: "ws://relay" }).allowed).toBe(false);
  });
});
