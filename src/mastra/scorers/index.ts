/**
 * Quality scorers.
 *
 * These are deliberately CODE-based rather than LLM-judge based:
 *   - they run with zero API keys, so quality scoring works in CI and in an
 *     unconfigured environment;
 *   - a judge model would itself be a provider, which would bias a
 *     cross-provider comparison toward whichever vendor judges.
 *
 * Add an LLM judge later by passing a `judge` config to a step — the pipeline
 * shape does not change.
 */
import { createScorer } from '@mastra/core/evals';
import { DOC_CHUNKS, DOC_OWNERS } from '../data/docs';

const VALID_DOC_IDS = new Set(DOC_CHUNKS.map((c) => c.id));

// ─────────────────────────────────────────────────────────────────────────────
// Groundedness: does the answer cite real, retrieved passages?
// ─────────────────────────────────────────────────────────────────────────────

export interface GroundednessInput {
  /** Passage ids the tool actually returned for this question. */
  retrievedDocIds: string[];
  /** Passage ids a correct answer is expected to rest on. */
  expectedDocIds: string[];
}

export interface GroundednessOutput {
  /** The agent's final answer text. */
  text: string;
}

/** Pull `(doc-id)` style citations out of free text. */
function extractCitations(text: string): string[] {
  const found = new Set<string>();
  for (const id of VALID_DOC_IDS) {
    if (text.includes(id)) found.add(id);
  }
  return [...found];
}

export const answerGroundednessScorer = createScorer<GroundednessInput, GroundednessOutput, 'answer-groundedness'>({
  id: 'answer-groundedness',
  name: 'Answer groundedness',
  description:
    'Scores whether an answer cites documentation passages that exist, were actually retrieved, and cover the expected sources.',
})
  .analyze(({ run }) => {
    const text = run.output?.text ?? '';
    const cited = extractCitations(text);
    const retrieved = new Set(run.input?.retrievedDocIds ?? []);
    const expected = run.input?.expectedDocIds ?? [];

    return {
      cited,
      // A citation that was never retrieved is a fabricated source.
      hallucinated: cited.filter((id) => !retrieved.has(id)),
      expectedHit: expected.filter((id) => cited.includes(id)),
      expectedTotal: expected.length,
      hasText: text.trim().length > 0,
    };
  })
  .generateScore(({ results }) => {
    const a = results.analyzeStepResult;
    if (!a.hasText) return 0;

    // No citations at all: the answer may be right but is not attributable.
    if (a.cited.length === 0) return 0.2;

    // Any fabricated citation is disqualifying.
    if (a.hallucinated.length > 0) return 0;

    // Otherwise reward covering the expected sources.
    if (a.expectedTotal === 0) return 1;
    return Number((a.expectedHit.length / a.expectedTotal).toFixed(3));
  })
  .generateReason(({ results, score }) => {
    const a = results.analyzeStepResult;
    if (!a.hasText) return 'empty answer';
    if (a.hallucinated.length > 0) return `cited passages that were never retrieved: ${a.hallucinated.join(', ')}`;
    if (a.cited.length === 0) return 'answer contains no passage citations';
    return `cited ${a.cited.join(', ')}; covered ${a.expectedHit.length}/${a.expectedTotal} expected sources (score ${score})`;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Triage validity: is the structured record well-formed and sensible?
// ─────────────────────────────────────────────────────────────────────────────

export interface TriageValidityInput {
  expectedSeverity?: string;
  expectedTeam?: string;
  expectedNeedsHuman?: boolean;
}

export interface TriageValidityOutput {
  summary?: unknown;
  severity?: unknown;
  team?: unknown;
  needsHuman?: unknown;
  topics?: unknown;
}

const VALID_SEVERITIES = new Set(['sev1', 'sev2', 'sev3']);
const VALID_TEAMS = new Set(DOC_OWNERS);

export const triageValidityScorer = createScorer<TriageValidityInput, TriageValidityOutput, 'triage-validity'>({
  id: 'triage-validity',
  name: 'Triage validity',
  description:
    'Scores whether a triage record is structurally valid (field types, allowed severity and team values) and matches the expected classification.',
})
  .analyze(({ run }) => {
    const o = run.output ?? {};
    const checks = {
      summaryOk: typeof o.summary === 'string' && o.summary.trim().length > 0,
      severityOk: typeof o.severity === 'string' && VALID_SEVERITIES.has(o.severity),
      teamOk: typeof o.team === 'string' && VALID_TEAMS.has(o.team),
      needsHumanOk: typeof o.needsHuman === 'boolean',
      topicsOk: Array.isArray(o.topics) && o.topics.every((t) => typeof t === 'string') && o.topics.length > 0,
    };

    const expected = run.input ?? {};
    const matches = {
      severity: expected.expectedSeverity === undefined || o.severity === expected.expectedSeverity,
      team: expected.expectedTeam === undefined || o.team === expected.expectedTeam,
      needsHuman: expected.expectedNeedsHuman === undefined || o.needsHuman === expected.expectedNeedsHuman,
    };

    return { checks, matches };
  })
  .generateScore(({ results }) => {
    const { checks, matches } = results.analyzeStepResult;
    const structural = Object.values(checks);
    const structuralScore = structural.filter(Boolean).length / structural.length;

    // A structurally broken record scores on structure alone — a lucky severity
    // guess inside malformed output is not worth credit.
    if (structuralScore < 1) return Number((structuralScore * 0.5).toFixed(3));

    const semantic = Object.values(matches);
    const semanticScore = semantic.filter(Boolean).length / semantic.length;
    return Number((0.5 + 0.5 * semanticScore).toFixed(3));
  })
  .generateReason(({ results, score }) => {
    const { checks, matches } = results.analyzeStepResult;
    const badFields = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const badMatches = Object.entries(matches)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);

    if (badFields.length > 0) return `invalid fields: ${badFields.join(', ')} (score ${score})`;
    if (badMatches.length > 0) return `well-formed but mismatched: ${badMatches.join(', ')} (score ${score})`;
    return `valid and matches expectations (score ${score})`;
  });
