export type SessionStateName = "waiting" | "paired" | "ended";

export type PublicStatus = {
  sessionId: string;
  state: "waiting" | "paired" | "expired";
  expiresAt: number;
  sessionStartedAt: number;
  browserConnected: boolean;
  agentConnected: boolean;
};

export type MintResponse = {
  sessionId: string;
  browserToken: string;
  agentToken: string;
  expiresAt: number;
  ttlSeconds: number;
  joins: {
    browser: string;
    agent: string;
  };
};

/** Fallback when SESSION_TTL_SECONDS is unset or unparseable. */
export const DEFAULT_TTL_SECONDS = 900;
export const MIN_TTL_SECONDS = 1;
export const MAX_TTL_SECONDS = 3600;

/**
 * Resolve mint default TTL from Worker var SESSION_TTL_SECONDS.
 * Clamps to [MIN_TTL_SECONDS, MAX_TTL_SECONDS]. Invalid/empty -> DEFAULT_TTL_SECONDS then clamp.
 */
export function resolveSessionTtlSeconds(envValue?: string): number {
  const raw = (envValue ?? "").trim();
  const parsed = raw === "" ? NaN : Number(raw);
  const n = Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, n));
}

/** Clamp an explicit request TTL (or fall back to fallback). */
export function clampTtlSeconds(
  ttl: number | undefined,
  fallback: number = DEFAULT_TTL_SECONDS,
): number {
  const n =
    typeof ttl === "number" && Number.isFinite(ttl) ? Math.floor(ttl) : fallback;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, n));
}
