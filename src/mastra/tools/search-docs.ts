/**
 * Documentation search tool.
 *
 * Deterministic keyword+term scoring rather than embeddings, so cross-provider
 * benchmark runs are comparable: identical passages go to every model.
 * Replacing this with a vector store is a change to this file alone.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { DOC_CHUNKS, type DocChunk } from '../data/docs';

const resultSchema = z.object({
  id: z.string().describe('Stable chunk id, cite this when answering'),
  title: z.string(),
  section: z.string(),
  owner: z.string().describe('Team that owns this document'),
  text: z.string(),
  score: z.number().describe('Relevance score, higher is better'),
});

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function scoreChunk(chunk: DocChunk, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${chunk.title} ${chunk.section} ${chunk.text}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    // Keyword hits are the strongest signal.
    for (const keyword of chunk.keywords) {
      const k = keyword.toLowerCase();
      if (k === term) score += 3;
      else if (k.includes(term) || term.includes(k)) score += 1.5;
    }
    if (haystack.includes(term)) score += 1;
  }

  // Normalise by term count so long queries do not inflate every chunk equally.
  return score / terms.length;
}

export const searchDocsTool = createTool({
  id: 'search_docs',
  description:
    'Search the internal documentation and return the most relevant passages. ' +
    'Use this before answering any question about internal policy, process or standards. ' +
    'Returns passages with a stable id that must be cited in the answer.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Natural language search query'),
    limit: z.number().int().min(1).max(10).default(3).describe('Maximum passages to return'),
  }),
  outputSchema: z.object({
    results: z.array(resultSchema),
    matched: z.number().int().describe('How many passages scored above zero'),
  }),
  execute: async ({ query, limit }) => {
    const terms = tokenize(query);
    const scored = DOC_CHUNKS.map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) })).filter((r) => r.score > 0);

    scored.sort((a, b) => b.score - a.score);

    return {
      matched: scored.length,
      results: scored.slice(0, limit).map(({ chunk, score }) => ({
        id: chunk.id,
        title: chunk.title,
        section: chunk.section,
        owner: chunk.owner,
        text: chunk.text,
        score: Number(score.toFixed(3)),
      })),
    };
  },
});
