function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function lower(value) {
  return text(value).trim().toLowerCase();
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value).trim();
    if (candidate) return candidate;
  }
  return "";
}

function hasUsefulDomain(value) {
  const normalized = lower(value);
  return Boolean(normalized && !isIpLiteral(normalized) && !["unknown", "other", "other/ip", "ip-only / no dns match"].includes(normalized));
}

function isIpLiteral(value) {
  const normalized = lower(value);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return true;
  return normalized.includes(":") && /^[0-9a-f:.]+$/i.test(normalized);
}

function evidenceSources(input, value) {
  const row = input && typeof input === "object" ? input : {};
  const sources = [];
  if (hasUsefulDomain(row.dns_qname || row.domain || row.destination)) sources.push("dns");
  if (text(row.dns_link_confidence)) sources.push("dns_link");
  if (text(row.route_verification)) sources.push("route_evidence");
  if (isIpLiteral(value || row.destination_ip)) sources.push("ip");
  return Array.from(new Set(sources));
}

function result(input, fields) {
  const row = input && typeof input === "object" ? input : {};
  const decisionHint = fields.decision_hint || fields.action_hint || "monitor";
  const category = fields.category || "unknown.domain";
  const trafficClass = fields.traffic_class || trafficClassForCategory(category);
  const trafficLane = fields.traffic_lane || trafficLaneForCategory(category, trafficClass);
  const dnsCategory = fields.dns_category || dnsCategoryForCategory(category);
  const explanation = fields.human_explanation || explanationFor(category, decisionHint, fields.provider || "");
  return {
    traffic_class: trafficClass,
    traffic_lane: trafficLane,
    dns_category: dnsCategory,
    category,
    provider: fields.provider || "",
    traffic_role: fields.traffic_role || "unknown",
    traffic_purpose: fields.traffic_purpose || "unknown",
    decision_hint: decisionHint,
    recommended_action: fields.recommended_action || decisionHint,
    action_hint: decisionHint,
    confidence: fields.confidence || "unknown",
    reason_code: fields.reason_code || "no_rule",
    human_explanation: explanation,
    evidence_sources: fields.evidence_sources || evidenceSources(row, fields.value),
  };
}

function trafficClassForCategory(category) {
  if (category.startsWith("personal_cloud.")) return "personal_cloud";
  if (category.startsWith("system.") || category.startsWith("analytics.") || category.startsWith("tracker.")) return "service_background";
  if (category.startsWith("cdn.")) return "service_background";
  if (category.startsWith("client.")) return "client";
  return "unclassified";
}

function trafficLaneForCategory(category, trafficClass) {
  if (category.startsWith("analytics.") || category.startsWith("tracker.")) return "privacy_risk";
  if (category.startsWith("system.")) return "service_system";
  if (category.startsWith("cdn.") || category.startsWith("vps.")) return "shared_infra";
  if (category.startsWith("unknown.")) return "unknown_review";
  if (trafficClass === "client" || trafficClass === "personal_cloud" || category.startsWith("personal_cloud.") || category.startsWith("client.")) return "client_observed";
  if (trafficClass === "service_background") return "service_system";
  return "unknown_review";
}

