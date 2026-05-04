import { NextResponse } from "next/server";
import { buildDashboardModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildDashboardModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    freshness_status: model.freshnessStatus,
    collector_run: model.collectorRun,
    collector_errors: model.collectorErrors,
    status_cards: model.statusCards,
    totals: model.totals,
    alerts: model.alerts,
  });
}
