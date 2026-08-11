/**
 * Filter-discovery endpoints.
 *
 * These exist so the agent never guesses a filter value. The chain narrows
 * left to right, each step's output feeding the next step's input:
 *
 *   appGroup / appArea / appRegion   ops_filter_catalog
 *        └→ appName + appDivision    ops_applications
 *             └→ matrix path group   ops_matrix_path_groups
 *                  └→ matrix path    ops_matrix_paths
 */
import { z } from 'zod';
import { defineEndpoint, flatRequest, provenance, provenanceSchema, renderRowsTable } from '../types';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Rows come back as a flat array under `data` for the ct-apis endpoints. */
function asRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  // The catalog endpoint nests its array under `content`.
  const p = (payload ?? {}) as Record<string, unknown>;
  return Array.isArray(p.content) ? (p.content as Record<string, unknown>[]) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// appGroup / appArea / appRegion catalog
// ─────────────────────────────────────────────────────────────────────────────

const catalogEntrySchema = z.object({
  appGroup: z.string(),
  appArea: z.string(),
  appRegions: z.array(z.string()),
});

export const filterCatalog = defineEndpoint({
  id: 'ops_filter_catalog',
  path: '/opensearch-api/ops-metrics/red-amber/by-appgroup-apparea',
  kind: 'read',
  description:
    'List every available application group, its application areas, and the regions under each. Call this FIRST ' +
    'whenever the user has not named an application group, or names one you cannot match exactly — then offer ' +
    'them the options rather than guessing. Takes no arguments.',
  inputSchema: z.object({}),
  outputSchema: z
    .object({
      appGroups: z.array(z.string()).describe('Distinct application groups, sorted'),
      entries: z.array(catalogEntrySchema).describe('Each group/area pair with its regions'),
      totalEntries: z.number().int(),
    })
    .merge(provenanceSchema),
  // pageSize is fixed: the catalog is small and a single page covers it.
  buildRequest: () => ({ pageSize: 1000, pagingState: '' }),
  project: (payload, ctx) => {
    const entries = asRows(payload)
      // Inactive rows would offer the user filters that return nothing.
      .filter((row) => row.isActive !== false)
      .map((row) => ({
        appGroup: str(row.appGroup) ?? '',
        appArea: str(row.appArea) ?? '',
        appRegions: Array.isArray(row.appRegion)
          ? (row.appRegion.map(str).filter(Boolean) as string[])
          : ([str(row.appRegion)].filter(Boolean) as string[]),
      }))
      .filter((entry) => entry.appGroup !== '')
      .sort((a, b) => a.appGroup.localeCompare(b.appGroup) || a.appArea.localeCompare(b.appArea));

    const appGroups = [...new Set(entries.map((e) => e.appGroup))].sort();

    return {
      appGroups,
      entries,
      totalEntries: entries.length,
      ...provenance(ctx),
      display: renderRowsTable(
        'Available filters',
        [
          { header: 'App group', get: (e) => e.appGroup },
          { header: 'App area', get: (e) => e.appArea },
          { header: 'Regions', get: (e) => (e.appRegions.length ? e.appRegions.join(', ') : '—') },
        ],
        entries,
        ctx,
        { maxRows: 30, emptyMessage: '_No application groups are configured._' },
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Applications (and divisions)
// ─────────────────────────────────────────────────────────────────────────────

export const applications = defineEndpoint({
  id: 'ops_applications',
  path: '/ct-apis/kpi-data-app-master/fetch-active-apps',
  kind: 'read',
  description:
    'List the active applications for a group/area/region, with the division each belongs to. Use this to find ' +
    'valid application names, and as the ONLY source of application division values. Requires group, area and ' +
    'region — get them from ops_filter_catalog first if the user has not supplied them.',
  inputSchema: z.object({
    appGroup: z.string().min(1),
    appArea: z.string().min(1),
    appRegion: z.string().min(1),
  }),
  outputSchema: z
    .object({
      applications: z.array(z.object({ appName: z.string(), appDivision: z.string().optional() })),
      appNames: z.array(z.string()),
      appDivisions: z.array(z.string()).describe('Distinct divisions across these applications'),
    })
    .merge(provenanceSchema),
  buildRequest: (input) =>
    flatRequest({ appGroup: input.appGroup, appArea: input.appArea, appRegion: input.appRegion }),
  project: (payload, ctx) => {
    const applicationRows = asRows(payload)
      .map((row) => ({ appName: str(row.appName) ?? '', appDivision: str(row.appDivision) }))
      .filter((row) => row.appName !== '');

    return {
      applications: applicationRows,
      appNames: [...new Set(applicationRows.map((a) => a.appName))].sort(),
      appDivisions: [...new Set(applicationRows.map((a) => a.appDivision).filter(Boolean) as string[])].sort(),
      ...provenance(ctx),
      display: renderRowsTable(
        'Applications',
        [
          { header: 'Application', get: (a) => a.appName },
          { header: 'Division', get: (a) => a.appDivision },
        ],
        applicationRows,
        ctx,
        { emptyMessage: '_No active applications for these filters._' },
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix path groups
// ─────────────────────────────────────────────────────────────────────────────

export const matrixPathGroups = defineEndpoint({
  id: 'ops_matrix_path_groups',
  path: '/ct-apis/kpi-Conf/fetch-kpigroups',
  kind: 'read',
  description:
    'List the matrix path groups (KPI groups) available for a specific application. Use after ops_applications ' +
    'when the user wants to narrow to a category of matrix paths, such as "Alerts".',
  inputSchema: z.object({
    appGroup: z.string().min(1),
    appArea: z.string().min(1),
    appRegion: z.string().min(1),
    appName: z.string().min(1),
  }),
  outputSchema: z
    .object({ matrixPathGroups: z.array(z.string()) })
    .merge(provenanceSchema),
  buildRequest: (input) =>
    flatRequest({
      appGroup: input.appGroup,
      appArea: input.appArea,
      appRegion: input.appRegion,
      appName: input.appName,
    }),
  project: (payload, ctx) => {
    const groups = [
      ...new Set(asRows(payload).map((row) => str(row.kpiGroup)).filter(Boolean) as string[]),
    ].sort();

    return {
      matrixPathGroups: groups,
      ...provenance(ctx),
      display: renderRowsTable(
        'Matrix path groups',
        [{ header: 'Group', get: (g: string) => g }],
        groups,
        ctx,
        { emptyMessage: '_No matrix path groups for this application._' },
      ),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix paths
// ─────────────────────────────────────────────────────────────────────────────

const matrixPathDefSchema = z.object({
  matrixPath: z.string().describe('The KPI name'),
  platform: z.string().optional(),
  matrixPathGroup: z.string().optional(),
  isMultiSource: z.boolean().optional(),
  primaryOwner: z.string().optional(),
});

export const matrixPaths = defineEndpoint({
  id: 'ops_matrix_paths',
  path: '/ct-apis/kpi-Conf/fetch-kpi-names',
  kind: 'read',
  description:
    'List the individual matrix paths (KPI names) configured for an application and matrix path group, with ' +
    'their platform and owning team. Use to resolve a matrix path name before filtering, or when the user asks ' +
    'what is monitored for an application.',
  inputSchema: z.object({
    appGroup: z.string().min(1),
    appArea: z.string().min(1),
    appRegion: z.string().min(1),
    appName: z.string().min(1),
    matrixPathGroup: z.string().min(1).describe('Matrix path group, e.g. "Alerts"'),
  }),
  outputSchema: z
    .object({
      matrixPaths: z.array(matrixPathDefSchema),
      matrixPathNames: z.array(z.string()),
    })
    .merge(provenanceSchema),
  buildRequest: (input) =>
    flatRequest({
      appGroup: input.appGroup,
      appArea: input.appArea,
      appRegion: input.appRegion,
      appName: input.appName,
      // The API names this field kpiGroup; the model speaks in matrix paths.
      kpiGroup: input.matrixPathGroup,
    }),
  project: (payload, ctx) => {
    const paths = asRows(payload)
      .map((row) => ({
        matrixPath: str(row.kpiName) ?? '',
        platform: str(row.platform),
        matrixPathGroup: str(row.kpiGroup),
        isMultiSource: typeof row.isMultiSource === 'boolean' ? row.isMultiSource : undefined,
        primaryOwner: str(row.primaryOwner),
      }))
      .filter((row) => row.matrixPath !== '');

    return {
      matrixPaths: paths,
      matrixPathNames: paths.map((p) => p.matrixPath),
      ...provenance(ctx),
      display: renderRowsTable(
        'Matrix paths',
        [
          { header: 'Matrix path', get: (p) => p.matrixPath },
          { header: 'Platform', get: (p) => p.platform },
          { header: 'Group', get: (p) => p.matrixPathGroup },
          { header: 'Owner', get: (p) => p.primaryOwner },
        ],
        paths,
        ctx,
        { emptyMessage: '_No matrix paths configured for this group._' },
      ),
    };
  },
});
