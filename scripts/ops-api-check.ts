/**
 * `npm run check:ops-api` — verify the ops API integration against a stubbed
 * HTTP layer.
 *
 * The real API is internal and not reachable from every environment, so this
 * exercises the parts that are ours: envelope unwrapping, provenance
 * propagation, data-quality detection, error mapping and the approval policy.
 * It proves nothing about the live service — use a contract test for that.
 */
import { parseEnvelope, postOps, OpsApiError, describeApiError } from '../src/mastra/services/ops-api/client';
import { OPS_ENDPOINTS, findEndpoint } from '../src/mastra/services/ops-api/registry';
import { createApiTool } from '../src/mastra/tools/ops-api';
import type { OpsApiConfig } from '../src/mastra/config/ops-api';
import { APPS_SAMPLE, CATALOG_SAMPLE, KPI_GROUPS_SAMPLE, KPI_NAMES_SAMPLE, SEARCH_SAMPLE } from './ops-api-samples';

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

// ── 6b. Matrix path search (paginated) ───────────────────────────────────────
heading('6b. ops_matrix_path_search');
const searchTool = createApiTool(findEndpoint('ops_matrix_path_search')!, {
  config: CONFIG,
  fetchImpl: stubFetch(SEARCH_SAMPLE),
});
const searchOut = (await searchTool.execute!(
  { appGroup: 'Atlas', appRegion: 'Ambient', page: 1, size: 20, sortOrder: 'desc' },
  {} as never,
)) as Record<string, any>;

check('unwraps the row array', Array.isArray(searchOut.rows) && searchOut.rows.length === 2);
check('maps nested metadata to flat fields', searchOut.rows[0].matrixPath === 'Sam Rivera');
check('maps analytics counts', searchOut.rows[0].totalRed === 196 && searchOut.rows[0].totalAmber === 203);
check('surfaces pagination', searchOut.pagination?.totalItems === 488 && searchOut.pagination?.hasNext === true);

// The whole point: thousands of sources must never reach the model.
const serialised = JSON.stringify(searchOut);
check('collapses 1650 sources to a count', searchOut.rows[1].sourceCount === 1650);
check('never emits a sourceId', !serialised.includes('sourceId'), `${serialised.length} chars total`);
check('output stays small despite huge input', serialised.length < 4000, `${serialised.length} chars`);

console.log(`    raw sample: ${JSON.stringify(SEARCH_SAMPLE).length.toLocaleString()} chars`);
console.log(`    projected : ${serialised.length.toLocaleString()} chars`);

// Malformed metadata in this sample must NOT be reported as data loss.
check('string timedOut is not treated as a timeout', !/timed out/.test(String(searchOut.warnings)));
check('incoherent shard block is flagged as unverifiable, not as an undercount',
  String(searchOut.warnings).includes('could not be verified'));

// ── 6c. Filter discovery chain ───────────────────────────────────────────────
heading('6c. filter discovery chain');

const catalogOut = (await createApiTool(findEndpoint('ops_filter_catalog')!, {
  config: CONFIG,
  fetchImpl: stubFetch(CATALOG_SAMPLE),
}).execute!({}, {} as never)) as Record<string, any>;
console.log(`    appGroups: ${catalogOut.appGroups.join(', ')}`);
check('reads the content envelope', catalogOut.totalEntries === 4);
check('excludes inactive rows', !catalogOut.appGroups.includes('Retired Group'));
check('dedupes and sorts groups', catalogOut.appGroups[0] === 'Atlas');
check('keeps regions per area', catalogOut.entries[0].appRegions.includes('Ambient'));

