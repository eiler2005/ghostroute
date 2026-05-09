import { NextResponse } from "next/server";
import { buildDashboardModel } from "@/lib/server/selectors/dashboard";
import { clearDerivedCache } from "@/lib/server/selectors/shell";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("fresh") === "1") clearDerivedCache();
  const model = buildDashboardModel({
    period: url.searchParams.get("period") || "today",
    route: url.searchParams.get("route") || "all",
    channel: url.searchParams.get("channel") || "all",
    confidence: url.searchParams.get("confidence") || "all",
    trafficClass: url.searchParams.get("trafficClass") || "client",
    client: url.searchParams.get("client") || "all",
    search: url.searchParams.get("search") || "",
  });
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    collector_run: model.collectorRun,
    collector_errors: model.collectorErrors,
    status_cards: model.statusCards,
    totals: model.totals,
    destination_attribution_coverage: model.destinationAttributionCoverage,
    dashboard_analytics: model.dashboardAnalytics,
    alerts: model.alerts,
  });
}
