const ROUTE_ORDER = ["VPS", "Direct", "Mixed", "Unknown"];

function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowBytes(row) {
  return number(row?.bytes || row?.total_bytes);
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

function addRouteBytes(target, route, bytes) {
  target.totalBytes += bytes;
  if (route === "VPS") target.viaVpsBytes += bytes;
  else if (route === "Direct") target.directBytes += bytes;
  else target.unknownBytes += bytes;
}

function routeRank(value) {
  const idx = ROUTE_ORDER.indexOf(value);
  return idx >= 0 ? idx : ROUTE_ORDER.length;
}

function dominantRoute(routes) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return clean.sort((a, b) => routeRank(a) - routeRank(b))[0] || "Mixed";
}

function destinationLabel(row) {
  return text(row?.destination || row?.dns_qname || row?.sni || row?.destination_ip, "unknown destination");
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
    addRouteBytes(point, text(row.route, "Unknown"), rowBytes(row));
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
      routes: new Set(),
      risks: new Set(),
    };
    current.bytes += rowBytes(row);
    current.routes.add(text(row.route, "Unknown"));
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
      sharePct: Math.round((row.bytes / total) * 100),
      route: dominantRoute(row.routes),
      status: row.risks.has("high") ? "Review" : "OK",
    }));
}

function topDestinations(rows, limit = 5) {
  const grouped = new Map();
  for (const row of rows) {
    const label = destinationLabel(row);
    if (!label || label === "unknown destination") continue;
    const key = label.toLowerCase();
    const current = grouped.get(key) || { key, label, bytes: 0, routes: new Set(), clients: new Set() };
    current.bytes += rowBytes(row);
    current.routes.add(text(row.route, "Unknown"));
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
    const bytes = rowBytes(row);
    if (row.route === "VPS") point.vpsBytes += bytes;
    if (isMobileTrafficRow(row)) point.lteBytes += bytes;
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
