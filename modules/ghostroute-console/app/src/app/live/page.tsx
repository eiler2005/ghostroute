import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { LiveStreamPanel } from "@/components/LiveStreamPanel";
import { bytes, ChannelBadge, EmptyState, Pagination, RouteBadge, shortDateTime, StatusBadge } from "@/components/Widgets";
import { buildLiveModel, listLiveEvents, listTrafficRows } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LivePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const eventsPage = Math.max(1, Number.parseInt(scalar(params.eventsPage) || "1", 10) || 1);
  const activityPage = Math.max(1, Number.parseInt(scalar(params.activityPage) || "1", 10) || 1);
  const liveEvents = listLiveEvents({ page: eventsPage, pageSize: 50, filters });
  const serviceEvents = listLiveEvents({ page: 1, pageSize: 50, filters: { ...filters, trafficClass: "service_background" } });
  const trafficPage = listTrafficRows({ page: activityPage, pageSize: 20, filters });
  const model = buildLiveModel(filters, trafficPage.rows);
  const activeFlows = trafficPage.rows;
  const activeClients = model.devices;
  const dnsRows = model.dnsQueries.slice(0, 8);
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "client" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };

  return (
    <ConsoleShell active="/live" model={model} filters={filters}>
      <div className="grid cards">
        <section className="card"><h3>Mode</h3><StatusBadge value="SSE" /><p>events snapshot with polling fallback</p></section>
        <section className="card"><h3>Freshness</h3><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`}</strong><p>{model.freshnessStatus}</p></section>
        <section className="card"><h3>Update</h3><strong>~10m</strong><p>Live events refresh cadence</p></section>
        <section className="card"><h3>Flows</h3><strong>{trafficPage.total}</strong><p>client activity rows</p></section>
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
            total_events: liveEvents.total,
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

      <section className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <div>
            <h2>Service/background live events</h2>
            <p>Служебные DNS/CDN/Apple/system события отдельно, чтобы не забивать клиентский live.</p>
          </div>
          <span className="subtle">показано {serviceEvents.rows.length} из {serviceEvents.total}</span>
        </div>
        {serviceEvents.rows.length === 0 ? (
          <EmptyState title="Нет service/background events" />
        ) : (
          <div className="live-feed">
            {serviceEvents.rows.map((row, idx) => (
              <div className="live-feed-row" key={`${row.event_type || "event"}-${row.id || idx}`}>
                <span>{shortDateTime(row.occurred_at)}</span>
                <strong>{row.event_type || "event"}</strong>
                <small>{row.origin || row.client || "System"} → {row.destinationLabel || row.destination || row.summary || "destination"}</small>
                <ChannelBadge value={row.channel} />
                <RouteBadge value={row.route || "Unknown"} />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <div>
              <h2>Client activity summary</h2>
              <p>Свежая выжимка по клиентам и трафику из последних snapshots; bytes зависят от confidence.</p>
            </div>
            <span className="subtle">последнее обновление {model.freshnessLabel || "n/a"}</span>
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
                  <tr key={row.id || idx}>
                    <td>{shortDateTime(row.event_ts || row.collected_at)}</td>
                    <td>{row.client}</td>
                    <td><ChannelBadge value={row.channel} /></td>
                    <td><Link href={`/traffic/${encodeURIComponent(row.id || `flow:${idx}`)}`}>{row.destinationLabel || row.destination}</Link></td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>{bytes(row.bytes || row.total_bytes || 0)}</td>
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
