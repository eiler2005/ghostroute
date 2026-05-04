import { NextRequest, NextResponse } from "next/server";
import { listAlarmEvents } from "@/lib/server/selectors";

function compact({ raw, evidence_json, ...row }: Record<string, any>) {
  return row;
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const result = listAlarmEvents({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || search.get("limit") || 25), 100),
    severity: search.get("severity") || "all",
    status: search.get("status") || "all",
    source: search.get("source") || "all",
    filters: {
      period: search.get("period") || "today",
      search: search.get("search") || "",
    },
  });
  return NextResponse.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    alarms: result.rows.map(compact),
  });
}
