import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { bytes, ConfidenceBadge, EmptyState, MetricCard, RouteBadge, StatusBadge } from "@/components/Widgets";
import { buildDashboardModel } from "@/lib/server/selectors/dashboard";
import { listAppFamilyRows, listClientInventory, listSiteEvidenceRows } from "@/lib/server/selectors/clients";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { groupAttributionRows, isPrimaryTrafficDestinationLabel, trafficDisplayDestination } from "@/lib/traffic-window.mjs";
import { trafficIntelligenceFor } from "@/lib/traffic-classification.mjs";
import { attributionEligibility, isAttributableSiteRow } from "@/lib/attribution-eligibility.mjs";

function share(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function observedBytes(row: Record<string, any>) {
  const explicit = [row.bytes, row.total_bytes, row.totalBytes, row.observed_bytes]
    .map((value) => Number(value || 0))
    .find((value) => Number.isFinite(value) && value > 0);
  if (explicit) return explicit;
  return Number(row.via_vps_bytes || row.viaVpsBytes || 0)
    + Number(row.direct_bytes || row.directBytes || 0)
    + Number(row.unknown_bytes || row.unknownBytes || 0);
}

function unknownBytes(row: Record<string, any>) {
  return Math.max(0, observedBytes(row) - Number(row.via_vps_bytes || row.viaVpsBytes || 0) - Number(row.direct_bytes || row.directBytes || 0));
}

function trafficClassOf(row: Record<string, any>) {
  return String(row.trafficClass || row.traffic_class || "").trim();
}

function routeSplit(row: Record<string, any>) {
  const viaVps = Number(row.via_vps_bytes || row.viaVpsBytes || (row.route === "VPS" ? observedBytes(row) : 0) || 0);
  const direct = Number(row.direct_bytes || row.directBytes || (row.route === "Direct" ? observedBytes(row) : 0) || 0);
  const unknown = Math.max(0, observedBytes(row) - viaVps - direct);
  return { viaVps, direct, unknown };
}

function routeFromRoutes(routes: Set<string>) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return "Mixed";
}

function destinationLabel(row: Record<string, any>) {
  return trafficDisplayDestination(row);
}

const dashboardNonDestinations = new Set(["client", "no site evidence", "encrypted ingress traffic", "n/a", "unknown", "unknown ip", "unknown ip only", "ip only", "ip-only destination", "unknown destination", "traffic without site attribution", "other / uncategorized"]);

function isDomainLike(value: unknown) {
  const text = String(value || "").trim();
  return Boolean(text)
    && text.includes(".")
    && !/^(\d{1,3}\.){3}\d{1,3}$/.test(text)
    && !text.includes(" ");
}

function domainForRow(row: Record<string, any>) {
  for (const candidate of [row.dns_qname, row.sni, row.domain, row.destination, row.raw?.dns_qname, row.raw?.sni, row.raw?.domain]) {
    if (isDomainLike(candidate)) return String(candidate).trim();
  }
  return "";
}

function hasDashboardDestination(row: Record<string, any>) {
  if (row.accounting_bucket || row.raw?.accounting_bucket) return false;
  if (!isAttributableSiteRow(row, { includeService: true })) return false;
  const label = destinationLabel(row).trim();
  if (dashboardNonDestinations.has(label.toLowerCase())) return false;
  return isPrimaryTrafficDestinationLabel(label);
}

function laneForRow(row: Record<string, any>) {
  return String(trafficIntelligenceFor(row).traffic_lane || row.traffic_lane || "unknown_review");
}

function destinationSection(row: Record<string, any>) {
  const trafficClass = trafficClassOf(row);
  const lane = laneForRow(row);
  if (lane === "service_system" || trafficClass === "service_background") return "service";
  return "client";
}

function isServiceEvidenceRow(row: Record<string, any>) {
  const eligibility = attributionEligibility(row);
  if (eligibility.serviceOnly) return true;
  return destinationSection(row) === "service"
    || row.traffic_role === "service_system"
    || row.app_category === "service_system"
    || row.app_family === "Service / system";
}

