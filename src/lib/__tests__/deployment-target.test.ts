import { describe, expect, test } from "bun:test";
import { classifyDeployment, DEPLOYMENT_TARGETS, describeDeployment, deploymentSlug, isForbiddenDeployment } from "../deployment-target";
import { resolveConvexUrl } from "../convex-url";

const DEV = `https://${DEPLOYMENT_TARGETS.dev}.convex.cloud`;
const PROD = `https://${DEPLOYMENT_TARGETS.prod}.convex.cloud`;
const SHINY = "https://shiny-bulldog-311.convex.cloud";

describe("deployment target", () => {
  test("dev and prod slugs are the ones this app is allowed to use", () => {
    expect(DEPLOYMENT_TARGETS).toEqual({ dev: "pastel-pelican-634", prod: "flexible-frog-776" });
  });

  test("classifies dev and prod, including the .convex.site origin", () => {
    expect(classifyDeployment(DEV)).toEqual({ slug: "pastel-pelican-634", environment: "dev" });
    expect(classifyDeployment(PROD)).toEqual({ slug: "flexible-frog-776", environment: "prod" });
    expect(classifyDeployment("https://flexible-frog-776.convex.site")).toEqual({
      slug: "flexible-frog-776",
      environment: "prod",
    });
  });

  test("the foreign deployment is forbidden, not merely unknown", () => {
    expect(isForbiddenDeployment(SHINY)).toBe(true);
    expect(classifyDeployment(SHINY)).toBeUndefined();
    expect(describeDeployment(SHINY)).toContain("blocked");
  });

  test("unknown hosts are not classified as dev or prod", () => {
    expect(deploymentSlug("https://example.com")).toBeUndefined();
    expect(classifyDeployment("https://some-other-123.convex.cloud")).toBeUndefined();
  });
});

describe("resolveConvexUrl never returns a foreign deployment", () => {
  test("accepts dev and prod", () => {
    expect(resolveConvexUrl(DEV)).toBe(DEV);
    expect(resolveConvexUrl(` ' ${PROD} ' `)).toBe(PROD);
  });

  test("rejects shiny so metrics cannot point there", () => {
    expect(resolveConvexUrl(SHINY)).toBeUndefined();
    expect(resolveConvexUrl("https://shiny-bulldog-311.convex.site")).toBeUndefined();
  });
});
