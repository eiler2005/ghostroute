import { execFileSync } from "node:child_process";
import type { ConsoleFilters, ConsoleModel, SnapshotRecord } from "./types";
import { dataDir, repoRoot } from "./paths";
import {
  auditLog,
  catalogReviews,
  getDb,
  hourlyTraffic,
  knownDeviceRows,
  latestCollectorErrors,
  latestCollectorRun,
  latestEvents,
  latestRouteDecisions,
  latestSnapshotIds,
  latestSnapshots,
  normalizedRows,
  notificationSettings,
  notifications,
  opsRuns,
} from "./store";
import {
  deviceRole,
  displayDestination,
  trafficClassFor,
  trafficClassLabel,
  trafficClasses,
} from "../traffic-classification.mjs";

const routes = new Set(["VPS", "Direct", "Mixed", "Unknown"]);

function shortCommit(value?: string) {
  const commit = String(value || "").trim();
  if (!commit || commit === "unknown") return "unknown";
  return commit.slice(0, 8);
}

function gitCommit() {
  if (process.env.GHOSTROUTE_CONSOLE_BUILD_COMMIT) {
    return shortCommit(process.env.GHOSTROUTE_CONSOLE_BUILD_COMMIT);
  }
  try {
    return shortCommit(execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoRoot(), encoding: "utf8", timeout: 1000 }));
  } catch {
    return "unknown";
  }
}

function labelPath(value: string) {
  if (value === "/data") return "/data";
  const marker = "modules/ghostroute-console/";
  const idx = value.indexOf(marker);
  if (idx >= 0) return value.slice(idx);
  return value;
}

function runtimeInfo(snapshots: ConsoleModel["snapshots"]) {
  const dir = dataDir();
  const repo = repoRoot();
  const sourceLabel = process.env.NODE_ENV === "production" || dir === "/data" ? "VPS/runtime data" : "local dev data";
  return {
    sourceLabel,
    dataDirLabel: labelPath(dir),
    repoRootLabel: labelPath(repo),
    buildCommit: gitCommit(),
    nodeEnv: process.env.NODE_ENV || "development",
    latestSnapshots: Object.fromEntries(
      Object.entries(snapshots)
        .filter(([, row]) => Boolean(row?.collectedAt))
        .map(([type, row]) => [type, row?.collectedAt || ""])
    ),
  };
}

function latestByType(records: SnapshotRecord[]) {
  return Object.fromEntries(records.map((row) => [row.type, row])) as ConsoleModel["snapshots"];
}

function minutesSince(value?: string) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function moscowHour(now = new Date()) {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(value);
}

function collectionIntervalMinutes(now = new Date()) {
  const hour = moscowHour(now);
  const daySeconds = Number(process.env.GHOSTROUTE_COLLECT_DAY_INTERVAL_SECONDS || 1800);
  const nightSeconds = Number(process.env.GHOSTROUTE_COLLECT_NIGHT_INTERVAL_SECONDS || 10800);
  return Math.max(1, Math.round(((hour >= 7 && hour <= 23) ? daySeconds : nightSeconds) / 60));
}

function staleThresholdMinutes(now = new Date()) {
  const hour = moscowHour(now);
  return hour >= 7 && hour <= 23 ? 75 : 210;
}

function nextExpectedCollection(value?: string) {
  if (!value) return "";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return "";
  return new Date(ts + collectionIntervalMinutes(new Date(ts)) * 60000).toISOString();
}

const periodLabels: Record<string, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  week: "Неделя",
  month: "Месяц",
};

function trafficPeriodLabel(traffic: Record<string, any>) {
  const period = String(traffic.source?.period || "today");
  if (traffic.source?.command === "traffic-summary" && period === "today") return "";
  return periodLabels[period] || period;
}

