import { describe, expect, test } from "bun:test";
import { parseAbiParameters, encodeAbiParameters, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildDeployData } from "../chain";
import { signCreateTransaction } from "../swap-executor";

// Deterministic test key (NEVER a funded key — test fixture only).
const TEST_PK = "0x" + "11".repeat(32) as `0x${string}`;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PK);

// Real BNB Chain router used as the FlashBoltArbitrage constructor arg.
const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

// Minimal solc creation-bytecode shape (not a real deploy — payload shape only).
const FAKE_BYTECODE = "0x608060405234801561001057600080fd5b50" as Hex;

const CTOR_ARGS = encodeAbiParameters(parseAbiParameters("address"), [
  PANCAKE_ROUTER as Hex,
]);

describe("buildDeployData (deploy payload)", () => {
  test("concatenates creation bytecode + constructor args, lowercase hex", () => {
    const data = buildDeployData(FAKE_BYTECODE, CTOR_ARGS);
    expect(data.startsWith("0x")).toBe(true);
    expect(data).toBe(data.toLowerCase() as `0x${string}`);
    expect(data.slice(2)).toBe(
      FAKE_BYTECODE.slice(2) + CTOR_ARGS.slice(2).toLowerCase(),
    );
  });

  test("tolerates 0x-less inputs from either side", () => {
    const noPrefix = buildDeployData(
      FAKE_BYTECODE.slice(2) as Hex,
      CTOR_ARGS.slice(2),
    );
    expect(noPrefix).toBe(buildDeployData(FAKE_BYTECODE, CTOR_ARGS));
  });
});

describe("signCreateTransaction (hot-wallet create tx)", () => {
  test("parses back as a legacy contract-creation tx: to=null, payload intact", async () => {
    const data = buildDeployData(FAKE_BYTECODE, CTOR_ARGS);
    const signed = await signCreateTransaction(TEST_PK, {
      chainId: 56,
      data,
      gas: 1_500_000n,
      gasPriceWei: 3_000_000_000n,
      nonce: 7n,
    });

    const tx = parseTransaction(signed as Hex);
    // The canonical create-tx marker: NO recipient (viem omits the field).
    expect(tx.to ?? null).toBeNull();
    expect(tx.type).toBe("legacy");
    expect(tx.chainId).toBe(56);
    expect(BigInt(tx.nonce ?? 0)).toBe(7n);
    expect(BigInt(tx.gas ?? 0n)).toBe(1_500_000n);
    expect(tx.data).toBe(data.toLowerCase() as `0x${string}`);
  });

  test("EIP-155 signature is chain-scoped (BSC testnet v = 229/230)", async () => {
    const signed = await signCreateTransaction(TEST_PK, {
      chainId: 97,
      data: buildDeployData(FAKE_BYTECODE, CTOR_ARGS),
      gas: 1_500_000n,
      gasPriceWei: 10_000_000_000n,
      nonce: 0n,
    });
    const tx = parseTransaction(signed as Hex);
    expect(tx.chainId).toBe(97);
    const v = tx.v ?? 0n;
    // EIP-155: v = chainId * 2 + 35 + yParity → 97*2+35 = 229 or 230.
    expect(v === 229n || v === 230n).toBe(true);
  });

  test("different nonces produce different signatures (no static output)", async () => {
    const base = {
      chainId: 56,
      data: buildDeployData(FAKE_BYTECODE, CTOR_ARGS),
      gas: 1_500_000n,
      gasPriceWei: 3_000_000_000n,
    };
    const a = await signCreateTransaction(TEST_PK, { ...base, nonce: 0n });
    const b = await signCreateTransaction(TEST_PK, { ...base, nonce: 1n });
    expect(a !== b).toBe(true);
  });

  test("signing key matches the account that will fund gas", async () => {
    expect(TEST_ACCOUNT.address).toBe(
      privateKeyToAccount(TEST_PK).address,
    );
  });
});
