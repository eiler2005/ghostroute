import { NextRequest, NextResponse } from "next/server";
import { listClientInventory } from "@/lib/server/selectors";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const result = listClientInventory({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || 25), 100),
    filters: {
      route: search.get("route") || "all",
      channel: search.get("channel") || "all",
      confidence: search.get("confidence") || "all",
      trafficClass: search.get("trafficClass") || "client",
      client: search.get("client") || "all",
      search: search.get("search") || "",
    },
  });
  return NextResponse.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    clients: result.rows.map((row: any) => {
      const { raw, ...rest } = row;
      return rest;
    }),
  });
}
