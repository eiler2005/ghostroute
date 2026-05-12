import { NextRequest, NextResponse } from "next/server";
import { listClientInventory } from "@/lib/server/selectors/clients";
import { clearDerivedCache } from "@/lib/server/selectors/shell";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  if (search.get("fresh") === "1") clearDerivedCache();
  const result = listClientInventory({
    page: Math.max(1, Number(search.get("page") || 1)),
    pageSize: Math.min(Number(search.get("pageSize") || 25), 100),
    filters: {
      period: search.get("period") || "today",
      route: search.get("route") || "all",
      channel: search.get("channel") || "all",
      confidence: search.get("confidence") || "all",
      trafficClass: search.get("trafficClass") || "all",
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
