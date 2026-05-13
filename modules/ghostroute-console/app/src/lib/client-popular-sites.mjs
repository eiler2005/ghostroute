import { trafficDisplayDestination } from "./traffic-window.mjs";

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

export function title(value = "") {
  return String(value || "unknown").replace(/_/g, " ");
}

export function siteBytes(row = {}) {
  return Number(row.bytes || row.total_bytes || row.totalBytes || row.observed_bytes || 0);
}

function siteLane(row = {}) {
  return String(row.traffic_lane || row.trafficClass || row.traffic_class || "unknown_review");
}

function isServiceSite(row = {}) {
  const lane = siteLane(row);
  return lane === "service_system" || String(row.trafficClass || row.traffic_class || "") === "service_background";
}

function normalizeSiteLabel(label = "") {
  return String(label || "").trim().toLowerCase();
}

function isUsefulSiteLabel(label, excludedLabels = new Set()) {
  const normalized = normalizeSiteLabel(label);
  return Boolean(label)
    && !["n/a", "client", "no site evidence"].includes(normalized)
    && !normalized.includes("destination aggregate")
    && !excludedLabels.has(normalized);
}

function routeFromSiteRoutes(routes) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return "Mixed";
}

export function groupPopularSites(rows = [], kind = "client", limit = 15, options = {}) {
  const grouped = new Map();
  const excludedLabels = new Set((options.excludeLabels || []).map(normalizeSiteLabel).filter(Boolean));
  for (const row of rows) {
    if ((kind === "service") !== isServiceSite(row)) continue;
    const label = trafficDisplayDestination(row);
    if (!isUsefulSiteLabel(label, excludedLabels)) continue;
    const key = label.toLowerCase();
    const current = grouped.get(key) || {
      ...row,
      label,
      destinationLabel: label,
      bytes: 0,
      total_bytes: 0,
      flows: 0,
      routes: new Set(),
      lanes: new Set(),
      last_seen_utc: row.last_seen_utc || row.collected_at || "",
    };
    current.bytes += siteBytes(row);
    current.total_bytes += siteBytes(row);
    current.flows += Number(row.flows || row.connections || 0);
    if (row.route) current.routes.add(String(row.route));
    current.lanes.add(siteLane(row));
    if (String(row.last_seen_utc || row.collected_at || "") > String(current.last_seen_utc || "")) {
      current.last_seen_utc = row.last_seen_utc || row.collected_at || "";
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0) || String(a.label).localeCompare(String(b.label)))
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      route: routeFromSiteRoutes(row.routes || new Set()),
      laneLabel: Array.from(row.lanes || []).filter(Boolean).map((lane) => title(String(lane))).slice(0, 2).join(", ") || title(siteLane(row)),
    }));
}

export function counterOnlyRows(rows = [], kind = "client", limit = 1) {
  const grouped = new Map();
  for (const row of rows) {
    if ((kind === "service") !== isServiceSite(row)) continue;
    if (siteBytes(row) <= 0 && !row.accounting_bucket && !row.raw?.accounting_bucket) continue;
    const label = trafficDisplayDestination(row);
    if (isUsefulSiteLabel(label)) continue;
    const key = isServiceSite(row) ? "service-counter-only" : "client-counter-only";
    const current = grouped.get(key) || {
      ...row,
      id: key,
      label: "Traffic without site attribution",
      destination: "Traffic without site attribution",
      destinationLabel: "Traffic without site attribution",
      bytes: 0,
      total_bytes: 0,
      flows: 0,
      routes: new Set(),
      laneLabel: "counter-only · destination not observed",
      counterOnly: true,
    };
    current.bytes += siteBytes(row);
    current.total_bytes += siteBytes(row);
    current.flows += Number(row.flows || row.connections || 0);
    if (row.route) current.routes.add(String(row.route));
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0))
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      route: routeFromSiteRoutes(row.routes || new Set()),
    }));
}

