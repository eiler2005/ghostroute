import { NextRequest, NextResponse } from "next/server";
import { listDnsQueryLog } from "@/lib/server/selectors";

function compact({ raw, evidence_json, ...row }: Record<string, any>) {
  return row;
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const result = listDnsQueryLog({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || search.get("limit") || 100), 1000),
    status: search.get("status") || "all",
    catalogStatus: search.get("catalogStatus") || "all",
    filters: {
      period: search.get("period") || "today",
      route: search.get("route") || "all",
      channel: search.get("channel") || "all",
      confidence: search.get("confidence") || "all",
      trafficClass: "all",
      client: search.get("client") || "all",
      search: search.get("search") || "",
    },
  });
  return NextResponse.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    queries: result.rows.map(compact),
  });
}
