/**
 * Version-sync guard — overlay artifacts must always carry the app version.
 *
 * Prevents a repeat of the drift found in v2.8.0: the BNB overlay shipped
 * v2.0.0 and the SOL overlay v1.0.0 while the app itself was at 2.7.x. If
 * this test fails, bump the version consts in lockstep with package.json.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OVERLAY_VERSION } from "../overlay-script";
import { SOL_OVERLAY_VERSION } from "../sol-overlay-script";

const pkg = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("overlay ↔ app version sync", () => {
  test("BNB overlay version matches the app version", () => {
    expect(OVERLAY_VERSION).toBe(pkg.version);
  });

  test("SOL overlay version matches the app version", () => {
    expect(SOL_OVERLAY_VERSION).toBe(pkg.version);
  });

  test("package.json carries a valid semver", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
