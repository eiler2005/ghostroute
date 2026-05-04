import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { bytes, ConfidenceBadge, EmptyState, MetricCard, RouteBadge, StatusBadge } from "@/components/Widgets";
import { buildDashboardModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { groupAttributionRows, groupDestinationRows, trafficDisplayDestination } from "@/lib/traffic-window.mjs";

function share(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

export default async function Dashboard({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildDashboardModel(filters);
  const total = model.totals.observedBytes || 1;
  const trafficWindow = [model.totals.periodLabel, model.totals.windowLabel].filter(Boolean).join(" · ");
  const trafficWindowText = trafficWindow || "сегодня, окно не указано";
  const topClients = [...model.devices].sort((a, b) => (b.total_bytes || 0) - (a.total_bytes || 0)).slice(0, 8);
  const clientTrafficRows = [...model.flows]
    .filter((row) => row.trafficClass === "client" && Number(row.bytes || row.total_bytes || 0) > 0)
    .sort((a, b) => (b.bytes || b.total_bytes || 0) - (a.bytes || a.total_bytes || 0));
  const topDestinations = groupDestinationRows(clientTrafficRows, 8);
  const serviceTraffic = [...model.flows]
    .filter((row) => row.trafficClass === "service_background" && Number(row.bytes || row.total_bytes || 0) > 0)
    .sort((a, b) => (b.bytes || b.total_bytes || 0) - (a.bytes || a.total_bytes || 0))
    .slice(0, 5);
  const needsAttribution = groupAttributionRows(
    model.flows.filter((row) => row.trafficClass === "unclassified" && Number(row.bytes || row.total_bytes || 0) > 0),
    10
  );
  const latestDecisions = clientTrafficRows.slice(0, 8);

  return (
    <ConsoleShell active="/" model={model} filters={filters}>
      <div className="grid cards">
        {model.statusCards.map((card) => (
          <section className="card" key={card.label}>
            <h3>{card.label}</h3>
            <StatusBadge value={card.status} />
            <p>{card.detail}</p>
          </section>
        ))}
      </div>

      <div className="grid three" style={{ marginTop: 14 }}>
        <MetricCard label="Observed traffic" value={bytes(model.totals.observedBytes)} detail={`Данные за ${trafficWindowText} · обновление около 5 минут`} />
        <MetricCard label="Via VPS" value={bytes(model.totals.viaVpsBytes)} detail={`${share(model.totals.viaVpsBytes, total)}% observed · current-day KPI`} />
        <MetricCard label="Direct" value={bytes(model.totals.directBytes)} detail={`${share(model.totals.directBytes, total)}% observed · current-day KPI`} />
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Operator overview</h2>
            <span className={`freshness freshness-${model.freshnessStatus}`}>{model.freshnessStatus}</span>
          </div>
          <div className="detail-list">
            <div className="detail-row"><span>Latest snapshot</span><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m ago`}</strong></div>
            <div className="detail-row"><span>Collector run</span><strong>{model.collectorRun ? `${model.collectorRun.ok_count}/${Number(model.collectorRun.ok_count || 0) + Number(model.collectorRun.error_count || 0)} ok` : "n/a"}</strong></div>
            <div className="detail-row"><span>Open alerts</span><strong>{model.alerts.length}</strong></div>
            <div className="detail-row"><span>Route split</span><strong>{share(model.totals.viaVpsBytes, total)}% VPS / {share(model.totals.directBytes, total)}% direct</strong></div>
          </div>
        </section>
        <section className="card">
          <h2>Warnings</h2>
          {model.alerts.length === 0 ? (
            <EmptyState title="Нет активных предупреждений" />
          ) : (
            <div className="detail-list">
              {model.alerts.slice(0, 8).map((alert, idx) => (
                <div className="detail-row" key={idx}>
                  <span>
                    {alert.title}
                    {alert.detail ? <small className="subtle block-detail">{alert.detail}</small> : null}
                  </span>
                  <strong>{alert.severity}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Top clients</h2>
            <Link className="muted-button" href="/clients">Open clients</Link>
          </div>
          {topClients.length === 0 ? (
            <EmptyState title="Нет фактических устройств" />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Client</th><th>Total</th><th>VPS</th><th>Direct</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {topClients.map((row) => (
                  <tr key={row.id || row.label}>
                    <td><Link href={`/clients?client=${encodeURIComponent(row.label || row.id)}`}>{row.label || row.id}</Link></td>
                    <td>{bytes(row.total_bytes || 0)}</td>
                    <td>{bytes(row.via_vps_bytes || 0)}</td>
                    <td>{bytes(row.direct_bytes || 0)}</td>
                    <td><ConfidenceBadge value={row.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="toolbar">
            <h2>Top destinations</h2>
            <Link className="muted-button" href="/traffic?trafficClass=client">Open traffic</Link>
          </div>
          {topDestinations.length === 0 ? (
            <EmptyState title="Нет destination snapshots" />
          ) : (
            <div className="detail-list">
              {topDestinations.map((row, idx) => (
                <div className="detail-row" key={idx}>
                  <span>
                    {trafficDisplayDestination(row)}
                    {row.detail ? <small className="subtle block-detail">{row.detail}</small> : null}
                  </span>
                  <strong>{bytes(row.bytes || row.total_bytes || 0)} <RouteBadge value={row.route} /></strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <h2>Client traffic snapshot rows</h2>
          <span className="subtle">current traffic window, sorted by volume</span>
        </div>
        {latestDecisions.length === 0 ? (
          <EmptyState title="Нет client traffic rows" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Client</th><th>Destination</th><th>Route</th><th>Traffic</th><th>Confidence</th></tr>
            </thead>
            <tbody>
              {latestDecisions.map((row, idx) => (
                <tr key={idx}>
                  <td>{row.client || row.channel || "n/a"}</td>
                  <td><Link href={`/traffic?flow=${idx}`}>{trafficDisplayDestination(row)}</Link></td>
                  <td><RouteBadge value={row.route} /></td>
                  <td>{bytes(row.bytes || row.total_bytes || 0)}</td>
                  <td><ConfidenceBadge value={row.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Service/background traffic</h2>
            <Link className="muted-button" href="/traffic?trafficClass=service_background">Open service</Link>
          </div>
          {serviceTraffic.length === 0 ? (
            <EmptyState title="Нет service/background traffic rows" />
          ) : (
            <div className="detail-list">
              {serviceTraffic.map((row, idx) => (
                <div className="detail-row" key={idx}>
                  <span>{trafficDisplayDestination(row)}</span>
                  <strong>{bytes(row.bytes || row.total_bytes || 0)} <RouteBadge value={row.route} /></strong>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <div className="toolbar">
            <h2>Needs attribution</h2>
            <Link className="muted-button" href="/traffic?trafficClass=unclassified">Open unknown</Link>
          </div>
          {needsAttribution.length === 0 ? (
            <EmptyState title="Нет unclassified traffic rows" />
          ) : (
            <div className="detail-list">
              {needsAttribution.map((row, idx) => (
                <div className="detail-row" key={idx}>
                  <span>
                    {trafficDisplayDestination(row)}
                    {row.attributionDetail ? <small className="subtle block-detail">{row.attributionDetail}</small> : null}
                  </span>
                  <strong>{bytes(row.bytes || row.total_bytes || 0)} <RouteBadge value={row.route} /></strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

    </ConsoleShell>
  );
}
