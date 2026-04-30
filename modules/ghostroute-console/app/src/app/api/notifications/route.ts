import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    total: model.notifications.length,
    notifications: model.notifications.slice(0, 100).map(({ raw, evidence_json, ...row }) => row),
  });
}
