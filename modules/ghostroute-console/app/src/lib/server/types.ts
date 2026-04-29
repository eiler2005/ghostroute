export type SnapshotType = "traffic" | "health" | "leaks" | "domains" | "dns";
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
  client?: string;
  confidence?: string;
  search?: string;
};

export type ConsoleModel = {
  generatedAt: string;
  freshnessMinutes: number | null;
  freshnessStatus: "fresh" | "stale" | "empty";
  collectorErrors: Array<Record<string, any>>;
  collectorRun?: Record<string, any> | null;
  hourlyTraffic: Array<Record<string, any>>;
  snapshots: Record<string, SnapshotRecord | undefined>;
  statusCards: Array<{ label: string; status: string; detail: string }>;
  totals: {
    observedBytes: number;
    viaVpsBytes: number;
    directBytes: number;
    unknownBytes: number;
  };
  devices: Array<Record<string, any>>;
  flows: Array<Record<string, any>>;
  dnsQueries: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
  catalog: Array<Record<string, any>>;
};
