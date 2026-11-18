/**
 * Fills the browser's cache of the backend's validated discovery registry.
 *
 * Two queries: validated RPC endpoints and validated addresses. Both are read
 * only — the backend decides what is validated, this component just mirrors it
 * so endpoint ordering and address checks do not need a round trip each time.
 *
 * Mounted once inside the authenticated terminal layout. Until the queries
 * answer, the store approves nothing: no preferred endpoint, no validated
 * router/factory/executor.
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  hydrateInternalDestinations,
  hydrateValidatedDiscovery,
  hydrateValidatedRpcEndpoints,
} from "@/chains/registry/discovery-store";

export function DiscoveryHydrator() {
  const rpcRows = useQuery(api.discovery.validatedRpcEndpoints, {});
  const recordRows = useQuery(api.discovery.validatedDiscoveryRecords, {});
  const destinationRows = useQuery(api.destinations.internalDestinations, {});

  useEffect(() => {
    if (rpcRows === undefined) return;
    hydrateValidatedRpcEndpoints(rpcRows);
  }, [rpcRows]);

  useEffect(() => {
    if (recordRows === undefined) return;
    hydrateValidatedDiscovery(recordRows);
  }, [recordRows]);

  useEffect(() => {
    if (destinationRows === undefined) return;
    hydrateInternalDestinations(destinationRows);
  }, [destinationRows]);

  return null;
}
