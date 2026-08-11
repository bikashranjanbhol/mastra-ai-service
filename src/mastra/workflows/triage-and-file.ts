/**
 * triage-and-file — deterministic pipeline for an inbound request.
 *
 *   1. search   — retrieve supporting documentation (pure function, no model)
 *   2. triage   — classify into a structured record (model call)
 *   3. file     — create a ticket only when triage says a human is needed
 *
 * The order is known in advance, so it is a workflow rather than a mega-agent:
 * step 1 is deterministic and cheap, and step 3 is conditional on step 2's
 * output rather than on a model deciding to call a tool.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { triageSchema } from '../agents/triage-agent';
import { searchDocsTool } from '../tools/search-docs';
import { getTicketStore } from '../services/ticket-store';

const workflowInput = z.object({
  request: z.string().min(1).describe('The inbound request text'),
  /** When false, triage still runs but no ticket is created. */
  fileTicket: z.boolean().default(true),
});

const searchOutput = z.object({
  request: z.string(),
  fileTicket: z.boolean(),
  docIds: z.array(z.string()),
  context: z.string(),
});

const triageOutput = searchOutput.extend({ triage: triageSchema });

const finalOutput = z.object({
  triage: triageSchema,
  docIds: z.array(z.string()),
  ticketId: z.string().optional(),
  filed: z.boolean(),
  reason: z.string().describe('Why a ticket was or was not filed'),
});

const searchStep = createStep({
  id: 'search',
  description: 'Retrieve documentation passages relevant to the request.',
  inputSchema: workflowInput,
  outputSchema: searchOutput,
  execute: async ({ inputData }) => {
    // Call the tool's execute directly: this step is deterministic, no model.
    const result = (await searchDocsTool.execute!(
      { query: inputData.request, limit: 3 },
      {} as never,
    )) as { results: Array<{ id: string; title: string; section: string; text: string }> };

    return {
      request: inputData.request,
      fileTicket: inputData.fileTicket,
      docIds: result.results.map((r) => r.id),
      context: result.results.map((r) => `[${r.id}] ${r.title} — ${r.section}: ${r.text}`).join('\n\n'),
    };
  },
});

const triageStep = createStep({
  id: 'triage',
  description: 'Classify the request into a structured triage record.',
  inputSchema: searchOutput,
  outputSchema: triageOutput,
  execute: async ({ inputData, mastra, requestContext }) => {
    const agent = mastra.getAgent('triageAgent');

    const prompt = inputData.context
      ? `Request:\n${inputData.request}\n\nSupporting documentation:\n${inputData.context}`
      : `Request:\n${inputData.request}\n\nNo supporting documentation was found.`;

    const result = await agent.generate(prompt, {
      structuredOutput: { schema: triageSchema },
      requestContext,
    });

    const triage = result.object;
    if (!triage) throw new Error('triage step: model returned no structured object');

    return { ...inputData, triage };
  },
});

const fileStep = createStep({
  id: 'file',
  description: 'File a ticket when triage determined a human is needed.',
  inputSchema: triageOutput,
  outputSchema: finalOutput,
  execute: async ({ inputData }) => {
    const { triage, docIds, fileTicket, request } = inputData;

    if (!fileTicket) {
      return { triage, docIds, filed: false, reason: 'ticket filing disabled for this run' };
    }
    if (!triage.needsHuman) {
      return { triage, docIds, filed: false, reason: 'triage determined no human action is required' };
    }

    const ticket = await getTicketStore().create({
      title: triage.summary.slice(0, 120),
      body: request,
      severity: triage.severity,
      team: triage.team,
      sourceDocIds: docIds,
    });

    return { triage, docIds, ticketId: ticket.id, filed: true, reason: 'triage determined a human is required' };
  },
});

export const triageAndFileWorkflow = createWorkflow({
  id: 'triage-and-file',
  description: 'Search documentation, classify the request, and file a ticket when a human is needed.',
  inputSchema: workflowInput,
  outputSchema: finalOutput,
})
  .then(searchStep)
  .then(triageStep)
  .then(fileStep)
  .commit();
