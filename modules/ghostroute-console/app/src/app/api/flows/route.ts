import { NextRequest, NextResponse } from "next/server";
import { listTrafficRows } from "@/lib/server/selectors";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const page = Math.max(1, Number(search.get("page") || 1));
  const pageSize = Math.min(Number(search.get("pageSize") || search.get("limit") || 25), 100);
  const result = listTrafficRows({
    page,
    pageSize,
    diagnostics: search.get("diagnostics") === "1",
    filters: {
    route: search.get("route") || "all",
    channel: search.get("channel") || "all",
    confidence: search.get("confidence") || "all",
    client: search.get("client") || "all",
    search: search.get("search") || "",
    },
  });
  return NextResponse.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    flows: result.rows.map(({ raw, ...row }) => row),
  });
}
