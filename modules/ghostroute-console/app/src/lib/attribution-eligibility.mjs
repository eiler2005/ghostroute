function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function normalized(value = "") {
  return text(value).trim().toLowerCase();
}

function haystackFor(row = {}) {
  return [
    row.domain,
    row.dns_qname,
    row.sni,
    row.destination,
    row.destination_key,
    row.destination_label,
    row.destinationLabel,
    row.url_label,
    row.label,
    row.provider,
    row.category,
    row.dns_category,
    row.traffic_lane,
    row.traffic_class,
    row.trafficClass,
    row.client,
    row.client_key,
    row.client_label,
    row.device_key,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function isDomainLikeLabel(value) {
  const clean = normalized(value).replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (!clean || clean.includes(" ") || clean === "localhost") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return false;
  if (/^[0-9a-f:.]+$/i.test(clean) && clean.includes(":")) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean);
}

export function isIpOnlyAttributionLabel(value) {
  const clean = normalized(value);
  return !clean
    || clean === "ip-only destination"
    || clean.includes("ip-only destination")
    || clean.includes("ip only")
    || clean.includes("unknown ip")
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(clean)
    || (/^[0-9a-f:.]+$/i.test(clean) && clean.includes(":"));
}

export function isAggregateResidualLabel(value) {
  const clean = normalized(value);
  return clean === "other / uncategorized"
    || clean === "unattributed traffic not mapped to sites"
    || clean.includes("aggregate residual")
    || clean.includes("counter-only")
    || clean.includes("destination aggregate")
    || clean.includes("current-window aggregate");
}

export function isInternalGhostRouteLabel(value) {
  const clean = normalized(value);
  return clean === "ghostroute"
    || clean === "home reality ingress"
    || clean === "encrypted ingress traffic"
    || clean === "client.home_reality_ingress"
    || clean.includes("home reality ingress")
    || clean.includes("encrypted ingress traffic");
}

export function isRawSourceCounter(row = {}) {
  const haystack = haystackFor(row);
  return /\bmobile-source-\d+\b/.test(haystack)
    || /\braw mobile\b/.test(haystack)
    || /\bunattributed mobile ingress source\b/.test(haystack);
}

export function isInternalGhostRouteRow(row = {}) {
  const haystack = haystackFor(row);
  return isInternalGhostRouteLabel(row.provider)
    || isInternalGhostRouteLabel(row.destination)
    || isInternalGhostRouteLabel(row.destination_key)
    || isInternalGhostRouteLabel(row.destination_label)
    || isInternalGhostRouteLabel(row.category)
    || isInternalGhostRouteLabel(row.dns_category)
    || haystack.includes("client.home_reality_ingress");
}

export function isServiceEvidenceRow(row = {}) {
  const trafficClass = normalized(row.traffic_class || row.trafficClass);
  const trafficLane = normalized(row.traffic_lane || row.trafficLane);
  const role = normalized(row.traffic_role || row.app_role);
  return trafficClass === "service_background"
    || trafficLane === "service_system"
    || role === "service_system"
    || normalized(row.app_category) === "service_system";
}

export function isUsefulCoarseAttribution(row = {}) {
  const provider = normalized(row.provider);
  const category = normalized(row.category || row.dns_category).replace(/[_.-]+/g, " ");
  const unusable = new Set([
    "",
    "unknown",
    "unknown provider",
    "unknown domain",
    "unclassified",
    "uncategorized",
    "ip only",
    "unknown ip",
    "client home reality ingress",
  ]);
  if (isInternalGhostRouteRow(row)) return false;
  if (provider && !unusable.has(provider)) return true;
  return Boolean(category && !unusable.has(category));
}

export function attributionEligibility(row = {}) {
  const domain = text(row.domain || row.dns_qname || row.sni || "");
  const label = text(row.url_label || row.label || row.destinationLabel || row.destination_label || row.destination || row.destination_key || "");
  if (isRawSourceCounter(row)) {
    return { state: "raw_counter_source", reason: "raw source counter without site evidence", appAttributable: false, siteAttributable: false, serviceOnly: false };
  }
  if (isInternalGhostRouteRow(row)) {
    return { state: "service_only", reason: "internal GhostRoute ingress/counter evidence", appAttributable: false, siteAttributable: false, serviceOnly: true };
  }
  if (isServiceEvidenceRow(row)) {
    return { state: "service_only", reason: "service/background evidence", appAttributable: false, siteAttributable: true, serviceOnly: true };
  }
  if (isDomainLikeLabel(domain) || isDomainLikeLabel(label)) {
    return { state: "app_attributable", reason: "domain/SNI evidence", appAttributable: true, siteAttributable: true, serviceOnly: false };
  }
  if (isAggregateResidualLabel(label) || isIpOnlyAttributionLabel(label)) {
    return { state: "low_signal", reason: "IP-only or aggregate residual evidence", appAttributable: false, siteAttributable: false, serviceOnly: false };
  }
  if (isUsefulCoarseAttribution(row)) {
    return { state: "coarse_attributable", reason: "provider/category evidence", appAttributable: true, siteAttributable: true, serviceOnly: false };
  }
  return { state: "low_signal", reason: "missing domain/provider evidence", appAttributable: false, siteAttributable: false, serviceOnly: false };
}

export function isAttributableSiteRow(row = {}, options = {}) {
  const eligibility = attributionEligibility(row);
  if (eligibility.serviceOnly) return Boolean(options.includeService);
  return eligibility.siteAttributable;
}

export function decorateAttributionEligibility(row = {}) {
  const eligibility = attributionEligibility(row);
  return {
    ...row,
    attribution_eligibility: eligibility.state,
    attribution_reason: eligibility.reason,
    excluded_from_app_attribution: !eligibility.appAttributable,
  };
}
