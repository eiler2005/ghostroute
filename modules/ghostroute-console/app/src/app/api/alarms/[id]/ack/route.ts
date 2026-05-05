import { NextResponse } from "next/server";
import { setAlarmStatus } from "@/lib/server/actions";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(setAlarmStatus(decodeURIComponent(id), "ack"));
}
