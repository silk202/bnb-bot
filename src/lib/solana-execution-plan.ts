/**
 * SOL FlashBolt — execution plan, read from the tracked IDL.
 *
 * The Solana terminal runs two engines over one wallet and one cluster pin:
 *
 *  • **Jupiter Swap** — the rail that already executes: quote both legs, the
 *    armed wallet signs ordinary swaps, Jito carries the bundle with a tip.
 *    No program of ours is involved, so it must never be blocked by
 *    arbitrage work in progress.
 *  • **Flash arbitrage** — the FlashboltSolana program (`flash_arb`) between
 *    a Jupiter Lend flash borrow and its payback. It is not deployed, so the
 *    rail refuses instead of silently falling through to Jupiter.
 *
 * Nothing here is hand-copied. The program address, instruction names, their
 * arguments and signers, and the error codes all come from
 * `solana/idl/flashbolt_solana.json` — the same file the CI job diffs against
 * `anchor idl build`. If the program gains an instruction, this module and
 * everything rendering it change with it.
 *
 * The lender half is a verification record, not a guess: `JUPITER_LEND`
 * carries only addresses and numbers that were read back from a cluster (see
 * `reports/flashbolt-provider-brief-2026-11-21.md` → Verification log).
 */
import idl from "../../solana/idl/flashbolt_solana.json";

/** Program address declared in the IDL (and enforced by `declare_id!`). */
export const FLASHBOLT_PROGRAM_ID: string = idl.address;

/** IDL metadata — version is bumped by the program crate, not by hand. */
export const FLASHBOLT_IDL_META = {
  name: idl.metadata.name,
  version: idl.metadata.version,
  spec: idl.metadata.spec,
  description: idl.metadata.description,
} as const;

export interface FlashboltInstruction {
  name: string;
  args: Array<{ name: string; type: string }>;
  /** Every account name the instruction takes, in IDL order. */
  accounts: string[];
  /** Accounts the instruction requires a signature from. */
  signers: string[];
  docs: string[];
}

/** Instruction types are nested (e.g. `{ option: "pubkey" }`) — flatten once. */
function describeType(type: unknown): string {
  if (typeof type === "string") return type;
  if (type && typeof type === "object") {
    const entries = Object.entries(type as Record<string, unknown>);
    return entries
      .map(([key, value]) =>
        key === "option" || key === "vec" || key === "array"
          ? `${key}<${describeType(value)}>`
          : `${key}:${describeType(value)}`,
      )
      .join(",");
  }
  return "unknown";
}

interface RawInstruction {
  name: string;
  docs?: string[];
  args?: Array<{ name: string; type: unknown }>;
  accounts?: Array<{ name: string; signer?: boolean }>;
}

/** The program's instructions exactly as the IDL declares them. */
export const FLASHBOLT_INSTRUCTIONS: FlashboltInstruction[] = (
  idl.instructions as RawInstruction[]
).map((ix) => ({
  name: ix.name,
  docs: ix.docs ?? [],
  args: (ix.args ?? []).map((a) => ({ name: a.name, type: describeType(a.type) })),
  accounts: (ix.accounts ?? []).map((a) => a.name),
  signers: (ix.accounts ?? []).filter((a) => a.signer).map((a) => a.name),
}));

/** Instruction names, in IDL order — the builder's callable surface. */
export const FLASHBOLT_INSTRUCTION_NAMES: string[] = FLASHBOLT_INSTRUCTIONS.map(
  (ix) => ix.name,
);

/** True when the IDL already declares the execution instruction. */
export const FLASH_ARB_IN_IDL = FLASHBOLT_INSTRUCTION_NAMES.includes("flash_arb");

/** Program error codes, in declaration order. */
export const FLASHBOLT_ERRORS: Array<{ code: number; name: string }> = (
  idl.errors as Array<{ code: number; name: string }>
).map((e) => ({ code: e.code, name: e.name }));

export interface JupiterLendDeployment {
  /** Account the flash borrow/payback instructions are issued to. */
  flashloan: string;
  /** Liquidity program the flashloan program CPIs into for the transfer. */
  liquidity: string;
  /** Borrow-market / vaults program. */
  vaults: string;
  /** Lend AMM program. */
  dex: string;
}

