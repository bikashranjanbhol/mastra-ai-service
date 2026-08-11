/**
 * Mastra instance — registers agents, tools, workflows and scorers, and wires
 * the production seams (storage, observability).
 *
 * Storage and provider selection are both env-driven and resolved here, so no
 * agent, tool or workflow contains a provider name or a storage detail.
 */
import { Mastra } from '@mastra/core/mastra';
import { Observability, MastraStorageExporter, SensitiveDataFilter } from '@mastra/observability';

import { logger, SERVICE_NAME } from './config/logger';
import { reportStartup } from './config/startup';
import { createMastraStorage, resolveStorageTarget } from './config/storage';

import { docsAgent } from './agents/docs-agent';
import { triageAgent } from './agents/triage-agent';
import { searchDocsTool } from './tools/search-docs';
import { createTicketTool } from './tools/create-ticket';
import { triageAndFileWorkflow } from './workflows/triage-and-file';
import { answerGroundednessScorer, triageValidityScorer } from './scorers';

// Report provider availability at boot. `allowZeroProviders` keeps the dev
// server usable with no keys — Studio still loads and the failure surfaces per
// request with a clear message, rather than the process refusing to start.
reportStartup({ allowZeroProviders: true });

const storageTarget = resolveStorageTarget();
logger.info('storage resolved', { service: SERVICE_NAME, backend: storageTarget.backend, target: storageTarget.describe });

export const mastra = new Mastra({
  agents: { docsAgent, triageAgent },
  tools: { searchDocsTool, createTicketTool },
  workflows: { triageAndFileWorkflow },
  scorers: { answerGroundednessScorer, triageValidityScorer },
  storage: await createMastraStorage(storageTarget),
  logger,
  observability: new Observability({
    configs: {
      default: {
        serviceName: SERVICE_NAME,
        exporters: [new MastraStorageExporter()],
        // Strips secrets from spans before they are persisted.
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
