import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const clients = buildConsoleModel().devices;
  return NextResponse.json({
    total: clients.length,
    clients: clients.map(({ raw, ...row }) => row),
  });
}
