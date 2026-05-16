import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import type { ConsoleFilters, ConsoleModel, SnapshotRecord } from "./types";
import { dataDir, repoRoot } from "./paths";
import { alarmStatusMatches, overlayAlarmState, readAlarmState } from "./alarm-state";
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
  latestSnapshotMetas,
  latestSnapshots,
  latestSnapshotsForTypes,
  normalizedRows,
  notificationSettings,
  notifications,
  opsRuns,
} from "./store";
import {
  deviceReviewState,
  deviceRole,
  displayDestination,
  trafficClassFor,
  trafficClassLabel,
  trafficClasses,
} from "../traffic-classification.mjs";
import {
  applyDeviceAttribution,
  canonicalDeviceKey,
  displayDeviceLabel,
  loadDeviceAttributions,
  resolveClient,
} from "../device-attribution.mjs";
import {
  dedupeAlerts,
  moscowDateKey,
  reconcileTrafficRows,
  snapshotMatchesPeriod,
  isPrimaryTrafficDestinationLabel,
  trafficPresentationBytes,
  trafficDisplayDestination,
} from "../traffic-window.mjs";
import { classifyAppFamily, isClientFacingAppFamily } from "../app-family.mjs";
import { normalizeRoutingPolicySnapshot } from "../routing-policy-snapshot.mjs";
import {
  attributionEligibility,
  decorateAttributionEligibility,
  isAggregateResidualLabel,
  isAttributableSiteRow,
  isInternalGhostRouteRow,
  isIpOnlyAttributionLabel,
  isUsefulCoarseAttribution,
} from "../attribution-eligibility.mjs";
import { buildDashboardAnalyticsFromRows } from "../dashboard-analytics.mjs";
import { bucketStartUtc, mskWindowBounds } from "../time/window.mjs";

const routes = new Set(["VPS", "Direct", "Mixed", "Unknown"]);
const TRAFFIC_DETAIL_TYPES = new Set(["traffic_facts", "traffic"]);
const TRAFFIC_DEVICE_TYPES = new Set(["traffic_facts", "traffic_summary", "traffic"]);
const TRAFFIC_DNS_TYPES = new Set(["dns", "traffic_evidence", "traffic"]);
const ALERT_CONTEXT_TYPES = new Set(["traffic_facts", "traffic_summary", "traffic_evidence", "dns", "health", "leaks", "domains"]);
const DERIVED_CACHE_TTL_MS = Number(process.env.GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS || 300_000);
const derivedCache = new Map<string, { expiresAt: number; value: any }>();
const USE_PREPARED_WINDOWS = process.env.GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS !== "0";

function dbContentVersion() {
  try {
    const db = getDb();
    const snapshots = db
      .prepare("select count(*) as count, max(collected_at) as max_collected from snapshots")
      .get() as { count?: number; max_collected?: string } | undefined;
    const collectors = db
      .prepare("select count(*) as count, max(coalesce(finished_at, started_at)) as max_run from collector_runs")
      .get() as { count?: number; max_run?: string } | undefined;
    const prepared = db
      .prepare("select count(*) as count, max(computed_at_utc) as max_computed from traffic_window_snapshots")
      .get() as { count?: number; max_computed?: string } | undefined;
    return [
      snapshots?.count || 0,
      snapshots?.max_collected || "",
      collectors?.count || 0,
      collectors?.max_run || "",
      prepared?.count || 0,
      prepared?.max_computed || "",
    ].join(":");
  } catch {
    return "unknown";
  }
}

function cacheGet<T>(key: string, build: () => T): T {
  if (DERIVED_CACHE_TTL_MS <= 0) return build();
  const now = Date.now();
  const cached = derivedCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;
  const value = build();
  derivedCache.set(key, { expiresAt: now + DERIVED_CACHE_TTL_MS, value });
  return value;
}

export function clearDerivedCache() {
  derivedCache.clear();
}

function latestSnapshotMetaRecords() {
  return cacheGet(`latest-snapshot-metas:${dbContentVersion()}`, () => latestSnapshotMetas());
}

function latestSnapshotMetaVersion(records = latestSnapshotMetaRecords()) {
  return records.map((row) => `${row.type}:${row.collectedAt}`).sort().join("|") || "empty";
}

function latestSnapshotRecords() {
  return cacheGet(`latest-snapshots:${latestSnapshotMetaVersion()}`, () => latestSnapshots());
}

function latestSnapshotVersion(records = latestSnapshotMetaRecords()) {
  return records.map((row) => `${row.type}:${row.collectedAt}`).sort().join("|") || "empty";
}

function cachedLatestByType() {
  const records = latestSnapshotRecords();
  return cacheGet(`latest-by-type:${latestSnapshotVersion(records)}`, () => latestByType(records));
}

function cachedLatestByTypes(types: Array<SnapshotRecord["type"]>) {
  const keyTypes = Array.from(new Set(types)).sort();
  return cacheGet(`latest-by-types:${latestSnapshotMetaVersion()}:${keyTypes.join(",")}`, () => latestByType(latestSnapshotsForTypes(keyTypes)));
}

function definedOverrides<T extends Record<string, any>>(overrides: T): Partial<T> {
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function maxIso(...values: Array<string | undefined>) {
  return values.filter(Boolean).sort((a, b) => Date.parse(String(b)) - Date.parse(String(a)))[0] || "";
}

function isoPlusMs(iso: string, ms: number) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function isoMinusHours(iso: string, hours: number) {
  return new Date(Date.parse(iso) - hours * 3600000).toISOString();
}

function isIpv4Literal(value: unknown) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || ""));
}

function windowAggregateSegmentsForSelector(window = "today", now = new Date()) {
  const nowIso = now.toISOString();
  const bounds = mskWindowBounds(window, now);
  const todayStart = mskWindowBounds("today", now).startUtc;
  const weekStart = mskWindowBounds("week", now).startUtc;
  const freshHours = Math.max(1, Number(process.env.GHOSTROUTE_PREPARED_FINE_HOURS || 2));
  const freshStart = maxIso(todayStart, bucketStartUtc(isoMinusHours(nowIso, freshHours), "hour"));
  const endExclusive = isoPlusMs(bounds.endUtc, 1);
  const segments: Array<{ layer: "weekly" | "daily" | "hourly" | "5min"; start: string; end: string }> = [];
  if (window === "month" && Date.parse(bounds.startUtc) < Date.parse(weekStart)) {
    segments.push({ layer: "weekly", start: bounds.startUtc, end: weekStart });
  }
  const dailyStart = window === "month" ? maxIso(bounds.startUtc, weekStart) : bounds.startUtc;
  if (window !== "today" && Date.parse(dailyStart) < Date.parse(todayStart)) {
    segments.push({ layer: "daily", start: dailyStart, end: todayStart });
  }
  const hourlyStart = maxIso(bounds.startUtc, todayStart);
  if (Date.parse(hourlyStart) < Date.parse(freshStart)) {
    segments.push({ layer: "hourly", start: hourlyStart, end: freshStart });
  }
  if (Date.parse(freshStart) < Date.parse(endExclusive)) {
    segments.push({ layer: "5min", start: freshStart, end: endExclusive });
  }
  return segments;
}

export function getConsolePageSummary(page: "health_mobile" | "health_shell" | "live_mobile" | string) {
  return cacheGet(`console-page-summary:${page}`, () => {
    try {
      const row = getDb()
        .prepare("select page, source_version, rebuilt_at, payload_json from console_page_summaries where page = ?")
        .get(page) as { page: string; source_version: string; rebuilt_at: string; payload_json: string } | undefined;
      if (!row) return null;
      return {
        page: row.page,
        source_version: row.source_version,
        rebuilt_at: row.rebuilt_at,
        payload: JSON.parse(row.payload_json || "{}"),
      };
    } catch {
      return null;
    }
  });
}

function preparedWindowVersion(kind: string, period = "today", trafficClass = "client") {
  if (!USE_PREPARED_WINDOWS) return "disabled";
  const window = ["today", "week", "month"].includes(period || "today") ? period || "today" : "today";
  try {
    const row = getDb()
      .prepare(
        `select source_version, computed_at_utc
           from traffic_window_snapshots
          where kind = ? and window = ? and traffic_class = ?
          limit 1`
      )
      .get(kind, window, trafficClass) as { source_version?: string; computed_at_utc?: string } | undefined;
    return row ? `${row.source_version || ""}:${row.computed_at_utc || ""}` : "missing";
  } catch {
    return "missing";
  }
}

function getPreparedWindowSnapshot(kind: string, period = "today", trafficClass = "client") {
  if (!USE_PREPARED_WINDOWS) return null;
  const window = ["today", "week", "month"].includes(period || "today") ? period || "today" : "today";
  return cacheGet(`prepared-window:${kind}:${window}:${trafficClass}:${preparedWindowVersion(kind, window, trafficClass)}`, () => {
    try {
      const row = getDb()
        .prepare(
          `select kind, window, traffic_class, window_start_utc, window_end_utc, source_version,
                  computed_at_utc, payload_json
             from traffic_window_snapshots
            where kind = ? and window = ? and traffic_class = ?
            limit 1`
        )
        .get(kind, window, trafficClass) as Record<string, any> | undefined;
      if (!row) return null;
      return {
        kind: row.kind,
        window: row.window,
        trafficClass: row.traffic_class,
        windowStartUtc: row.window_start_utc,
        windowEndUtc: row.window_end_utc,
        sourceVersion: row.source_version,
        computedAtUtc: row.computed_at_utc,
        payload: JSON.parse(row.payload_json || "{}"),
      };
    } catch {
      return null;
    }
  });
}

function preparedDashboard(period = "today", trafficClass = "all") {
  return getPreparedWindowSnapshot("dashboard", period, trafficClass || "all")?.payload || null;
}

function filtersKey(filters: ConsoleFilters = {}) {
  return JSON.stringify({
    period: filters.period || "today",
    route: filters.route || "all",
    channel: filters.channel || "all",
    client: filters.client || "all",
    confidence: filters.confidence || "all",
    trafficClass: filters.trafficClass || "all",
    search: filters.search || "",
  });
}

function pageArgsKey(args: PageArgs = {}) {
  return JSON.stringify({
    page: clampPage(args.page),
    pageSize: args.pageSize,
    maxPageSize: args.maxPageSize,
    maxRows: args.maxRows,
    diagnostics: Boolean(args.diagnostics),
    presentationWeight: Boolean(args.presentationWeight),
    clientTarget: args.clientTarget ? {
      id: args.clientTarget.id,
      label: args.clientTarget.label,
      client_key: args.clientTarget.client_key,
      client_label: args.clientTarget.client_label,
      device_key: args.clientTarget.device_key,
      device_label: args.clientTarget.device_label,
      aliases: args.clientTarget.aliases,
      observed_aliases: args.clientTarget.observed_aliases,
      observed_identities: args.clientTarget.observed_identities,
    } : undefined,
    filters: filtersKey(args.filters || {}),
  });
}

function dnsPageArgsKey(args: DnsPageArgs = {}) {
  return JSON.stringify({
    page: clampPage(args.page),
    pageSize: args.pageSize,
    status: args.status || "all",
    catalogStatus: args.catalogStatus || "all",
    filters: filtersKey(args.filters || {}),
  });
}

function alarmPageArgsKey(args: AlarmPageArgs = {}) {
  return JSON.stringify({
    page: clampPage(args.page),
    pageSize: args.pageSize,
    severity: args.severity || "all",
    status: args.status || "all",
    source: args.source || "all",
    filters: filtersKey(args.filters || {}),
  });
}

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

