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

  return (
    <ConsoleShell active="/budget" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <MetricCard label="VPS traffic" value={bytes(vpsUsed)} detail={vpsQuota ? `${vpsPct}% of ${bytes(vpsQuota)}` : "quota env not set"} />
        <MetricCard label="LTE / direct reserve" value={bytes(directUsed)} detail={lteQuota ? `${ltePct}% of ${bytes(lteQuota)}` : "quota env not set"} />
        <MetricCard label="Forecast" value={bytes(forecastVps)} detail="current snapshot trend" />
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
            <div className="detail-row"><span>Provider billing API</span><strong>disabled</strong></div>
            <div className="detail-row"><span>Notification actions</span><strong>post-MVP</strong></div>
          </div>
        </aside>
      </div>
    </ConsoleShell>
  );
}
