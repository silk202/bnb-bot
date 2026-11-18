#!/usr/bin/env bun
/**
 * FlashBolt wallet exposure audit — READ-ONLY.
 *
 * Answers the three questions that matter after a drain, for any EVM address:
 *   1. What has this wallet approved, and which of those allowances are live?
 *   2. Can the approved spenders actually move the tokens (is the approval
 *      drainable, or does the token block it — as COAI does)?
 *   3. Can the wallet still move its own tokens (is the token movable at all)?
 *
 * Nothing here signs or broadcasts: every call is `eth_call` simulation or a
 * read. Safe to run against any address.
 *
 * Usage:
 *   bun scripts/wallet-audit.mjs 0xADDRESS
 *   bun scripts/wallet-audit.mjs 0xADDRESS --json
 *   bun scripts/wallet-audit.mjs 0xADDRESS --rpc URL --archive URL --max-history 60
 *
 * Notes / limits (learned the hard way on BSC):
 *   • Native transfers emit no logs, so history is reconstructed by binary
 *     searching the nonce over [0, head] and reading each hit block.
 *   • Historical state needs an archive node; most free BSC nodes prune.
 *   • eth_getLogs is capped at 25–50 blocks on free nodes, so logs are not used.
 *   • Approvals can only be created by the owner, so enumerating the wallet's
 *     own history IS the exhaustive approval list.
 *
 * Exit code: 0 = no live+drainable exposure, 1 = exposure found, 2 = usage error.
 */

const DEFAULTS = {
  rpc: "https://bsc-dataseed.binance.org",
  archive: "https://bsc-mainnet.public.blastapi.io",
  maxHistory: 40,
};
const SEL = {
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  approve: "0x095ea7b3",
  approvalForAll: "0xa22cb465",
  allowance: "0xdd62ed3e",
  balanceOf: "0x70a08231",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
};
const SINK = "0x000000000000000000000000000000000000dEaD";
const MAX_UINT = 2n ** 256n - 1n;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ADDRESS = argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const AS_JSON = argv.includes("--json");
const RPC = flag("rpc", DEFAULTS.rpc);
const ARCHIVE = flag("archive", DEFAULTS.archive);
const MAX_HISTORY = Number(flag("max-history", DEFAULTS.maxHistory));

if (!ADDRESS) {
  console.error("usage: bun scripts/wallet-audit.mjs 0xADDRESS [--json] [--rpc URL] [--archive URL] [--max-history N]");
  process.exit(2);
}

/* ── RPC ─────────────────────────────────────────────────────────────────── */
async function rpc(url, method, params, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}
const stateRpc = (method, params) => rpc(ARCHIVE, method, params);
const fastRpc = (method, params) => rpc(RPC, method, params);
const hex = (n) => "0x" + n.toString(16);

const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padAmt = (v) => BigInt(v).toString(16).padStart(64, "0");

/** Decode an `Error(string)` revert payload into readable text, however it is wrapped. */
function revertReason(message) {
  const text = String(message);
  const hexMatch = /0x[0-9a-fA-F]{138,}/.exec(text);
  if (hexMatch) {
    let payload = hexMatch[0];
    try {
      // Standard `Error(string)` encoding starts with the 0x08c379a0 selector.
      if (payload.slice(0, 10).toLowerCase() === "0x08c379a0") payload = "0x" + payload.slice(10);
      const len = parseInt(payload.slice(2 + 64, 2 + 128), 16);
      if (Number.isFinite(len) && len > 0 && len < 512) {
        const body = payload.slice(2 + 128, 2 + 128 + len * 2);
        const decoded = Buffer.from(body, "hex").toString("utf8").replace(/[^\x20-\x7E]/g, "").trim();
        if (decoded) return decoded;
      }
    } catch {
      /* fall through to the raw message */
    }
  }
  const m = /^execution reverted: ?(.*)$/.exec(text);
  return (m ? m[1] : text).trim().slice(0, 120) || "reverted";
}

