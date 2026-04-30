import { NextResponse } from "next/server";
import { buildConsoleModel } from "@/lib/server/selectors";

function quotaBytes(bytesEnv: string, gbEnv: string) {
  const rawBytes = Number(process.env[bytesEnv] || 0);
  if (Number.isFinite(rawBytes) && rawBytes > 0) return rawBytes;
  const gb = Number(process.env[gbEnv] || 0);
  return Number.isFinite(gb) && gb > 0 ? gb * 1024 ** 3 : 0;
}

function dailyHistory(rows: Array<Record<string, any>>) {
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = String(row.hour_key || "").slice(0, 10) || "unknown";
    const current = byDay.get(day) || { VPS: 0, Direct: 0, Mixed: 0, Unknown: 0 };
    current[row.route || "Unknown"] = (current[row.route || "Unknown"] || 0) + Number(row.bytes || 0);
    byDay.set(day, current);
  }
  return Array.from(byDay.entries()).map(([day, routes]) => ({ day, routes }));
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
    history: {
      hourly: model.hourlyTraffic,
      daily: dailyHistory(model.hourlyTraffic),
      reset_day: Number(process.env.GHOSTROUTE_CONSOLE_BILLING_RESET_DAY || 1),
      provider_billing_enabled: process.env.GHOSTROUTE_PROVIDER_BILLING_ENABLED === "1",
    },
    clients: model.devices.slice(0, 50).map(({ raw, ...row }) => row),
  });
}
