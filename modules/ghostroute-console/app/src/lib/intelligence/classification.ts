export { classifyDestination } from "./classification.mjs";

export type TrafficClass = "client" | "personal_cloud" | "service_background" | "unclassified";
export type TrafficLane = "client_observed" | "service_system" | "privacy_risk" | "shared_infra" | "unknown_review";
export type DnsCategory =
  | "user_content"
  | "messaging"
  | "personal_cloud"
  | "media_streaming"
  | "system_push"
  | "system_appstore"
  | "system_connectivity"
  | "system_auth_security"
  | "system_maintenance"
  | "app_background"
  | "crash_reporting"
  | "analytics"
  | "ads_tracking"
  | "telemetry"
  | "cdn_shared"
  | "cloud_hosting"
  | "unknown_ip_only"
  | "unknown_shared_answer"
  | "unknown_domain";
export type TrafficRole =
  | "client_interactive"
  | "client_bulk_sync"
  | "system_maintenance"
  | "analytics_tracker"
  | "cdn_delivery"
  | "infra_hosting"
  | "unknown";
export type DecisionHint =
  | "allow"
  | "block_candidate"
  | "monitor"
  | "route_vps_candidate"
  | "direct_candidate"
  | "investigate"
  | "ask_user";
export type Confidence = "high" | "medium" | "low" | "unknown";

export type TrafficIntelligenceInput = {
  destination?: string;
  destination_ip?: string;
  domain?: string;
  dns_qname?: string;
  dns_link_confidence?: string;
  route?: string;
  route_verification?: string;
  protocol?: string;
  destination_port?: number | string;
  traffic_class?: string;
  provider?: string;
  asn_org?: string;
  egress_asn?: string;
  organization?: string;
};

export type TrafficIntelligenceResult = {
  traffic_class: TrafficClass;
  traffic_lane: TrafficLane;
  dns_category: DnsCategory;
  category: string;
  provider: string;
  traffic_role: TrafficRole;
  traffic_purpose: string;
  decision_hint: DecisionHint;
  recommended_action: DecisionHint;
  action_hint: DecisionHint;
  confidence: Confidence;
  reason_code: string;
  human_explanation: string;
  evidence_sources: string[];
};