function buildAt() {
  const value = String(process.env.GHOSTROUTE_CONSOLE_BUILD_AT || "").trim();
  if (value && value !== "unknown") return value;
  try {
    return execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: repoRoot(), encoding: "utf8", timeout: 1000 }).trim();
  } catch {
    return "";
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
    buildAt: buildAt(),
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
  today: "Today",
  yesterday: "Yesterday",
  week: "Week",
  month: "Month",
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
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}:${pick("second")}.${String(new Date(ts).getMilliseconds()).padStart(3, "0")}`;
}

function trafficWindowLabel(traffic: Record<string, any>) {
  const windows = traffic.window || {};
  const raw = [windows.summary, windows.lan_wifi_samples, windows.home_reality_samples, windows.interface_samples, windows.per_device, windows.home_reality, windows.router]
    .map((value) => String(value || "").trim())
    .find((value) => value && !value.startsWith("n/a"));
  if (!raw) return "";
  const [start, end] = raw.split(" -> ").map((value) => value.trim());
  const startLabel = formatMoscowBoundary(start);
  const endLabel = end === "current router state" ? "now" : formatMoscowBoundary(end);
  if (startLabel && endLabel) return `from ${startLabel} to ${endLabel}`;
  if (startLabel) return `from ${startLabel}`;
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
    if (filters.trafficClass && filters.trafficClass !== "all" && row.trafficClass && row.trafficClass !== filters.trafficClass) {
      if (!(filters.trafficClass === "client" && (row.accounting_bucket || row.raw?.accounting_bucket))) return false;
    }
    if (filters.client && filters.client !== "all") {
      const requested = resolveClient(filters.client);
      const rowResolved = resolveClient({ ...row, profile: row.profile || row.raw?.profile });
      const requestedKey = requested.client_key || canonicalDeviceKey(filters.client);
      const rowKey = row.client_key || rowResolved.client_key || canonicalDeviceKey(row);
      const aliases = [
        row.client_key,
        row.device_key,
        row.client_label,
        row.client,
        row.raw_client,
        row.label,
        row.id,
        row.device_id,
        ...(row.aliases || []),
        ...(row.observed_aliases || []),
        ...(rowResolved.observed_aliases || []),
      ].filter(Boolean).map(String);
      if (requestedKey && rowKey && requestedKey === rowKey) {
        // same canonical device
      } else if (!aliases.includes(filters.client) && !aliases.map((value) => value.toLowerCase()).includes(String(filters.client).toLowerCase())) {
        return false;
      }
    }
    if (!search) return true;
    return JSON.stringify(row).toLowerCase().includes(search);
  });
}

function inventoryIdentityForTrafficRow(row: Record<string, any>) {
  const candidate = String(row.client_ip || (ipv4Literal(row.client) ? row.client : "") || "").trim();
  if (!candidate) return null;
  return cacheGet(`traffic-inventory-identity:${latestSnapshotVersion()}:${candidate}`, () => {
    try {
      const inventory = getDb().prepare(`
        select device_key, label, ip, hostname, profile, device_type, channel, confidence
          from device_inventory
         where ip = ?
         order by last_seen desc
         limit 1
      `).get(candidate) as Record<string, any> | undefined;
      if (!inventory) return null;
      const resolved = resolveClient({
        client: inventory.label,
        label: inventory.label,
        client_ip: inventory.ip,
        ip: inventory.ip,
        device_key: inventory.device_key,
        profile: inventory.profile,
        hostname: inventory.hostname,
      });
      return {
        ...inventory,
        label: inventory.label || "",
        ip: inventory.ip || "",
        profile: inventory.profile || "",
        device_type: inventory.device_type || "",
        client_key: resolved.client_key || inventory.device_key || inventory.ip || "",
        client_label: resolved.client_label || inventory.label || inventory.hostname || inventory.ip || "",
        device_key: resolved.device_key || inventory.device_key || resolved.client_key || "",
        device_label: resolved.device_label || resolved.client_label || inventory.label || "",
        client_channel: resolved.client_channel || inventory.channel || "",
        matched_by: resolved.matched_by || "device_inventory_ip",
      };
    } catch {
      return null;
    }
  });
}

function decorateTrafficRow(row: Record<string, any>): Record<string, any> {
  const trafficClass = row.trafficClass || row.traffic_class || trafficClassFor(row);
  const rawClient = row.client;
  const rawProfile = row.profile || row.raw?.profile || "";
  const raw = row.raw || {};
  const inventoryIdentity = inventoryIdentityForTrafficRow(row);
  const resolved = resolveClient({
    ...row,
    label: row.label || inventoryIdentity?.label,
    device_key: row.device_key || inventoryIdentity?.device_key,
    profile: rawProfile || inventoryIdentity?.profile,
    ip: row.client_ip || inventoryIdentity?.ip,
  });
  const resolvedLooksLikeIp = isIpv4Literal(resolved.client_label)
    || isIpv4Literal(resolved.client_key)
    || (isIpv4Literal(row.client) && resolved.client_label === row.client);
  const inventoryClient = inventoryIdentity?.client_label || inventoryIdentity?.label || "";
  const preferInventoryClient = Boolean(inventoryClient && (resolvedLooksLikeIp || !resolved.client_key));
  const client = (preferInventoryClient ? inventoryClient : resolved.client_label)
    || inventoryClient
    || displayDeviceLabel(row.client || row.label || row.device_id || row.id || "");
  const bytes = Number(row.bytes || row.total_bytes || raw.bytes || 0);
  const bytesUp = Number(row.bytes_up || raw.bytes_up || raw.out_bytes || 0);
  const bytesDown = Number(row.bytes_down || raw.bytes_down || raw.in_bytes || 0);
  const viaVps = Number(row.via_vps_bytes || raw.via_vps_bytes || 0);
  const direct = Number(row.direct_bytes || raw.direct_bytes || 0);
  const unknown = Number(row.unknown_bytes || raw.unknown_bytes || 0);
  return {
    ...row,
    raw_client: rawClient,
    raw_profile: rawProfile,
    client,
    client_key: (preferInventoryClient ? inventoryIdentity?.client_key : resolved.client_key) || inventoryIdentity?.client_key || row.client_key || "",
    client_label: client,
    device_key: (preferInventoryClient ? inventoryIdentity?.device_key : resolved.device_key) || inventoryIdentity?.device_key || resolved.client_key || row.device_key || "",
    device_label: (preferInventoryClient ? inventoryIdentity?.device_label : resolved.device_label) || inventoryIdentity?.device_label || resolved.client_label || client,
    client_role: resolved.client_role || row.client_role || "",
    owner: resolved.client_owner || row.owner || "",
    device_type: resolved.device_type || row.device_type || inventoryIdentity?.device_type || "",
    client_channel: (preferInventoryClient ? inventoryIdentity?.client_channel : resolved.client_channel) || row.client_channel || inventoryIdentity?.client_channel || "",
    matched_by: (preferInventoryClient ? inventoryIdentity?.matched_by : resolved.matched_by) || inventoryIdentity?.matched_by,
    attribution_confidence: resolved.attribution_confidence,
    accounting_bucket: Boolean(row.accounting_bucket || row.raw?.accounting_bucket),
    unattributed_reason: row.unattributed_reason || row.raw?.unattributed_reason || "",
    observed_aliases: Array.from(new Set([...(row.observed_aliases || []), row.client, row.raw?.client, rawProfile, row.label, ...(resolved.observed_aliases || [])].filter(Boolean).map(String))).slice(0, 16),
    label: row.label ? (resolved.client_label || displayDeviceLabel(row.label)) : row.label,
    physical_device_key: resolved.device_key || resolved.client_key || canonicalDeviceKey(row.client || row.label || row.device_id || row.id || ""),
    destinationLabel: displayDestination(row),
    trafficClass,
    trafficClassLabel: trafficClassLabel(trafficClass),
    route_meta: {
      intended_route: row.intended_route || raw.intended_route || row.route || "Unknown",
      source: row.route_source || raw.route_source || "",
      basis: row.route_basis || raw.route_basis || "",
      matched_ipset: row.matched_ipset || raw.matched_ipset || "",
      verification: row.route_verification || raw.route_verification || "",
      status: row.route_status || raw.route_status || "",
      egress_iface: row.egress_iface || raw.egress_iface || "",
      fwmark: row.fwmark || raw.fwmark || "",
    },
    attribution: {
      bytes,
      bytes_up: bytesUp,
      bytes_down: bytesDown,
      via_vps: viaVps,
      direct,
      unknown,
      accounting_status: row.accounting_status || raw.accounting_status || "ok",
      confidence: row.byte_confidence || raw.byte_confidence || row.confidence || "unknown",
    },
    dns_link: {
      id: row.dns_link_id || raw.dns_link_id || "",
      qname: row.dns_qname || raw.dns_qname || "",
      answer_ip: row.dns_answer_ip || raw.dns_answer_ip || "",
      confidence: row.dns_link_confidence || raw.dns_link_confidence || "",
      status: row.dns_status || raw.dns_status || "",
      ts_source: row.dns_ts_source || raw.dns_ts_source || "",
    },
  };
}

function normalizedNetworkHint(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/-/g, ":");
}

function isLocalServiceAddress(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (text === "localhost" || text === "::1" || text.startsWith("127.")) return true;
  return text === "0.0.0.0";
}

function isPrivateAddress(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return isLocalServiceAddress(text)
    || text.startsWith("10.")
    || text.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(text)
    || text.startsWith("169.254.");
}

function isTrustedDeviceCounterSource(row: Record<string, any>, rawRow: Record<string, any> = {}) {
  const ip = String(row.ip || row.client_ip || rawRow.ip || rawRow.client_ip || "").trim();
  if (ip) return isPrivateAddress(ip);
  const channel = String(row.channel || rawRow.channel || row.profile || rawRow.profile || "").toLowerCase();
  return channel.includes("home wi-fi") || channel.includes("wifi") || channel.includes("lan");
}

let inventoryHintCacheKey = "";
let inventoryHintCache = new Map<string, string>();

function inventoryNetworkHints(registry = loadDeviceAttributions()) {
  const cacheKey = `${latestSnapshotVersion()}:${registry.sourcePath || ""}`;
  if (inventoryHintCacheKey === cacheKey) return inventoryHintCache;
  const hints = new Map<string, string>();
  const clients = registry.clients as Record<string, Record<string, any>>;
  try {
    for (const row of knownDeviceRows(2000) as Array<Record<string, any>>) {
      const resolved = resolveClient({ ...row, raw: { profile: row.profile, ip: row.ip, mac: row.mac } }, registry);
      if (!clients[String(resolved.client_key || "")]) continue;
      const aliases = Array.isArray(row.aliases) ? row.aliases : [];
      for (const candidate of [row.ip, row.mac, row.hostname, row.device_key, row.id, row.label, row.profile, ...aliases]) {
        const key = normalizedNetworkHint(candidate);
        if (key) hints.set(key, resolved.client_key);
      }
    }
  } catch {
    // Keep fallback attribution best-effort; prepared windows remain authoritative.
  }
  inventoryHintCacheKey = cacheKey;
  inventoryHintCache = hints;
  return inventoryHintCache;
}

function registeredClientResolution(row: Record<string, any>) {
  const registry = loadDeviceAttributions();
  const clients = registry.clients as Record<string, Record<string, any>>;
  const rawProfile = row.profile || row.raw_profile || row.raw?.profile || "";
  const resolved = resolveClient({ ...row, profile: rawProfile }, registry);
  if (clients[String(resolved.client_key || "")]) return resolved;
  const hints = inventoryNetworkHints(registry);
  for (const candidate of [row.client_ip, row.ip, row.source_ip, row.mac, row.device_key, row.id, row.raw?.client_ip, row.raw?.ip, row.raw?.source_ip, row.raw?.mac]) {
    const key = hints.get(normalizedNetworkHint(candidate));
    if (!key || !clients[key]) continue;
    const entry = clients[key];
    return {
      client_key: key,
      client_label: entry.label,
      device_key: entry.device_key || key,
      device_label: entry.device_label || entry.label,
      client_role: entry.role,
      client_owner: entry.owner,
      device_type: entry.device_type || entry.profile_type,
      client_channel: entry.primary_channel || entry.channel,
      matched_by: "device_inventory_network_hint",
      attribution_confidence: entry.confidence || "operator-local",
      observed_aliases: [String(candidate || "")].filter(Boolean),
    };
  }
  return null;
}

function pseudoClientLabel(row: Record<string, any>) {
  const label = String(row.label || row.client_label || row.client || row.id || "").trim().toLowerCase();
  return /^(a\/home reality|b\/xhttp relay|c\d?\b|dns-interest|service|accounting)/i.test(label);
}

function positiveNumber(...values: Array<unknown>) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function observedByteValue(row: Record<string, any>) {
  return positiveNumber(row.total_bytes, row.bytes, row.observed_bytes)
    || Number(row.via_vps_bytes || row.vps_bytes || row.reality_bytes || 0)
      + Number(row.direct_bytes || row.wan_bytes || 0)
      + Number(row.unknown_bytes || row.unresolved_bytes || 0);
}

function operatorTrafficRow(row: Record<string, any>, options: { allowAccountingBucket?: boolean } = {}): Record<string, any> | null {
  const decorated = decorateTrafficRow(row);
  const total = observedByteValue(decorated);
  if (total <= 0) return null;
  if (!options.allowAccountingBucket && decorated.accounting_bucket) return null;
  if (String(decorated.confidence || "").toLowerCase() === "dns-interest") return null;
  const rowClass = decorated.trafficClass || decorated.traffic_class || trafficClassFor(decorated);
  if (!["client", "personal_cloud"].includes(String(rowClass))) return null;
  if (pseudoClientLabel(decorated)) return null;
  const resolved = registeredClientResolution(decorated);
  if (!resolved) return null;
  return {
    ...decorated,
    bytes: total,
    total_bytes: total,
    client: resolved.client_label || decorated.client,
    client_key: resolved.client_key,
    client_label: resolved.client_label || decorated.client_label,
    device_key: resolved.device_key || decorated.device_key,
    device_label: resolved.device_label || decorated.device_label,
    label: resolved.client_label || decorated.label,
    channel: resolved.client_channel || decorated.channel,
    matched_by: resolved.matched_by || decorated.matched_by,
  };
}

function operatorClientRow(row: Record<string, any>): Record<string, any> | null {
  const total = observedByteValue(row);
  if (total <= 0) return null;
  if (String(row.confidence || "").toLowerCase() === "dns-interest") return null;
  if (pseudoClientLabel(row)) return null;
  const resolved = registeredClientResolution({
    ...row,
    trafficClass: "client",
    traffic_class: "client",
    client_key: row.client_key || row.device_key || row.client || row.id || "",
    client_label: row.client_label || row.label || row.client || "",
  });
  if (!resolved) return null;
  const canonicalLabel = resolved.client_label || row.client_label || row.label || row.client || row.id || "";
  if (pseudoClientLabel({ ...row, label: canonicalLabel })) return null;
  const viaVpsBytes = Number(row.via_vps_bytes || row.vps_bytes || row.reality_bytes || 0);
  const directBytes = Number(row.direct_bytes || row.wan_bytes || 0);
  const unknownBytes = Number(row.unknown_bytes || Math.max(0, total - viaVpsBytes - directBytes));
  const route = row.route && row.route !== "Unknown"
    ? row.route
    : routeFromCounters({ ...row, total_bytes: total, via_vps_bytes: viaVpsBytes, direct_bytes: directBytes });
  return {
    ...row,
    id: resolved.device_key || resolved.client_key || row.id || row.device_key,
    label: canonicalLabel,
    client: canonicalLabel,
    client_key: resolved.client_key,
    client_label: canonicalLabel,
    device_key: resolved.device_key || row.device_key || resolved.client_key,
    device_label: resolved.device_label || row.device_label || canonicalLabel,
    client_role: resolved.client_role || row.client_role || row.role || "",
    owner: resolved.client_owner || row.owner || "",
    device_type: resolved.device_type || row.device_type || "",
    client_channel: resolved.client_channel || row.client_channel || "",
    channel: resolved.client_channel || row.channel || "Unknown",
    matched_by: resolved.matched_by || row.matched_by,
    attribution_confidence: resolved.attribution_confidence || row.attribution_confidence,
    confidence: row.confidence || resolved.attribution_confidence || "operator-local",
    trafficClass: "client",
    traffic_class: "client",
    total_bytes: total,
    bytes: total,
    via_vps_bytes: viaVpsBytes,
    direct_bytes: directBytes,
    unknown_bytes: unknownBytes,
    route,
    traffic_window_active: true,
    status: row.status || statusFromLastSeen(row.last_seen || row.collected_at || row.traffic_collected_at),
    observed_aliases: Array.from(new Set([...(row.observed_aliases || []), ...(resolved.observed_aliases || [])].filter(Boolean).map(String))).slice(0, 16),
  };
}

function operatorDnsRow(row: Record<string, any>): Record<string, any> | null {
  if (!row.domain && !row.dns_qname && !row.destination) return null;
  const resolved = registeredClientResolution({
    ...row,
    client_key: row.device_key || row.client_key || row.client || "",
    client_label: row.client_label || row.client || "",
  });
  if (!resolved) {
    const trafficClass = row.trafficClass || row.traffic_class || trafficClassFor(row);
    const rawClient = row.raw_client || row.client || row.client_label || row.device_key || row.client_ip || "";
    const sourceHints = [row.client_ip, row.client, row.client_label, row.device_key, row.raw?.client_ip, row.raw?.client];
    const localServiceSource = sourceHints.some(isLocalServiceAddress);
    const privateUnresolvedSource = sourceHints.some(isPrivateAddress);
    const serviceLabel = localServiceSource
      ? "Router DNS service"
      : trafficClass === "service_background"
        ? "Service DNS source"
        : "Unattributed DNS source";
    const clientLabel = privateUnresolvedSource || trafficClass === "service_background"
      ? serviceLabel
      : row.client_label || row.client || row.device_key || row.client_ip || serviceLabel;
    return {
      ...row,
      raw_client: rawClient,
      client: clientLabel,
      client_key: "",
      client_label: clientLabel,
      device_key: "",
      device_label: clientLabel,
      channel: row.client_channel || row.channel || "Unknown",
      client_attributed: false,
    };
  }
  return {
    ...row,
    client: resolved.client_label || row.client,
    client_key: resolved.client_key,
    client_label: resolved.client_label || row.client_label,
    device_key: resolved.device_key || row.device_key,
    device_label: resolved.device_label || row.device_label,
    channel: resolved.client_channel || row.client_channel || row.channel || "Unknown",
    client_channel: resolved.client_channel || row.client_channel || "",
    matched_by: resolved.matched_by || row.matched_by,
    client_attributed: true,
  };
}

function dnsRouteValue(value: unknown) {
  return String(value || "").toLowerCase() === "vps" ? "VPS" : "Direct";
}

function operatorLiveRow(row: Record<string, any>): Record<string, any> | null {
  if (pseudoClientLabel(row)) return null;
  const resolved = registeredClientResolution({
    ...row,
    client_key: row.client_key || row.device_key || row.client || row.id || "",
    client_label: row.client_label || row.label || row.client || "",
  });
  if (!resolved) return null;
  const canonicalLabel = resolved.client_label || row.client_label || row.label || row.client || "";
  if (pseudoClientLabel({ ...row, label: canonicalLabel })) return null;
  return {
    ...row,
    client: canonicalLabel,
    client_key: resolved.client_key,
    client_label: canonicalLabel,
    device_key: resolved.device_key || row.device_key,
    device_label: resolved.device_label || row.device_label || canonicalLabel,
    label: canonicalLabel,
    channel: resolved.client_channel || row.channel,
    matched_by: resolved.matched_by || row.matched_by,
    trafficClass: "client",
    traffic_class: "client",
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

function splitCounters(row: Record<string, any>, totalBytes = Number(row.bytes || row.total_bytes || 0)) {
  const viaVpsBytes = Number(row.via_vps_bytes || row.reality_bytes || 0);
  const directBytes = Number(row.direct_bytes || row.wan_bytes || 0);
  let unknownBytes = Number(row.unknown_bytes || row.unresolved_bytes || 0);
  if (totalBytes > 0 && viaVpsBytes + directBytes + unknownBytes === 0) {
    unknownBytes = totalBytes;
  } else if (totalBytes > viaVpsBytes + directBytes + unknownBytes) {
    unknownBytes += totalBytes - viaVpsBytes - directBytes - unknownBytes;
  }
  return {
    via_vps_bytes: viaVpsBytes,
    direct_bytes: directBytes,
    unknown_bytes: unknownBytes,
  };
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
  const resolved = resolveClient({ ...row, profile: row.profile || row.raw?.profile });
  const canonical = resolved.device_key || resolved.client_key || canonicalDeviceKey({ ...row, profile: row.profile || row.raw?.profile });
  if (canonical) return canonical;
  return String(row.device_id || row.id || row.label || row.ip || "unknown-device").toLowerCase();
}

function deviceLabel(row: Record<string, any>) {
  const resolved = resolveClient({ ...row, profile: row.profile || row.raw?.profile });
  return resolved.device_label || resolved.client_label || displayDeviceLabel({ ...row, profile: row.profile || row.raw?.profile });
}

function rawDeviceKey(row: Record<string, any>) {
  return canonicalDeviceKey(row.device_id || row.id || row.profile || row.raw?.profile || row.label || row.client)
    || String(row.device_id || row.id || row.profile || row.label || row.client || row.ip || "").toLowerCase();
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
  current.aliases = Array.from(aliases).slice(0, 24);
}

function deviceAliasTokens(row: Record<string, any>, key = keyForDevice(row), label = deviceLabel(row)) {
  const raw = row.raw || {};
  return Array.from(new Set([
    label,
    key,
    row.id,
    row.device_id,
    row.device_key,
    row.client_key,
    row.client_label,
    row.label,
    row.client,
    row.ip,
    row.client_ip,
    raw.id,
    raw.device_id,
    raw.device_key,
    raw.client_key,
    raw.client_label,
    raw.label,
    raw.client,
    raw.ip,
    raw.client_ip,
  ].filter(Boolean).map(String))).slice(0, 24);
}

function addObservedIdentity(current: Record<string, any>, row: Record<string, any>) {
  const raw = row.raw || {};
  const values = [
    row.device_id,
    row.id,
    row.profile,
    raw.profile,
    row.client,
    raw.client,
    row.label,
    raw.label,
    raw.observed_label,
    raw.redacted_label,
    raw.canonical_hint,
    ...(row.observed_aliases || []),
  ].filter(Boolean).map(String);
  const observed = new Set([...(current.observed_identities || [])]);
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && trimmed !== "Unknown") observed.add(trimmed);
  }
  current.observed_identities = Array.from(observed).slice(0, 32);
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
      total_bytes: observedByteValue(row),
      via_vps_bytes: Number(row.via_vps_bytes || row.reality_bytes || 0),
      direct_bytes: Number(row.direct_bytes || row.wan_bytes || 0),
      unknown_bytes: Number(row.unknown_bytes || row.unresolved_bytes || 0),
    };
    const sourceId = `${collected}|${rawDeviceKey(row)}|${preservedChannel(row)}`;
    if (!current) {
      byKey.set(key, {
        id: key,
        label,
        device_label: label,
        ip: row.ip || row.client_ip || "",
        role,
        owner: row.owner || row.client_owner || "",
        device_type: row.device_type || "",
        channel: preservedChannel(row),
        route: deviceRoute(row),
        confidence: row.confidence || "unknown",
        ...rowTotals,
        last_seen: collected,
        status: statusFromLastSeen(collected),
        from_history: fromHistory,
        channels: preservedChannel(row) !== "Unknown" ? [preservedChannel(row)] : [],
        aliases: deviceAliasTokens(row, key, label),
        observed_identities: [],
        source_ids: [sourceId],
        raw: row.raw || row,
      });
      const created = byKey.get(key);
      if (created) {
        addObservedIdentity(created, row);
        Object.assign(created, applyDeviceAttribution(created));
      }
      return;
    }
    for (const alias of deviceAliasTokens(row, key, label)) addAlias(current, alias);
    addObservedIdentity(current, row);
    const currentTs = Date.parse(current.last_seen || "");
    const rowTs = Date.parse(collected || "");
    const newer = Number.isFinite(rowTs) && (!Number.isFinite(currentTs) || rowTs > currentTs);
    const sameTime = Number.isFinite(rowTs) && Number.isFinite(currentTs) && rowTs === currentTs;
    if (newer) {
      current.total_bytes = rowTotals.total_bytes;
      current.via_vps_bytes = rowTotals.via_vps_bytes;
      current.direct_bytes = rowTotals.direct_bytes;
      current.unknown_bytes = rowTotals.unknown_bytes;
    } else if (sameTime) {
      const sourceIds = new Set([...(current.source_ids || [])]);
      if (!sourceIds.has(sourceId)) {
        current.total_bytes = Number(current.total_bytes || 0) + rowTotals.total_bytes;
        current.via_vps_bytes = Number(current.via_vps_bytes || 0) + rowTotals.via_vps_bytes;
        current.direct_bytes = Number(current.direct_bytes || 0) + rowTotals.direct_bytes;
        current.unknown_bytes = Number(current.unknown_bytes || 0) + rowTotals.unknown_bytes;
        sourceIds.add(sourceId);
        current.source_ids = Array.from(sourceIds).slice(0, 32);
      } else {
        current.total_bytes = Math.max(Number(current.total_bytes || 0), rowTotals.total_bytes);
        current.via_vps_bytes = Math.max(Number(current.via_vps_bytes || 0), rowTotals.via_vps_bytes);
        current.direct_bytes = Math.max(Number(current.direct_bytes || 0), rowTotals.direct_bytes);
        current.unknown_bytes = Math.max(Number(current.unknown_bytes || 0), rowTotals.unknown_bytes);
      }
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
      current.source_ids = [sourceId];
    }
    const channel = preservedChannel(row);
    addChannel(current, channel);
    Object.assign(current, applyDeviceAttribution(current));
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

function snapshotRecordsForWindow(period = "today", types = new Set<string>(["traffic", "traffic_summary"])) {
  const now = new Date();
  const key = `snapshot-records:${latestSnapshotVersion()}:${period}:${Array.from(types).sort().join(",")}`;
  return cacheGet(key, () => {
    const records = (period || "today") === "today" ? latestSnapshotMetaRecords() : latestSnapshotRecords();
    return records.filter((row) => {
      if (!types.has(row.type)) return false;
      if ((period || "today") === "today") return moscowDateKey(row.collectedAt) === moscowDateKey(now);
      return snapshotMatchesPeriod(row, period || "today", now);
    });
  });
}

function snapshotIdsForWindow(period = "today", types = new Set<string>(["traffic", "traffic_summary"])) {
  return snapshotRecordsForWindow(period, types).filter((row) => row.id > 0).map((row) => row.id);
}

function snapshotIdsForDeviceWindow(period = "today", types = new Set<string>(["traffic", "traffic_summary"])) {
  const cacheKey = `device-window-ids:${latestSnapshotVersion()}:${period}:${Array.from(types).sort().join(",")}`;
  return cacheGet(cacheKey, () => {
  const placeholders = Array.from(types).map(() => "?").join(",");
  if ((period || "today") === "today") {
    const today = moscowDateKey(new Date());
    const rows = getDb()
      .prepare(`select id, type, collected_at from snapshots where type in (${placeholders}) order by collected_at desc limit 1000`)
      .all(...Array.from(types));
    return rows
      .filter((row: any) => moscowDateKey(row.collected_at) === today)
      .map((row: any) => row.id);
  }
  const rows = getDb()
    .prepare(`select id, type, collected_at, source, path, payload_json from snapshots where type in (${placeholders}) order by collected_at desc limit 1000`)
    .all(...Array.from(types))
    .map((row: any) => ({
      id: row.id,
      type: row.type,
      collectedAt: row.collected_at,
      source: row.source,
      path: row.path,
      payload: rawJson({ raw_json: row.payload_json }),
    }));
  return rows.filter((row: SnapshotRecord) => snapshotMatchesPeriod(row, period || "today", new Date())).map((row: SnapshotRecord) => row.id);
  });
}

function authoritativeTotalsForPeriod(period = "today", trafficClass = "all") {
  return cacheGet(`authoritative-totals:${latestSnapshotVersion()}:${period}:${trafficClass || "all"}`, () => {
  const prepared = preparedDashboard(period, trafficClass);
  if (prepared?.totals) {
    return {
      observed: Number(prepared.totals.observedBytes || 0),
      vps: Number(prepared.totals.viaVpsBytes || 0),
      direct: Number(prepared.totals.directBytes || 0),
      unknown: Number(prepared.totals.unknownBytes || 0),
    };
  }
  if (USE_PREPARED_WINDOWS && period !== "today") return { observed: 0, vps: 0, direct: 0, unknown: 0 };
  const latestPayload = (type: string) => {
    const rows = getDb()
      .prepare("select collected_at, payload_json from snapshots where type = ? order by collected_at desc limit 50")
      .all(type) as Array<Record<string, any>>;
    for (const row of rows) {
      if ((period || "today") === "today" && moscowDateKey(row.collected_at) !== moscowDateKey(new Date())) continue;
      const payload = rawJson({ raw_json: row.payload_json });
      if (snapshotMatchesPeriod({ type, collectedAt: row.collected_at, payload }, period || "today", new Date())) return payload;
    }
    return {};
  };
  const trafficSummary = latestPayload("traffic_summary");
  const traffic = latestPayload("traffic");
  const totals = (trafficSummary.totals || traffic.totals || {}) as Record<string, any>;
  return {
    observed: Number(totals.client_observed_bytes || 0),
    vps: Number(totals.via_vps_bytes || 0),
    direct: Number(totals.direct_bytes || 0),
    unknown: Number(totals.unknown_bytes || 0),
  };
  });
}

function destinationAttributionCoverageForPeriod(period = "today") {
  return cacheGet(`destination-coverage:${latestSnapshotVersion()}:${period}`, () => {
    const prepared = preparedDashboard(period, "all");
    if (prepared?.destinationAttributionCoverage) return prepared.destinationAttributionCoverage;
    if (USE_PREPARED_WINDOWS && period !== "today") return null;
    const rows = getDb()
      .prepare("select type, collected_at, payload_json from snapshots where type in ('traffic_facts', 'traffic') order by collected_at desc limit 50")
      .all() as Array<Record<string, any>>;
    for (const row of rows) {
      if ((period || "today") === "today" && moscowDateKey(row.collected_at) !== moscowDateKey(new Date())) continue;
      const payload = rawJson({ raw_json: row.payload_json });
      if (snapshotMatchesPeriod({ type: row.type, collectedAt: row.collected_at, payload }, period || "today", new Date())) {
        return payload.destination_attribution_coverage || payload.coverage || null;
      }
    }
    return null;
  });
}

function flowByteValue(row: Record<string, any>) {
  return observedByteValue(row);
}

function flowGroupKey(row: Record<string, any>) {
  return [
    row.raw?.flow_group_key,
    row.raw?.accounting_bucket ? "bucket" : "",
    row.channel,
    row.raw_profile || row.raw?.profile,
    row.raw_client || row.raw?.client || row.client,
    row.destination,
    row.route,
    row.confidence,
  ].filter(Boolean).join("|").toLowerCase();
}

function applyFlowWindowDeltas(rows: Array<Record<string, any>>) {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const key = flowGroupKey(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const result: Array<Record<string, any>> = [];
  for (const list of groups.values()) {
    const ordered = list.sort((a, b) => Date.parse(a.collected_at || a.event_ts || "") - Date.parse(b.collected_at || b.event_ts || ""));
    let previous: Record<string, any> | null = null;
    let latest: Record<string, any> = ordered[ordered.length - 1];
    let bytes = 0;
    let viaVpsBytes = 0;
    let directBytes = 0;
    let unknownBytes = 0;
    let connections = 0;
    let snapshotSamples = 0;
    let deltaSamples = 0;
    for (const sample of ordered) {
      const currentBytes = flowByteValue(sample);
      const currentConnections = Number(sample.connections || 0);
      const currentSplit = splitCounters(sample, currentBytes);
      const first = !previous;
      const previousBytes = previous ? flowByteValue(previous) : 0;
      const previousConnections = Number(previous?.connections || 0);
      const previousSplit = previous ? splitCounters(previous, previousBytes) : { via_vps_bytes: 0, direct_bytes: 0, unknown_bytes: 0 };
      const byteDelta = first ? currentBytes : Math.max(0, currentBytes - previousBytes);
      const deltaVps = first ? currentSplit.via_vps_bytes : Math.max(0, currentSplit.via_vps_bytes - previousSplit.via_vps_bytes);
      const deltaDirect = first ? currentSplit.direct_bytes : Math.max(0, currentSplit.direct_bytes - previousSplit.direct_bytes);
      const deltaUnknownRaw = first ? currentSplit.unknown_bytes : Math.max(0, currentSplit.unknown_bytes - previousSplit.unknown_bytes);
      const deltaUnknown = deltaVps + deltaDirect + deltaUnknownRaw === byteDelta
        ? deltaUnknownRaw
        : Math.max(0, byteDelta - deltaVps - deltaDirect);
      const connectionDelta = first ? currentConnections : Math.max(0, currentConnections - previousConnections);
      if (byteDelta > 0 || connectionDelta > 0) {
        bytes += byteDelta;
        viaVpsBytes += deltaVps;
        directBytes += deltaDirect;
        unknownBytes += deltaUnknown;
        connections += connectionDelta;
        if (first) snapshotSamples += 1;
        else deltaSamples += 1;
      }
      if (Date.parse(sample.collected_at || sample.event_ts || "") >= Date.parse(latest.collected_at || latest.event_ts || "")) latest = sample;
      previous = sample;
    }
    result.push({
      ...latest,
      bytes,
      total_bytes: bytes,
      via_vps_bytes: viaVpsBytes,
      direct_bytes: directBytes,
      unknown_bytes: unknownBytes,
      route: viaVpsBytes > 0 || directBytes > 0
        ? routeFromCounters({ via_vps_bytes: viaVpsBytes, direct_bytes: directBytes })
        : latest.route || "Unknown",
      connections,
      raw_total_bytes: flowByteValue(latest),
      traffic_basis: snapshotSamples && !deltaSamples ? "snapshot_total" : snapshotSamples ? "snapshot_total+delta" : "delta",
      snapshot_samples: snapshotSamples,
      delta_samples: deltaSamples,
    });
  }
  return result;
}

function matchesTrafficClass(row: Record<string, any>, trafficClass = "client") {
  if (!trafficClass || trafficClass === "all") return true;
  if (row.trafficClass === trafficClass) return true;
  return trafficClass === "client" && Boolean(row.accounting_bucket);
}

function deviceDeltaRowsForPeriod(period = "today") {
  return cacheGet(`device-deltas:${latestSnapshotVersion()}:${period}`, () => {
  const rows = normalizedRowsForIds("normalized_devices", snapshotIdsForDeviceWindow(period, TRAFFIC_DEVICE_TYPES))
    .map((row: any) => ({
      id: row.device_id,
      device_id: row.device_id,
      label: row.label,
      ip: row.ip,
      channel: row.channel,
      route: row.route,
      confidence: row.confidence,
      total_bytes: Number(row.total_bytes || 0),
      via_vps_bytes: Number(row.via_vps_bytes || 0),
      direct_bytes: Number(row.direct_bytes || 0),
      raw: row.raw,
      collected_at: row.collected_at,
      profile: row.raw?.profile,
    }));
  const byKey = new Map<string, Map<string, Array<Record<string, any>>>>();
  for (const row of rows) {
    const key = keyForDevice(row);
    if (!key || key === "unknown-device") continue;
    const bySource = byKey.get(key) || new Map<string, Array<Record<string, any>>>();
    const sourceKey = rawDeviceKey(row) || key;
    const list = bySource.get(sourceKey) || [];
    list.push(row);
    bySource.set(sourceKey, list);
    byKey.set(key, bySource);
  }
  const deltas: Array<Record<string, any>> = [];
  for (const [key, sourceGroups] of byKey) {
    let latest: Record<string, any> | null = null;
    const acc = {
      total_bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      snapshot_samples: 0,
      delta_samples: 0,
    };
    const aliases = new Set<string>();
    for (const list of sourceGroups.values()) {
      const ordered = list.sort((a, b) => Date.parse(a.collected_at || "") - Date.parse(b.collected_at || ""));
      let previous: Record<string, any> | null = null;
      for (const sample of ordered) {
        aliases.add(rawDeviceKey(sample));
        if (!latest || Date.parse(sample.collected_at || "") >= Date.parse(latest.collected_at || "")) latest = sample;
        const first = !previous;
        const deltaTotal = first ? Number(sample.total_bytes || 0) : Math.max(0, Number(sample.total_bytes || 0) - Number(previous?.total_bytes || 0));
        const deltaVps = first ? Number(sample.via_vps_bytes || 0) : Math.max(0, Number(sample.via_vps_bytes || 0) - Number(previous?.via_vps_bytes || 0));
        const deltaDirect = first ? Number(sample.direct_bytes || 0) : Math.max(0, Number(sample.direct_bytes || 0) - Number(previous?.direct_bytes || 0));
        if (deltaTotal > 0 || deltaVps > 0 || deltaDirect > 0) {
          acc.total_bytes += deltaTotal;
          acc.via_vps_bytes += deltaVps;
          acc.direct_bytes += deltaDirect;
          if (first) acc.snapshot_samples += 1;
          else acc.delta_samples += 1;
        }
        previous = sample;
      }
    }
    if (!latest) continue;
    deltas.push({
      ...latest,
      id: key,
      device_id: key,
      aliases: Array.from(aliases).filter(Boolean),
      total_bytes: acc.total_bytes,
      via_vps_bytes: acc.via_vps_bytes,
      direct_bytes: acc.direct_bytes,
      route: routeFromCounters(acc),
      confidence: latest.confidence || (acc.snapshot_samples ? "estimated" : "unknown"),
      traffic_basis: acc.snapshot_samples && !acc.delta_samples ? "snapshot_total" : acc.snapshot_samples ? "snapshot_total+delta" : "delta",
      delta_samples: acc.delta_samples,
      snapshot_samples: acc.snapshot_samples,
      last_seen: latest.collected_at,
    });
  }
  return reconcileTrafficRows(deltas, authoritativeTotalsForPeriod(period));
  });
}

function latestWindowSnapshot(snapshots: ConsoleModel["snapshots"], type: string, period = "today") {
  const row = snapshots[type as keyof ConsoleModel["snapshots"]];
  return row && snapshotMatchesPeriod(row, period || "today", new Date()) ? row : undefined;
}

function normalizedRowsForIds(table: string, ids: number[]) {
  const allowed = new Set([
    "normalized_devices",
    "normalized_flows",
    "normalized_dns",
    "normalized_health",
    "normalized_catalog",
    "normalized_alerts",
  ]);
  if (!allowed.has(table) || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  try {
    return getDb()
      .prepare(`select * from ${table} where snapshot_id in (${placeholders}) order by collected_at desc`)
      .all(...ids)
      .map((row: any) => ({ ...row, raw: rawJson(row) }));
  } catch {
    return [];
  }
}

function evidenceRowsForWindow(rows: Array<Record<string, any>>, period = "today") {
  if ((period || "today") !== "today") return rows;
  return rows.filter((row) => {
    const collectedAt = row.occurred_at || row.event_ts || row.collected_at || row.created_at || "";
    return snapshotMatchesPeriod({ collectedAt, payload: { source: { period: "today" } } }, "today", new Date());
  });
}

export function buildConsoleModel(filters: ConsoleFilters = {}): ConsoleModel {
  return cacheGet(`build-console-model:${latestSnapshotVersion()}:${filtersKey(filters)}`, () => buildConsoleModelUncached(filters));
}

function buildConsoleModelUncached(filters: ConsoleFilters = {}): ConsoleModel {
  const snapshots = cachedLatestByType();
  const period = filters.period || "today";
  const trafficSummarySnapshot = latestWindowSnapshot(snapshots, "traffic_summary", period);
  const trafficSnapshot = latestWindowSnapshot(snapshots, "traffic", period);
  const trafficSummary = trafficSummarySnapshot?.payload || {};
  const traffic = trafficSnapshot?.payload || {};
  const dashboardTraffic = trafficSummary.totals ? trafficSummary : traffic;
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const domains = snapshots.domains?.payload || {};
  const dns = snapshots.dns?.payload || {};
  const detailTrafficWindowIds = snapshotIdsForWindow(period, TRAFFIC_DETAIL_TYPES);
  const dnsWindowIds = snapshotIdsForWindow(period, TRAFFIC_DNS_TYPES);
  const alertWindowIds = snapshotIdsForWindow(period, ALERT_CONTEXT_TYPES);

  const newest = Object.values(snapshots)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();

  const normalizedDevices = deviceDeltaRowsForPeriod(period);

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
  const devices = mergeKnownDevices(latestDevices, false);

  const normalizedFlows = normalizedRowsForIds("normalized_flows", detailTrafficWindowIds).map((row: any) => decorateTrafficRow({
    client: row.client,
    client_ip: row.client_ip,
    channel: row.channel,
    destination: row.destination,
    destination_ip: row.destination_ip,
    destination_port: row.destination_port,
    route: row.route,
    intended_route: row.intended_route,
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
      ? reconcileTrafficRows(applyFlowWindowDeltas(normalizedFlows), authoritativeTotalsForPeriod(period))
      : [
      ...(traffic.app_flows || []).map((row: any) => decorateTrafficRow(row)),
      ...(traffic.destinations || []).map((row: any) => decorateTrafficRow({
        ...row,
        client: row.client || row.channel,
      })),
    ],
    filters
  );

  const normalizedDns = normalizedRowsForIds("normalized_dns", dnsWindowIds).map((row: any) => ({
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

  const normalizedAlerts = normalizedRowsForIds("normalized_alerts", alertWindowIds).map((row: any) => ({
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

  const alerts = dedupeAlerts([...staleAlert, ...egressIdentityAlert, ...collectorAlerts, ...normalizedAlerts, ...leakAlerts, ...routingAlerts]);
  const events = evidenceRowsForWindow(latestEvents() as Array<Record<string, any>>, period);
  const routeDecisions = evidenceRowsForWindow(latestRouteDecisions() as Array<Record<string, any>>, period);
  const derivedNotifications = alerts.map((row: any, idx: number) => ({
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
    events,
    routeDecisions,
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
    destinationAttributionCoverage: destinationAttributionCoverageForPeriod(period),
    devices: filterRows(devices.map((row: any) => ({ ...row, route: row.route || routeFromCounters(row) })), filters),
    flows,
    dnsQueries,
    alerts,
    catalog,
  };
}

type PageArgs = {
  page?: number;
  pageSize?: number;
  maxPageSize?: number;
  maxRows?: number;
  filters?: ConsoleFilters;
  diagnostics?: boolean;
  showInactive?: boolean;
  clientTarget?: Record<string, any>;
  presentationWeight?: boolean;
};

type DnsPageArgs = PageArgs & {
  status?: string;
  catalogStatus?: string;
};

type AlarmPageArgs = PageArgs & {
  severity?: string;
  status?: string;
  source?: string;
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

function stableAlarmId(...parts: Array<string | number | undefined | null>) {
  const hash = crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
  return `alarm:fallback:${hash}`;
}

function evidenceJson(row: any) {
  try {
    return row.evidence_json ? JSON.parse(row.evidence_json) : {};
  } catch {
    return {};
  }
}

function safeJson(value: unknown, fallback: any) {
  try {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readModelHasRows(table: string) {
  if (!/^(flow_sessions|dns_query_log|device_inventory|alarm_events)$/.test(table)) return false;
  try {
    return Number((getDb().prepare(`select count(*) as count from ${table}`).get() as any)?.count || 0) > 0;
  } catch {
    return false;
  }
}

function aggregateModelHasRows(table: string, timeColumn?: string, start?: string, end?: string) {
  if (!/^(dns_log_5min|dns_log_hourly|dns_log_daily|dns_log_weekly)$/.test(table)) return false;
  try {
    if (timeColumn && start && end) {
      return Number((getDb().prepare(`select count(*) as count from ${table} where ${timeColumn} >= ? and ${timeColumn} < ? limit 1`).get(start, end) as any)?.count || 0) > 0;
    }
    return Number((getDb().prepare(`select count(*) as count from ${table} limit 1`).get() as any)?.count || 0) > 0;
  } catch {
    return false;
  }
}

function latestIdWhereForFilters(filters: ConsoleFilters = {}) {
  const ids = snapshotIdsForWindow(filters.period || "today", TRAFFIC_DETAIL_TYPES);
  if (ids.length === 0) return { ids, sql: "1 = 0", params: [] as any[] };
  return { ids, sql: `snapshot_id in (${ids.map(() => "?").join(",")})`, params: ids as any[] };
}

function idWhereForWindow(period = "today", types = new Set<string>(["traffic"])) {
  const ids = snapshotIdsForWindow(period || "today", types);
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
  // Client filters are applied after rows pass through the registry resolver:
  // one canonical client can have Channel A/B/C/LAN aliases that are not
  // representable as a single SQL predicate over the raw client column.
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

function notSystemDestinationSql(destination = "destination", dns = "dns_qname") {
  return `coalesce(${destination}, destination_ip, ${dns}, '') != ''
    and ${destination} not like '192.168.%'
    and ${destination} not like '10.%'
    and ${destination} not like '172.16.%'
    and ${destination} not like '172.17.%'
    and ${destination} not like '172.18.%'
    and ${destination} not like '172.19.%'
    and ${destination} not like '172.2_.%'
    and ${destination} not like '172.30.%'
    and ${destination} not like '172.31.%'
    and ${destination} not like '127.%'
    and ${destination} not like '169.254.%'
    and ${destination} not like '0.%'
    and lower(${destination}) not like '%localhost%'
    and lower(${destination}) not like '%router.local%'
    and lower(${destination}) not like '%sslip.io%'`;
}

function notSyntheticAccountingBucketSql(evidenceColumn = "evidence_json") {
  return `coalesce(${evidenceColumn}, '') not like '%"accounting_bucket":true%'
    and coalesce(${evidenceColumn}, '') not like '%"device_counter":true%'`;
}

function flowSelect() {
  return `rowid as rowid, 'flow:' || rowid as id, snapshot_id, snapshot_type, collected_at,
    client, client_ip, channel, destination, destination_ip, destination_port, route, intended_route, confidence,
    bytes, connections, protocol, dns_qname, dns_answer_ip, sni, outbound, matched_rule,
    rule_set, egress_ip, egress_asn, egress_country, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, ts_confidence, source_log,
    traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, route_verification, route_status, dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status, raw_json`;
}

function isDomainLikeValue(value: unknown) {
  const text = String(value || "").trim();
  return Boolean(text)
    && text.includes(".")
    && !/^(\d{1,3}\.){3}\d{1,3}$/.test(text)
    && !/^[0-9a-f:.]+$/i.test(text)
    && !text.includes(" ");
}

function isPseudoDestinationValue(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  return ["n/a", "not observed", "unknown", "unknown destination", "client", "home reality ingress"].includes(text)
    || text.endsWith(" ingress")
    || text.includes(" ingress ")
    || text.includes(" relay");
}

let flowDnsFallbackCacheKey = "";
const flowDnsFallbackCache = new Map<string, Record<string, any> | null>();

function sqlIn(column: string, values: Array<string>) {
  const clean = Array.from(new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))).slice(0, 80);
  if (clean.length === 0) return { sql: "", params: [] as Array<string> };
  return {
    sql: `lower(${column}) in (${clean.map(() => "?").join(",")})`,
    params: clean,
  };
}

function clientMatchPredicate(columns: Array<string>, values: Array<string>) {
  const predicates: string[] = [];
  const params: string[] = [];
  for (const column of columns) {
    const clause = sqlIn(column, values);
    if (!clause.sql) continue;
    predicates.push(clause.sql);
    params.push(...clause.params);
  }
  return { sql: predicates.length ? `(${predicates.join(" or ")})` : "", params };
}

function genericDeviceDnsAliases(target: Record<string, any>) {
  const raw = rawJson(target);
  return uniqueNonEmpty([
    target.label,
    target.client,
    target.client_label,
    target.device_label,
    target.client_key,
    target.device_key,
    target.device_type,
    target.role,
    raw.label,
    raw.client,
    raw.client_label,
    raw.device_label,
    raw.device_type,
    raw.role,
  ]).flatMap((value) => {
    const text = value.toLowerCase();
    if (text.includes("iphone")) return ["iphone", "iPhone"];
    if (text.includes("ipad")) return ["ipad", "iPad"];
    if (text.includes("macbook")) return ["macbook", "MacBook"];
    if (text.includes("windows")) return ["windows", "Windows"];
    return [];
  });
}

function isMobileProfileTarget(target: Record<string, any>) {
  const raw = rawJson(target);
  const text = uniqueNonEmpty([
    target.label,
    target.client,
    target.client_label,
    target.client_key,
    target.device_type,
    target.role,
    target.channel,
    target.client_channel,
    raw.label,
    raw.client,
    raw.device_type,
    raw.role,
    raw.channel,
  ]).join(" ").toLowerCase();
  return text.includes("reality") || text.includes("profile") || text.includes("mobile") || text.includes("iphone") || text.includes("ipad");
}

function flowDnsFallback(row: Record<string, any>) {
  if (isDomainLikeValue(row.dns_qname) || isDomainLikeValue(row.sni) || isDomainLikeValue(row.domain)) return null;
  const destination = String(row.destination || "").trim();
  if (isDomainLikeValue(destination) && !isPseudoDestinationValue(destination)) return null;
  const cacheKeyVersion = latestSnapshotVersion();
  if (flowDnsFallbackCacheKey !== cacheKeyVersion) {
    flowDnsFallbackCacheKey = cacheKeyVersion;
    flowDnsFallbackCache.clear();
  }
  const client = String(row.client || row.client_label || row.device_key || "").trim();
  const destinationIp = String(row.destination_ip || "").trim();
  const eventAt = String(row.display_ts_utc || row.event_ts_utc || row.last_seen || row.first_seen || row.collected_at || "").trim();
  const clientCandidates = laneClientKeyCandidates(row);
  const key = [clientCandidates.join(","), destinationIp, eventAt.slice(0, 16)].join("|");
  if (flowDnsFallbackCache.has(key)) return flowDnsFallbackCache.get(key) || null;
  const db = getDb();
  let linked: Record<string, any> | undefined;
  if (row.dns_link_id) {
    linked = db.prepare(`
      select domain, dns_answer_ip as answer_ip, destination_ip, confidence, link_type
        from traffic_dns_links
       where id = ?
       order by collected_at desc
       limit 1
    `).get(row.dns_link_id) as Record<string, any> | undefined;
  }
  const linkClientMatch = clientMatchPredicate(["client_key", "client_ip"], clientCandidates);
  if (!linked && destinationIp && linkClientMatch.sql) {
    linked = db.prepare(`
      select domain, dns_answer_ip as answer_ip, destination_ip, confidence, link_type
        from traffic_dns_links
       where destination_ip = ?
         and ${linkClientMatch.sql}
         and coalesce(domain, '') != ''
       order by collected_at desc
       limit 1
    `).get(destinationIp, ...linkClientMatch.params) as Record<string, any> | undefined;
  }
  if (!linked && destinationIp) {
    linked = db.prepare(`
      select domain, dns_answer_ip as answer_ip, destination_ip, confidence, link_type
        from traffic_dns_links
       where destination_ip = ?
         and coalesce(domain, '') != ''
       order by collected_at desc
       limit 1
    `).get(destinationIp) as Record<string, any> | undefined;
  }
  const dnsClientMatch = clientMatchPredicate(["client", "device_key", "client_ip"], clientCandidates);
  if (!linked && dnsClientMatch.sql) {
    const params: any[] = [...dnsClientMatch.params];
    const timeExpr = "coalesce(nullif(event_ts, ''), nullif(collected_at, ''), '')";
    const timeWindowSql = eventAt ? `and abs(strftime('%s', ${timeExpr}) - strftime('%s', ?)) <= ?` : "";
    if (eventAt) params.push(eventAt, 15 * 60);
    const answerPriority = destinationIp ? `case when answer_ip = ? then 0 else 1 end,` : "";
    if (destinationIp) params.push(destinationIp);
    if (eventAt) params.push(eventAt);
    linked = db.prepare(`
      select domain, answer_ip, confidence, 'client-nearby-dns' as link_type
        from dns_query_log
       where ${dnsClientMatch.sql}
         ${timeWindowSql}
         and coalesce(domain, '') != ''
       order by ${answerPriority} ${eventAt ? `abs(strftime('%s', ${timeExpr}) - strftime('%s', ?)) asc,` : ""} count desc, ${timeExpr} desc
      limit 1
     `).get(...params) as Record<string, any> | undefined;
  }
  const genericDnsMatch = !linked && isMobileProfileTarget(row)
    ? clientMatchPredicate(["client", "device_key"], genericDeviceDnsAliases(row))
    : { sql: "", params: [] as Array<string> };
  if (!linked && genericDnsMatch.sql) {
    const params: any[] = [...genericDnsMatch.params];
    const timeExpr = "coalesce(nullif(event_ts, ''), nullif(collected_at, ''), '')";
    const timeWindowSql = eventAt ? `and abs(strftime('%s', ${timeExpr}) - strftime('%s', ?)) <= ?` : "";
    if (eventAt) params.push(eventAt, 15 * 60);
    linked = db.prepare(`
      select domain, answer_ip, 'dns-generic-device' as confidence, 'generic-device-nearby-dns' as link_type
        from dns_query_log
       where ${genericDnsMatch.sql}
         ${timeWindowSql}
         and coalesce(domain, '') != ''
       order by ${eventAt ? `abs(strftime('%s', ${timeExpr}) - strftime('%s', ?)) asc,` : ""} count desc, ${timeExpr} desc
       limit 1
    `).get(...params, ...(eventAt ? [eventAt] : [])) as Record<string, any> | undefined;
  }
  const result = linked && isDomainLikeValue(linked.domain) ? linked : null;
  flowDnsFallbackCache.set(key, result);
  return result;
}

function applyFlowDnsFallback(row: Record<string, any>) {
  const linked = flowDnsFallback(row);
  if (!linked?.domain) return row;
  const destination = String(row.destination || "").trim();
  const shouldReplaceDestination = !destination || isPseudoDestinationValue(destination);
  return {
    ...row,
    destination: shouldReplaceDestination ? linked.domain : row.destination,
    dns_qname: row.dns_qname || linked.domain,
    dns_answer_ip: row.dns_answer_ip || linked.answer_ip || "",
    dns_status: row.dns_status || "linked",
    dns_link_confidence: row.dns_link_confidence || linked.confidence || "client-nearby",
    dns_ts_source: row.dns_ts_source || linked.link_type || "client-nearby-dns",
  };
}

function ipv4Literal(value?: string) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

function ipv4ToU32(value?: string) {
  const parts = String(value || "").trim().split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 256 ** 3) + (parts[1] * 256 ** 2) + (parts[2] * 256) + parts[3]) >>> 0;
}

function ipEnrichmentFor(value?: string) {
  const ip = String(value || "").trim();
  if (!ipv4Literal(ip)) return null;
  return cacheGet(`ip-enrichment:${latestSnapshotVersion()}:${ip}`, () => {
    try {
      const row = getDb().prepare(`
        select ip, prefix_cidr, asn, asn_org, provider, category_hint,
               traffic_lane_hint, dns_category_hint, decision_hint, country,
               source, confidence, lookup_status
          from ip_enrichment_cache
         where ip = ?
           and lookup_status = 'hit'
         limit 1
      `).get(ip) as Record<string, any> | undefined;
      if (row) return row;
      const ipU32 = ipv4ToU32(ip);
      if (ipU32 === null) return null;
      const prefix = getDb().prepare(`
        select prefix_cidr, asn, asn_org, provider, country, registry, source
          from ip_prefix_catalog
         where range_start_u32 <= ?
           and range_end_u32 >= ?
         order by (range_end_u32 - range_start_u32) asc
         limit 1
      `).get(ipU32, ipU32) as Record<string, any> | undefined;
      if (!prefix) return null;
      const provider = prefix.provider || prefix.asn_org || "";
      const normalizedProvider = String(provider).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "network";
      return {
        ip,
        ...prefix,
        provider,
        category_hint: `ip_asn.network_provider.${normalizedProvider}`,
        traffic_lane_hint: "shared_infra",
        dns_category_hint: "network_provider",
        decision_hint: "monitor",
        confidence: "estimated",
        lookup_status: "prefix_hit",
      };
    } catch {
      return null;
    }
  });
}

function destinationContextFromIp(row: Record<string, any>) {
  const candidate = row.destination_ip || (ipv4Literal(row.destination) ? row.destination : "");
  const enrichment = ipEnrichmentFor(candidate);
  if (!enrichment) return row;
  return {
    ...row,
    ip_provider: enrichment.provider || "",
    ip_asn: enrichment.asn || "",
    ip_asn_org: enrichment.asn_org || "",
    ip_category_hint: enrichment.category_hint || "",
    ip_traffic_lane_hint: enrichment.traffic_lane_hint || "",
    ip_dns_category_hint: enrichment.dns_category_hint || "",
    ip_decision_hint: enrichment.decision_hint || "",
    ip_enrichment_source: enrichment.source || "",
    ip_enrichment_confidence: enrichment.confidence || "",
    provider: row.provider || enrichment.provider || enrichment.asn_org || "",
    asn_org: row.asn_org || enrichment.asn_org || "",
    category: row.category || enrichment.category_hint || "",
  };
}

function mapFlowRow(row: any) {
  row = applyFlowDnsFallback(row);
  return destinationContextFromIp(decorateTrafficRow({
    id: row.id,
    rowid: row.rowid,
    client: row.client,
    client_ip: row.client_ip,
    channel: row.channel,
    destination: row.destination,
    destination_ip: row.destination_ip,
    destination_port: row.destination_port,
    route: row.route,
    intended_route: row.intended_route,
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
    event_ts_utc: row.event_ts_utc,
    observed_at_utc: row.observed_at_utc,
    display_ts_utc: row.display_ts_utc,
    time_precision: row.time_precision,
    ts_confidence: row.ts_confidence,
    source_log: row.source_log,
    traffic_class: row.traffic_class,
    via_vps_bytes: Number(row.via_vps_bytes || 0),
    direct_bytes: Number(row.direct_bytes || 0),
    unknown_bytes: Number(row.unknown_bytes || 0),
    route_verification: row.route_verification,
    route_status: row.route_status,
    dns_link_id: row.dns_link_id,
    dns_link_confidence: row.dns_link_confidence,
    dns_status: row.dns_status,
    dns_ts_source: row.dns_ts_source,
    accounting_status: row.accounting_status,
    collected_at: row.collected_at,
    raw: rawJson(row),
  }));
}

function flowSessionSelect() {
  return `id, snapshot_id, collected_at, first_seen, last_seen, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, device_key,
    channel, destination, destination_ip, destination_port, protocol, route, intended_route, policy, matched_rule,
    outbound, dns_qname, dns_answer_ip, sni, egress_ip, egress_asn, egress_country, ts_confidence,
    traffic_class, via_vps_bytes, direct_bytes, unknown_bytes, route_verification, route_status, dns_link_id, dns_link_confidence, dns_status, dns_ts_source, accounting_status, bytes, connections, duration_seconds, duration_confidence, risk, risk_reason,
    confidence, source_kind, evidence_json`;
}

function mapFlowSessionRow(row: any) {
  const raw = evidenceJson(row);
  row = applyFlowDnsFallback({ ...row, raw });
  const rowid = String(row.id || "").replace(/^flow:/, "");
  return destinationContextFromIp(decorateTrafficRow({
    id: row.id,
    rowid,
    snapshot_id: row.snapshot_id,
    collected_at: row.collected_at,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    event_ts_utc: row.event_ts_utc,
    observed_at_utc: row.observed_at_utc,
    display_ts_utc: row.display_ts_utc,
    time_precision: row.time_precision,
    client: row.client,
    client_ip: row.client_ip,
    device_key: row.device_key,
    channel: row.channel,
    destination: row.destination,
    destination_ip: row.destination_ip,
    destination_port: row.destination_port,
    route: row.route,
    confidence: row.confidence,
    bytes: Number(row.bytes || 0),
    total_bytes: Number(row.bytes || 0),
    connections: Number(row.connections || 0),
    protocol: row.protocol,
    dns_qname: row.dns_qname,
    dns_answer_ip: row.dns_answer_ip,
    sni: row.sni,
    outbound: row.outbound,
    matched_rule: row.matched_rule || row.policy,
    rule_set: row.policy,
    egress_ip: row.egress_ip,
    egress_asn: row.egress_asn,
    egress_country: row.egress_country,
    ts_confidence: row.ts_confidence,
    traffic_class: row.traffic_class,
    via_vps_bytes: Number(row.via_vps_bytes || 0),
    direct_bytes: Number(row.direct_bytes || 0),
    unknown_bytes: Number(row.unknown_bytes || 0),
    route_verification: row.route_verification,
    route_status: row.route_status,
    dns_link_id: row.dns_link_id,
    dns_link_confidence: row.dns_link_confidence,
    dns_status: row.dns_status,
    dns_ts_source: row.dns_ts_source,
    accounting_status: row.accounting_status,
    policy: row.policy,
    risk: row.risk,
    risk_reason: row.risk_reason,
    duration_seconds: Number(row.duration_seconds || 0),
    duration_confidence: row.duration_confidence,
    event_ts: row.display_ts_utc || row.last_seen || row.first_seen || row.collected_at,
    source_log: row.source_kind,
    raw,
  }));
}

function dashboardAnalyticsRows(filters: ConsoleFilters = {}) {
  const effectiveFilters = { ...filters, period: "all" };
  if (!readModelHasRows("flow_sessions")) {
    return listTrafficRows({ page: 1, pageSize: 5000, maxRows: 5000, filters, diagnostics: true }).rows;
  }
  const where = ["bytes > 0"];
  const params: any[] = [];
  if (filters.route && filters.route !== "all") {
    where.push("route = ?");
    params.push(filters.route);
  }
  if (filters.channel && filters.channel !== "all") {
    where.push("channel = ?");
    params.push(filters.channel);
  }
  if (filters.confidence && filters.confidence !== "all") {
    where.push("confidence = ?");
    params.push(filters.confidence);
  }
  const search = filters.search?.trim();
  if (search) {
    const needle = `%${search.toLowerCase()}%`;
    where.push(`(
      lower(client) like ? or lower(client_ip) like ? or lower(destination) like ?
      or lower(destination_ip) like ? or lower(policy) like ? or lower(matched_rule) like ?
      or lower(outbound) like ? or lower(dns_qname) like ? or lower(sni) like ?
    )`);
    params.push(needle, needle, needle, needle, needle, needle, needle, needle, needle);
  }
  const trafficClass = filters.trafficClass || "all";
  return getDb()
    .prepare(
      `select ${flowSessionSelect()}
         from flow_sessions
        where ${where.map((item) => `(${item})`).join(" and ")}
        order by coalesce(nullif(last_seen, ''), collected_at) desc, id desc
        limit 10000`
    )
    .all(...params)
    .map(mapFlowSessionRow)
    .map((row) => operatorTrafficRow(row))
    .filter((row): row is Record<string, any> => Boolean(row))
    .filter((row) => filterRows([row], effectiveFilters).length > 0)
    .filter((row) => matchesTrafficClass(row, trafficClass));
}

export function listTrafficRows(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, args.maxPageSize || 100);
  const maxRows = Math.max(pageSize, Number(args.maxRows || Number.MAX_SAFE_INTEGER));
  const latest = latestIdWhereForFilters(args.filters || {});
  const where = [latest.sql];
  const params = [...latest.params];
  addCommonFilters(where, params, args.filters || {});
  if (!args.diagnostics) {
    where.push(isUsefulClientSql());
    where.push("(bytes > 0 or connections > 1)");
    where.push(notSystemDestinationSql());
    where.push(notSyntheticAccountingBucketSql("raw_json"));
  }
  const whereSql = where.map((item) => `(${item})`).join(" and ");
  const offset = (page - 1) * pageSize;
  const trafficClass = args.filters?.trafficClass || "client";
  const fetchLimit = Math.min(maxRows, Math.max(offset + pageSize * 8, 500));
  const sqlTotal = Math.min(maxRows, Number((getDb().prepare(`select count(*) as count from normalized_flows where ${whereSql}`).get(...params) as any)?.count || 0));
  const rawRows = getDb()
    .prepare(
      `select ${flowSelect()}
         from normalized_flows
        where ${whereSql}
        order by bytes desc, coalesce(nullif(event_ts, ''), collected_at) desc, rowid desc
        limit ?`
     )
     .all(...params, fetchLimit)
     .map(mapFlowRow)
    .map((row) => ["client", "personal_cloud"].includes(trafficClass) ? operatorTrafficRow(row, { allowAccountingBucket: true }) : row)
     .filter((row): row is Record<string, any> => Boolean(row))
     .filter((row) => filterRows([row], args.filters || {}).length > 0)
     .filter((row) => matchesTrafficClass(row, trafficClass))
    .sort((a, b) => Number(b.bytes || b.total_bytes || 0) - Number(a.bytes || a.total_bytes || 0));
  const allRows = (reconcileTrafficRows(applyFlowWindowDeltas(rawRows), authoritativeTotalsForPeriod(args.filters?.period || "today", trafficClass)) as Array<Record<string, any>>)
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(b.bytes || b.total_bytes || 0) - Number(a.bytes || a.total_bytes || 0));
  const total = Math.min(maxRows, Math.max(allRows.length, allRows.length >= fetchLimit ? sqlTotal : allRows.length));
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

export function listFlowSessions(args: PageArgs = {}) {
  return cacheGet(`list-flow-sessions:${latestSnapshotVersion()}:${pageArgsKey(args)}`, () => listFlowSessionsUncached(args));
}

function listFlowSessionsUncached(args: PageArgs = {}) {
  if (!readModelHasRows("flow_sessions")) return listTrafficRows(args);
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, args.maxPageSize || 100);
  const maxRows = Math.max(pageSize, Number(args.maxRows || Number.MAX_SAFE_INTEGER));
  const latest = idWhereForWindow(args.filters?.period || "today", TRAFFIC_DETAIL_TYPES);
  const where = [latest.sql];
  const params = [...latest.params];
  const filters = args.filters || {};
  if (filters.route && filters.route !== "all") {
    where.push("route = ?");
    params.push(filters.route);
  }
  if (filters.channel && filters.channel !== "all") {
    where.push("channel = ?");
    params.push(filters.channel);
  }
  if (filters.confidence && filters.confidence !== "all") {
    where.push("confidence = ?");
    params.push(filters.confidence);
  }
  const search = filters.search?.trim();
  if (search) {
    const needle = `%${search.toLowerCase()}%`;
    where.push(`(
      lower(client) like ? or lower(client_ip) like ? or lower(destination) like ?
      or lower(destination_ip) like ? or lower(policy) like ? or lower(matched_rule) like ?
      or lower(outbound) like ? or lower(dns_qname) like ? or lower(sni) like ?
    )`);
    params.push(needle, needle, needle, needle, needle, needle, needle, needle, needle);
  }
  if (!args.diagnostics) {
    where.push(isUsefulClientSql());
    where.push("(bytes > 0 or connections > 1)");
    where.push(notSystemDestinationSql("destination", "destination"));
    where.push(notSyntheticAccountingBucketSql("evidence_json"));
  }
  const whereSql = where.map((item) => `(${item})`).join(" and ");
  const offset = (page - 1) * pageSize;
  const trafficClass = filters.trafficClass || "client";
  const fetchLimit = Math.min(maxRows, Math.max(offset + pageSize * 8, 500));
  const db = getDb();
  const sortBytes = (row: Record<string, any>) => args.presentationWeight
    ? trafficPresentationBytes(row)
    : Number(row.bytes || row.total_bytes || 0);
  const compareFlowRows = (a: Record<string, any>, b: Record<string, any>) =>
    sortBytes(b) - sortBytes(a)
      || Number(b.bytes || b.total_bytes || 0) - Number(a.bytes || a.total_bytes || 0);
  const sqlTotal = Math.min(maxRows, Number((db.prepare(`select count(*) as count from flow_sessions where ${whereSql}`).get(...params) as any)?.count || 0));
  const rawRows = db
    .prepare(
      `select ${flowSessionSelect()}
         from flow_sessions
        where ${whereSql}
        order by bytes desc, coalesce(nullif(last_seen, ''), collected_at) desc, id desc
        limit ?`
     )
     .all(...params, fetchLimit)
     .map(mapFlowSessionRow)
    .map((row) => ["client", "personal_cloud"].includes(trafficClass) ? operatorTrafficRow(row, { allowAccountingBucket: true }) : row)
     .filter((row): row is Record<string, any> => Boolean(row))
     .filter((row) => filterRows([row], filters).length > 0)
     .filter((row) => matchesTrafficClass(row, trafficClass))
    .sort(compareFlowRows);
  const allRows = (reconcileTrafficRows(applyFlowWindowDeltas(rawRows), authoritativeTotalsForPeriod(filters.period || "today", trafficClass)) as Array<Record<string, any>>)
    .sort(compareFlowRows);
  const total = Math.min(maxRows, Math.max(allRows.length, allRows.length >= fetchLimit ? sqlTotal : allRows.length));
  const rows = allRows.slice(offset, offset + pageSize);
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hiddenCount: args.diagnostics
      ? 0
      : Math.max(0, Number((db.prepare(`select count(*) as count from flow_sessions where ${latest.sql}`).get(...latest.params) as any)?.count || 0) - total),
  };
}

export function getTrafficRowById(id: string, filters: ConsoleFilters = {}) {
  const normalizedId = String(id || "");
  if (readModelHasRows("flow_sessions")) {
    const readModelRow = getDb().prepare(`select ${flowSessionSelect()} from flow_sessions where id = ?`).get(normalizedId) as any;
    if (readModelRow) return mapFlowSessionRow(readModelRow);
  }
  const match = normalizedId.match(/^flow:(\d+)$/);
  if (!match) return null;
  const row = getDb().prepare(`select ${flowSelect()} from normalized_flows where rowid = ?`).get(Number(match[1])) as any;
  if (!row) return null;
  return mapFlowRow(row);
}

function mapDnsReadModelRow(row: any) {
  const raw = evidenceJson(row);
  return decorateTrafficRow({
    id: row.id,
    snapshot_id: row.snapshot_id,
    collected_at: row.collected_at,
    event_ts: row.event_ts,
    event_ts_utc: row.event_ts_utc,
    observed_at_utc: row.observed_at_utc,
    display_ts_utc: row.display_ts_utc,
    time_precision: row.time_precision,
    client: row.client,
    client_ip: row.client_ip,
    device_key: row.device_key,
    channel: row.channel,
    destination: row.domain,
    domain: row.domain,
    dns_qname: row.domain,
    qtype: row.qtype,
    answer_ip: row.answer_ip,
    dns_answer_ip: row.answer_ip,
    raw_route: row.route,
    route: dnsRouteValue(row.route),
    catalog_status: row.catalog_status,
    status: row.status,
    count: Number(row.count || 0),
    risk: row.risk,
    confidence: row.confidence,
    raw,
  });
}

function mapDnsFallbackRow(row: any) {
  return decorateTrafficRow({
    id: `dns:fallback:${row.snapshot_id}:${row.domain}:${row.qtype}:${row.event_ts || row.collected_at}`,
    snapshot_id: row.snapshot_id,
    collected_at: row.collected_at,
    event_ts: row.event_ts,
    client: row.client,
    destination: row.domain,
    domain: row.domain,
    dns_qname: row.domain,
    qtype: row.qtype,
    answer_ip: row.answer_ip,
    dns_answer_ip: row.answer_ip,
    raw_route: row.route,
    route: dnsRouteValue(row.route),
    catalog_status: "unknown",
    status: "OK",
    count: Number(row.count || 0),
    risk: "low",
    confidence: row.confidence || "dns-interest",
    raw: row.raw,
  });
}

export function listDnsQueryLog(args: DnsPageArgs = {}) {
  return cacheGet(`list-dns-query-log:${latestSnapshotVersion()}:${dnsPageArgsKey(args)}`, () => listDnsQueryLogUncached(args));
}

function listDnsQueryLogUncached(args: DnsPageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 100, 1000);
  const maxRows = 1000;
  const filters = args.filters || {};
  const status = args.status || "all";
  const catalogStatus = args.catalogStatus || "all";
  const route = filters.route || "all";
  const period = filters.period || "today";
  const prepared = getPreparedWindowSnapshot("dns_counts", period, "all")?.payload;
  if (prepared?.rows) {
    const rows = (prepared.rows as Array<Record<string, any>>)
      .map((row: any) => {
        const preparedClient = row.client || "";
        const preparedClientIp = row.client_ip || (isIpv4Literal(preparedClient) ? preparedClient : "");
        return mapDnsReadModelRow({
        id: `dns:prepared:${period}:${preparedClient}:${row.domain}:${row.qtype}:${row.route}`,
        snapshot_id: 0,
        collected_at: row.event_ts || prepared.generatedAt || "",
        event_ts: row.event_ts || "",
        display_ts_utc: row.event_ts || "",
        time_precision: "prepared_bucket",
        client: preparedClient,
        client_ip: preparedClientIp,
        device_key: preparedClient,
        channel: row.channel || row.client_channel || "",
        domain: row.domain || "",
        qtype: row.qtype || "",
        answer_ip: "",
        route: row.route || "Unknown",
        catalog_status: row.catalog_status || "unknown",
        status: "OK",
        count: Number(row.count || 0),
        risk: "low",
        confidence: row.confidence || "dns-interest",
        evidence_json: JSON.stringify({ client: preparedClient, client_ip: preparedClientIp }),
      });
      })
      .map(operatorDnsRow)
      .filter((row): row is Record<string, any> => Boolean(row))
      .filter((row) => route === "all" || row.route === route)
      .filter((row) => catalogStatus === "all" || row.catalog_status === catalogStatus)
      .filter((row) => status === "all" || String(row.status || "").toLowerCase() === status.toLowerCase())
      .filter((row) => filterRows([row], { ...filters, trafficClass: "all" }).length > 0);
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
  if (USE_PREPARED_WINDOWS && period !== "today") {
    return { rows: [], total: 0, page: 1, pageSize, totalPages: 1 };
  }
  if (!readModelHasRows("dns_query_log")) {
    const rows = normalizedRowsForIds("normalized_dns", snapshotIdsForWindow(period, new Set(["dns", "traffic"])))
      .map(mapDnsFallbackRow)
      .map(operatorDnsRow)
      .filter((row): row is Record<string, any> => Boolean(row))
      .filter((row) => route === "all" || row.route === route)
      .filter((row) => catalogStatus === "all" || row.catalog_status === catalogStatus)
      .filter((row) => status === "all" || String(row.status || "").toLowerCase() === status.toLowerCase())
      .filter((row) => filterRows([row], { ...filters, trafficClass: "all" }).length > 0)
      .slice(0, maxRows);
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
  const latest = idWhereForWindow(period, new Set(["dns", "live"]));
  const where = [latest.sql];
  const params = [...latest.params];
  if (route !== "all") {
    if (route === "VPS") {
      where.push("route = ?");
      params.push(route);
    } else {
      where.push("coalesce(route, '') != 'VPS'");
    }
  }
  if (filters.confidence && filters.confidence !== "all") {
    where.push("confidence = ?");
    params.push(filters.confidence);
  }
  if (status !== "all") {
    where.push("lower(status) = ?");
    params.push(status.toLowerCase());
  }
  if (catalogStatus !== "all") {
    where.push("catalog_status = ?");
    params.push(catalogStatus);
  }
  const search = filters.search?.trim();
  if (search) {
    const needle = `%${search.toLowerCase()}%`;
    where.push("(lower(client) like ? or lower(client_ip) like ? or lower(domain) like ? or lower(answer_ip) like ? or lower(route) like ? or lower(catalog_status) like ?)");
    params.push(needle, needle, needle, needle, needle, needle);
  }
  const whereSql = where.map((item) => `(${item})`).join(" and ");
  const db = getDb();
  const rows = db
    .prepare(
      `select id, snapshot_id, collected_at, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, device_key, domain,
              qtype, answer_ip, route, catalog_status, status, count, risk, confidence, evidence_json
         from dns_query_log
        where ${whereSql}
        order by coalesce(nullif(event_ts, ''), collected_at) desc, id desc
        limit ?`
    )
    .all(...params, maxRows)
    .map(mapDnsReadModelRow)
    .map(operatorDnsRow)
    .filter((row): row is Record<string, any> => Boolean(row))
    .filter((row) => filterRows([row], { ...filters, trafficClass: "all" }).length > 0);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    total,
    page: effectivePage,
    pageSize,
    totalPages,
  };
}

function dnsLayerMeta(layer: "weekly" | "daily" | "hourly" | "5min") {
  if (layer === "weekly") return { table: "dns_log_weekly", timeColumn: "week_start_utc" };
  if (layer === "daily") return { table: "dns_log_daily", timeColumn: "day_start_utc" };
  if (layer === "hourly") return { table: "dns_log_hourly", timeColumn: "hour_start_utc" };
  return { table: "dns_log_5min", timeColumn: "bucket_start_utc" };
}

function dnsEvidenceLatest(row: Record<string, any>) {
  return String(row.latest || row.event_ts || row.display_ts_utc || row.event_ts_utc || row.observed_at_utc || row.collected_at || row.updated_at_utc || "");
}

function dnsEvidenceCount(row: Record<string, any>) {
  const parsed = Number(row.count || row.query_count || row.total || row.rows || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeAppEvidenceSource(app: Record<string, any>, row: Record<string, any>) {
  if (app.app_source !== "app_family_catalog") return app;
  return {
    ...app,
    app_source: row.dns_link_confidence || row.dns_status === "linked" ? "dns_linked" : "dns_exact",
  };
}

function withAppFamily(row: Record<string, any>): Record<string, any> {
  const domain = String(row.domain || row.dns_qname || row.destination || row.destination_key || row.destination_label || "").trim();
  const app = normalizeAppEvidenceSource(classifyAppFamily({
    ...row,
    domain,
    dns_qname: domain || row.dns_qname,
    destination: domain || row.destination,
  }), row);
  const trafficClass = row.traffic_class || trafficClassFor({
    ...row,
    domain,
    dns_qname: domain || row.dns_qname,
    destination: domain || row.destination,
    confidence: row.confidence || "dns-interest",
  });
  return { ...row, ...app, traffic_class: trafficClass, trafficClass };
}

function aggregateClientDnsEvidenceRows(rows: Array<Record<string, any>>, limit = 200) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows || []) {
    const domain = String(row.domain || row.qname || row.dns_qname || row.query || row.destination || "").trim();
    if (!domain || domain === "n/a") continue;
    const key = domain.toLowerCase();
    const latest = dnsEvidenceLatest(row);
    const current = grouped.get(key) || {
      domain,
      dns_qname: domain,
      count: 0,
      latest,
      routes: new Set<string>(),
      catalogStatuses: new Set<string>(),
      confidences: new Set<string>(),
      trafficClasses: new Set<string>(),
      rows: [] as Array<Record<string, any>>,
    };
    current.count += dnsEvidenceCount(row);
    current.rows.push(row);
    if (latest && (!current.latest || Date.parse(latest) > Date.parse(current.latest))) current.latest = latest;
    if (row.route) current.routes.add(dnsRouteValue(row.route));
    if (row.catalog_status) current.catalogStatuses.add(String(row.catalog_status));
    if (row.confidence) current.confidences.add(String(row.confidence));
    const trafficClass = row.traffic_class || trafficClassFor({
      ...row,
      domain,
      dns_qname: domain,
      destination: domain,
      confidence: row.confidence || "dns-interest",
    });
    if (trafficClass) current.trafficClasses.add(String(trafficClass));
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || Date.parse(b.latest || "") - Date.parse(a.latest || "") || String(a.domain).localeCompare(String(b.domain)))
    .slice(0, Math.max(1, Number(limit || 200)))
    .map((row) => {
      const routes = Array.from(row.routes || []);
      const catalogStatuses = Array.from(row.catalogStatuses || []);
      const confidences = Array.from(row.confidences || []);
      const trafficClasses = Array.from(row.trafficClasses || []);
      return withAppFamily({
        domain: row.domain,
        dns_qname: row.domain,
        count: row.count,
        latest: row.latest,
        event_ts: row.latest,
        route: routes.length === 1 ? routes[0] : routes.length > 1 ? "Mixed" : "Unknown",
        catalog_status: catalogStatuses.length === 1 ? catalogStatuses[0] : catalogStatuses.length > 1 ? "mixed" : "unknown",
        confidence: confidences.includes("exact") ? "exact" : confidences[0] || "dns-interest",
        traffic_class: trafficClasses.length === 1 ? trafficClasses[0] : trafficClasses.length > 1 ? "mixed" : "client",
        rows: row.rows,
      });
    });
}

function preparedDnsLayerAvailable(period = "today") {
  if (!USE_PREPARED_WINDOWS) return false;
  return windowAggregateSegmentsForSelector(period).some((segment) => {
    const meta = dnsLayerMeta(segment.layer);
    return aggregateModelHasRows(meta.table, meta.timeColumn, segment.start, segment.end);
  });
}

function preparedClientDnsRows(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const candidates = laneClientKeyCandidates(target);
  if (candidates.length === 0 || !preparedDnsLayerAvailable(period)) return { available: false, rows: [] as Array<Record<string, any>> };
  const match = clientMatchPredicate(["client_key", "client_ip"], candidates);
  if (!match.sql) return { available: true, rows: [] as Array<Record<string, any>> };
  const limit = Math.max(1, Number(options.limit || 500));
  const rows: Array<Record<string, any>> = [];
  const db = getDb();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const meta = dnsLayerMeta(segment.layer);
    rows.push(...db.prepare(`
      select max(client_key) as client_key,
             max(client_ip) as client_ip,
             domain,
             qtype,
             catalog_status,
             route,
             confidence,
             sum(query_count) as count,
             max(${meta.timeColumn}) as latest
        from ${meta.table}
       where ${meta.timeColumn} >= ?
         and ${meta.timeColumn} < ?
         and ${match.sql}
         and coalesce(domain, '') != ''
       group by domain, qtype, catalog_status, route, confidence
       order by count desc, latest desc
       limit ?
    `).all(segment.start, segment.end, ...match.params, limit) as Array<Record<string, any>>);
  }
  return { available: true, rows: aggregateClientDnsEvidenceRows(rows, limit) };
}

function clientDnsRows(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const candidates = laneClientKeyCandidates(target);
  const limit = Math.max(1, Number(options.limit || 500));
  if (candidates.length === 0) return [];
  if (!readModelHasRows("dns_query_log")) {
    const lookup = new Set(candidates.map((value) => value.toLowerCase()));
    return listDnsQueryLog({ page: 1, pageSize: limit, filters: { period, trafficClass: "all" } }).rows
      .filter((row: Record<string, any>) => laneClientKeyCandidates(row).some((value) => lookup.has(value.toLowerCase())))
      .slice(0, limit);
  }
  const latest = idWhereForWindow(period, new Set(["dns", "live"]));
  const match = clientMatchPredicate(["client", "device_key", "client_ip"], candidates);
  if (!match.sql) return [];
  const fetchRows = (matchSql: string, matchParams: Array<string>, fallbackConfidence = "") => getDb()
    .prepare(
      `select id, snapshot_id, collected_at, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, device_key, domain,
              qtype, answer_ip, route, catalog_status, status, count, risk, confidence, evidence_json
         from dns_query_log
        where (${latest.sql})
          and ${matchSql}
          and coalesce(domain, '') != ''
        order by coalesce(nullif(event_ts, ''), collected_at) desc, id desc
        limit ?`
    )
    .all(...latest.params, ...matchParams, limit)
    .map(mapDnsReadModelRow)
    .map(operatorDnsRow)
    .filter((row): row is Record<string, any> => Boolean(row))
    .map((row) => fallbackConfidence ? { ...row, confidence: fallbackConfidence, dns_link_confidence: fallbackConfidence } : row);
  const rows = fetchRows(match.sql, match.params);
  if (rows.length > 0) return rows;
  const fallbackMatch = isMobileProfileTarget(target)
    ? clientMatchPredicate(["client", "device_key"], genericDeviceDnsAliases(target))
    : { sql: "", params: [] as Array<string> };
  if (fallbackMatch.sql) {
    const genericRows = fetchRows(fallbackMatch.sql, fallbackMatch.params, "dns-generic-device");
    if (genericRows.length > 0) return genericRows;
  }
  const lookup = new Set(candidates.map((value) => value.toLowerCase()));
  return getDb()
    .prepare(
      `select id, snapshot_id, collected_at, event_ts, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, device_key, domain,
              qtype, answer_ip, route, catalog_status, status, count, risk, confidence, evidence_json
         from dns_query_log
        where (${latest.sql})
          and coalesce(domain, '') != ''
        order by coalesce(nullif(event_ts, ''), collected_at) desc, id desc
        limit ?`
    )
    .all(...latest.params, Math.max(limit * 20, 1000))
    .map(mapDnsReadModelRow)
    .map(operatorDnsRow)
    .filter((row): row is Record<string, any> => Boolean(row))
    .filter((row) => laneClientKeyCandidates(row).some((value) => lookup.has(value.toLowerCase())))
    .slice(0, limit);
}

export function listClientDnsEvidence(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const key = laneClientKeyCandidates(target).join("|");
  const limit = Math.max(1, Number(options.limit || 200));
  return cacheGet(`client-dns-evidence:${latestSnapshotVersion()}:${period}:${key}:${limit}`, () => {
    const prepared = preparedClientDnsRows(target, period, { limit: Math.max(limit * 4, 200) });
    if (prepared.available && prepared.rows.length > 0) return prepared.rows.slice(0, limit);
    const fallback = aggregateClientDnsEvidenceRows(clientDnsRows(target, period, { limit: Math.max(limit * 4, 200) }), limit);
    if (fallback.length > 0) return fallback;
    return prepared.available ? [] : fallback;
  });
}

export function listClientDnsDomains(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  return listClientDnsEvidence(client, period, options);
}

function normalizedSiteKey(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function siteEvidenceBytes(row: Record<string, any>) {
  return Number(row.effective_bytes || row.bytes || row.total_bytes || 0);
}

function isIpOnlyDestinationValue(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return !text
    || text === "ip-only destination"
    || text.includes("ip-only destination")
    || text.includes("ip only")
    || /^(\d{1,3}\.){3}\d{1,3}$/.test(text)
    || /^[0-9a-f:.]+$/i.test(text);
}

function coarseSiteLabel(row: Record<string, any>) {
  if (!isUsefulCoarseAttribution(row)) return "";
  const provider = String(row.provider || "").trim();
  const category = String(row.category || row.dns_category || "").trim();
  const unusable = new Set(["unknown", "unknown_provider", "unknown_domain", "unclassified", "ip-only", "ip only", "unknown ip", "unknown ip only"]);
  if (provider && !unusable.has(provider.toLowerCase())) return provider;
  if (category && !unusable.has(category.toLowerCase().replace(/[_.-]+/g, " "))) return category.replace(/[_.-]+/g, " ");
  return "";
}

function byteSiteLabel(row: Record<string, any>) {
  if (isInternalGhostRouteRow(row)) return "";
  for (const value of [row.domain, row.dns_qname, row.sni, row.destination_key, row.destination_label, row.destination]) {
    if (isDomainLikeValue(value)) return String(value).trim().toLowerCase();
  }
  if (!isIpOnlyDestinationValue(row.destination_key) && !isIpOnlyDestinationValue(row.destination_label || row.destination)) {
    const label = String(row.destination_label || row.destination_key || row.destination || "").trim();
    if (label && !isPseudoDestinationValue(label) && !isAggregateResidualLabel(label) && !isIpOnlyAttributionLabel(label)) return label;
  }
  return coarseSiteLabel(row);
}

function clientFacingDnsEvidenceRows(rows: Array<Record<string, any>>, includeService = false) {
  return rows.filter((row) => {
    const domain = String(row.domain || row.dns_qname || "").trim();
    if (!domain || !isDomainLikeValue(domain)) return false;
    if (includeService) return true;
    const trafficClass = row.traffic_class || trafficClassFor({
      ...row,
      domain,
      dns_qname: domain,
      destination: domain,
      confidence: row.confidence || "dns-interest",
    });
    return trafficClass !== "service_background";
  });
}

function makeSiteEvidenceRow(base: Record<string, any>): Record<string, any> {
  const domain = String(base.domain || base.dns_qname || "").trim().toLowerCase();
  const label = String(base.url_label || domain || base.label || base.destinationLabel || base.destination || "Other / uncategorized").trim();
  const app = withAppFamily({
    ...base,
    domain,
    dns_qname: domain || base.dns_qname,
    destination: domain || label,
    category: base.category || base.dns_category,
    provider: base.provider,
  });
  const effective = Number(base.effective_bytes || base.bytes || base.total_bytes || 0);
  const factual = Number(base.factual_bytes || 0);
  const inferred = Number(base.inferred_bytes || 0);
  return decorateAttributionEligibility({
    ...base,
    ...app,
    domain,
    url_label: label,
    label,
    destination: label,
    destinationLabel: label,
    effective_bytes: effective,
    bytes: effective,
    total_bytes: effective,
    factual_bytes: factual,
    inferred_bytes: inferred,
    dns_queries: Number(base.dns_queries || base.count || 0),
    latest: base.latest || base.last_seen_utc || base.collected_at || "",
    attribution_source: base.attribution_source || (factual > 0 ? "byte_exact" : inferred > 0 ? "dns_inferred" : "aggregate_residual"),
    byte_confidence: base.byte_confidence || (factual > 0 && inferred <= 0 ? "factual" : inferred > 0 ? "estimated" : "residual"),
  });
}

function mergeSiteEvidenceRows(rows: Array<Record<string, any>>, limit = 200) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const label = String(row.domain || row.url_label || row.label || row.destination || "").trim();
    if (!label) continue;
    const key = normalizedSiteKey(label);
    const current = grouped.get(key) || {
      ...row,
      effective_bytes: 0,
      bytes: 0,
      total_bytes: 0,
      factual_bytes: 0,
      inferred_bytes: 0,
      dns_queries: 0,
      flows: 0,
      routes: new Set<string>(),
      attributionSources: new Set<string>(),
      confidences: new Set<string>(),
    };
    const effective = siteEvidenceBytes(row);
    current.effective_bytes += effective;
    current.bytes += effective;
    current.total_bytes += effective;
    current.factual_bytes += Number(row.factual_bytes || 0);
    current.inferred_bytes += Number(row.inferred_bytes || 0);
    current.dns_queries += Number(row.dns_queries || row.count || 0);
    current.flows += Number(row.flows || row.connections || 0);
    if (row.route) current.routes.add(String(row.route));
    if (row.attribution_source) current.attributionSources.add(String(row.attribution_source));
    if (row.byte_confidence || row.confidence) current.confidences.add(String(row.byte_confidence || row.confidence));
    if (String(row.latest || row.last_seen_utc || row.collected_at || "") > String(current.latest || "")) current.latest = row.latest || row.last_seen_utc || row.collected_at || "";
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.effective_bytes || 0) - Number(a.effective_bytes || 0) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0) || Date.parse(b.latest || "") - Date.parse(a.latest || ""))
    .slice(0, Math.max(1, Number(limit || 200)))
    .map((row, idx) => {
      const routes = Array.from(row.routes || []);
      const attributionSources = Array.from(row.attributionSources || []);
      const confidences = Array.from(row.confidences || []);
      return {
        ...row,
        rank: idx + 1,
        route: routes.length === 1 ? routes[0] : routes.length > 1 ? "Mixed" : row.route || "Unknown",
        attribution_source: attributionSources.includes("byte_exact") ? "byte_exact" : attributionSources[0] || row.attribution_source || "dns_inferred",
        byte_confidence: confidences.includes("factual") ? "factual" : confidences.includes("estimated") ? "estimated" : confidences[0] || row.byte_confidence || "estimated",
        routes: undefined,
        attributionSources: undefined,
        confidences: undefined,
      };
    });
}

function distributeResidualBytes(residualBytes: number, dnsRows: Array<Record<string, any>>, target: Record<string, any>) {
  const totalQueries = dnsRows.reduce((sum, row) => sum + Number(row.count || row.dns_queries || 0), 0);
  if (residualBytes <= 0 || totalQueries <= 0) return [];
  let allocated = 0;
  return dnsRows.map((row, index) => {
    const count = Number(row.count || row.dns_queries || 0);
    const inferred = index === dnsRows.length - 1
      ? Math.max(0, residualBytes - allocated)
      : Math.round(residualBytes * (count / totalQueries));
    allocated += inferred;
    return makeSiteEvidenceRow({
      ...row,
      url_label: row.domain,
      effective_bytes: inferred,
      factual_bytes: 0,
      inferred_bytes: inferred,
      dns_queries: count,
      flows: count,
      route: row.route || target.route || "Unknown",
      attribution_source: "dns_inferred",
      byte_confidence: "estimated",
      confidence: row.confidence || "dns-inferred",
    });
  }).filter((row) => Number(row.effective_bytes || 0) > 0);
}

function scaleCoarseRowsToResidual(rows: Array<Record<string, any>>, targetBytes: number) {
  const total = rows.reduce((sum, row) => sum + Number(row.factual_bytes || row.effective_bytes || row.bytes || 0), 0);
  if (targetBytes <= 0 || total <= 0) return rows;
  let allocated = 0;
  return rows.map((row, index) => {
    const base = Number(row.factual_bytes || row.effective_bytes || row.bytes || 0);
    const effective = index === rows.length - 1
      ? Math.max(0, Math.round(targetBytes - allocated))
      : Math.round(targetBytes * (base / total));
    allocated += effective;
    return makeSiteEvidenceRow({
      ...row,
      effective_bytes: effective,
      bytes: effective,
      total_bytes: effective,
      factual_bytes: base,
      inferred_bytes: Math.max(0, effective - base),
      attribution_source: row.attribution_source || (row.provider ? "provider_hint" : "category_hint"),
      byte_confidence: "estimated",
      confidence: row.confidence || "estimated",
    });
  }).filter((row) => Number(row.effective_bytes || 0) > 0);
}

function clientWindowTrafficSummary(target: Record<string, any>, period = "today") {
  const keys = uniqueNonEmpty([resolveLaneClientKey(target, "client_traffic_by_lane"), ...laneClientKeyCandidates(target)]);
  const match = clientMatchPredicate(["client_key", "client_label"], keys);
  const laneSummary = {
    bytes: 0,
    total_bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    flows: 0,
    last_seen_utc: "",
  };
  if (!match.sql) return laneSummary;
  const db = getDb();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const rows = db.prepare(`
      select sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             max(last_seen_utc) as last_seen_utc
        from client_traffic_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and traffic_lane = 'all'
         and ${match.sql}
    `).get(granularity, segment.start, segment.end, ...match.params) as Record<string, any> | undefined;
    const bytes = Number(rows?.bytes || 0);
    laneSummary.bytes += bytes;
    laneSummary.total_bytes += bytes;
    laneSummary.via_vps_bytes += Number(rows?.via_vps_bytes || 0);
    laneSummary.direct_bytes += Number(rows?.direct_bytes || 0);
    laneSummary.unknown_bytes += Number(rows?.unknown_bytes || 0);
    laneSummary.flows += Number(rows?.flows || 0);
    if (String(rows?.last_seen_utc || "") > laneSummary.last_seen_utc) laneSummary.last_seen_utc = String(rows?.last_seen_utc || "");
  }
  const lookup = new Set(keys.map((value) => value.toLowerCase()));
  const deviceSummary = {
    bytes: 0,
    total_bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    flows: laneSummary.flows,
    last_seen_utc: laneSummary.last_seen_utc,
  };
  const seen = new Set<string>();
  for (const rawRow of deviceDeltaRowsForPeriod(period)) {
    const row = inventoryRowFromTraffic(rawRow) || rawRow;
    if (!isTrustedDeviceCounterSource(row, rawRow)) continue;
    const rowCandidates = laneClientKeyCandidates(row);
    if (!rowCandidates.some((value) => lookup.has(value.toLowerCase()))) continue;
    const rowKey = String(row.client_key || row.id || row.device_key || rawRow.id || rawRow.device_id || row.label || "").trim();
    if (rowKey && seen.has(rowKey)) continue;
    if (rowKey) seen.add(rowKey);
    const bytes = observedByteValue(row);
    deviceSummary.bytes += bytes;
    deviceSummary.total_bytes += bytes;
    deviceSummary.via_vps_bytes += Number(row.via_vps_bytes || 0);
    deviceSummary.direct_bytes += Number(row.direct_bytes || 0);
    deviceSummary.unknown_bytes += Number(row.unknown_bytes || Math.max(0, bytes - Number(row.via_vps_bytes || 0) - Number(row.direct_bytes || 0)));
    const seenAt = String(row.last_seen || row.last_seen_utc || row.collected_at || row.traffic_collected_at || "");
    if (seenAt > deviceSummary.last_seen_utc) deviceSummary.last_seen_utc = seenAt;
  }
  return observedByteValue(deviceSummary) > observedByteValue(laneSummary) ? deviceSummary : laneSummary;
}

export function listClientSiteEvidence(client: Record<string, any> | string, period = "today", options: { limit?: number; includeService?: boolean } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const keys = uniqueNonEmpty([resolveLaneClientKey(target, "client_destination_by_lane"), ...laneClientKeyCandidates(target)]);
  const limit = Math.max(1, Number(options.limit || 200));
  const includeService = Boolean(options.includeService);
  return cacheGet(`client-site-evidence:${latestSnapshotVersion()}:${period}:${keys.join("|")}:${limit}:${includeService}`, () => {
    const byteRows = clientDestinationLaneRows(keys, period, "all");
    const dnsRows = clientFacingDnsEvidenceRows(listClientDnsEvidence(target, period, { limit: Math.max(limit * 4, 200) }), includeService);
    const byDomainDns = new Map(dnsRows.map((row) => [normalizedSiteKey(row.domain), row]));
    const byteEvidenceRows = byteRows
      .map((row) => {
        const label = byteSiteLabel(row);
        if (!label) return null;
        const source = isDomainLikeValue(label)
          ? "byte_exact"
          : row.provider ? "provider_hint" : row.category || row.dns_category ? "category_hint" : "";
        if (!source) return null;
        const dns = byDomainDns.get(normalizedSiteKey(label));
        return makeSiteEvidenceRow({
          ...row,
          domain: isDomainLikeValue(label) ? label : "",
          url_label: label,
          effective_bytes: Number(row.bytes || row.total_bytes || 0),
          factual_bytes: Number(row.bytes || row.total_bytes || 0),
          inferred_bytes: 0,
          dns_queries: Number(dns?.count || 0),
          latest: row.last_seen_utc || dns?.latest || "",
          attribution_source: source,
          byte_confidence: source === "byte_exact" ? "factual" : "estimated",
        });
      })
      .filter((row) => row && isAttributableSiteRow(row, { includeService }))
      .filter(Boolean) as Array<Record<string, any>>;
    const exactRows = byteEvidenceRows.filter((row) => row.attribution_source === "byte_exact");
    const coarseRows = byteEvidenceRows.filter((row) => row.attribution_source !== "byte_exact");
    const exactFactualBytes = exactRows
      .filter((row) => row.attribution_source === "byte_exact")
      .reduce((sum, row) => sum + Number(row.factual_bytes || 0), 0);
    const windowSummary = clientWindowTrafficSummary(target, period);
    const targetBytes = observedByteValue(windowSummary) || observedByteValue(target);
    const residualBytes = Math.max(0, Math.round(targetBytes - exactFactualBytes));
    const factualDomainKeys = new Set(exactRows.map((row) => normalizedSiteKey(row.domain || row.url_label)).filter(Boolean));
    const residualDnsRows = dnsRows.filter((row) => !factualDomainKeys.has(normalizedSiteKey(row.domain)));
    const inferredRows = distributeResidualBytes(residualBytes, residualDnsRows.length ? residualDnsRows : dnsRows, target);
    const coarseEffectiveRows = inferredRows.length > 0
      ? []
      : scaleCoarseRowsToResidual(coarseRows, Math.max(0, targetBytes - exactFactualBytes));
    const coarseEffectiveBytes = coarseEffectiveRows.reduce((sum, row) => sum + Number(row.factual_bytes || row.effective_bytes || 0), 0);
    const fallbackBytes = Math.max(0, Math.round(targetBytes - exactFactualBytes - coarseEffectiveBytes));
    const hasUsefulEvidence = exactRows.length > 0 || coarseEffectiveRows.length > 0 || dnsRows.length > 0;
    const residualFallback = fallbackBytes > 0 && inferredRows.length === 0 && hasUsefulEvidence
      ? [makeSiteEvidenceRow({
        url_label: "Other / uncategorized",
        effective_bytes: fallbackBytes,
        factual_bytes: 0,
        inferred_bytes: fallbackBytes,
        dns_queries: 0,
        route: target.route || "Unknown",
        attribution_source: "aggregate_residual",
        byte_confidence: "residual",
        confidence: "estimated",
      })]
      : [];
    const evidence: Array<Record<string, any>> = mergeSiteEvidenceRows([...exactRows, ...coarseEffectiveRows, ...inferredRows, ...residualFallback], limit)
      .filter((row) => isAttributableSiteRow(row, { includeService }) || String(row.attribution_source || "") === "aggregate_residual");
    const returnedBytes = evidence.reduce((sum, row) => sum + siteEvidenceBytes(row), 0);
    const hiddenTailBytes = Math.max(0, Math.round(targetBytes - returnedBytes));
    if (hiddenTailBytes > Math.max(64 * 1024, targetBytes * 0.02)) {
      evidence.push(makeSiteEvidenceRow({
        url_label: "Other / uncategorized",
        effective_bytes: hiddenTailBytes,
        factual_bytes: 0,
        inferred_bytes: hiddenTailBytes,
        dns_queries: Math.max(0, dnsRows.reduce((sum, row) => sum + Number(row.count || row.dns_queries || 0), 0) - evidence.reduce((sum, row) => sum + Number(row.dns_queries || 0), 0)),
        route: target.route || "Unknown",
        attribution_source: "aggregate_residual",
        byte_confidence: "residual",
        confidence: "estimated",
        matched_pattern: "truncated DNS evidence tail",
      }));
    }
    return evidence
      .sort((a, b) => siteEvidenceBytes(b) - siteEvidenceBytes(a) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0))
      .map((row, idx) => ({ ...row, rank: idx + 1 }));
  });
}

function siteEvidenceRowsForFilters(filters: ConsoleFilters = {}, options: { limit?: number; perClientLimit?: number; includeService?: boolean } = {}) {
  const period = filters.period || "today";
  const limit = Math.max(1, Number(options.limit || 5000));
  const perClientLimit = Math.max(10, Number(options.perClientLimit || 80));
  const includeService = Boolean(options.includeService);
  const clients = clientInventoryRows({ ...filters, client: "all", trafficClass: "all" })
    .filter((row) => observedByteValue(row) > 0)
    .slice(0, 250);
  const rows: Array<Record<string, any>> = [];
  for (const client of clients) {
    rows.push(...listClientSiteEvidence(client, period, { limit: perClientLimit, includeService }));
    if (rows.length >= limit * 2) break;
  }
  const route = filters.route && filters.route !== "all" ? String(filters.route) : "";
  const trafficClass = filters.trafficClass && filters.trafficClass !== "all" ? String(filters.trafficClass) : "";
  const search = filters.search?.trim().toLowerCase() || "";
  return rows
    .filter((row) => !route || row.route === route || row.route === "Mixed")
    .filter((row) => !trafficClass || row.traffic_class === trafficClass || row.trafficClass === trafficClass)
    .filter((row) => {
      if (!search) return true;
      return [row.domain, row.url_label, row.label, row.destination, row.app_family, row.app_category, row.provider, row.category]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .slice(0, limit);
}

export function listSiteEvidenceRows(filters: ConsoleFilters = {}, options: { limit?: number; perClientLimit?: number; includeService?: boolean } = {}) {
  return cacheGet(`site-evidence-rows:${latestSnapshotVersion()}:${filtersKey(filters)}:${options.limit || 0}:${options.perClientLimit || 0}:${Boolean(options.includeService)}`, () => {
    return siteEvidenceRowsForFilters(filters, options);
  });
}

function mapAlarmReadModelRow(row: any) {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    collected_at: row.collected_at,
    created_at: row.collected_at,
    severity: row.severity,
    source: row.source,
    title: row.title,
    status: row.status,
    evidence: row.evidence,
    suggested_action: row.suggested_action,
    snoozed_until: row.snoozed_until,
    confidence: row.confidence,
    risk: row.risk,
    raw: evidenceJson(row),
  };
}

function mapAlarmFallbackRow(row: any) {
  return {
    id: stableAlarmId(row.snapshot_id || "local", row.snapshot_type, row.title, row.collected_at),
    snapshot_id: row.snapshot_id,
    collected_at: row.collected_at,
    created_at: row.collected_at,
    severity: row.severity,
    source: row.snapshot_type,
    title: row.title,
    status: row.status || "open",
    evidence: row.evidence,
    suggested_action: "",
    snoozed_until: "",
    confidence: row.confidence,
    risk: row.severity === "critical" ? "high" : row.severity === "info" ? "low" : "medium",
    raw: row.raw,
  };
}

export function listAlarmEvents(args: AlarmPageArgs = {}) {
  return cacheGet(`list-alarm-events:${latestSnapshotVersion()}:${alarmPageArgsKey(args)}`, () => listAlarmEventsUncached(args));
}

function listAlarmEventsUncached(args: AlarmPageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, 100);
  const filters = args.filters || {};
  const period = filters.period || "today";
  const severity = args.severity || "all";
  const status = args.status || "all";
  const source = args.source || "all";
  const state = readAlarmState();
  if (!readModelHasRows("alarm_events")) {
    const ids = snapshotIdsForWindow(period, ALERT_CONTEXT_TYPES);
    const rows = overlayAlarmState(normalizedRowsForIds("normalized_alerts", ids)
      .map(mapAlarmFallbackRow)
      .filter((row) => severity === "all" || String(row.severity || "").toLowerCase() === severity.toLowerCase())
      .filter((row) => source === "all" || row.source === source)
      .filter((row) => {
        const search = filters.search?.trim().toLowerCase();
        if (!search) return true;
        return [row.title, row.source, row.severity, row.status, row.evidence, row.suggested_action].filter(Boolean).join(" ").toLowerCase().includes(search);
      }), state)
      .filter((row) => alarmStatusMatches(row, status));
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
  const latest = idWhereForWindow(period, ALERT_CONTEXT_TYPES);
  const where = [latest.sql];
  const params = [...latest.params];
  if (severity !== "all") {
    where.push("lower(severity) = ?");
    params.push(severity.toLowerCase());
  }
  if (source !== "all") {
    where.push("source = ?");
    params.push(source);
  }
  const search = filters.search?.trim();
  if (search) {
    const needle = `%${search.toLowerCase()}%`;
    where.push("(lower(title) like ? or lower(source) like ? or lower(severity) like ? or lower(status) like ? or lower(evidence) like ? or lower(suggested_action) like ?)");
    params.push(needle, needle, needle, needle, needle, needle);
  }
  const whereSql = where.map((item) => `(${item})`).join(" and ");
  const db = getDb();
  const fetchLimit = 500;
  const candidates = overlayAlarmState(db
    .prepare(
      `select id, snapshot_id, collected_at, severity, source, title, status, evidence,
               suggested_action, snoozed_until, confidence, risk, evidence_json
          from alarm_events
         where ${whereSql}
         order by case lower(severity) when 'critical' then 0 when 'warning' then 1 when 'review' then 2 when 'info' then 3 else 4 end,
                  collected_at desc,
                  id desc
         limit ?`
    )
    .all(...params, fetchLimit)
    .map(mapAlarmReadModelRow), state)
    .filter((row) => alarmStatusMatches(row, status));
  const total = candidates.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  const rows = candidates.slice(offset, offset + pageSize);
  return {
    rows,
    total,
    page: effectivePage,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function buildChromeModel(filters: ConsoleFilters, overrides: Partial<ConsoleModel> = {}): ConsoleModel {
  const snapshotMetas = latestByType(latestSnapshotMetaRecords());
  const snapshots = cachedLatestByTypes(["traffic_summary", "health", "leaks", "deploy_gate"]);
  const period = filters.period || "today";
  const trafficSummarySnapshot = latestWindowSnapshot(snapshots, "traffic_summary", period);
  const trafficSummary = trafficSummarySnapshot?.payload || {};
  const dashboardTraffic = trafficSummary;
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
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
  const normalizedAlerts = listAlarmEvents({ page: 1, pageSize: 50, filters }).rows.map((row: any) => ({
    severity: row.severity,
    title: row.title,
    source: row.source,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence,
    suggested_action: row.suggested_action,
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
  const devices = clientInventoryRows(filters).slice(0, 200);
  const dnsQueries = listDnsQueryLog({ page: 1, pageSize: 80, filters: { ...filters, trafficClass: "all" } }).rows;
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
    runtime: runtimeInfo(snapshotMetas),
    collectorErrors,
    collectorRun: collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null),
    hourlyTraffic: [],
    events: [],
    routeDecisions: [],
    catalogReviews: [],
    notifications: [],
    notificationSettings: {},
    auditLog: [],
    opsRuns: [],
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
    destinationAttributionCoverage: destinationAttributionCoverageForPeriod(period),
    devices,
    flows: [],
    dnsQueries,
    alerts: dedupeAlerts([...staleAlert, ...normalizedAlerts, ...leakAlerts]),
    catalog: [],
  };
  return { ...model, ...definedOverrides(overrides) };
}

export function buildShellModel(filters: ConsoleFilters = {}, overrides: Partial<ConsoleModel> = {}): ConsoleModel {
  const snapshotMetas = latestByType(latestSnapshotMetaRecords());
  const snapshots = cachedLatestByTypes(["traffic_summary", "health", "leaks", "deploy_gate"]);
  const period = filters.period || "today";
  const trafficSummarySnapshot = latestWindowSnapshot(snapshots, "traffic_summary", period);
  const dashboardTraffic = trafficSummarySnapshot?.payload?.totals ? trafficSummarySnapshot.payload : {};
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const newest = Object.values(snapshotMetas)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();
  const staleMinutes = minutesSince(newest);
  const staleThreshold = staleThresholdMinutes();
  const collectorDisabled = (process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled") === "disabled";
  const collectorErrors = collectorDisabled ? [] : (latestCollectorErrors(3) as Array<Record<string, any>>);
  const leakAlerts = (leaks.leaks || []).map((row: any) => ({
    severity: row.severity || "warning",
    title: row.label || row.probe,
    source: "leak-check",
    status: row.status,
    evidence: row.evidence,
    confidence: row.confidence || "exact",
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
  const alarmRows = listAlarmEvents({ page: 1, pageSize: 50, filters }).rows;
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
    runtime: runtimeInfo(snapshotMetas),
    collectorErrors,
    collectorRun: collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null),
    hourlyTraffic: [],
    events: [],
    routeDecisions: [],
    catalogReviews: [],
    notifications: [],
    notificationSettings: {},
    auditLog: [],
    opsRuns: [],
    snapshots,
    statusCards,
    totals: {
      observedBytes: Number(totals.client_observed_bytes || 0),
      viaVpsBytes: Number(totals.via_vps_bytes || 0),
      directBytes: Number(totals.direct_bytes || 0),
      unknownBytes: Number(totals.unknown_bytes || 0),
      periodLabel: trafficPeriodLabel(dashboardTraffic),
      windowLabel: trafficWindowLabel(dashboardTraffic),
    },
    destinationAttributionCoverage: destinationAttributionCoverageForPeriod(period),
    devices: [],
    flows: [],
    dnsQueries: [],
    alerts: dedupeAlerts([...staleAlert, ...alarmRows, ...leakAlerts, ...collectorErrors.map((row) => ({
      severity: "warning",
      title: row.type || "collector warning",
      source: "collector",
      status: "WARN",
      evidence: row.message || "",
      confidence: "exact",
    }))]),
    catalog: [],
  };
  return { ...model, ...definedOverrides(overrides) };
}

export function buildLightweightShellModel(filters: ConsoleFilters = {}, overrides: Partial<ConsoleModel> = {}): ConsoleModel {
  const snapshotMetas = latestByType(latestSnapshotMetaRecords());
  const snapshots = cachedLatestByTypes(["traffic_summary"]);
  const period = filters.period || "today";
  const trafficSummarySnapshot = latestWindowSnapshot(snapshots, "traffic_summary", period);
  const dashboardTraffic = trafficSummarySnapshot?.payload?.totals ? trafficSummarySnapshot.payload : {};
  const shellSummary = getConsolePageSummary("health_shell")?.payload || getConsolePageSummary("health_mobile")?.payload || {};
  const newest = Object.values(snapshotMetas)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();
  const staleMinutes = minutesSince(newest);
  const staleThreshold = staleThresholdMinutes();
  const collectorDisabled = (process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled") === "disabled";
  const collectorErrors = collectorDisabled ? [] : (latestCollectorErrors(2) as Array<Record<string, any>>);
  const totals = dashboardTraffic.totals || shellSummary.totals || {};
  const statusCards = Array.isArray(shellSummary.statusCards) && shellSummary.statusCards.length > 0
    ? shellSummary.statusCards
    : [
        { label: "Router", status: "UNKNOWN", detail: "not observed" },
        { label: "Reality", status: "UNKNOWN", detail: "home ingress / reality-out" },
        { label: "DNS", status: "UNKNOWN", detail: "dnscrypt + policy" },
        { label: "IPv6", status: "UNKNOWN", detail: "not in routing scope" },
        { label: "Rule-set", status: "UNKNOWN", detail: "catalog mirror" },
        { label: "Leaks", status: "UNKNOWN", detail: "0 signals" },
      ];
  const summaryAlerts = Array.isArray(shellSummary.alarms) ? shellSummary.alarms : [];
  const model: ConsoleModel = {
    generatedAt: new Date().toISOString(),
    freshnessMinutes: staleMinutes,
    freshnessStatus: staleMinutes === null ? "empty" : staleMinutes > staleThreshold || collectorErrors.length > 0 ? "stale" : "fresh",
    freshnessLabel: newest || "",
    nextExpectedCollection: nextExpectedCollection(newest),
    staleThresholdMinutes: staleThreshold,
    runtime: runtimeInfo(snapshotMetas),
    collectorErrors,
    collectorRun: collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null),
    hourlyTraffic: [],
    events: [],
    routeDecisions: [],
    catalogReviews: [],
    notifications: [],
    notificationSettings: {},
    auditLog: [],
    opsRuns: [],
    snapshots,
    statusCards,
    totals: {
      observedBytes: Number(totals.client_observed_bytes || totals.observedBytes || 0),
      viaVpsBytes: Number(totals.via_vps_bytes || totals.viaVpsBytes || 0),
      directBytes: Number(totals.direct_bytes || totals.directBytes || 0),
      unknownBytes: Number(totals.unknown_bytes || totals.unknownBytes || 0),
      periodLabel: trafficPeriodLabel(dashboardTraffic),
      windowLabel: trafficWindowLabel(dashboardTraffic),
    },
    destinationAttributionCoverage: undefined,
    devices: [],
    flows: [],
    dnsQueries: [],
    alerts: summaryAlerts,
    catalog: [],
  };
  return { ...model, ...definedOverrides(overrides) };
}

const dashboardNonDestinations = new Set([
  "client",
  "no site evidence",
  "encrypted ingress traffic",
  "n/a",
  "unknown",
  "unknown ip",
  "unknown ip only",
  "ip only",
  "ip-only destination",
  "unknown destination",
  "traffic without site attribution",
  "other / uncategorized",
]);

function dashboardRouteSplit(row: Record<string, any>) {
  const bytes = siteEvidenceBytes(row);
  const viaVps = Number(row.via_vps_bytes || row.viaVpsBytes || (row.route === "VPS" ? bytes : 0) || 0);
  const direct = Number(row.direct_bytes || row.directBytes || (row.route === "Direct" ? bytes : 0) || 0);
  const unknown = Math.max(0, bytes - viaVps - direct);
  return { viaVps, direct, unknown };
}

function dashboardRouteFromRoutes(routes: Set<string>) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return "Mixed";
}

function dashboardDestinationSection(row: Record<string, any>) {
  const trafficClass = String(row.trafficClass || row.traffic_class || "").trim();
  const lane = String(row.traffic_lane || row.lane || "").trim();
  if (lane === "service_system" || trafficClass === "service_background") return "service";
  return "client";
}

function dashboardIsServiceEvidenceRow(row: Record<string, any>) {
  const eligibility = attributionEligibility(row);
  if (eligibility.serviceOnly) return true;
  return dashboardDestinationSection(row) === "service"
    || row.traffic_role === "service_system"
    || row.app_category === "service_system"
    || row.app_family === "Service / system";
}

function dashboardDomainForRow(row: Record<string, any>) {
  for (const candidate of [row.dns_qname, row.sni, row.domain, row.destination, row.raw?.dns_qname, row.raw?.sni, row.raw?.domain]) {
    if (isDomainLikeValue(candidate)) return String(candidate).trim();
  }
  return "";
}

function hasDashboardEvidenceDestination(row: Record<string, any>) {
  if (row.accounting_bucket || row.raw?.accounting_bucket) return false;
  if (!isAttributableSiteRow(row, { includeService: true })) return false;
  const label = trafficDisplayDestination(row).trim();
  if (dashboardNonDestinations.has(label.toLowerCase())) return false;
  return isPrimaryTrafficDestinationLabel(label);
}

function dashboardDestinationDetail(row: Record<string, any>) {
  const domains = row.domains instanceof Set ? Array.from(row.domains) : [];
  const domain = domains.length ? String(domains[0]).trim() : "";
  return domain || String(row.destinationLabel || row.label || "").trim();
}

function groupDashboardEvidenceDestinations(rows: Array<Record<string, any>>, limit = 10) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const bytes = siteEvidenceBytes(row);
    if (bytes <= 0 || !hasDashboardEvidenceDestination(row)) continue;
    const label = trafficDisplayDestination(row).trim();
    const section = dashboardDestinationSection(row);
    const key = `${section}|${label.toLowerCase()}`;
    const current = grouped.get(key) || {
      ...row,
      destinationLabel: label,
      label,
      section,
      bytes: 0,
      total_bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      viaVpsBytes: 0,
      directBytes: 0,
      unknownBytes: 0,
      connections: 0,
      clients: new Set<string>(),
      routes: new Set<string>(),
      domains: new Set<string>(),
    };
    const split = dashboardRouteSplit(row);
    current.bytes += bytes;
    current.total_bytes += bytes;
    current.via_vps_bytes += split.viaVps;
    current.direct_bytes += split.direct;
    current.unknown_bytes += split.unknown;
    current.viaVpsBytes += split.viaVps;
    current.directBytes += split.direct;
    current.unknownBytes += split.unknown;
    current.connections += Number(row.connections || row.flows || 0);
    if (row.client_key || row.client_label || row.client) current.clients.add(String(row.client_key || row.client_label || row.client));
    if (row.route) current.routes.add(String(row.route));
    const domain = dashboardDomainForRow(row);
    if (domain) current.domains.add(domain);
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0) || Number(b.connections || 0) - Number(a.connections || 0))
    .slice(0, limit)
    .map((row, idx) => ({
      ...row,
      rank: idx + 1,
      route: dashboardRouteFromRoutes(row.routes || new Set()),
      detail: [
        dashboardDestinationDetail(row),
        row.clients?.size ? `${row.clients.size} client${row.clients.size === 1 ? "" : "s"}` : "",
        row.connections ? `${row.connections} sessions` : "",
      ].filter(Boolean).join(" · "),
    }));
}

function dashboardEvidenceAnalytics(filters: ConsoleFilters = {}) {
  const siteRows = siteEvidenceRowsForFilters(
    { ...filters, trafficClass: "all", client: "all" },
    { limit: 5000, perClientLimit: 120, includeService: true }
  ).filter((row) => siteEvidenceBytes(row) > 0);
  const clientRows = siteRows.filter((row) => !dashboardIsServiceEvidenceRow(row));
  const serviceRows = siteRows.filter(dashboardIsServiceEvidenceRow);
  return {
    topDestinations: groupDashboardEvidenceDestinations(clientRows, 10),
    topAppFamilies: groupAppFamilyRowsFromSiteEvidence(clientRows).slice(0, 10),
    serviceBackgroundTraffic: groupDashboardEvidenceDestinations(serviceRows, 10),
  };
}

function mergeDashboardAnalyticsWithEvidence(base: Record<string, any> = {}, filters: ConsoleFilters = {}) {
  const evidence = dashboardEvidenceAnalytics(filters);
  return {
    ...base,
    topDestinations: evidence.topDestinations.length ? evidence.topDestinations : base.topDestinations || [],
    topAppFamilies: evidence.topAppFamilies,
    serviceBackgroundTraffic: evidence.serviceBackgroundTraffic,
  };
}

export function buildDashboardModel(filters: ConsoleFilters = {}): ConsoleModel {
  return cacheGet(`build-dashboard-model:${latestSnapshotVersion()}:${filtersKey(filters)}`, () => buildDashboardModelUncached(filters));
}

function buildDashboardModelUncached(filters: ConsoleFilters = {}): ConsoleModel {
  const period = filters.period || "today";
  const prepared = preparedDashboard(period, filters.trafficClass || "all");
  if (prepared) {
    const shell = buildShellModel(filters, {
      devices: (prepared.devices || []).map((row: any) => decorateTrafficRow(row)),
      flows: (prepared.flows || []).map((row: any) => decorateTrafficRow(row)),
      totals: prepared.totals || undefined,
      destinationAttributionCoverage: prepared.destinationAttributionCoverage || undefined,
    });
    return {
      ...shell,
      generatedAt: prepared.generatedAt || shell.generatedAt,
      totals: prepared.totals || shell.totals,
      destinationAttributionCoverage: prepared.destinationAttributionCoverage || shell.destinationAttributionCoverage,
      dashboardAnalytics: mergeDashboardAnalyticsWithEvidence(prepared.dashboardAnalytics || {}, filters),
    };
  }
  if (USE_PREPARED_WINDOWS && period !== "today") {
    return { ...buildShellModel(filters), dashboardAnalytics: mergeDashboardAnalyticsWithEvidence({}, filters) };
  }
  const allFilters = { ...filters, trafficClass: "all" };
  const flows = listFlowSessions({ page: 1, pageSize: 100, filters: allFilters, diagnostics: true }).rows;
  const devices = listClientInventory({ page: 1, pageSize: 100, filters }).rows;
  const dashboardAnalytics = buildDashboardAnalyticsFromRows(dashboardAnalyticsRows(filters), {
    period: filters.period || "today",
    vpsQuotaBytes: process.env.GHOSTROUTE_CONSOLE_VPS_QUOTA_BYTES,
    vpsQuotaGb: process.env.GHOSTROUTE_CONSOLE_VPS_QUOTA_GB,
    lteQuotaBytes: process.env.GHOSTROUTE_CONSOLE_LTE_QUOTA_BYTES,
    lteQuotaGb: process.env.GHOSTROUTE_CONSOLE_LTE_QUOTA_GB,
    resetDay: process.env.GHOSTROUTE_CONSOLE_BILLING_RESET_DAY,
  });
  return { ...buildShellModel(filters, { devices, flows }), dashboardAnalytics: mergeDashboardAnalyticsWithEvidence(dashboardAnalytics, filters) };
}

export function buildLiveModel(filters: ConsoleFilters = {}, flows: Array<Record<string, any>> = []): ConsoleModel {
  const flowKey = flows.map((row) => row.id || row.destination || row.client).slice(0, 200).join("|");
  return cacheGet(`build-live-model:${latestSnapshotVersion()}:${filtersKey(filters)}:${flows.length}:${flowKey}`, () => buildLiveModelUncached(filters, flows));
}

function buildLiveModelUncached(filters: ConsoleFilters = {}, flows: Array<Record<string, any>> = []): ConsoleModel {
  const dnsQueries = listDnsQueryLog({ page: 1, pageSize: 12, filters: { ...filters, trafficClass: "all" } }).rows;
  const devices = listClientInventory({ page: 1, pageSize: 10, filters }).rows;
  return buildShellModel(filters, { flows, devices, dnsQueries });
}

export function buildClientsModel(filters: ConsoleFilters = {}, devices: Array<Record<string, any>> = [], flows: Array<Record<string, any>> = []): ConsoleModel {
  const deviceKey = devices.map((row) => row.id || row.label || row.client).slice(0, 200).join("|");
  const flowKey = flows.map((row) => row.id || row.destination || row.client).slice(0, 200).join("|");
  return cacheGet(`build-clients-model:${latestSnapshotVersion()}:${filtersKey(filters)}:${devices.length}:${deviceKey}:${flows.length}:${flowKey}`, () => buildClientsModelUncached(filters, devices, flows));
}

function buildClientsModelUncached(filters: ConsoleFilters = {}, devices: Array<Record<string, any>> = [], flows: Array<Record<string, any>> = []): ConsoleModel {
  const dnsQueries = listDnsQueryLog({ page: 1, pageSize: 80, filters: { ...filters, trafficClass: "all" } }).rows;
  return buildShellModel(filters, { devices, flows, dnsQueries });
}

export function buildHealthModel(filters: ConsoleFilters = {}) {
  return cacheGet(`build-health-model:${latestSnapshotVersion()}:${filtersKey(filters)}`, () => buildLightweightShellModel(filters));
}

export function buildCatalogModel(filters: ConsoleFilters = {}) {
  return cacheGet(`build-catalog-model:${latestSnapshotVersion()}:${filtersKey(filters)}`, () => buildCatalogModelUncached(filters));
}

function buildCatalogModelUncached(filters: ConsoleFilters = {}) {
  const domains = cachedLatestByType().domains?.payload || {};
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
  return buildShellModel(filters, {
    catalog,
    catalogReviews: catalogReviews() as Array<Record<string, any>>,
  });
}

function intelligenceSearchMatches(row: Record<string, any>, search = "") {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.destination_key,
    row.value,
    row.normalized_value,
    row.category,
    row.provider,
    row.traffic_class,
    row.traffic_role,
    row.traffic_purpose,
    row.decision_hint,
    row.reason_code,
    row.human_explanation,
  ].filter(Boolean).join(" ").toLowerCase().includes(needle);
}

function readTrafficIntelligence(filters: ConsoleFilters = {}) {
  const trafficClass = filters.trafficClass || "all";
  const search = filters.search || "";
  try {
    const db = getDb();
    const rows = db.prepare(`
      select destination_key, kind, value, normalized_value, category, provider, action_hint,
             traffic_class, traffic_lane, dns_category, traffic_role, traffic_purpose, decision_hint, human_explanation,
             source, confidence, reason_code, sources_json, evidence_sources_json, evidence_json,
             first_seen, last_seen, expires_at
        from destination_enrichment
       order by last_seen desc
       limit 500
    `).all() as Array<Record<string, any>>;
    const enrichments: Array<Record<string, any>> = rows
      .filter((row) => trafficClass === "all" || row.traffic_class === trafficClass)
      .filter((row) => intelligenceSearchMatches(row, search))
      .slice(0, 250)
      .map((row) => ({
        ...row,
        evidence_sources: safeJson(row.evidence_sources_json, []),
        sources: safeJson(row.sources_json, []),
        evidence: safeJson(row.evidence_json, {}),
      }));
    const candidates = db.prepare(`
      select candidate_id, snapshot_id, destination_key, client_key, client_ip, proposed_action,
             confidence, reason_code, explanation, status, applied, created_at_utc, updated_at_utc,
             evidence_json
        from decision_candidates
       order by updated_at_utc desc
       limit 200
    `).all() as Array<Record<string, any>>;
    const filteredCandidates: Array<Record<string, any>> = candidates
      .filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase()))
      .map((row) => ({ ...row, evidence: safeJson(row.evidence_json, {}) }));
    const summary = {
      total: enrichments.length,
      pendingCandidates: filteredCandidates.filter((row) => row.status === "pending" && !Number(row.applied || 0)).length,
      byClass: enrichments.reduce<Record<string, number>>((acc, row) => {
        const key = row.traffic_class || "unclassified";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      byRole: enrichments.reduce<Record<string, number>>((acc, row) => {
        const key = row.traffic_role || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      byLane: enrichments.reduce<Record<string, number>>((acc, row) => {
        const key = row.traffic_lane || "unknown_review";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      byDnsCategory: enrichments.reduce<Record<string, number>>((acc, row) => {
        const key = row.dns_category || "unknown_domain";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      byAction: enrichments.reduce<Record<string, number>>((acc, row) => {
        const key = row.decision_hint || row.action_hint || "monitor";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    };
    return { enrichments, candidates: filteredCandidates.slice(0, 80), summary };
  } catch {
    return {
      enrichments: [],
      candidates: [],
      summary: { total: 0, pendingCandidates: 0, byClass: {}, byLane: {}, byDnsCategory: {}, byRole: {}, byAction: {} },
    };
  }
}

export function buildIntelligenceModel(filters: ConsoleFilters = {}): ConsoleModel {
  return cacheGet(`build-intelligence-model:${dbContentVersion()}:${filtersKey(filters)}`, () => {
    const trafficIntelligence = readTrafficIntelligence(filters);
    return buildShellModel(filters, { trafficIntelligence });
  });
}

export function buildSettingsModel(filters: ConsoleFilters = {}) {
  return cacheGet(`build-settings-model:${latestSnapshotVersion()}:${routingPolicySnapshotVersion()}:${filtersKey(filters)}`, () => buildSettingsModelUncached(filters));
}

function buildSettingsModelUncached(filters: ConsoleFilters = {}) {
  const devices = listClientInventory({ page: 1, pageSize: 200, filters }).rows;
  const shell = buildShellModel(filters, {
    devices,
    notificationSettings: notificationSettings() as Record<string, any>,
    auditLog: auditLog() as Array<Record<string, any>>,
    opsRuns: opsRuns() as Array<Record<string, any>>,
  });
  const routingPolicy = readRoutingPolicySnapshot();
  const model = { ...shell, routingPolicy };
  return { ...model, settingsInventory: buildSettingsInventory(model) };
}

function configured(value?: string) {
  return value ? "configured" : "missing";
}

function enabled(value?: string) {
  const normalized = String(value || "").toLowerCase();
  if (["1", "true", "yes", "enabled", "on"].includes(normalized)) return "enabled";
  if (["0", "false", "no", "disabled", "off"].includes(normalized)) return "disabled";
  return value ? "configured" : "external";
}

function envNumber(name: string, fallback: string | number) {
  return String(process.env[name] || fallback);
}

function tableCount(table: string) {
  if (!/^[a-z_]+$/.test(table)) return 0;
  try {
    return Number((getDb().prepare(`select count(*) as count from ${table}`).get() as any)?.count || 0);
  } catch {
    return 0;
  }
}

function latestRetentionRun() {
  try {
    return getDb()
      .prepare("select ran_at, raw_deleted, snapshot_rows_deleted, backups_deleted, backup_path from retention_runs order by ran_at desc limit 1")
      .get() as Record<string, any> | undefined;
  } catch {
    return null;
  }
}

function readModelStates() {
  try {
    return getDb()
      .prepare("select model, source_version, rebuilt_at, row_count, duration_ms, status, detail from read_model_state order by model")
      .all() as Array<Record<string, any>>;
  } catch {
    return [];
  }
}

function lockStatus(name: string) {
  const file = pathJoin(dataDir(), name);
  if (!fs.existsSync(file)) return "clear";
  try {
    const ageSeconds = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000);
    return `present (${ageSeconds}s old)`;
  } catch {
    return "present";
  }
}

function pathJoin(...parts: string[]) {
  return parts.join("/").replace(/\/+/g, "/");
}

function routingPolicySnapshotPath() {
  return process.env.GHOSTROUTE_CONSOLE_POLICY_SNAPSHOT_PATH || pathJoin(dataDir(), "policy-snapshot.local.json");
}

function routingPolicySnapshotVersion() {
  const file = routingPolicySnapshotPath();
  try {
    const stat = fs.statSync(file);
    return `${labelPath(file)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${labelPath(file)}:missing`;
  }
}

function readRoutingPolicySnapshot() {
  const file = routingPolicySnapshotPath();
  try {
    const stat = fs.statSync(file);
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeRoutingPolicySnapshot(payload, {
      source_path: labelPath(file),
      file_mtime: stat.mtime.toISOString(),
    });
  } catch (error: any) {
    const missing = error?.code === "ENOENT";
    return normalizeRoutingPolicySnapshot(null, {
      source_path: labelPath(file),
      warnings: missing ? [] : [`policy snapshot ignored: ${error?.message || "invalid json"}`],
    });
  }
}

function buildSettingsInventory(model: ConsoleModel) {
  const readModels = readModelStates();
  const registryRows = model.devices || [];
  const unattributed = registryRows.filter((row) => row.role === "Unattributed mobile ingress source" || row.attribution_confidence === "unattributed").length;
  const routerProfile = process.env.GHOSTROUTE_READONLY_SSH_HOST && process.env.GHOSTROUTE_READONLY_SSH_KEY_PATH ? "configured" : "missing";
  const alarmMode = process.env.GHOSTROUTE_ALARM_STATE_MODE || "disabled";
  const routingPolicy = model.routingPolicy || readRoutingPolicySnapshot();
  return {
    routingPolicy,
    routingPolicyOverview: [
      ["Snapshot", routingPolicy.status || "missing"],
      ["Home full-VPS clients", String(routingPolicy.summary?.home_full_vps || 0)],
      ["Channel A profiles", `${routingPolicy.summary?.channel_a_profiles || 0} profiles / ${routingPolicy.summary?.channel_a_full_vps || 0} full-VPS`],
      ["Channel B profiles", `${routingPolicy.summary?.channel_b_profiles || 0} managed split`],
      ["Channel C profiles", `${routingPolicy.summary?.channel_c_profiles || 0} compatibility`],
      ["Source", routingPolicy.source?.path || "policy-snapshot.local.json"],
    ],
    runtime: [
      ["Source", model.runtime.sourceLabel],
      ["Build commit", model.runtime.buildCommit],
      ["Node env", model.runtime.nodeEnv],
      ["Data dir", model.runtime.dataDirLabel],
      ["Repo root", model.runtime.repoRootLabel],
      ["Freshness", model.freshnessStatus],
    ],
    collectors: [
      ["Full collector", process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled"],
      ["Light collector", process.env.GHOSTROUTE_LIGHT_COLLECTOR_MODE || process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled"],
      ["Live collector", process.env.GHOSTROUTE_LIVE_COLLECTOR_MODE || process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled"],
      ["Day interval", `${envNumber("GHOSTROUTE_COLLECT_DAY_INTERVAL_SECONDS", 1800)}s`],
      ["Night interval", `${envNumber("GHOSTROUTE_COLLECT_NIGHT_INTERVAL_SECONDS", 10800)}s`],
      ["Light interval", `${envNumber("GHOSTROUTE_LIGHT_COLLECT_INTERVAL_SECONDS", 300)}s`],
      ["Live poll", `${envNumber("GHOSTROUTE_LIVE_POLL_SECONDS", 600)}s`],
      ["Writer lock wait", `${envNumber("GHOSTROUTE_COLLECTOR_WRITER_LOCK_WAIT_SECONDS", 120)}s`],
    ],
    retention: [
      ["Raw snapshots", `${envNumber("GHOSTROUTE_RAW_RETENTION_DAYS", 7)}d`],
      ["Live raw snapshots", `${envNumber("GHOSTROUTE_LIVE_RAW_RETENTION_HOURS", 6)}h`],
      ["Hourly aggregates", `${envNumber("GHOSTROUTE_HOURLY_RETENTION_DAYS", 30)}d`],
      ["DB backups", `${envNumber("GHOSTROUTE_BACKUP_RETENTION_DAYS", 2)}d / max ${envNumber("GHOSTROUTE_DB_BACKUP_MAX_FILES", 2)}`],
      ["Derived cache TTL", `${envNumber("GHOSTROUTE_CONSOLE_DERIVED_CACHE_TTL_MS", 300000)}ms`],
      ["Latest retention run", latestRetentionRun()?.ran_at || "n/a"],
    ],
    access: [
      ["Console auth", enabled(process.env.GHOSTROUTE_CONSOLE_AUTH || process.env.GHOSTROUTE_CONSOLE_BASIC_AUTH)],
      ["Public listener", process.env.GHOSTROUTE_CONSOLE_PUBLIC_MODE || "caddy dedicated listener"],
      ["Router remote profile", routerProfile],
      ["Router write scope", alarmMode === "ssh" ? "alarm-state only" : alarmMode],
      ["Router host", routerProfile === "configured" ? "redacted" : "missing"],
      ["Router key", configured(process.env.GHOSTROUTE_READONLY_SSH_KEY_PATH)],
    ],
    dataSources: [
      ["Snapshots", String(Object.values(model.snapshots).filter(Boolean).length)],
      ["Latest traffic", model.runtime.latestSnapshots.traffic || "missing"],
      ["Latest traffic summary", model.runtime.latestSnapshots.traffic_summary || "missing"],
      ["Latest DNS", model.runtime.latestSnapshots.dns || "missing"],
      ["Latest health", model.runtime.latestSnapshots.health || "missing"],
      ["Collector run", model.collectorRun ? `${model.collectorRun.ok_count}/${Number(model.collectorRun.ok_count || 0) + Number(model.collectorRun.error_count || 0)}` : "n/a"],
      ["Collector errors", String(model.collectorErrors.length)],
    ],
    readModels: [
      ["flow_sessions", String(tableCount("flow_sessions"))],
      ["dns_query_log", String(tableCount("dns_query_log"))],
      ["device_inventory", String(tableCount("device_inventory"))],
      ["alarm_events", String(tableCount("alarm_events"))],
      ["events", String(tableCount("events"))],
      ["route_decisions", String(tableCount("route_decisions"))],
    ],
    locks: [
      ["Full collector", lockStatus("collector.lock")],
      ["Light collector", lockStatus("light-collector.lock")],
      ["Live collector", lockStatus("live-collector.lock")],
      ["SQLite writer", lockStatus("collector-writer.lock")],
    ],
    safety: [
      ["Catalog apply", "prepare patch only"],
      ["Router mutation", alarmMode === "ssh" ? "alarm-state JSON only" : "disabled"],
      ["Production deploy", "not exposed in Console UI"],
      ["Secrets display", "redacted/configured flags only"],
    ],
    notifications: [
      ["Telegram delivery", "planned"],
      ["Email delivery", "planned"],
      ["Stored settings", String(Object.keys(model.notificationSettings || {}).length)],
      ["Delivery secrets", "not stored in SQLite"],
    ],
    registry: [
      ["Inventory rows", String(registryRows.length)],
      ["Unattributed rows", String(unattributed)],
      ["Audit entries", String(model.auditLog.length)],
      ["Ops runs", String(model.opsRuns.length)],
    ],
    readModelState: readModels,
  };
}

export function buildBudgetModel(filters: ConsoleFilters = {}): ConsoleModel {
  return cacheGet(`build-budget-model:${latestSnapshotVersion()}:${filtersKey(filters)}`, () => buildBudgetModelUncached(filters));
}

function buildBudgetModelUncached(filters: ConsoleFilters = {}): ConsoleModel {
  const snapshots = cachedLatestByType();
  const period = filters.period || "today";
  const trafficSummarySnapshot = latestWindowSnapshot(snapshots, "traffic_summary", period);
  const trafficSnapshot = latestWindowSnapshot(snapshots, "traffic", period);
  const dashboardTraffic = trafficSummarySnapshot?.payload?.totals ? trafficSummarySnapshot.payload : trafficSnapshot?.payload || {};
  const health = snapshots.health?.payload || {};
  const leaks = snapshots.leaks?.payload || {};
  const newest = Object.values(snapshots)
    .filter(Boolean)
    .map((row) => row?.collectedAt)
    .sort()
    .pop();
  const staleMinutes = minutesSince(newest);
  const staleThreshold = staleThresholdMinutes();
  const totals = dashboardTraffic.totals || {};
  const currentRows = mergeKnownDevices(deviceDeltaRowsForPeriod(period), false).slice(0, 50);
  const collectorDisabled = (process.env.GHOSTROUTE_COLLECTOR_MODE || "disabled") === "disabled";
  const collectorErrors = collectorDisabled ? [] : (latestCollectorErrors(3) as Array<Record<string, any>>);
  const leakAlerts = (leaks.leaks || []).map((row: any) => ({
    severity: row.severity || "warning",
    title: row.label || row.probe,
    source: "leak-check",
    status: row.status,
    evidence: row.evidence,
    confidence: row.confidence || "exact",
  }));
  const statusCards = [
    { label: "Router", status: normalizeStatus(health.services?.router || health.overall), detail: formatDetail(health.router?.product) },
    { label: "Reality", status: normalizeStatus(health.services?.reality), detail: "home ingress / reality-out" },
    { label: "DNS", status: normalizeStatus(health.services?.dns), detail: "dnscrypt + policy" },
    { label: "IPv6", status: normalizeStatus(health.services?.ipv6), detail: "not in routing scope" },
    { label: "Rule-set", status: normalizeStatus(health.services?.rule_set_sync), detail: "catalog mirror" },
    { label: "Leaks", status: normalizeStatus(leaks.overall), detail: `${leakAlerts.length} signals` },
  ];
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
  return {
    generatedAt: new Date().toISOString(),
    freshnessMinutes: staleMinutes,
    freshnessStatus: staleMinutes === null ? "empty" : staleMinutes > staleThreshold || collectorErrors.length > 0 ? "stale" : "fresh",
    freshnessLabel: newest || "",
    nextExpectedCollection: nextExpectedCollection(newest),
    staleThresholdMinutes: staleThreshold,
    runtime: runtimeInfo(snapshots),
    collectorErrors,
    collectorRun: collectorDisabled ? null : (latestCollectorRun() as Record<string, any> | null),
    hourlyTraffic: hourlyTraffic(96) as Array<Record<string, any>>,
    events: [],
    routeDecisions: [],
    catalogReviews: [],
    notifications: [],
    notificationSettings: {},
    auditLog: [],
    opsRuns: [],
    snapshots,
    statusCards,
    totals: {
      observedBytes: Number(totals.client_observed_bytes || 0),
      viaVpsBytes: Number(totals.via_vps_bytes || 0),
      directBytes: Number(totals.direct_bytes || 0),
      unknownBytes: Number(totals.unknown_bytes || 0),
      periodLabel: trafficPeriodLabel(dashboardTraffic),
      windowLabel: trafficWindowLabel(dashboardTraffic),
    },
    devices: filterRows(reconcileTrafficRows(currentRows, authoritativeTotalsForPeriod(period, filters.trafficClass || "all")), filters),
    flows: [],
    dnsQueries: [],
    alerts: dedupeAlerts([...staleAlert, ...leakAlerts, ...collectorErrors.map((row) => ({
      severity: "warning",
      title: row.type || "collector warning",
      source: "collector",
      status: "WARN",
      evidence: row.message || "",
      confidence: "exact",
    }))]),
    catalog: [],
  };
}

export function buildPagedEvidenceContext(filters: ConsoleFilters, flows: Array<Record<string, any>>) {
  return buildChromeModel(filters, { flows });
}

function clientSearch(row: Record<string, any>, search?: string) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [row.label, row.client_label, row.id, row.client_key, row.ip, row.channel, row.route, ...(row.aliases || [])].filter(Boolean).join(" ").toLowerCase().includes(needle);
}

function registeredInventoryRows() {
  const registry = loadDeviceAttributions();
  const clients = registry.clients as Record<string, Record<string, any>>;
  return Object.entries(clients).map(([key, entry]) => ({
    id: entry.device_key || entry.client_key || key,
    label: entry.label || entry.device_label || key,
    client: entry.label || key,
    client_key: entry.client_key || key,
    client_label: entry.label || key,
    device_key: entry.device_key || entry.client_key || key,
    device_label: entry.device_label || entry.label || key,
    owner: entry.owner || "",
    role: entry.role || "",
    device_type: entry.device_type || entry.profile_type || "",
    channel: entry.primary_channel || entry.channel || "Unknown",
    channels: [entry.primary_channel || entry.channel || "Unknown"].filter((value) => value && value !== "Unknown"),
    confidence: entry.confidence || "operator-local",
    total_bytes: 0,
    bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    route: "Unknown",
    trafficClass: "client",
    traffic_class: "client",
    last_seen: "",
    status: "Inactive",
    client_attributed: true,
    registry_registered: true,
    traffic_window_active: false,
    aliases: Array.from(new Set([...(entry.aliases || []), ...(entry.ip_aliases || []), ...(entry.mac_aliases || [])].filter(Boolean).map(String))).slice(0, 16),
  }));
}

function inactiveHistoryRows() {
  return mergeKnownDevices(knownDeviceRows(2000), false).map((row) => ({
    ...row,
    total_bytes: 0,
    bytes: 0,
    via_vps_bytes: 0,
    direct_bytes: 0,
    unknown_bytes: 0,
    traffic_window_active: false,
    traffic_collected_at: "",
    status: statusFromLastSeen(row.last_seen || row.collected_at),
  }));
}

function needsAttributionClientRow(row: Record<string, any>) {
  const total = observedByteValue(row);
  if (total <= 0) return null;
  const clientKey = String(row.client_key || row.client || row.client_label || row.ip || row.client_ip || row.device_key || "").trim();
  if (!clientKey) return null;
  const viaVpsBytes = Number(row.via_vps_bytes || row.vps_bytes || row.reality_bytes || 0);
  const directBytes = Number(row.direct_bytes || row.wan_bytes || 0);
  const unknownBytes = Number(row.unknown_bytes || Math.max(0, total - viaVpsBytes - directBytes));
  const rawLabel = String(row.client_label || row.client || row.label || clientKey);
  const rawLooksLikeIp = isIpv4Literal(rawLabel) || isIpv4Literal(clientKey) || isIpv4Literal(row.ip) || isIpv4Literal(row.client_ip);
  const label = rawLooksLikeIp ? "Unknown LAN device" : rawLabel;
  return {
    ...row,
    id: clientKey,
    label,
    client: label,
    client_key: clientKey,
    client_label: label,
    device_key: row.device_key || clientKey,
    device_label: rawLooksLikeIp ? "Unknown LAN device" : (row.device_label || label),
    role: "Needs attribution",
    owner: "",
    device_type: "Needs attribution",
    channel: row.channel || "Unknown",
    confidence: row.confidence || "estimated",
    total_bytes: total,
    bytes: total,
    via_vps_bytes: viaVpsBytes,
    direct_bytes: directBytes,
    unknown_bytes: unknownBytes,
    route: row.route && row.route !== "Unknown" ? row.route : routeFromCounters({ via_vps_bytes: viaVpsBytes, direct_bytes: directBytes }),
    trafficClass: row.trafficClass || row.traffic_class || "client",
    traffic_class: row.traffic_class || row.trafficClass || "client",
    last_seen: row.last_seen || row.last_seen_utc || row.collected_at || row.traffic_collected_at || "",
    status: statusFromLastSeen(row.last_seen || row.last_seen_utc || row.collected_at || row.traffic_collected_at),
    traffic_window_active: true,
    traffic_collected_at: row.last_seen || row.last_seen_utc || row.collected_at || row.traffic_collected_at || "",
    client_attributed: false,
    attribution_state: "needs_attribution",
    observed_aliases: Array.from(new Set([row.client_key, row.client_label, row.client, row.label, row.ip, row.client_ip].filter(Boolean).map(String))).slice(0, 16),
  };
}

function withDeviceReviewState(row: Record<string, any>): Record<string, any> {
  return { ...row, ...deviceReviewState(row) };
}

function inventoryRowFromTraffic(row: Record<string, any>): Record<string, any> | null {
  const resolved = operatorClientRow(row) || needsAttributionClientRow(row);
  return resolved ? withDeviceReviewState(resolved) : null;
}

function aggregateClientRowsForPeriod(period = "today") {
  const db = getDb();
  const byKey = new Map<string, Record<string, any>>();
  const remember = (row: Record<string, any>) => {
    const key = String(row.client_key || row.client_label || row.client || "").trim();
    if (!key) return;
    const current = byKey.get(key) || {
      client_key: key,
      client_label: row.client_label || key,
      client: row.client_label || key,
      label: row.client_label || key,
      channel: row.channel || "Unknown",
      confidence: row.confidence || "estimated",
      traffic_class: row.traffic_class || "client",
      total_bytes: 0,
      bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 0,
      destinations_count: 0,
      last_seen: row.last_seen_utc || row.collected_at || "",
    };
    current.total_bytes += Number(row.bytes || row.total_bytes || 0);
    current.bytes = current.total_bytes;
    current.via_vps_bytes += Number(row.via_vps_bytes || 0);
    current.direct_bytes += Number(row.direct_bytes || 0);
    current.unknown_bytes += Number(row.unknown_bytes || 0);
    current.flows += Number(row.flows || 0);
    current.destinations_count += Number(row.destinations_count || 0);
    if (String(row.last_seen_utc || row.collected_at || "") > String(current.last_seen || "")) current.last_seen = row.last_seen_utc || row.collected_at || "";
    if (row.channel && row.channel !== "Unknown") current.channel = row.channel;
    current.route = routeFromCounters(current);
    byKey.set(key, current);
  };
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const laneRows = db.prepare(`
      select client_key,
             max(client_label) as client_label,
             max(channel) as channel,
             max(confidence) as confidence,
             max(traffic_class) as traffic_class,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             sum(destinations_count) as destinations_count,
             max(last_seen_utc) as last_seen_utc
        from client_traffic_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and traffic_lane = 'all'
       group by client_key
    `).all(granularity, segment.start, segment.end) as Array<Record<string, any>>;
    for (const row of laneRows) remember(row);
  }
  const existing = new Set(byKey.keys());
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const destinationRows = db.prepare(`
      select client_key,
             max(client_label) as client_label,
             max(channel) as channel,
             max(confidence) as confidence,
             max(traffic_class) as traffic_class,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             count(distinct destination_key) as destinations_count,
             max(last_seen_utc) as last_seen_utc
        from client_destination_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
       group by client_key
    `).all(granularity, segment.start, segment.end) as Array<Record<string, any>>;
    for (const row of destinationRows) {
      if (existing.has(String(row.client_key || ""))) continue;
      remember(row);
    }
  }
  return Array.from(byKey.values()).map(inventoryRowFromTraffic).filter((row): row is Record<string, any> => Boolean(row));
}

function mergeInventoryRows(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  const byKey = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const key = String(row.client_key || row.id || row.device_key || row.label || "").trim();
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...row });
      continue;
    }
    const rowBytes = observedByteValue(row);
    const currentBytes = observedByteValue(current);
    const preferIdentity = row.client_attributed !== false && (current.client_attributed === false || labelScore(row.label) >= labelScore(current.label));
    if (preferIdentity) {
      current.label = row.label || current.label;
      current.client = row.client || current.client;
      current.client_label = row.client_label || current.client_label;
      current.device_label = row.device_label || current.device_label;
      current.owner = row.owner || current.owner;
      current.role = row.role || current.role;
      current.device_type = row.device_type || current.device_type;
      current.client_attributed = true;
      current.registry_registered = row.registry_registered || current.registry_registered;
    }
    if (rowBytes > currentBytes) {
      current.total_bytes = row.total_bytes || row.bytes || 0;
      current.bytes = current.total_bytes;
      current.via_vps_bytes = row.via_vps_bytes || 0;
      current.direct_bytes = row.direct_bytes || 0;
      current.unknown_bytes = row.unknown_bytes || 0;
      current.route = row.route || current.route;
      current.confidence = row.confidence || current.confidence;
      current.traffic_window_active = rowBytes > 0;
      current.traffic_collected_at = row.traffic_collected_at || row.last_seen || row.last_seen_utc || row.collected_at || current.traffic_collected_at || "";
    }
    const lastSeen = row.last_seen || row.last_seen_utc || row.collected_at || "";
    if (String(lastSeen) > String(current.last_seen || "")) current.last_seen = lastSeen;
    current.status = current.traffic_window_active ? (current.status || "Recently seen") : statusFromLastSeen(current.last_seen);
    current.channel = channelLabel([...(current.channels || []), current.channel, ...(row.channels || []), row.channel]);
    current.channels = Array.from(new Set([...(current.channels || []), ...(row.channels || []), row.channel].filter((value) => value && value !== "Unknown")));
    current.aliases = Array.from(new Set([...(current.aliases || []), ...(row.aliases || [])].filter(Boolean).map(String))).slice(0, 16);
    current.observed_aliases = Array.from(new Set([...(current.observed_aliases || []), ...(row.observed_aliases || [])].filter(Boolean).map(String))).slice(0, 16);
    byKey.set(key, current);
  }
  return Array.from(byKey.values()).map((row: Record<string, any>) => withDeviceReviewState({
    ...row,
    status: Number(row.total_bytes || 0) > 0 ? (row.status || "Recently seen") : statusFromLastSeen(row.last_seen),
  }));
}

function clientInventoryRows(filters: ConsoleFilters = {}) {
  const period = filters.period || "today";
  const trafficClass = filters.trafficClass || "all";
  return cacheGet(`client-inventory:${latestSnapshotVersion()}:${period}:${trafficClass}`, () => {
  const prepared = getPreparedWindowSnapshot("clients", period, trafficClass)?.payload;
  const preparedRows = prepared?.rows
    ? (prepared.rows as Array<Record<string, any>>).map((row) => {
      const total = observedByteValue(row);
      const split = splitCounters(row, total);
      return operatorClientRow({
      ...row,
      bytes: total,
      total_bytes: total,
      via_vps_bytes: split.via_vps_bytes,
      direct_bytes: split.direct_bytes,
      unknown_bytes: split.unknown_bytes,
      route: routeFromCounters(split),
      traffic_window_active: total > 0,
      });
    }).filter((row): row is Record<string, any> => Boolean(row))
    : [];
  const inventory = mergeKnownDevices(knownDeviceRows(2000), false);
  const currentRows = deviceDeltaRowsForPeriod(period);
  const currentByKey = new Map<string, Record<string, any>>(mergeKnownDevices(currentRows, false).map((row) => [keyForDevice(row), row]));
  const seen = new Set<string>();
  const rows: Array<Record<string, any>> = inventory.map((row) => {
    const key = keyForDevice(row);
    seen.add(key);
    const current = currentByKey.get(key);
    return {
      ...row,
      inventory_total_bytes: row.total_bytes || 0,
      inventory_via_vps_bytes: row.via_vps_bytes || 0,
      inventory_direct_bytes: row.direct_bytes || 0,
      total_bytes: current ? Number(current.total_bytes || 0) : 0,
      via_vps_bytes: current ? Number(current.via_vps_bytes || 0) : 0,
      direct_bytes: current ? Number(current.direct_bytes || 0) : 0,
      unknown_bytes: current ? Number(current.unknown_bytes || 0) : 0,
      route: current ? deviceRoute(current) : "Unknown",
      confidence: current?.confidence || "unknown",
      traffic_window_active: Boolean(current && observedByteValue(current) > 0),
      traffic_collected_at: current?.last_seen || current?.collected_at || "",
    };
  });
  for (const [key, row] of currentByKey) {
    if (seen.has(key)) continue;
    rows.push({
      ...row,
      traffic_window_active: observedByteValue(row) > 0,
      traffic_collected_at: row.last_seen || row.collected_at || "",
    });
  }
    const currentDeviceRows = (rows as Array<Record<string, any>>)
    .map(inventoryRowFromTraffic)
    .filter((row): row is Record<string, any> => Boolean(row));
    return (mergeInventoryRows([
      ...registeredInventoryRows(),
      ...inactiveHistoryRows(),
      ...preparedRows,
      ...aggregateClientRowsForPeriod(period),
      ...currentDeviceRows,
    ]) as Array<Record<string, any>>)
    .sort((a, b) => {
    const trafficDelta = Number(b.total_bytes || 0) - Number(a.total_bytes || 0);
    if (trafficDelta !== 0) return trafficDelta;
    const aSeen = Date.parse(a.last_seen || "");
    const bSeen = Date.parse(b.last_seen || "");
    if (Number.isFinite(aSeen) && Number.isFinite(bSeen) && aSeen !== bSeen) return bSeen - aSeen;
    return String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""));
  });
  });
}

export function listClientInventory(args: PageArgs = {}) {
  return cacheGet(`list-client-inventory:${latestSnapshotVersion()}:${pageArgsKey(args)}`, () => listClientInventoryUncached(args));
}

function listClientInventoryUncached(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, 100);
  const showInactive = Boolean(args.showInactive);
  const allRows = clientInventoryRows(args.filters || {})
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
      if (args.filters?.client && args.filters.client !== "all" && filterRows([row], args.filters).length === 0) return false;
      return clientSearch(row, args.filters?.search);
    });
  const hiddenInactive = allRows.filter((row) => Number(row.total_bytes || 0) <= 0 && row.registry_registered).length;
  const rows = allRows.filter((row) => Number(row.total_bytes || 0) > 0 || (showInactive && row.registry_registered));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    total: rows.length,
    hiddenInactive,
    page: effectivePage,
    pageSize,
    totalPages,
  };
}

function moscowHourKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 13);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:00:00+03:00`;
}

