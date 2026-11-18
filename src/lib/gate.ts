/**
 * Gate (v2.0) client helpers — access grants, passcode rules and location
 * auto-detection for the subscribe popup. Pure functions where possible so
 * they stay unit-testable.
 */

export const GATE_GRANT_KEY = "flashbolt.gate.grant";

export type GateRole = "operator" | "subscriber";

export interface GateGrant {
  role: GateRole;
  email: string;
  grantedAt: number;
}

/** Passcodes expire 72 hours after issue. */
export const PASSCODE_TTL_MS = 72 * 60 * 60 * 1000;

export function isPasscodeExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt < now;
}

export function getGrant(): GateGrant | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GATE_GRANT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GateGrant;
    if (!parsed || (parsed.role !== "operator" && parsed.role !== "subscriber")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setGrant(grant: GateGrant): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GATE_GRANT_KEY, JSON.stringify(grant));
  } catch {
    // Storage unavailable — the session simply won't persist across reloads.
  }
}

export function clearGrant(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GATE_GRANT_KEY);
  } catch {
    // noop
  }
}

// Server-issued device trust (v2.5) — the token is minted by the Convex
// backend ONLY after a real server-side verification (guest access code or
// operator email OTP); only its SHA-256 hash is ever stored server-side.
// Its presence in this browser proves a real verification happened here, so
// operator-only bot surfaces recognize every future session on this device —
// the amber "Session not recognized" banner cannot recur.
export const DEVICE_TRUST_TOKEN_KEY = "flashbolt.deviceTrustToken";

/** Raw device-trust token for this browser, or null when never issued. */
export function getDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_TRUST_TOKEN_KEY);
    return raw && raw.length >= 32 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the just-issued raw token (returned exactly once by the server). */
export function setDeviceToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEVICE_TRUST_TOKEN_KEY, token);
  } catch {
    // Storage unavailable — the device simply re-verifies next time.
  }
}

/** Mask a passcode for display: FB-XX••••-XXXX (never full in the UI). */
export function maskPasscode(code: string): string {
  if (!code) return "••••";
  if (code.length <= 4) return "••••";
  return `${code.slice(0, 3)}••••${code.slice(-5)}`;
}

/** Human-friendly expiry label. */
export function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Real location auto-detection: ipapi.co first (no key needed), browser
 * geolocation as a fallback. Returns "" when neither is available — the
 * subscriber can type their location manually.
 */
export async function detectLocation(): Promise<string> {
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (res.ok) {
      const data = (await res.json()) as {
        city?: string;
        country_name?: string;
      };
      const parts = [data.city, data.country_name].filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
    }
  } catch {
    // fall through to geolocation
  }
  if (typeof navigator !== "undefined" && navigator.geolocation) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 5000,
        });
      });
      return `Lat ${pos.coords.latitude.toFixed(2)}, Lon ${pos.coords.longitude.toFixed(2)}`;
    } catch {
      return "";
    }
  }
  return "";
}
