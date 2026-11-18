import { getGrant } from "@/lib/gate";
import type { ReactNode } from "react";
import { Navigate } from "react-router";

/**
 * The landing page is the second page: it only opens after the terminal
 * operator or a subscriber passes the gate (first page). Without a stored
 * grant the visitor is sent back to the gate.
 */
export function GateGuard({ children }: { children: ReactNode }) {
  if (!getGrant()) {
    return <Navigate to="/" replace />;
  }
  return children;
}
