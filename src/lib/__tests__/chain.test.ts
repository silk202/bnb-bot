import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Hex,
} from "viem";
import {
  BNB_NETWORKS,
  buildDeployData,
  buildExecuteData,
  computeAmountOutMin,
  computeGasUsedBnb,
  isAddressLike,
  networkForChainId,
} from "../chain";
import { CHAIN_INFO, chainForChainId, effectiveRpc } from "../flashbolt";

const WBNB_MAINNET = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const USDT_MAINNET = "0x55d398326f99059fF775485246999027B3197955";

const EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "loanAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "profit", type: "uint256" }],
  },
] as const;

describe("buildExecuteData", () => {
  test("encodes multi-asset execute(address,uint256,address[],uint256) that decodes back exactly", () => {
    const amount = 500000000000000000n;
    const amountOutMin = 998482500000000000n;
    const data = buildExecuteData(
      WBNB_MAINNET as Hex,
      amount,
      [WBNB_MAINNET as Hex, CAKE as Hex, WBNB_MAINNET as Hex],
      amountOutMin,
    );
    expect(data.startsWith("0x")).toBe(true);
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args).toEqual([
      WBNB_MAINNET,
      amount,
      [WBNB_MAINNET, CAKE, WBNB_MAINNET],
      amountOutMin,
    ]);
  });

  test("encodes a stable-denominated route bridging through the wrapped native", () => {
    const amount = 500n * 10n ** 18n;
    const data = buildExecuteData(
      USDT_MAINNET as Hex,
      amount,
      [USDT_MAINNET as Hex, WBNB_MAINNET as Hex, CAKE as Hex, WBNB_MAINNET as Hex, USDT_MAINNET as Hex],
      503n * 10n ** 18n,
    );
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data });
    expect(decoded.args?.[0]).toBe(USDT_MAINNET);
    expect(decoded.args?.[2]).toEqual([
      USDT_MAINNET, WBNB_MAINNET, CAKE, WBNB_MAINNET, USDT_MAINNET,
    ]);
  });
});

describe("computeAmountOutMin", () => {
  test("0.35% profit at 0.5% slippage on a 1 BNB loan", () => {
    // 1e18 * (10035/10000) * 9950/10000 = 998482500000000000 wei
    expect(computeAmountOutMin(10n ** 18n, 0.35, 0.5)).toBe(998482500000000000n);
  });

  test("no profit and no slippage means exactly the principal", () => {
    expect(computeAmountOutMin(10n ** 18n, 0, 0)).toBe(1000000000000000000n);
  });

  test("scales with a stable-denominated principal", () => {
    // 500 USDT principal, +12% target, 1% slippage:
    // 500e18 * 1.12 * 0.99 = 554.4e18
    expect(computeAmountOutMin(500n * 10n ** 18n, 12, 1)).toBe(554400000000000000000n);
  });
  test("slippage is clamped at 100%", () => {
    expect(computeAmountOutMin(10n ** 18n, 0, 100)).toBe(0n);
  });

  test("negative inputs are clamped to the raw principal", () => {
    expect(computeAmountOutMin(10n ** 18n, -1, -1)).toBe(1000000000000000000n);
  });
});

describe("isAddressLike", () => {
  test("accepts the official checksummed Router02 address", () => {
    expect(isAddressLike("0x10ED43C718714eb63d5aA57B78B54704E256024E")).toBe(true);
  });

  test("accepts all-lowercase addresses", () => {
    expect(isAddressLike("0x10ed43c718714eb63d5aa57b78b54704e256024e")).toBe(true);
  });

  test("rejects short, prefix-less and non-hex strings", () => {
    expect(isAddressLike("0x1234")).toBe(false);
    expect(isAddressLike("10ED43C718714eb63d5aA57B78B54704E256024E")).toBe(false);
    expect(isAddressLike("0xnotanaddressnotanaddressnotanaddress")).toBe(false);
    expect(isAddressLike("")).toBe(false);
  });
});

describe("networkForChainId", () => {
  test("maps the real BNB chains and rejects everything else", () => {
    expect(networkForChainId(56)).toBe("mainnet");
    expect(networkForChainId(97)).toBe("testnet");
    expect(networkForChainId(1)).toBeNull();
    expect(networkForChainId(0)).toBeNull();
  });
});

