import { isPrimaryTrafficDestinationLabel, trafficDisplayDestination } from "./traffic-window.mjs";

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function rowBytes(row) {
  return firstPositiveNumber(row?.bytes, row?.total_bytes, row?.observed_bytes)
    || number(row?.via_vps_bytes || row?.reality_bytes)
      + number(row?.direct_bytes || row?.wan_bytes)
      + number(row?.unknown_bytes || row?.unresolved_bytes);
}

function hasNumber(value) {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
}

function firstNumber(...values) {
  for (const value of values) {
    if (hasNumber(value)) return number(value);
  }
  return 0;
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowEvidence(row) {
  return {
    ...parseObject(row?.raw),
    ...parseObject(row?.evidence),
    ...parseObject(row?.evidence_json),
  };
}

export function routeByteSplit(row) {
  const evidence = rowEvidence(row);
  let totalBytes = rowBytes(row);
  const explicitVps = hasNumber(row?.via_vps_bytes) || hasNumber(row?.reality_bytes)
    || hasNumber(evidence.via_vps_bytes) || hasNumber(evidence.reality_bytes);
  const explicitDirect = hasNumber(row?.direct_bytes) || hasNumber(row?.wan_bytes)
    || hasNumber(evidence.direct_bytes) || hasNumber(evidence.wan_bytes);
  const explicitUnknown = hasNumber(row?.unknown_bytes) || hasNumber(row?.unresolved_bytes)
    || hasNumber(evidence.unknown_bytes) || hasNumber(evidence.unresolved_bytes);
  let viaVpsBytes = firstNumber(row?.via_vps_bytes, row?.reality_bytes, evidence.via_vps_bytes, evidence.reality_bytes);
  let directBytes = firstNumber(row?.direct_bytes, row?.wan_bytes, evidence.direct_bytes, evidence.wan_bytes);
  let unknownBytes = firstNumber(row?.unknown_bytes, row?.unresolved_bytes, evidence.unknown_bytes, evidence.unresolved_bytes);
  if (totalBytes <= 0 && viaVpsBytes + directBytes + unknownBytes > 0) {
    totalBytes = viaVpsBytes + directBytes + unknownBytes;
  }

  if (!explicitVps && !explicitDirect && !explicitUnknown) {
    const route = text(row?.route, "Unknown").toLowerCase();
    if (route === "vps") viaVpsBytes = totalBytes;
    else if (route === "direct") directBytes = totalBytes;
    else unknownBytes = totalBytes;
  } else if (!explicitUnknown) {
    unknownBytes = Math.max(0, totalBytes - viaVpsBytes - directBytes);
  }

  let splitSum = viaVpsBytes + directBytes + unknownBytes;
  if (splitSum < totalBytes) {
    unknownBytes += totalBytes - splitSum;
    splitSum = totalBytes;
  }
  if (splitSum > totalBytes && unknownBytes > 0) {
    const overflow = Math.min(unknownBytes, splitSum - totalBytes);
    unknownBytes -= overflow;
  }

  return {
    totalBytes,
    viaVpsBytes,
    directBytes,
    unknownBytes,
  };
}

function rowTime(row) {
  return text(row?.last_seen || row?.event_ts || row?.first_seen || row?.collected_at);
}

function dateParts(value, now = new Date()) {
  const date = value ? new Date(value) : now;
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
  };
}

function dateKey(value, now = new Date()) {
  const parts = dateParts(value, now);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function monthKey(value, now = new Date()) {
  const parts = dateParts(value, now);
  return parts ? `${parts.year}-${parts.month}` : "";
}

function hourKey(value, now = new Date()) {
  const parts = dateParts(value, now);
  return parts ? `${parts.hour}:00` : "";
}

function addRouteBytes(target, row) {
  const split = routeByteSplit(row);
  target.totalBytes += split.totalBytes;
  target.viaVpsBytes += split.viaVpsBytes;
  target.directBytes += split.directBytes;
  target.unknownBytes += split.unknownBytes;
}

function dominantRoute(routes) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return "Mixed";
}

function routeFromSplit(row) {
  const split = routeByteSplit(row);
  const hasVps = split.viaVpsBytes > 0;
  const hasDirect = split.directBytes > 0;
  const hasUnknown = split.unknownBytes > 0;
  const count = [hasVps, hasDirect, hasUnknown].filter(Boolean).length;
  if (count > 1) return "Mixed";
  if (hasVps) return "VPS";
  if (hasDirect) return "Direct";
  if (hasUnknown) return "Unknown";
  return text(row?.route, "Unknown");
}

function destinationLabel(row) {
  return trafficDisplayDestination(row);
}

