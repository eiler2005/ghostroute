import { NextRequest, NextResponse } from "next/server";
import { catalogApply } from "@/lib/server/actions";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(catalogApply(String(body.confirmation || "")));
}
