import { trafficClassForDomain } from "./domain-attribution.mjs";

const GENERIC_DESTINATIONS = new Set([
  "AI services",
  "Apple/iCloud",
  "AWS/CDN",
  "DNS/Resolver",
  "Dev/Productivity",
  "Google/YouTube",
  "IP-only / no DNS match",
  "Client",
  "Meta/Instagram",
  "Other",
  "Other/IP",
  "Unclassified domain",
]);

const PSEUDO_DESTINATIONS = new Set([
  "Home Reality ingress",
  "A/Home Reality",
  "B/XHTTP relay",
  "C/Naive ingress",
  "Channel A",
  "Channel B",
  "Channel C",
  "Unknown/Unattributed client traffic",
  "Unknown/Unattributed LAN-Wi-Fi",
]);

const CATEGORY_LABELS = {
  "client.home_reality_ingress": "Encrypted ingress traffic",
  "client.google.youtube": "Google YouTube",
  "client.ai.anthropic": "Anthropic API",
  "client.ai.openai": "OpenAI / ChatGPT",
  "client.meeting.zoom": "Zoom meeting traffic",
  "personal_cloud.dropbox": "Dropbox",
  "system.apple.push": "Apple push service",
  "analytics.firebase": "Firebase analytics",
  "cdn.shared": "Shared CDN traffic",
  "unknown.ip_only": "IP-only destination",
  "unknown.no_dns_match": "IP-only destination",
  "unknown.shared_dns_answer": "Shared DNS answer",
  "unknown.domain": "Unknown domain",
};

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

export function isPseudoTrafficDestination(value) {
  const destination = text(value).trim();
  if (!destination) return false;
  if (PSEUDO_DESTINATIONS.has(destination)) return true;
  const lower = destination.toLowerCase();
  return lower.endsWith(" ingress") || lower.includes(" ingress ") || lower.includes(" relay");
}

export function isGenericTrafficDestination(value) {
  const destination = text(value).trim();
  if (!destination) return true;
  if (GENERIC_DESTINATIONS.has(destination)) return true;
  if (isPseudoTrafficDestination(destination)) return true;
  if (destination.includes("/") && !destination.includes(".")) return true;
  if (destination === "Client") return true;
  return false;
}

export function concreteTrafficDestination(row) {
  const candidates = [
    row?.dns_qname,
    row?.sni,
    row?.raw?.dns_qname,
    row?.raw?.sni,
    row?.destination,
  ].map((value) => text(value).trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (isIpLiteral(candidate)) continue;
    if (candidate.includes(".") && !isGenericTrafficDestination(candidate)) return candidate;
  }
  return "";
}

export function technicalTrafficDestination(row) {
  return concreteTrafficDestination(row) || text(row?.destination_ip || row?.raw?.destination_ip || row?.dns_qname || row?.sni || row?.raw?.destination_ip, "");
}