function destinationDetailLabel(row: Record<string, any>) {
  const domain = row.domains?.size ? String(Array.from(row.domains)[0]).trim() : "";
  return domain || String(row.destinationLabel || row.label || "").trim();
}

function isNeedsAttributionRow(row: Record<string, any>) {
  if (observedBytes(row) <= 0 || row.accounting_bucket || row.raw?.accounting_bucket) return false;
  const label = destinationLabel(row);
  const trafficClass = trafficClassOf(row);
  const lane = laneForRow(row);
  if (!isPrimaryTrafficDestinationLabel(label)) return true;
  return trafficClass === "unclassified" || lane === "unknown_review";
}

function groupDashboardDestinations(rows: Array<Record<string, any>>, limit = 10) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if (observedBytes(row) <= 0 || !hasDashboardDestination(row)) continue;
    const label = destinationLabel(row);
    const section = destinationSection(row);
    const key = `${section}|${label.toLowerCase()}`;
    const current = grouped.get(key) || {
      ...row,
      destinationLabel: label,
      label,
      section,
      bytes: 0,
      total_bytes: 0,
      via_vps_bytes: 0,
      direct_bytes: 0,
      unknown_bytes: 0,
      viaVpsBytes: 0,
      directBytes: 0,
      unknownBytes: 0,
      connections: 0,
      clients: new Set<string>(),
      routes: new Set<string>(),
      lanes: new Set<string>(),
      domains: new Set<string>(),
    };
    const rowBytes = observedBytes(row);
    const split = routeSplit(row);
    current.bytes += rowBytes;
    current.total_bytes += rowBytes;
    current.via_vps_bytes += split.viaVps;
    current.direct_bytes += split.direct;
    current.unknown_bytes += split.unknown;
    current.viaVpsBytes += split.viaVps;
    current.directBytes += split.direct;
    current.unknownBytes += split.unknown;
    current.connections += Number(row.connections || 0);
    if (row.client) current.clients.add(String(row.client));
    if (row.route) current.routes.add(String(row.route));
    current.lanes.add(laneForRow(row));
    const domain = domainForRow(row);
    if (domain) current.domains.add(domain);
    grouped.set(key, current);
  }
  const sectionRank = (row: Record<string, any>) => row.section === "service" ? 1 : 0;
  return Array.from(grouped.values())
    .sort((a, b) => sectionRank(a) - sectionRank(b) || Number(b.bytes || 0) - Number(a.bytes || 0))
    .slice(0, limit)
    .map((row, idx) => ({
      ...row,
      rank: idx + 1,
      route: routeFromRoutes(row.routes || new Set()),
      detail: [
        destinationDetailLabel(row),
        row.clients?.size ? `${row.clients.size} client${row.clients.size === 1 ? "" : "s"}` : "",
        row.connections ? `${row.connections} sessions` : "",
      ].filter(Boolean).join(" · "),
    }));
}

function pct(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
}

function compactBytes(value: number) {
  if (!value) return "0 B";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  return bytes(value);
}

function trafficIntelSummary(rows: Array<Record<string, any>>) {
  const summary = {
    client_observed: 0,
    service_system: 0,
    privacy_risk: 0,
    shared_infra: 0,
    unknown_review: 0,
    block_candidate: 0,
    ask_user: 0,
  };
  for (const row of rows) {
    const rowBytes = observedBytes(row);
    if (rowBytes <= 0) continue;
    const intel = trafficIntelligenceFor(row);
    const lane = String(intel.traffic_lane || "unknown_review") as keyof typeof summary;
    if (lane in summary) summary[lane] += rowBytes;
    if (intel.decision_hint === "block_candidate") summary.block_candidate += 1;
    if (intel.decision_hint === "ask_user") summary.ask_user += 1;
  }
  return summary;
}

function maxSeries(points: Array<Record<string, any>>, keys: string[]) {
  return Math.max(1, ...points.flatMap((point) => keys.map((key) => Number(point[key] || 0))));
}