function rowIdentityTokens(row: Record<string, any>) {
  const raw = rawJson(row);
  const evidence = evidenceJson(row);
  const resolved = resolveClient({ ...row, raw, profile: row.profile || raw.profile });
  const aliases = [
    ...safeJson(row.aliases_json, []),
    ...safeJson(raw.aliases_json, []),
    ...safeJson(evidence.aliases_json, []),
    ...safeJson(evidence.aliases, []),
  ];
  return [
    resolved.client_key,
    resolved.client_label,
    resolved.device_key,
    resolved.device_label,
    row.client_key,
    row.client_label,
    row.client_ip,
    row.ip,
    row.hostname,
    row.mac,
    keyForDevice({ ...row, raw }),
    row.device_id,
    row.device_key,
    row.device_label,
    row.id,
    row.label,
    row.client,
    row.profile,
    raw.id,
    raw.client_key,
    raw.client_label,
    raw.client_ip,
    raw.device_key,
    raw.device_label,
    raw.ip,
    raw.hostname,
    raw.mac,
    raw.profile,
    raw.label,
    raw.client,
    evidence.id,
    evidence.client_key,
    evidence.client_label,
    evidence.client_ip,
    evidence.device_key,
    evidence.device_label,
    evidence.ip,
    evidence.hostname,
    evidence.mac,
    evidence.profile,
    evidence.label,
    evidence.client,
    ...(resolved.observed_aliases || []),
    ...(row.aliases || []),
    ...(row.observed_aliases || []),
    ...aliases,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
}

function uniqueNonEmpty(values: Array<unknown>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    for (const candidate of [text, text.toLowerCase()]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function registryAliasCandidates(target: Record<string, any>) {
  const raw = rawJson(target);
  const registry = loadDeviceAttributions();
  const resolved = resolveClient({ ...target, raw, profile: target.profile || raw.profile }, registry);
  const entry = resolved.client_key ? (registry.clients as Record<string, Record<string, any>>)[resolved.client_key] : null;
  const networkAliases = Object.entries(registry.networkAliases || {})
    .filter(([, key]) => key === resolved.client_key)
    .map(([alias]) => alias);
  return uniqueNonEmpty([
    resolved.client_key,
    resolved.client_label,
    resolved.device_key,
    resolved.device_label,
    ...(resolved.observed_aliases || []),
    entry?.client_key,
    entry?.label,
    entry?.device_key,
    entry?.device_label,
    entry?.display_name,
    entry?.owner,
    ...(entry?.aliases || []),
    ...(entry?.ip_aliases || []),
    ...(entry?.mac_aliases || []),
    ...networkAliases,
  ]);
}

function inventoryAliasCandidates(target: Record<string, any>) {
  const raw = rawJson(target);
  const seed = uniqueNonEmpty([
    target.client_key,
    target.device_key,
    target.id,
    target.label,
    target.client_label,
    target.device_label,
    target.client,
    target.ip,
    target.client_ip,
    raw.client_key,
    raw.device_key,
    raw.id,
    raw.label,
    raw.client,
    raw.ip,
    raw.client_ip,
  ]);
  if (seed.length === 0 || !readModelHasRows("device_inventory")) return [];
  const db = getDb();
  const rows: Array<Record<string, any>> = [];
  const exact = db.prepare(`
    select device_key, label, ip, hostname, profile, aliases_json, evidence_json
      from device_inventory
     where lower(device_key) = lower(?)
        or lower(label) = lower(?)
        or lower(ip) = lower(?)
        or lower(hostname) = lower(?)
     limit 5
  `);
  const aliasLike = db.prepare(`
    select device_key, label, ip, hostname, profile, aliases_json, evidence_json
      from device_inventory
     where aliases_json like ?
     limit 5
  `);
  for (const value of seed) {
    rows.push(...exact.all(value, value, value, value) as Array<Record<string, any>>);
    rows.push(...aliasLike.all(`%"${String(value).replace(/"/g, "")}"%`) as Array<Record<string, any>>);
  }
  return uniqueNonEmpty(rows.flatMap((row) => {
    const evidence = safeJson(row.evidence_json, {});
    return [
      row.device_key,
      row.label,
      row.ip,
      row.hostname,
      row.profile,
      evidence.client_key,
      evidence.client_label,
      evidence.client_ip,
      evidence.device_key,
      evidence.device_label,
      evidence.ip,
      evidence.label,
      evidence.client,
      ...safeJson(row.aliases_json, []),
      ...safeJson(evidence.aliases, []),
    ];
  }));
}

function laneClientKeyCandidates(target: Record<string, any>) {
  const raw = rawJson(target);
  const resolved = resolveClient({ ...target, raw, profile: target.profile || raw.profile });
  const base = uniqueNonEmpty([
    resolved.client_key,
    resolved.device_key,
    resolved.client_label,
    resolved.device_label,
    target.client_key,
    target.device_key,
    target.device_id,
    target.id,
    target.label,
    target.client_label,
    target.device_label,
    target.client,
    target.profile,
    raw.profile,
    raw.label,
    raw.client,
    keyForDevice({ ...target, raw }),
    ...(resolved.observed_aliases || []),
    ...(target.aliases || []),
    ...(target.observed_aliases || []),
    ...inventoryAliasCandidates(target),
    ...registryAliasCandidates(target),
    ...rowIdentityTokens(target),
  ]);
  const expanded = [...base];
  for (const value of base) {
    if (/^(lan-host|mobile-client|mobile-source)-\d+$/i.test(value)) continue;
    const stripped = value.replace(/-\d+$/, "");
    if (stripped && stripped !== value) expanded.push(stripped);
  }
  return uniqueNonEmpty(expanded);
}

function resolveLaneClientKey(target: Record<string, any>, table: "client_traffic_by_lane" | "client_destination_by_lane" | "client_route_evidence_defects") {
  const candidates = laneClientKeyCandidates(target);
  if (candidates.length === 0) return "";
  const db = getDb();
  const byKey = db.prepare(`select client_key from ${table} where client_key = ? limit 1`);
  for (const candidate of candidates) {
    const row = byKey.get(candidate) as { client_key?: string } | undefined;
    if (row?.client_key) return row.client_key;
  }
  const byLabel = db.prepare(`select client_key from ${table} where lower(client_label) = lower(?) order by bytes desc limit 1`);
  for (const candidate of candidates) {
    const row = byLabel.get(candidate) as { client_key?: string } | undefined;
    if (row?.client_key) return row.client_key;
  }
  return candidates[0];
}

function clientDomainAggregateRows(clientKey: string, period = "today") {
  if (!clientKey) return [];
  const db = getDb();
  const grouped = new Map<string, Record<string, any>>();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const table = segment.layer === "weekly" ? "client_destination_traffic_weekly" : segment.layer === "daily" ? "client_destination_traffic_daily" : segment.layer === "hourly" ? "client_destination_traffic_hourly" : "client_destination_traffic_5min";
    const timeColumn = segment.layer === "weekly" ? "week_start_utc" : segment.layer === "daily" ? "day_start_utc" : segment.layer === "hourly" ? "hour_start_utc" : "bucket_start_utc";
    const rows = db.prepare(`
      select max(client_label) as client_label,
             destination_key,
             route,
             traffic_class,
             confidence,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             max(${timeColumn}) as collected_at
        from ${table}
       where ${timeColumn} >= ?
         and ${timeColumn} < ?
         and client_key = ?
         and coalesce(destination_key, '') not in ('', 'unknown destination', 'Unknown/Unattributed LAN-Wi-Fi')
         and coalesce(attributed_bytes, bytes, 0) > 0
       group by destination_key, route, traffic_class, confidence
    `).all(segment.start, segment.end, clientKey) as Array<Record<string, any>>;
    for (const row of rows) {
      const key = [row.destination_key, row.route, row.traffic_class, row.confidence].join("|");
      const current = grouped.get(key) || {
        client: row.client_label || clientKey,
        client_key: clientKey,
        client_label: row.client_label || clientKey,
        destination: row.destination_key,
        destinationLabel: row.destination_key,
        route: row.route || "Unknown",
        trafficClass: row.traffic_class || trafficClassFor(row),
        traffic_class: row.traffic_class || trafficClassFor(row),
        confidence: row.confidence || "estimated",
        bytes: 0,
        total_bytes: 0,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        collected_at: row.collected_at,
      };
      current.bytes += Number(row.bytes || 0);
      current.total_bytes += Number(row.bytes || 0);
      current.via_vps_bytes += Number(row.via_vps_bytes || 0);
      current.direct_bytes += Number(row.direct_bytes || 0);
      current.unknown_bytes += Number(row.unknown_bytes || 0);
      current.flows += Number(row.flows || 0);
      if (String(row.collected_at || "") > String(current.collected_at || "")) current.collected_at = row.collected_at;
      grouped.set(key, current);
    }
  }
  return Array.from(grouped.values()).sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
}

function laneGranularity(layer: "weekly" | "daily" | "hourly" | "5min") {
  if (layer === "weekly") return "week";
  if (layer === "daily") return "day";
  if (layer === "hourly") return "hour";
  return "5min";
}

function clientLaneSummaryRows(clientKey: string, period = "today") {
  if (!clientKey) return [];
  const db = getDb();
  const grouped = new Map<string, Record<string, any>>();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const rows = db.prepare(`
      select max(client_label) as client_label,
             channel,
             route,
             confidence,
             traffic_class,
             traffic_lane,
             dns_category,
             decision_hint,
             enrichment_status,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             sum(destinations_count) as destinations_count,
             max(last_seen_utc) as last_seen_utc
        from client_traffic_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and client_key = ?
       group by channel, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint, enrichment_status
    `).all(granularity, segment.start, segment.end, clientKey) as Array<Record<string, any>>;
    for (const row of rows) {
      const key = [row.channel, row.route, row.confidence, row.traffic_class, row.traffic_lane, row.dns_category, row.decision_hint, row.enrichment_status].join("|");
      const current = grouped.get(key) || {
        client_key: clientKey,
        client_label: row.client_label || clientKey,
        channel: row.channel || "Unknown",
        route: row.route || "Unknown",
        confidence: row.confidence || "unknown",
        traffic_class: row.traffic_class || "unclassified",
        traffic_lane: row.traffic_lane || "unknown_review",
        dns_category: row.dns_category || "unknown_domain",
        decision_hint: row.decision_hint || "monitor",
        enrichment_status: row.enrichment_status || "missing",
        bytes: 0,
        total_bytes: 0,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        destinations_count: 0,
        last_seen_utc: row.last_seen_utc || "",
      };
      current.bytes += Number(row.bytes || 0);
      current.total_bytes += Number(row.bytes || 0);
      current.via_vps_bytes += Number(row.via_vps_bytes || 0);
      current.direct_bytes += Number(row.direct_bytes || 0);
      current.unknown_bytes += Number(row.unknown_bytes || 0);
      current.flows += Number(row.flows || 0);
      current.destinations_count += Number(row.destinations_count || 0);
      if (String(row.last_seen_utc || "") > String(current.last_seen_utc || "")) current.last_seen_utc = row.last_seen_utc;
      grouped.set(key, current);
    }
  }
  return Array.from(grouped.values()).sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
}

function clientDestinationLaneRows(clientKeys: string | Array<string>, period = "today", trafficLane = "all") {
  const keys = uniqueNonEmpty(Array.isArray(clientKeys) ? clientKeys : [clientKeys]);
  if (keys.length === 0) return [];
  const db = getDb();
  const grouped = new Map<string, Record<string, any>>();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const laneSql = trafficLane && trafficLane !== "all" ? "and traffic_lane = ?" : "";
    const clientMatch = clientMatchPredicate(["client_key", "client_label"], keys);
    const params = trafficLane && trafficLane !== "all"
      ? [granularity, segment.start, segment.end, ...clientMatch.params, trafficLane]
      : [granularity, segment.start, segment.end, ...clientMatch.params];
    const rows = db.prepare(`
      select max(client_label) as client_label,
             destination_key,
             max(destination_label) as destination_label,
             route,
             confidence,
             traffic_class,
             traffic_lane,
             dns_category,
             decision_hint,
             max(category) as category,
             max(provider) as provider,
             max(enrichment_status) as enrichment_status,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             max(last_seen_utc) as last_seen_utc
        from client_destination_by_lane
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         and ${clientMatch.sql}
         ${laneSql}
       group by destination_key, route, confidence, traffic_class, traffic_lane, dns_category, decision_hint
    `).all(...params) as Array<Record<string, any>>;
    for (const row of rows) {
      const key = [row.destination_key, row.route, row.confidence, row.traffic_class, row.traffic_lane, row.dns_category, row.decision_hint].join("|");
      const current = grouped.get(key) || {
        client_key: keys[0],
        client_label: row.client_label || keys[0],
        destination: row.destination_label || row.destination_key,
        destination_key: row.destination_key,
        destination_label: row.destination_label || row.destination_key,
        route: row.route || "Unknown",
        confidence: row.confidence || "unknown",
        traffic_class: row.traffic_class || "unclassified",
        traffic_lane: row.traffic_lane || "unknown_review",
        dns_category: row.dns_category || "unknown_domain",
        decision_hint: row.decision_hint || "monitor",
        category: row.category || "unknown",
        provider: row.provider || "",
        enrichment_status: row.enrichment_status || "missing",
        bytes: 0,
        total_bytes: 0,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        last_seen_utc: row.last_seen_utc || "",
      };
      current.bytes += Number(row.bytes || 0);
      current.total_bytes += Number(row.bytes || 0);
      current.via_vps_bytes += Number(row.via_vps_bytes || 0);
      current.direct_bytes += Number(row.direct_bytes || 0);
      current.unknown_bytes += Number(row.unknown_bytes || 0);
      current.flows += Number(row.flows || 0);
      if (String(row.last_seen_utc || "") > String(current.last_seen_utc || "")) current.last_seen_utc = row.last_seen_utc;
      grouped.set(key, current);
    }
  }
  return Array.from(grouped.values()).sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
}

