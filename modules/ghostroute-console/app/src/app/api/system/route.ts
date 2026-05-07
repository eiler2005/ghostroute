import { NextResponse } from "next/server";
import { buildShellModel } from "@/lib/server/selectors/shell";

export async function GET() {
  const model = buildShellModel();
  return NextResponse.json({
    status_cards: model.statusCards,
    health: model.snapshots.health?.payload || null,
    leaks: model.snapshots.leaks?.payload || null,
  });
}