function linePath(points: Array<Record<string, any>>, key: string, max: number, width = 100, height = 54) {
  if (points.length === 0) return "";
  return points.map((point, idx) => {
    const x = points.length === 1 ? 0 : (idx / (points.length - 1)) * width;
    const y = height - (Number(point[key] || 0) / max) * (height - 8) - 2;
    return `${idx === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function areaPath(points: Array<Record<string, any>>, key: string, max: number, width = 100, height = 54) {
  const path = linePath(points, key, max, width, height);
  if (!path) return "";
  return `${path} L ${width} ${height} L 0 ${height} Z`;
}

function TrafficTodayChart({ points }: { points: Array<Record<string, any>> }) {
  const max = maxSeries(points, ["totalBytes", "viaVpsBytes", "directBytes", "unknownBytes"]);
  const ticks = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "23:00"];
  return (
    <section className="card dashboard-chart-card dashboard-traffic-card">
      <div className="dashboard-card-head">
        <h2>Traffic today</h2>
        <div className="dashboard-card-actions"><span>MB</span><span>...</span></div>
      </div>
      <div className="chart-legend">
        <span className="legend-total">Total</span>
        <span className="legend-vps">Via VPS</span>
        <span className="legend-direct">Direct</span>
        <span className="legend-unknown">Unknown</span>
      </div>
      <div className="dashboard-chart-wrap">
        <div className="chart-scale">
          <span>{compactBytes(max)}</span>
          <span>{compactBytes(max / 2)}</span>
          <span>0</span>
        </div>
        <svg className="dashboard-line-chart" viewBox="0 0 100 58" role="img" aria-label="Traffic today chart" preserveAspectRatio="none">
          <path className="area-total" d={areaPath(points, "totalBytes", max, 100, 54)} />
          <path className="area-vps" d={areaPath(points, "viaVpsBytes", max, 100, 54)} />
          <path className="line-total" d={linePath(points, "totalBytes", max, 100, 54)} />
          <path className="line-vps" d={linePath(points, "viaVpsBytes", max, 100, 54)} />
          <path className="line-direct" d={linePath(points, "directBytes", max, 100, 54)} />
          <path className="line-unknown" d={linePath(points, "unknownBytes", max, 100, 54)} />
        </svg>
      </div>
      <div className="chart-axis-labels">{ticks.map((tick) => <span key={tick}>{tick}</span>)}</div>
    </section>
  );
}

function RankedClients({ rows }: { rows: Array<Record<string, any>> }) {
  const max = Math.max(1, ...rows.map((row) => observedBytes(row)));
  return (
    <section className="card dashboard-rank-card">
      <div className="dashboard-card-head">
        <h2>Top clients</h2>
        <Link className="dashboard-card-link" href="/clients">Open all</Link>
      </div>
      {rows.length === 0 ? <EmptyState title="No client traffic observed" /> : (
        <div className="dashboard-rank-list">
          {rows.map((row) => (
            <div className="dashboard-rank-row" key={row.key || row.label}>
              <span className="rank-index">{row.rank}</span>
              <div className="rank-title"><strong>{row.label}</strong><small>{row.channel || "not observed"}</small></div>
              <div className="rank-meter">
                <strong>{compactBytes(observedBytes(row))}</strong><span>{row.sharePct || 0}%</span>
                <small>VPS {compactBytes(row.viaVpsBytes || row.via_vps_bytes || 0)} · Direct {compactBytes(row.directBytes || row.direct_bytes || 0)} · Unknown {compactBytes(row.unknownBytes || unknownBytes(row))}</small>
                <i><b style={{ width: `${pct(observedBytes(row), max)}%` }} /></i>
              </div>
              <span className={`rank-status status-${String(row.status || "OK").toLowerCase()}`}>{row.status || "OK"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RankedDestinations({ rows }: { rows: Array<Record<string, any>> }) {
  const max = Math.max(1, ...rows.map((row) => observedBytes(row)));
  const total = Math.max(1, rows.reduce((sum, row) => sum + observedBytes(row), 0));
  return (
    <section className="card dashboard-rank-card">
      <div className="dashboard-card-head">
        <h2>Top destinations</h2>
        <Link className="dashboard-card-link" href="/traffic">Open all</Link>
      </div>
      {rows.length === 0 ? <EmptyState title="No destination traffic observed" /> : (
        <div className="dashboard-rank-list">
          {rows.map((row) => (
            <div className="dashboard-rank-row destination-row" key={row.key || row.label}>
              <span className="rank-index">{row.rank}</span>
              <div className="rank-title"><strong>{row.label}</strong><small>{row.detail || "not observed"}</small></div>
              <RouteBadge value={row.route} />
              <div className="rank-meter">
                <strong>{compactBytes(observedBytes(row))}</strong><span>{row.sharePct || pct(observedBytes(row), total)}%</span>
                <small>VPS {compactBytes(row.viaVpsBytes || 0)} · Direct {compactBytes(row.directBytes || 0)} · Unknown {compactBytes(row.unknownBytes || 0)}</small>
                <i><b style={{ width: `${pct(observedBytes(row), max)}%` }} /></i>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RankedApps({ rows }: { rows: Array<Record<string, any>> }) {
  const max = Math.max(1, ...rows.map((row) => observedBytes(row)));
  return (
    <section className="card dashboard-rank-card">
      <div className="dashboard-card-head">
        <h2>Top app families</h2>
        <Link className="dashboard-card-link" href="/apps">Open Apps</Link>
      </div>
      {rows.length === 0 ? <EmptyState title="No app-family traffic observed" /> : (
        <div className="dashboard-rank-list">
          {rows.map((row) => (
            <div className="dashboard-rank-row destination-row" key={row.app_family}>
              <span className="rank-index">{row.rank}</span>
              <div className="rank-title">
                <strong>{row.app_family}</strong>
                <small>{(row.sample_domains || []).slice(0, 3).join(", ") || row.app_category || "not observed"}</small>
              </div>
              <RouteBadge value={row.route} />
              <div className="rank-meter">
                <strong>{compactBytes(observedBytes(row))}</strong><span>{pct(observedBytes(row), max)}%</span>
                <small>{row.dns_queries || 0} DNS queries · {row.app_confidence || "estimated"}</small>
                <i><b style={{ width: `${pct(observedBytes(row), max)}%` }} /></i>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageChart({ points, note }: { points: Array<Record<string, any>>; note?: string }) {
  const max = maxSeries(points, ["vpsBytes", "lteBytes", "vpsForecastBytes"]);
  const labels = points.filter((_, idx) => idx === 0 || idx === Math.floor(points.length / 2) || idx === points.length - 1);
  return (
    <section className="card dashboard-chart-card dashboard-usage-card">
      <div className="dashboard-card-head">
        <h2>Traffic usage</h2>
        <div className="dashboard-card-actions"><span>By day</span></div>
      </div>
      <div className="chart-legend">
        <span className="legend-vps">VPS cumulative</span>
        <span className="legend-lte">LTE reserve cumulative</span>
        <span className="legend-forecast">VPS forecast</span>
      </div>
      <div className="dashboard-chart-wrap">
        <div className="chart-scale"><span>{compactBytes(max)}</span><span>{compactBytes(max / 2)}</span><span>0</span></div>
        <svg className="dashboard-line-chart usage-chart" viewBox="0 0 100 58" role="img" aria-label="Traffic usage chart" preserveAspectRatio="none">
          <path className="area-vps" d={areaPath(points, "vpsBytes", max, 100, 54)} />
          <path className="area-lte" d={areaPath(points, "lteBytes", max, 100, 54)} />
          <path className="line-vps" d={linePath(points, "vpsBytes", max, 100, 54)} />
          <path className="line-lte" d={linePath(points, "lteBytes", max, 100, 54)} />
          <path className="line-forecast" d={linePath(points, "vpsForecastBytes", max, 100, 54)} />
        </svg>
      </div>
      <div className="chart-axis-labels">{labels.map((point) => <span key={point.day}>{point.label}</span>)}</div>
      <p className="chart-note">{note || "Forecast is based on prepared traffic evidence."}</p>
    </section>
  );
}

export default async function Dashboard({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildDashboardModel(filters);
  const total = model.totals.observedBytes || 1;
  const trafficWindow = [model.totals.periodLabel, model.totals.windowLabel].filter(Boolean).join(" · ");
  const trafficWindowText = trafficWindow || "today, window not observed";
  const analytics = model.dashboardAnalytics || {};
  const inventoryTopClientsRaw = listClientInventory({
    page: 1,
    pageSize: 5,
    filters: { ...filters, trafficClass: "all" },
  }).rows.filter((row) => observedBytes(row) > 0);
  const inventoryTopTotal = inventoryTopClientsRaw.reduce((sum, row) => sum + observedBytes(row), 0) || 1;
  const inventoryTopClients = inventoryTopClientsRaw.map((row, idx) => ({
    ...row,
    rank: idx + 1,
    key: row.client_key || row.id || row.label,
    label: row.label || row.client_label || row.id || "Unknown client",
    bytes: observedBytes(row),
    total_bytes: observedBytes(row),
    viaVpsBytes: Number(row.via_vps_bytes || 0),
    directBytes: Number(row.direct_bytes || 0),
    unknownBytes: unknownBytes(row),
    sharePct: share(observedBytes(row), inventoryTopTotal),
    status: Number(row.total_bytes || 0) > 0 ? "OK" : "Inactive",
  }));
  const topApps = listAppFamilyRows({
    page: 1,
    pageSize: 5,
    filters: { ...filters, trafficClass: "all", client: "all" },
  }).rows;
  const detailFlowRows = listFlowSessions({
    page: 1,
    pageSize: 500,
    maxPageSize: 500,
    maxRows: 5000,
    filters: { ...filters, trafficClass: "all" },
    diagnostics: true,
  }).rows;
  const observedFlowRows = [...(detailFlowRows.length ? detailFlowRows : model.flows)]
    .filter((row) => observedBytes(row) > 0)
    .sort((a, b) => observedBytes(b) - observedBytes(a));
  const siteEvidenceRows = listSiteEvidenceRows({ ...filters, trafficClass: "all" }, { limit: 5000, perClientLimit: 120, includeService: true })
    .filter((row) => observedBytes(row) > 0);
  const topDestinations = groupDashboardDestinations(siteEvidenceRows.filter((row) => !isServiceEvidenceRow(row)), 10);
  const serviceTraffic = groupDashboardDestinations(siteEvidenceRows.filter(isServiceEvidenceRow), 10);
  const needsAttribution = groupAttributionRows(
    observedFlowRows.filter(isNeedsAttributionRow),
    10
  );
  const latestDecisions = observedFlowRows
    .filter((row) => destinationSection(row) === "client" && hasDashboardDestination(row))
    .slice(0, 10);
  const intelligenceSummary = trafficIntelSummary(model.flows);

  return (
    <ConsoleShell active="/" model={model} filters={filters}>
      <div className="dashboard-analytics">
        <TrafficTodayChart points={analytics.trafficToday?.points || []} />
        <div className="grid four">
          <MetricCard label="Observed traffic" value={bytes(model.totals.observedBytes)} detail={`Data for ${trafficWindowText} · refresh about 5 minutes`} />
          <MetricCard label="Via VPS" value={bytes(model.totals.viaVpsBytes)} detail={`${share(model.totals.viaVpsBytes, total)}% observed · current-day KPI`} />
          <MetricCard label="Direct" value={bytes(model.totals.directBytes)} detail={`${share(model.totals.directBytes, total)}% observed · current-day KPI`} />
          <MetricCard label="Unknown" value={bytes(Math.max(0, model.totals.observedBytes - model.totals.viaVpsBytes - model.totals.directBytes))} detail="not attributed to VPS or direct yet" />
        </div>
        <div className="dashboard-rank-grid">
          <RankedClients rows={inventoryTopClients} />
          <RankedDestinations rows={topDestinations} />
          <RankedApps rows={topApps} />
        </div>
      </div>

      <div className="grid cards">
        {model.statusCards.map((card) => (
          <section className="card" key={card.label}>
            <h3>{card.label}</h3>
            <StatusBadge value={card.status} />
            <p>{card.detail}</p>
          </section>
        ))}
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <h2>Traffic Intelligence Summary</h2>
          <Link className="muted-button" href="/intelligence">Open review</Link>
        </div>
        <div className="grid cards intelligence-summary-grid">
          <MetricCard label="Client traffic" value={bytes(intelligenceSummary.client_observed)} detail="user-facing or encrypted client evidence" />
          <MetricCard label="Service/system" value={bytes(intelligenceSummary.service_system)} detail="OS/app background that is usually allowed" />
          <MetricCard label="Analytics/trackers" value={bytes(intelligenceSummary.privacy_risk)} detail={`${intelligenceSummary.block_candidate} block candidates`} />
          <MetricCard label="CDN/shared infra" value={bytes(intelligenceSummary.shared_infra)} detail="monitor; do not block by IP alone" />
          <MetricCard label="Unknown/review" value={bytes(intelligenceSummary.unknown_review)} detail={`${intelligenceSummary.ask_user} ask-user rows`} />
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
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
      <section className="card compact-warnings" style={{ marginTop: 14 }}>
          <h2>Warnings</h2>
          {model.alerts.length === 0 ? (
            <EmptyState title="No active warnings" />
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

      <section className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <h2>Client traffic snapshot rows</h2>
          <span className="subtle">{trafficWindowText}, sorted by volume</span>
        </div>
        {latestDecisions.length === 0 ? (
          <EmptyState title="No client traffic rows" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Client</th><th>Destination</th><th>Route</th><th>Traffic</th><th>Period</th><th>Confidence</th></tr>
            </thead>
            <tbody>
              {latestDecisions.map((row, idx) => (
                <tr key={idx}>
                  <td>{row.client || row.channel || "n/a"}</td>
                  <td><Link href={`/traffic?flow=${idx}`}>{trafficDisplayDestination(row)}</Link></td>
                  <td><RouteBadge value={row.route} /></td>
                  <td>{bytes(observedBytes(row))}<small className="subtle block-detail">{row.connections || 0} sessions</small></td>
                  <td>{trafficWindowText}</td>
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
            <EmptyState title="No service/background traffic rows" />
          ) : (
            <div className="detail-list">
              {serviceTraffic.map((row, idx) => (
                <div className="detail-row" key={idx}>
                  <span>{trafficDisplayDestination(row)}</span>
                  <strong>{bytes(observedBytes(row))} <RouteBadge value={row.route} /></strong>
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
            <EmptyState title="No unclassified traffic rows" />
          ) : (
            <div className="detail-list">
              {needsAttribution.map((row, idx) => (
                <div className="detail-row" key={idx}>
                  <span>
                    {trafficDisplayDestination(row)}
                    {row.attributionDetail ? <small className="subtle block-detail">{row.attributionDetail}</small> : null}
                  </span>
                  <strong>{bytes(observedBytes(row))} <RouteBadge value={row.route} /></strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Route topology</h2>
            <span className="subtle">logical view</span>
          </div>
          <div className="topology-strip">
            <span>Client</span><i /><span>Router</span><i className={model.totals.viaVpsBytes > 0 ? "active" : ""} /><span>VPS</span><i className={model.totals.viaVpsBytes > 0 ? "active" : ""} /><span>Internet</span>
          </div>
          <div className="topology-strip direct">
            <span>Client</span><i /><span>Router</span><i className={model.totals.directBytes > 0 ? "active direct" : ""} /><span>Direct</span><i /><span>Internet</span>
          </div>
        </section>
        <section className="card">
          <div className="toolbar">
            <h2>Operator Actions</h2>
            <span className="subtle">read-only safe entrypoints</span>
          </div>
          <div className="operator-actions">
            <Link className="muted-button" href="/live">Open Live mode</Link>
            <Link className="muted-button" href="/health">Review alarms</Link>
            <Link className="muted-button" href="/catalog">Review catalog</Link>
            <Link className="muted-button" href="/reports">LLM-safe report</Link>
          </div>
        </section>
      </div>

    </ConsoleShell>
  );
}
