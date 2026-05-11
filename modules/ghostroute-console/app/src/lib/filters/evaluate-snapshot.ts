import { evaluateFlow } from "./evaluator";
import type { FilterRule } from "./types";

export function evaluateSnapshot(flows: Array<Record<string, unknown>>, rules: FilterRule[]) {
  return flows.flatMap((flow) => evaluateFlow(flow, rules));
}
