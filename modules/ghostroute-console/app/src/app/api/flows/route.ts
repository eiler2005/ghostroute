import { NextRequest, NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const limit = Math.min(Number(search.get("limit") || 50), 250);
  const model = buildConsoleModel({
    route: search.get("route") || "all",
    confidence: search.get("confidence") || "all",
    client: search.get("client") || "all",
    search: search.get("search") || "",
  });
  return NextResponse.json({
    total: model.flows.length,
    limit,
    flows: model.flows.slice(0, limit).map(({ raw, ...row }) => row),
  });
}
