import type { ConsoleFilters, ConsoleModel, SnapshotRecord } from "./types";
import {
  auditLog,
  catalogReviews,
  hourlyTraffic,
  latestCollectorErrors,
  latestCollectorRun,
  latestEvents,
  latestRouteDecisions,
  latestSnapshots,
  normalizedRows,
  notificationSettings,
  notifications,
  opsRuns,
} from "./store";

const routes = new Set(["VPS", "Direct", "Mixed", "Unknown"]);

function latestByType(records: SnapshotRecord[]) {
  return Object.fromEntries(records.map((row) => [row.type, row])) as ConsoleModel["snapshots"];
}

function minutesSince(value?: string) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function normalizeStatus(value?: string) {
  const status = String(value || "UNKNOWN").toUpperCase();
  if (status === "OK") return "OK";
  if (status === "CRIT") return "CRIT";
  if (status === "WARN") return "WARN";
  return "UNKNOWN";
}

function formatDetail(value: any) {
  if (value === undefined || value === null || value === "") return "n/a";
  return String(value);
}

function filterRows(rows: Array<Record<string, any>>, filters: ConsoleFilters) {
  const search = filters.search?.toLowerCase().trim();
  return rows.filter((row) => {
    if (filters.route && filters.route !== "all" && row.route !== filters.route) return false;
    if (filters.channel && filters.channel !== "all" && row.channel !== filters.channel) return false;
    if (filters.confidence && filters.confidence !== "all" && row.confidence !== filters.confidence) return false;
    if (filters.client && filters.client !== "all" && row.client !== filters.client && row.label !== filters.client) return false;
    if (!search) return true;
    return JSON.stringify(row).toLowerCase().includes(search);
  });
}

function routeFromCounters(row: Record<string, any>) {
  const vps = Number(row.via_vps_bytes || row.reality_bytes || row.vps_connections || 0);
  const direct = Number(row.direct_bytes || row.wan_bytes || row.direct_connections || 0);
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return row.route || "Unknown";
}

