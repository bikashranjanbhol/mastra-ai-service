/**
 * `npm run bench` — run the fixed task set against every configured provider
 * and print a comparison table.
 *
 * Exits 0 when the run completes, even if no provider is configured: an
 * unconfigured environment is a reportable state, not a crash. Pass --strict to
 * exit non-zero when nothing ran or any task failed.
 */
import { mastra } from '../src/mastra';
import { runBenchmark } from '../src/bench/runner';
import { renderTable, renderTaskDetail, writeRunArtifact } from '../src/bench/report';
import type { ModelTier } from '../src/mastra/config/models';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const strict = process.argv.includes('--strict');
const tier = (argValue('tier') as ModelTier | undefined) ?? undefined;
const concurrency = argValue('concurrency') ? Number(argValue('concurrency')) : undefined;

const run = await runBenchmark(mastra, { tier, concurrency });

console.log(renderTable(run));
const detail = renderTaskDetail(run);
if (detail) console.log(detail);

const artifact = writeRunArtifact(run);
console.log(`\nresults written to ${artifact}\n`);

if (strict) {
  const ran = run.providers.filter((p) => p.status === 'ran');
  if (ran.length === 0) {
    console.error('bench --strict: no providers configured');
    process.exit(1);
  }
  const failed = ran.flatMap((p) => p.tasks.filter((t) => !t.pass));
  if (failed.length > 0) {
    console.error(`bench --strict: ${failed.length} task(s) failed`);
    process.exit(1);
  }
}

process.exit(0);
