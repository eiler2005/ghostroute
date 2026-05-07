import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { LiveStreamPanel } from "@/components/LiveStreamPanel";
import { bytes, ChannelBadge, EmptyState, Pagination, RouteBadge, timeWithMillis } from "@/components/Widgets";
import { buildLiveModel, listFlowSessions, listLiveEvents } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function hrefWithParams(path: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export default async function LivePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const eventsPage = Math.max(1, Number.parseInt(scalar(params.eventsPage) || "1", 10) || 1);
  const eventsPageSize = Math.min(1000, Math.max(100, Number.parseInt(scalar(params.eventsPageSize) || "150", 10) || 150));
  const servicePage = Math.max(1, Number.parseInt(scalar(params.servicePage) || "1", 10) || 1);
  const servicePageSize = Math.min(1000, Math.max(100, Number.parseInt(scalar(params.servicePageSize) || "150", 10) || 150));
  const activityPage = Math.max(1, Number.parseInt(scalar(params.activityPage) || "1", 10) || 1);
  const activityPageSize = Math.min(150, Math.max(150, Number.parseInt(scalar(params.activityPageSize) || "150", 10) || 150));
  const liveEvents = listLiveEvents({ page: eventsPage, pageSize: eventsPageSize, filters });
  const serviceEvents = listLiveEvents({ page: servicePage, pageSize: servicePageSize, filters: { ...filters, trafficClass: "service_background" } });
  const trafficPage = listFlowSessions({ page: activityPage, pageSize: activityPageSize, maxPageSize: 150, maxRows: 4500, filters });
  const model = buildLiveModel(filters, trafficPage.rows);
  const activeFlows = trafficPage.rows;
  const activeClients = model.devices;
  const dnsRows = model.dnsQueries.slice(0, 8);
  const serviceRows = serviceEvents.rows.length > 0
    ? serviceEvents.rows
    : model.dnsQueries.slice((servicePage - 1) * servicePageSize, servicePage * servicePageSize).map((row, idx) => ({
        id: `dns-service:${row.id || idx}`,
        event_type: "dns.query",
        occurred_at: row.event_ts || row.collected_at,
        origin: row.client || row.client_ip || "Router DNS service",
        client: row.client || "",
        summary: row.domain || row.answer_ip || "",
        destination: row.domain || row.dns_qname || row.answer_ip || "",
        destinationLabel: row.domain || row.dns_qname || row.answer_ip,
        channel: row.channel || "Service/background",
        route: row.route || "Unknown",
      }));
  const serviceTotal = serviceEvents.rows.length > 0 ? serviceEvents.total : model.dnsQueries.length;
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
    eventsPageSize,
    servicePageSize,
    activityPageSize,
  };
  const liveStreamHref = hrefWithParams("/api/live/stream", {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass || "all",
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
    page: liveEvents.page,
    pageSize: liveEvents.pageSize,
  });
  const liveEventsPagination = (
    <Pagination
      basePath="/live"
      page={liveEvents.page}
      pageParam="eventsPage"
      pageSizeParam="eventsPageSize"
      pageSize={liveEvents.pageSize}
      total={liveEvents.total}
      totalPages={liveEvents.totalPages}
      extraParams={{ ...filterParams, activityPage: trafficPage.page, servicePage }}
    />
  );

  return (
    <ConsoleShell active="/live" model={model} filters={filters}>
      <div className="grid live-kpis">
        <section className="card compact-kpi"><h3>Mode</h3><strong className="kpi-pill">SSE</strong><p>events snapshot with polling fallback</p></section>
        <section className="card compact-kpi"><h3>Freshness</h3><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`}</strong><p>{model.freshnessStatus}</p></section>
        <section className="card compact-kpi"><h3>Update</h3><strong>~10m</strong><p>Live events refresh cadence</p></section>
        <section className="card compact-kpi"><h3>Flows</h3><strong>{trafficPage.total}</strong><p>client activity rows</p></section>
        <section className="card compact-kpi"><h3>Clients</h3><strong>{activeClients.length}</strong><p>top observed devices</p></section>
        <section className="card compact-kpi"><h3>DNS</h3><strong>{model.dnsQueries.length}</strong><p>DNS-interest rows</p></section>
        <section className="card compact-kpi"><h3>Alerts</h3><strong>{model.alerts.length}</strong><p>open signals</p></section>
      </div>

      <div className="live-primary">
        <LiveStreamPanel
          initial={{
            generated_at: model.generatedAt,
            freshness_status: model.freshnessStatus,
            events: liveEvents.rows,
            total_events: liveEvents.total,
            route_decisions: [],
            alerts: model.alerts.slice(0, 20).map(({ raw, ...row }) => row),
          }}
          visibleCount={eventsPageSize}
          streamHref={liveStreamHref}
        />
        <div className="live-card-footer live-primary-footer">
          {liveEventsPagination}
        </div>
      </div>

      <section className="card live-stream-card service-events-card">
        <div className="live-stream-toolbar">
          <div className="live-stream-title">
            <h2>Service/background live events</h2>
            <span>показано {serviceRows.length} из {serviceTotal}</span>
          </div>
        </div>
        <div className="live-stream-meta">Служебные DNS/CDN/Apple/system события отдельно, чтобы не забивать клиентский live.</div>
        {serviceRows.length === 0 ? (
          <EmptyState title="Нет service/background events" />
        ) : (
          <div className="live-table-wrap service-table-wrap">
            <table className="live-events-table service-events-table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Событие</th>
                  <th>Маршрут / Назначение</th>
                  <th>Клиент</th>
                  <th>Канал / Route</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {serviceRows.map((row, idx) => {
                  const eventType = row.event_type || "event";
                  const origin = row.origin || row.client || "System";
                  const destination = row.destinationLabel || row.destination || row.summary || "destination";
                  const clientIp = (row as Record<string, any>).client_ip;
                  return (
                    <tr key={`${eventType}-${row.id || idx}`}>
                      <td className="live-col-time">{timeWithMillis(row.occurred_at)}</td>
                      <td className="live-col-event">
                        <span className={`event-dot event-${String(eventType).split(".")[0]}`} />
                        <strong>{eventType}</strong>
                      </td>
                      <td className="live-col-destination">
                        <span>{origin}</span>
                        <i>→</i>
                        <strong>{destination}</strong>
                      </td>
                      <td className="live-col-client">{row.client || clientIp || "service/background"}</td>
                      <td className="live-col-route route-stack">
                        <ChannelBadge value={row.channel} />
                        <RouteBadge value={row.route || "Unknown"} />
                      </td>
                      <td className="live-col-status status-text-ok">OK</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="live-card-footer">
          <Pagination
            basePath="/live"
            page={servicePage}
            pageParam="servicePage"
            pageSizeParam="servicePageSize"
            pageSize={servicePageSize}
            total={serviceTotal}
            totalPages={Math.max(1, Math.ceil(serviceTotal / servicePageSize))}
            extraParams={{ ...filterParams, eventsPage: liveEvents.page, activityPage: trafficPage.page }}
          />
        </div>
      </section>

      <div className="grid two live-secondary-grid">
        <section className="card live-stream-card client-activity-card">
          <div className="live-stream-toolbar">
            <div className="live-stream-title">
              <h2>Client activity summary</h2>
              <span>показано {activeFlows.length} из {trafficPage.total}</span>
            </div>
            <span className="subtle">последнее обновление {model.freshnessLabel || "n/a"}</span>
          </div>
          <div className="live-stream-meta">Свежая выжимка по клиентам и трафику из последних snapshots; bytes зависят от confidence.</div>
          {activeFlows.length === 0 ? (
            <EmptyState title="Нет activity snapshot" />
          ) : (
            <div className="live-table-wrap client-activity-table-wrap">
              <table className="live-events-table client-activity-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Client</th>
                    <th>Channel</th>
                    <th>Destination</th>
                    <th>Route</th>
                    <th>Traffic</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {activeFlows.map((row, idx) => (
                    <tr key={row.id || idx}>
                      <td className="live-col-time">{timeWithMillis(row.last_seen || row.event_ts || row.collected_at)}</td>
                      <td className="live-col-client" title={row.client}>{row.client}</td>
                      <td className="activity-col-channel"><ChannelBadge value={row.channel} /></td>
                      <td className="live-col-destination" title={row.destinationLabel || row.destination}>
                        <Link href={`/traffic/${encodeURIComponent(row.id || `flow:${idx}`)}`}>{row.destinationLabel || row.destination}</Link>
                      </td>
                      <td className="live-col-route"><RouteBadge value={row.route} /></td>
                      <td className="activity-col-traffic">{bytes(row.bytes || row.total_bytes || 0)}</td>
                      <td className="activity-col-confidence">{row.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="live-card-footer">
            <Pagination
              basePath="/live"
              page={trafficPage.page}
              pageParam="activityPage"
              pageSizeParam="activityPageSize"
              pageSize={trafficPage.pageSize}
              total={trafficPage.total}
              totalPages={trafficPage.totalPages}
              extraParams={{ ...filterParams, eventsPage: liveEvents.page, servicePage }}
            />
          </div>
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