function dnsCategoryForCategory(category) {
  if (category === "analytics.firebase") return "analytics";
  if (category.startsWith("analytics.")) return "analytics";
  if (category === "tracker.ads") return "ads_tracking";
  if (category === "system.apple.push") return "system_push";
  if (category.startsWith("system.apple.")) return category.includes("store") || category.includes("itunes") ? "system_appstore" : "system_maintenance";
  if (category.startsWith("system.google.connectivity") || category.startsWith("system.microsoft.connectivity")) return "system_connectivity";
  if (category.startsWith("system.")) return "system_maintenance";
  if (category.startsWith("personal_cloud.")) return "personal_cloud";
  if (category.includes(".youtube") || category.startsWith("client.media.")) return "media_streaming";
  if (category.startsWith("client.messaging.")) return "messaging_platform";
  if (category.startsWith("client.social.")) return "social_platform";
  if (category.startsWith("client.meeting.")) return "meeting_platform";
  if (category.startsWith("client.ai.")) return "ai_assistant";
  if (category.startsWith("client.mail.")) return "mail";
  if (category.startsWith("client.dev.")) return "developer_tool";
  if (category.startsWith("client.search.")) return "search";
  if (category.startsWith("client.")) return "user_content";
  if (category.startsWith("cdn.")) return "cdn_shared";
  if (category.startsWith("vps.")) return "cloud_hosting";
  if (category === "unknown.no_dns_match") return "unknown_ip_only";
  if (category === "unknown.shared_dns_answer") return "unknown_shared_answer";
  if (category === "unknown.ip_only") return "unknown_ip_only";
  return "unknown_domain";
}

function explanationFor(category, decisionHint, provider) {
  if (category === "client.home_reality_ingress") return "Home Reality encrypted ingress counter; destination details are not attributed without DNS or flow evidence.";
  if (category === "analytics.firebase") return "Firebase analytics traffic; review as a block candidate.";
  if (category === "tracker.ads") return "Advertising or tracking traffic; review as a block candidate.";
  if (category === "system.apple.push") return "Apple Push traffic; usually keep allowed for notifications.";
  if (category.startsWith("system.apple.")) return "Apple system traffic; usually keep allowed.";
  if (category.startsWith("system.google.")) return "Google system/background traffic; usually keep allowed.";
  if (category.startsWith("personal_cloud.")) return "Personal cloud sync traffic; monitor before changing policy.";
  if (category.startsWith("cdn.")) return `${provider || "CDN"} shared delivery traffic; avoid blocking without domain context.`;
  if (category.startsWith("vps.")) return "Hosting/VPS-like destination; investigate before routing or blocking.";
  if (category === "unknown.no_dns_match") return "No safe DNS match; keep as IP-only until reviewed.";
  if (category === "unknown.shared_dns_answer") return "Shared DNS answer; do not assign one confident domain.";
  if (category === "unknown.ip_only") return "IP-only destination; needs review or optional enrichment.";
  if (decisionHint === "ask_user") return "No local rule matched; ask the operator before acting.";
  return "Local deterministic traffic classification.";
}

function valueFor(input) {
  if (typeof input === "string") return input.trim();
  const row = input || {};
  if (lower(row.dns_link_confidence) === "no_dns_match") return "unknown:no_dns_match";
  if (lower(row.dns_link_confidence) === "low" && !hasUsefulDomain(row.dns_qname || row.domain || row.destination)) return "unknown:shared_dns_answer";
  return firstText(row.dns_qname, row.domain, row.sni, row.destination, row.destination_ip);
}

function includesAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

function isAppleSystemDomain(value) {
  return includesAny(value, [
    "configuration.apple",
    "configuration.ls.apple.com",
    "captive.apple",
    "ocsp.apple",
    "ocsp2.apple",
    "stocks-data-service.apple",
    "mzstatic",
    "aaplimg",
    "itunes",
    "apple-dns.net",
    "gs-loc.apple.com",
    "gsp-ssl.ls.apple.com",
    "ls.apple.com",
    "iphone-ld.apple.com",
    "cl2.apple.com",
    "lcdn-locator.apple.com",
    "pancake.apple.com",
    "swallow.apple.com",
    "valid.apple.com",
    "cdn-apple.com",
  ]);
}

