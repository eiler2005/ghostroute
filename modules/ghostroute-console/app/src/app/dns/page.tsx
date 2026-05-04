import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { ChannelBadge, ConfidenceBadge, EmptyState, MetricCard, Pagination, RouteBadge, StatusBadge, shortDateTime } from "@/components/Widgets";
import { buildShellModel, listAlarmEvents, listDnsQueryLog } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sumCounts(rows: Array<Record<string, any>>) {
  return rows.reduce((sum, row) => sum + Number(row.count || 1), 0);
}

function grouped(rows: Array<Record<string, any>>, key: string, limit = 6) {
  const map = new Map<string, { label: string; count: number; rows: number }>();
  for (const row of rows) {
    const label = String(row[key] || "unknown");
    const current = map.get(label) || { label, count: 0, rows: 0 };
    current.count += Number(row.count || 1);
    current.rows += 1;
    map.set(label, current);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, limit);
}

export default async function DnsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(25, Number.parseInt(scalar(params.pageSize) || "50", 10) || 50));
  const status = scalar(params.status) || "all";
  const catalogStatus = scalar(params.catalogStatus) || "all";
  const dnsPage = listDnsQueryLog({ page, pageSize, status, catalogStatus, filters: { ...filters, trafficClass: "all" } });
  const alarms = listAlarmEvents({ page: 1, pageSize: 8, filters: { ...filters, search: "" } }).rows;
  const model = buildShellModel(filters, { dnsQueries: dnsPage.rows, alerts: alarms });
  const totalCount = sumCounts(dnsPage.rows);
  const managedCount = sumCounts(dnsPage.rows.filter((row) => row.catalog_status === "managed"));
  const directCount = sumCounts(dnsPage.rows.filter((row) => row.route === "Direct"));
  const suspiciousCount = sumCounts(dnsPage.rows.filter((row) => ["medium", "high"].includes(String(row.risk || "")) || ["Blocked", "Review"].includes(String(row.status || ""))));
  const topDomains = grouped(dnsPage.rows, "domain", 7);
  const topClients = grouped(dnsPage.rows, "client", 7);
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
    status: status !== "all" ? status : undefined,
    catalogStatus: catalogStatus !== "all" ? catalogStatus : undefined,
  };

  return (
    <ConsoleShell active="/dns" model={model} filters={{ ...filters, trafficClass: "all" }}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <MetricCard label="DNS queries shown" value={String(totalCount)} detail={`${dnsPage.total} read-model rows`} />
        <MetricCard label="Managed catalog hits" value={String(managedCount)} detail="catalog_status=managed" />
        <MetricCard label="Direct decisions" value={String(directCount)} detail="allowed/local/direct answers" />
        <MetricCard label="Suspicious/new" value={String(suspiciousCount)} detail="blocked, review or elevated risk" />
        <MetricCard label="Top client rows" value={String(topClients.length)} detail="visible page grouping" />
        <MetricCard label="Alerts" value={String(alarms.length)} detail="linked alarm center signals" />
      </div>

      <div className="grid two">
        <section className="card dns-table-card">
          <div className="toolbar">
            <div>
              <h2>DNS Query Log</h2>
              <p>Кто спросил домен, какой ответ получил, какой маршрут и что решил catalog.</p>
            </div>
            <Link className="muted-button" href="/traffic">Open Flow Explorer</Link>
          </div>
          {dnsPage.rows.length === 0 ? (
            <EmptyState title="Нет DNS query rows" />
          ) : (
            <>
              <table className="table dns-table">
                <thead>
                  <tr>
                    <th className="col-time">Time</th>
                    <th className="col-client">Client</th>
                    <th>Domain</th>
                    <th>Type</th>
                    <th>Resolved IP</th>
                    <th>Route</th>
                    <th>Catalog</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {dnsPage.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="col-time">{shortDateTime(row.event_ts || row.collected_at)}</td>
                      <td>
                        <Link href={`/clients?client=${encodeURIComponent(row.client_key || row.client || "")}`}>{row.client || "Unknown"}</Link>
                        {row.client_ip ? <small className="subtle block-detail">{row.client_ip}</small> : null}
                      </td>
                      <td>
                        <Link href={`/traffic?search=${encodeURIComponent(row.domain || "")}`}>{row.domain || row.dns_qname || "n/a"}</Link>
                        <small className="subtle block-detail">count {row.count || 1}</small>
                      </td>
                      <td>{row.qtype || "A"}</td>
                      <td>{row.answer_ip || row.dns_answer_ip || "n/a"}</td>
                      <td><RouteBadge value={row.route} /></td>
                      <td><ConfidenceBadge value={row.catalog_status || "unknown"} /></td>
                      <td><StatusBadge value={row.status || "OK"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination basePath="/dns" page={dnsPage.page} pageSize={dnsPage.pageSize} total={dnsPage.total} totalPages={dnsPage.totalPages} extraParams={filterParams} />
            </>
          )}
        </section>

        <aside className="card side-panel">
          <div className="panel-title">
            <h2>DNS Forensics</h2>
            <StatusBadge value={suspiciousCount > 0 ? "WARN" : "OK"} />
          </div>
          <h3>Top clients</h3>
          <div className="mini-bars">
            {topClients.length === 0 ? <div className="subtle">No client grouping on this page.</div> : topClients.map((row) => (
              <div className="mini-bar" key={row.label}>
                <span>{row.label}</span>
                <i style={{ width: `${Math.max(6, Math.round((row.count / Math.max(totalCount, 1)) * 100))}%` }} />
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
          <h3 style={{ marginTop: 16 }}>Top domains</h3>
          <div className="detail-list">
            {topDomains.length === 0 ? <div className="subtle">No domains visible.</div> : topDomains.map((row) => (
              <div className="detail-row" key={row.label}><span>{row.label}</span><strong>{row.count}</strong></div>
            ))}
          </div>
          <h3 style={{ marginTop: 16 }}>Attention</h3>
          <div className="detail-list">
            {alarms.length === 0 ? <div className="subtle">No active DNS-linked alarms.</div> : alarms.slice(0, 5).map((row) => (
              <div className="detail-row" key={row.id}>
                <span>{row.title}<small className="subtle block-detail">{row.evidence}</small></span>
                <strong>{row.severity}</strong>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </ConsoleShell>
  );
}
