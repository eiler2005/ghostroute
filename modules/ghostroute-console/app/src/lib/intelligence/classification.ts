export type DestinationClassification = {
  category: string;
  provider: string;
  action_hint: "allow" | "block_candidate" | "monitor" | "investigate";
  confidence: "high" | "medium" | "low" | "unknown";
  reason_code: string;
};

function valueFor(input: unknown): string {
  if (typeof input === "string") return input.toLowerCase();
  const row = (input || {}) as Record<string, unknown>;
  return String(row.destination || row.domain || row.dns_qname || row.sni || row.destination_ip || "").toLowerCase();
}

export function classifyDestination(input: unknown): DestinationClassification {
  const value = valueFor(input);
  if (!value) {
    return { category: "unknown.empty", provider: "", action_hint: "investigate", confidence: "unknown", reason_code: "empty_destination" };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return { category: "unknown.ip_only", provider: "", action_hint: "investigate", confidence: "low", reason_code: "ip_only" };
  }
  if (value.includes("app-measurement") || value.includes("analytics") || value.includes("telemetry") || value.includes("crashlytics")) {
    return { category: "analytics", provider: value.includes("firebase") || value.includes("app-measurement") ? "firebase" : "", action_hint: "block_candidate", confidence: "medium", reason_code: "analytics_domain" };
  }
  if (value.includes("push.apple")) {
    return { category: "system.apple.push", provider: "apple", action_hint: "allow", confidence: "high", reason_code: "apple_push" };
  }
  if (value.includes("itunes") || value.includes("mzstatic") || value.includes("aaplimg")) {
    return { category: "system.apple.appstore", provider: "apple", action_hint: "allow", confidence: "medium", reason_code: "apple_appstore" };
  }
  if (value.includes("icloud")) {
    return { category: "personal_cloud.apple", provider: "apple", action_hint: "monitor", confidence: "high", reason_code: "icloud" };
  }
  if (value.includes("dropbox")) {
    return { category: "personal_cloud.dropbox", provider: "dropbox", action_hint: "monitor", confidence: "high", reason_code: "dropbox" };
  }
  if (value.includes("cloudfront") || value.includes("akamai") || value.includes("fastly") || value.includes("cloudflare")) {
    return { category: "cdn", provider: "", action_hint: "monitor", confidence: "medium", reason_code: "cdn_suffix" };
  }
  return { category: "unknown.domain", provider: "", action_hint: "monitor", confidence: "unknown", reason_code: "no_rule" };
}
