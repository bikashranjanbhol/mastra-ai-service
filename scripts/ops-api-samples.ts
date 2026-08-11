/**
 * Sample payloads for `npm run check:ops-api`, taken from the real API docs.
 *
 * Values are reproduced as given, including the awkward parts that the client
 * has to survive: a `timedOut` that is a timestamp string rather than a boolean,
 * an incoherent shard block, and a row carrying thousands of metric sources.
 */

/** Builds a multiSourceMetricData array of the given length. */
function sources(count: number) {
  return Array.from({ length: count }, (_, i) => ({ sourceId: `id-${i * 2}`, status: 'ipsum' }));
}

export const SEARCH_SAMPLE = {
  // The supplied example had lorem-ipsum here; the live contract returns
  // 'SUCCESS' like every other endpoint. A literal 'ipsum' is correctly
  // rejected by the client as a failed status, which section 4 already covers.
  status: 'SUCCESS',
  message: 'dolor',
  timestamp: 1577836803,
  data: {
    data: [
      {
        metadata: {
          appName: 'Casey Kim',
          appGroup: 'consectetur',
          appArea: 'lorem',
          appRegion: 'ipsum',
          kpiName: 'Sam Rivera',
        },
        kpiConfig: { kpiType: 'sit', kpiGroup: 'amet', isMultiSource: false },
        statusMasterInfo: {
          status: 'lorem',
          statusCode: 'ipsum',
          refreshedTime: 1577836815,
          multiSourceMetricData: sources(3),
        },
        analyticsMatrix: {
          totalOccurrences: 168,
          totalManualResolve: 175,
          totalAutoresolved: 182,
          totalAlerts: 189,
          totalRed: 196,
          totalAmber: 203,
        },
        indexedAt: 1577836834,
        docVersion: 245,
      },
      {
        metadata: {
          appName: 'Sam Rivera',
          appGroup: 'sit',
          appArea: 'amet',
          appRegion: 'consectetur',
          kpiName: 'Jordan Lee',
        },
        kpiConfig: { kpiType: 'ipsum', kpiGroup: 'dolor', isMultiSource: false },
        statusMasterInfo: {
          status: 'lorem',
          statusCode: 'ipsum',
          // The pathological row: thousands of sources on a single result.
          multiSourceMetricData: sources(1650),
        },
        analyticsMatrix: {
          totalOccurrences: 114,
          totalManualResolve: 121,
          totalAutoresolved: 128,
          totalAlerts: 135,
          totalRed: 142,
          totalAmber: 149,
        },
        indexedAt: 1577840110,
        docVersion: 177,
      },
    ],
    pagination: {
      page: 474,
      size: 481,
      totalItems: 488,
      totalPages: 495,
      hasNext: true,
      hasPrevious: false,
      searchAfter: null,
    },
    metadata: {
      executionTimeMs: 1577841589,
      indexName: 'Sam Rivera',
      queryType: 'sit',
      totalHits: 544,
      // Not a boolean in the real payload.
      timedOut: '2020-01-01T00:00:00Z',
      // Incoherent: successful + failed exceeds total.
      shards: { total: 558, successful: 565, failed: 572 },
    },
  },
  error: null,
};

export const CATALOG_SAMPLE = {
  status: 'SUCCESS',
  message: ' KPI App Area Masters paginated retrieved successfully',
  timestamp: 1786483773852,
  data: {
    content: [
      {
        appGroup: 'Replenishment',
        appArea: 'Replenishment',
        appRegion: ['INTL'],
        isActive: true,
      },
      {
        appGroup: 'Atlas International',
        appArea: 'Ambient',
        appRegion: ['CAM', 'CL', 'Chile', 'ChileL'],
        isActive: true,
      },
      {
        appGroup: 'Atlas',
        appArea: 'Atlas',
        appRegion: ['Ambient', 'Default', 'FC', 'Fulfillment', 'Grocery', 'MFC', 'US'],
        isActive: true,
      },
      {
        appGroup: 'Atlas',
        appArea: 'Logistics',
        appRegion: ['CL'],
        isActive: true,
      },
      // Inactive rows must not be offered as choices.
      {
        appGroup: 'Retired Group',
        appArea: 'Retired',
        appRegion: ['US'],
        isActive: false,
      },
    ],
    nextPagingState: null,
  },
};

export const APPS_SAMPLE = {
  status: 'SUCCESS',
  message: 'KPI App Master retrieved successfully',
  timestamp: 1786484131834,
  data: [
    { appName: 'Kafka', appDivision: 'RDC' },
    { appName: 'Pharmacy', appDivision: 'Pharmacy' },
  ],
};

export const KPI_GROUPS_SAMPLE = {
  status: 'SUCCESS',
  message: 'KPI groups retrieved successfully',
  timestamp: 1786484530508,
  data: [{ kpiGroup: 'Alerts' }],
};

export const KPI_NAMES_SAMPLE = {
  status: 'SUCCESS',
  message: 'KPI names and platform retrieved successfully',
  timestamp: 1786484532954,
  data: [
    {
      kpiName: 'Consumer Lag',
      platform: 'Kafka',
      configType: 'MMS',
      isMultiSource: true,
      kpiGroup: 'Alerts',
      primaryOwner: 'Atlas_Ambient_Ops',
      workLogTraceKeys: null,
      blastRadius: null,
    },
  ],
};
