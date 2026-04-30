import { NextRequest, NextResponse } from "next/server";
import { runOpsAction } from "@/lib/server/actions";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(runOpsAction(String(body.action || "")));
}
