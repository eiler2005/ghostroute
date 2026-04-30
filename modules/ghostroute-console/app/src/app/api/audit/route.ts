import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    total: model.auditLog.length,
    audit_log: model.auditLog,
    ops_runs: model.opsRuns,
  });
}
