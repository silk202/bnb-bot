#!/usr/bin/env bun
/**
 * RPC diagnostics.
 *
 *   bun scripts/rpc-diagnostics.mjs                 # every registered network
 *   bun scripts/rpc-diagnostics.mjs bsc base        # only these
 *   bun scripts/rpc-diagnostics.mjs --json          # machine-readable
 *
 * Reports each endpoint's origin (discovered / configured / public), the chain id
 * it reports, its latency and head block, and whether independent endpoints agree.
 * It never enables execution.
 */
import { diagnoseAll, diagnoseNetwork, formatDiagnostics, isNetworkHealthy } from "../src/chains/registry/rpc-diagnostics.ts";
import { discoverEndpointsByChain, endpointPool } from "../src/chains/registry/rpc-pools.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const keys = args.filter((a) => !a.startsWith("--"));

const discovery = await discoverEndpointsByChain({ force: true, timeoutMs: 6_000 });
if (!json && endpointPool().length > 0) {
  console.log(
    `Configured endpoints: ${endpointPool().length} · resolved chains: ${[...discovery.byChain.keys()].join(", ") || "none"} · rejected: ${discovery.rejected.length}`,
  );
}

const rows = keys.length > 0
  ? (await Promise.all(keys.map((key) => diagnoseNetwork(key)))).filter(Boolean)
  : await diagnoseAll();

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(formatDiagnostics(rows));
  const bad = rows.filter((row) => !isNetworkHealthy(row));
  if (bad.length > 0) {
    console.log(`\n${bad.length} network(s) need attention: ${bad.map((r) => r.name).join(", ")}`);
  }
}