describe("viem artifact helpers (solc worker bytecode hash + constructor args)", () => {
  test("keccak256 matches the canonical empty-input digest", () => {
    // Well-known keccak-256 test vector (keccak256 of empty input).
    expect(keccak256("0x")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  test("constructor args encode the real Router02 into a 66-char hex", () => {
    const router = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
    const args = encodeAbiParameters(parseAbiParameters("address"), [router]);
    expect(args).toHaveLength(66); // 0x + 32-byte word
    expect(args.startsWith("0x000000000000000000000000")).toBe(true);
    expect(
      args.endsWith("10ed43c718714eb63d5aa57b78b54704e256024e"),
    ).toBe(true);
  });
});

describe("buildDeployData (one-click deploy payload)", () => {
  test("concatenates creation bytecode + encoded constructor args into one lowercase 0x payload", () => {
    const code = "0x608060405234801561001057600080fd5b50";
    const args =
      "0x00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e";
    const data = buildDeployData(code as Hex, args);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.slice(2)).toBe(code.slice(2) + args.slice(2));
    expect(data).toBe(data.toLowerCase() as Hex);
  });

  test("tolerates inputs without the 0x prefix", () => {
    expect(buildDeployData("abc" as Hex, "def")).toBe("0xabcdef");
  });

  test("deploy payload for the real contract is bytecode + 66-char router word", () => {
    const code = "0x60806040";
    const args = encodeAbiParameters(parseAbiParameters("address"), [
      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    ]);
    const data = buildDeployData(code as Hex, args);
    expect(data.length).toBe(2 + 8 + 64); // 0x + 4 bytes + one 32-byte word
  });
});

describe("computeGasUsedBnb (real receipt gas math)", () => {
  test("320,000 gas at 5 gwei costs exactly 0.0016 BNB", () => {
    // 0x4E200 = 320000 gas · 0x12A05F200 = 5,000,000,000 wei (5 gwei)
    expect(computeGasUsedBnb("0x4E200", "0x12A05F200")).toBeCloseTo(0.0016, 6);
  });

  test("a reverted tx still reports its real gas cost", () => {
    // gasUsed 0x1D4C0 = 120000 · 3 gwei (0xB2D05E00)
    expect(computeGasUsedBnb("0x1D4C0", "0xB2D05E00")).toBeCloseTo(0.00036, 6);
  });

  test("zero gas or zero price means zero cost", () => {
    expect(computeGasUsedBnb("0x0", "0x12A05F200")).toBe(0);
    expect(computeGasUsedBnb("0x4E200", "0x0")).toBe(0);
  });

  test("garbage hex degrades to zero instead of throwing", () => {
    expect(computeGasUsedBnb("nope", "0x12A05F200")).toBe(0);
    expect(computeGasUsedBnb("0x4E200", "also-nope")).toBe(0);
  });
});

describe("multi-chain registry (chainForChainId + effectiveRpc)", () => {
  test("chainForChainId maps the real EVM chain ids", () => {
    expect(chainForChainId(56)).toBe("bsc");
    expect(chainForChainId(1)).toBe("ethereum");
    expect(chainForChainId(42161)).toBe("arbitrum");
    expect(chainForChainId(137)).toBe("polygon");
    expect(chainForChainId(0)).toBeNull();
    expect(chainForChainId(999999)).toBeNull();
  });

  test("effectiveRpc falls back to the verified public endpoint", () => {
    expect(effectiveRpc("ethereum", undefined)).toBe(CHAIN_INFO.ethereum.rpc);
    expect(effectiveRpc("bsc", "")).toBe(CHAIN_INFO.bsc.rpc);
    expect(effectiveRpc("bsc", "   ")).toBe(CHAIN_INFO.bsc.rpc);
  });

  test("effectiveRpc honors a valid private http(s) override", () => {
    const priv = "https://my-private-node.example.com/rpc";
    expect(effectiveRpc("ethereum", priv)).toBe(priv);
    expect(effectiveRpc("bsc", "http://10.0.0.1:8545")).toBe(
      "http://10.0.0.1:8545",
    );
  });

  test("effectiveRpc rejects non-http overrides and falls back", () => {
    expect(effectiveRpc("arbitrum", "garbage")).toBe(CHAIN_INFO.arbitrum.rpc);
    expect(effectiveRpc("polygon", "ftp://node")).toBe(CHAIN_INFO.polygon.rpc);
    expect(effectiveRpc("polygon", "wss://node")).toBe(CHAIN_INFO.polygon.rpc);
  });

  test("every chain ships a real quote token and CORS-open public RPC", () => {
    expect(CHAIN_INFO.ethereum.quoteAddress).toBe(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    );
    expect(CHAIN_INFO.polygon.quoteAddress).toBe(
      "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    );
    for (const key of Object.keys(CHAIN_INFO) as (keyof typeof CHAIN_INFO)[]) {
      const info = CHAIN_INFO[key];
      expect(info.rpc).toMatch(/^https?:\/\//);
      expect(info.router).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(info.dexes.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("BNB_NETWORKS", () => {
  test("ships the official PancakeSwap V2 Router02 addresses", () => {
    expect(BNB_NETWORKS.mainnet.router).toBe(
      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    );
    expect(BNB_NETWORKS.testnet.router).toBe(
      "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    );
    expect(BNB_NETWORKS.mainnet.chainId).toBe(56);
    expect(BNB_NETWORKS.testnet.chainId).toBe(97);
    expect(BNB_NETWORKS.mainnet.wbnb).toBe(WBNB_MAINNET);
  });
});
