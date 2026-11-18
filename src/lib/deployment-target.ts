/**
 * Which backend every frontend surface is allowed to talk to.
 *
 * Three Convex deployments exist for this project and only two belong to the
 * app: `pastel-pelican-634` (dev) and `flexible-frog-776` (production).
 * `shiny-bulldog-311` is a foreign/parked deployment that must never receive
 * telemetry, metrics or any other request from the frontend.
 *
 * The rule is enforced at the single read path (`resolveConvexUrl`), so the
 * Convex client, the HTTP-actions origin and every metric endpoint inherit it
 * without each call site re-checking. A rejected URL behaves exactly like an
 * unconfigured one: the app shows its "Backend not configured" state instead
 * of silently attaching to the wrong deployment.
 */

export const DEPLOYMENT_TARGETS = {
  dev: "pastel-pelican-634",
  prod: "flexible-frog-776",
} as const;

export type Environment = keyof typeof DEPLOYMENT_TARGETS;

/** Deployments the app must never point at. */
export const FORBIDDEN_DEPLOYMENTS: readonly string[] = ["shiny-bulldog-311"];

/** `https://pastel-pelican-634.convex.cloud` → `pastel-pelican-634`. */
export function deploymentSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https?:\/\/([a-z0-9-]+)\.convex\.(?:cloud|site)\/?$/i.exec(url.trim());
  return match?.[1]?.toLowerCase();
}

export function isForbiddenDeployment(url: string | undefined): boolean {
  const slug = deploymentSlug(url);
  return Boolean(slug && FORBIDDEN_DEPLOYMENTS.includes(slug));
}

export interface DeploymentTarget {
  slug: string;
  environment: Environment;
}

/** Classify a URL; undefined for an unknown (or forbidden) deployment. */
export function classifyDeployment(url: string | undefined): DeploymentTarget | undefined {
  const slug = deploymentSlug(url);
  if (!slug || FORBIDDEN_DEPLOYMENTS.includes(slug)) return undefined;
  for (const [environment, name] of Object.entries(DEPLOYMENT_TARGETS) as [Environment, string][]) {
    if (name === slug) return { slug, environment };
  }
  return undefined;
}

/** Human label for the settings/keys surface: "pastel-pelican-634 · dev". */
export function describeDeployment(url: string | undefined): string {
  const slug = deploymentSlug(url);
  if (!slug) return "not configured";
  if (FORBIDDEN_DEPLOYMENTS.includes(slug)) return `${slug} · blocked (not this app's deployment)`;
  const target = classifyDeployment(url);
  return target ? `${target.slug} · ${target.environment}` : `${slug} · unrecognised`;
}
