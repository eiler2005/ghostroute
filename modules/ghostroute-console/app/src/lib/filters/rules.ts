import { getDb } from "../server/store";
import type { FilterDecision, FilterRule } from "./types";

export function listFilterRules(limit = 100, offset = 0): FilterRule[] {
  return getDb()
    .prepare("select * from filter_rules order by priority asc, updated_at_utc desc, rule_id asc limit ? offset ?")
    .all(limit, offset) as FilterRule[];
}

export function listFilterDecisions(limit = 100, offset = 0): FilterDecision[] {
  return getDb()
    .prepare("select * from filter_decisions order by observed_at_utc desc, decision_id desc limit ? offset ?")
    .all(limit, offset) as FilterDecision[];
}
