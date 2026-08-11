/**
 * Ops API endpoint registry.
 *
 * Adding an endpoint is a DATA change here, not a code change: one entry gives
 * you a validated tool with consistent auth, retries, envelope unwrapping,
 * output projection and approval policy.
 *
 * Conventions every entry follows:
 *  - `input` is what the MODEL supplies, in domain terms. It is not the wire
 *    format; `buildRequest` maps it to the API's request envelope.
 *  - `project` returns ONLY the fields worth spending tokens on. Diagnostics
 *    (executionTimeMs, indexName, duplicate hit counts) stay in traces.
 *  - `kind: 'write'` forces human approval. Reads never prompt, otherwise an
 *    agent over 100 read endpoints becomes unusable.
 */
import { z } from 'zod';
import type { DataQuality, OpsMetadata } from './client';

export type EndpointKind = 'read' | 'write';

export interface ProjectContext {
  appliedFilters: Record<string, unknown>;
  metadata: OpsMetadata;
  quality: DataQuality;
  pagination: unknown;
}

export interface ApiEndpoint<TInput extends z.ZodTypeAny = z.ZodTypeAny, TOutput extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Tool id exposed to the model. Stable; changing it breaks saved traces. */
  readonly id: string;
  readonly path: string;
  readonly kind: EndpointKind;
  /** Written for the MODEL: when to use this, not what it returns. */
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  /** Domain input → API request envelope. */
  readonly buildRequest: (input: z.infer<TInput>) => unknown;
  /** Raw payload + envelope context → the narrow object the model sees. */
  readonly project: (payload: unknown, ctx: ProjectContext) => z.infer<TOutput>;
  /**
   * Force approval for a read endpoint, or refine it for a write.
   * Omitted means: writes require approval, reads do not.
   */
  readonly requireApproval?: boolean | ((input: z.infer<TInput>) => boolean);
  /** Set when the endpoint supports the pagination block. */
  readonly paginated?: boolean;
}

/**
 * Heterogeneous registry element. Each entry has its own input/output schemas,
 * so the collection is intentionally loosely typed; per-entry safety comes from
 * `defineEndpoint`, which preserves the concrete schema types at the definition
 * site where the handlers are written.
 */
export type AnyApiEndpoint = ApiEndpoint<z.ZodTypeAny, z.ZodTypeAny>;

/** Identity helper that keeps `buildRequest`/`project` typed against the schemas. */
export function defineEndpoint<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny>(
  endpoint: ApiEndpoint<TIn, TOut>,
): ApiEndpoint<TIn, TOut> {
  return endpoint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The API's standard request envelope.
 *
 * `pagination` is always present because the observed contract includes it even
 * when empty. Paginated endpoints will pass a populated block here.
 */
export function opsRequestEnvelope(queryParams: Record<string, unknown>, pagination: Record<string, unknown> = {}) {
  const cleaned = Object.fromEntries(Object.entries(queryParams).filter(([, v]) => v !== undefined && v !== null));
  return { filter: { queryParams: cleaned }, pagination };
}

/** Every projected output carries these, so answers stay auditable. */
const provenanceSchema = z.object({
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('Filters the API actually applied. State these when reporting numbers.'),
  partialData: z.boolean().describe('True when the result is known to be incomplete'),
  warnings: z.array(z.string()).describe('Data-quality warnings that must be relayed to the user'),
  display: z
    .string()
    .describe('Pre-formatted markdown summary of this result. Reproduce it verbatim; do not retype the numbers.'),
});

function provenance(ctx: ProjectContext) {
  return {
    appliedFilters: ctx.appliedFilters,
    partialData: ctx.quality.partial,
    warnings: ctx.quality.warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Thousands separators, so 1493 reads as 1,493 in the table. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export interface DisplayRow {
  label: string;
  value: number;
  /** Renders the row in bold — use for totals. */
  emphasis?: boolean;
}

/**
 * Build the markdown block the agent reproduces verbatim.
 *
 * Rendered in CODE, not by the model. The model has already been observed
 * dropping fields and reformatting values when asked to present numbers itself;
 * generating the table here means the figures a user reads are exactly the
 * figures the API returned.
 */
export function renderDisplay(title: string, rows: DisplayRow[], ctx: ProjectContext): string {
  const lines: string[] = [`**${title}**`, '', '| Metric | Count |', '| :--- | ---: |'];

  for (const row of rows) {
    lines.push(
      row.emphasis
        ? `| **${row.label}** | **${formatNumber(row.value)}** |`
        : `| ${row.label} | ${formatNumber(row.value)} |`,
    );
  }

  const filters = Object.entries(ctx.appliedFilters);
  lines.push('');
  lines.push(
    filters.length > 0
      ? `Filters applied: ${filters.map(([k, v]) => `\`${k}: ${String(v)}\``).join(', ')}`
      : 'Filters applied: none reported by the API',
  );

  if (ctx.quality.partial) {
    lines.push('');
    lines.push('> ⚠️ **Incomplete result — treat these as lower bounds.**');
    for (const warning of ctx.quality.warnings) lines.push(`> - ${warning}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const redAmberOverall = defineEndpoint({
  id: 'ops_red_amber_overall',
  path: '/opensearch-api/ops-metrics/red-amber/overall',
  kind: 'read',
  description:
    'Get overall red and amber operational alert counts for an application group, optionally narrowed to an ' +
    'application area. Use for questions about how many red or amber alerts exist, the total alert volume, or ' +
    'how many paths are affected. Requires an application group; ask the user for one if they have not given it.',
  inputSchema: z.object({
    appGroup: z.string().min(1).describe('Application group, e.g. "Atlas"'),
    appArea: z.string().min(1).optional().describe('Optional application area to narrow the query'),
  }),
  outputSchema: z
    .object({
      red: z.number().int().describe('Count of red alerts'),
      amber: z.number().int().describe('Count of amber alerts'),
      totalAlerts: z.number().int(),
      totalPaths: z.number().int().describe('Number of paths covered by these counts'),
    })
    .merge(provenanceSchema),
  buildRequest: (input) => opsRequestEnvelope({ appGroup: input.appGroup, appArea: input.appArea }),
  project: (payload, ctx) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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

export const OPS_ENDPOINTS: readonly AnyApiEndpoint[] = [redAmberOverall];

export function findEndpoint(id: string): AnyApiEndpoint | undefined {
  return OPS_ENDPOINTS.find((e) => e.id === id);
}
