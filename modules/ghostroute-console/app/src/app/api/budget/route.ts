import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

function quotaBytes(bytesEnv: string, gbEnv: string) {
  const rawBytes = Number(process.env[bytesEnv] || 0);
  if (Number.isFinite(rawBytes) && rawBytes > 0) return rawBytes;
  const gb = Number(process.env[gbEnv] || 0);
  return Number.isFinite(gb) && gb > 0 ? gb * 1024 ** 3 : 0;
}

export async function GET() {
  const model = buildConsoleModel();
  return NextResponse.json({
    generated_at: model.generatedAt,
    freshness_minutes: model.freshnessMinutes,
    quotas: {
      vps_bytes: quotaBytes("GHOSTROUTE_CONSOLE_VPS_QUOTA_BYTES", "GHOSTROUTE_CONSOLE_VPS_QUOTA_GB"),
      lte_bytes: quotaBytes("GHOSTROUTE_CONSOLE_LTE_QUOTA_BYTES", "GHOSTROUTE_CONSOLE_LTE_QUOTA_GB"),
    },
    usage: {
      vps_bytes: model.totals.viaVpsBytes,
      direct_bytes: model.totals.directBytes,
      observed_bytes: model.totals.observedBytes,
    },
    clients: model.devices.slice(0, 50).map(({ raw, ...row }) => row),
  });
}