/**
 * Jupiter Lend — verified 2026-11-21 against `api.mainnet-beta.solana.com` and
 * `api.devnet.solana.com`.
 *
 * Mainnet: the flashloan program account exists (executable, 1,141,446
 * lamports, owner BPFLoaderUpgradeab1e). Its admin account
 * `ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL` decodes to authority
 * `HqPrpa4ESBDnRHRWaiYtjv4xe93wvCS9NNZtDwR89cVa`, liquidity program
 * `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`, activation flag 1 and a
 * zero fee word — matching the documented "all flashloans are free".
 *
 * Devnet: every Lend program (flashloan, liquidity, AMM) returns `null` from
 * `getAccountInfo`; the deployment named in the Lend CPI guides is gone. The
 * devnet gate is therefore **failed**, not merely unverified, and the
 * arbitrage rail stays blocked.
 */
export const JUPITER_LEND = {
  name: "Jupiter Lend",
  feePct: 0,
  feeLabel: "0%",
  feeSource: "on-chain flashloan_admin fee word = 0 · developers.jup.ag/docs/lend/flashloan",
  /** Smallest borrow the program accepts (`MIN_FLASHLOAN_AMOUNT` = 1e3). */
  minBorrowBaseUnits: 1_000,
  /** Program-enforced fee ceiling (`FLASHLOAN_FEE_MAX` = 50 bps = 0.5%). */
  feeCapPct: 0.5,
  /** Borrow/payback are top-level instructions around our CPI — not CPI-able. */
  shape: "bracketed" as const,
  mainnet: {
    flashloan: "jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS",
    liquidity: "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
    vaults: "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",
    dex: "jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd",
  } satisfies JupiterLendDeployment,
  admin: {
    pda: "ALXWtv2P4GqH1B7Lq731joag52yRBRqmHV4naiXPTYWL",
    authority: "HqPrpa4ESBDnRHRWaiYtjv4xe93wvCS9NNZtDwR89cVa",
    /** Decoded u16 at offset 73 of the admin account — 0 bps. */
    feeWord: 0,
  },
  devnet: {
    /** Checked by `getAccountInfo` — null means the program is not deployed. */
    deployed: false,
    checkedOn: "2026-11-21",
    rpc: "https://api.devnet.solana.com",
    result: "flashloan, liquidity and AMM programs all return null",
  },
} as const;

export type SolPlanStatus = "done" | "next" | "blocked" | "pending";

export interface SolPlanStep {
  id: string;
  title: string;
  detail: string;
  status: SolPlanStatus;
  /** Where the claim comes from — a file, a command, or a verified address. */
  evidence: string;
}

const STATUS_LABEL: Record<SolPlanStatus, string> = {
  done: "Done",
  next: "Next",
  blocked: "Blocked",
  pending: "Not started",
};

