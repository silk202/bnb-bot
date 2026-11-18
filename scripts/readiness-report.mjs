#!/usr/bin/env bun
/**
 * Live readiness report.
 *
 * Runs the real validators against real RPC endpoints — no fixtures. It is a
 * report only: it never activates anything and always prints execution OFF.
 *
 *   bun scripts/readiness-report.mjs                 # every registered network
 *   bun scripts/readiness-report.mjs bsc ethereum    # only these
 */
import { NETWORKS, networkByKey } from "../src/chains/registry/networks.ts";
import { discoverEndpointsByChain, endpointPool } from "../src/chains/registry/rpc-pools.ts";
import { deploymentManifest } from "../src/chains/registry/deployment-registry.ts";
import { validateRpc } from "../src/chains/validation/rpc-validator.ts";
import { validateContracts } from "../src/chains/validation/contract-validator.ts";
import { evaluateReadiness } from "../src/chains/validation/readiness-engine.ts";
import { createEvmAdapter } from "../src/chains/adapters/evm-adapter.ts";
import { rpcCall } from "../src/lib/json-rpc.ts";

const wanted = process.argv.slice(2);
const targets = wanted.length > 0 ? wanted.map((key) => networkByKey(key)).filter(Boolean) : [...NETWORKS];

const rows = [];

// Configured URLs may sit in another chain's variable, so file them by the
// chain id they actually report before validating anything.
const discovery = await discoverEndpointsByChain({ force: true, timeoutMs: 6_000 });
const poolSize = endpointPool().length;
if (poolSize > 0) {
  console.log(
    `Discovered ${discovery.byChain.size} chain(s) from ${poolSize} configured endpoint(s); ` +
      `${discovery.rejected.length} rejected.`,
  );
}

for (const network of targets) {
  const manifest = deploymentManifest(network.deploymentRegistry);
  const discovered = discovery.byChain.get(network.chainId) ?? [];
  const httpList = discovered.length > 0 ? discovered : network.rpc.http;
  const endpoints = httpList.map((url) => ({
    url,
    provider: (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return url;
      }
    })(),
  }));

  const rpc = await validateRpc({ expectedChainId: network.chainId, endpoints, transport: rpcCall });
  const outcomes = [rpc.outcome];

  if (rpc.outcome.result === "pass") {
    const verified = rpc.endpoints.find((e) => e.ok);
    if (verified && manifest && manifest.status !== "unavailable") {
      const adapter = createEvmAdapter(network, verified.url);
      try {
        outcomes.push(
          ...(await validateContracts({
            probe: adapter,
            expectedChainId: network.chainId,
            chainId: () => adapter.chainId(),
            router: manifest.router?.address,
            factory: manifest.factory?.address,
            executor: manifest.executor,
          })),
        );
      } catch (e) {
        outcomes.push({
          requirement: "executor",
          result: "fail",
          detail: e instanceof Error ? e.message : "contract validation failed",
        });
      }
    }
  }

  const report = evaluateReadiness({ network, manifest, outcomes });
  rows.push({
    network: network.name,
    env: network.environment,
    chain: String(network.chainId),
    readiness: report.state,
    execution: report.execution,
    rpc: report.checks.find((c) => c.requirement === "rpc")?.detail ?? "not run",
    blocking: report.blocking[0] ?? "",
  });
}

const width = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(
  `${width("NETWORK", 20)} ${width("ENV", 8)} ${width("CHAIN", 9)} ${width("READINESS", 20)} ${width("EXEC", 5)} DETAIL`,
);
for (const row of rows) {
  console.log(
    `${width(row.network, 20)} ${width(row.env, 8)} ${width(row.chain, 9)} ${width(row.readiness, 20)} ${width(row.execution, 5)} ${row.rpc}`,
  );
}
console.log("\nExecution is OFF for every network: activation is a separate backend authorization.");
