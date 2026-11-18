/**
 * Real Solidity compiler Web Worker.
 *
 * Downloads the official solc 0.8.20 emscripten build from the Solidity
 * binaries CDN, resolves the contract's @openzeppelin/contracts (5.1.0) and
 * @uniswap dependencies from jsDelivr, and compiles FlashBoltArbitrage.sol
 * with the real compiler. Nothing here is simulated — the result is the
 * actual solc output (bytecode, ABI or real compiler errors).
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";
import wrapper from "solc/wrapper";
import {
  flattenSoliditySource,
  IMPORT_RE,
  resolveImport,
} from "./solc-flatten";

const SOLJSON_URL =
  "https://binaries.soliditylang.org/bin/soljson-v0.8.20+commit.a1b79de6.js";

/** Import remappings → real package files on the jsDelivr CDN. */
const REMAPS: ReadonlyArray<readonly [string, string]> = [
  [
    "@openzeppelin/contracts/",
    "https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@5.1.0/",
  ],
  [
    "@uniswap/v2-periphery/contracts/",
    "https://cdn.jsdelivr.net/npm/@uniswap/v2-periphery@1.1.0-beta.0/contracts/",
  ],
  [
    "@uniswap/v2-core/contracts/",
    "https://cdn.jsdelivr.net/npm/@uniswap/v2-core@1.0.1/contracts/",
  ],
];

/** Fetch the full transitive import closure from the CDNs (async). */
async function fetchDependencyClosure(
  rootName: string,
  rootSource: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>([[rootName, rootSource]]);
  const queue = [rootName];
  while (queue.length) {
    const name = queue.shift() as string;
    const text = files.get(name) as string;
    const re = new RegExp(IMPORT_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const imp = resolveImport(name, m[2]);
      if (files.has(imp)) continue;
      const target = REMAPS.find(([from]) => imp.startsWith(from));
      if (!target) throw new Error(`No remap for ${imp} (from ${name})`);
      const url = target[1] + imp.slice(target[0].length);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      files.set(imp, await res.text());
      queue.push(imp);
    }
  }
  return files;
}

interface CompileResult {
  type: "result";
  ok: boolean;
  version?: string;
  bytecodeBytes?: number;
  /** Full solc creation bytecode — the exact payload for a one-click deploy. */
  bytecode?: string;
  bytecodeHash?: string;
  constructorArgs?: string;
  abiFunctions?: string[];
  warnings?: number;
  errors?: string[];
  /** Single-file flattened source — the payload BscScan verification needs. */
  flattenedSource?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
};

workerScope.onmessage = async (event: MessageEvent) => {
  const payload = event.data as { source?: string; routerAddress?: string } | undefined;
  const source = payload?.source;
  if (!source) return;
  const routerAddress = payload?.routerAddress?.trim() || undefined;
  try {
    self.postMessage({ type: "progress", stage: "compiler" });
    const soljson = await (await fetch(SOLJSON_URL)).text();
    // Evaluate the emscripten build in this worker's global scope. In a real
    // worker importScripts/location exist and `process` does not, so the
    // build takes its worker environment path natively.
    const Module = new Function(soljson + "\n; return Module;")() as Record<
      string,
      unknown
    >;
    const solc = wrapper(Module as never);

    self.postMessage({ type: "progress", stage: "deps" });
    const files = await fetchDependencyClosure("FlashBoltArbitrage.sol", source);

    self.postMessage({ type: "progress", stage: "compile" });
    const stdInput = JSON.stringify({
      language: "Solidity",
      sources: Object.fromEntries(
        [...files].map(([name, contents]) => [name, { content: contents }]),
      ),
      settings: {
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    });
    const resolver = (path: string): { contents?: string; error?: string } => {
      const contents = files.get(path);
      return contents === undefined
        ? { error: `Missing ${path}` }
        : { contents };
    };
    const output = JSON.parse(
      solc.compile(stdInput, { import: resolver }),
    ) as {
      errors?: { severity: string; formattedMessage?: string; message?: string }[];
      contracts?: Record<
        string,
        Record<
          string,
          {
            abi?: { type?: string; name?: string }[];
            evm?: { bytecode?: { object?: string } };
          }
        >
      >;
    };

    const errors = (output.errors ?? []).filter((e) => e.severity === "error");
    if (errors.length > 0) {
      const result: CompileResult = {
        type: "result",
        ok: false,
        errors: errors.map((e) => e.formattedMessage ?? e.message ?? "Compile error"),
      };
      self.postMessage(result);
      return;
    }

    const contract =
      output.contracts?.["FlashBoltArbitrage.sol"]?.["FlashBoltArbitrage"];
    if (!contract) {
      const result: CompileResult = {
        type: "result",
        ok: false,
        errors: ["Compiler produced no FlashBoltArbitrage output."],
      };
      self.postMessage(result);
      return;
    }

    // Real artifacts: keccak-256 of the creation bytecode and the ABI-encoded
    // constructor argument (the router address) that gets appended on deploy.
    const bytecode = (contract.evm?.bytecode?.object ?? "0x") as Hex;
    const bytecodeHash = keccak256(bytecode);
    let constructorArgs: string | undefined;
    if (routerAddress) {
      constructorArgs = encodeAbiParameters(parseAbiParameters("address"), [
        routerAddress as Hex,
      ]);
    }

    // Flatten the real fetched sources into the single-file form that
    // BscScan's verify & publish accepts.
    const flattenedSource = flattenSoliditySource(
      "FlashBoltArbitrage.sol",
      files,
    );

    const result: CompileResult = {
      type: "result",
      ok: true,
      version: String(solc.version()),
      bytecodeBytes: Math.floor((bytecode.length - 2) / 2),
      bytecode,
      bytecodeHash,
      constructorArgs,
      abiFunctions: (contract.abi ?? [])
        .filter((x) => x.type === "function")
        .map((x) => x.name ?? ""),
      warnings: (output.errors ?? []).filter((e) => e.severity === "warning")
        .length,
      flattenedSource,
    };
    self.postMessage(result);
  } catch (error) {
    const result: CompileResult = {
      type: "result",
      ok: false,
      errors: [error instanceof Error ? error.message : "Unknown compile error"],
    };
    self.postMessage(result);
  }
};

export {};