export function classifyDestination(input) {
  const row = input && typeof input === "object" ? input : {};
  const rawDestination = lower(row.destination || row.domain || row.dns_qname || "");
  if (rawDestination.includes("home reality ingress") || lower(row.destination_kind) === "encrypted_ingress") {
    return result(input, {
      value: rawDestination || "home reality ingress",
      category: "client.home_reality_ingress",
      provider: "ghostroute",
      traffic_class: "client",
      traffic_lane: "client_observed",
      dns_category: "user_content",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "home_reality_counter",
      traffic_role: "client_interactive",
      traffic_purpose: "encrypted_ingress",
    });
  }
  const value = lower(valueFor(input));
  if (!value) {
    return result(input, {
      value,
      category: "unknown.empty",
      traffic_class: "unclassified",
      decision_hint: "ask_user",
      confidence: "unknown",
      reason_code: "empty_destination",
      traffic_role: "unknown",
      traffic_purpose: "unknown",
    });
  }
  if (value === "unknown:no_dns_match") {
    return result(input, {
      value,
      category: "unknown.no_dns_match",
      traffic_class: "unclassified",
      decision_hint: "ask_user",
      confidence: "low",
      reason_code: "no_dns_match",
      traffic_role: "unknown",
      traffic_purpose: "unknown",
    });
  }
  if (value === "unknown:shared_dns_answer") {
    return result(input, {
      value,
      category: "unknown.shared_dns_answer",
      traffic_class: "unclassified",
      decision_hint: "ask_user",
      confidence: "low",
      reason_code: "shared_dns_answer",
      traffic_role: "unknown",
      traffic_purpose: "unknown",
    });
  }
  if (isIpLiteral(value)) {
    return result(input, {
      value,
      category: "unknown.ip_only",
      traffic_class: "unclassified",
      decision_hint: "ask_user",
      confidence: "low",
      reason_code: "ip_only",
      traffic_role: "unknown",
      traffic_purpose: "unknown",
    });
  }
  if (includesAny(value, ["app-measurement", "firebase", "crashlytics"])) {
    return result(input, {
      value,
      category: "analytics.firebase",
      provider: "firebase",
      decision_hint: "block_candidate",
      confidence: "high",
      reason_code: "firebase_analytics",
      traffic_role: "analytics_tracker",
      traffic_purpose: "telemetry",
    });
  }
  if (/(^|[.-])(ads?|doubleclick|adservice|googlesyndication|scorecardresearch|branch|adjust|appsflyer)([.-]|$)/.test(value)) {
    return result(input, {
      value,
      category: "tracker.ads",
      decision_hint: "block_candidate",
      confidence: "medium",
      reason_code: "ad_tracker_domain",
      traffic_role: "analytics_tracker",
      traffic_purpose: "tracking",
    });
  }
  if (value.includes("app-analytics-services.com")) {
    return result(input, {
      value,
      category: "analytics.apple",
      provider: "apple",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "apple_analytics",
      traffic_role: "analytics_tracker",
      traffic_purpose: "telemetry",
    });
  }
  if (value.includes("icloud")) {
    return result(input, {
      value,
      category: "personal_cloud.icloud",
      provider: "apple",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "icloud",
      traffic_role: "client_bulk_sync",
      traffic_purpose: "personal_cloud",
    });
  }
  if (value.includes("dropbox")) {
    return result(input, {
      value,
      category: "personal_cloud.dropbox",
      provider: "dropbox",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "dropbox",
      traffic_role: "client_bulk_sync",
      traffic_purpose: "personal_cloud",
    });
  }
  if (value.includes("onedrive") || value.includes("sharepoint")) {
    return result(input, {
      value,
      category: "personal_cloud.onedrive",
      provider: "microsoft",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "microsoft_cloud",
      traffic_role: "client_bulk_sync",
      traffic_purpose: "personal_cloud",
    });
  }
  if (value.includes("drive.google") || value.includes("photos.google")) {
    return result(input, {
      value,
      category: "personal_cloud.google_drive",
      provider: "google",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "google_cloud",
      traffic_role: "client_bulk_sync",
      traffic_purpose: "personal_cloud",
    });
  }
  if (value === "calendar.google.com" || value.endsWith(".calendar.google.com")) {
    return result(input, {
      value,
      category: "client.calendar.google",
      provider: "google",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "known_calendar_app",
      traffic_role: "client_interactive",
      traffic_purpose: "calendar",
    });
  }
  if (value.includes("youtube") || value.includes("ytimg.com") || value.includes("googlevideo.com")) {
    return result(input, {
      value,
      category: "client.google.youtube",
      provider: "google",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "user_content_domain",
      traffic_role: "client_interactive",
      traffic_purpose: "media",
    });
  }
  if (includesAny(value, ["api.anthropic.com", "chatgpt.com", "openai.com"])) {
    return result(input, {
      value,
      category: value.includes("anthropic") ? "client.ai.anthropic" : "client.ai.openai",
      provider: value.includes("anthropic") ? "anthropic" : "openai",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "known_client_ai_app",
      traffic_role: "client_interactive",
      traffic_purpose: "ai_assistant",
    });
  }
  if (/(^|[.-])zoom\.us$/.test(value) || value.endsWith(".zoom.us")) {
    return result(input, {
      value,
      category: "client.meeting.zoom",
      provider: "zoom",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "known_meeting_app",
      traffic_role: "client_interactive",
      traffic_purpose: "meeting",
    });
  }
  if (includesAny(value, ["instagram.com", "facebook.com", "fbcdn.net"]) || /(^|[.-])(dgw|dgw-ig)\.c10r\./.test(value)) {
    return result(input, {
      value,
      category: value.includes("instagram") || value.includes("dgw-ig") ? "client.social.instagram" : "client.social.facebook",
      provider: "meta",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_social_app",
      traffic_role: "client_interactive",
      traffic_purpose: "social",
    });
  }
  if (value.includes("whatsapp.com") || value.includes("whatsapp.net")) {
    return result(input, {
      value,
      category: "client.messaging.whatsapp",
      provider: "whatsapp",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "known_messaging_app",
      traffic_role: "client_interactive",
      traffic_purpose: "messaging",
    });
  }
  if (value === "x.com" || value.endsWith(".x.com") || value.includes("twitter.com")) {
    return result(input, {
      value,
      category: "client.social.x",
      provider: "x",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_social_app",
      traffic_role: "client_interactive",
      traffic_purpose: "social",
    });
  }
  if (value.includes("github.com")) {
    return result(input, {
      value,
      category: "client.dev.github",
      provider: "github",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_developer_app",
      traffic_role: "client_interactive",
      traffic_purpose: "developer_tool",
    });
  }
  if (includesAny(value, ["imap.gmail.com", "gmail.com", "mail.google.com", "imap.mail.me.com"])) {
    return result(input, {
      value,
      category: value.includes("mail.me.com") ? "client.mail.icloud" : "client.mail.gmail",
      provider: value.includes("mail.me.com") ? "apple" : "google",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_mail_app",
      traffic_role: "client_interactive",
      traffic_purpose: "mail",
    });
  }
  if (value === "www.google.com" || value === "google.com") {
    return result(input, {
      value,
      category: "client.search.google",
      provider: "google",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_search_app",
      traffic_role: "client_interactive",
      traffic_purpose: "search",
    });
  }
  if (value.includes("push.apple") || value.includes("push-apple")) {
    return result(input, {
      value,
      category: "system.apple.push",
      provider: "apple",
      decision_hint: "allow",
      confidence: "high",
      reason_code: "apple_push",
      traffic_role: "system_maintenance",
      traffic_purpose: "push",
    });
  }
  if (isAppleSystemDomain(value)) {
    return result(input, {
      value,
      category: "system.apple.maintenance",
      provider: "apple",
      decision_hint: "allow",
      confidence: "medium",
      reason_code: "apple_system",
      traffic_role: "system_maintenance",
      traffic_purpose: "maintenance",
    });
  }
  if (includesAny(value, ["connectivitycheck", "dns.google", "clients3.google", "gvt", "gstatic", "googleapis", "msftncsi"])) {
    return result(input, {
      value,
      category: value.includes("msftncsi") ? "system.microsoft.connectivity" : value.includes("connectivitycheck") ? "system.google.connectivity" : "system.google.background",
      provider: value.includes("msftncsi") ? "microsoft" : "google",
      decision_hint: "allow",
      confidence: "medium",
      reason_code: value.includes("msftncsi") ? "microsoft_connectivity" : "google_system",
      traffic_role: "system_maintenance",
      traffic_purpose: "maintenance",
    });
  }
  if (value === "miro.com" || value.endsWith(".miro.com")) {
    return result(input, {
      value,
      category: "client.collaboration.miro",
      provider: "miro",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "medium",
      reason_code: "known_client_app",
      traffic_role: "client_interactive",
      traffic_purpose: "collaboration",
    });
  }
  if (value === "2gis.com" || value.endsWith(".2gis.com") || value === "2gis.ru" || value.endsWith(".2gis.ru")) {
    return result(input, {
      value,
      category: "client.maps.2gis",
      provider: "2gis",
      traffic_class: "client",
      decision_hint: "monitor",
      confidence: "high",
      reason_code: "known_maps_app",
      traffic_role: "client_interactive",
      traffic_purpose: "maps",
    });
  }
  const cdn = cdnProvider(value);
  if (cdn.provider) {
    return result(input, {
      value,
      category: cdn.category,
      provider: cdn.provider,
      traffic_class: "service_background",
      decision_hint: "monitor",
      confidence: cdn.confidence,
      reason_code: "cdn_provider",
      traffic_role: "cdn_delivery",
      traffic_purpose: "cdn",
    });
  }
  const hosting = hostingProvider(value, row);
  if (hosting.provider) {
    return result(input, {
      value,
      category: hosting.category,
      provider: hosting.provider,
      traffic_class: "unclassified",
      decision_hint: "ask_user",
      confidence: hosting.confidence,
      reason_code: "hosting_provider",
      traffic_role: "infra_hosting",
      traffic_purpose: "hosting",
    });
  }
  return result(input, {
    value,
    category: "unknown.domain",
    traffic_class: "unclassified",
    decision_hint: "ask_user",
    confidence: "unknown",
    reason_code: "no_rule",
    traffic_role: "unknown",
    traffic_purpose: "unknown",
  });
}

