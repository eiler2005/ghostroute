import { NextRequest, NextResponse } from "next/server";
import { catalogRollback } from "@/lib/server/actions";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(catalogRollback(String(body.rollback_ref || "")));
}
