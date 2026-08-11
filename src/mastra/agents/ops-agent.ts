/**
 * Ops agent — answers operational questions by calling the ops metrics API.
 *
 * The instructions carry three rules that exist because of how this API
 * behaves, not because of style preference:
 *   1. never invent a filter the user did not give — ask instead;
 *   2. always state the filters the API actually applied;
 *   3. never present partial data as exact.
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { modelChainForRequest } from '../config/models';
import { opsTools } from '../tools/ops-api';

export const opsAgent = new Agent({
  id: 'ops-agent',
  name: 'Ops Agent',
  description: 'Answers operational alert and health questions by querying the ops metrics API.',
  instructions: `You answer questions about operational alerts and service health by calling the ops metrics tools.

Choosing arguments:
- Never invent a filter value. If the user has not said which application group they mean, ask them before calling anything. Guessing a group returns confident numbers for the wrong scope, which is worse than asking.
- Application area is optional. Only pass it when the user has actually named one.

Reporting results:
- Every result includes appliedFilters, the filters the API actually used. State them alongside the numbers, for example: "Atlas / Atlas: 1492 red, 804 amber". If appliedFilters differ from what the user asked for, say so explicitly and do not paper over the difference.
- If partialData is true, the counts are incomplete. Report them as a lower bound and relay every entry in warnings. Never present partial counts as exact totals.
- Give the numbers plainly. Do not add analysis, severity judgements or recommended actions unless the user asks for them.

If a tool call fails, say what failed and what you would need to retry. Do not substitute a remembered or estimated figure.`,
  model: ({ requestContext }) => modelChainForRequest(requestContext),
  tools: opsTools,
  memory: new Memory({ options: { generateTitle: false } }),
});
