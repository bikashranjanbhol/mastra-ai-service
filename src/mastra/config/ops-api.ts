/**
 * Ops API connection config.
 *
 * The API currently has no authentication. `buildHeaders()` is the single place
 * that changes when it gains some — no tool or registry entry constructs
 * headers itself, so adding auth later touches exactly one function.
 */

export interface OpsApiConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export class OpsApiNotConfiguredError extends Error {
  constructor() {
    super('OPS_API_BASE_URL is not set. Add it to .env (e.g. OPS_API_BASE_URL=https://ops.internal.example).');
    this.name = 'OpsApiNotConfiguredError';
  }
}

/**
 * Resolve config from the environment.
 *
 * Throws only when a tool actually runs, never at import time — a missing base
 * URL must not stop the dev server or the rest of the agents from working.
 */
export function resolveOpsApiConfig(env: NodeJS.ProcessEnv = process.env): OpsApiConfig {
  const baseUrl = env.OPS_API_BASE_URL?.trim();
  if (!baseUrl) throw new OpsApiNotConfiguredError();

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: Number(env.OPS_API_TIMEOUT_MS ?? 15_000),
    maxRetries: Number(env.OPS_API_MAX_RETRIES ?? 2),
  };
}

/** True when the API is configured, without throwing. Used by health reporting. */
export function isOpsApiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPS_API_BASE_URL?.trim());
}

/**
 * Headers for every ops API request.
 *
 * No authentication today. When the API gains auth (bearer, gateway header,
 * forwarded user identity), add it here and every endpoint inherits it.
 */
export function buildHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
  };
}
