import { NextResponse } from "next/server";
import { ackNotification } from "@/lib/server/actions";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(ackNotification(Number.parseInt(id, 10)));
}