function appSourceRank(value: unknown) {
  const source = String(value || "");
  if (source === "app_family_catalog") return 5;
  if (source === "dns_exact" || source === "dns_linked") return 4;
  if (source === "provider_hint") return 3;
  if (source === "category_hint") return 2;
  if (source === "ip_only") return 1;
  if (source === "aggregate_residual") return 1;
  return 0;
}

function groupAppFamilyRows(rows: Array<Record<string, any>>, dnsRows: Array<Record<string, any>> = []) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const rowBytes = Number(row.bytes || row.total_bytes || 0);
    if (rowBytes <= 0) continue;
    const domain = row.dns_qname || row.domain || row.sni || (isDomainLikeValue(row.destination_key) ? row.destination_key : "");
    const app = normalizeAppEvidenceSource(classifyAppFamily({
      ...row,
      domain,
      dns_qname: domain || row.dns_qname,
      sni: row.sni,
      destination: row.destination_label || row.destination_key || row.destination,
      category: row.category || row.dns_category,
      provider: row.provider,
      dns_category: row.dns_category,
      traffic_lane: row.traffic_lane,
      traffic_class: row.traffic_class,
    }), row);
    const key = app.app_family || "Other / uncategorized";
    const current = grouped.get(key) || {
      ...app,
      app_family: key,
      bytes: 0,
      total_bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 0,
      clients: new Set<string>(),
      routes: new Set<string>(),
      sample_domains: new Set<string>(),
      dns_queries: 0,
      confidence: "estimated",
      app_source: app.app_source || "none",
      app_confidence: app.app_confidence || "unknown",
      matched_pattern: app.matched_pattern || "",
      provider: row.provider || "",
      category: row.category || row.dns_category || "",
    };
    if (appSourceRank(app.app_source) > appSourceRank(current.app_source)) {
      current.app_source = app.app_source || current.app_source;
      current.app_confidence = app.app_confidence || current.app_confidence;
      current.matched_pattern = app.matched_pattern || current.matched_pattern;
      current.app_category = app.app_category || current.app_category;
      current.traffic_role = app.traffic_role || current.traffic_role;
    }
    current.bytes += rowBytes;
    current.total_bytes += rowBytes;
    current.via_vps_bytes += Number(row.via_vps_bytes || 0);
    current.direct_bytes += Number(row.direct_bytes || 0);
    current.unknown_bytes += Number(row.unknown_bytes || Math.max(0, rowBytes - Number(row.via_vps_bytes || 0) - Number(row.direct_bytes || 0)));
    current.flows += Number(row.flows || row.connections || 0);
    if (row.client_key || row.client_label || row.client) current.clients.add(String(row.client_key || row.client_label || row.client));
    if (row.route) current.routes.add(String(row.route));
    const sample = trafficDisplayDestination(row);
    if (sample && sample !== "not observed") current.sample_domains.add(sample);
    if (!current.provider && row.provider) current.provider = row.provider;
    if (!current.category && (row.category || row.dns_category)) current.category = row.category || row.dns_category;
    if (row.confidence === "exact") current.confidence = "exact";
    grouped.set(key, current);
  }
  for (const row of dnsRows) {
    const app = normalizeAppEvidenceSource(classifyAppFamily(row), row);
    const key = app.app_family || "Other / uncategorized";
    const current = grouped.get(key);
    if (!current) continue;
    current.dns_queries += Number(row.count || 0);
    if (row.domain) current.sample_domains.add(String(row.domain));
    if (appSourceRank(app.app_source) > appSourceRank(current.app_source)) {
      current.app_source = app.app_source || current.app_source;
      current.app_confidence = app.app_confidence || current.app_confidence;
      current.matched_pattern = app.matched_pattern || current.matched_pattern;
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0))
    .map((row, idx) => ({
      ...row,
      rank: idx + 1,
      client_count: row.clients?.size || 0,
      route: row.routes?.size === 1 ? Array.from(row.routes)[0] : row.routes?.size > 1 ? "Mixed" : "Unknown",
      sample_domains: Array.from(row.sample_domains || []).slice(0, 6),
    }));
}

