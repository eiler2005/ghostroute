import { NextResponse } from "next/server";
import { buildHealthModel } from "@/lib/server/selectors/health";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET() {
  const model = buildHealthModel();
  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    snapshots: Object.values(model.snapshots).filter(Boolean).length,
    freshness_minutes: model.freshnessMinutes,
    runtime: model.runtime,
  });
}
