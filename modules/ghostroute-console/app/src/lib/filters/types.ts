export type FilterAction = "allow" | "block" | "route_via_vps" | "route_direct" | "monitor";

export type FilterRule = {
  rule_id: string;
  scope: string;
  match_kind: string;
  match_value: string;
  action: FilterAction;
  priority: number;
  enabled: number;
  dry_run: number;
  reason: string;
  created_by: string;
  created_at_utc: string;
  updated_at_utc: string;
  evidence_json: string;
};

export type FilterDecision = {
  decision_id: string;
  snapshot_id: string;
  observed_at_utc: string;
  rule_id: string;
  client_key: string;
  client_ip: string;
  destination: string;
  destination_ip: string;
  matched_field: string;
  matched_value: string;
  would_have_action: FilterAction;
  applied: 0;
  evidence_json: string;
};
