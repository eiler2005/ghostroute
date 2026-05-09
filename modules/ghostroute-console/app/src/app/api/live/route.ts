import { NextRequest, NextResponse } from "next/server";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { buildLiveModel, listLiveEvents } from "@/lib/server/selectors/live";
import { clearDerivedCache } from "@/lib/server/selectors/shell";

export const dynamic = "force-dynamic";
export const revalidate = 60;

function compact({ raw, evidence, evidence_json, ...row }: Record<string, any>) {
  return row;
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  if (search.get("fresh") === "1") clearDerivedCache();
  const filters = {
    route: search.get("route") || "all",
    channel: search.get("channel") || "all",
    confidence: search.get("confidence") || "all",
    trafficClass: search.get("trafficClass") || "all",
    client: search.get("client") || "all",
    search: search.get("search") || "",
  };
  const flows = listFlowSessions({ page: 1, pageSize: 8, filters }).rows;
  const model = buildLiveModel(filters, flows);
  const events = listLiveEvents({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || 50), 500),
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
