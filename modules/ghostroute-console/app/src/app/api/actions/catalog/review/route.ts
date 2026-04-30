import { NextRequest, NextResponse } from "next/server";
import { reviewCatalog } from "@/lib/server/actions";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return NextResponse.json(reviewCatalog(String(body.domain || ""), String(body.decision || ""), String(body.reason || "")));
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
