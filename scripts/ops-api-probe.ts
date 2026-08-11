/**
 * `npm run probe:ops-api` — diagnose a rejected request against the REAL API.
 *
 * Run this when an endpoint returns 400. It posts a set of body variants and
 * reports, for each, the HTTP status and the extracted validation message, so
 * the correct request shape is determined by the server rather than guessed.
 *
 *   npm run probe:ops-api -- catalog
 *   npm run probe:ops-api -- search --appGroup Atlas
 *
 * Requires OPS_API_BASE_URL. Read-only: every variant is a GET-equivalent
 * lookup, nothing here mutates state.
 */
import { buildHeaders, resolveOpsApiConfig } from '../src/mastra/config/ops-api';
import { describeApiError } from '../src/mastra/services/ops-api/client';

interface Variant {
  label: string;
  body: unknown;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const target = process.argv[2] ?? 'catalog';
const appGroup = argValue('appGroup') ?? 'Atlas';
const appArea = argValue('appArea') ?? 'Atlas';
const appRegion = argValue('appRegion') ?? 'Ambient';

const SUITES: Record<string, { path: string; variants: Variant[] }> = {
  catalog: {
    path: '/opensearch-api/ops-metrics/red-amber/by-appgroup-apparea',
    variants: [
      { label: 'as documented (pagingState: "")', body: { pageSize: 1000, pagingState: '' } },
      { label: 'pagingState omitted', body: { pageSize: 1000 } },
      { label: 'pagingState: null', body: { pageSize: 1000, pagingState: null } },
      { label: 'smaller pageSize (100)', body: { pageSize: 100, pagingState: '' } },
      { label: 'smaller pageSize, omitted state', body: { pageSize: 100 } },
      { label: 'empty body', body: {} },
      { label: 'wrapped in filter envelope', body: { filter: { queryParams: {} }, pagination: { pageSize: 1000 } } },
    ],
  },
  search: {
    path: '/ops/live-summary/search',
    variants: [
      {
        label: 'as documented',
        body: { filter: { queryParams: { appGroup } }, pagination: { page: 1, size: 100, sortOrder: 'desc' } },
      },
      { label: 'pagination omitted', body: { filter: { queryParams: { appGroup } } } },
      { label: 'empty pagination', body: { filter: { queryParams: { appGroup } }, pagination: {} } },
    ],
  },
  apps: {
    path: '/ct-apis/kpi-data-app-master/fetch-active-apps',
    variants: [
      { label: 'flat body (as documented)', body: { appGroup, appArea, appRegion } },
      { label: 'wrapped in filter envelope', body: { filter: { queryParams: { appGroup, appArea, appRegion } } } },
    ],
  },
};

const suite = SUITES[target];
if (!suite) {
  console.error(`Unknown target "${target}". Choose one of: ${Object.keys(SUITES).join(', ')}`);
  process.exit(1);
}

const config = resolveOpsApiConfig();
const url = `${config.baseUrl}${suite.path}`;

console.log(`\nProbing ${suite.path}`);
console.log(`against ${config.baseUrl}`);
console.log('─'.repeat(78));

let firstSuccess: Variant | undefined;

for (const variant of suite.variants) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(variant.body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await res.text().catch(() => '');
    const ms = Date.now() - started;

    if (res.ok) {
      console.log(`\n✅ ${res.status}  ${variant.label}  (${ms}ms)`);
      console.log(`   body sent: ${JSON.stringify(variant.body)}`);
      console.log(`   response : ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`);
      firstSuccess ??= variant;
    } else {
      console.log(`\n❌ ${res.status}  ${variant.label}  (${ms}ms)`);
      console.log(`   body sent: ${JSON.stringify(variant.body)}`);
      console.log(`   reason   : ${describeApiError(text)}`);
    }
  } catch (err) {
    console.log(`\n⚠️  ${variant.label} — request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${'─'.repeat(78)}`);
if (firstSuccess) {
  console.log(`Accepted shape: ${firstSuccess.label}`);
  console.log(`  ${JSON.stringify(firstSuccess.body)}`);
  console.log('\nUpdate the endpoint\'s buildRequest() in src/mastra/services/ops-api/endpoints/ to match.');
} else {
  console.log('No variant was accepted. Paste the reasons above and the request shape can be corrected.');
}
console.log();
