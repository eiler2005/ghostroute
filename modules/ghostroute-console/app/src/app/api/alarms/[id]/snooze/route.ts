import { NextRequest, NextResponse } from "next/server";
import { setAlarmStatus } from "@/lib/server/actions";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(setAlarmStatus(decodeURIComponent(id), "snooze", Number(body.minutes || 60)));
}
