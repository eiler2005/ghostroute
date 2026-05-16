import { NextResponse } from "next/server";
import { buildSettingsModel } from "@/lib/server/selectors/settings";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET() {
  const model = buildSettingsModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_status: model.freshnessStatus,
    runtime: model.runtime,
    routing_policy: model.routingPolicy || {},
    settings: model.settingsInventory || {},
  });
}
