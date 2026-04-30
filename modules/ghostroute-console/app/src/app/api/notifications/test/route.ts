import { NextResponse } from "next/server";
import { testNotification } from "@/lib/server/actions";

export async function POST() {
  return NextResponse.json(testNotification());
}
