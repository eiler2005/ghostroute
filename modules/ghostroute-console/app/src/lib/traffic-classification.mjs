import { destinationClassification, isDnsOnlyTraffic, trafficClassForDomain, trafficDomainLabel } from "./domain-attribution.mjs";

export const trafficClasses = ["client", "personal_cloud", "service_background", "unclassified", "all"];

export const trafficClassLabels = {
  client: "Client",
  personal_cloud: "Personal cloud",
  service_background: "Service/background",
  unclassified: "Needs attribution",
  all: "All traffic",
};

export function trafficClassFor(row) {
  return trafficClassForDomain(row);
}

export function trafficIntelligenceFor(row) {
  return destinationClassification(row);
}

export function trafficClassLabel(value) {
  return trafficClassLabels[String(value || "client")] || String(value || "client");
}

export function displayDestination(row) {
  const destination = trafficDomainLabel(row);
  if (!destination) return "n/a";
  const lower = destination.toLowerCase();
  if (lower === "other/ip") return "IP-only / no DNS match";
  if (lower.startsWith("unknown/unattributed")) return destination;
  if (lower === "other") {
    if (isDnsOnlyTraffic(row)) return "DNS-only interest";
    if (trafficDomainLabel({ destination: row.destination_ip })) return "IP-only / no DNS match";
    return "Unclassified domain";
  }
  return destination;
}

export function deviceRole(row) {
  const text = [row.label, row.id, row.device_id, row.profile, row.client, row.channel].filter(Boolean).join(" ").toLowerCase();
  if (/mobile-client-\d+/.test(text)) return "Home Reality profile";
  if (/mobile-source-\d+/.test(text)) return "Unattributed mobile ingress source";
  if (text.includes("channel c") || /\bc1\b|shadowrocket|naive/.test(text)) return "Channel C profile";
  if (text.includes("channel b") || /iphone-b|xhttp|selected-client/.test(text)) return "Channel B profile";
  if (text.includes("ipad")) return "iPad";
  if (text.includes("iphone")) return "iPhone";
  if (text.includes("macbook") || text.includes("mac book")) return "MacBook";
  if (text.includes("apple tv")) return "Apple TV";
  if (text.includes("windows laptop")) return "Windows laptop";
  if (text.includes("windows pc")) return "Windows PC";
  if (text.includes("private mac") || text.includes("unknown mobile")) return "Private MAC mobile device";
  if (/^lan-host-\d+/.test(text) || text.includes("home wi-fi/lan")) return "Home LAN device";
  return "Unknown device";
}

function isIpLiteral(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

function observedBytes(row) {
  const parsed = Number(row?.total_bytes || row?.bytes || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deviceReviewState(row = {}) {
  const total = observedBytes(row);
  const registryKnown = row.registry_registered === true
    || row.client_attributed === true
    || row.attribution_confidence === "operator-local"
    || row.source === "registry";
  const label = String(row.label || row.client_label || row.device_label || row.id || row.client_key || "");
  if (registryKnown) {
    return {
      review_state: "registry_known",
      review_reason: "operator registry or trusted current-window identity",
      suggested_action: "keep_diagnostic",
      current_window_active: Boolean(row.traffic_window_active || total > 0),
    };
  }
  const identity = [
    row.label,
    row.client_label,
    row.device_label,
    row.id,
    row.client_key,
    row.device_key,
    row.client,
  ].filter(Boolean).join(" ").toLowerCase();
  const mobileSource = /\bmobile-source-\d+\b/.test(identity);
  const pseudoLanHost = /\blan-host-\d+\b/.test(identity);
  const rawIp = isIpLiteral(label) || isIpLiteral(row.client_key) || isIpLiteral(row.client_label) || isIpLiteral(row.device_label) || isIpLiteral(row.ip) || isIpLiteral(row.client_ip);
  const currentWindowActive = Boolean(row.traffic_window_active || total > 0);
  const serviceSource = row.traffic_class === "service_background"
    || row.traffic_lane === "service_system"
    || String(row.role || row.device_type || "").toLowerCase().includes("service");

  let review_state = "registry_known";
  let review_reason = "operator registry or trusted current-window identity";
  let suggested_action = "keep_diagnostic";
  if (mobileSource) {
    review_state = "active_unattributed";
    review_reason = "unattributed mobile ingress source; map it to a known profile/device or keep as diagnostic";
    suggested_action = currentWindowActive ? "add_registry_alias" : "hide_stale";
  } else if (pseudoLanHost && !currentWindowActive) {
    review_state = "stale_historical";
    review_reason = "old pseudo LAN host without selected-window traffic or registry backing";
    suggested_action = "hide_stale";
  } else if (rawIp) {
    review_state = "raw_ip_source";
    review_reason = currentWindowActive ? "active source is identified only by IP" : "historical source is identified only by IP";
    suggested_action = currentWindowActive ? "add_registry_alias" : "hide_stale";
  } else if (serviceSource && !registryKnown) {
    review_state = "service_source";
    review_reason = "service/system evidence should stay diagnostic, not primary inventory";
    suggested_action = "collapse_service";
  } else if (!currentWindowActive && !registryKnown) {
    review_state = "stale_historical";
    review_reason = "historical observation without selected-window traffic or registry backing";
    suggested_action = "hide_stale";
  } else if (!registryKnown && total > 0 && total < 1024 * 1024) {
    review_state = "low_signal";
    review_reason = "low-volume active source without registry backing";
    suggested_action = "manual_review";
  } else if (!registryKnown && currentWindowActive) {
    review_state = "active_unattributed";
    review_reason = "active selected-window traffic is not backed by the private registry";
    suggested_action = "add_registry_alias";
  }
  return { review_state, review_reason, suggested_action, current_window_active: currentWindowActive };
}
