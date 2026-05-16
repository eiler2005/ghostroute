const CHANNELS = new Set(["A", "B", "C"]);
const POLICIES = new Set(["full_vps", "managed_split", "compatibility"]);
const STATUSES = new Set(["enabled", "disabled", "planned", "missing", "unknown"]);

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "enabled", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "disabled", "off"].includes(normalized)) return false;
  return fallback;
}

function safeStatus(value, fallback = "enabled") {
  const normalized = text(value, fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeChannel(value) {
  const normalized = text(value).toUpperCase().replace(/^CHANNEL\s+/, "");
  return CHANNELS.has(normalized) ? normalized : "A";
}

function normalizePolicy(value, channel) {
  const fallback = channel === "C" ? "compatibility" : "managed_split";
  const normalized = text(value, fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return POLICIES.has(normalized) ? normalized : fallback;
}

export function isRawNetworkLiteral(value) {
  const candidate = text(value);
  if (!candidate) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) return true;
  if (/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(candidate)) return true;
  if (/^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$/i.test(candidate)) return true;
  return false;
}

function token(value, prefix) {
  const candidate = text(value);
  if (!candidate) return "";
  if (isRawNetworkLiteral(candidate)) return `${prefix}-redacted`;
  const normalized = candidate.toLowerCase();
  if (new RegExp(`^${prefix}-[a-z0-9]{6,32}$`).test(normalized)) return normalized;
  if (["masked", "redacted", "configured"].includes(normalized)) return `${prefix}-${normalized}`;
  return `${prefix}-masked`;
}

function dnsStatus(row) {
  const explicit = text(row?.strict_dns_status || row?.dns_status).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["configured", "missing", "disabled", "unknown", "not_configured"].includes(explicit)) {
    return explicit === "not_configured" ? "missing" : explicit;
  }
  if (bool(row?.strict_dns_configured, false) || text(row?.strict_dns_resolver_ip)) return "configured";
  return "missing";
}

function rowNote(row) {
  return text(row?.note || row?.notes || row?.detail);
}

function normalizeHomeClient(row, index) {
  const fallback = `home-client-${index + 1}`;
  const name = text(row?.name || row?.id || row?.label, fallback);
  const status = safeStatus(row?.status, "enabled");
  const fullVps = bool(row?.full_vps, true);
  return {
    id: text(row?.id || name, fallback),
    name,
    label: text(row?.label || row?.display_name || name, name),
    selector: "reserved_source_ip",
    interface: text(row?.interface, "br0"),
    ip_token: token(row?.ip_token || row?.masked_ip || row?.ip_hash || row?.ip, "ip"),
    mac_token: token(row?.mac_token || row?.masked_mac || row?.mac_hash || row?.mac, "mac"),
    strict_dns_status: dnsStatus(row),
    status,
    profile_enabled: status === "enabled",
    full_vps: fullVps,
    route: fullVps ? "VPS" : "Direct",
    outbound: fullVps ? "reality-out" : "managed split",
    toggle_editable: false,
    note: rowNote(row),
  };
}

function normalizeChannelProfile(row, index) {
  const channel = normalizeChannel(row?.channel);
  const fallbackProfile = `channel-${channel.toLowerCase()}-profile-${index + 1}`;
  const profile = text(row?.profile || row?.name || row?.auth_user || row?.id, fallbackProfile);
  const profileType = text(
    row?.profile_type || row?.type,
    channel === "A" ? "home_reality" : channel === "B" ? "xhttp_home" : "naive_compatibility"
  );
  const status = safeStatus(row?.status, "enabled");
  const supported = channel === "A" ? bool(row?.full_vps_supported, true) : false;
  const requestedPolicy = normalizePolicy(row?.policy, channel);
  const requestedFullVps = bool(row?.full_vps, false) || requestedPolicy === "full_vps";
  const fullVps = supported && requestedFullVps;
  const policy = fullVps ? "full_vps" : channel === "C" ? "compatibility" : "managed_split";
  return {
    id: text(row?.id || `${channel}:${profile}`, `${channel}:${fallbackProfile}`),
    channel,
    profile,
    label: text(row?.label || row?.display_name || profile, profile),
    profile_type: profileType,
    status,
    profile_enabled: status === "enabled",
    policy,
    full_vps: fullVps,
    full_vps_supported: supported,
    route: fullVps ? "VPS" : "Mixed",
    outbound: fullVps ? "reality-out" : channel === "C" ? "compatibility lane" : "managed split",
    toggle_editable: false,
    note: rowNote(row),
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildSummary(homeClients, profiles) {
  const channelProfiles = (channel) => profiles.filter((row) => row.channel === channel);
  return {
    home_full_vps: homeClients.filter((row) => row.full_vps).length,
    channel_a_profiles: channelProfiles("A").length,
    channel_a_full_vps: channelProfiles("A").filter((row) => row.full_vps).length,
    channel_b_profiles: channelProfiles("B").length,
    channel_c_profiles: channelProfiles("C").length,
  };
}

export function emptyRoutingPolicySnapshot(meta = {}) {
  const generatedAt = text(meta.generated_at || meta.file_mtime || "");
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      command: "policy-snapshot.local",
      mode: "sanitized",
      path: text(meta.source_path || "policy-snapshot.local.json"),
    },
    confidence: "unknown",
    status: "missing",
    home_wifi_lan_full_vps: [],
    channel_profiles: [],
    summary: buildSummary([], []),
    warnings: normalizeArray(meta.warnings),
  };
}

export function normalizeRoutingPolicySnapshot(payload, meta = {}) {
  if (!payload || typeof payload !== "object") return emptyRoutingPolicySnapshot(meta);
  const homeClients = normalizeArray(payload.home_wifi_lan_full_vps).map(normalizeHomeClient);
  const profiles = normalizeArray(payload.channel_profiles).map(normalizeChannelProfile);
  const warnings = normalizeArray(payload.warnings).map((item) => text(item)).filter(Boolean);
  const generatedAt = text(payload.generated_at || meta.generated_at || meta.file_mtime || "");
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      command: text(payload.source?.command, "policy-snapshot.local"),
      mode: text(payload.source?.mode, "sanitized"),
      path: text(meta.source_path || payload.source?.path, "policy-snapshot.local.json"),
    },
    confidence: text(payload.confidence, "exact"),
    status: homeClients.length || profiles.length ? "configured" : "empty",
    home_wifi_lan_full_vps: homeClients,
    channel_profiles: profiles,
    summary: buildSummary(homeClients, profiles),
    warnings,
  };
}
