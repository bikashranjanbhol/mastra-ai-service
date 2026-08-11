/**
 * Structured logging, shared by the Mastra instance and the benchmark harness.
 *
 * Every model-facing log line carries `provider` and `model` so a failure can be
 * attributed to a specific provider/model pair rather than "the agent broke".
 */
import { PinoLogger } from '@mastra/loggers';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' ? raw : 'info';
}

export const SERVICE_NAME = process.env.SERVICE_NAME?.trim() || 'mastra-ai-service';

export const logger = new PinoLogger({
  name: SERVICE_NAME,
  level: resolveLevel(),
});

/** Fields attached to any log line describing a model call. */
export interface ModelLogFields {
  provider: string;
  model: string;
  [key: string]: unknown;
}

/**
 * Log a model call outcome with consistent, greppable fields.
 * Kept here (not in agents/) so no provider naming leaks into domain code.
 */
export function logModelCall(
  outcome: 'ok' | 'error',
  fields: ModelLogFields & { latencyMs?: number; error?: string },
): void {
  const { provider, model, ...rest } = fields;
  const payload = { service: SERVICE_NAME, provider, model, ...rest };
  if (outcome === 'ok') logger.info('model call succeeded', payload);
  else logger.error('model call failed', payload);
}
