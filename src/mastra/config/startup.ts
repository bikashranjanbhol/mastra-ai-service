/**
 * Startup environment report.
 *
 * Prints which providers are usable and which were skipped, then returns the
 * validated result. Imported by the Mastra instance and by `npm run doctor`.
 */
import { logger, SERVICE_NAME } from './logger';
import {
  buildModelChain,
  NoProvidersConfiguredError,
  selectModel,
  validateEnv,
  type EnvValidationResult,
} from './models';

export interface StartupReport extends EnvValidationResult {
  readonly defaultModel?: string;
  readonly chain: string[];
}

/**
 * Validate and log. `allowZeroProviders` lets tooling introspect an
 * unconfigured environment without throwing (the benchmark relies on this).
 */
export function reportStartup(opts: { allowZeroProviders?: boolean } = {}): StartupReport {
  const result = validateEnv(process.env, opts);

  for (const warning of result.warnings) {
    logger.warn(warning, { service: SERVICE_NAME });
  }

  const configured = result.availability.filter((p) => p.configured);
  for (const p of configured) {
    logger.info(`provider "${p.id}" configured`, { service: SERVICE_NAME, provider: p.id, keySource: p.keySource });
  }

  const selection = selectModel();
  const chain = buildModelChain().map((entry) => entry.model);

  if (selection) {
    logger.info('default model resolved', {
      service: SERVICE_NAME,
      provider: selection.provider,
      model: selection.modelString,
      tier: selection.tier,
      fallbacks: chain.length - 1,
    });
  } else {
    logger.warn('no provider configured — agents will error until a key is set', { service: SERVICE_NAME });
  }

  return { ...result, defaultModel: selection?.modelString, chain };
}

export { NoProvidersConfiguredError };
