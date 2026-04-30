import { ConsoleShell } from "@/components/ConsoleShell";
import { bytes, EmptyState, MetricCard, ProgressBar } from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function quotaBytes(bytesEnv: string, gbEnv: string) {
  const rawBytes = Number(process.env[bytesEnv] || 0);
  if (Number.isFinite(rawBytes) && rawBytes > 0) return rawBytes;
  const gb = Number(process.env[gbEnv] || 0);
  return Number.isFinite(gb) && gb > 0 ? gb * 1024 ** 3 : 0;
}

function pct(used: number, quota: number) {
  return quota > 0 ? Math.round((used / quota) * 100) : 0;
}

function tone(value: number) {
  if (value >= 100) return "crit";
  if (value >= 80) return "warn";
  return "ok";
}

function resetDay() {
  const value = Number(process.env.GHOSTROUTE_CONSOLE_BILLING_RESET_DAY || 1);
  return Number.isFinite(value) && value >= 1 && value <= 31 ? value : 1;
}

function dailyHistory(rows: Array<Record<string, any>>) {
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = String(row.hour_key || "").slice(0, 10) || "unknown";
    const current = byDay.get(day) || { VPS: 0, Direct: 0, Mixed: 0, Unknown: 0 };
    current[row.route || "Unknown"] = (current[row.route || "Unknown"] || 0) + Number(row.bytes || 0);
    byDay.set(day, current);
  }
  return Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-31);
}

export default async function BudgetPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const vpsQuota = quotaBytes("GHOSTROUTE_CONSOLE_VPS_QUOTA_BYTES", "GHOSTROUTE_CONSOLE_VPS_QUOTA_GB");
  const lteQuota = quotaBytes("GHOSTROUTE_CONSOLE_LTE_QUOTA_BYTES", "GHOSTROUTE_CONSOLE_LTE_QUOTA_GB");
  const vpsUsed = model.totals.viaVpsBytes;
  const directUsed = model.totals.directBytes;
  const vpsPct = pct(vpsUsed, vpsQuota);
  const ltePct = pct(directUsed, lteQuota);
  const top = [...model.devices].sort((a, b) => (b.total_bytes || 0) - (a.total_bytes || 0))[0];
  const forecastVps = model.freshnessMinutes === null ? vpsUsed : Math.round(vpsUsed * 1.08);
  const history = dailyHistory(model.hourlyTraffic);
  const avgDailyVps = history.length ? Math.round(history.reduce((sum, [, row]) => sum + (row.VPS || 0), 0) / history.length) : 0;
  const daysLeft = Math.max(1, 31 - new Date().getUTCDate());
  const trendForecast = vpsUsed + avgDailyVps * daysLeft;

  return (
    <ConsoleShell active="/budget" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <MetricCard label="VPS traffic" value={bytes(vpsUsed)} detail={vpsQuota ? `${vpsPct}% of ${bytes(vpsQuota)}` : "quota env not set"} />
        <MetricCard label="LTE / direct reserve" value={bytes(directUsed)} detail={lteQuota ? `${ltePct}% of ${bytes(lteQuota)}` : "quota env not set"} />
        <MetricCard label="Forecast" value={bytes(Math.max(forecastVps, trendForecast))} detail={`reset day ${resetDay()}`} />
        <MetricCard label="Largest consumer" value={top?.label || "n/a"} detail={top ? bytes(top.total_bytes || 0) : "no factual devices"} />
        <MetricCard label="Freshness" value={model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`} detail={model.freshnessStatus} />
        <MetricCard label="Alerts" value={String(model.alerts.length)} detail="read-only signals" />
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Потребление по устройствам</h2>
          {model.devices.length === 0 ? (
            <EmptyState title="Нет фактических traffic snapshots" />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Device</th><th>VPS</th><th>Direct</th><th>Total</th><th>Share</th></tr>
              </thead>
              <tbody>
                {model.devices.map((row) => {
                  const share = model.totals.observedBytes > 0 ? Math.round(((row.total_bytes || 0) / model.totals.observedBytes) * 100) : 0;
                  return (
                    <tr key={row.id || row.label}>
                      <td>{row.label || row.id}</td>
                      <td>{bytes(row.via_vps_bytes || 0)}</td>
                      <td>{bytes(row.direct_bytes || 0)}</td>
                      <td>{bytes(row.total_bytes || 0)}</td>
                      <td>{share}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <aside className="card side-panel">
          <h2>Пороги и прогноз</h2>
          <div className="detail-list">
            <div className="detail-row"><span>VPS quota</span><strong>{vpsQuota ? bytes(vpsQuota) : "not set"}</strong></div>
            {vpsQuota ? <ProgressBar value={vpsPct} tone={tone(vpsPct)} /> : null}
            <div className="detail-row"><span>LTE/direct quota</span><strong>{lteQuota ? bytes(lteQuota) : "not set"}</strong></div>
            {lteQuota ? <ProgressBar value={ltePct} tone={tone(ltePct)} /> : null}
            <div className="detail-row"><span>Forecast VPS</span><strong>{bytes(forecastVps)}</strong></div>
            <div className="detail-row"><span>Trend forecast</span><strong>{bytes(trendForecast)}</strong></div>
            <div className="detail-row"><span>Reset day</span><strong>{resetDay()}</strong></div>
            <div className="detail-row"><span>Provider billing API</span><strong>{process.env.GHOSTROUTE_PROVIDER_BILLING_ENABLED === "1" ? "enabled" : "disabled"}</strong></div>
            <div className="detail-row"><span>Notification actions</span><strong>post-MVP</strong></div>
          </div>
        </aside>
      </div>
      <section className="card" style={{ marginTop: 14 }}>
        <h2>Daily history</h2>
        <div className="detail-list">
          {history.length === 0 ? (
            <div className="subtle">No hourly aggregates yet.</div>
          ) : (
            history.map(([day, row]) => (
              <div className="detail-row" key={day}>
                <span>{day}</span>
                <strong>VPS {bytes(row.VPS || 0)} / Direct {bytes(row.Direct || 0)} / LTE reserve {bytes(row.Mixed || 0)}</strong>
              </div>
            ))
          )}
        </div>
      </section>
    </ConsoleShell>
  );
}
