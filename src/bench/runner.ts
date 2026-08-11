/**
 * Cross-provider benchmark runner.
 *
 * Runs the SAME fixed task set against every configured provider and records
 * pass/fail, latency, tokens, cost and tool calls, plus quality scores from the
 * scorers.
 *
 * Design notes:
 *  - Providers run concurrently (bounded by BENCH_CONCURRENCY); tasks WITHIN a
 *    provider run sequentially, so one provider's rate limit is not amplified.
 *  - Every request pins `fallback: 'off'`, otherwise a failing provider is
 *    rescued by the chain and the table misattributes the result.
 *  - Providers with no key are reported as "not configured", never as failures.
 */
import { RequestContext } from '@mastra/core/request-context';
import type { Mastra } from '@mastra/core/mastra';

import {
  configuredProviderIds,
  getAvailableProviders,
  hasTier,
  toModelString,
  MODEL_CONTEXT_KEYS,
  type ModelTier,
  type ProviderId,
} from '../mastra/config/models';
import { estimateCostUsd } from '../mastra/config/pricing';
import { logModelCall, logger } from '../mastra/config/logger';
import { answerGroundednessScorer, triageValidityScorer } from '../mastra/scorers';
import { BENCH_TASKS, type BenchTask, type ToolCallRecord } from './tasks';

export interface TaskResult {
  taskId: string;
  kind: BenchTask['kind'];
  pass: boolean;
  reason: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
  toolCalls: number;
  toolNames: string[];
  qualityScore?: number;
  qualityReason?: string;
  attempts: number;
  error?: string;
}

export interface ProviderResult {
  provider: ProviderId;
  model: string;
  status: 'ran' | 'not-configured';
  tasks: TaskResult[];
  totals: {
    passed: number;
    total: number;
    latencyMsTotal: number;
    inputTokens: number;
    outputTokens: number;
    estCostUsd?: number;
    toolCalls: number;
    qualityAvg?: number;
  };
}

export interface BenchRun {
  startedAt: string;
  finishedAt: string;
  tier: ModelTier;
  taskIds: string[];
  providers: ProviderResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry / rate limiting
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE = /\b(429|too many requests|rate.?limit|overloaded|503|502|504|timeout|ETIMEDOUT|ECONNRESET)\b/i;

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { status?: unknown }).status ?? '')}` : String(err);
  return RETRYABLE.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, honouring an explicit retry-after when present. */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, label: string): Promise<{ value: T; attempts: number }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt > maxRetries || !isRetryable(err)) break;

      const retryAfter = Number((err as { retryAfter?: unknown })?.retryAfter);
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** (attempt - 1) * 1000;
      const jittered = Math.min(backoff + Math.random() * 500, 30_000);
      logger.warn('bench retrying after retryable error', {
        label,
        attempt,
        waitMs: Math.round(jittered),
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      await sleep(jittered);
    }
  }
  throw lastErr;
}

/** Bounded-concurrency map that preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractToolCalls(result: unknown): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  const r = result as {
    toolCalls?: Array<Record<string, unknown>>;
    steps?: Array<{ toolCalls?: Array<Record<string, unknown>> }>;
  };

  const push = (c: Record<string, unknown>) => {
    const toolName = (c.toolName ?? c.name ?? c.tool) as string | undefined;
    if (toolName) calls.push({ toolName, args: (c.args ?? c.input ?? {}) as Record<string, unknown> });
  };

  if (Array.isArray(r?.toolCalls)) r.toolCalls.forEach(push);
  // Multi-step runs carry tool calls per step.
  if (Array.isArray(r?.steps)) {
    for (const step of r.steps) if (Array.isArray(step?.toolCalls)) step.toolCalls.forEach(push);
  }

  // De-duplicate: some shapes surface the same call at both levels.
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = `${c.toolName}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collect the passage ids the search tool actually RETURNED.
 *
 * Read from tool *results*, not tool call args — args carry the query, not the
 * passages. Deliberately never reads the model's final text, otherwise a
 * fabricated citation would validate itself.
 */
