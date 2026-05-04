import fs from "node:fs";
import path from "node:path";

const ATTRIBUTION_FILENAMES = ["device-attribution.json", "device-aliases.json"];

let cachedDir = "";
let cachedMtime = "";
let cachedRegistry = { clients: {}, devices: {}, aliases: {}, networkAliases: {}, sourcePath: "" };

const PSEUDO_KEY_RE = /\b(mobile-client-\d+|mobile-source-\d+|lan-host-\d+|iphone-b-\d+|iphone-\d+|c1[_-]?iphone[_-]?\d+|\d+-sr)\b/i;
const REPORT_ALIAS_RE = /^mobile-client-\d+$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

function consoleDataDir() {
  if (process.env.GHOSTROUTE_CONSOLE_DATA_DIR) return path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR);
  if (process.env.NODE_ENV === "production") return "/data";
  return path.resolve(process.cwd(), "..", "data");
}

function clean(value) {
  return String(value || "").trim();
}

function literalKey(value) {
  return clean(value).toLowerCase();
}

function isReportAlias(value) {
  return REPORT_ALIAS_RE.test(literalKey(value));
}

function normalizedMac(value) {
  const text = literalKey(value).replace(/-/g, ":");
  return MAC_RE.test(text) ? text : "";
}

export function canonicalDeviceKey(value) {
  if (value && typeof value === "object") {
    for (const field of [value.client_key, value.device_key, value.device_id, value.id, value.profile]) {
      const literal = literalKey(field);
      if (!literal || literal === "unknown" || literal === "unknown-device") continue;
      const pseudo = literal.match(PSEUDO_KEY_RE);
      if (pseudo) return pseudo[1].replace(/-/g, "-").toLowerCase();
      if (!literal.includes(" ") && !literal.includes("(") && !literal.includes(")") && !IP_RE.test(literal)) return literal;
    }
  }
  const text = typeof value === "string"
    ? value
    : [value?.label, value?.client, value?.raw_client, value?.ip, value?.client_ip].filter(Boolean).join(" ");
  const match = literalKey(text).match(PSEUDO_KEY_RE);
  return match ? match[1].toLowerCase() : "";
}

function suffixFor(value) {
  const match = clean(value).match(/\s*\/\s*([BC]\d?)\b/i);
  return match ? ` / ${match[1].toUpperCase()}` : "";
}

function fallbackLabelFor(key, text = "") {
  if (!key) return text || "Unknown device";
  if (/\([^)]{2,}\)/.test(text) && !/unknown/i.test(text)) return text;
  if (key.startsWith("lan-host-")) return `${key} (Unknown device)`;
  if (key.startsWith("mobile-client-")) return `${key} (Unknown Home Reality profile)${suffixFor(text)}`;
  if (key.startsWith("mobile-source-")) return `${key} (Unattributed source)`;
  if (key.startsWith("iphone-b-")) return `${key} (Channel B profile)`;
  if (key.startsWith("iphone-")) return `${key} (Home Reality profile)`;
  if (key.includes("c1") || key.endsWith("-sr")) return `${key} (Channel C profile)`;
  return text || `${key} (Unknown device)`;
}

function normalizeAliasList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) => normalizeAliasList(entry));
  }
  return [clean(value)].filter(Boolean);
}

function normalizeEntry(key, value) {
  if (!value) return null;
  if (typeof value === "string") return { client_key: key, label: `${key} (${value})` };
  if (typeof value !== "object") return null;
  const clientKey = clean(value.client_key || key).toLowerCase();
  const deviceKey = clean(value.device_key || value.physical_device_key || value.inventory_key || clientKey).toLowerCase();
  const owner = clean(value.owner || value.name || value.display_name);
  const kind = clean(value.kind || value.profile_type || value.device_type);
  const label = clean(value.label || value.display_name) || (owner ? `${key} (${owner})` : kind ? `${key} (${kind})` : fallbackLabelFor(key));
  const deviceLabel = clean(value.device_label || value.physical_device_label || value.inventory_label) || label;
  const aliases = normalizeAliasList(value.aliases);
  const observedIds = normalizeAliasList(value.observed_ids || value.observedIds);
  const macAliases = normalizeAliasList(value.mac_aliases || value.macs || value.mac || value.mac_address);
  const ipAliases = normalizeAliasList(value.ip_aliases || value.ips || value.ip || value.client_ip);
  return {
    client_key: clientKey,
    device_key: deviceKey,
    device_label: deviceLabel,
    label,
    display_name: clean(value.display_name || value.name || label),
    role: clean(value.role || kind || ""),
    owner,
    device_type: clean(value.device_type || kind || ""),
    profile_type: kind,
    primary_channel: clean(value.primary_channel || value.channel || ""),
    channel: clean(value.channel || value.primary_channel || ""),
    confidence: clean(value.confidence || ""),
    aliases: Array.from(new Set([...aliases, ...observedIds])),
    mac_aliases: macAliases,
    ip_aliases: ipAliases,
  };
}