function cdnProvider(value) {
  const rules = [
    ["cdn.cloudfront", "aws", "medium", ["cloudfront"]],
    ["cdn.akamai", "akamai", "medium", ["akamai", "edgesuite", "edgekey"]],
    ["cdn.fastly", "fastly", "medium", ["fastly"]],
    ["cdn.cloudflare", "cloudflare", "medium", ["cloudflare"]],
    ["cdn.gcore", "gcore", "medium", ["gcore", "g-core"]],
  ];
  for (const [category, provider, confidence, terms] of rules) {
    if (includesAny(value, terms)) return { category, provider, confidence };
  }
  if (/(\b|[.-])cdn(\b|[.-])/.test(value)) return { category: "cdn.unknown", provider: "", confidence: "low" };
  return {};
}

function hostingProvider(value, row) {
  const rawProvider = lower(row.provider || row.asn_org || row.egress_asn || row.organization);
  const haystack = `${value} ${rawProvider}`;
  const rules = [
    ["hetzner", ["hetzner"]],
    ["digitalocean", ["digitalocean", "digital ocean"]],
    ["linode", ["linode", "akamai cloud"]],
    ["vultr", ["vultr"]],
    ["ovh", ["ovh"]],
    ["contabo", ["contabo"]],
    ["aws", ["compute.amazonaws.com", "ec2-", "amazon aws"]],
    ["google_cloud", ["googleusercontent.com", "google cloud"]],
    ["azure", ["azure", "cloudapp.net"]],
  ];
  for (const [provider, terms] of rules) {
    if (includesAny(haystack, terms)) return { category: "vps.hosting", provider, confidence: rawProvider ? "medium" : "low" };
  }
  if (includesAny(haystack, ["hosting", "vps", "server", "cloud provider"])) {
    return { category: "vps.provider_unknown", provider: "", confidence: "low" };
  }
  return {};
}
