import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { LiveStreamPanel } from "@/components/LiveStreamPanel";
import { bytes, ChannelBadge, EmptyState, Pagination, RouteBadge, StatusBadge } from "@/components/Widgets";
import { buildRouteEvidenceSet } from "@/lib/server/evidence";
import { buildPagedEvidenceContext, listClientInventory, listLiveEvents, listTrafficRows } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LivePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const eventsPage = Math.max(1, Number.parseInt(scalar(params.eventsPage) || "1", 10) || 1);
  const activityPage = Math.max(1, Number.parseInt(scalar(params.activityPage) || "1", 10) || 1);
  const liveEvents = listLiveEvents({ page: eventsPage, pageSize: 25, filters });
  const trafficPage = listTrafficRows({ page: activityPage, pageSize: 20, filters });
  const model = buildPagedEvidenceContext(filters, trafficPage.rows);
  const evidenceSet = buildRouteEvidenceSet(model, { limit: 20, fallbackToDiagnostics: false });
  const activeFlows = evidenceSet.evidences;
  const activeClients = listClientInventory({ page: 1, pageSize: 10, filters }).rows;
  const dnsRows = model.dnsQueries.slice(0, 8);
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };

  return (
    <ConsoleShell active="/live" model={model} filters={filters}>
      <div className="grid cards">
        <section className="card"><h3>Mode</h3><StatusBadge value="SSE" /><p>real log tail with polling fallback</p></section>
        <section className="card"><h3>Freshness</h3><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`}</strong><p>{model.freshnessStatus}</p></section>
        <section className="card"><h3>Flows</h3><strong>{trafficPage.total}</strong><p>operator rows</p></section>
        <section className="card"><h3>Clients</h3><strong>{activeClients.length}</strong><p>top observed devices</p></section>
        <section className="card"><h3>DNS</h3><strong>{model.dnsQueries.length}</strong><p>DNS-interest rows</p></section>
        <section className="card"><h3>Alerts</h3><strong>{model.alerts.length}</strong><p>open signals</p></section>
      </div>

      <div style={{ marginTop: 14 }}>
        <LiveStreamPanel
          initial={{
            generated_at: model.generatedAt,
            freshness_status: model.freshnessStatus,
            events: liveEvents.rows,
            route_decisions: [],
            alerts: model.alerts.slice(0, 20).map(({ raw, ...row }) => row),
          }}
        />
        <Pagination
          basePath="/live"
          page={liveEvents.page}
          pageParam="eventsPage"
          pageSize={liveEvents.pageSize}
          total={liveEvents.total}
          totalPages={liveEvents.totalPages}
          extraParams={{ ...filterParams, eventsPage: liveEvents.page, activityPage: trafficPage.page }}
        />
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Live activity</h2>
            <span className="subtle">latest factual flow and tail rows</span>
          </div>
          {activeFlows.length === 0 ? (
            <EmptyState title="Нет activity snapshot" />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Time</th><th>Client</th><th>Channel</th><th>Destination</th><th>Route</th><th>Traffic</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {activeFlows.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.eventTimeLabel}</td>
                    <td>{row.client}</td>
                    <td><ChannelBadge value={row.channel} /></td>
                    <td><Link href={`/traffic?flow=${idx}`}>{row.destination}</Link></td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>{bytes(row.bytes)}</td>
                    <td>{row.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pagination
            basePath="/live"
            page={trafficPage.page}
            pageParam="activityPage"
            pageSize={trafficPage.pageSize}
            total={trafficPage.total}
            totalPages={trafficPage.totalPages}
            extraParams={{ ...filterParams, activityPage: trafficPage.page, eventsPage: liveEvents.page }}
          />
        </section>

        <aside className="card side-panel">
          <h2>Active clients</h2>
          {activeClients.length === 0 ? (
            <EmptyState title="Нет активных клиентов" />
          ) : (
            <div className="detail-list">
              {activeClients.map((row) => (
                <div className="detail-row" key={row.id || row.label}>
                  <span>{row.label || row.id}</span>
                  <strong>{bytes(row.total_bytes || 0)}</strong>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      <div className="grid three" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>Topology</h2>
          <div className="live-topology">
            <span>Clients</span>
            <i />
            <span>Router</span>
            <i className="active" />
            <span>VPS</span>
            <i />
            <span>Internet</span>
          </div>
          <div className="detail-list" style={{ marginTop: 12 }}>
            <div className="detail-row"><span>VPS</span><strong>{bytes(model.totals.viaVpsBytes)}</strong></div>
            <div className="detail-row"><span>Direct</span><strong>{bytes(model.totals.directBytes)}</strong></div>
          </div>
        </section>
        <section className="card">
          <h2>DNS interest</h2>
          {dnsRows.length === 0 ? (
            <EmptyState title="Нет DNS rows" />
          ) : (
            <div className="detail-list">
              {dnsRows.map((row, idx) => (
                <div className="detail-row" key={idx}><span>{row.domain}</span><strong>{row.count || 1}</strong></div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <h2>Warnings</h2>
          {model.alerts.length === 0 ? (
            <EmptyState title="Нет предупреждений" />
          ) : (
            <div className="detail-list">
              {model.alerts.slice(0, 5).map((row, idx) => (
                <div className="detail-row" key={idx}><span>{row.title}</span><strong>{row.severity}</strong></div>
              ))}
            </div>
          )}
        </section>
      </div>
    </ConsoleShell>
  );
}
