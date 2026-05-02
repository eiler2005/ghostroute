import fs from "node:fs";
import path from "node:path";

const ATTRIBUTION_FILENAMES = ["device-attribution.json", "device-aliases.json"];

let cachedDir = "";
let cachedMtime = "";
let cachedRegistry = { devices: {}, aliases: {} };

function consoleDataDir() {
  if (process.env.GHOSTROUTE_CONSOLE_DATA_DIR) return path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR);
  if (process.env.NODE_ENV === "production") return "/data";
  return path.resolve(process.cwd(), "..", "data");
}

export function canonicalDeviceKey(value) {
  const text = typeof value === "string"
    ? value
    : [value?.device_id, value?.id, value?.label, value?.client, value?.profile, value?.ip, value?.client_ip].filter(Boolean).join(" ");
  const match = String(text || "").toLowerCase().match(/\b(mobile-client-\d+|mobile-source-\d+|lan-host-\d+|iphone-b-\d+)\b/);
  return match ? match[1] : "";
}

function suffixFor(value) {
  const text = String(value || "");
  const match = text.match(/\s*\/\s*([BC]\d?)\b/i);
  return match ? ` / ${match[1].toUpperCase()}` : "";
}

function normalizeEntry(key, value) {
  if (!value) return null;
  if (typeof value === "string") return { label: `${key} (${value})` };
  if (typeof value !== "object") return null;
  const owner = String(value.owner || value.name || "").trim();
  const kind = String(value.kind || "").trim();
  const label = String(value.label || "").trim() || (owner ? `${key} (${owner})` : kind ? `${key} (${kind})` : "");
  return {
    label,
    role: String(value.role || kind || "").trim(),
    kind,
    owner,
    channel: String(value.channel || "").trim(),
    confidence: String(value.confidence || "").trim(),
    aliases: Array.isArray(value.aliases) ? value.aliases.map(String).filter(Boolean) : [],
  };
}

export function loadDeviceAttributions(dataDir = consoleDataDir()) {
  const files = ATTRIBUTION_FILENAMES.map((name) => path.join(dataDir, name));
  const existing = files.find((file) => fs.existsSync(file));
  const mtime = existing ? String(fs.statSync(existing).mtimeMs) : "missing";
  if (cachedDir === dataDir && cachedMtime === mtime) return cachedRegistry;
  cachedDir = dataDir;
  cachedMtime = mtime;
  cachedRegistry = { devices: {}, aliases: {} };
  if (!existing) return cachedRegistry;
  try {
    const parsed = JSON.parse(fs.readFileSync(existing, "utf8"));
    const rawDevices = parsed.devices && typeof parsed.devices === "object" ? parsed.devices : parsed;
    const devices = {};
    const aliases = {};
    for (const [rawKey, rawValue] of Object.entries(rawDevices || {})) {
      if (rawKey === "schema_version" || rawKey === "updated_at" || rawKey === "notes") continue;
      const key = canonicalDeviceKey(rawKey) || String(rawKey).toLowerCase();
      const entry = normalizeEntry(key, rawValue);
      if (!key || !entry) continue;
      devices[key] = entry;
      for (const alias of [rawKey, entry.label, ...(entry.aliases || [])]) {
        const aliasKey = canonicalDeviceKey(alias) || String(alias || "").toLowerCase();
        if (aliasKey) aliases[aliasKey] = key;
        const literal = String(alias || "").toLowerCase();
        if (literal) aliases[literal] = key;
      }
    }
    cachedRegistry = { devices, aliases };
  } catch {
    cachedRegistry = { devices: {}, aliases: {} };
  }
  return cachedRegistry;
}

export function deviceAttributionFor(value, registry = loadDeviceAttributions()) {
  const rawKey = canonicalDeviceKey(value);
  const literal = String(typeof value === "string" ? value : value?.label || value?.client || value?.id || "").toLowerCase();
  const key = registry.aliases[rawKey] || registry.aliases[literal] || rawKey;
  if (!key) return null;
  const entry = registry.devices[key];
  return entry ? { key, ...entry } : null;
}

export function displayDeviceLabel(value, registry = loadDeviceAttributions()) {
  const text = String(typeof value === "string" ? value : value?.label || value?.client || value?.id || value?.device_id || "Unknown").trim();
  const key = canonicalDeviceKey(value || text);
  const attribution = deviceAttributionFor(value || text, registry);
  if (attribution?.label) {
    const suffix = suffixFor(text);
    return suffix && !attribution.label.toLowerCase().includes(suffix.trim().toLowerCase())
      ? `${attribution.label}${suffix}`
      : attribution.label;
  }
  if (!key) return text || "Unknown device";
  if (/\([^)]{2,}\)/.test(text) && !/unknown/i.test(text)) return text;
  if (key.startsWith("lan-host-")) return `${key} (Unknown device)`;
  if (key.startsWith("mobile-client-")) return `${key} (Unknown Home Reality profile)${suffixFor(text)}`;
  if (key.startsWith("mobile-source-")) return `${key} (Unattributed source)`;
  return text || `${key} (Unknown device)`;
}

export function applyDeviceAttribution(row, registry = loadDeviceAttributions()) {
  const key = canonicalDeviceKey(row);
  const attribution = deviceAttributionFor(row, registry);
  const originalLabel = String(row?.label || row?.client || row?.id || row?.device_id || "").trim();
  const label = displayDeviceLabel(row, registry);
  const aliases = new Set([...(row?.aliases || []), originalLabel, row?.id, row?.device_id, row?.client, key, ...(attribution?.aliases || [])].filter(Boolean).map(String));
  return {
    ...row,
    id: row?.id || key || row?.device_id || row?.label,
    device_key: key || row?.device_key || "",
    label,
    role: attribution?.role || row?.role,
    channel: attribution?.channel || row?.channel,
    attribution_confidence: attribution?.confidence || (attribution ? "operator-local" : row?.attribution_confidence || "inferred"),
    aliases: Array.from(aliases).slice(0, 12),
  };
}
