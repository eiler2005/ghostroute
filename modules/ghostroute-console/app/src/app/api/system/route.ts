import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    status_cards: model.statusCards,
    health: model.snapshots.health?.payload || null,
    leaks: model.snapshots.leaks?.payload || null,
  });
}
