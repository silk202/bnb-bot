/**
 * Transaction simulation.
 *
 * Simulation runs through the same RPC path as the real transaction and is
 * gated: a refused execution request cannot even be simulated for signing.
 * A simulation is evidence, not permission — it never activates a network.
 */

export interface SimulationInput {
  rpcUrl: string;
  from: string;
  to: string;
  data: string;
  /** Native value in wei, as a hex quantity. */
  value?: string;
  timeoutMs?: number;
}

export interface SimulationResult {
  ok: boolean;
  returnData?: string;
  estimatedGas?: string;
  error?: string;
}

type Transport = <T>(url: string, method: string, params: unknown[], timeoutMs?: number) => Promise<T>;

export async function simulateTransaction(
  input: SimulationInput,
  opts: { transport: Transport; ensureAllowed: () => void },
): Promise<SimulationResult> {
  // The gate runs first: if policy denies, there is nothing to simulate.
  opts.ensureAllowed();

  const tx = {
    from: input.from,
    to: input.to,
    data: input.data,
    ...(input.value ? { value: input.value } : {}),
  };
  const timeout = input.timeoutMs ?? 20_000;

  let returnData: string;
  try {
    returnData = await opts.transport<string>(input.rpcUrl, "eth_call", [tx, "latest"], timeout);
  } catch (e) {
    return { ok: false, error: `eth_call reverted: ${e instanceof Error ? e.message : "unknown"}` };
  }

  let estimatedGas: string;
  try {
    estimatedGas = await opts.transport<string>(input.rpcUrl, "eth_estimateGas", [tx], timeout);
  } catch (e) {
    return {
      ok: false,
      returnData,
      error: `eth_estimateGas failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  if (!/^0x[0-9a-fA-F]+$/.test(estimatedGas) || BigInt(estimatedGas) === 0n) {
    return { ok: false, returnData, error: "Simulation returned no usable gas estimate." };
  }
  return { ok: true, returnData, estimatedGas };
}
