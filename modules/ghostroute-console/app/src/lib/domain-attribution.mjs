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

export function isServiceDomain(value) {
  const domain = text(value).toLowerCase();
  return domain.includes("apple/icloud")
    || domain.includes("dns/resolver")
    || domain.includes("aws/cdn")
    || domain.includes("icloud")
    || domain.includes("apple")
    || domain.includes("itunes")
    || domain.includes("mzstatic")
    || domain.includes("aaplimg")
    || domain.includes("cloudfront")
    || domain.includes("amazonaws")
    || domain.includes("cloudflare")
    || domain.includes("akamai")
    || domain.includes("fastly")
    || domain === "cdn"
    || domain.includes("resolver");
}

export function trafficClassForDomain(row) {
  if (row?.accounting_bucket || row?.raw?.accounting_bucket) return "unclassified";
  const domain = trafficDomainLabel(row);
  if (isDnsOnlyTraffic(row)) return "service_background";
  if (!domain) return "service_background";
  if (isServiceDomain(domain)) return "service_background";
  if (isUnclassifiedDomain(domain)) return "unclassified";
  return "client";
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
