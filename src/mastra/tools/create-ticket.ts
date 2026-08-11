/**
 * Ticket filing tool.
 *
 * Persists through the TicketStore seam — this file knows nothing about
 * SQLite, Postgres or any external tracker.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTicketStore } from '../services/ticket-store';
import { DOC_OWNERS } from '../data/docs';

export const createTicketTool = createTool({
  id: 'create_ticket',
  description:
    'File a ticket for work that cannot be resolved by answering from documentation alone. ' +
    'Only call this when the user has asked for something to be actioned, or when the documentation ' +
    'does not cover their situation and a human needs to decide. Do not file a ticket just to ' +
    'acknowledge a question you already answered.',
  inputSchema: z.object({
    title: z.string().min(4).max(120).describe('Short imperative summary, e.g. "Rotate leaked API key in billing repo"'),
    body: z
      .string()
      .min(10)
      .describe('What is needed and why, including any relevant detail the user supplied'),
    severity: z
      .enum(['sev1', 'sev2', 'sev3'])
      .describe('sev1 = service down or data loss, sev2 = major degradation with a workaround, sev3 = minor or no customer impact'),
    team: z
      .string()
      .describe(`Owning team. Prefer one of: ${DOC_OWNERS.join(', ')}`),
    sourceDocIds: z
      .array(z.string())
      .default([])
      .describe('Ids of documentation passages that informed this ticket, if any'),
  }),
  outputSchema: z.object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
    team: z.string(),
    createdAt: z.string(),
  }),
  execute: async ({ title, body, severity, team, sourceDocIds }) => {
    const ticket = await getTicketStore().create({ title, body, severity, team, sourceDocIds });
    return {
      id: ticket.id,
      title: ticket.title,
      severity: ticket.severity,
      team: ticket.team,
      createdAt: ticket.createdAt,
    };
  },
});