let catalogBody: unknown;
await createApiTool(findEndpoint('ops_filter_catalog')!, {
  config: CONFIG,
  fetchImpl: (async (_u: string, init: RequestInit) => {
    catalogBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify(CATALOG_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch,
}).execute!({}, {} as never);
check('sends the fixed pageSize envelope', JSON.stringify(catalogBody) === '{"pageSize":1000,"pagingState":""}',
  JSON.stringify(catalogBody));

const appsOut = (await createApiTool(findEndpoint('ops_applications')!, {
  config: CONFIG,
  fetchImpl: stubFetch(APPS_SAMPLE),
}).execute!({ appGroup: 'Atlas', appArea: 'Atlas', appRegion: 'Ambient' }, {} as never)) as Record<string, any>;
check('lists application names', appsOut.appNames.join(',') === 'Kafka,Pharmacy');
check('extracts divisions', appsOut.appDivisions.join(',') === 'Pharmacy,RDC');

let appsBody: unknown;
await createApiTool(findEndpoint('ops_applications')!, {
  config: CONFIG,
  fetchImpl: (async (_u: string, init: RequestInit) => {
    appsBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify(APPS_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch,
}).execute!({ appGroup: 'Atlas', appArea: 'Atlas', appRegion: 'Ambient' }, {} as never);
check('uses a FLAT body, not filter.queryParams',
  JSON.stringify(appsBody) === '{"appGroup":"Atlas","appArea":"Atlas","appRegion":"Ambient"}',
  JSON.stringify(appsBody));

const groupsOut = (await createApiTool(findEndpoint('ops_matrix_path_groups')!, {
  config: CONFIG,
  fetchImpl: stubFetch(KPI_GROUPS_SAMPLE),
}).execute!(
  { appGroup: 'Atlas', appArea: 'Atlas', appRegion: 'Ambient', appName: 'Kafka' },
  {} as never,
)) as Record<string, any>;
check('lists matrix path groups', groupsOut.matrixPathGroups.join(',') === 'Alerts');

let namesBody: unknown;
const pathsOut = (await createApiTool(findEndpoint('ops_matrix_paths')!, {
  config: CONFIG,
  fetchImpl: (async (_u: string, init: RequestInit) => {
    namesBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify(KPI_NAMES_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch,
}).execute!(
  { appGroup: 'Atlas', appArea: 'Atlas', appRegion: 'Ambient', appName: 'Kafka', matrixPathGroup: 'Alerts' },
  {} as never,
)) as Record<string, any>;
check('maps kpiName to matrixPath', pathsOut.matrixPaths[0].matrixPath === 'Consumer Lag');
check('keeps platform and owner', pathsOut.matrixPaths[0].primaryOwner === 'Atlas_Ambient_Ops');
check('translates matrixPathGroup back to kpiGroup on the wire',
  (namesBody as Record<string, unknown>).kpiGroup === 'Alerts');

console.log('\n    --- search display ---');
console.log(String(searchOut.display).split('\n').map((l) => `    ${l}`).join('\n'));
console.log('\n    --- catalog display ---');
console.log(String(catalogOut.display).split('\n').slice(0, 9).map((l) => `    ${l}`).join('\n'));

// ── 6d. Error diagnosis ──────────────────────────────────────────────────────
heading('6d. validation errors stay diagnosable');

// A real Spring bean-validation body: the useful part sits far past the
// 200-char mark that the previous implementation truncated at.
const SPRING_400 = JSON.stringify({
  status: 'FAILURE',
  message:
    'Validation failed for argument at index 0 in method: public org.springframework.http.ResponseEntity' +
    '<com.example.ops.dto.ApiResponse<com.example.ops.dto.PagedResult<com.example.ops.dto.AppAreaMaster>>> ' +
    'com.example.ops.controller.OpsMetricsController.byAppGroupAppArea(com.example.ops.dto.PagedRequest), ' +
    "with 1 error(s): [Field error in object 'pagedRequest' on field 'pageSize': rejected value [1000]; " +
    'codes [Max.pagedRequest.pageSize,Max.pageSize,Max.java.lang.Integer,Max]; ' +
    'default message [must be less than or equal to 100]]',
});

const described = describeApiError(SPRING_400);
console.log(`    raw body  : ${SPRING_400.length} chars`);
console.log(`    diagnosed : ${described}`);
check('names the offending field', described.includes('pageSize'));
check('gives the constraint', described.includes('must be less than or equal to 100'));
check('is short enough to read', described.length < 120, `${described.length} chars`);
check('old 200-char truncation would have hidden it', !SPRING_400.slice(0, 200).includes('pageSize'));

const multi = describeApiError(
  JSON.stringify({
    message:
      "with 2 error(s): [Field error in object 'r' on field 'pageSize': rejected value [1000]; " +
      "default message [must be less than or equal to 100]] [Field error in object 'r' on field 'pagingState': " +
      'rejected value []; default message [must not be blank]]',
  }),
);
console.log(`    multi     : ${multi}`);
check('reports every failing field', multi.includes('pageSize') && multi.includes('pagingState'));
check('non-JSON bodies survive', describeApiError('upstream timeout').includes('upstream timeout'));
check('empty body is labelled', describeApiError('').includes('empty'));

// ── 7. Registry hygiene ──────────────────────────────────────────────────────
heading('7. registry hygiene');
const ids = OPS_ENDPOINTS.map((e) => e.id);
check('ids are unique', new Set(ids).size === ids.length);
check('every endpoint declares both schemas', OPS_ENDPOINTS.every((e) => e.inputSchema && e.outputSchema));
check('every description is model-usable', OPS_ENDPOINTS.every((e) => e.description.length > 40));

heading('Result');
console.log(failures.length === 0 ? '  all checks passed\n' : `  ${failures.length} failed: ${failures.join(', ')}\n`);
process.exit(failures.length === 0 ? 0 : 1);
