/**
 * RPC diagnostics: per-endpoint truth about a network.
 *
 * Answers the questions an operator actually asks when something is wrong —
 * which endpoints do we have, where did each come from, does it report the
 * chain we think it does, how slow is it, and do they agree on the head?
 *
 * It never blocks execution and never chooses an endpoint: it observes.
 */
import { rpcCall } from "../../lib/json-rpc";
import { NETWORKS, networkByKey } from "./networks";
import { rpcProvenance } from "./rpc-registry";

export interface EndpointDiagnostic {
  url: string;
  origin: "validated" | "discovered" | "configured" | "public";
  expectedChainId: number;
  chainId?: number;
  ok: boolean;
  latencyMs?: number;
  blockNumber?: number;
  error?: string;
}

export interface NetworkDiagnostics {
  networkKey: string;
  name: string;
  environment: "mainnet" | "testnet";
  chainId: number;
  endpoints: EndpointDiagnostic[];
  healthy: number;
  mismatched: number;
  unreachable: number;
  /** Absent when fewer than two endpoints answered. */
  headSpread?: number;
  checkedAt: number;
}

type Transport = <T>(url: string, method: string, params: unknown[], timeoutMs?: number) => Promise<T>;

const HEAD_TOLERANCE = 50;

export async function diagnoseNetwork(
  networkKey: string,
  opts: { timeoutMs?: number; transport?: Transport; now?: () => number } = {},
): Promise<NetworkDiagnostics | undefined> {
  const network = networkByKey(networkKey);
  if (!network) return undefined;
  const transport = opts.transport ?? rpcCall;
  const timeout = opts.timeoutMs ?? 6_000;
  const now = opts.now ?? Date.now;

  const endpoints = await Promise.all(
    rpcProvenance(networkKey).map(async (entry): Promise<EndpointDiagnostic> => {
      const started = now();
      try {
        const hex = await transport<string>(entry.url, "eth_chainId", [], timeout);
        const chainId = Number.parseInt(hex, 16);
        if (chainId !== network.chainId) {
          return {
            ...entry,
            expectedChainId: network.chainId,
            chainId,
            ok: false,
            latencyMs: now() - started,
            error: `reports chain ${chainId}, expected ${network.chainId}`,
          };
        }
        const head = await transport<string>(entry.url, "eth_blockNumber", [], timeout);
        return {
          ...entry,
          expectedChainId: network.chainId,
          chainId,
          ok: true,
          latencyMs: now() - started,
          blockNumber: Number.parseInt(head, 16),
        };
      } catch (e) {
        return {
          ...entry,
          expectedChainId: network.chainId,
          ok: false,
          latencyMs: now() - started,
          error: e instanceof Error ? e.message : "unreachable",
        };
      }
    }),
  );

  const good = endpoints.filter((e) => e.ok && typeof e.blockNumber === "number");
  const heads = good.map((e) => e.blockNumber as number);
  return {
    networkKey,
    name: network.name,
    environment: network.environment,
    chainId: network.chainId,
    endpoints,
    healthy: good.length,
    mismatched: endpoints.filter((e) => !e.ok && typeof e.chainId === "number").length,
    unreachable: endpoints.filter((e) => !e.ok && e.chainId === undefined).length,
    ...(heads.length > 1 ? { headSpread: Math.max(...heads) - Math.min(...heads) } : {}),
    checkedAt: now(),
  };
}

export async function diagnoseAll(
  opts: { timeoutMs?: number; transport?: Transport; now?: () => number } = {},
): Promise<NetworkDiagnostics[]> {
  const rows: NetworkDiagnostics[] = [];
  for (const network of NETWORKS) {
    const row = await diagnoseNetwork(network.key, opts);
    if (row) rows.push(row);
  }
  return rows;
}

/** True when at least one endpoint is healthy and heads agree. */
export function isNetworkHealthy(row: NetworkDiagnostics): boolean {
  if (row.healthy === 0) return false;
  if (row.headSpread !== undefined && row.headSpread > HEAD_TOLERANCE) return false;
  return true;
}

export function formatDiagnostics(rows: NetworkDiagnostics[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const state = isNetworkHealthy(row) ? "ok" : "PROBLEM";
    lines.push(
      `${row.name} (${row.chainId}, ${row.environment}) — ${row.healthy} healthy, ` +
        `${row.mismatched} wrong-chain, ${row.unreachable} unreachable` +
        `${row.headSpread !== undefined ? `, head spread ${row.headSpread}` : ""} [${state}]`,
    );
    for (const endpoint of row.endpoints) {
      const host = (() => {
        try {
          return new URL(endpoint.url).hostname;
        } catch {
          return endpoint.url;
        }
      })();
      const detail = endpoint.ok
        ? `block ${endpoint.blockNumber} · ${endpoint.latencyMs}ms`
        : endpoint.error ?? "failed";
      lines.push(`  ${endpoint.ok ? "✔" : "✖"} ${host} [${endpoint.origin}] ${detail}`);
    }
  }
  return lines.join("\n");
}