function reconcileAppFamilyRowsToClientTotal(rows: Array<Record<string, any>>, target: Record<string, any> | null = null) {
  if (!target) return rows;
  const targetBytes = observedByteValue(target);
  const rowBytes = rows.reduce((sum, row) => sum + Number(row.bytes || row.total_bytes || 0), 0);
  const residual = Math.round(targetBytes - rowBytes);
  if (targetBytes <= 0 || residual <= Math.max(64 * 1024, targetBytes * 0.05)) return rows;
  const next: Array<Record<string, any>> = rows.map((row) => ({ ...row, sample_domains: Array.isArray(row.sample_domains) ? [...row.sample_domains] : row.sample_domains }));
  const existing = next.find((row) => String(row.app_family || "").toLowerCase() === "other / uncategorized");
  const residualSample = "aggregate client byte evidence";
  if (existing) {
    existing.bytes = Number(existing.bytes || existing.total_bytes || 0) + residual;
    existing.total_bytes = Number(existing.total_bytes || 0) + residual;
    existing.unknown_bytes = Number(existing.unknown_bytes || 0) + residual;
    existing.app_source = existing.app_source === "ip_only" ? "aggregate_residual" : existing.app_source || "aggregate_residual";
    existing.app_confidence = existing.app_confidence || "estimated";
    existing.matched_pattern = existing.matched_pattern || "current-window aggregate residual";
    existing.sample_domains = Array.from(new Set([...(existing.sample_domains || []), residualSample])).slice(0, 6);
  } else {
    next.push({
      app_family: "Other / uncategorized",
      app_category: "uncategorized",
      bytes: residual,
      total_bytes: residual,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: residual,
      flows: 0,
      dns_queries: 0,
      clients: new Set<string>(),
      client_count: 1,
      routes: new Set<string>(),
      route: target.route || "Unknown",
      sample_domains: [residualSample],
      confidence: "estimated",
      app_source: "aggregate_residual",
      app_confidence: "estimated",
      matched_pattern: "current-window aggregate residual",
    });
  }
  return next
    .sort((a, b) => Number(b.bytes || b.total_bytes || 0) - Number(a.bytes || a.total_bytes || 0) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0))
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
}

