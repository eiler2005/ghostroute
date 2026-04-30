import { NextRequest, NextResponse } from "next/server";
import { snoozeNotification } from "@/lib/server/actions";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(snoozeNotification(Number.parseInt(id, 10), Number(body.minutes || 60)));
}
