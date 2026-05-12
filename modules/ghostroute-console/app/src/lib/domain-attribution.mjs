import { classifyDestination } from "./intelligence/classification.mjs";

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usefulText(value) {
  const trimmed = text(value).trim();
  if (!trimmed) return "";
  if (["unknown", "client", "not observed", "n/a"].includes(trimmed.toLowerCase())) return "";
  return trimmed;
}

export function trafficDomainLabel(row) {
  for (const candidate of [row?.destination, row?.destinationLabel, row?.family, row?.app, row?.domain, row?.dns_qname, row?.sni, row?.destination_ip]) {
    const value = usefulText(candidate);
    if (value) return value;
  }
  return "";
}

export function isDnsOnlyTraffic(row) {
  return number(row?.bytes || row?.total_bytes || row?.totalBytes) <= 0 && text(row?.confidence).toLowerCase() === "dns-interest";
}

export function isUnclassifiedDomain(value) {
  const domain = text(value).toLowerCase();
  return domain.startsWith("unknown/unattributed")
    || domain === "other"
    || domain === "other/ip"
    || domain === "unknown"
    || domain === "ip-only / no dns match"
    || domain === "unclassified domain";
}

function rowText(row) {
  return [
    row?.client,
    row?.clientLabel,
    row?.device_label,
    row?.destination,
    row?.destinationLabel,
    row?.family,
    row?.app,
    row?.domain,
    row?.dns_qname,
    row?.sni,
    row?.qtype,
    row?.source,
    row?.source_kind,
    row?.source_log,
    row?.channel,
    row?.raw?.client,
    row?.raw?.source,
    row?.raw?.source_log,
    row?.raw?.qtype,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isLocalAddress(value) {
  const ip = text(value).trim().toLowerCase();
  return ip === "127.0.0.1"
    || ip === "::1"
    || ip === "localhost"
    || ip.startsWith("127.")
    || ip.startsWith("169.254.")
    || ip === "0.0.0.0";
}

export function isResolverOrRouterService(row) {
  const domain = trafficDomainLabel(row).toLowerCase();
  const evidence = rowText(row);
  return isLocalAddress(row?.client_ip || row?.ip)
    || isLocalAddress(row?.destination_ip || row?.answer_ip || row?.dns_answer_ip)
    || domain.includes("dns/resolver")
    || domain.endsWith(".arpa")
    || domain === "_dns.resolver.arpa"
    || evidence.includes("dnsmasq")
    || evidence.includes("dnscrypt")
    || evidence.includes("local resolver")
    || evidence.includes("router/local")
    || evidence.includes("router dns")
    || /\bptr\b/.test(evidence);
}

export function isPersonalCloudDomain(value) {
  const domain = text(value).toLowerCase();
  return domain.includes("apple/icloud")
    || domain.includes("icloud")
    || domain.includes("icloud-content")
    || domain.includes("icloud-drive")
    || domain.includes("google drive")
    || domain.includes("google photos")
    || domain.includes("photos.google")
    || domain.includes("drive.google")
    || domain.includes("dropbox")
    || domain.includes("onedrive")
    || domain.includes("sharepoint")
    || domain.includes("backup");
}

export function hasConcreteAppEvidence(row) {
  const destination = text(row?.destination || row?.destinationLabel).toLowerCase();
  const app = text(row?.app || row?.family || row?.category || row?.destination_class).toLowerCase();
  const generic = /^(aws\/cdn|cdn|cloudfront|akamai|fastly|cloudflare|amazonaws|unclassified domain|other\/ip|unknown)$/;
  return Boolean((app && !generic.test(app)) || (destination && !generic.test(destination)));
}

export function isServiceDomain(value, row = {}) {
  const domain = text(value).toLowerCase();
  const evidence = rowText(row);
  const classification = classifyDestination({ ...row, destination: value });
  if (classification.category.startsWith("system.") || classification.category.startsWith("analytics.") || classification.category.startsWith("tracker.") || classification.category.startsWith("cdn.")) return true;
  if (isResolverOrRouterService({ ...row, destination: value })) return true;
  return domain.includes("dns/resolver")
    || domain.includes("asus")
    || domain.includes("asuscomm")
    || domain.includes("trendmicro")
    || domain.includes("ntp.org")
    || domain.includes("configuration.apple.com")
    || domain.includes("stocks-data-service.apple.com")
    || domain.includes("msftncsi")
    || domain.includes("connectivitycheck")
    || domain.includes("captive.apple")
    || domain.includes("ocsp")
    || domain.includes("crl.")
    || domain.includes("crashlytics")
    || domain.includes("app-measurement")
    || domain.includes("beacons.gvt")
    || domain.includes("firebase-settings")
    || domain.includes("telemetry")
    || domain.includes("analytics")
    || domain.includes("metrics")
    || domain.includes("push.apple")
    || domain.includes("gvt2.com")
    || domain.includes("gvt3.com")
    || domain.includes("mzstatic")
    || domain.includes("aaplimg")
    || domain.includes("itunes")
    || domain.includes("aws/cdn")
    || domain.includes("cloudfront")
    || domain.includes("amazonaws")
    || domain.includes("cloudflare")
    || domain.includes("akamai")
    || domain.includes("fastly")
    || (domain === "cdn" && !hasConcreteAppEvidence(row))
    || evidence.includes("health check")
    || evidence.includes("control-plane");
}

export function trafficClassForDomain(row) {
  if (row?.accounting_bucket || row?.raw?.accounting_bucket) return "unclassified";
  const domain = trafficDomainLabel(row);
  if (!domain) return "service_background";
  if (isUnclassifiedDomain(domain)) return "unclassified";
  const classification = classifyDestination(row);
  if (classification.category && !classification.category.startsWith("unknown.")) return classification.traffic_class;
  if (["unknown.empty", "unknown.ip_only", "unknown.no_dns_match", "unknown.shared_dns_answer"].includes(classification.category)) return "unclassified";
  if (isPersonalCloudDomain(domain)) return "personal_cloud";
  if (isServiceDomain(domain, row)) return "service_background";
  return "unclassified";
}

export function destinationClassification(row) {
  return classifyDestination(row);
}

function rowBytes(row) {
  return number(row?.bytes || row?.total_bytes || row?.totalBytes);
}

function routeFromBytes(row) {
  const vps = number(row?.via_vps_bytes || row?.viaVpsBytes);
  const direct = number(row?.direct_bytes || row?.directBytes);
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return text(row?.route, "Unknown");
}

function scaleRows(rows, targetBytes) {
  const rawTotal = rows.reduce((sum, row) => sum + rowBytes(row), 0);
  if (rawTotal <= 0 || targetBytes <= 0) return rows;
  const scale = targetBytes / rawTotal;
  const scaled = rows.map((row) => {
    const bytes = Math.round(rowBytes(row) * scale);
    const viaVpsBytes = Math.round(number(row.via_vps_bytes || row.viaVpsBytes) * scale);
    const directBytes = Math.round(number(row.direct_bytes || row.directBytes) * scale);
    const unknownBytes = Math.max(0, bytes - viaVpsBytes - directBytes);
    return {
      ...row,
      raw_bytes: rowBytes(row),
      bytes,
      total_bytes: bytes,
      via_vps_bytes: viaVpsBytes,
      direct_bytes: directBytes,
      unknown_bytes: unknownBytes,
      route: routeFromBytes({ ...row, via_vps_bytes: viaVpsBytes, direct_bytes: directBytes }),
      allocation_basis: "proportional_client_total",
    };
  });
  let diff = targetBytes - scaled.reduce((sum, row) => sum + rowBytes(row), 0);
  for (const row of scaled.sort((a, b) => rowBytes(b) - rowBytes(a))) {
    if (diff === 0) break;
    const adjustment = diff > 0 ? 1 : -1;
    if (row.bytes + adjustment < 0) continue;
    row.bytes += adjustment;
    row.total_bytes = row.bytes;
    diff -= adjustment;
  }
  return scaled;
}

export function normalizeDomainBreakdown(rows, targetBytes, options = {}) {
  const limit = Math.max(1, number(options.limit || 8));
  const minimumCoverageRatio = number(options.minimumCoverageRatio ?? 0.5);
  const positiveRows = (rows || [])
    .map((row) => ({
      ...row,
      destination: trafficDomainLabel(row) || text(row.destination, "Unknown destination"),
      destinationLabel: row.destinationLabel || trafficDomainLabel(row) || text(row.destination, "Unknown destination"),
      trafficClass: row.trafficClass || row.traffic_class || trafficClassForDomain(row),
      route: routeFromBytes(row),
      bytes: rowBytes(row),
      total_bytes: rowBytes(row),
    }))
    .filter((row) => row.bytes > 0 && !row.accounting_bucket);
  const rawTotalBytes = positiveRows.reduce((sum, row) => sum + row.bytes, 0);
  const target = Math.max(0, Math.round(number(targetBytes)));
  const coverageRatio = target > 0 ? rawTotalBytes / target : 1;
  const shouldScale = target > 0 && rawTotalBytes > 0 && coverageRatio >= minimumCoverageRatio;
  const normalizedRows = (shouldScale ? scaleRows(positiveRows, target) : positiveRows)
    .sort((a, b) => rowBytes(b) - rowBytes(a))
    .slice(0, limit);
  const shownBytes = normalizedRows.reduce((sum, row) => sum + rowBytes(row), 0);
  return {
    rows: normalizedRows,
    rawTotalBytes,
    targetBytes: target,
    coverageRatio,
    scaled: shouldScale,
    unattributedBytes: shouldScale ? 0 : Math.max(0, target - shownBytes),
  };
}