function groupAppFamilyRowsFromSiteEvidence(siteRows: Array<Record<string, any>>) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of siteRows) {
    const bytes = siteEvidenceBytes(row);
    if (bytes <= 0) continue;
    const app = withAppFamily(row);
    const key = app.app_family || row.app_family || "Other / uncategorized";
    const current = grouped.get(key) || {
      ...app,
      app_family: key,
      label: key,
      destinationLabel: key,
      app_category: app.app_category || row.category || "uncategorized",
      bytes: 0,
      total_bytes: 0,
      effective_bytes: 0,
      factual_bytes: 0,
      inferred_bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      flows: 0,
      dns_queries: 0,
      clients: new Set<string>(),
      routes: new Set<string>(),
      sample_domains: new Set<string>(),
      attributionSources: new Set<string>(),
      confidence: "estimated",
      app_source: row.attribution_source || app.app_source || "dns_inferred",
      app_confidence: row.byte_confidence || app.app_confidence || "estimated",
      matched_pattern: row.matched_pattern || row.attribution_source || "",
      provider: row.provider || "",
      category: row.category || row.dns_category || "",
    };
    current.bytes += bytes;
    current.total_bytes += bytes;
    current.effective_bytes += bytes;
    current.factual_bytes += Number(row.factual_bytes || 0);
    current.inferred_bytes += Number(row.inferred_bytes || 0);
    current.via_vps_bytes += Number(row.via_vps_bytes || 0);
    current.direct_bytes += Number(row.direct_bytes || 0);
    current.unknown_bytes += Number(row.unknown_bytes || Math.max(0, bytes - Number(row.via_vps_bytes || 0) - Number(row.direct_bytes || 0)));
    current.flows += Number(row.flows || row.connections || 0);
    current.dns_queries += Number(row.dns_queries || row.count || 0);
    if (row.client_key || row.client_label || row.client) current.clients.add(String(row.client_key || row.client_label || row.client));
    if (row.route) current.routes.add(String(row.route));
    if (row.domain || row.url_label || row.label) current.sample_domains.add(String(row.domain || row.url_label || row.label));
    if (row.attribution_source) current.attributionSources.add(String(row.attribution_source));
    if (!current.provider && row.provider) current.provider = row.provider;
    if (!current.category && (row.category || row.dns_category)) current.category = row.category || row.dns_category;
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.effective_bytes || b.bytes || 0) - Number(a.effective_bytes || a.bytes || 0) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0))
    .map((row, idx) => ({
      ...row,
      rank: idx + 1,
      label: row.app_family,
      destinationLabel: row.app_family,
      client_count: row.clients?.size || 0,
      route: row.routes?.size === 1 ? Array.from(row.routes)[0] : row.routes?.size > 1 ? "Mixed" : "Unknown",
      sample_domains: Array.from(row.sample_domains || []).slice(0, 6),
      app_source: Array.from(row.attributionSources || [])[0] || row.app_source,
      app_confidence: Number(row.factual_bytes || 0) > 0 && Number(row.inferred_bytes || 0) <= 0 ? "factual" : row.app_confidence,
    }));
}

