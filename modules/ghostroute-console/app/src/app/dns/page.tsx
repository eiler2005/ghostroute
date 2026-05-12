import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { ConfidenceBadge, EmptyState, MetricCard, Pagination, RouteBadge, StatusBadge, timeWithMillis } from "@/components/Widgets";
import { buildShellModel } from "@/lib/server/selectors/shell";
import { listAlarmEvents } from "@/lib/server/selectors/health";
import { listDnsQueryLog } from "@/lib/server/selectors/dns";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { boundedPageSize, isMobileRequest } from "@/lib/server/mobile";
import { trafficClassLabel, trafficIntelligenceFor } from "@/lib/traffic-classification.mjs";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function sumCounts(rows: Array<Record<string, any>>) {
  return rows.reduce((sum, row) => sum + Number(row.count || 1), 0);
}

function grouped(rows: Array<Record<string, any>>, key: string, limit = 6) {
  const map = new Map<string, { label: string; count: number; rows: number; trafficClass: string; classCounts: Record<string, number> }>();
  for (const row of rows) {
    const label = String(row[key] || "unknown");
    const current = map.get(label) || { label, count: 0, rows: 0, trafficClass: "unclassified", classCounts: {} };
    current.count += Number(row.count || 1);
    current.rows += 1;
    const trafficClass = String(row.trafficClass || row.traffic_class || "unclassified");
    current.classCounts[trafficClass] = (current.classCounts[trafficClass] || 0) + Number(row.count || 1);
    current.trafficClass = Object.entries(current.classCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || current.trafficClass;
    map.set(label, current);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, limit);
}

function dnsRoute(row: Record<string, any>) {
  return String(row.route || "").toLowerCase() === "vps" ? "VPS" : "Direct";
}

function dnsTime(row: Record<string, any>) {
  const value = row.display_ts_utc || row.event_ts_utc || row.event_ts || row.collected_at;
  const base = timeWithMillis(value, true).replace(/\.000$/, "");
  return row.time_precision === "prepared_bucket" ? `${base} MSK bucket` : `${base} MSK`;
}

function dnsChannel(row: Record<string, any>) {
  return row.channel || row.client_channel || row.raw?.channel || "Unknown";
}

function dnsTrafficType(row: Record<string, any>, intel: Record<string, any>) {
  const lane = String(intel.traffic_lane || row.traffic_lane || "");
  const trafficClass = String(row.trafficClass || row.traffic_class || "");
  if (lane === "service_system" || trafficClass === "service_background") return "Service/system";
  if (trafficClass === "personal_cloud") return "Personal cloud";
  if (lane === "privacy_risk") return "Analytics/tracker";
  if (lane === "shared_infra") return "Shared infra";
  if (trafficClass === "client" || lane === "client_observed") return "Client";
  return trafficClassLabel(trafficClass || "unclassified");
}

export default async function DnsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const mobile = await isMobileRequest();
  const filters = await todayOnlyFiltersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = boundedPageSize(scalar(params.pageSize), { desktop: 50, mobile: 25, min: 25, desktopMax: 500, mobileMax: 25 }, mobile);
  const status = scalar(params.status) || "all";
  const catalogStatus = scalar(params.catalogStatus) || "all";
  const dnsPage = listDnsQueryLog({ page, pageSize, status, catalogStatus, filters: { ...filters, trafficClass: "all" } });
  const alarms = listAlarmEvents({ page: 1, pageSize: 8, filters: { ...filters, search: "" } }).rows;
  const model = buildShellModel(filters, { dnsQueries: dnsPage.rows, alerts: alarms });
  const totalCount = sumCounts(dnsPage.rows);
  const managedCount = sumCounts(dnsPage.rows.filter((row) => row.catalog_status === "managed"));
  const directCount = sumCounts(dnsPage.rows.filter((row) => dnsRoute(row) === "Direct"));
  const suspiciousCount = sumCounts(dnsPage.rows.filter((row) => ["medium", "high"].includes(String(row.risk || "")) || ["Blocked", "Review"].includes(String(row.status || ""))));
  const topDomains = grouped(dnsPage.rows, "domain", 7);
  const topClients = grouped(dnsPage.rows.filter((row) => row.client_attributed && row.client_key), "client", 7);
  const filterParams = {
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
      <div className="grid cards dns-kpis">
        <MetricCard label="DNS rows" value={String(dnsPage.total)} detail={`latest log window, page ${dnsPage.page}/${dnsPage.totalPages}`} />
        <MetricCard label="Managed catalog hits" value={String(managedCount)} detail="catalog_status=managed" />
        <MetricCard label="Direct decisions" value={String(directCount)} detail="allowed/local/direct answers" />
        <MetricCard label="Suspicious/new" value={String(suspiciousCount)} detail="blocked, review or elevated risk" />
        <MetricCard label="Top client rows" value={String(topClients.length)} detail="visible page grouping" />
        <MetricCard label="Alerts" value={String(alarms.length)} detail="linked alarm center signals" />
      </div>

      <section className="card live-stream-card dns-log-card">
        <div className="live-stream-toolbar">
          <div className="live-stream-title">
            <h2>DNS Query Log</h2>
            <span>Showing {dnsPage.rows.length} of {dnsPage.total} latest DNS rows</span>
          </div>
          <div className="live-stream-actions">
            <div className="dense-top-pager">
              <Pagination basePath="/dns" page={dnsPage.page} pageSize={dnsPage.pageSize} total={dnsPage.total} totalPages={dnsPage.totalPages} extraParams={filterParams} />
            </div>
            <Link className="muted-button dns-flow-button" href="/traffic">Open Flow Explorer</Link>
          </div>
        </div>
        <div className="live-stream-meta">
          Client, DNS domain, channel, traffic type, route and catalog status · pageSize up to 1000
        </div>
        {dnsPage.rows.length === 0 ? (
          <div className="dns-empty-wrap"><EmptyState title="No DNS query rows" /></div>
        ) : (
          <div className="live-table-wrap dns-table-wrap">
            <table className="live-events-table dns-events-table">
                <thead>
                  <tr>
                    <th>Time (MSK)</th>
                    <th>Client</th>
                    <th>Domain</th>
                    <th>Channel</th>
                    <th>Traffic</th>
                    <th>Route</th>
                    <th>Category</th>
                    <th>Decision</th>
                    <th>Catalog</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {dnsPage.rows.map((row) => {
                    const statusValue = String(row.status || "OK");
                    const statusSlug = statusValue.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
                    const clientLabel = row.device_label || row.client_label || row.client || "Unknown";
                    const clientDetail = [row.client_ip, row.raw_client && row.raw_client !== row.client ? row.raw_client : ""].filter(Boolean).join(" · ");
                    const domain = row.domain || row.dns_qname || "n/a";
                    const answer = row.answer_ip || row.dns_answer_ip || "n/a";
                    const intel = trafficIntelligenceFor({ ...row, destination: domain, destination_ip: answer });
                    return (
                      <tr key={row.id}>
                        <td className="live-col-time">{dnsTime(row)}</td>
                        <td className="live-col-client dns-col-client" title={clientDetail || clientLabel}>
                          <Link href={`/clients?client=${encodeURIComponent(row.client_key || row.client || "")}`}>{clientLabel}</Link>
                        </td>
                        <td className="live-col-destination dns-col-domain" title={`${domain} · count ${row.count || 1}`}>
                          <span className="event-dot event-dns" />
                          <Link href={`/traffic?search=${encodeURIComponent(domain)}`}>{domain}</Link>
                          {Number(row.count || 1) > 1 ? <small> x{row.count}</small> : null}
                        </td>
                        <td className="dns-col-type">{dnsChannel(row)}</td>
                        <td className="dns-col-answer" title={answer === "n/a" ? "DNS answer not observed" : `DNS answer ${answer}`}>{dnsTrafficType(row, intel)}</td>
                        <td className="live-col-route"><RouteBadge value={dnsRoute(row)} /></td>
                        <td><span className="badge" title={intel.human_explanation}>{String(intel.dns_category || intel.category).replace(/_/g, " ")}</span></td>
                        <td><span className={`badge action-${String(intel.decision_hint || "monitor").replace(/_/g, "-")}`}>{String(intel.decision_hint || "monitor").replace(/_/g, " ")}</span></td>
                        <td className="dns-col-catalog"><ConfidenceBadge value={row.catalog_status || "unknown"} /></td>
                        <td className="live-col-status"><span className={`status-text-${statusSlug}`}>{statusValue}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          </div>
        )}
        <div className="live-card-footer">
          <Pagination basePath="/dns" page={dnsPage.page} pageSize={dnsPage.pageSize} total={dnsPage.total} totalPages={dnsPage.totalPages} extraParams={filterParams} />
        </div>
      </section>

      {mobile ? null : <div className="grid three dns-insights">
        <aside className="card">
          <div className="panel-title">
            <h2>Top clients</h2>
            <StatusBadge value={suspiciousCount > 0 ? "WARN" : "OK"} />
          </div>
          <div className="mini-bars">
            {topClients.length === 0 ? <div className="subtle">No client grouping on this page.</div> : topClients.map((row) => (
              <div className="mini-bar" key={row.label}>
                <span>{row.label}</span>
                <i style={{ width: `${Math.max(6, Math.round((row.count / Math.max(totalCount, 1)) * 100))}%` }} />
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
        </aside>
        <aside className="card">
          <div className="panel-title"><h2>Top domains</h2></div>
          <div className="detail-list">
            {topDomains.length === 0 ? <div className="subtle">No domains visible.</div> : topDomains.map((row) => (
               <div className="detail-row" key={row.label}>
                 <span>{row.label}<small className="subtle block-detail">{trafficClassLabel(row.trafficClass)}</small></span>
                 <strong>{row.count}</strong>
               </div>
            ))}
          </div>
        </aside>
        <aside className="card">
          <div className="panel-title"><h2>Attention</h2></div>
          <div className="detail-list">
            {alarms.length === 0 ? <div className="subtle">No active DNS-linked alarms.</div> : alarms.slice(0, 5).map((row) => (
              <div className="detail-row" key={row.id}>
                <span>{row.title}<small className="subtle block-detail">{row.evidence}</small></span>
                <strong>{row.severity}</strong>
              </div>
            ))}
          </div>
        </aside>
      </div>}
    </ConsoleShell>
  );
}
