import type { FilterDecision, FilterRule } from "./types";

function text(value: unknown): string {
  return String(value || "");
}

function matches(rule: FilterRule, fact: Record<string, unknown>) {
  const value = text(rule.match_value).toLowerCase();
  const domain = text(fact.dns_qname || fact.destination).toLowerCase();
  const ip = text(fact.destination_ip).toLowerCase();
  const clientKey = text(fact.client_key).toLowerCase();
  const route = text(fact.route).toLowerCase();
  const trafficClass = text(fact.traffic_class).toLowerCase();
  if (!value) return null;
  if (rule.match_kind === "domain" && domain === value) return { field: "domain", value: domain };
  if (rule.match_kind === "domain_suffix" && (domain === value || domain.endsWith(`.${value}`))) return { field: "domain", value: domain };
  if (rule.match_kind === "ip" && ip === value) return { field: "destination_ip", value: ip };
  if (rule.match_kind === "client_key" && clientKey === value) return { field: "client_key", value: clientKey };
  if (rule.match_kind === "route" && route === value) return { field: "route", value: route };
  if (rule.match_kind === "category" && trafficClass === value) return { field: "traffic_class", value: trafficClass };
  return null;
}

export function evaluateFlow(fact: Record<string, unknown>, rules: FilterRule[]): FilterDecision[] {
  return rules
    .filter((rule) => Number(rule.enabled) === 1 && Number(rule.dry_run) === 1)
    .flatMap((rule) => {
      const match = matches(rule, fact);
      if (!match) return [];
      return [{
        decision_id: `${fact.fact_id || "fact"}:${rule.rule_id}:${match.field}:${match.value}`,
        snapshot_id: text(fact.snapshot_id),
        observed_at_utc: text(fact.observed_at_utc || fact.event_ts_utc),
        rule_id: rule.rule_id,
        client_key: text(fact.client_key),
        client_ip: text(fact.client_ip),
        destination: text(fact.destination),
        destination_ip: text(fact.destination_ip),
        matched_field: match.field,
        matched_value: match.value,
        would_have_action: rule.action,
        applied: 0,
        evidence_json: JSON.stringify({ dry_run: true }),
      }];
    });
}