export function listClientAppFamilies(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const keys = uniqueNonEmpty([resolveLaneClientKey(target, "client_destination_by_lane"), ...laneClientKeyCandidates(target)]);
  const limit = Math.max(1, Number(options.limit || 10));
  return cacheGet(`client-app-families:${latestSnapshotVersion()}:${period}:${keys.join("|")}:${limit}`, () => {
    return groupAppFamilyRowsFromSiteEvidence(listClientSiteEvidence(target, period, { limit: Math.max(limit * 4, 50) })).slice(0, limit);
  });
}

function appFamilySourceRows(filters: ConsoleFilters = {}, clientTarget?: Record<string, any>) {
  const period = filters.period || "today";
  const target = clientTarget || (filters.client && filters.client !== "all" ? { label: filters.client, client_key: filters.client } : null);
  const clientKeys = target ? uniqueNonEmpty([resolveLaneClientKey(target, "client_destination_by_lane"), ...laneClientKeyCandidates(target)]) : [];
  const rows: Array<Record<string, any>> = [];
  const db = getDb();
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const where = [
      "bucket_granularity = ?",
      "bucket_start_utc >= ?",
      "bucket_start_utc < ?",
      "bytes > 0",
    ];
    const params: Array<any> = [granularity, segment.start, segment.end];
    if (clientKeys.length > 0) {
      const clientMatch = clientMatchPredicate(["client_key", "client_label"], clientKeys);
      if (clientMatch.sql) {
        where.push(clientMatch.sql);
        params.push(...clientMatch.params);
      }
    }
    if (filters.route && filters.route !== "all") {
      where.push("route = ?");
      params.push(filters.route);
    }
    if (filters.trafficClass && filters.trafficClass !== "all") {
      where.push("traffic_class = ?");
      params.push(filters.trafficClass);
    }
    const search = filters.search?.trim();
    if (search) {
      const needle = `%${search.toLowerCase()}%`;
      where.push("(lower(client_label) like ? or lower(destination_key) like ? or lower(destination_label) like ?)");
      params.push(needle, needle, needle);
    }
    rows.push(...db.prepare(`
      select client_key,
             max(client_label) as client_label,
             destination_key,
             max(destination_label) as destination_label,
             route,
             confidence,
             traffic_class,
             traffic_lane,
             dns_category,
             max(category) as category,
             max(provider) as provider,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows
        from client_destination_by_lane
       where ${where.map((item) => `(${item})`).join(" and ")}
       group by client_key, destination_key, route, confidence, traffic_class, traffic_lane, dns_category
       order by bytes desc
       limit 5000
    `).all(...params) as Array<Record<string, any>>);
  }
  return rows;
}

