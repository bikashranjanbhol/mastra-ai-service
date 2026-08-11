/**
 * `npm run bench:selftest` — verify the benchmark HARNESS without provider keys.
 *
 * Drives the real runner, graders, scorers and reporter with a stubbed agent,
 * so the parts that only execute when a provider responds are actually
 * exercised: grading, tool-call extraction, quality scoring, 429 retry with
 * backoff, bounded concurrency, table rendering and the JSON artifact.
 *
 * This proves the harness. It says nothing about any real provider — those
 * numbers only appear when `npm run bench` runs with keys present.
 */
import type { Mastra } from '@mastra/core/mastra';
import { runBenchmark } from '../src/bench/runner';
import { renderTable, renderTaskDetail } from '../src/bench/report';
import { BENCH_TASKS } from '../src/bench/tasks';

// Pretend three providers are configured. Values are placeholders; no network
// call is made because the agent is stubbed.
process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
process.env.ANTHROPIC_API_KEY = 'test-only-not-a-real-key';
process.env.GROQ_API_KEY = 'test-only-not-a-real-key';
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.MISTRAL_API_KEY;
delete process.env.OPENROUTER_API_KEY;
process.env.BENCH_MAX_RETRIES = '3';

/** Canned good answers, keyed by task id. */
const GOOD_TEXT: Record<string, string> = {
  'tool-search-expense': 'Meals are reimbursed up to 75 USD per day while travelling (expenses-001).',
  'tool-search-severity': 'A SEV1 is complete loss of a customer-facing service or confirmed data loss (incident-001).',
  'tool-abstain': 'The documentation does not cover pets in the office, so I cannot answer from policy.',
  'qa-retention': 'Customer data is retained for 24 months after account closure (security-002).',
};

const GOOD_OBJECT: Record<string, unknown> = {
  'structured-triage-outage': {
    summary: 'Checkout service returning 500s for all customers',
    severity: 'sev1',
    team: 'platform',
    needsHuman: true,
    topics: ['outage', 'checkout'],
  },
  'structured-triage-question': {
    summary: 'Asks what the expense receipt threshold is',
    severity: 'sev3',
    team: 'finance',
    needsHuman: false,
    topics: ['expenses', 'policy'],
  },
};

/** Doc ids the search tool would have returned for each task. */
const RETRIEVED: Record<string, string[]> = {
  'tool-search-expense': ['expenses-001', 'expenses-002'],
  'tool-search-severity': ['incident-001'],
  'tool-abstain': [],
  'qa-retention': ['security-002'],
};

type Behaviour = 'good' | 'degraded' | 'flaky';

let flakyCallCount = 0;

function buildResult(taskId: string, behaviour: Behaviour) {
  const task = BENCH_TASKS.find((t) => t.id === taskId)!;
  const isStructured = task.kind === 'structured-output';

  // "degraded" simulates the classic cross-provider divergences: skipping the
  // tool call, and emitting a severity outside the enum.
  if (behaviour === 'degraded') {
    if (isStructured) {
      return {
        text: '',
        object: { ...(GOOD_OBJECT[taskId] as Record<string, unknown>), severity: 'critical' },
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 300, outputTokens: 60 },
      };
    }
    return {
      text: GOOD_TEXT[taskId]?.replace(/\s*\([a-z-]+-\d+\)/, '') ?? '',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 280, outputTokens: 55 },
    };
  }

  const retrieved = RETRIEVED[taskId] ?? [];
  // A healthy docs agent always searches first — including the abstain case,
  // where the search legitimately comes back empty.
  const callsTool = task.agent === 'docsAgent';

  return {
    text: isStructured ? '' : (GOOD_TEXT[taskId] ?? ''),
    object: isStructured ? GOOD_OBJECT[taskId] : undefined,
    toolCalls: callsTool ? [{ toolName: 'search_docs', args: { query: task.prompt, limit: 3 } }] : [],
    toolResults: callsTool
      ? [{ toolName: 'search_docs', result: { results: retrieved.map((id) => ({ id })), matched: retrieved.length } }]
      : [],
    usage: { inputTokens: 420, outputTokens: 85 },
  };
}

/** Minimal Mastra stub: only getAgent is reached by the runner. */
function makeStub(behaviourFor: (provider: string) => Behaviour): Mastra {
  return {
    getAgent() {
      return {
        async generate(_prompt: string, options: { requestContext?: { get(k: string): unknown } }) {
          const provider = String(options.requestContext?.get('provider') ?? 'unknown');
          const behaviour = behaviourFor(provider);

          // Identify the task by matching the prompt.
          const taskId = BENCH_TASKS.find((t) => t.prompt === _prompt)?.id ?? BENCH_TASKS[0]!.id;

          // Simulate a rate limit that clears after two attempts.
          if (behaviour === 'flaky' && taskId === 'tool-search-expense' && flakyCallCount < 2) {
            flakyCallCount++;
            const err = new Error('429 Too Many Requests — rate limit exceeded');
            (err as { retryAfter?: number }).retryAfter = 0.05;
            throw err;
          }

          await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
          return buildResult(taskId, behaviour === 'flaky' ? 'good' : behaviour);
        },
      };
    },
  } as unknown as Mastra;
}

const stub = makeStub((provider) => {
  if (provider === 'anthropic') return 'degraded';
  if (provider === 'groq') return 'flaky';
  return 'good';
});

console.log('Running benchmark harness against a STUBBED agent (no network calls).');
console.log('openai = healthy, anthropic = degraded, groq = rate-limited then recovers.\n');

const run = await runBenchmark(stub, { tier: 'fast', concurrency: 3 });

console.log(renderTable(run));
console.log(renderTaskDetail(run));

// ── Assertions on the harness itself ─────────────────────────────────────────
const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const byProvider = Object.fromEntries(run.providers.map((p) => [p.provider, p]));

check('healthy provider passes every task', byProvider.openai?.totals.passed === BENCH_TASKS.length);
check('degraded provider is not rescued by fallback', (byProvider.anthropic?.totals.passed ?? 99) < BENCH_TASKS.length);
check(
  'invalid enum value is caught by the structured-output grader',
  byProvider.anthropic?.tasks.some((t) => t.taskId === 'structured-triage-outage' && !t.pass) === true,
);
check(
  'missing tool call is caught by the tool-calling grader',
  byProvider.anthropic?.tasks.some((t) => t.taskId === 'tool-search-expense' && /did not call/.test(t.reason)) === true,
);
check('429 was retried and eventually succeeded', (byProvider.groq?.tasks.find((t) => t.taskId === 'tool-search-expense')?.attempts ?? 0) > 1);
check('unconfigured providers reported, not failed', run.providers.filter((p) => p.status === 'not-configured').length === 3);
check('tool calls counted', (byProvider.openai?.totals.toolCalls ?? 0) > 0);
check('quality scored', typeof byProvider.openai?.totals.qualityAvg === 'number');
check(
  'degraded provider scores lower on quality than healthy',
  (byProvider.anthropic?.totals.qualityAvg ?? 1) < (byProvider.openai?.totals.qualityAvg ?? 0),
);

console.log(failures.length === 0 ? '\nharness self-test: all checks passed\n' : `\nharness self-test: ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