export function isMobileTrafficRow(row) {
  const haystack = [
    row?.channel,
    row?.client,
    row?.client_label,
    row?.client_key,
    row?.device_key,
    row?.device_type,
    row?.client_role,
    row?.raw_profile,
    row?.raw?.profile,
    row?.raw?.device_type,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\bc\s*\/|channel c|c\/mobile|mobile lte|shadowrocket|naive/.test(haystack)) return true;
  if (/\bb\s*\/|channel b|iphone-b|selected-client|xhttp|xray/.test(haystack)) return true;
  if (/mobile-client-\d+|mobile-source-\d+|iphone|ipad|private mac|unknown mobile/.test(haystack)) return true;
  return haystack.includes("a/home reality") && /mobile|iphone|ipad/.test(haystack);
}

function rowsForPeriod(rows, period, now) {
  const today = dateKey("", now);
  const currentMonth = monthKey("", now);
  const nowTs = now.getTime();
  return rows.filter((row) => {
    const ts = rowTime(row);
    if (!ts) return false;
    if (period === "month") return monthKey(ts, now) === currentMonth;
    if (period === "week") {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) && parsed >= nowTs - 7 * 24 * 60 * 60 * 1000 && parsed <= nowTs + 60 * 1000;
    }
    if (period === "yesterday") {
      const yesterday = new Date(nowTs - 24 * 60 * 60 * 1000);
      return dateKey(ts, now) === dateKey("", yesterday);
    }
    return dateKey(ts, now) === today;
  });
}

function trafficToday(rows, now) {
  const today = dateKey("", now);
  const byHour = new Map();
  for (let hour = 0; hour < 24; hour += 1) {
    const label = `${String(hour).padStart(2, "0")}:00`;
    byHour.set(label, { hour: label, totalBytes: 0, viaVpsBytes: 0, directBytes: 0, unknownBytes: 0 });
  }
  for (const row of rows) {
    const ts = rowTime(row);
    if (!ts || dateKey(ts, now) !== today) continue;
    const key = hourKey(ts, now);
    const point = byHour.get(key);
    if (!point) continue;
    addRouteBytes(point, row);
  }
  return Array.from(byHour.values());
}

function topClients(rows, limit = 5) {
  const grouped = new Map();
  for (const row of rows) {
    const label = text(row.client_label || row.client || row.client_ip || row.device_key, "Unknown client");
    const key = text(row.client_key || row.device_key || label).toLowerCase();
    const current = grouped.get(key) || {
      key,
      label,
      channel: text(row.channel, "Unknown"),
      bytes: 0,
      viaVpsBytes: 0,
      directBytes: 0,
      unknownBytes: 0,
      routes: new Set(),
      risks: new Set(),
    };
    const split = routeByteSplit(row);
    current.bytes += split.totalBytes;
    current.viaVpsBytes += split.viaVpsBytes;
    current.directBytes += split.directBytes;
    current.unknownBytes += split.unknownBytes;
    current.routes.add(routeFromSplit(row));
    if (row.risk) current.risks.add(text(row.risk));
    if (label.length > current.label.length && !label.toLowerCase().includes("unknown")) current.label = label;
    if (row.channel && current.channel === "Unknown") current.channel = row.channel;
    grouped.set(key, current);
  }
  const total = Array.from(grouped.values()).reduce((sum, row) => sum + row.bytes, 0) || 1;
  return Array.from(grouped.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((row, idx) => ({
      rank: idx + 1,
      key: row.key,
      label: row.label,
      channel: row.channel,
      bytes: row.bytes,
      viaVpsBytes: row.viaVpsBytes,
      directBytes: row.directBytes,
      unknownBytes: row.unknownBytes,
      sharePct: Math.round((row.bytes / total) * 100),
      route: dominantRoute(row.routes),
      status: row.risks.has("high") ? "Review" : "OK",
    }));
}

function topDestinations(rows, limit = 5) {
  const grouped = new Map();
  for (const row of rows) {
    const label = destinationLabel(row);
    if (!isPrimaryTrafficDestinationLabel(label)) continue;
    const key = label.toLowerCase();
    const current = grouped.get(key) || {
      key,
      label,
      bytes: 0,
      viaVpsBytes: 0,
      directBytes: 0,
      unknownBytes: 0,
      routes: new Set(),
      clients: new Set(),
    };
    const split = routeByteSplit(row);
    current.bytes += split.totalBytes;
    current.viaVpsBytes += split.viaVpsBytes;
    current.directBytes += split.directBytes;
    current.unknownBytes += split.unknownBytes;
    current.routes.add(routeFromSplit(row));
    if (row.client) current.clients.add(text(row.client));
    grouped.set(key, current);
  }
  const total = Array.from(grouped.values()).reduce((sum, row) => sum + row.bytes, 0) || 1;
  return Array.from(grouped.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((row, idx) => ({
      rank: idx + 1,
      key: row.key,
      label: row.label,
      route: dominantRoute(row.routes),
      bytes: row.bytes,
      viaVpsBytes: row.viaVpsBytes,
      directBytes: row.directBytes,
      unknownBytes: row.unknownBytes,
      sharePct: Math.round((row.bytes / total) * 100),
      detail: `${row.clients.size} client${row.clients.size === 1 ? "" : "s"}`,
    }));
}

function quotaBytes(bytesValue, gbValue) {
  const rawBytes = number(bytesValue);
  if (rawBytes > 0) return rawBytes;
  const rawGb = number(gbValue);
  return rawGb > 0 ? rawGb * 1024 ** 3 : 0;
}

function resetDate(now, resetDay) {
  const day = Math.max(1, Math.min(31, number(resetDay) || 1));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const candidate = new Date(Date.UTC(year, month, day, 0, 0, 0));
  if (candidate.getTime() <= now.getTime()) return new Date(Date.UTC(year, month + 1, day, 0, 0, 0)).toISOString();
  return candidate.toISOString();
}

function monthDayKeys(now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: days }, (_, idx) => {
    const date = new Date(Date.UTC(year, month, idx + 1, 12, 0, 0));
    return date.toISOString().slice(0, 10);
  });
}