export function counterFallbackRows(selected, rows = [], route = "Unknown", kind = "client", attributedBytes = 0) {
  if (!selected || kind === "service") return [];
  const selectedBytes = Math.max(
    siteBytes(selected),
    rows.reduce((max, row) => Math.max(max, siteBytes(row)), 0)
  );
  const residualBytes = Math.max(0, selectedBytes - attributedBytes);
  if (residualBytes <= 0) return [];
  const selectedFlows = Math.max(
    Number(selected.flows || selected.connections || 0),
    rows.reduce((max, row) => Math.max(max, Number(row.flows || row.connections || 0)), 0)
  );
  return [{
    id: "client-counter-fallback",
    rank: 1,
    label: "Traffic without site attribution",
    destination: "Traffic without site attribution",
    destinationLabel: "Traffic without site attribution",
    bytes: residualBytes,
    total_bytes: residualBytes,
    flows: selectedFlows,
    route,
    laneLabel: "counter-only · residual traffic",
    counterOnly: true,
  }];
}

export function dnsEstimatedRows(dnsRows = [], residualBytes = 0, route = "Unknown", limit = 15, options = {}) {
  const excludedLabels = new Set((options.excludeLabels || []).map(normalizeSiteLabel).filter(Boolean));
  const candidates = [];
  for (const row of dnsRows || []) {
    const label = text(row.domain || row.label || row.destination || row.destinationLabel);
    if (!isUsefulSiteLabel(label, excludedLabels)) continue;
    candidates.push({
      ...row,
      label,
      destination: label,
      destinationLabel: label,
      weight: Math.max(1, Number(row.count || row.flows || 1)),
    });
  }
  const visible = candidates.slice(0, limit);
  const totalWeight = visible.reduce((sum, row) => sum + row.weight, 0);
  const totalResidual = Math.max(0, Number(residualBytes || 0));
  if (totalWeight <= 0 || totalResidual <= 0) return [];
  let allocated = 0;
  return visible.map((row, index) => {
    const isLast = index === visible.length - 1;
    const share = isLast ? Math.max(0, totalResidual - allocated) : Math.floor((totalResidual * row.weight) / totalWeight);
    allocated += share;
    return {
      id: `dns-estimated-${index}-${normalizeSiteLabel(row.label)}`,
      rank: index + 1,
      label: row.label,
      destination: row.label,
      destinationLabel: row.label,
      bytes: share,
      total_bytes: share,
      flows: row.weight,
      route,
      laneLabel: "DNS-estimated · residual traffic",
      confidence: "estimated/dns-interest",
      dnsEstimated: true,
      allocationBasis: "dns-interest-residual",
      destinationEvidence: "dns_interest",
    };
  }).filter((row) => siteBytes(row) > 0);
}

function mergeVisibleRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const label = text(row.label || row.destinationLabel || row.destination);
    if (!label) continue;
    const key = normalizeSiteLabel(label);
    const current = grouped.get(key) || {
      ...row,
      label,
      destination: row.destination || label,
      destinationLabel: label,
      bytes: 0,
      total_bytes: 0,
      flows: 0,
      laneLabels: new Set(),
      routes: new Set(),
    };
    current.bytes += siteBytes(row);
    current.total_bytes += siteBytes(row);
    current.flows += Number(row.flows || row.connections || 0);
    current.counterOnly = Boolean(current.counterOnly || row.counterOnly);
    current.dnsOnly = Boolean(current.dnsOnly || row.dnsOnly);
    current.dnsEstimated = Boolean(current.dnsEstimated || row.dnsEstimated);
    if (row.allocationBasis) current.allocationBasis = row.allocationBasis;
    if (row.destinationEvidence) current.destinationEvidence = row.destinationEvidence;
    if (row.confidence) current.confidence = row.confidence;
    if (row.route) current.routes.add(String(row.route));
    if (row.laneLabel) current.laneLabels.add(String(row.laneLabel));
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).map((row) => ({
    ...row,
    route: routeFromSiteRoutes(row.routes || new Set()),
    laneLabel: Array.from(row.laneLabels || []).filter(Boolean).slice(0, 3).join(", ") || row.laneLabel,
  }));
}

export function composePopularSiteRows(rows = [], dnsFallback = [], counterFallback = []) {
  const residualRows = counterFallback || [];
  const dnsRows = rows.length || residualRows.length ? [] : (dnsFallback || []);
  return mergeVisibleRows([...rows, ...residualRows, ...dnsRows])
    .sort((a, b) => siteBytes(b) - siteBytes(a) || text(a.label).localeCompare(text(b.label)))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
