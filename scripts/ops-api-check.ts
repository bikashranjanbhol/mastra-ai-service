/**
 * `npm run check:ops-api` — verify the ops API integration against a stubbed
 * HTTP layer.
 *
 * The real API is internal and not reachable from every environment, so this
 * exercises the parts that are ours: envelope unwrapping, provenance
 * propagation, data-quality detection, error mapping and the approval policy.
 * It proves nothing about the live service — use a contract test for that.
 */
import { parseEnvelope, postOps, OpsApiError } from '../src/mastra/services/ops-api/client';
import { OPS_ENDPOINTS, findEndpoint } from '../src/mastra/services/ops-api/registry';
import { createApiTool } from '../src/mastra/tools/ops-api';
import type { OpsApiConfig } from '../src/mastra/config/ops-api';

const CONFIG: OpsApiConfig = { baseUrl: 'https://ops.test', timeoutMs: 5000, maxRetries: 0 };

const failures: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}
function heading(t: string) {
  console.log(`\n${t}\n${'─'.repeat(t.length)}`);
}

/** The exact payload supplied for this endpoint. */
const REAL_SAMPLE = {
  status: 'SUCCESS',
  message: 'Data fetched successfully',
  timestamp: 1786447577711,
  data: {
    data: {
      data: { red: 1492, amber: 804, totalAlerts: 2296, totalPaths: 5 },
      appliedFilters: { appGroup: 'Atlas', appArea: 'Atlas' },
      metadata: {
        executionTimeMs: 438,
        indexName: 'ct_ops_live_summary_v1',
        queryType: 'METRICS',
        totalHits: 5,
        timedOut: false,
        shards: { total: 3, successful: 3, failed: 0 },
      },
    },
    pagination: null,
    metadata: {
      executionTimeMs: 438,
      indexName: 'ct_ops_live_summary_v1',
      queryType: 'METRICS',
      totalHits: 5,
      timedOut: false,
      shards: { total: 3, successful: 3, failed: 0 },
    },
    additionalInfo: null,
  },
  error: null,
};

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

// ── 1. Envelope unwrapping on the real sample ────────────────────────────────
heading('1. envelope unwrapping (verbatim sample payload)');
const parsed = parseEnvelope<Record<string, number>>(REAL_SAMPLE, '/x');
console.log(`  payload: ${JSON.stringify(parsed.payload)}`);
check('reaches data.data.data', parsed.payload?.red === 1492 && parsed.payload?.totalPaths === 5);
check('captures appliedFilters', parsed.appliedFilters.appGroup === 'Atlas' && parsed.appliedFilters.appArea === 'Atlas');
check('captures metadata', parsed.metadata.indexName === 'ct_ops_live_summary_v1');
check('healthy response is not flagged partial', parsed.quality.partial === false);

// ── 2. Varying nest depth ────────────────────────────────────────────────────
heading('2. tolerates a different nesting depth');
const twoLevel = { status: 'SUCCESS', error: null, data: { data: { red: 7, amber: 2 }, appliedFilters: { appGroup: 'B' } } };
const shallow = parseEnvelope<Record<string, number>>(twoLevel, '/x');
check('two-level envelope unwraps', shallow.payload?.red === 7, JSON.stringify(shallow.payload));
check('appliedFilters still found', shallow.appliedFilters.appGroup === 'B');

// ── 3. Silent data loss ──────────────────────────────────────────────────────
heading('3. partial data is detected (200 OK, wrong numbers)');
const degraded = structuredClone(REAL_SAMPLE);
degraded.data.data.metadata.shards = { total: 3, successful: 2, failed: 1 };
const deg = parseEnvelope(degraded, '/x');
check('failed shard flags partial', deg.quality.partial === true);
check('warning explains undercount', /undercount/.test(deg.quality.warnings.join(' ')), deg.quality.warnings[0]);

const timedOut = structuredClone(REAL_SAMPLE);
timedOut.data.data.metadata.timedOut = true;
check('timeout flags partial', parseEnvelope(timedOut, '/x').quality.partial === true);

// ── 4. Error mapping ─────────────────────────────────────────────────────────
heading('4. error mapping');
try {
  parseEnvelope({ status: 'FAILURE', message: 'index unavailable', error: 'boom', data: null }, '/x');
  check('non-SUCCESS status throws', false);
} catch (e) {
  check('non-SUCCESS status throws', e instanceof OpsApiError, (e as Error).message.slice(0, 70));
}
try {
  parseEnvelope({ status: 'SUCCESS', error: { code: 500 }, data: {} }, '/x');
  check('non-null error throws', false);
} catch (e) {
  check('non-null error throws', e instanceof OpsApiError);
}
try {
  await postOps('/x', {}, { config: CONFIG, fetchImpl: stubFetch({ msg: 'nope' }, 503) });
  check('HTTP 503 throws', false);
} catch (e) {
  check('HTTP 503 throws', e instanceof OpsApiError, (e as Error).message.slice(0, 60));
}