function addAlias(registry, alias, key, network = false) {
  const text = literalKey(alias);
  if (!text || !key) return;
  registry.aliases[text] = key;
  const canonical = canonicalDeviceKey(text);
  if (canonical) registry.aliases[canonical] = key;
  const mac = normalizedMac(text);
  if (network || IP_RE.test(text) || mac) {
    registry.networkAliases[mac || text] = key;
  }
}

function addClient(registry, rawKey, rawValue) {
  const key = canonicalDeviceKey(rawKey) || literalKey(rawKey);
  const entry = normalizeEntry(key, rawValue);
  if (!key || !entry) return;
  const clientKey = entry.client_key || key;
  registry.clients[clientKey] = entry;
  registry.devices[clientKey] = entry;
  for (const alias of [
    rawKey,
    key,
    clientKey,
    entry.label,
    entry.display_name,
    entry.owner,
    ...(entry.aliases || []),
  ]) {
    addAlias(registry, alias, clientKey, false);
  }
  for (const alias of [...(entry.mac_aliases || []), ...(entry.ip_aliases || [])]) {
    addAlias(registry, alias, clientKey, true);
  }
}

export function loadDeviceAttributions(dataDir = consoleDataDir()) {
  const files = ATTRIBUTION_FILENAMES.map((name) => path.join(dataDir, name));
  const existing = files.find((file) => fs.existsSync(file));
  const mtime = existing ? String(fs.statSync(existing).mtimeMs) : "missing";
  if (cachedDir === dataDir && cachedMtime === mtime) return cachedRegistry;
  cachedDir = dataDir;
  cachedMtime = mtime;
  const registry = { clients: {}, devices: {}, aliases: {}, networkAliases: {}, sourcePath: existing || "" };
  if (!existing) {
    cachedRegistry = registry;
    return cachedRegistry;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(existing, "utf8"));
    if (parsed.clients && typeof parsed.clients === "object") {
      for (const [rawKey, rawValue] of Object.entries(parsed.clients)) addClient(registry, rawKey, rawValue);
    }
    const rawDevices = parsed.devices && typeof parsed.devices === "object"
      ? parsed.devices
      : parsed.clients ? {} : parsed;
    for (const [rawKey, rawValue] of Object.entries(rawDevices || {})) {
      if (rawKey === "schema_version" || rawKey === "updated_at" || rawKey === "notes" || rawKey === "clients") continue;
      const key = canonicalDeviceKey(rawKey) || literalKey(rawKey);
      if (registry.clients[key]) continue;
      addClient(registry, rawKey, rawValue);
    }
    cachedRegistry = registry;
  } catch {
    cachedRegistry = { clients: {}, devices: {}, aliases: {}, networkAliases: {}, sourcePath: existing || "" };
  }
  return cachedRegistry;
}

function candidateValues(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const raw = value.raw || {};
  const stableCandidates = [
    value.profile,
    raw.profile,
    raw.client_key,
    raw.device_key,
    raw.device_id,
    value.client_key,
    value.device_key,
    value.device_id,
    value.id,
  ].filter(Boolean).map(String).filter((candidate) => !isReportAlias(candidate));
  const observedCandidates = [
    raw.id,
    raw.client,
    raw.label,
    value.client,
    value.raw_client,
    value.label,
    value.name,
    ...(value.aliases || []),
    ...(value.observed_aliases || []),
  ].filter(Boolean).map(String);
  const ordered = [...stableCandidates, ...observedCandidates.filter((candidate) => !isReportAlias(candidate)), ...observedCandidates.filter(isReportAlias)];
  return Array.from(new Set(ordered));
}

function networkCandidateValues(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const raw = value.raw || {};
  return [
    value.mac,
    value.mac_address,
    value.ip,
    value.client_ip,
    value.source_ip,
    raw.mac,
    raw.mac_address,
    raw.ip,
    raw.client_ip,
    raw.source_ip,
  ].filter(Boolean).map(String);
}

function fallbackResolution(value) {
  const key = canonicalDeviceKey(value);
  const text = clean(typeof value === "string" ? value : value?.label || value?.client || value?.profile || value?.id || value?.device_id || "Unknown");
  const label = fallbackLabelFor(key, text);
  const role = key.startsWith("mobile-source-") ? "Unattributed mobile ingress source" : "";
  return {
    client_key: key,
    client_label: label,
    device_key: key,
    device_label: label,
    client_role: role,
    client_owner: "",
    device_type: "",
    client_channel: "",
    matched_by: key ? "observed_alias" : "unmatched",
    attribution_confidence: key.startsWith("mobile-source-") ? "unattributed" : "inferred",
    observed_aliases: Array.from(new Set([text, key].filter(Boolean))),
  };
}

