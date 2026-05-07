export type SnapshotType = "traffic" | "traffic_summary" | "health" | "leaks" | "domains" | "dns" | "live" | "deploy_gate";
export type Confidence = "exact" | "estimated" | "dns-interest" | "unknown" | "mixed";

export type SnapshotRecord = {
  id: number;
  type: SnapshotType;
  collectedAt: string;
  source: string;
  path: string;
  payload: any;
};

export type ConsoleFilters = {
  period?: string;
  route?: string;
  channel?: string;
  client?: string;
  confidence?: string;
  trafficClass?: string;
  search?: string;
};

export type ConsoleModel = {
  generatedAt: string;
  freshnessMinutes: number | null;
  freshnessStatus: "fresh" | "stale" | "empty";
  freshnessLabel?: string;
  nextExpectedCollection?: string;
  staleThresholdMinutes?: number;
  runtime: {
    sourceLabel: string;
    dataDirLabel: string;
    repoRootLabel: string;
    buildCommit: string;
    buildAt: string;
    nodeEnv: string;
    latestSnapshots: Record<string, string>;
  };
  collectorErrors: Array<Record<string, any>>;
  collectorRun?: Record<string, any> | null;
  hourlyTraffic: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  routeDecisions: Array<Record<string, any>>;
  catalogReviews: Array<Record<string, any>>;
  notifications: Array<Record<string, any>>;
  notificationSettings: Record<string, any>;
  auditLog: Array<Record<string, any>>;
  opsRuns: Array<Record<string, any>>;
  snapshots: Record<string, SnapshotRecord | undefined>;
  statusCards: Array<{ label: string; status: string; detail: string }>;
  totals: {
    observedBytes: number;
    viaVpsBytes: number;
    directBytes: number;
    unknownBytes: number;
    periodLabel: string;
    windowLabel: string;
  };
  destinationAttributionCoverage?: Record<string, any>;
  devices: Array<Record<string, any>>;
  flows: Array<Record<string, any>>;
  dnsQueries: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
  catalog: Array<Record<string, any>>;
  settingsInventory?: Record<string, any>;
};
