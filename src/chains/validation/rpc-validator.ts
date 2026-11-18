/**
 * RPC validation: connectivity, chain identity and block consistency.
 *
 * A responsive endpoint is not a valid RPC for a chain. Each endpoint must
 * report the expected chain id, and independent endpoints must broadly agree on
 * the head block (a private fork or a mislabelled endpoint shows up here).
 */
import type { ValidationOutcome } from "../registry/chain-types";

type Transport = <T>(url: string, method: string, params: unknown[], timeoutMs?: number) => Promise<T>;

export interface RpcEndpointCheck {
  url: string;
  provider: string;
  ok: boolean;
  chainId?: number;
  blockNumber?: number;
  latencyMs?: number;
  error?: string;
}

export interface RpcValidationReport {
  outcome: ValidationOutcome;
  endpoints: RpcEndpointCheck[];
}

/** Heads more than this apart suggest fork/desync rather than propagation lag. */
export const HEAD_TOLERANCE_BLOCKS = 50;

export async function validateRpc(args: {
  expectedChainId: number;
  endpoints: { url: string; provider: string }[];
  transport: Transport;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RpcValidationReport> {
  const now = args.now ?? Date.now;
  const timeout = args.timeoutMs ?? 10_000;
  const checks: RpcEndpointCheck[] = [];

  for (const endpoint of args.endpoints) {
    const started = now();
    try {
      const chainHex = await args.transport<string>(endpoint.url, "eth_chainId", [], timeout);
      const chainId = Number.parseInt(chainHex, 16);
      if (chainId !== args.expectedChainId) {
        checks.push({
          url: endpoint.url,
          provider: endpoint.provider,
          ok: false,
          chainId,
          error: `reports chain ${chainId}, expected ${args.expectedChainId}`,
        });
        continue;
      }
      const blockHex = await args.transport<string>(endpoint.url, "eth_blockNumber", [], timeout);
      checks.push({
        url: endpoint.url,
        provider: endpoint.provider,
        ok: true,
        chainId,
        blockNumber: Number.parseInt(blockHex, 16),
        latencyMs: now() - started,
      });
    } catch (e) {
      checks.push({
        url: endpoint.url,
        provider: endpoint.provider,
        ok: false,
        error: e instanceof Error ? e.message : "unreachable",
      });
    }
  }

  const good = checks.filter((c) => c.ok);
  if (good.length === 0) {
    return {
      outcome: {
        requirement: "rpc",
        result: "fail",
        detail: `No endpoint verified chain ${args.expectedChainId}: ${checks.map((c) => c.error).filter(Boolean).join("; ") || "none answered"}.`,
      },
      endpoints: checks,
    };
  }

  const heads = good.map((c) => c.blockNumber ?? 0);
  const spread = Math.max(...heads) - Math.min(...heads);
  if (spread > HEAD_TOLERANCE_BLOCKS) {
    return {
      outcome: {
        requirement: "rpc",
        result: "fail",
        detail: `Verified endpoints disagree on head by ${spread} blocks (> ${HEAD_TOLERANCE_BLOCKS}).`,
      },
      endpoints: checks,
    };
  }

  // Distinct providers matter: four hostnames can be one operator.
  const providers = new Set(good.map((c) => c.provider)).size;
  return {
    outcome: {
      requirement: "rpc",
      result: "pass",
      detail: `${good.length}/${checks.length} endpoints verified chain ${args.expectedChainId} across ${providers} provider(s); head spread ${spread} blocks.`,
    },
    endpoints: checks,
  };
}
