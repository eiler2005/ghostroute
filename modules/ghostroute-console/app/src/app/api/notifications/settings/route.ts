import { NextRequest, NextResponse } from "next/server";
import { saveNotificationSettings } from "@/lib/server/actions";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  return NextResponse.json(buildConsoleModel().notificationSettings);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(saveNotificationSettings(body));
}
