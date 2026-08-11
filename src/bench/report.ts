/**
 * Benchmark reporting: the comparison table and the timestamped JSON artifact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatCost, hasAnyRates } from '../mastra/config/pricing';
import type { BenchRun, ProviderResult } from './runner';

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}
function padLeft(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padStart(width);
}

const COLUMNS: Array<[string, number]> = [
  ['provider', 11],
  ['model', 34],
  ['pass/fail', 14],
  ['latency', 9],
  ['tok in/out', 13],
  ['est. cost', 11],
  ['tools', 6],
  ['quality', 8],
];

function row(cells: string[]): string {
  return cells
    .map((c, i) => {
      const [, width] = COLUMNS[i]!;
      // Numeric columns right-align.
      return i >= 3 && i !== 8 ? padLeft(c, width) : pad(c, width);
    })
    .join('  ');
}

function providerRow(p: ProviderResult): string {
  if (p.status === 'not-configured') {
    return row([p.provider, p.model, 'not configured', '—', '—', '—', '—', '—']);
  }
  const t = p.totals;
  return row([
    p.provider,
    p.model,
    `${t.passed}/${t.total}`,
    `${(t.latencyMsTotal / 1000).toFixed(1)}s`,
    `${t.inputTokens}/${t.outputTokens}`,
    formatCost(t.estCostUsd),
    String(t.toolCalls),
    t.qualityAvg === undefined ? 'n/a' : t.qualityAvg.toFixed(2),
  ]);
}

export function renderTable(run: BenchRun): string {
  const header = row(COLUMNS.map(([name]) => name));
  const rule = '─'.repeat(header.length);
  const lines = [
    '',
    `Cross-provider benchmark — tier "${run.tier}", ${run.taskIds.length} tasks`,
    `started ${run.startedAt}`,
    '',
    header,
    rule,
    ...run.providers.map(providerRow),
    rule,
  ];

  const ranCount = run.providers.filter((p) => p.status === 'ran').length;
  const skipCount = run.providers.length - ranCount;
  lines.push(`${ranCount} provider(s) ran, ${skipCount} not configured`);
  if (!hasAnyRates()) {
    lines.push('est. cost is "n/a" — no token rates configured (see src/mastra/config/pricing.ts)');
  }
  return lines.join('\n');
}

/** Per-task breakdown for the providers that ran. */
export function renderTaskDetail(run: BenchRun): string {
  const ran = run.providers.filter((p) => p.status === 'ran');
  if (ran.length === 0) return '';

  const lines = ['', 'Per-task detail', '─'.repeat(78)];
  for (const p of ran) {
    lines.push(`\n${p.provider}  (${p.model})`);
    for (const t of p.tasks) {
      const mark = t.pass ? 'PASS' : 'FAIL';
      const q = t.qualityScore === undefined ? '' : `  quality ${t.qualityScore}`;
      lines.push(`  ${mark}  ${pad(t.taskId, 26)} ${padLeft(`${t.latencyMs}ms`, 8)}  ${t.reason}${q}`);
      if (t.error) lines.push(`        error: ${t.error}`);
      if (t.attempts > 1) lines.push(`        attempts: ${t.attempts} (retried)`);
    }
  }
  return lines.join('\n');
}

/** Write a timestamped JSON artifact so runs are comparable over time. */
export function writeRunArtifact(run: BenchRun, outDir = process.env.BENCH_OUT_DIR ?? './bench-results'): string {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const stamp = run.startedAt.replace(/[:.]/g, '-');
  const file = join(dir, `bench-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}