export function listAppFamilyRows(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 25, args.maxPageSize || 100);
  const filters = args.filters || {};
  return cacheGet(`app-family-rows:${latestSnapshotVersion()}:${pageArgsKey(args)}`, () => {
    const target = args.clientTarget || (filters.client && filters.client !== "all" ? { label: filters.client, client_key: filters.client } : null);
    const allRows = target
      ? groupAppFamilyRowsFromSiteEvidence(listClientSiteEvidence(target, filters.period || "today", { limit: 500 }))
      : groupAppFamilyRowsFromSiteEvidence(siteEvidenceRowsForFilters(filters, { limit: 5000, perClientLimit: 120 }));
    const total = allRows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const effectivePage = Math.min(page, totalPages);
    const offset = (effectivePage - 1) * pageSize;
    return {
      rows: allRows.slice(offset, offset + pageSize).map((row, idx) => ({ ...row, rank: offset + idx + 1 })),
      total,
      page: effectivePage,
      pageSize,
      totalPages,
    };
  });
}

function routeEvidenceDefectRows(period = "today", options: { clientKey?: string; evidence?: string } = {}) {
  const db = getDb();
  const grouped = new Map<string, Record<string, any>>();
  const clientKey = String(options.clientKey || "");
  const evidence = String(options.evidence || "");
  for (const segment of windowAggregateSegmentsForSelector(period)) {
    const granularity = laneGranularity(segment.layer);
    const whereClient = clientKey ? "and client_key = ?" : "";
    const whereEvidence = evidence ? "and route_evidence = ?" : "";
    const params: Array<string> = [granularity, segment.start, segment.end];
    if (clientKey) params.push(clientKey);
    if (evidence) params.push(evidence);
    const rows = db.prepare(`
      select max(client_label) as client_label,
             client_key,
             channel,
             destination_key,
             max(destination_label) as destination_label,
             traffic_lane,
             dns_category,
             max(category) as category,
             max(provider) as provider,
             route_evidence,
             route,
             intended_route,
             route_verification,
             route_status,
             matched_ipset,
             sum(bytes) as bytes,
             sum(via_vps_bytes) as via_vps_bytes,
             sum(direct_bytes) as direct_bytes,
             sum(unknown_bytes) as unknown_bytes,
             sum(flows) as flows,
             max(last_seen_utc) as last_seen_utc
        from client_route_evidence_defects
       where bucket_granularity = ?
         and bucket_start_utc >= ?
         and bucket_start_utc < ?
         ${whereClient}
         ${whereEvidence}
       group by client_key, channel, destination_key, traffic_lane, dns_category,
                route_evidence, route, intended_route, route_verification, route_status, matched_ipset
    `).all(...params) as Array<Record<string, any>>;
    for (const row of rows) {
      const key = [
        row.client_key,
        row.channel,
        row.destination_key,
        row.traffic_lane,
        row.dns_category,
        row.route_evidence,
        row.route,
        row.intended_route,
        row.route_verification,
        row.route_status,
        row.matched_ipset,
      ].join("|");
      const current = grouped.get(key) || {
        client_key: row.client_key || "",
        client_label: row.client_label || row.client_key || "",
        channel: row.channel || "Unknown",
        destination: row.destination_label || row.destination_key,
        destination_key: row.destination_key,
        destination_label: row.destination_label || row.destination_key,
        traffic_lane: row.traffic_lane || "unknown_review",
        dns_category: row.dns_category || "unknown_domain",
        category: row.category || "unknown",
        provider: row.provider || "",
        route_evidence: row.route_evidence || "unknown_route",
        route: row.route || "Unknown",
        intended_route: row.intended_route || "Unknown",
        route_verification: row.route_verification || "unknown",
        route_status: row.route_status || "unknown",
        matched_ipset: row.matched_ipset || "",
        bytes: 0,
        total_bytes: 0,
        via_vps_bytes: 0,
        direct_bytes: 0,
        unknown_bytes: 0,
        flows: 0,
        last_seen_utc: row.last_seen_utc || "",
      };
      current.bytes += Number(row.bytes || 0);
      current.total_bytes += Number(row.bytes || 0);
      current.via_vps_bytes += Number(row.via_vps_bytes || 0);
      current.direct_bytes += Number(row.direct_bytes || 0);
      current.unknown_bytes += Number(row.unknown_bytes || 0);
      current.flows += Number(row.flows || 0);
      if (String(row.last_seen_utc || "") > String(current.last_seen_utc || "")) current.last_seen_utc = row.last_seen_utc;
      grouped.set(key, current);
    }
  }
  return Array.from(grouped.values()).sort((a, b) => Number(b.unknown_bytes || 0) - Number(a.unknown_bytes || 0) || Number(b.bytes || 0) - Number(a.bytes || 0));
}

export function listClientDomainBreakdown(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const key = resolveLaneClientKey(target, "client_destination_by_lane");
  const limit = Math.max(1, Number(options.limit || 20));
  return cacheGet(`client-domain-breakdown:${latestSnapshotVersion()}:${period}:${key}:${limit}`, () => clientDomainAggregateRows(key, period).slice(0, limit));
}

export function listClientLaneSummary(client: Record<string, any> | string, period = "today", options: { limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const key = resolveLaneClientKey(target, "client_traffic_by_lane");
  const limit = Math.max(1, Number(options.limit || 50));
  return cacheGet(`client-lane-summary:${latestSnapshotVersion()}:${period}:${key}:${limit}`, () => clientLaneSummaryRows(key, period).slice(0, limit));
}

export function listClientDestinationsByLane(client: Record<string, any> | string, period = "today", options: { lane?: string; limit?: number } = {}) {
  const target = typeof client === "string" ? { label: client, client_key: client } : client || {};
  const keys = uniqueNonEmpty([resolveLaneClientKey(target, "client_destination_by_lane"), ...laneClientKeyCandidates(target)]);
  const lane = String(options.lane || "all");
  const limit = Math.max(1, Number(options.limit || 50));
  return cacheGet(`client-destination-lanes:${latestSnapshotVersion()}:${period}:${keys.join("|")}:${lane}:${limit}`, () => clientDestinationLaneRows(keys, period, lane).slice(0, limit));
}

export function listRouteEvidenceDefects(period = "today", options: { client?: Record<string, any> | string; evidence?: string; limit?: number } = {}) {
  const target = typeof options.client === "string" ? { label: options.client, client_key: options.client } : options.client || {};
  const key = resolveLaneClientKey(target, "client_route_evidence_defects");
  const limit = Math.max(1, Number(options.limit || 100));
  const evidence = String(options.evidence || "");
  return cacheGet(`route-evidence-defects:${latestSnapshotVersion()}:${period}:${key}:${evidence}:${limit}`, () => routeEvidenceDefectRows(period, { clientKey: key, evidence }).slice(0, limit));
}

export function listClientActivity(client: Record<string, any> | string, period = "today") {
  const target = typeof client === "string" ? { label: client } : client || {};
  const keyTarget = {
    id: target.id,
    label: target.label,
    client_key: target.client_key,
    client_label: target.client_label,
    device_key: target.device_key,
    device_label: target.device_label,
    aliases: target.aliases,
    observed_aliases: target.observed_aliases,
    observed_identities: target.observed_identities,
  };
  return cacheGet(`list-client-activity:${latestSnapshotVersion()}:${period}:${JSON.stringify(keyTarget)}`, () => listClientActivityUncached(client, period));
}

function listClientActivityUncached(client: Record<string, any> | string, period = "today") {
  const target = typeof client === "string" ? { label: client } : client || {};
  const targetTokens = new Set(rowIdentityTokens(target));
  const targetKey = keyForDevice(target);
  if (targetKey) targetTokens.add(targetKey.toLowerCase());
  if (targetTokens.size === 0) return [];
  const ids = snapshotIdsForDeviceWindow(period, TRAFFIC_DEVICE_TYPES);
  const samples = normalizedRowsForIds("normalized_devices", ids)
    .filter((row: any) => {
      const tokens = rowIdentityTokens(row);
      if (targetKey && keyForDevice({ ...row, raw: row.raw }) === targetKey) return true;
      return tokens.some((token) => targetTokens.has(token));
    })
    .map((row: any) => ({
      collected_at: row.collected_at,
      hour_key: moscowHourKey(row.collected_at),
      total_bytes: Number(row.total_bytes || 0),
      via_vps_bytes: Number(row.via_vps_bytes || 0),
      direct_bytes: Number(row.direct_bytes || 0),
      channel: preservedChannel({ ...row, raw: row.raw }),
      route: deviceRoute(row),
      confidence: row.confidence || "unknown",
    }))
    .sort((a: any, b: any) => Date.parse(a.collected_at) - Date.parse(b.collected_at));
  const byCollected = new Map<string, Record<string, any>>();
  for (const sample of samples) {
    const current = byCollected.get(sample.collected_at);
    if (!current || Number(sample.total_bytes || 0) > Number(current.total_bytes || 0)) byCollected.set(sample.collected_at, sample);
  }
  const ordered = Array.from(byCollected.values()).sort((a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at));
  const byHour = new Map<string, Record<string, any>>();
  let previous: Record<string, any> | null = null;
  for (const sample of ordered) {
    const first = !previous;
    const deltaTotal = first ? sample.total_bytes : Math.max(0, Number(sample.total_bytes || 0) - Number(previous?.total_bytes || 0));
    const deltaVps = first ? sample.via_vps_bytes : Math.max(0, Number(sample.via_vps_bytes || 0) - Number(previous?.via_vps_bytes || 0));
    const deltaDirect = first ? sample.direct_bytes : Math.max(0, Number(sample.direct_bytes || 0) - Number(previous?.direct_bytes || 0));
    previous = sample;
    if (deltaTotal <= 0 && deltaVps <= 0 && deltaDirect <= 0) continue;
    const current = byHour.get(sample.hour_key) || {
      hour_key: sample.hour_key,
      bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      samples: 0,
      mode: first ? "snapshot" : "delta",
      channel: sample.channel,
      route: sample.route,
      confidence: sample.confidence,
      latest_collected_at: sample.collected_at,
    };
    current.bytes += deltaTotal;
    current.via_vps_bytes += deltaVps;
    current.direct_bytes += deltaDirect;
    current.samples += 1;
    current.latest_collected_at = sample.collected_at;
    current.mode = current.mode === "delta" || !first ? "delta" : "snapshot";
    current.route = routeFromCounters(current);
    byHour.set(sample.hour_key, current);
  }
  return Array.from(byHour.values()).sort((a, b) => String(a.hour_key).localeCompare(String(b.hour_key)));
}

function originForLive(row: Record<string, any>) {
  const client = String(row.client || row.client_ip || "").trim();
  const source = String(row.source_log || row.source || "").toLowerCase();
  if (client && !["client", "unknown", "not observed"].includes(client.toLowerCase())) return resolveClient(row).client_label || displayDeviceLabel(client);
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
    event_ts_utc: row.event_ts_utc,
    observed_at_utc: row.observed_at_utc,
    display_ts_utc: row.display_ts_utc,
    time_precision: row.time_precision,
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
  return cacheGet(`list-live-events:${latestSnapshotVersion()}:${pageArgsKey(args)}`, () => listLiveEventsUncached(args));
}

function listLiveEventsUncached(args: PageArgs = {}) {
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize, 150, 1000);
  const offset = (page - 1) * pageSize;
  const filter = { ...(args.filters || {}), trafficClass: args.filters?.trafficClass || "client" };
  const hasPostFilter = Boolean(filter.client && filter.client !== "all") || Boolean(filter.trafficClass && filter.trafficClass !== "all");
  const fetchLimit = Math.max(offset + pageSize * (hasPostFilter ? 8 : 2), pageSize * (hasPostFilter ? 20 : 4));
  const where: string[] = [];
  const params: any[] = [];
  addCommonFilters(where, params, filter);
  const whereSql = where.length ? `where ${where.map((item) => `(${item})`).join(" and ")}` : "";
  const eventSelect = `
    select 'event' as kind, id, event_type, occurred_at, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, channel, destination, dns_qname, destination_ip, route, confidence, summary, source_log
      from events
     ${whereSql}
     order by occurred_at desc, id desc
     limit ?`;
  const decisionSelect = `
    select 'route_decision' as kind, id, 'route.decision' as event_type, occurred_at, event_ts_utc, observed_at_utc, display_ts_utc, time_precision, client, client_ip, channel, destination, dns_qname, destination_ip, route, confidence, '' as summary, source_log
      from route_decisions
     ${whereSql}
     order by occurred_at desc, id desc
     limit ?`;
  const eventRows = getDb().prepare(eventSelect).all(...params, fetchLimit);
  const decisionRows = getDb().prepare(decisionSelect).all(...params, fetchLimit);
  const candidates = [...eventRows, ...decisionRows]
    .sort((a: any, b: any) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")) || Number(b.id || 0) - Number(a.id || 0))
    .slice(0, fetchLimit)
    .map(mapLiveRow)
    .map((row) => ["client", "personal_cloud"].includes(String(filter.trafficClass)) ? operatorLiveRow(row) : row)
    .filter((row): row is Record<string, any> => Boolean(row))
    .filter((row) => filterRows([row], filter).length > 0);
  const total = candidates.length >= fetchLimit ? fetchLimit : candidates.length;
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
