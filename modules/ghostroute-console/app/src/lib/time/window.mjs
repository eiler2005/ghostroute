export const TZ = "Europe/Moscow";

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeClockHour(value) {
  const hour = number(value);
  return hour === 24 ? 0 : hour;
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function mskDateParts(value = new Date()) {
  const date = dateFrom(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: number(pick("year")),
    month: number(pick("month")),
    day: number(pick("day")),
    hour: normalizeClockHour(pick("hour")),
    minute: number(pick("minute")),
    second: number(pick("second")),
  };
}

function utcFromMskParts(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0) - MSK_OFFSET_MS);
}

function addMskDays(parts, days) {
  const date = utcFromMskParts({ ...parts, hour: 0, minute: 0, second: 0 });
  return mskDateParts(new Date(date.getTime() + days * 86400000));
}

function mskMonthStart(parts, monthOffset = 0) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1 + monthOffset, 1, 0, 0, 0) - MSK_OFFSET_MS);
  return mskDateParts(base);
}

function mskWeekStart(parts) {
  const midnightUtc = utcFromMskParts({ ...parts, hour: 0, minute: 0, second: 0 });
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return mskDateParts(new Date(midnightUtc.getTime() - mondayOffset * 86400000));
}

export function nowUtcIso() {
  return new Date().toISOString();
}

export function parseSourceTimestamp(raw) {
  if (!raw) return nowUtcIso();
  const text = String(raw).trim();
  if (!text) return nowUtcIso();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? nowUtcIso() : parsed.toISOString();
  }
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(`${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? nowUtcIso() : parsed.toISOString();
}

export function toMskKey(utcIso, granularity = "day") {
  const parts = mskDateParts(utcIso);
  if (granularity === "5min") {
    const minute = Math.floor(parts.minute / 5) * 5;
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(minute)}`;
  }
  if (granularity === "hour") {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}`;
  }
  if (granularity === "week") {
    const week = mskWeekStart(parts);
    return `${week.year}-${pad2(week.month)}-${pad2(week.day)}`;
  }
  if (granularity === "month") {
    return `${parts.year}-${pad2(parts.month)}`;
  }
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function toUtcIsoFromMskKey(mskKey, granularity = "day") {
  const value = String(mskKey || "");
  const match = value.match(/^(\d{4})-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?)?$/);
  if (!match) return nowUtcIso();
  const [, year, month, day = "1", hour = "0", minute = "0"] = match;
  const date = utcFromMskParts({
    year: number(year),
    month: number(month),
    day: number(day),
    hour: ["day", "week", "month"].includes(granularity) ? 0 : normalizeClockHour(hour),
    minute: granularity === "5min" ? Math.floor(number(minute) / 5) * 5 : 0,
    second: 0,
  });
  return date.toISOString();
}

export function bucketStartUtc(utcIso, granularity = "hour") {
  return toUtcIsoFromMskKey(toMskKey(utcIso, granularity), granularity);
}

export function mskWindowBounds(window = "today", nowValue = new Date()) {
  const now = dateFrom(nowValue);
  const current = mskDateParts(now);
  let startParts;
  if (window === "month") {
    startParts = mskMonthStart(current, 0);
  } else if (window === "week") {
    startParts = mskWeekStart(current);
  } else {
    startParts = current;
  }
  const startUtc = utcFromMskParts({ ...startParts, hour: 0, minute: 0, second: 0 }).toISOString();
  return {
    window: ["today", "week", "month"].includes(window) ? window : "today",
    startUtc,
    endUtc: now.toISOString(),
    startMskKey: toMskKey(startUtc, "day"),
    endMskKey: toMskKey(now.toISOString(), "day"),
  };
}

export function mskWindowLabel(window = "today", bounds = mskWindowBounds(window)) {
  if (window === "month") return `Month from ${bounds.startMskKey}`;
  if (window === "week") return `Week from ${bounds.startMskKey}`;
  return `Today from ${bounds.startMskKey}`;
}