export function resolveClient(value, registry = loadDeviceAttributions()) {
  for (const candidate of candidateValues(value)) {
    const literal = literalKey(candidate);
    const canonical = canonicalDeviceKey(candidate);
    const key = registry.aliases[literal] || registry.aliases[canonical] || "";
    if (!key || !registry.clients[key]) continue;
    const entry = registry.clients[key];
    return {
      client_key: key,
      client_label: entry.label,
      device_key: entry.device_key || key,
      device_label: entry.device_label || entry.label,
      client_role: entry.role,
      client_owner: entry.owner,
      device_type: entry.device_type || entry.profile_type,
      client_channel: entry.primary_channel || entry.channel,
      matched_by: canonical && registry.aliases[canonical] === key ? "exact_observed_id" : "exact_alias",
      attribution_confidence: entry.confidence || "operator-local",
      observed_aliases: Array.from(new Set([candidate, canonical].filter(Boolean).map(String))).slice(0, 16),
    };
  }
  for (const candidate of networkCandidateValues(value)) {
    const literal = normalizedMac(candidate) || literalKey(candidate);
    const key = registry.networkAliases[literal] || "";
    if (!key || !registry.clients[key]) continue;
    const entry = registry.clients[key];
    return {
      client_key: key,
      client_label: entry.label,
      device_key: entry.device_key || key,
      device_label: entry.device_label || entry.label,
      client_role: entry.role,
      client_owner: entry.owner,
      device_type: entry.device_type || entry.profile_type,
      client_channel: entry.primary_channel || entry.channel,
      matched_by: IP_RE.test(literal) ? "explicit_ip_alias" : "explicit_mac_alias",
      attribution_confidence: entry.confidence || "operator-local",
      observed_aliases: Array.from(new Set([candidate].filter(Boolean).map(String))).slice(0, 16),
    };
  }
  return fallbackResolution(value);
}

export function deviceAttributionFor(value, registry = loadDeviceAttributions()) {
  const resolved = resolveClient(value, registry);
  if (!resolved.client_key || !registry.clients[resolved.client_key]) return null;
  const entry = registry.clients[resolved.client_key];
  return { key: resolved.client_key, ...entry };
}

export function displayDeviceLabel(value, registry = loadDeviceAttributions()) {
  const resolved = resolveClient(value, registry);
  const text = clean(typeof value === "string" ? value : value?.label || value?.client || value?.profile || value?.id || value?.device_id || "Unknown");
  if (resolved.client_label) {
    const suffix = suffixFor(text);
    return suffix && !resolved.client_label.toLowerCase().includes(suffix.trim().toLowerCase())
      ? `${resolved.client_label}${suffix}`
      : resolved.client_label;
  }
  return fallbackLabelFor(resolved.client_key, text);
}

export function applyDeviceAttribution(row, registry = loadDeviceAttributions()) {
  const resolved = resolveClient(row, registry);
  const key = resolved.client_key || canonicalDeviceKey(row);
  const deviceKey = resolved.device_key || key;
  const originalLabel = clean(row?.label || row?.client || row?.profile || row?.id || row?.device_id || "");
  const raw = row?.raw || {};
  const aliases = new Set([...(row?.aliases || []), originalLabel, row?.id, row?.device_id, row?.profile, raw.profile, row?.client, raw.client, key, ...(resolved.observed_aliases || [])].filter(Boolean).map(String));
  return {
    ...row,
    id: deviceKey || row?.id || key || row?.device_id || row?.label,
    device_key: deviceKey || row?.device_key || "",
    physical_device_key: deviceKey || row?.physical_device_key || "",
    device_label: resolved.device_label || row?.device_label || resolved.client_label,
    client_key: resolved.client_key || key || "",
    client_label: resolved.client_label,
    label: resolved.device_label || resolved.client_label || displayDeviceLabel(row, registry),
    role: resolved.client_role || row?.role,
    client_role: resolved.client_role || row?.role,
    owner: resolved.client_owner || row?.owner || "",
    device_type: resolved.device_type || row?.device_type || "",
    channel: resolved.client_channel || row?.channel,
    client_channel: resolved.client_channel || row?.channel,
    matched_by: resolved.matched_by,
    attribution_confidence: resolved.attribution_confidence || row?.attribution_confidence || "inferred",
    aliases: Array.from(aliases).slice(0, 16),
    observed_aliases: Array.from(new Set([...(row?.observed_aliases || []), originalLabel, row?.client, raw.client, row?.profile, raw.profile, row?.label, row?.device_id].filter(Boolean).map(String))).slice(0, 16),
  };
}

export function clientRegistrySummary(registry = loadDeviceAttributions()) {
  const unmatchedReason = "no profile id, no explicit registry alias, or source-only counter";
  return {
    clients: Object.keys(registry.clients || {}).length,
    aliases: Object.keys(registry.aliases || {}).length,
    networkAliases: Object.keys(registry.networkAliases || {}).length,
    sourcePath: registry.sourcePath || "",
    unmatchedReason,
  };
}