function prettyToken(value) {
  return text(value)
    .replace(/^[a-z]+[.]/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function providerDisplayName(value) {
  const provider = text(value).trim();
  if (!provider) return "";
  const normalized = provider.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized || normalized === "unknown") return "";
  if (normalized.includes("facebook") || normalized.includes("meta")) return "Facebook network";
  if (normalized.includes("google")) return "Google network";
  if (normalized.includes("youtube")) return "Google YouTube network";
  if (normalized.includes("yandex")) return "Yandex network";
  if (normalized.includes("telegram")) return "Telegram network";
  if (normalized.includes("apple")) return "Apple network";
  if (normalized.includes("microsoft")) return "Microsoft network";
  if (normalized.includes("cloudflare")) return "Cloudflare network";
  if (normalized.includes("amazon") || normalized === "aws") return "Amazon/AWS network";
  if (normalized.includes("akamai")) return "Akamai CDN";
  if (normalized.includes("fastly")) return "Fastly CDN";
  const compact = provider
    .replace(/[_-]+/g, " ")
    .replace(/\b(AS|LLC|INC|LTD|CORP|CO)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact ? `${prettyToken(compact)} network` : "";
}

function ipCategoryDisplayName(value) {
  const category = text(value).trim();
  if (!category || category.startsWith("unknown.")) return "";
  return prettyToken(category.replace(/^ip_asn[.]/, ""));
}

function ipEnrichmentLabel(row) {
  const provider = providerDisplayName(row?.provider || row?.ip_provider || row?.asn_org || row?.raw?.provider || row?.raw?.ip_provider || row?.raw?.asn_org);
  if (provider) return provider;
  return ipCategoryDisplayName(row?.category || row?.ip_category_hint || row?.raw?.category || row?.raw?.ip_category_hint);
}

function categoryLabel(row) {
  const category = text(row?.category || row?.raw?.category || row?.dns_category || row?.traffic_lane || row?.traffic_role || row?.traffic_class, "");
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  if (category) return prettyToken(category);
  const provider = text(row?.provider || row?.raw?.provider, "");
  if (provider) return provider;
  const role = text(row?.traffic_role || row?.traffic_purpose, "");
  if (role) return prettyToken(role);
  return "";
}

function hasIpEvidence(row) {
  return Boolean(text(row?.destination_ip || row?.raw?.destination_ip || row?.answer_ip || row?.dns_answer_ip, "")) || isIpLiteral(row?.destination);
}

export function trafficDisplayDestination(row) {
  const concrete = concreteTrafficDestination(row);
  if (concrete) return concrete;
  if (hasIpEvidence(row)) {
    const ipLabel = ipEnrichmentLabel(row);
    if (ipLabel) return ipLabel;
  }
  for (const candidate of [row?.destinationLabel, row?.destination, row?.family, row?.domain]) {
    const value = text(candidate).trim();
    if (!value || value === "unknown destination") continue;
    if (isIpLiteral(value)) continue;
    if (!isGenericTrafficDestination(value)) return value;
  }
  const category = categoryLabel(row);
  if (category) return category;
  if (hasIpEvidence(row)) return "IP-only destination";
  if (row?.accounting_bucket) return "No site evidence";
  return "n/a";
}

export function isPrimaryTrafficDestinationLabel(value) {
  const label = text(value).trim();
  if (!label || label === "n/a" || label === "unknown destination") return false;
  if (isIpLiteral(label)) return false;
  if (label === "IP-only destination" || label === "No site evidence") return false;
  if (["Client", "Other", "Other/IP", "Unclassified domain"].includes(label)) return false;
  return !isPseudoTrafficDestination(label);
}

function isClientOnlyDestination(value) {
  return text(value).trim() === "Client";
}

export function destinationEvidence(row) {
  const dns = text(row?.dns_qname || row?.raw?.dns_qname).trim();
  if (dns) {
    const linked = Boolean(text(row?.dns_link_confidence || row?.dns_status || row?.raw?.dns_link_confidence || row?.raw?.dns_status).trim());
    return { label: dns, kind: linked ? "DNS-linked" : "DNS", exact: !linked };
  }
  const sni = text(row?.sni || row?.raw?.sni).trim();
  if (sni && !isGenericTrafficDestination(sni)) return { label: sni, kind: "SNI", exact: true };
  const ip = text(row?.destination_ip || row?.raw?.destination_ip || (isIpLiteral(row?.destination) ? row?.destination : "")).trim();
  if (ip) {
    const label = ipEnrichmentLabel(row) || "IP-only destination";
    return { label, kind: label === "IP-only destination" ? "IP" : "IP/provider", exact: false, technical: ip };
  }
  const rawDestination = text(row?.destinationLabel || row?.destination || row?.family || row?.domain).trim();
  if (rawDestination && rawDestination !== "unknown destination" && !isIpLiteral(rawDestination) && !isPseudoTrafficDestination(rawDestination) && !isClientOnlyDestination(rawDestination)) {
    return {
      label: rawDestination,
      kind: isGenericTrafficDestination(rawDestination) ? "category" : "counter",
      exact: false,
    };
  }
  const destination = trafficDisplayDestination(row);
  if (destination && destination !== "n/a" && destination !== "unknown destination" && !isClientOnlyDestination(destination)) {
    return {
      label: destination,
      kind: isGenericTrafficDestination(destination) ? "category" : "counter",
      exact: false,
    };
  }
  const pseudoDestination = text(row?.destination || row?.raw?.destination).trim();
  if (isPseudoTrafficDestination(pseudoDestination)) {
    return {
      label: categoryLabel({ ...row, category: row?.category || row?.raw?.category || "client.home_reality_ingress" }) || "Encrypted ingress traffic",
      kind: "counter",
      exact: false,
    };
  }
  if (row?.accounting_bucket || row?.raw?.accounting_bucket) {
    return { label: "No site evidence", kind: "counter", exact: false };
  }
  return { label: "not observed", kind: "not observed", exact: false };
}

function dnsCount(row) {
  const parsed = number(row?.count || row?.query_count || row?.total || row?.rows);
  return parsed > 0 ? parsed : 1;
}

function timestampMs(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function aggregateDnsInterest(rows, limit = 8) {
  const grouped = new Map();
  for (const row of rows || []) {
    const domain = text(row?.domain || row?.qname || row?.dns_qname || row?.query || row?.destination || row?.answer_ip).trim();
    if (!domain || domain === "n/a") continue;
    const key = domain.toLowerCase();
    const latest = text(row?.event_ts || row?.occurred_at || row?.collected_at);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { domain, count: dnsCount(row), latest, rows: [row] });
      continue;
    }
    current.count += dnsCount(row);
    current.rows.push(row);
    if (timestampMs(latest) > timestampMs(current.latest)) current.latest = latest;
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || timestampMs(b.latest) - timestampMs(a.latest) || a.domain.localeCompare(b.domain))
    .slice(0, Math.max(1, number(limit) || 8));
}

export function dnsInterestTrafficClass(row) {
  const evidence = Array.isArray(row?.rows) && row.rows.length ? row.rows[0] : row || {};
  const domain = text(row?.domain || evidence.domain || evidence.qname || evidence.dns_qname || evidence.query || evidence.destination).trim();
  return trafficClassForDomain({
    ...evidence,
    domain,
    dns_qname: domain || evidence.dns_qname,
    destination: domain || evidence.destination,
    confidence: evidence.confidence || row?.confidence || "dns-interest",
  });
}

export function filterDnsInterestRows(rows, options = {}) {
  const includeService = Boolean(options.includeService);
  return (rows || []).filter((row) => includeService || dnsInterestTrafficClass(row) !== "service_background");
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
  const splitFor = (row) => {
    const bytes = byteValue(row);
    const viaVps = number(row?.via_vps_bytes);
    const direct = number(row?.direct_bytes);
    let unknown = number(row?.unknown_bytes);
    if (bytes > 0 && viaVps + direct + unknown === 0) unknown = bytes;
    return { viaVps, direct, unknown };
  };
  const vpsTotal = rows.reduce((sum, row) => sum + splitFor(row).viaVps, 0);
  const directTotal = rows.reduce((sum, row) => sum + splitFor(row).direct, 0);
  const unknownTotal = rows.reduce((sum, row) => {
    return sum + splitFor(row).unknown;
  }, 0);
  const unknownBudget = Math.max(0, observed - number(totals.vps) - number(totals.direct));
  const vpsScale = number(totals.vps) > 0 && vpsTotal > number(totals.vps) ? number(totals.vps) / vpsTotal : totalScale;
  const directScale = number(totals.direct) > 0 && directTotal > number(totals.direct) ? number(totals.direct) / directTotal : totalScale;
  const unknownScale = unknownTotal > 0 ? Math.min(totalScale, unknownBudget / unknownTotal) : totalScale;
  const reconciled = rows.map((row) => {
    const split = splitFor(row);
    const viaVps = Math.round(split.viaVps * vpsScale);
    const direct = Math.round(split.direct * directScale);
    const unknown = Math.round(split.unknown * unknownScale);
    const bytesValue = viaVps + direct + unknown;
    return {
      ...row,
      total_bytes: row?.total_bytes !== undefined ? bytesValue : row?.total_bytes,
      bytes: row?.bytes !== undefined ? bytesValue : row?.bytes,
      via_vps_bytes: row?.via_vps_bytes !== undefined ? viaVps : row?.via_vps_bytes,
      direct_bytes: row?.direct_bytes !== undefined ? direct : row?.direct_bytes,
      unknown_bytes: row?.unknown_bytes !== undefined ? unknown : row?.unknown_bytes,
      route: viaVps > 0 || direct > 0 ? routeFromCounters({ via_vps_bytes: viaVps, direct_bytes: direct }) : row?.route,
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
      let remaining = adjustment;
      if (row.unknown_bytes !== undefined) {
        const take = Math.min(number(row.unknown_bytes), remaining);
        row.unknown_bytes = number(row.unknown_bytes) - take;
        remaining -= take;
      }
      if (remaining > 0 && row.direct_bytes !== undefined) {
        const take = Math.min(number(row.direct_bytes), remaining);
        row.direct_bytes = number(row.direct_bytes) - take;
        remaining -= take;
      }
      if (remaining > 0 && row.via_vps_bytes !== undefined) {
        const take = Math.min(number(row.via_vps_bytes), remaining);
        row.via_vps_bytes = number(row.via_vps_bytes) - take;
      }
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
