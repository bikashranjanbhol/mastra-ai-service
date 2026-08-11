/**
 * Fixed benchmark task set.
 *
 * The same cases run against every configured provider. Two kinds are
 * deliberately included because they are where providers actually diverge:
 *   - TOOL CALLING      — does the model call the tool at all, with valid args?
 *   - STRUCTURED OUTPUT — does it produce a schema-valid object?
 *
 * Each case carries its own grader so pass/fail is objective, plus the inputs
 * the quality scorers need.
 */
import { z } from 'zod';
import { triageSchema } from '../mastra/agents/triage-agent';

export type TaskKind = 'qa' | 'tool-calling' | 'structured-output';

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
}

export interface GradeContext {
  text: string;
  object: unknown;
  toolCalls: ToolCallRecord[];
}

export interface GradeResult {
  pass: boolean;
  reason: string;
}

export interface BenchTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly description: string;
  /** Which registered agent runs this case. */
  readonly agent: 'docsAgent' | 'triageAgent';
  readonly prompt: string;
  /** Present for structured-output cases only. */
  readonly schema?: z.ZodTypeAny;
  /** Objective pass/fail. */
  readonly grade: (ctx: GradeContext) => GradeResult;
  /** Passage ids a correct answer should rest on (drives the groundedness scorer). */
  readonly expectedDocIds?: string[];
  /** Expected classification (drives the triage-validity scorer). */
  readonly expectedTriage?: { severity?: string; team?: string; needsHuman?: boolean };
}

const pass = (reason: string): GradeResult => ({ pass: true, reason });
const fail = (reason: string): GradeResult => ({ pass: false, reason });

export const BENCH_TASKS: readonly BenchTask[] = [
  // ── Tool calling ───────────────────────────────────────────────────────────
  {
    id: 'tool-search-expense',
    kind: 'tool-calling',
    description: 'Must call search_docs, then answer the meal limit with a citation',
    agent: 'docsAgent',
    prompt: 'What is the daily limit for meal expenses when travelling?',
    expectedDocIds: ['expenses-001'],
    grade: ({ text, toolCalls }) => {
      const searched = toolCalls.some((c) => c.toolName === 'search_docs');
      if (!searched) return fail('did not call search_docs');
      if (!/\b75\b/.test(text)) return fail('answer omits the 75 USD limit');
      if (!text.includes('expenses-001')) return fail('answer does not cite expenses-001');
      return pass('called search_docs and cited the correct passage');
    },
  },
  {
    id: 'tool-search-severity',
    kind: 'tool-calling',
    description: 'Must call search_docs and report the SEV1 definition',
    agent: 'docsAgent',
    prompt: 'What counts as a SEV1 incident here?',
    expectedDocIds: ['incident-001'],
    grade: ({ text, toolCalls }) => {
      if (!toolCalls.some((c) => c.toolName === 'search_docs')) return fail('did not call search_docs');
      const lower = text.toLowerCase();
      const mentionsLoss = lower.includes('data loss') || lower.includes('complete loss');
      if (!mentionsLoss) return fail('answer omits the defining condition');
      if (!text.includes('incident-001')) return fail('answer does not cite incident-001');
      return pass('called search_docs and described SEV1 correctly');
    },
  },
  {
    id: 'tool-abstain',
    kind: 'tool-calling',
    description: 'Documentation does not cover this; must abstain rather than invent policy',
    agent: 'docsAgent',
    prompt: 'What is the company policy on bringing pets into the office?',
    grade: ({ text, toolCalls }) => {
      if (!toolCalls.some((c) => c.toolName === 'search_docs')) return fail('did not call search_docs');
      const lower = text.toLowerCase();
      const abstains =
        lower.includes("doesn't cover") ||
        lower.includes('does not cover') ||
        lower.includes('no documentation') ||
        lower.includes('not covered') ||
        lower.includes("couldn't find") ||
        lower.includes('could not find') ||
        lower.includes('no policy');
      if (!abstains) return fail('invented an answer instead of abstaining');
      return pass('abstained correctly');
    },
  },

  // ── Structured output ──────────────────────────────────────────────────────
  {
    id: 'structured-triage-outage',
    kind: 'structured-output',
    description: 'Severe outage must produce a schema-valid sev1 record needing a human',
    agent: 'triageAgent',
    prompt:
      'The checkout service has been returning 500s for all customers for the last twenty minutes. Nothing we try is bringing it back.',
    schema: triageSchema,
    expectedTriage: { severity: 'sev1', needsHuman: true },
    grade: ({ object }) => {
      const parsed = triageSchema.safeParse(object);
      if (!parsed.success) return fail(`schema invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      if (parsed.data.severity !== 'sev1') return fail(`severity ${parsed.data.severity}, expected sev1`);
      if (!parsed.data.needsHuman) return fail('needsHuman false for a full outage');
      return pass('valid sev1 record');
    },
  },
  {
    id: 'structured-triage-question',
    kind: 'structured-output',
    description: 'Emphatic wording must not inflate severity above sev3',
    agent: 'triageAgent',
    prompt: 'URGENT!!! I need to know RIGHT NOW what the receipt threshold is for expenses. This is extremely important!!!',
    schema: triageSchema,
    expectedTriage: { severity: 'sev3', team: 'finance', needsHuman: false },
    grade: ({ object }) => {
      const parsed = triageSchema.safeParse(object);
      if (!parsed.success) return fail(`schema invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      if (parsed.data.severity !== 'sev3') {
        return fail(`severity ${parsed.data.severity} — inflated by urgent wording, expected sev3`);
      }
      return pass('resisted urgency inflation');
    },
  },

  // ── Plain QA ───────────────────────────────────────────────────────────────
  {
    id: 'qa-retention',
    kind: 'qa',
    description: 'Answer the retention window with a citation',
    agent: 'docsAgent',
    prompt: 'How long do we keep customer data after an account is closed?',
    expectedDocIds: ['security-002'],
    grade: ({ text }) => {
      if (!/24\s*month|two\s*year|2\s*year/i.test(text)) return fail('answer omits the 24 month window');
      if (!text.includes('security-002')) return fail('answer does not cite security-002');
      return pass('correct retention window with citation');
    },
  },
];
