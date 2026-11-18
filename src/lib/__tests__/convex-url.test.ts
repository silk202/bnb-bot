import { describe, expect, test } from "bun:test";
import { convexHttpOrigin, resolveConvexUrl } from "../convex-url";

describe("resolveConvexUrl", () => {
  test("keeps a clean URL", () => {
    expect(resolveConvexUrl("https://pastel-pelican-634.convex.cloud")).toBe(
      "https://pastel-pelican-634.convex.cloud",
    );
  });

  // The exact shape the secret sync has repeatedly written into .env.local.
  test("strips a space-padded single-quoted value", () => {
    expect(resolveConvexUrl("' https://pastel-pelican-634.convex.cloud'")).toBe(
      "https://pastel-pelican-634.convex.cloud",
    );
  });

  test("strips double quotes and padding in either order", () => {
    expect(resolveConvexUrl('  " https://x.convex.cloud "  ')).toBe("https://x.convex.cloud");
    expect(resolveConvexUrl('"https://x.convex.cloud"')).toBe("https://x.convex.cloud");
  });

  test("drops trailing slashes", () => {
    expect(resolveConvexUrl("https://x.convex.cloud///")).toBe("https://x.convex.cloud");
  });

  test("rejects blank, quoted-empty and non-URL values", () => {
    expect(resolveConvexUrl("")).toBeUndefined();
    expect(resolveConvexUrl("   ")).toBeUndefined();
    expect(resolveConvexUrl("''")).toBeUndefined();
    expect(resolveConvexUrl("pastel-pelican-634")).toBeUndefined();
    expect(resolveConvexUrl("ftp://x.convex.cloud")).toBeUndefined();
    // Trailing text, a path or a query are not deployment URLs.
    expect(resolveConvexUrl("https://x.convex.cloud extra")).toBeUndefined();
    expect(resolveConvexUrl("https://x.convex.cloud/api")).toBeUndefined();
    expect(resolveConvexUrl("https://x.convex.cloud?x=1")).toBeUndefined();
    expect(resolveConvexUrl(undefined)).toBeUndefined();
    expect(resolveConvexUrl(null)).toBeUndefined();
  });
});

describe("convexHttpOrigin", () => {
  test("maps .convex.cloud to the .convex.site actions origin", () => {
    expect(convexHttpOrigin("' https://flexible-frog-776.convex.cloud'")).toBe(
      "https://flexible-frog-776.convex.site",
    );
  });

  test("returns undefined when there is no usable URL", () => {
    expect(convexHttpOrigin("")).toBeUndefined();
    expect(convexHttpOrigin(undefined)).toBeUndefined();
  });
});
