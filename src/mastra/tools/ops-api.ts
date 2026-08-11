/**
 * Ops API tools, generated from the registry.
 *
 * There is no hand-written tool per endpoint — one factory means all ~100
 * endpoints get identical retry, unwrapping, provenance and approval behaviour,
 * and adding an endpoint cannot accidentally skip any of it.
 */
import { createTool } from '@mastra/core/tools';
import { postOps, type RequestOptions } from '../services/ops-api/client';
import { OPS_ENDPOINTS, type AnyApiEndpoint } from '../services/ops-api/registry';

/**
 * Approval policy, in one place.
 *
 * Writes always require a human. Reads never do by default — prompting on every
 * read across a large endpoint library makes the agent unusable — but an entry
 * can opt in, including conditionally on its arguments.
 */
function approvalFor(endpoint: AnyApiEndpoint): boolean | ((input: unknown) => boolean) {
  if (endpoint.requireApproval !== undefined) {
    return endpoint.requireApproval as boolean | ((input: unknown) => boolean);
  }
  return endpoint.kind === 'write';
}

/** Build a Mastra tool from a registry entry. */
export function createApiTool(endpoint: AnyApiEndpoint, options: RequestOptions = {}) {
  return createTool({
    id: endpoint.id,
    description: endpoint.description,
    inputSchema: endpoint.inputSchema,
    outputSchema: endpoint.outputSchema,
    requireApproval: approvalFor(endpoint),
    execute: async (input) => {
      const body = endpoint.buildRequest(input);
      const res = await postOps(endpoint.path, body, options);
      return endpoint.project(res.payload, {
        appliedFilters: res.appliedFilters,
        metadata: res.metadata,
        quality: res.quality,
        pagination: res.pagination,
      });
    },
  });
}

/** All registry endpoints as tools, keyed by tool id. */
export function buildOpsTools(options: RequestOptions = {}): Record<string, ReturnType<typeof createApiTool>> {
  return Object.fromEntries(OPS_ENDPOINTS.map((e) => [e.id, createApiTool(e, options)]));
}

export const opsTools = buildOpsTools();
