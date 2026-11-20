import { NextRequest, NextResponse } from "next/server";
import { saveNotificationSettings } from "@/lib/server/actions";
import { notificationSettings } from "@/lib/server/store";

export async function GET() {
  return NextResponse.json(notificationSettings());
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(saveNotificationSettings(body));
}
