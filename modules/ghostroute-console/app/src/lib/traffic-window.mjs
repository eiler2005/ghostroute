const GENERIC_DESTINATIONS = new Set([
  "AI services",
  "Apple/iCloud",
  "AWS/CDN",
  "DNS/Resolver",
  "Dev/Productivity",
  "Google/YouTube",
  "IP-only / no DNS match",
  "Meta/Instagram",
  "Other",
  "Other/IP",
  "Unclassified domain",
]);

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function moscowParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function moscowDateKey(value, now = new Date()) {
  return moscowParts(value) || moscowParts(now) || "";
}

function snapshotEffectivePeriod(snapshot) {
  const payload = snapshot?.payload || snapshot || {};
  const period = text(payload.source?.period || payload.period, "");
  if (period) return period;
  const command = text(payload.source?.command || snapshot?.source, "");
  if (command.includes("traffic-summary") || command.includes("traffic-report") || command.includes("traffic")) return "today";
  return "";
}

export function snapshotMatchesPeriod(snapshot, period = "today", now = new Date()) {
  if (!snapshot) return false;
  const requested = period || "today";
  const effective = snapshotEffectivePeriod(snapshot);
  if (effective && effective !== requested) return false;
  if (requested !== "today") return effective === requested;
  const payload = snapshot.payload || snapshot || {};
  const collected = text(snapshot.collectedAt || payload.generated_at || payload.collected_at, "");
  if (!collected) return false;
  return moscowDateKey(collected, now) === moscowDateKey(now, now);
}

export function isIpLiteral(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(text(value));
}

export function isGenericTrafficDestination(value) {
  const destination = text(value).trim();
  if (!destination) return true;
  if (GENERIC_DESTINATIONS.has(destination)) return true;
  if (destination.includes("/") && !destination.includes(".")) return true;
  return false;
}

export function concreteTrafficDestination(row) {
  const candidates = [
    row?.dns_qname,
    row?.sni,
    row?.raw?.dns_qname,
    row?.raw?.sni,
    row?.destination,
    row?.destination_ip,
    row?.raw?.destination_ip,
  ].map((value) => text(value).trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (isIpLiteral(candidate)) return candidate;
    if (candidate.includes(".") && !isGenericTrafficDestination(candidate)) return candidate;
  }
  return "";
}

export function trafficDisplayDestination(row) {
  return concreteTrafficDestination(row) || text(row?.destinationLabel || row?.destination || row?.family || row?.domain, "n/a");
}

function routeValue(row) {
  return text(row?.route, "Unknown");
}

function byteValue(row) {
  return number(row?.bytes || row?.total_bytes);
}

function routeFromCounters(row) {
  const vps = number(row?.via_vps_bytes || (row?.route === "VPS" ? row?.bytes : 0));
  const direct = number(row?.direct_bytes || (row?.route === "Direct" ? row?.bytes : 0));
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return row?.route || "Unknown";
}

export function reconcileTrafficRows(rows, totals = {}) {
  const observed = number(totals.observed);
  if (!observed || rows.length === 0) return rows;
  const rowTotal = rows.reduce((sum, row) => sum + byteValue(row), 0);
  if (rowTotal <= observed * 1.03) return rows;
  const totalScale = observed / rowTotal;
  const vpsTotal = rows.reduce((sum, row) => sum + number(row?.via_vps_bytes || (row?.route === "VPS" ? row?.bytes : 0)), 0);
  const directTotal = rows.reduce((sum, row) => sum + number(row?.direct_bytes || (row?.route === "Direct" ? row?.bytes : 0)), 0);
  const unknownTotal = rows.reduce((sum, row) => {
    const split = number(row?.via_vps_bytes || (row?.route === "VPS" ? row?.bytes : 0)) + number(row?.direct_bytes || (row?.route === "Direct" ? row?.bytes : 0));
    return split > 0 ? sum : sum + byteValue(row);
  }, 0);
  const unknownBudget = Math.max(0, observed - number(totals.vps) - number(totals.direct));
  const vpsScale = number(totals.vps) > 0 && vpsTotal > number(totals.vps) ? number(totals.vps) / vpsTotal : totalScale;
  const directScale = number(totals.direct) > 0 && directTotal > number(totals.direct) ? number(totals.direct) / directTotal : totalScale;
  const unknownScale = unknownTotal > 0 ? Math.min(totalScale, unknownBudget / unknownTotal) : totalScale;
  const reconciled = rows.map((row) => {
    const viaVps = Math.round(number(row?.via_vps_bytes || (row?.route === "VPS" ? row?.bytes : 0)) * vpsScale);
    const direct = Math.round(number(row?.direct_bytes || (row?.route === "Direct" ? row?.bytes : 0)) * directScale);
    const hasSplit = viaVps > 0 || direct > 0;
    const value = Math.round(byteValue(row) * unknownScale);
    const bytesValue = hasSplit ? viaVps + direct : value;
    return {
      ...row,
      total_bytes: row?.total_bytes !== undefined ? bytesValue : row?.total_bytes,
      bytes: row?.bytes !== undefined ? bytesValue : row?.bytes,
      via_vps_bytes: row?.via_vps_bytes !== undefined ? viaVps : row?.via_vps_bytes,
      direct_bytes: row?.direct_bytes !== undefined ? direct : row?.direct_bytes,
      route: hasSplit ? routeFromCounters({ via_vps_bytes: viaVps, direct_bytes: direct, route: row?.route }) : row?.route,
      reconciled: true,
      raw_total_bytes: byteValue(row),
    };
  });
  let overage = reconciled.reduce((sum, row) => sum + byteValue(row), 0) - observed;
  if (overage > 0) {
    for (const row of [...reconciled].sort((a, b) => byteValue(b) - byteValue(a))) {
      const current = byteValue(row);
      if (current <= 0) continue;
      const adjustment = Math.min(current, overage);
      if (row.total_bytes !== undefined) row.total_bytes = current - adjustment;
      if (row.bytes !== undefined) row.bytes = current - adjustment;
      overage -= adjustment;
      if (overage <= 0) break;
    }
  }
  return reconciled;
}