export function solPlanStatusLabel(status: SolPlanStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Flash arbitrage — the `[borrow, flash_arb, payback]` path. Step 1 and 2 are
 * finished; step 3 is where work stops today because Jupiter Lend has no
 * devnet deployment to verify against.
 */
export const FLASH_ARB_STEPS: SolPlanStep[] = [
  {
    id: "config",
    title: "Program config + authority foundation",
    detail:
      "initialize_config, propose_admin/accept_admin, update_authorities, pause/unpause, with a 256-byte reserve for the execution layout.",
    status: "done",
    evidence: "solana/programs/flashbolt_solana/src/instructions/",
  },
  {
    id: "idl",
    title: "Generated IDL, proven and CI-gated",
    detail: `${FLASHBOLT_INSTRUCTIONS.length} instructions and ${FLASHBOLT_ERRORS.length} error codes in the tracked IDL; the CI job rebuilds it and fails on any drift.`,
    status: "done",
    evidence: "solana/idl/flashbolt_solana.json · .github/workflows/ci.yml",
  },
  {
    id: "lender-devnet",
    title: "Jupiter Lend devnet verification",
    detail:
      "Required before any adapter is written. The devnet flashloan, liquidity and AMM programs are absent, so there is nothing to borrow from or repay on devnet.",
    status: "blocked",
    evidence: "reports/flashbolt-provider-brief-2026-11-21.md → Verification log",
  },
  {
    id: "flash-arb",
    title: "flash_arb instruction",
    detail:
      "Verify the borrow by balance delta, run the venue legs, measure profit as post − pre − owed and leave the principal in the account the payback debits.",
    status: "pending",
    evidence: `not in the IDL${FLASH_ARB_IN_IDL ? " (was expected to be absent — check the adapter)" : ""}`,
  },
  {
    id: "lender-adapter",
    title: "Jupiter Lend borrow/payback builder",
    detail:
      "Borrow and payback are top-level instructions around our CPI, so the engine composes the transaction; the program never CPIs the lender.",
    status: "pending",
    evidence: "JUPITER_LEND.mainnet + shape: bracketed",
  },
  {
    id: "orca",
    title: "Orca Whirlpool venue adapter",
    detail:
      "First swap venue per the provider decision: quote and build both legs against Whirlpool, mainnet pools only until an equivalent exists on devnet.",
    status: "pending",
    evidence: "rounded decision, 2026-11-21",
  },
  {
    id: "raydium",
    title: "Raydium venue adapter",
    detail: "Second venue, added only after the Orca path is proven end to end.",
    status: "pending",
    evidence: "rounded decision, 2026-11-21",
  },
  {
    id: "audit",
    title: "Independent audit + mainnet approval",
    detail:
      "Mainnet contract execution stays off until an external audit signs off and the operator records that approval.",
    status: "blocked",
    evidence: "solana/SECURITY.md → Deploy gates",
  },
];

/**
 * Jupiter Swap — already executing in the app. Listing its steps here is what
 * keeps arbitrage work from being mistaken for a swap change.
 */
export const JUPITER_SWAP_STEPS: SolPlanStep[] = [
  {
    id: "quote",
    title: "Quote + build both legs",
    detail:
      "Live quote for the exact route that will be signed; no program of ours is involved, so no deployment gates this rail.",
    status: "done",
    evidence: "src/lib/solana-live-execution.ts",
  },
  {
    id: "wallet",
    title: "Wallet role + minimum clip",
    detail: `Vault signs in-app (minimum 0.05 SOL clip); a connected extension is the external wallet and keeps its own wallet-fit rules.`,
    status: "done",
    evidence: "src/lib/solana-policy.ts → solWalletRole",
  },
  {
    id: "guard",
    title: "Profit floor + cluster pin",
    detail:
      "Quoted net must clear the operator floor, and getGenesisHash must match the pin before anything is signed.",
    status: "done",
    evidence: "src/lib/solana-policy.ts → profitFloorVerdict, clusterPinVerdict",
  },
  {
    id: "submit",
    title: "Protected submission",
    detail:
      "Jito bundle with the tip attached before signing; revert protection means a failed route costs the network fee only.",
    status: "done",
    evidence: "src/lib/solana-jito.ts",
  },
  {
    id: "isolation",
    title: "Isolation from flash arbitrage",
    detail:
      "The active engine is the only thing the rail switch changes; venue whitelist, slippage, loan bounds and the arbitrage authorization persist across it.",
    status: "next",
    evidence: "SOL Strategy → Execution rail · Operator Settings",
  },
];

export interface SolEnginePlan {
  id: "jupiter-swap" | "flash-arb";
  name: string;
  summary: string;
  steps: SolPlanStep[];
}

/** Both engines, in the order the settings page presents them. */
export const SOL_ENGINE_PLANS: SolEnginePlan[] = [
  {
    id: "jupiter-swap",
    name: "Jupiter Swap",
    summary: "Live swaps today — no program, no deployment, no audit gate.",
    steps: JUPITER_SWAP_STEPS,
  },
  {
    id: "flash-arb",
    name: "Flash arbitrage",
    summary: "FlashboltSolana flash_arb between a Jupiter Lend borrow and payback.",
    steps: FLASH_ARB_STEPS,
  },
];

/** Short "3/8 done · 2 blocked" tally for a step list. */
export function solPlanTally(steps: readonly SolPlanStep[]): {
  done: number;
  total: number;
  blocked: number;
} {
  return {
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
    blocked: steps.filter((s) => s.status === "blocked").length,
  };
}

/** One-line description of an instruction, for the contract page. */
export function flashboltInstructionLine(ix: FlashboltInstruction): string {
  const args = ix.args.length === 0 ? "no args" : ix.args.map((a) => `${a.name}: ${a.type}`).join(", ");
  return `${ix.name}(${args}) · ${ix.accounts.length} accounts`;
}
