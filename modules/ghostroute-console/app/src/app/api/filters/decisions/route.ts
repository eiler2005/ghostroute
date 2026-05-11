import { NextRequest, NextResponse } from "next/server";
import { listFilterDecisions } from "@/lib/filters/rules";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET(request: NextRequest) {
  const limit = Math.min(250, Math.max(1, Number(request.nextUrl.searchParams.get("limit") || 100)));
  const offset = Math.max(0, Number(request.nextUrl.searchParams.get("offset") || 0));
  const decisions = listFilterDecisions(limit, offset);
  return NextResponse.json({ total: decisions.length, limit, offset, decisions });
}

function mutationDisabled() {
  return NextResponse.json({ error: "filter mutation API ships in the next refactor" }, { status: 405 });
}

export const POST = mutationDisabled;
export const PUT = mutationDisabled;
export const DELETE = mutationDisabled;