function routeLabel(routes) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  if (clean.includes("VPS") && clean.includes("Direct")) return "Mixed";
  return "Mixed";
}

export function groupDestinationRows(rows, limit = 8) {
  const byDestination = new Map();
  for (const row of rows) {
    const destination = concreteTrafficDestination(row);
    if (!destination || byteValue(row) <= 0) continue;
    const current = byDestination.get(destination) || {
      label: destination,
      bytes: 0,
      routes: new Set(),
      clients: new Set(),
      categories: new Set(),
      row,
    };
    current.bytes += byteValue(row);
    current.routes.add(routeValue(row));
    if (row?.client) current.clients.add(text(row.client));
    if (row?.destinationLabel && row.destinationLabel !== destination) current.categories.add(text(row.destinationLabel));
    byDestination.set(destination, current);
  }
  return Array.from(byDestination.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((item) => ({
      ...item.row,
      destinationLabel: item.label,
      bytes: item.bytes,
      route: routeLabel(item.routes),
      detail: [
        Array.from(item.categories).slice(0, 2).join(", "),
        item.clients.size > 0 ? `${item.clients.size} client${item.clients.size === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" · "),
    }));
}

function attributionEvidence(row) {
  return concreteTrafficDestination(row) || text(row?.destination_ip || row?.dns_qname || row?.sni || row?.raw?.destination_ip, "");
}

export function groupAttributionRows(rows, limit = 10) {
  const grouped = new Map();
  for (const row of rows) {
    if (byteValue(row) <= 0) continue;
    const reason = text(row?.destinationLabel || row?.destination || "Needs attribution");
    const evidence = attributionEvidence(row);
    const key = [reason, evidence || "no-evidence", routeValue(row)].join("|").toLowerCase();
    const current = grouped.get(key) || {
      label: evidence || reason,
      reason,
      evidence,
      bytes: 0,
      routes: new Set(),
      clients: new Set(),
      count: 0,
      row,
    };
    current.bytes += byteValue(row);
    current.routes.add(routeValue(row));
    if (row?.client) current.clients.add(text(row.client));
    current.count += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((item) => ({
      ...item.row,
      destinationLabel: item.label,
      bytes: item.bytes,
      route: routeLabel(item.routes),
      attributionReason: item.reason,
      attributionDetail: [
        item.evidence ? `evidence: ${item.evidence}` : "no concrete DNS/SNI/IP evidence",
        item.clients.size > 0 ? `clients: ${Array.from(item.clients).slice(0, 3).join(", ")}` : "",
        item.count > 1 ? `${item.count} rows` : "",
      ].filter(Boolean).join(" · "),
    }));
}

export function alertEvidenceText(alert) {
  const raw = alert?.raw || {};
  const evidence = alert?.evidence || raw.evidence || {};
  const candidates = [
    alert?.destination,
    alert?.domain,
    raw.destination,
    raw.domain,
    evidence.destination,
    evidence.domain,
    evidence.dns_qname,
    evidence.sni,
    evidence.destination_ip,
    typeof evidence === "string" ? evidence : "",
  ].map((value) => text(value).trim()).filter(Boolean);
  const concrete = candidates.find((value) => value.includes(".") || isIpLiteral(value)) || candidates[0] || "";
  const source = text(alert?.source || raw.source, "");
  const status = text(alert?.status || raw.status, "");
  return [concrete, source, status].filter(Boolean).join(" · ");
}

export function dedupeAlerts(alerts) {
  const grouped = new Map();
  for (const alert of alerts) {
    const evidence = alertEvidenceText(alert);
    const key = [alert?.title, alert?.severity, evidence].map((value) => text(value).toLowerCase()).join("|");
    const current = grouped.get(key) || { ...alert, detail: evidence, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).map((alert) => ({
    ...alert,
    detail: [alert.detail, alert.count > 1 ? `${alert.count} repeats` : ""].filter(Boolean).join(" · "),
  }));
}
