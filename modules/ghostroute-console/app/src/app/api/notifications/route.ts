import { NextResponse } from "next/server";
import { notifications } from "@/lib/server/store";

export async function GET() {
  const rows = notifications(100) as Array<Record<string, any>>;
  return NextResponse.json({
    total: rows.length,
    notifications: rows.map(({ raw, evidence_json, ...row }) => row),
  });
}
