/**
 * Hydrates the chain-activation store from the backend.
 *
 * The store is the ONLY source of activation truth for the execution gate, and
 * this component is the only thing that fills it. Until the query resolves the
 * store stays "not loaded" and the gate refuses live signing — a failure here
 * (offline, paused deployment, tampering) cannot grant anything, it can only
 * withhold.
 *
 * Mounted once, inside the authenticated terminal layout.
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { hydrateActivations } from "@/chains/registry/activations";

export function ActivationHydrator() {
  const rows = useQuery(api.chainActivations.currentActivations, {});

  useEffect(() => {
    // `undefined` means the query has not answered yet — leave the store
    // untouched. An empty array is a real answer: no chain is activated.
    if (rows === undefined) return;
    hydrateActivations(rows);
  }, [rows]);

  return null;
}
