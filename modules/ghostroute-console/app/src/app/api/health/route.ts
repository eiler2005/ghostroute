import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    snapshots: Object.values(model.snapshots).filter(Boolean).length,
    freshness_minutes: model.freshnessMinutes,
  });
}
