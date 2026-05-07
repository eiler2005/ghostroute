import { NextResponse } from "next/server";
import { buildSettingsModel } from "@/lib/server/selectors/settings";

export async function GET() {
  const model = buildSettingsModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_status: model.freshnessStatus,
    runtime: model.runtime,
    settings: model.settingsInventory || {},
  });
}
