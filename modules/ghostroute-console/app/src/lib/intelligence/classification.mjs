function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function valueFor(input) {
  if (typeof input === "string") return input.toLowerCase();
  const row = input || {};
  if (text(row.dns_link_confidence).toLowerCase() === "no_dns_match") return "unknown:no_dns_match";
  return text(row.destination || row.domain || row.dns_qname || row.sni || row.destination_ip).toLowerCase();
}

function result(category, provider, action_hint, confidence, reason_code, traffic_role, traffic_purpose) {
  return { category, provider, action_hint, confidence, reason_code, traffic_role, traffic_purpose };
}

export function classifyDestination(input) {
  const value = valueFor(input);
  if (!value) return result("unknown.empty", "", "investigate", "unknown", "empty_destination", "unknown", "unknown");
  if (value === "unknown:no_dns_match") return result("unknown.no_dns_match", "", "investigate", "low", "no_dns_match", "unknown", "unknown");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || /^[0-9a-f:]+$/i.test(value)) {
    return result("unknown.ip_only", "", "investigate", "low", "ip_only", "unknown", "unknown");
  }
  if (value.includes("app-measurement") || value.includes("firebase") || value.includes("crashlytics")) {
    return result("analytics.firebase", "firebase", "block_candidate", "high", "firebase_analytics", "analytics_tracker", "telemetry");
  }
  if (value.match(/(^|[.-])(ads?|doubleclick|adservice|googlesyndication|scorecardresearch|branch|adjust|appsflyer)([.-]|$)/)) {
    return result("tracker.ads", "", "block_candidate", "medium", "ad_tracker_domain", "analytics_tracker", "tracking");
  }
  if (value.includes("push.apple")) return result("system.apple.push", "apple", "allow", "high", "apple_push", "system_maintenance", "push");
  if (value.includes("configuration.apple") || value.includes("captive.apple") || value.includes("ocsp.apple")) {
    return result("system.apple.maintenance", "apple", "allow", "medium", "apple_system", "system_maintenance", "maintenance");
  }
  if (value.includes("gvt") || value.includes("gstatic") || value.includes("connectivitycheck") || value.includes("googleapis")) {
    return result("system.google.background", "google", "allow", "medium", "google_system", "system_maintenance", "maintenance");
  }
  if (value.includes("icloud")) return result("personal_cloud.apple", "apple", "monitor", "high", "icloud", "client_bulk_sync", "personal_cloud");
  if (value.includes("dropbox")) return result("personal_cloud.dropbox", "dropbox", "monitor", "high", "dropbox", "client_bulk_sync", "personal_cloud");
  if (value.includes("onedrive") || value.includes("sharepoint")) return result("personal_cloud.microsoft", "microsoft", "monitor", "high", "microsoft_cloud", "client_bulk_sync", "personal_cloud");
  if (value.includes("drive.google") || value.includes("photos.google")) return result("personal_cloud.google", "google", "monitor", "high", "google_cloud", "client_bulk_sync", "personal_cloud");
  if (value.includes("cloudfront")) return result("cdn.cloudfront", "aws", "monitor", "medium", "cdn_provider", "cdn_delivery", "cdn");
  if (value.includes("akamai")) return result("cdn.akamai", "akamai", "monitor", "medium", "cdn_provider", "cdn_delivery", "cdn");
  if (value.includes("fastly")) return result("cdn.fastly", "fastly", "monitor", "medium", "cdn_provider", "cdn_delivery", "cdn");
  if (value.includes("cloudflare")) return result("cdn.cloudflare", "cloudflare", "monitor", "medium", "cdn_provider", "cdn_delivery", "cdn");
  return result("unknown.domain", "", "monitor", "unknown", "no_rule", "client_interactive", "unknown");
}
