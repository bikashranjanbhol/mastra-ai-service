/**
 * Ops API endpoint registry.
 *
 * Adding an endpoint is a DATA change: write one entry under `endpoints/` and
 * list it here. The entry gets consistent auth, retries, envelope unwrapping,
 * output projection, display rendering and approval policy for free.
 */
import { applications, filterCatalog, matrixPathGroups, matrixPaths } from './endpoints/catalog';
import { liveSummarySearch, redAmberOverall } from './endpoints/metrics';
import type { AnyApiEndpoint } from './types';

export * from './types';

export const OPS_ENDPOINTS: readonly AnyApiEndpoint[] = [
  // Aggregate metrics
  redAmberOverall,
  liveSummarySearch,
  // Filter discovery, in narrowing order
  filterCatalog,
  applications,
  matrixPathGroups,
  matrixPaths,
];

export function findEndpoint(id: string): AnyApiEndpoint | undefined {
  return OPS_ENDPOINTS.find((e) => e.id === id);
}
