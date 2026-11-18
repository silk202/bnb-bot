import { describe, expect, test } from "bun:test";
import { decodeApprovals } from "../wallet-history";
import { classifyApproval } from "../wallet-risk";
import { UNLIMITED_THRESHOLD } from "../wallet-risk";

const TOKEN = "0x91975b5fdb5cc54eead4aa264039e401d4fe5634";
const SPENDER = "0x1de460f363af910f51726def188f9004276bf4bc";
// approve(spender, 2^256-1)
const MAX = "f".repeat(64);
const unlimitedApprove = `0x095ea7b3${"0".repeat(24)}${SPENDER.slice(2)}${MAX}`;
// approve(spender, 1000)
const finiteApprove = `0x095ea7b3${"0".repeat(24)}${SPENDER.slice(2)}${1000n.toString(16).padStart(64, "0")}`;
// setApprovalForAll(spender, true)
const approveAll = `0xa22cb465${"0".repeat(24)}${SPENDER.slice(2)}${"0".repeat(63)}1`;

describe("decodeApprovals", () => {
  test("decodes an unlimited ERC-20 approve", () => {
    const [a] = decodeApprovals([{ to: TOKEN, input: unlimitedApprove }], 123);
    expect(a.kind).toBe("erc20");
    expect(a.token).toBe(TOKEN);
    expect(a.spender).toBe(SPENDER);
    expect(a.granted).toBe(UNLIMITED_THRESHOLD * 2n - 1n);
    expect(a.block).toBe(123);
  });

  test("decodes a finite approve", () => {
    const [a] = decodeApprovals([{ to: TOKEN, input: finiteApprove }], 5);
    expect(a.granted).toBe(1000n);
  });

  test("decodes approveForAll", () => {
    const [a] = decodeApprovals([{ to: TOKEN, input: approveAll }], 9);
    expect(a.kind).toBe("erc721/1155");
    expect(a.approvedAll).toBe(true);
  });

  test("ignores unrelated calls, contract creations and short calldata", () => {
    expect(decodeApprovals([{ to: TOKEN, input: "0xdeadbeef" }], 1)).toEqual([]);
    expect(decodeApprovals([{ to: null, input: unlimitedApprove }], 1)).toEqual([]);
    expect(decodeApprovals([{ to: TOKEN, input: "0x095ea7b3ff" }], 1)).toEqual([]);
  });

  // The whole point: a spender discovered from history is NOT in the trusted
  // set, so an unlimited allowance to it blocks the payout.
  test("a history-discovered unlimited approval grades as blocking", () => {
    const [a] = decodeApprovals([{ to: TOKEN, input: unlimitedApprove }], 1);
    const trusted = new Set<string>();
    const finding = classifyApproval({
      token: a.token,
      spender: a.spender,
      allowance: a.granted ?? 0n,
      knownSpenders: trusted,
    });
    expect(finding?.kind).toBe("drainable-approval");
    expect(finding?.severity).toBe("high");
  });
});