function trafficUsage(rows, now) {
  const byDay = new Map(monthDayKeys(now).map((day) => [day, { day, vpsBytes: 0, lteBytes: 0 }]));
  const currentMonth = monthKey("", now);
  for (const row of rows) {
    const ts = rowTime(row);
    if (!ts || monthKey(ts, now) !== currentMonth) continue;
    const key = dateKey(ts, now);
    const point = byDay.get(key);
    if (!point) continue;
    const split = routeByteSplit(row);
    if (split.viaVpsBytes > 0) point.vpsBytes += split.viaVpsBytes;
    if (isMobileTrafficRow(row)) point.lteBytes += split.totalBytes;
  }
  const today = dateKey("", now);
  const ordered = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  let cumulativeVps = 0;
  let cumulativeLte = 0;
  const actual = ordered.map((point) => {
    if (point.day <= today) {
      cumulativeVps += point.vpsBytes;
      cumulativeLte += point.lteBytes;
    }
    return {
      day: point.day,
      label: point.day.slice(5),
      vpsBytes: cumulativeVps,
      lteBytes: cumulativeLte,
      vpsForecastBytes: point.day <= today ? cumulativeVps : 0,
      forecast: point.day > today,
    };
  });
  const last7 = ordered.filter((point) => point.day <= today).slice(-7);
  const avgDailyVps = last7.length ? last7.reduce((sum, point) => sum + point.vpsBytes, 0) / last7.length : 0;
  let forecast = cumulativeVps;
  return actual.map((point) => {
    if (!point.forecast) return point;
    forecast += avgDailyVps;
    return { ...point, vpsForecastBytes: Math.round(forecast) };
  });
}

export function buildDashboardAnalyticsFromRows(rows, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const period = options.period || "today";
  const cleanRows = (rows || []).filter((row) => rowBytes(row) > 0);
  const periodRows = rowsForPeriod(cleanRows, period, now);
  const todayPoints = trafficToday(cleanRows, now);
  const usagePoints = trafficUsage(cleanRows, now);
  const usedVps = usagePoints.findLast?.((point) => !point.forecast)?.vpsBytes || usagePoints.reduce((max, point) => Math.max(max, point.vpsBytes), 0);
  const usedLte = usagePoints.findLast?.((point) => !point.forecast)?.lteBytes || usagePoints.reduce((max, point) => Math.max(max, point.lteBytes), 0);
  const vpsQuotaBytes = quotaBytes(options.vpsQuotaBytes, options.vpsQuotaGb);
  const lteQuotaBytes = quotaBytes(options.lteQuotaBytes, options.lteQuotaGb);
  const reset = resetDate(now, options.resetDay);

  const quota = (usedBytes, configuredBytes) => ({
    usedBytes,
    quotaBytes: configuredBytes,
    remainingBytes: configuredBytes > 0 ? Math.max(0, configuredBytes - usedBytes) : 0,
    pct: configuredBytes > 0 ? Math.min(999, Math.round((usedBytes / configuredBytes) * 100)) : 0,
    resetDate: reset,
  });

  return {
    trafficToday: {
      points: todayPoints,
      totalBytes: todayPoints.reduce((sum, point) => sum + point.totalBytes, 0),
    },
    topClients: topClients(periodRows),
    topDestinations: topDestinations(periodRows),
    quota: {
      vps: quota(usedVps, vpsQuotaBytes),
      lte: quota(usedLte, lteQuotaBytes),
    },
    usage: {
      points: usagePoints,
      note: "Forecast is based on average daily VPS usage over the last 7 observed days.",
    },
  };
}
