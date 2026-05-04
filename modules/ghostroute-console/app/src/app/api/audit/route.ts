import { NextResponse } from "next/server";
import { auditLog, opsRuns } from "@/lib/server/store";

export async function GET() {
  const rows = auditLog(100) as Array<Record<string, any>>;
  const runs = opsRuns(50) as Array<Record<string, any>>;
  return NextResponse.json({
    total: rows.length,
    audit_log: rows,
    ops_runs: runs,
  });
}