function extractRetrievedDocIds(result: unknown): string[] {
  const ids = new Set<string>();
  const r = result as {
    toolResults?: Array<Record<string, unknown>>;
    steps?: Array<{ toolResults?: Array<Record<string, unknown>> }>;
  };

  const harvest = (entry: Record<string, unknown>) => {
    const payload = (entry.result ?? entry.output ?? entry) as { results?: unknown };
    if (Array.isArray(payload?.results)) {
      for (const item of payload.results) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id === 'string') ids.add(id);
      }
    }
  };

  if (Array.isArray(r?.toolResults)) r.toolResults.forEach(harvest);
  if (Array.isArray(r?.steps)) {
    for (const step of r.steps) if (Array.isArray(step?.toolResults)) step.toolResults.forEach(harvest);
  }
  return [...ids];
}

async function scoreQuality(
  task: BenchTask,
  ctx: { text: string; object: unknown; toolCalls: ToolCallRecord[]; retrievedDocIds: string[] },
): Promise<{ score?: number; reason?: string }> {
  try {
    if (task.kind === 'structured-output') {
      const res = await triageValidityScorer.run({
        input: {
          expectedSeverity: task.expectedTriage?.severity,
          expectedTeam: task.expectedTriage?.team,
          expectedNeedsHuman: task.expectedTriage?.needsHuman,
        },
        output: (ctx.object ?? {}) as Record<string, unknown>,
      });
      return { score: res.score, reason: res.reason };
    }

    // When no tool ran, nothing was retrieved — so any citation is fabricated
    // and the scorer should say so, rather than being handed the answer key.
    const retrievedDocIds = ctx.retrievedDocIds;

    const res = await answerGroundednessScorer.run({
      input: { retrievedDocIds, expectedDocIds: task.expectedDocIds ?? [] },
      output: { text: ctx.text },
    });
    return { score: res.score, reason: res.reason };
  } catch (err) {
    return { reason: `scorer error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

async function runTask(
  mastra: Mastra,
  provider: ProviderId,
  tier: ModelTier,
  task: BenchTask,
  maxRetries: number,
): Promise<TaskResult> {
  const modelString = toModelString(provider, tier);
  const started = Date.now();

  const requestContext = new RequestContext([
    [MODEL_CONTEXT_KEYS.provider, provider],
    [MODEL_CONTEXT_KEYS.tier, tier],
    // Pin: no silent failover, so this row describes THIS provider.
    [MODEL_CONTEXT_KEYS.fallback, 'off'],
  ]);

  try {
    const { value: result, attempts } = await withRetry(
      async () => {
        const agent = mastra.getAgent(task.agent);
        // Two explicit call sites: a conditionally-spread `structuredOutput`
        // widens to `T | undefined` and fails overload resolution.
        return task.schema
          ? agent.generate(task.prompt, { requestContext, structuredOutput: { schema: task.schema } })
          : agent.generate(task.prompt, { requestContext });
      },
      maxRetries,
      `${provider}/${task.id}`,
    );

    const latencyMs = Date.now() - started;
    const r = result as { text?: string; object?: unknown; usage?: { inputTokens?: number; outputTokens?: number } };
    const text = r.text ?? '';
    const object = r.object;
    const toolCalls = extractToolCalls(result);
    const retrievedDocIds = extractRetrievedDocIds(result);

    const graded = task.grade({ text, object, toolCalls });
    const quality = await scoreQuality(task, { text, object, toolCalls, retrievedDocIds });

    const inputTokens = r.usage?.inputTokens;
    const outputTokens = r.usage?.outputTokens;

    logModelCall(graded.pass ? 'ok' : 'error', {
      provider,
      model: modelString,
      task: task.id,
      latencyMs,
      pass: graded.pass,
    });

    return {
      taskId: task.id,
      kind: task.kind,
      pass: graded.pass,
      reason: graded.reason,
      latencyMs,
      inputTokens,
      outputTokens,
      estCostUsd: estimateCostUsd(modelString, inputTokens, outputTokens),
      toolCalls: toolCalls.length,
      toolNames: [...new Set(toolCalls.map((c) => c.toolName))],
      qualityScore: quality.score,
      qualityReason: quality.reason,
      attempts,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    logModelCall('error', { provider, model: modelString, task: task.id, latencyMs, error: message.slice(0, 300) });
    return {
      taskId: task.id,
      kind: task.kind,
      pass: false,
      reason: 'request failed',
      latencyMs,
      toolCalls: 0,
      toolNames: [],
      attempts: maxRetries + 1,
      error: message.slice(0, 300),
    };
  }
}

function summarise(provider: ProviderId, model: string, tasks: TaskResult[]): ProviderResult {
  const costs = tasks.map((t) => t.estCostUsd).filter((c): c is number => typeof c === 'number');
  const quality = tasks.map((t) => t.qualityScore).filter((q): q is number => typeof q === 'number');

  return {
    provider,
    model,
    status: 'ran',
    tasks,
    totals: {
      passed: tasks.filter((t) => t.pass).length,
      total: tasks.length,
      latencyMsTotal: tasks.reduce((a, t) => a + t.latencyMs, 0),
      inputTokens: tasks.reduce((a, t) => a + (t.inputTokens ?? 0), 0),
      outputTokens: tasks.reduce((a, t) => a + (t.outputTokens ?? 0), 0),
      estCostUsd: costs.length > 0 ? costs.reduce((a, c) => a + c, 0) : undefined,
      toolCalls: tasks.reduce((a, t) => a + t.toolCalls, 0),
      qualityAvg: quality.length > 0 ? Number((quality.reduce((a, q) => a + q, 0) / quality.length).toFixed(3)) : undefined,
    },
  };
}

export interface RunOptions {
  tier?: ModelTier;
  concurrency?: number;
  maxRetries?: number;
  tasks?: readonly BenchTask[];
}

export async function runBenchmark(mastra: Mastra, opts: RunOptions = {}): Promise<BenchRun> {
  const tier = opts.tier ?? ((process.env.BENCH_TIER as ModelTier | undefined) || 'fast');
  const concurrency = opts.concurrency ?? Number(process.env.BENCH_CONCURRENCY ?? 3);
  const maxRetries = opts.maxRetries ?? Number(process.env.BENCH_MAX_RETRIES ?? 3);
  const tasks = opts.tasks ?? BENCH_TASKS;

  const startedAt = new Date().toISOString();
  const availability = getAvailableProviders();
  const configured = configuredProviderIds();

  // Providers without a key are reported, never run, never counted as failures.
  const skipped: ProviderResult[] = availability
    .filter((p) => !p.configured)
    .map((p) => ({
      provider: p.id,
      model: toModelString(p.id, hasTier(p.id, tier) ? tier : 'flagship'),
      status: 'not-configured' as const,
      tasks: [],
      totals: { passed: 0, total: 0, latencyMsTotal: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    }));

  const ran = await mapLimit(configured, concurrency, async (provider) => {
    const effectiveTier: ModelTier = hasTier(provider, tier) ? tier : 'flagship';
    const model = toModelString(provider, effectiveTier);
    logger.info('bench provider starting', { provider, model, tasks: tasks.length });

    // Sequential within a provider: keeps us inside per-key rate limits.
    const results: TaskResult[] = [];
    for (const task of tasks) {
      results.push(await runTask(mastra, provider, effectiveTier, task, maxRetries));
    }
    return summarise(provider, model, results);
  });

  // Preserve registry order in the report.
  const order = availability.map((a) => a.id);
  const providers = [...ran, ...skipped].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    tier,
    taskIds: tasks.map((t) => t.id),
    providers,
  };
}
