/**
 * Shared endpoint contract and rendering helpers.
 *
 * Everything an endpoint entry needs lives here, so `endpoints/*.ts` files stay
 * pure data + projection and nothing re-implements provenance or formatting.
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
  /** Set when the endpoint supports a pagination block. */
  readonly paginated?: boolean;
}

/** Heterogeneous registry element; per-entry safety comes from defineEndpoint. */
export type AnyApiEndpoint = ApiEndpoint<z.ZodTypeAny, z.ZodTypeAny>;

/** Identity helper that keeps `buildRequest`/`project` typed against the schemas. */
export function defineEndpoint<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny>(
  endpoint: ApiEndpoint<TIn, TOut>,
): ApiEndpoint<TIn, TOut> {
  return endpoint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request envelopes
// ─────────────────────────────────────────────────────────────────────────────

function stripEmpty(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/**
 * The ops-metrics request envelope: `{ filter: { queryParams }, pagination }`.
 * Used by the red/amber and live-summary endpoints.
 */
export function opsRequestEnvelope(queryParams: Record<string, unknown>, pagination: Record<string, unknown> = {}) {
  return { filter: { queryParams: stripEmpty(queryParams) }, pagination };
}

/**
 * The ct-apis request style: a flat object, no filter wrapper.
 * Absent optional fields are dropped rather than sent as null.
 */
export function flatRequest(params: Record<string, unknown>) {
  return stripEmpty(params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/** Every projected output carries these, so answers stay auditable. */
export const provenanceSchema = z.object({
  appliedFilters: z
    .record(z.string(), z.unknown())
    .describe('Filters the API actually applied. State these when reporting results.'),
  partialData: z.boolean().describe('True when the result is known to be incomplete'),
  warnings: z.array(z.string()).describe('Data-quality warnings that must be relayed to the user'),
  display: z
    .string()
    .describe('Pre-formatted markdown summary. Reproduce it verbatim; do not retype the values.'),
});

export function provenance(ctx: ProjectContext) {
  return {
    appliedFilters: ctx.appliedFilters,
    partialData: ctx.quality.partial,
    warnings: ctx.quality.warnings,
  };
}

/** Page info surfaced to the model for paginated endpoints. */
export const paginationSchema = z.object({
  page: z.number().int(),
  size: z.number().int(),
  totalItems: z.number().int(),
  totalPages: z.number().int(),
  hasNext: z.boolean(),
});

export function readPagination(pagination: unknown) {
  const p = (pagination ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    page: num(p.page, 1),
    size: num(p.size),
    totalItems: num(p.totalItems),
    totalPages: num(p.totalPages),
    hasNext: p.hasNext === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display rendering
// ─────────────────────────────────────────────────────────────────────────────

const formatNumber = (n: number) => n.toLocaleString('en-US');

/** Escape pipes so a value can never break the markdown table. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replace(/\|/g, '\\|');
}

export interface DisplayRow {
  label: string;
  value: number;
  emphasis?: boolean;
}

function filtersLine(ctx: ProjectContext): string {
  const filters = Object.entries(ctx.appliedFilters);
  return filters.length > 0
    ? `Filters applied: ${filters.map(([k, v]) => `\`${k}: ${String(v)}\``).join(', ')}`
    : 'Filters applied: none reported by the API';
}

function warningBlock(ctx: ProjectContext): string[] {
  if (!ctx.quality.partial) return [];
  return ['', '> ⚠️ **Incomplete result — treat these as lower bounds.**', ...ctx.quality.warnings.map((w) => `> - ${w}`)];
}

/**
 * Metric-tile style block (label/value pairs).
 *
 * Rendered in CODE, not by the model: the figures a user reads are exactly the
 * figures the API returned.
 */
export function renderDisplay(title: string, rows: DisplayRow[], ctx: ProjectContext): string {
  const lines: string[] = [`**${title}**`, '', '| Metric | Count |', '| :--- | ---: |'];
  for (const row of rows) {
    lines.push(
      row.emphasis ? `| **${row.label}** | **${cell(row.value)}** |` : `| ${row.label} | ${cell(row.value)} |`,
    );
  }
  lines.push('', filtersLine(ctx), ...warningBlock(ctx));
  return lines.join('\n');
}

export interface TableColumn<T> {
  header: string;
  /** Right-align numeric columns. */
  numeric?: boolean;
  get: (row: T) => unknown;
}

export interface RenderTableOptions {
  /** Rows beyond this are omitted from the DISPLAY (not from the data). */
  maxRows?: number;
  /** Extra line under the table, e.g. page info. */
  footer?: string;
  emptyMessage?: string;
}

/** Row-oriented markdown table for list endpoints. */
export function renderRowsTable<T>(
  title: string,
  columns: TableColumn<T>[],
  rows: T[],
  ctx: ProjectContext,
  options: RenderTableOptions = {},
): string {
  const maxRows = options.maxRows ?? 20;
  const lines: string[] = [`**${title}**`, ''];

  if (rows.length === 0) {
    lines.push(options.emptyMessage ?? '_No matching results._', '', filtersLine(ctx), ...warningBlock(ctx));
    return lines.join('\n');
  }

  lines.push(`| ${columns.map((c) => c.header).join(' | ')} |`);
  lines.push(`| ${columns.map((c) => (c.numeric ? '---:' : ':---')).join(' | ')} |`);

  for (const row of rows.slice(0, maxRows)) {
    lines.push(`| ${columns.map((c) => cell(c.get(row))).join(' | ')} |`);
  }

  if (rows.length > maxRows) {
    lines.push('', `_Showing ${maxRows} of ${formatNumber(rows.length)} rows returned._`);
  }
  if (options.footer) lines.push('', options.footer);

  lines.push('', filtersLine(ctx), ...warningBlock(ctx));
  return lines.join('\n');
}