async function simulate(from, to, data) {
  try {
    await fastRpc("eth_call", [{ from, to, data }, "latest"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: revertReason(e.message) };
  }
}

const call = async (to, data) => {
  try {
    const r = await fastRpc("eth_call", [{ to, data }, "latest"]);
    return r && r !== "0x" ? r : null;
  } catch {
    return null;
  }
};

/** Decode a dynamic string return (symbol/name) defensively. */
function decodeString(hexStr) {
  if (!hexStr || hexStr.length < 130) return null;
  try {
    const len = parseInt(hexStr.slice(2 + 64, 2 + 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 200) {
      return Buffer.from(hexStr.slice(2, 2 + 64), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
    }
    return Buffer.from(hexStr.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
  } catch {
    return null;
  }
}

function formatUnits(value, decimals) {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/* ── history ─────────────────────────────────────────────────────────────── */
const nonceCache = new Map();
async function nonceAt(block) {
  if (nonceCache.has(block)) return nonceCache.get(block);
  const v = await stateRpc("eth_getTransactionCount", [ADDRESS, hex(block)]).catch(() => null);
  const n = v === null ? null : parseInt(v, 16);
  if (n !== null) nonceCache.set(block, n);
  return n;
}

async function firstBlockWhere(predicate, lo, hi) {
  let ans = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let hit;
    try {
      hit = await predicate(mid);
    } catch {
      return null;
    }
    if (hit === null) return null;
    if (hit) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

async function main() {
  const head = parseInt(await fastRpc("eth_blockNumber", []), 16);
  const balanceWei = BigInt(await fastRpc("eth_getBalance", [ADDRESS, "latest"]));
  const nonceNow = parseInt(await fastRpc("eth_getTransactionCount", [ADDRESS, "latest"]), 16);

  const birth = await firstBlockWhere(async (b) => {
    const n = await nonceAt(b);
    return n === null ? null : n > 0;
  }, 0, head);
  const historyCapped = nonceNow > MAX_HISTORY;
  const blocks = [];
  if (!historyCapped && nonceNow > 0) {
    for (let target = 0; target < nonceNow; target++) {
      const blk = await firstBlockWhere(async (b) => {
        const n = await nonceAt(b);
        return n === null ? null : n > target;
      }, birth ?? 0, head);
      if (blk !== null) blocks.push(blk);
    }
  }

  const txs = [];
  for (const blk of [...new Set(blocks)]) {
    const block = await fastRpc("eth_getBlockByNumber", [hex(blk), true]);
    if (!block) continue;
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() === ADDRESS.toLowerCase()) {
        txs.push({ ...tx, block: blk, time: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() });
      }
    }
  }
  txs.sort((a, b) => parseInt(a.nonce, 16) - parseInt(b.nonce, 16));

  const approvals = [];
  for (const tx of txs) {
    const sel = (tx.input || "0x").slice(0, 10);
    if (sel === SEL.approve) {
      approvals.push({ kind: "erc20", token: tx.to, spender: "0x" + tx.input.slice(34, 74), granted: BigInt("0x" + tx.input.slice(74, 138)), tx: tx.hash, block: tx.block, time: tx.time });
    } else if (sel === SEL.approvalForAll) {
      approvals.push({ kind: "erc721/1155", token: tx.to, spender: "0x" + tx.input.slice(34, 74), approved: tx.input.slice(74, 138).endsWith("1"), tx: tx.hash, block: tx.block, time: tx.time });
    }
  }

  const findings = [];
  for (const a of approvals) {
    if (a.kind !== "erc20") {
      findings.push({ token: a.token, spender: a.spender, allowance: a.approved ? "ALL" : "none", balance: null, drainable: "not simulated", movable: "n/a", tokenSymbol: "NFT" });
      continue;
    }
    const [symHex, decHex, allowHex, balHex] = await Promise.all([
      call(a.token, SEL.symbol),
      call(a.token, SEL.decimals),
      call(a.token, SEL.allowance + pad(ADDRESS) + pad(a.spender)),
      call(a.token, SEL.balanceOf + pad(ADDRESS)),
    ]);
    const decimals = decHex ? Number(BigInt(decHex)) : 18;
    const allowance = allowHex ? BigInt(allowHex) : 0n;
    const balance = balHex ? BigInt(balHex) : 0n;
    const symbol = decodeString(symHex) || a.token.slice(0, 10);

    // Would a drain actually succeed right now?
    const drainProbe = allowance > 0n && balance > 0n
      ? await simulate(a.spender, a.token, SEL.transferFrom + pad(ADDRESS) + pad(a.spender) + padAmt(balance < allowance ? balance : allowance))
      : null;
    // Can the owner still move the token at all?
    const moveProbe = balance > 0n
      ? await simulate(ADDRESS, a.token, SEL.transfer + pad(SINK) + padAmt(balance))
      : null;

    findings.push({
      token: a.token,
      tokenSymbol: symbol,
      spender: a.spender,
      allowance: allowance === MAX_UINT || allowance > MAX_UINT / 2n ? "UNLIMITED" : `${formatUnits(allowance, decimals)} ${symbol}`,
      allowanceRaw: allowance.toString(),
      balance: `${formatUnits(balance, decimals)} ${symbol}`,
      balanceRaw: balance.toString(),
      drainable: drainProbe === null ? "no balance" : drainProbe.ok ? "YES — spender can drain" : `no (${drainProbe.reason})`,
      movable: moveProbe === null ? "no balance" : moveProbe.ok ? "yes" : `no (${moveProbe.reason})`,
      capabilityCheck: true,
      tx: a.tx,
    });
  }

  const highRisk = findings.filter((f) => String(f.drainable).startsWith("YES"));
  const report = {
    address: ADDRESS,
    chainId: parseInt(await fastRpc("eth_chainId", []), 16),
    head,
    bornAtBlock: birth,
    balanceBNB: formatUnits(balanceWei, 18),
    nonce: nonceNow,
    historyScanned: historyCapped ? `skipped (nonce ${nonceNow} > --max-history ${MAX_HISTORY})` : `${txs.length}/${nonceNow}`,
    transactions: txs.map((t) => ({ nonce: parseInt(t.nonce, 16), block: t.block, time: t.time, to: t.to, valueWei: BigInt(t.value || "0x0").toString(), selector: (t.input || "0x").slice(0, 10), tx: t.hash })),
    approvals: findings,
    verdict: highRisk.length > 0
      ? `HIGH — drainable now: ${highRisk.map((f) => `${f.tokenSymbol} (${f.balance})`).join(", ")}`
      : historyCapped
        ? `UNKNOWN — history skipped (nonce ${nonceNow} > --max-history ${MAX_HISTORY}); rerun with a higher limit`
        : findings.length > 0
          ? "MEDIUM — approvals exist but none can currently move value"
          : "LOW — no approvals found",
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = "─".repeat(72);
    console.log(line);
    console.log(`wallet      ${report.address}`);
    console.log(`chain       ${report.chainId}   balance ${report.balanceBNB} BNB   nonce ${report.nonce}`);
    console.log(`first seen  block ${report.bornAtBlock ?? "?"}   history ${report.historyScanned}`);
    console.log(line);
    if (findings.length === 0) {
      console.log("approvals   none found");
    } else {
      console.log(`approvals   ${findings.length} found, ${highRisk.length} drainable now\n`);
      for (const f of findings) {
        console.log(`  ${f.tokenSymbol} ${f.token} -> ${f.spender}`);
        console.log(`    allowance ${f.allowance}`);
        console.log(`    balance   ${f.balance}`);
        console.log(`    drainable ${f.drainable}`);
        console.log(`    movable   ${f.movable}`);
        console.log(`    tx        ${f.tx}`);
      }
    }
    console.log(line);
    console.log(`VERDICT     ${report.verdict}`);
  }
  process.exit(highRisk.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`wallet-audit failed: ${e.message}`);
  process.exit(2);
});
