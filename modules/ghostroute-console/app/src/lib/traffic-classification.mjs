import { isDnsOnlyTraffic, trafficClassForDomain, trafficDomainLabel } from "./domain-attribution.mjs";

export const trafficClasses = ["client", "service_background", "unclassified", "all"];

export const trafficClassLabels = {
  client: "Client",
  service_background: "Service/background",
  unclassified: "Needs attribution",
  all: "All traffic",
};

export function trafficClassFor(row) {
  return trafficClassForDomain(row);
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
