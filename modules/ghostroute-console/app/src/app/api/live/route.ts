import { NextRequest, NextResponse } from "next/server";
import { buildLiveModel, listLiveEvents, listTrafficRows } from "@/lib/server/selectors";

function compact({ raw, evidence, evidence_json, ...row }: Record<string, any>) {
  return row;
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const filters = {
    route: search.get("route") || "all",
    channel: search.get("channel") || "all",
    confidence: search.get("confidence") || "all",
    trafficClass: search.get("trafficClass") || "client",
    client: search.get("client") || "all",
    search: search.get("search") || "",
  };
  const flows = listTrafficRows({ page: 1, pageSize: 8, filters }).rows;
  const model = buildLiveModel(filters, flows);
  const events = listLiveEvents({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || 50), 50),
    filters,
  });
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    flows: flows.map(compact),
    clients: model.devices.slice(0, 6).map(compact),
    dns: model.dnsQueries.slice(0, 6).map(compact),
    events: events.rows.map(compact),
    route_decisions: [],
    pagination: { total: events.total, page: events.page, pageSize: events.pageSize, totalPages: events.totalPages },
    alerts: model.alerts.slice(0, 5).map(compact),
  });
}
