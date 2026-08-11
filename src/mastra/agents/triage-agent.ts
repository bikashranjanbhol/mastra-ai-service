/**
 * Triage agent — classifies an inbound request into a structured record.
 *
 * Exists separately from the docs agent because its job is structured
 * extraction, not conversation: it is the structured-output half of the
 * cross-provider benchmark, where providers diverge most.
 *
 * Instructions describe the FIELDS in prose rather than embedding a JSON
 * example, so the same prompt works whether a provider is driven by native
 * structured output, tool-call-shaped output, or constrained decoding.
 */
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { modelChainForRequest } from '../config/models';
import { DOC_OWNERS } from '../data/docs';

/** Shared with the workflow and the benchmark so all three agree on the shape. */
export const triageSchema = z.object({
  summary: z.string().describe('One sentence describing what the user needs'),
  severity: z.enum(['sev1', 'sev2', 'sev3']).describe('Impact level'),
  team: z.string().describe('Owning team'),
  needsHuman: z.boolean().describe('True when a person must decide or act'),
  topics: z.array(z.string()).describe('Short topic labels, lowercase'),
});

export type TriageResult = z.infer<typeof triageSchema>;

export const triageAgent = new Agent({
  id: 'triage-agent',
  name: 'Triage Agent',
  description: 'Classifies an inbound request into a structured triage record.',
  instructions: `You classify inbound internal requests so they can be routed.

For each request, determine:
- summary: a single sentence stating what the user needs. Do not copy the request verbatim.
- severity: sev1 when a customer-facing service is down or data has been lost; sev2 when there is major degradation but a workaround exists; sev3 when impact is minor or purely informational. A question that only asks what a policy says is sev3.
- team: the team that owns the work. Choose from: ${DOC_OWNERS.join(', ')}. If none clearly fits, use the closest match rather than inventing a new team name.
- needsHuman: true only when a person must decide or take action. A request answerable from documentation alone is false.
- topics: two to four short lowercase labels, each one or two words.

Judge severity by actual impact described, not by how urgent the wording sounds. An emphatic request about a policy question is still sev3.`,
  model: ({ requestContext }) => modelChainForRequest(requestContext),
});
