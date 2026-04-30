import { NextResponse } from "next/server";
import { catalogDryRun } from "@/lib/server/actions";

export async function POST() {
  return NextResponse.json(catalogDryRun());
}
