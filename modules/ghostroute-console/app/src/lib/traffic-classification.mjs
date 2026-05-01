function usefulText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (["unknown", "client", "not observed", "n/a"].includes(text.toLowerCase())) return "";
  return text;
}

function rawDestination(row) {
  return usefulText(row.destination || row.family || row.app || row.dns_qname || row.sni || row.destination_ip);
}

function trafficBytes(row) {
  return Number(row.bytes || row.total_bytes || row.totalBytes || 0);
}

function isDnsOnly(row) {
  return trafficBytes(row) <= 0 && String(row.confidence || "").toLowerCase() === "dns-interest";
}

function isUnclassifiedDestination(value) {
  const d = value.toLowerCase();
  return d === "other" || d === "other/ip" || d === "unknown" || d === "ip-only / no dns match" || d === "unclassified domain";
}

function isServiceDestination(value) {
  const d = value.toLowerCase();
  return (
    d.includes("apple/icloud") ||
    d.includes("dns/resolver") ||
    d.includes("aws/cdn") ||
    d.includes("icloud") ||
    d.includes("apple") ||
    d.includes("itunes") ||
    d.includes("mzstatic") ||
    d.includes("aaplimg") ||
    d.includes("cloudfront") ||
    d.includes("amazonaws") ||
    d.includes("cloudflare") ||
    d.includes("akamai") ||
    d.includes("fastly") ||
    d === "cdn" ||
    d.includes("resolver")
  );
}

export const trafficClasses = ["client", "service_background", "unclassified", "all"];

export const trafficClassLabels = {
  client: "Client",
  service_background: "Service/background",
  unclassified: "Needs attribution",
  all: "All traffic",
};

export function trafficClassFor(row) {
  const destination = rawDestination(row);
  if (isDnsOnly(row)) return "service_background";
  if (!destination) return "service_background";
  if (isServiceDestination(destination)) return "service_background";
  if (isUnclassifiedDestination(destination)) return "unclassified";
  return "client";
}

export function trafficClassLabel(value) {
  return trafficClassLabels[String(value || "client")] || String(value || "client");
}

export function displayDestination(row) {
  const destination = rawDestination(row);
  if (!destination) return "n/a";
  const lower = destination.toLowerCase();
  if (lower === "other/ip") return "IP-only / no DNS match";
  if (lower === "other") {
    if (isDnsOnly(row)) return "DNS-only interest";
    if (usefulText(row.destination_ip)) return "IP-only / no DNS match";
    return "Unclassified domain";
  }
  return destination;
}

export function deviceRole(row) {
  const text = [row.label, row.id, row.device_id, row.profile, row.client, row.channel].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("channel c") || /\bc1\b|shadowrocket|naive/.test(text)) return "Channel C profile";
  if (text.includes("channel b") || /iphone-b|xhttp|selected-client/.test(text)) return "Channel B profile";
  if (/mobile-source-\d+/.test(text)) return "Unattributed mobile ingress source";
  if (/mobile-client-\d+/.test(text)) return "Home Reality profile";
  if (text.includes("ipad")) return "iPad";
  if (text.includes("iphone")) return "iPhone";
  if (text.includes("macbook") || text.includes("mac book")) return "MacBook";
  if (/^lan-host-\d+/.test(text) || text.includes("home wi-fi/lan")) return "Home LAN device";
  return "Unknown device";
}
