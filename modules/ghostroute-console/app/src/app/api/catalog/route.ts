import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const catalog = buildConsoleModel().catalog;
  return NextResponse.json({
    total: catalog.length,
    limit: 250,
    catalog: catalog.slice(0, 250).map(({ raw, ...row }) => row),
  });
}
