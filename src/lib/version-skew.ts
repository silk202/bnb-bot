/**
 * Client/deployment version skew.
 *
 * `gate:operatorLogin` is an Action. A client bundle built before that change
 * still calls it as a Mutation, and Convex answers:
 *
 *   "Trying to execute gate.js:operatorLogin as Mutation, but it is defined as
 *    Action. Called by client"
 *
 * Nothing is wrong with the deployment, and retrying cannot help — the running
 * page is older than the backend. Saying so beats showing a raw server error,
 * because the fix (reload, or rebuild the bundle) is the operator's to make.
 */

const SKEW = /defined as (Action|Mutation)/i;

export function isFunctionKindSkew(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${(error as { data?: unknown }).data ?? ""}`
      : typeof error === "string"
        ? error
        : "";
  return SKEW.test(message);
}

export const VERSION_SKEW_MESSAGE =
  "This page was built before the backend changed this action. Reload the page (hard refresh); if it persists, the app bundle needs rebuilding and redeploying. Your credentials were not sent.";
