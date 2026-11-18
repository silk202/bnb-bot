import { describe, expect, test } from "bun:test";
import {
  flattenSoliditySource,
  resolveImport,
  stripImportHeaders,
} from "../solc-flatten";

/** Real-shaped fixture: root contract + nested OpenZeppelin-style deps. */
const FILES = new Map<string, string>([
  [
    "FlashBoltArbitrage.sol",
    [
      "// SPDX-License-Identifier: MIT",
      "pragma solidity ^0.8.20;",
      "",
      'import "@openzeppelin/contracts/access/Ownable.sol";',
      'import {IERC20} from "./interfaces/IERC20.sol";',
      "",
      "contract FlashBoltArbitrage {",
      "    Ownable internal o;",
      "    IERC20 internal t;",
      "}",
    ].join("\n"),
  ],
  [
    "@openzeppelin/contracts/access/Ownable.sol",
    [
      "// SPDX-License-Identifier: MIT",
      "pragma solidity ^0.8.20;",
      "",
      'import "../utils/Context.sol";',
      "",
      "contract Ownable {",
      "    address public owner = msg.sender;",
      "    Context internal c;",
      "}",
    ].join("\n"),
  ],
  [
    "@openzeppelin/contracts/utils/Context.sol",
    [
      "// SPDX-License-Identifier: MIT",
      "pragma solidity ^0.8.20;",
      "",
      "abstract contract Context {",
      "    uint256 internal constant ZERO = 0;",
      "}",
    ].join("\n"),
  ],
  [
    "interfaces/IERC20.sol",
    [
      "// SPDX-License-Identifier: MIT",
      "pragma solidity ^0.8.20;",
      "",
      "interface IERC20 {",
      "    function totalSupply() external view returns (uint256);",
      "}",
    ].join("\n"),
  ],
]);

describe("flattenSoliditySource (BscScan verify payload)", () => {
  test("inlines every import into a single file", () => {
    const out = flattenSoliditySource("FlashBoltArbitrage.sol", FILES);
    expect(out).toContain("contract FlashBoltArbitrage");
    expect(out).toContain("contract Ownable");
    expect(out).toContain("abstract contract Context");
    expect(out).toContain("interface IERC20");
  });

  test("leaves no import statements behind", () => {
    const out = flattenSoliditySource("FlashBoltArbitrage.sol", FILES);
    expect(out).not.toMatch(/import/);
  });

  test("keeps exactly one pragma and one SPDX header (the root's)", () => {
    const out = flattenSoliditySource("FlashBoltArbitrage.sol", FILES);
    expect(out.match(/pragma solidity/g)?.length).toBe(1);
    expect(out.match(/SPDX-License-Identifier/g)?.length).toBe(1);
  });

  test("dependencies are inlined at their import site, before the root body", () => {
    const out = flattenSoliditySource("FlashBoltArbitrage.sol", FILES);
    expect(out.indexOf("contract Ownable")).toBeGreaterThan(-1);
    expect(out.indexOf("contract Ownable")).toBeLessThan(
      out.indexOf("contract FlashBoltArbitrage"),
    );
  });

  test("a dependency is inlined exactly once", () => {
    const out = flattenSoliditySource("FlashBoltArbitrage.sol", FILES);
    expect(out.match(/abstract contract Context/g)?.length).toBe(1);
  });

  test("missing files degrade to an empty inline instead of throwing", () => {
    const out = flattenSoliditySource("Ghost.sol", new Map([["Ghost.sol", 'import "./nope.sol";\ncontract Ghost {}']]));
    expect(out).toContain("contract Ghost");
  });
});

describe("resolveImport", () => {
  test("resolves ../ against the importer directory", () => {
    expect(
      resolveImport(
        "@openzeppelin/contracts/access/Ownable.sol",
        "../utils/Context.sol",
      ),
    ).toBe("@openzeppelin/contracts/utils/Context.sol");
  });

  test("resolves ./ against the importer directory", () => {
    expect(
      resolveImport("FlashBoltArbitrage.sol", "./interfaces/IERC20.sol"),
    ).toBe("interfaces/IERC20.sol");
  });

  test("leaves bare (package) imports untouched", () => {
    expect(
      resolveImport(
        "FlashBoltArbitrage.sol",
        "@openzeppelin/contracts/access/Ownable.sol",
      ),
    ).toBe("@openzeppelin/contracts/access/Ownable.sol");
  });
});

describe("stripImportHeaders", () => {
  test("removes pragma + SPDX but keeps the code", () => {
    const stripped = stripImportHeaders(
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract A {}\n",
    );
    expect(stripped).not.toContain("SPDX");
    expect(stripped).not.toContain("pragma");
    expect(stripped).toContain("contract A");
  });
});
