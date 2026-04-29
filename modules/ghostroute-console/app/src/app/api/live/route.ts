import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    flows: model.flows.slice(0, 50).map(({ raw, ...row }) => row),
    clients: model.devices.slice(0, 30).map(({ raw, ...row }) => row),
    dns: model.dnsQueries.slice(0, 50).map(({ raw, ...row }) => row),
    alerts: model.alerts.slice(0, 20).map(({ raw, ...row }) => row),
  });
}