// ── 5. The generated tool end to end ─────────────────────────────────────────
heading('5. generated tool');
const endpoint = findEndpoint('ops_red_amber_overall')!;
const tool = createApiTool(endpoint, { config: CONFIG, fetchImpl: stubFetch(REAL_SAMPLE) });

const out = (await tool.execute!({ appGroup: 'Atlas', appArea: 'Atlas' }, {} as never)) as Record<string, unknown>;
console.log(`  tool output: ${JSON.stringify(out)}`);
check('projects the four metrics', out.red === 1492 && out.amber === 804 && out.totalAlerts === 2296);
check('surfaces appliedFilters to the model', JSON.stringify(out.appliedFilters).includes('Atlas'));
check('surfaces partialData flag', out.partialData === false);
check('drops diagnostics from model output', !('executionTimeMs' in out) && !('indexName' in out));
check('output matches declared schema', endpoint.outputSchema.safeParse(out).success);

// Request envelope shape
let captured: unknown;
const capturing = createApiTool(endpoint, {
  config: CONFIG,
  fetchImpl: (async (_u: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify(REAL_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch,
});
await capturing.execute!({ appGroup: 'Atlas' }, {} as never);
console.log(`  request body: ${JSON.stringify(captured)}`);
const body = captured as { filter?: { queryParams?: Record<string, unknown> }; pagination?: unknown };
check('builds filter.queryParams envelope', body.filter?.queryParams?.appGroup === 'Atlas');
check('omits absent optional filter', !('appArea' in (body.filter?.queryParams ?? {})));
check('includes pagination block', body.pagination !== undefined);

// ── 5b. Deterministic display block ──────────────────────────────────────────
heading('5b. rendered display block');
const display = String(out.display ?? '');
console.log(display.split('\n').map((l) => `    ${l}`).join('\n'));
check('is a markdown table', display.includes('| Metric | Count |'));
check('formats thousands separators', display.includes('1,492'), 'raw 1492 would read poorly');
check('includes every metric', ['🔴 Red', '🟡 Amber', 'Total alerts', 'Paths affected'].every((l) => display.includes(l)));
check('emphasises the total', display.includes('| **Total alerts** | **2,296** |'));
check('states applied filters', /Filters applied:.*appGroup: Atlas/.test(display));
check('healthy result carries no warning banner', !display.includes('⚠️'));

const partialTool = createApiTool(endpoint, {
  config: CONFIG,
  fetchImpl: stubFetch(
    (() => {
      const s = structuredClone(REAL_SAMPLE);
      s.data.data.metadata.shards = { total: 3, successful: 2, failed: 1 };
      return s;
    })(),
  ),
});
const partialOut = (await partialTool.execute!({ appGroup: 'Atlas' }, {} as never)) as Record<string, unknown>;
const partialDisplay = String(partialOut.display ?? '');
console.log(`\n    --- partial-data variant ---`);
console.log(partialDisplay.split('\n').slice(-3).map((l) => `    ${l}`).join('\n'));
check('partial result renders a warning banner', partialDisplay.includes('⚠️'));
check('warning banner says lower bounds', /lower bounds/i.test(partialDisplay));
check('warning text is included', /shards failed/.test(partialDisplay));

// ── 6. Approval policy ───────────────────────────────────────────────────────
heading('6. approval policy');
check('read endpoint does not require approval', (tool as { requireApproval?: unknown }).requireApproval === false);
const writeTool = createApiTool({ ...endpoint, id: 'ops_write_probe', kind: 'write' });
check('write endpoint requires approval', (writeTool as { requireApproval?: unknown }).requireApproval === true);

// ── 7. Registry hygiene ──────────────────────────────────────────────────────
heading('7. registry hygiene');
const ids = OPS_ENDPOINTS.map((e) => e.id);
check('ids are unique', new Set(ids).size === ids.length);
check('every endpoint declares both schemas', OPS_ENDPOINTS.every((e) => e.inputSchema && e.outputSchema));
check('every description is model-usable', OPS_ENDPOINTS.every((e) => e.description.length > 40));

heading('Result');
console.log(failures.length === 0 ? '  all checks passed\n' : `  ${failures.length} failed: ${failures.join(', ')}\n`);
process.exit(failures.length === 0 ? 0 : 1);
