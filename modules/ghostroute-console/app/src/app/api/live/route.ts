import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

function compact({ raw, evidence, evidence_json, ...row }: Record<string, any>) {
  return row;
}

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    flows: model.flows.slice(0, 8).map(compact),
    clients: model.devices.slice(0, 6).map(compact),
    dns: model.dnsQueries.slice(0, 6).map(compact),
    events: model.events.slice(0, 8).map(compact),
    route_decisions: model.routeDecisions.slice(0, 8).map(compact),
    alerts: model.alerts.slice(0, 5).map(compact),
  });
}