export function buildConsoleModel(filters: ConsoleFilters = {}): ConsoleModel {
  const snapshots = latestByType(latestSnapshots());
  const traffic = snapshots.traffic?.payload || {};
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const domains = snapshots.domains?.payload || {};
  const dns = snapshots.dns?.payload || {};

  const newest = Object.values(snapshots)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();

  const normalizedDevices = normalizedRows("normalized_devices").map((row: any) => ({
    id: row.device_id,
    label: row.label,
    ip: row.ip,
    channel: row.channel,
    route: row.route,
    confidence: row.confidence,
    total_bytes: row.total_bytes,
    via_vps_bytes: row.via_vps_bytes,
    direct_bytes: row.direct_bytes,
    raw: row.raw,
    collected_at: row.collected_at,
  }));

  const devices = normalizedDevices.length
    ? normalizedDevices
    : [
    ...(traffic.devices || []),
    ...(traffic.home_reality_clients || []).map((row: any) => ({
      id: row.profile || row.label,
      label: row.label,
      profile: row.profile,
      total_bytes: row.total_bytes,
      via_vps_bytes: row.via_vps_bytes,
      direct_bytes: row.direct_bytes,
      route: row.route,
      confidence: row.confidence,
    })),
  ];

  const normalizedFlows = normalizedRows("normalized_flows").map((row: any) => ({
    client: row.client,
    channel: row.channel,
    destination: row.destination,
    route: row.route,
    confidence: row.confidence,
    bytes: row.bytes,
    connections: row.connections,
    protocol: row.protocol,
    raw: row.raw,
    collected_at: row.collected_at,
  }));

  const flows = filterRows(
    normalizedFlows.length
      ? normalizedFlows
      : [
      ...(traffic.app_flows || []),
      ...(traffic.destinations || []).map((row: any) => ({
        ...row,
        client: row.client || row.channel,
      })),
    ],
    filters
  );

  const normalizedDns = normalizedRows("normalized_dns").map((row: any) => ({
    client: row.client,
    domain: row.domain,
    qtype: row.qtype,
    count: row.count,
    confidence: row.confidence,
    raw: row.raw,
    collected_at: row.collected_at,
  }));
  const dnsQueries = filterRows(normalizedDns.length ? normalizedDns : dns.queries || [], filters);

  const normalizedCatalog = normalizedRows("normalized_catalog").map((row: any) => ({
    domain: row.domain,
    type: row.entry_type,
    source: row.source,
    confidence: row.confidence,
    raw: row.raw,
    collected_at: row.collected_at,
  }));

  const catalog = normalizedCatalog.length
    ? normalizedCatalog
    : [
        ...(domains.managed || []),
        ...(domains.auto || []),
        ...(domains.candidates || []),
      ];

  const leakAlerts = (leaks.leaks || []).map((row: any) => ({
    severity: row.severity || "warning",
    title: row.label || row.probe,
    source: "leak-check",
    status: row.status,
    evidence: row.evidence,
    confidence: row.confidence || "exact",
  }));

  const routingAlerts = (traffic.routing_mistakes || []).map((row: any) => ({
    severity: row.severity || "warning",
    title: row.kind || "routing review",
    source: "traffic-report",
    destination: row.destination,
    confidence: row.confidence || "estimated",
  }));

  const normalizedAlerts = normalizedRows("normalized_alerts").map((row: any) => ({
    severity: row.severity,
    title: row.title,
    source: row.snapshot_type,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence,
    raw: row.raw,
  }));

  const collectorAlerts = latestCollectorErrors().map((row: any) => ({
    severity: "warning",
    title: `collector skipped ${row.type}`,
    source: "collector",
    status: "WARN",
    confidence: "exact",
    evidence: row.message,
    collectedAt: row.collected_at,
  }));
  const collectorDisabled = (process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled") === "disabled";
  const collectorErrors = collectorDisabled ? [] : (latestCollectorErrors(10) as Array<Record<string, any>>);
  const collectorRun = collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null);

  const staleMinutes = minutesSince(newest);
  const staleAlert =
    staleMinutes !== null && staleMinutes > 30
      ? [
          {
            severity: "warning",
            title: "stale snapshot",
            source: "console",
            status: "WARN",
            evidence: `${staleMinutes} minutes since latest snapshot`,
            confidence: "exact",
          },
        ]
      : [];

  const derivedNotifications = [...staleAlert, ...normalizedAlerts, ...leakAlerts, ...routingAlerts, ...collectorAlerts].map((row: any, idx) => ({
    id: `derived-${idx}`,
    type: row.source || "alert",
    severity: row.severity || "warning",
    title: row.title || row.evidence || "alert",
    status: "open",
    channel: row.channel || "",
    target: row.destination || row.title || "",
    created_at: row.collectedAt || newest || new Date().toISOString(),
    updated_at: row.collectedAt || newest || new Date().toISOString(),
    evidence: row,
  }));

  const statusCards = [
    {
      label: "Router",
      status: normalizeStatus(health.services?.router || health.overall),
      detail: formatDetail(health.router?.product),
    },
    {
      label: "Reality",
      status: normalizeStatus(health.services?.reality),
      detail: "home ingress / reality-out",
    },
    {
      label: "DNS",
      status: normalizeStatus(health.services?.dns),
      detail: "dnscrypt + policy",
    },
    {
      label: "IPv6",
      status: normalizeStatus(health.services?.ipv6),
      detail: "not in routing scope",
    },
    {
      label: "Rule-set",
      status: normalizeStatus(health.services?.rule_set_sync),
      detail: "catalog mirror",
    },
    {
      label: "Leaks",
      status: normalizeStatus(leaks.overall),
      detail: `${leakAlerts.length} signals`,
    },
  ];

  const totals = traffic.totals || {};
  return {
    generatedAt: new Date().toISOString(),
    freshnessMinutes: staleMinutes,
    freshnessStatus: staleMinutes === null ? "empty" : staleMinutes > 30 || collectorErrors.length > 0 ? "stale" : "fresh",
    collectorErrors,
    collectorRun,
    hourlyTraffic: hourlyTraffic() as Array<Record<string, any>>,
    events: latestEvents() as Array<Record<string, any>>,
    routeDecisions: latestRouteDecisions() as Array<Record<string, any>>,
    catalogReviews: catalogReviews() as Array<Record<string, any>>,
    notifications: [...(notifications() as Array<Record<string, any>>), ...derivedNotifications],
    notificationSettings: notificationSettings() as Record<string, any>,
    auditLog: auditLog() as Array<Record<string, any>>,
    opsRuns: opsRuns() as Array<Record<string, any>>,
    snapshots,
    statusCards,
    totals: {
      observedBytes: totals.client_observed_bytes || 0,
      viaVpsBytes: totals.via_vps_bytes || 0,
      directBytes: totals.direct_bytes || 0,
      unknownBytes: totals.unknown_bytes || 0,
    },
    devices: filterRows(devices.map((row: any) => ({ ...row, route: row.route || routeFromCounters(row) })), filters),
    flows,
    dnsQueries,
    alerts: [...staleAlert, ...collectorAlerts, ...normalizedAlerts, ...leakAlerts, ...routingAlerts],
    catalog,
  };
}

export function filterOptions(model: ConsoleModel) {
  const clients = Array.from(new Set(model.devices.map((row) => row.label || row.client).filter(Boolean))).sort();
  const routeValues = Array.from(
    new Set(model.flows.map((row) => row.route).filter((route) => routes.has(route)))
  ).sort();
  const channels = Array.from(
    new Set([...model.flows, ...model.devices].map((row) => row.channel).filter(Boolean))
  ).sort();
  return {
    clients,
    routes: routeValues,
    channels,
    confidences: ["exact", "estimated", "dns-interest", "unknown", "mixed"],
  };
}