function formatMoscowBoundary(value: string) {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return "";
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}`;
}

function trafficWindowLabel(traffic: Record<string, any>) {
  const windows = traffic.window || {};
  const raw = [windows.summary, windows.lan_wifi_samples, windows.home_reality_samples, windows.interface_samples, windows.per_device, windows.home_reality, windows.router]
    .map((value) => String(value || "").trim())
    .find((value) => value && !value.startsWith("n/a"));
  if (!raw) return "";
  const [start, end] = raw.split(" -> ").map((value) => value.trim());
  const startLabel = formatMoscowBoundary(start);
  const endLabel = end === "current router state" ? "сейчас" : formatMoscowBoundary(end);
  if (startLabel && endLabel) return `с ${startLabel} до ${endLabel}`;
  if (startLabel) return `с ${startLabel}`;
  return raw;
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
    if (filters.channel && filters.channel !== "all" && row.channel !== filters.channel && !(row.channels || []).includes(filters.channel)) return false;
    if (filters.confidence && filters.confidence !== "all" && row.confidence !== filters.confidence) return false;
    if (filters.trafficClass && filters.trafficClass !== "all" && row.trafficClass && row.trafficClass !== filters.trafficClass) return false;
    if (filters.client && filters.client !== "all" && row.client !== filters.client && row.label !== filters.client) return false;
    if (!search) return true;
    return JSON.stringify(row).toLowerCase().includes(search);
  });
}

function decorateTrafficRow(row: Record<string, any>): Record<string, any> {
  const trafficClass = trafficClassFor(row);
  return {
    ...row,
    destinationLabel: displayDestination(row),
    trafficClass,
    trafficClassLabel: trafficClassLabel(trafficClass),
  };
}

function routeFromCounters(row: Record<string, any>) {
  const vps = Number(row.via_vps_bytes || row.reality_bytes || row.vps_connections || 0);
  const direct = Number(row.direct_bytes || row.wan_bytes || row.direct_connections || 0);
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return row.route || "Unknown";
}

function deviceRoute(row: Record<string, any>) {
  const route = String(row.route || "");
  if (route && route !== "Unknown") return route;
  return routeFromCounters(row);
}

function statusFromLastSeen(value?: string) {
  const minutes = minutesSince(value);
  if (minutes === null) return "Inactive";
  if (minutes <= 15) return "Online";
  if (minutes <= 24 * 60) return "Recently seen";
  return "Inactive";
}

function keyForDevice(row: Record<string, any>) {
  const text = [row.device_id, row.id, row.label, row.client, row.profile].filter(Boolean).join(" ").toLowerCase();
  const canonical = text.match(/\b(mobile-client-\d+|mobile-source-\d+|lan-host-\d+)\b/);
  if (canonical) return canonical[1];
  return String(row.device_id || row.id || row.label || row.ip || "unknown-device").toLowerCase();
}

function deviceLabel(row: Record<string, any>) {
  return String(row.label || row.client || row.id || row.device_id || "Unknown").trim();
}

function labelScore(value?: string) {
  const label = String(value || "").toLowerCase();
  let score = label ? 1 : 0;
  if (/\b(iphone|ipad|macbook|mac book|windows|laptop|pc|private mac|apple tv)\b/.test(label)) score += 70;
  if (/\([^)]{2,}\)/.test(label)) score += 30;
  if (/^(lan-host|mobile-client|mobile-source)-\d+$/.test(label)) score -= 20;
  if (label.includes("unknown")) score -= 10;
  return score;
}

function roleScore(value?: string) {
  const role = String(value || "").toLowerCase();
  if (!role || role === "unknown device") return 0;
  if (role.includes("channel b") || role.includes("channel c")) return 90;
  if (/\b(iphone|ipad|macbook|windows|private mac|apple tv)\b/.test(role)) return 80;
  if (role.includes("home reality")) return 55;
  if (role.includes("home lan")) return 35;
  if (role.includes("unattributed")) return 25;
  return 20;
}

function addAlias(current: Record<string, any>, label?: string) {
  const value = String(label || "").trim();
  if (!value || value === "Unknown") return;
  const aliases = new Set([...(current.aliases || []), value]);
  current.aliases = Array.from(aliases).slice(0, 8);
}

function preservedChannel(row: Record<string, any>) {
  const label = String(row.label || row.client || row.id || row.device_id || "").toLowerCase();
  if (/\/\s*b\d?\b|iphone-b|channel b/.test(label)) return "Channel B";
  if (/\/\s*c\d?\b|shadowrocket|naive|channel c/.test(label)) return "Channel C";
  const channel = String(row.channel || "");
  if (channel && channel !== "Unknown") return channel;
  if (label.includes("mobile-client-")) return "A/Home Reality";
  return "Unknown";
}

function channelLabel(channels?: Array<string>) {
  const clean = Array.from(new Set((channels || []).filter((value) => value && value !== "Unknown")));
  if (clean.length === 0) return "Unknown";
  const rank = (value: string) => {
    if (value.includes("A/Home")) return 0;
    if (value.includes("Channel B")) return 1;
    if (value.includes("Channel C")) return 2;
    if (value.includes("Home Wi-Fi")) return 3;
    return 4;
  };
  return clean.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(" + ");
}

function addChannel(current: Record<string, any>, value?: string) {
  if (!value || value === "Unknown") return;
  const channels = new Set([...(current.channels || []), value]);
  current.channels = Array.from(channels);
  current.channel = channelLabel(current.channels);
}

function mergeKnownDevices(latest: Array<Record<string, any>>, includeHistory = true) {
  const byKey = new Map<string, Record<string, any>>();
  const remember = (row: Record<string, any>, fromHistory = false) => {
    const key = keyForDevice(row);
    if (!key || key === "unknown-device") return;
    const current = byKey.get(key);
    const collected = row.collected_at || row.last_seen || "";
    const label = deviceLabel(row);
    const role = row.role || deviceRole(row);
    const rowTotals = {
      total_bytes: Number(row.total_bytes || 0),
      via_vps_bytes: Number(row.via_vps_bytes || row.reality_bytes || 0),
      direct_bytes: Number(row.direct_bytes || row.wan_bytes || 0),
    };
    if (!current) {
      byKey.set(key, {
        id: key,
        label,
        ip: row.ip || row.client_ip || "",
        role,
        channel: preservedChannel(row),
        route: deviceRoute(row),
        confidence: row.confidence || "unknown",
        ...rowTotals,
        last_seen: collected,
        status: statusFromLastSeen(collected),
        from_history: fromHistory,
        channels: preservedChannel(row) !== "Unknown" ? [preservedChannel(row)] : [],
        aliases: label ? [label] : [],
        raw: row.raw || row,
      });
      return;
    }
    addAlias(current, label);
    const currentTs = Date.parse(current.last_seen || "");
    const rowTs = Date.parse(collected || "");
    const newer = Number.isFinite(rowTs) && (!Number.isFinite(currentTs) || rowTs > currentTs);
    const sameTime = Number.isFinite(rowTs) && Number.isFinite(currentTs) && rowTs === currentTs;
    if (newer) {
      current.total_bytes = rowTotals.total_bytes;
      current.via_vps_bytes = rowTotals.via_vps_bytes;
      current.direct_bytes = rowTotals.direct_bytes;
    } else if (sameTime) {
      current.total_bytes = Math.max(Number(current.total_bytes || 0), rowTotals.total_bytes);
      current.via_vps_bytes = Math.max(Number(current.via_vps_bytes || 0), rowTotals.via_vps_bytes);
      current.direct_bytes = Math.max(Number(current.direct_bytes || 0), rowTotals.direct_bytes);
    }
    if (labelScore(label) > labelScore(current.label)) {
      current.label = label;
      const labelRole = deviceRole({ ...row, label });
      if (roleScore(labelRole) >= roleScore(current.role)) {
        current.role = labelRole;
      }
    }
    if (roleScore(role) > roleScore(current.role)) {
      current.role = role;
    }
    if (newer) {
      current.last_seen = collected;
      current.status = statusFromLastSeen(collected);
      current.route = deviceRoute(row);
      current.confidence = row.confidence || current.confidence;
      current.ip = row.ip || row.client_ip || current.ip;
      current.raw = row.raw || row;
    }
    const channel = preservedChannel(row);
    addChannel(current, channel);
  };
  for (const row of latest) remember(row, false);
  if (includeHistory) {
    for (const row of knownDeviceRows()) remember(row, true);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const trafficDelta = Number(b.total_bytes || 0) - Number(a.total_bytes || 0);
    if (trafficDelta !== 0) return trafficDelta;
    const aSeen = Date.parse(a.last_seen || "");
    const bSeen = Date.parse(b.last_seen || "");
    if (Number.isFinite(aSeen) && Number.isFinite(bSeen) && aSeen !== bSeen) return bSeen - aSeen;
    return String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""));
  });
}

export function buildConsoleModel(filters: ConsoleFilters = {}): ConsoleModel {
  const snapshots = latestByType(latestSnapshots());
  const trafficSummary = snapshots.traffic_summary?.payload || {};
  const traffic = snapshots.traffic?.payload || {};
  const dashboardTraffic = trafficSummary.totals ? trafficSummary : traffic;
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

  const latestDevices = normalizedDevices.length
    ? normalizedDevices
    : [
    ...(traffic.devices || []),
    ...(traffic.home_reality_clients || []).map((row: any) => ({
      id: row.profile || row.label,
      label: row.label,
      profile: row.profile,
      channel: row.channel,
      collected_at: newest,
      total_bytes: row.total_bytes,
      via_vps_bytes: row.via_vps_bytes,
      direct_bytes: row.direct_bytes,
      route: row.route,
      confidence: row.confidence,
    })),
  ];
  const devices = mergeKnownDevices(latestDevices);

  const normalizedFlows = normalizedRows("normalized_flows").map((row: any) => decorateTrafficRow({
    client: row.client,
    client_ip: row.client_ip,
    channel: row.channel,
    destination: row.destination,
    destination_ip: row.destination_ip,
    destination_port: row.destination_port,
    route: row.route,
    confidence: row.confidence,
    bytes: row.bytes,
    connections: row.connections,
    protocol: row.protocol,
    dns_qname: row.dns_qname,
    dns_answer_ip: row.dns_answer_ip,
    sni: row.sni,
    outbound: row.outbound,
    matched_rule: row.matched_rule,
    rule_set: row.rule_set,
    egress_ip: row.egress_ip,
    egress_asn: row.egress_asn,
    egress_country: row.egress_country,
    event_ts: row.event_ts,
    ts_confidence: row.ts_confidence,
    source_log: row.source_log,
    raw: row.raw,
    collected_at: row.collected_at,
  }));

  const flows = filterRows(
    normalizedFlows.length
      ? normalizedFlows
      : [
      ...(traffic.app_flows || []).map((row: any) => decorateTrafficRow(row)),
      ...(traffic.destinations || []).map((row: any) => decorateTrafficRow({
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
    answer_ip: row.answer_ip,
    event_ts: row.event_ts,
    ts_confidence: row.ts_confidence,
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
  const staleThreshold = staleThresholdMinutes();
  const staleAlert =
    staleMinutes !== null && staleMinutes > staleThreshold
      ? [
          {
            severity: "warning",
            title: "stale snapshot",
            source: "console",
            status: "WARN",
            evidence: `${staleMinutes} minutes since latest snapshot; threshold ${staleThreshold} minutes`,
            confidence: "exact",
          },
        ]
      : [];
  const egressIdentity = {
    ...(health.egress_identity || {}),
    ip: health.egress_identity?.ip || process.env.GHOSTROUTE_VPS_EGRESS_IP || process.env.GHOSTROUTE_CONSOLE_EGRESS_IP || "",
  };
  const hasVpsEvidence =
    Number(traffic.totals?.via_vps_bytes || 0) > 0 ||
    normalizedFlows.some((row: any) => row.route === "VPS" && (Number(row.bytes || 0) > 0 || row.outbound === "reality-out"));
  const egressIdentityAlert =
    hasVpsEvidence && !egressIdentity.ip
      ? [
          {
            severity: "warning",
            title: "egress identity source not configured",
            source: "router-health-report",
            status: "WARN",
            evidence: "VPS routing is observed, but egress IP/ASN/country are not configured or observed.",
            confidence: "exact",
          },
        ]
      : [];

  const derivedNotifications = [...staleAlert, ...egressIdentityAlert, ...normalizedAlerts, ...leakAlerts, ...routingAlerts, ...collectorAlerts].map((row: any, idx) => ({
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

  const totals = dashboardTraffic.totals || {};
  return {
    generatedAt: new Date().toISOString(),
    freshnessMinutes: staleMinutes,
    freshnessStatus: staleMinutes === null ? "empty" : staleMinutes > staleThreshold || collectorErrors.length > 0 ? "stale" : "fresh",
    freshnessLabel: newest || "",
    nextExpectedCollection: nextExpectedCollection(newest),
    staleThresholdMinutes: staleThreshold,
    runtime: runtimeInfo(snapshots),
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
      periodLabel: trafficPeriodLabel(dashboardTraffic),
      windowLabel: trafficWindowLabel(dashboardTraffic),
    },
    devices: filterRows(devices.map((row: any) => ({ ...row, route: row.route || routeFromCounters(row) })), filters),
    flows,
    dnsQueries,
    alerts: [...staleAlert, ...egressIdentityAlert, ...collectorAlerts, ...normalizedAlerts, ...leakAlerts, ...routingAlerts],
    catalog,
  };
}

type PageArgs = {
  page?: number;
  pageSize?: number;
  filters?: ConsoleFilters;
  diagnostics?: boolean;
};

function clampPage(value?: number) {
  return Math.max(1, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 1);
}

function clampPageSize(value?: number, fallback = 25, max = 100) {
  const parsed = Number(value);
  return Math.max(1, Math.min(max, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

function rawJson(row: any) {
  try {
    return row.raw_json ? JSON.parse(row.raw_json) : {};
  } catch {
    return {};
  }
}

function latestIdWhere() {
  const ids = latestSnapshotIds();
  if (ids.length === 0) return { ids, sql: "1 = 0", params: [] as any[] };
  return { ids, sql: `snapshot_id in (${ids.map(() => "?").join(",")})`, params: ids as any[] };
}

function addCommonFilters(where: string[], params: any[], filters: ConsoleFilters = {}, aliases: Record<string, string> = {}) {
  const route = aliases.route || "route";
  const channel = aliases.channel || "channel";
  const confidence = aliases.confidence || "confidence";
  const client = aliases.client || "client";
  const destination = aliases.destination || "destination";
  if (filters.route && filters.route !== "all") {
    where.push(`${route} = ?`);
    params.push(filters.route);
  }
  if (filters.channel && filters.channel !== "all") {
    where.push(`${channel} = ?`);
    params.push(filters.channel);
  }
  if (filters.confidence && filters.confidence !== "all") {
    where.push(`${confidence} = ?`);
    params.push(filters.confidence);
  }
  if (filters.client && filters.client !== "all") {
    where.push(`${client} = ?`);
    params.push(filters.client);
  }
  const search = filters.search?.trim();
  if (search) {
    const needle = `%${search.toLowerCase()}%`;
    where.push(`(lower(${client}) like ? or lower(${destination}) like ? or lower(dns_qname) like ? or lower(destination_ip) like ?)`);
    params.push(needle, needle, needle, needle);
  }
}

function isUsefulClientSql(column = "client") {
  return `trim(${column}) != '' and lower(trim(${column})) not in ('unknown','client','not observed') and lower(trim(${column})) not glob '[0-9]*ms'`;
}

function notSystemDestinationSql() {
  return `coalesce(destination, destination_ip, dns_qname, '') != ''
    and destination not like '192.168.%'
    and destination not like '10.%'
    and destination not like '172.16.%'
    and destination not like '172.17.%'
    and destination not like '172.18.%'
    and destination not like '172.19.%'
    and destination not like '172.2_.%'
    and destination not like '172.30.%'
    and destination not like '172.31.%'
    and destination not like '127.%'
    and destination not like '169.254.%'
    and destination not like '0.%'
    and lower(destination) not like '%localhost%'
    and lower(destination) not like '%router.local%'
    and lower(destination) not like '%sslip.io%'`;
}

function flowSelect() {
  return `rowid as rowid, 'flow:' || rowid as id, snapshot_id, snapshot_type, collected_at,
    client, client_ip, channel, destination, destination_ip, destination_port, route, confidence,
    bytes, connections, protocol, dns_qname, dns_answer_ip, sni, outbound, matched_rule,
    rule_set, egress_ip, egress_asn, egress_country, event_ts, ts_confidence, source_log, raw_json`;
}

function mapFlowRow(row: any) {
  return decorateTrafficRow({
    id: row.id,
    rowid: row.rowid,
    client: row.client,
    client_ip: row.client_ip,
    channel: row.channel,
    destination: row.destination,
    destination_ip: row.destination_ip,
    destination_port: row.destination_port,
    route: row.route,
    confidence: row.confidence,
    bytes: Number(row.bytes || 0),
    connections: Number(row.connections || 0),
    protocol: row.protocol,
    dns_qname: row.dns_qname,
    dns_answer_ip: row.dns_answer_ip,
    sni: row.sni,
    outbound: row.outbound,
    matched_rule: row.matched_rule,
    rule_set: row.rule_set,
    egress_ip: row.egress_ip,
    egress_asn: row.egress_asn,
    egress_country: row.egress_country,
    event_ts: row.event_ts,
    ts_confidence: row.ts_confidence,
    source_log: row.source_log,
    collected_at: row.collected_at,
    raw: rawJson(row),
  });
}

export function listTrafficRows(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, 100);
  const latest = latestIdWhere();
  const where = [latest.sql];
  const params = [...latest.params];
  addCommonFilters(where, params, args.filters || {});
  if (!args.diagnostics) {
    where.push(isUsefulClientSql());
    where.push("(bytes > 0 or connections > 1)");
    where.push(notSystemDestinationSql());
  }
  const whereSql = where.map((item) => `(${item})`).join(" and ");
  const offset = (page - 1) * pageSize;
  const allRows = getDb()
    .prepare(
      `select ${flowSelect()}
         from normalized_flows
        where ${whereSql}
        order by coalesce(nullif(event_ts, ''), collected_at) desc, bytes desc, rowid desc
        limit 5000`
    )
    .all(...params)
    .map(mapFlowRow)
    .filter((row) => !args.filters?.trafficClass || args.filters.trafficClass === "all" || row.trafficClass === args.filters.trafficClass)
    .sort((a, b) => Number(b.bytes || b.total_bytes || 0) - Number(a.bytes || a.total_bytes || 0));
  const total = allRows.length;
  const rows = allRows.slice(offset, offset + pageSize);
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hiddenCount: args.diagnostics
      ? 0
      : Math.max(0, Number((getDb().prepare(`select count(*) as count from normalized_flows where ${latest.sql}`).get(...latest.params) as any)?.count || 0) - total),
  };
}

export function getTrafficRowById(id: string, filters: ConsoleFilters = {}) {
  const match = String(id || "").match(/^flow:(\d+)$/);
  if (!match) return null;
  const row = getDb().prepare(`select ${flowSelect()} from normalized_flows where rowid = ?`).get(Number(match[1])) as any;
  if (!row) return null;
  return mapFlowRow(row);
}

function buildChromeModel(filters: ConsoleFilters, overrides: Partial<ConsoleModel> = {}): ConsoleModel {
  const snapshots = latestByType(latestSnapshots());
  const trafficSummary = snapshots.traffic_summary?.payload || {};
  const traffic = snapshots.traffic?.payload || {};
  const dashboardTraffic = trafficSummary.totals ? trafficSummary : traffic;
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const domains = snapshots.domains?.payload || {};
  const newest = Object.values(snapshots)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();
  const staleMinutes = minutesSince(newest);
  const staleThreshold = staleThresholdMinutes();
  const collectorDisabled = (process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled") === "disabled";
  const collectorErrors = collectorDisabled ? [] : (latestCollectorErrors(10) as Array<Record<string, any>>);
  const leakAlerts = (leaks.leaks || []).map((row: any) => ({
    severity: row.severity || "warning",
    title: row.label || row.probe,
    source: "leak-check",
    status: row.status,
    evidence: row.evidence,
    confidence: row.confidence || "exact",
  }));
  const normalizedAlerts = normalizedRows("normalized_alerts").slice(0, 50).map((row: any) => ({
    severity: row.severity,
    title: row.title,
    source: row.snapshot_type,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence,
    raw: row.raw,
  }));
  const staleAlert =
    staleMinutes !== null && staleMinutes > staleThreshold
      ? [{
          severity: "warning",
          title: "stale snapshot",
          source: "console",
          status: "WARN",
          evidence: `${staleMinutes} minutes since latest snapshot; threshold ${staleThreshold} minutes`,
          confidence: "exact",
        }]
      : [];
  const devices = mergeKnownDevices(knownDeviceRows(200), false);
  const dnsQueries = normalizedRows("normalized_dns").slice(0, 80).map((row: any) => ({
    client: row.client,
    domain: row.domain,
    qtype: row.qtype,
    count: row.count,
    answer_ip: row.answer_ip,
    event_ts: row.event_ts,
    ts_confidence: row.ts_confidence,
    confidence: row.confidence,
    raw: row.raw,
    collected_at: row.collected_at,
  }));
  const normalizedCatalog = normalizedRows("normalized_catalog").slice(0, 500).map((row: any) => ({
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
      ].slice(0, 500);
  const statusCards = [
    { label: "Router", status: normalizeStatus(health.services?.router || health.overall), detail: formatDetail(health.router?.product) },
    { label: "Reality", status: normalizeStatus(health.services?.reality), detail: "home ingress / reality-out" },
    { label: "DNS", status: normalizeStatus(health.services?.dns), detail: "dnscrypt + policy" },
    { label: "IPv6", status: normalizeStatus(health.services?.ipv6), detail: "not in routing scope" },
    { label: "Rule-set", status: normalizeStatus(health.services?.rule_set_sync), detail: "catalog mirror" },
    { label: "Leaks", status: normalizeStatus(leaks.overall), detail: `${leakAlerts.length} signals` },
  ];
  const totals = dashboardTraffic.totals || {};
  const model: ConsoleModel = {
    generatedAt: new Date().toISOString(),
    freshnessMinutes: staleMinutes,
    freshnessStatus: staleMinutes === null ? "empty" : staleMinutes > staleThreshold || collectorErrors.length > 0 ? "stale" : "fresh",
    freshnessLabel: newest || "",
    nextExpectedCollection: nextExpectedCollection(newest),
    staleThresholdMinutes: staleThreshold,
    runtime: runtimeInfo(snapshots),
    collectorErrors,
    collectorRun: collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null),
    hourlyTraffic: hourlyTraffic() as Array<Record<string, any>>,
    events: latestEvents(80) as Array<Record<string, any>>,
    routeDecisions: latestRouteDecisions(80) as Array<Record<string, any>>,
    catalogReviews: catalogReviews() as Array<Record<string, any>>,
    notifications: notifications() as Array<Record<string, any>>,
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
      periodLabel: trafficPeriodLabel(dashboardTraffic),
      windowLabel: trafficWindowLabel(dashboardTraffic),
    },
    devices,
    flows: [],
    dnsQueries,
    alerts: [...staleAlert, ...normalizedAlerts, ...leakAlerts],
    catalog,
  };
  return { ...model, ...overrides };
}

export function buildPagedEvidenceContext(filters: ConsoleFilters, flows: Array<Record<string, any>>) {
  return buildChromeModel(filters, { flows });
}

function clientSearch(row: Record<string, any>, search?: string) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [row.label, row.id, row.ip, row.channel, row.route].filter(Boolean).join(" ").toLowerCase().includes(needle);
}

export function listClientInventory(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, 100);
  const rows = mergeKnownDevices(knownDeviceRows(2000), false)
    .filter((row) => {
      const total = Number(row.total_bytes || 0);
      const confidence = String(row.confidence || "");
      const label = String(row.label || row.id || "");
      if (total <= 0 && confidence === "dns-interest" && /\/\s*[bc]\d?$/i.test(label)) return false;
      if (
        args.filters?.channel &&
        args.filters.channel !== "all" &&
        row.channel !== args.filters.channel &&
        !(row.channels || []).includes(args.filters.channel)
      ) return false;
      if (args.filters?.route && args.filters.route !== "all" && routeFromCounters(row) !== args.filters.route) return false;
      if (args.filters?.confidence && args.filters.confidence !== "all" && row.confidence !== args.filters.confidence) return false;
      if (args.filters?.client && args.filters.client !== "all" && row.label !== args.filters.client && row.id !== args.filters.client) return false;
      return clientSearch(row, args.filters?.search);
    });
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    total: rows.length,
    page: effectivePage,
    pageSize,
    totalPages,
  };
}

function originForLive(row: Record<string, any>) {
  const client = String(row.client || row.client_ip || "").trim();
  const source = String(row.source_log || row.source || "").toLowerCase();
  if (client && !["client", "unknown", "not observed"].includes(client.toLowerCase())) return client;
  if (source.includes("dnsmasq")) return "Router DNS service";
  if (source.includes("sing-box")) return "Router/sing-box";
  if (String(row.event_type || "").includes("collector")) return "Collector";
  return "System";
}

function mapLiveRow(row: any) {
  const eventType = row.event_type || "route.decision";
  return decorateTrafficRow({
    id: `${row.kind}:${row.id}`,
    source_kind: row.kind,
    event_type: eventType,
    occurred_at: row.occurred_at,
    origin: originForLive(row),
    client: row.client,
    client_ip: row.client_ip,
    channel: row.channel,
    destination: row.destination || row.dns_qname || row.summary || row.destination_ip,
    route: row.route || "Unknown",
    confidence: row.confidence || "unknown",
    summary: row.summary || "",
    source_log: row.source_log || "",
  });
}

export function listLiveEvents(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 50, 50);
  const offset = (page - 1) * pageSize;
  const union = `
    select 'event' as kind, id, event_type, occurred_at, client, client_ip, channel, destination, dns_qname, destination_ip, route, confidence, summary, source_log
      from events
    union all
    select 'route_decision' as kind, id, 'route.decision' as event_type, occurred_at, client, client_ip, channel, destination, dns_qname, destination_ip, route, confidence, '' as summary, source_log
      from route_decisions`;
  const filter = { ...(args.filters || {}), trafficClass: args.filters?.trafficClass || "client" };
  const candidates = getDb()
    .prepare(`select * from (${union}) order by occurred_at desc, id desc limit 500`)
    .all()
    .map(mapLiveRow)
    .filter((row) => filterRows([row], filter).length > 0);
  const total = candidates.length;
  const rows = candidates.slice(offset, offset + pageSize);
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
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
    trafficClasses: trafficClasses.map((value) => ({ value, label: trafficClassLabel(value) })),
  };
}
