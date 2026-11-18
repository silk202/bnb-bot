import { useAuth } from "@/hooks/use-auth";
import { useBackendOutage } from "@/lib/backend-outage";
import { BackendPausedScreen } from "@/components/BackendPausedBoundary";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const backendOutage = useBackendOutage();
  const location = useLocation();

  if (isLoading) {
    // During a backend pause the auth boot can never resolve — show the calm
    // standby screen (with recovery probing) instead of an eternal spinner.
    if (backendOutage) {
      return <BackendPausedScreen />;
    }
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return children;
}
