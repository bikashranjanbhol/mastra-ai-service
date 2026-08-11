/**
 * Ops metrics endpoints: aggregate red/amber counts, and the paginated
 * matrix-path (KPI) search.
 */
import { z } from 'zod';
import {
  defineEndpoint,
  opsRequestEnvelope,
  paginationSchema,
  provenance,
  provenanceSchema,
  readPagination,
  renderDisplay,
  renderRowsTable,
} from '../types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

// ─────────────────────────────────────────────────────────────────────────────
// Overall red / amber counts
// ─────────────────────────────────────────────────────────────────────────────

export const redAmberOverall = defineEndpoint({
  id: 'ops_red_amber_overall',
  path: '/opensearch-api/ops-metrics/red-amber/overall',
  kind: 'read',
  description:
    'Get overall red and amber operational alert counts for an application group, optionally narrowed to an ' +
    'application area. Use for questions about how many red or amber alerts exist, the total alert volume, or ' +
    'how many paths are affected. Requires an application group; use ops_filter_catalog first if the user has ' +
    'not named one.',
  inputSchema: z.object({
    appGroup: z.string().min(1).describe('Application group, e.g. "Atlas"'),
    appArea: z.string().min(1).optional().describe('Optional application area to narrow the query'),
  }),
  outputSchema: z
    .object({
      red: z.number().int().describe('Count of red alerts'),
      amber: z.number().int().describe('Count of amber alerts'),
      totalAlerts: z.number().int(),
      totalPaths: z.number().int().describe('Number of matrix paths covered by these counts'),
    })
    .merge(provenanceSchema),
  buildRequest: (input) => opsRequestEnvelope({ appGroup: input.appGroup, appArea: input.appArea }),
  project: (payload, ctx) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const metrics = {
      red: num(p.red),
      amber: num(p.amber),
      totalAlerts: num(p.totalAlerts),
      totalPaths: num(p.totalPaths),
    };
    const scope = [ctx.appliedFilters.appGroup, ctx.appliedFilters.appArea].filter(Boolean).join(' / ') || 'All';

    return {
      ...metrics,
      ...provenance(ctx),
      display: renderDisplay(
        `Red / amber alerts — ${scope}`,
        [
          { label: '🔴 Red', value: metrics.red },
          { label: '🟡 Amber', value: metrics.amber },
          { label: 'Total alerts', value: metrics.totalAlerts, emphasis: true },
          { label: 'Paths affected', value: metrics.totalPaths },
        ],
        ctx,
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix path search (paginated)
// ─────────────────────────────────────────────────────────────────────────────

const matrixPathSchema = z.object({
  appName: z.string().optional(),
  appGroup: z.string().optional(),
  appArea: z.string().optional(),
  appRegion: z.string().optional(),
  matrixPath: z.string().optional().describe('The KPI name — a matrix path'),
  matrixPathGroup: z.string().optional().describe('The KPI group'),
  status: z.string().optional(),
  totalAlerts: z.number().int(),
  totalRed: z.number().int(),
  totalAmber: z.number().int(),
  totalOccurrences: z.number().int(),
  /**
   * COUNT of entries in multiSourceMetricData, never the entries themselves —
   * a single row in this API can carry thousands of them.
   */
  sourceCount: z.number().int().describe('Number of underlying metric sources'),
});

/** Rows can carry thousands of sources; only their shape is ever summarised. */
function summariseSources(statusMasterInfo: Record<string, unknown>): number {
  const sources = statusMasterInfo.multiSourceMetricData;
  return Array.isArray(sources) ? sources.length : 0;
}

export const liveSummarySearch = defineEndpoint({
  id: 'ops_matrix_path_search',
  path: '/ops/live-summary/search',
  kind: 'read',
  paginated: true,
  description:
    'Search and filter individual matrix paths (KPIs) and their alert counts. Use when the user wants the ' +
    'breakdown per matrix path rather than a single total — for example "which paths are red", "show me the ' +
    'Kafka alerts", or any request naming an application, region or division. Application group is required; ' +
    'every other filter is optional and narrows the result. Results are paginated.',
  inputSchema: z.object({
    appGroup: z.string().min(1).describe('Application group (required), e.g. "Atlas"'),
    appArea: z.string().min(1).optional().describe('Application area, e.g. "Atlas"'),
    appRegion: z.string().min(1).optional().describe('Application region, e.g. "Ambient"'),
    appName: z.string().min(1).optional().describe('Application name, e.g. "Kafka"'),
    appDivision: z.string().min(1).optional().describe('Application division, e.g. "RDC"'),
    page: z.number().int().min(1).default(1).describe('1-based page number'),
    size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Rows per page. Keep small; large pages waste context for little gain.'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
  outputSchema: z
    .object({
      rows: z.array(matrixPathSchema),
      returned: z.number().int().describe('Rows on this page'),
      pagination: paginationSchema,
    })
    .merge(provenanceSchema),
  buildRequest: (input) =>
    opsRequestEnvelope(
      {
        appGroup: input.appGroup,
        appArea: input.appArea,
        appRegion: input.appRegion,
        appName: input.appName,
        appDivision: input.appDivision,
      },
      { page: input.page, size: input.size, sortOrder: input.sortOrder },
    ),
  project: (payload, ctx) => {
    const list = Array.isArray(payload) ? payload : [];

    const rows = list.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const kpiConfig = (row.kpiConfig ?? {}) as Record<string, unknown>;
      const statusInfo = (row.statusMasterInfo ?? {}) as Record<string, unknown>;
      const analytics = (row.analyticsMatrix ?? {}) as Record<string, unknown>;

      return {
        appName: str(metadata.appName),
        appGroup: str(metadata.appGroup),
        appArea: str(metadata.appArea),
        appRegion: str(metadata.appRegion),
        matrixPath: str(metadata.kpiName),
        matrixPathGroup: str(kpiConfig.kpiGroup),
        status: str(statusInfo.status),
        totalAlerts: num(analytics.totalAlerts),
        totalRed: num(analytics.totalRed),
        totalAmber: num(analytics.totalAmber),
        totalOccurrences: num(analytics.totalOccurrences),
        sourceCount: summariseSources(statusInfo),
      };
    });

    const pagination = readPagination(ctx.pagination);
    const footer =
      pagination.totalPages > 0
        ? `Page ${pagination.page.toLocaleString('en-US')} of ${pagination.totalPages.toLocaleString('en-US')} · ` +
          `${pagination.totalItems.toLocaleString('en-US')} matching paths` +
          (pagination.hasNext ? ' · more available' : '')
        : undefined;

    return {
      rows,
      returned: rows.length,
      pagination,
      ...provenance(ctx),
      display: renderRowsTable(
        'Matrix paths',
        [
          { header: 'App', get: (r) => r.appName },
          { header: 'Region', get: (r) => r.appRegion },
          { header: 'Matrix path', get: (r) => r.matrixPath },
          { header: 'Status', get: (r) => r.status },
          { header: '🔴 Red', numeric: true, get: (r) => r.totalRed },
          { header: '🟡 Amber', numeric: true, get: (r) => r.totalAmber },
          { header: 'Alerts', numeric: true, get: (r) => r.totalAlerts },
        ],
        rows,
        ctx,
        { footer, emptyMessage: '_No matrix paths matched these filters._' },
      ),
    };
  },
});
