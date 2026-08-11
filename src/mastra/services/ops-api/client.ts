/**
 * Shared ops API HTTP client.
 *
 * Every endpoint goes through here so that envelope unwrapping, error mapping,
 * retries and data-quality detection are written once rather than 100 times.
 *
 * ── The response envelope ───────────────────────────────────────────────────
 * Observed shape (red-amber/overall):
 *
 *   root.status                      'SUCCESS' | other
 *   root.error                       null when healthy
 *   root.data.data.data              ← the actual payload
 *   root.data.data.appliedFilters    ← what the API ACTUALLY filtered on
 *   root.data.data.metadata          ← shards / timedOut / totalHits
 *   root.data.pagination             ← null when unpaginated
 *   root.data.metadata               ← duplicate of the inner metadata
 *
 * The payload sits three `data` levels deep. Unwrapping is deliberately
 * defensive rather than hard-coded to that depth: with ~100 endpoints written
 * by different hands, some will nest differently, and a wrong assumption would
 * surface as a confidently-wrong answer rather than an error.
 */
import { buildHeaders, resolveOpsApiConfig, type OpsApiConfig } from '../../config/ops-api';
import { logger } from '../../config/logger';

export interface ShardInfo {
  total?: number;
  successful?: number;
  failed?: number;
}

export interface OpsMetadata {
  executionTimeMs?: number;
  indexName?: string;
  queryType?: string;
  totalHits?: number;
  timedOut?: boolean;
  shards?: ShardInfo;
}

/**
 * Whether the result can be trusted as complete.
 *
 * Failed shards and timeouts do NOT produce an HTTP error — the API returns 200
 * with silently undercounted numbers. Reporting those as fact is the single
 * most dangerous failure mode for this integration, so it is surfaced
 * explicitly and every tool is expected to pass it to the model.
 */
export interface DataQuality {
  partial: boolean;
  warnings: string[];
}

export interface OpsResponse<T> {
  payload: T;
  appliedFilters: Record<string, unknown>;
  metadata: OpsMetadata;
  pagination: unknown;
  quality: DataQuality;
}

export class OpsApiError extends Error {
  constructor(
    message: string,
    readonly detail: { path: string; status?: number; apiStatus?: string; apiError?: unknown } = { path: '' },
  ) {
    super(message);
    this.name = 'OpsApiError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope handling
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walk down repeated `data` wrappers to the innermost meaningful object.
 *
 * Stops as soon as a level carries real content (anything other than a lone
 * `data` key), so a two-level endpoint and a three-level one both work.
 */
function unwrapDataChain(root: unknown): { payload: unknown; carriers: Record<string, unknown>[] } {
  const carriers: Record<string, unknown>[] = [];
  let current = root;

  for (let depth = 0; depth < 6; depth++) {
    if (!isRecord(current) || !('data' in current)) break;
    carriers.push(current);
    const next = current.data;
    // A level that holds siblings (appliedFilters, metadata, pagination) is a
    // carrier; keep descending, but remember it.
    if (!isRecord(next)) {
      current = next;
      break;
    }
    current = next;
  }

  return { payload: current, carriers };
}

/** First defined value for `key` across the carrier levels, innermost first. */
function pickFromCarriers<T>(carriers: Record<string, unknown>[], key: string): T | undefined {
  for (let i = carriers.length - 1; i >= 0; i--) {
    const value = carriers[i]?.[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

function assessQuality(metadata: OpsMetadata): DataQuality {
  const warnings: string[] = [];
  const failed = metadata.shards?.failed ?? 0;

  if (failed > 0) {
    const total = metadata.shards?.total ?? '?';
    warnings.push(
      `${failed} of ${total} shards failed — counts are undercounts and must not be reported as exact totals`,
    );
  }
  if (metadata.timedOut) {
    warnings.push('the query timed out server-side — results are partial');
  }

  return { partial: warnings.length > 0, warnings };
}

/** Split a raw envelope into payload, applied filters, metadata and quality. */
export function parseEnvelope<T>(root: unknown, path: string): OpsResponse<T> {
  if (!isRecord(root)) {
    throw new OpsApiError('ops API returned a non-object response', { path });
  }

  const status = typeof root.status === 'string' ? root.status : undefined;
  if (status && status.toUpperCase() !== 'SUCCESS') {
    throw new OpsApiError(`ops API returned status "${status}": ${String(root.message ?? 'no message')}`, {
      path,
      apiStatus: status,
      apiError: root.error,
    });
  }
  if (root.error != null) {
    throw new OpsApiError(`ops API returned an error: ${JSON.stringify(root.error).slice(0, 200)}`, {
      path,
      apiError: root.error,
    });
  }

  const { payload, carriers } = unwrapDataChain(root);
  const metadata = pickFromCarriers<OpsMetadata>(carriers, 'metadata') ?? {};

  return {
    payload: payload as T,
    appliedFilters: pickFromCarriers<Record<string, unknown>>(carriers, 'appliedFilters') ?? {},
    metadata,
    pagination: pickFromCarriers(carriers, 'pagination') ?? null,
    quality: assessQuality(metadata),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  config?: OpsApiConfig;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a request envelope and return the parsed response.
 *
 * Retries only on transient statuses and network faults — a 4xx is a contract
 * problem and retrying it just delays a clear error.
 */
export async function postOps<T>(
  path: string,
  body: unknown,
  { config, fetchImpl }: RequestOptions = {},
): Promise<OpsResponse<T>> {
  const cfg = config ?? resolveOpsApiConfig();
  const doFetch = fetchImpl ?? fetch;
  const url = `${cfg.baseUrl}${path}`;

  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const started = Date.now();
      const res = await doFetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new OpsApiError(`ops API ${res.status} for ${path}: ${text.slice(0, 200)}`, {
          path,
          status: res.status,
        });
        if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.maxRetries) {
          lastError = err;
          await sleep(2 ** attempt * 500 + Math.random() * 250);
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as unknown;
      const parsed = parseEnvelope<T>(json, path);

      logger.info('ops api call', {
        path,
        latencyMs: Date.now() - started,
        index: parsed.metadata.indexName,
        totalHits: parsed.metadata.totalHits,
        partial: parsed.quality.partial,
      });

      return parsed;
    } catch (err) {
      lastError = err;
      // Contract errors are final; transport faults get one more go.
      const transient = !(err instanceof OpsApiError) && attempt < cfg.maxRetries;
      if (!transient) break;
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }

  if (lastError instanceof OpsApiError) throw lastError;
  throw new OpsApiError(
    `ops API request to ${path} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { path },
  );
}
