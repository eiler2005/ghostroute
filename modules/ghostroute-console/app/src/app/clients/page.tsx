import { ConsoleShell } from "@/components/ConsoleShell";
import {
  bytes,
  ChannelBadge,
  ConfidenceBadge,
  ConfidenceHelp,
  EmptyState,
  MetricCard,
  Pagination,
  RawEvidence,
  RouteBadge,
  routeFromBytes,
  SplitBars,
  StatusBadge,
  timeWithMillis,
} from "@/components/Widgets";
import {
  buildClientsModel,
  listClientDomainBreakdown,
  listClientActivity,
  listClientDestinationsByLane,
  listClientInventory,
  listClientLaneSummary,
  listRouteEvidenceDefects,
} from "@/lib/server/selectors/clients";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { boundedPageSize, isMobileRequest } from "@/lib/server/mobile";
import { aggregateDnsInterest, trafficDisplayDestination } from "@/lib/traffic-window.mjs";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function clientTokens(client?: Record<string, any>) {
  return [client?.client_key, client?.client_label, client?.device_key, client?.device_label, client?.label, client?.id, client?.ip, client?.profile, client?.client, ...(client?.aliases || []), ...(client?.observed_aliases || []), ...(client?.observed_identities || [])].filter(Boolean).map(String);
}

function normalizeToken(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function selectedClientValue(client?: Record<string, any>) {
  return client?.id || client?.device_key || client?.label || client?.client_key || client?.client_label || client?.device_label || "";
}

function matchesClientFilter(client: Record<string, any>, value?: string) {
  const target = normalizeToken(value);
  return Boolean(target) && clientTokens(client).some((token) => normalizeToken(token) === target);
}

function belongsToClient(row: Record<string, any>, tokens: string[]) {
  if (tokens.length === 0) return false;
  const normalizedTokens = tokens.map(normalizeToken);
  const clientFields = [row.client, row.client_key, row.client_label, row.device_key, row.device_label, row.label, row.device_id, row.id, row.ip, row.source_ip].filter(Boolean).map(String);
  if (clientFields.some((value) => normalizedTokens.includes(normalizeToken(value)))) return true;
  const raw = normalizeToken(JSON.stringify(row));
  return tokens.some((token) => token.length > 2 && raw.includes(normalizeToken(token)));
}

function hourLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(11, 13);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", hour12: false }).format(date);
}

function ClientActivityChart({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <EmptyState title="No client activity history" />;
  const max = Math.max(...rows.map((row) => Number(row.bytes || 0)), 1);
  const width = 360;
  const height = 136;
  const padX = 18;
  const padY = 14;
  const step = rows.length > 1 ? (width - padX * 2) / (rows.length - 1) : 0;
  const points = rows.map((row, idx) => {
    const x = rows.length > 1 ? padX + idx * step : width - padX;
    const y = height - padY - (Number(row.bytes || 0) / max) * (height - padY * 2);
    return { x, y, row };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${padX},${height - padY} ${line} ${points[points.length - 1].x},${height - padY}`;
  return (
    <div className="client-activity-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Client hourly traffic">
        <polygon points={area} />
        <polyline points={line} />
        {points.map((point, idx) => <circle key={idx} cx={point.x} cy={point.y} r="3.5" />)}
      </svg>
      <div className="chart-axis">
        {rows.map((row) => <span key={row.hour_key}>{hourLabel(row.hour_key)}h</span>)}
      </div>
      <div className="detail-list chart-breakdown">
        {rows.slice(-5).reverse().map((row) => (
          <div className="detail-row" key={row.hour_key}>
            <span>{hourLabel(row.hour_key)}h {row.mode === "snapshot" ? "snapshot total" : "delta"}</span>
            <strong>{bytes(row.bytes || 0)} <RouteBadge value={row.route} /></strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const laneTabs = [
  { value: "all", label: "All" },
  { value: "client_observed", label: "Client" },
  { value: "service_system", label: "Service/system" },
  { value: "privacy_risk", label: "Analytics/trackers" },
  { value: "shared_infra", label: "CDN/shared" },
  { value: "unknown_review", label: "Unknown/review" },
];

function title(value?: string) {
  return String(value || "unknown").replace(/_/g, " ");
}

function summarizeLaneRows(rows: Array<Record<string, any>>) {
  const summary: Record<string, Record<string, any>> = {};
  for (const tab of laneTabs) {
    summary[tab.value] = { bytes: 0, flows: 0, destinations: 0, decisionHints: new Map<string, number>() };
  }
  const hasAllRow = rows.some((row) => String(row.traffic_lane || "") === "all");
  for (const row of rows) {
    const lane = String(row.traffic_lane || "unknown_review");
    const target = summary[lane] || (summary[lane] = { bytes: 0, flows: 0, destinations: 0, decisionHints: new Map<string, number>() });
    const rowBytes = Number(row.bytes || row.total_bytes || 0);
    target.bytes += rowBytes;
    target.flows += Number(row.flows || 0);
    target.destinations += Number(row.destinations_count || 0);
    const hint = String(row.decision_hint || "monitor");
    target.decisionHints.set(hint, (target.decisionHints.get(hint) || 0) + Number(row.flows || 1));
    if (lane !== "all" && !hasAllRow) {
      summary.all.bytes += rowBytes;
      summary.all.flows += Number(row.flows || 0);
      summary.all.destinations += Number(row.destinations_count || 0);
    }
  }
  return summary;
}

function evidenceSummary(rows: Array<Record<string, any>>, totalBytes: number) {
  const result = { proven: 0, counter: 0, intent: 0, mismatch: 0, unknown: 0 };
  for (const row of rows) {
    const value = Number(row.bytes || row.total_bytes || 0);
    const evidence = String(row.route_evidence || row.route_verification || "");
    if (evidence.includes("counter") || evidence.includes("allocated")) result.counter += value;
    else if (evidence.includes("intent")) result.intent += value;
    else if (evidence.includes("mismatch")) result.mismatch += value;
    else if (evidence.includes("unknown")) result.unknown += value;
  }
  result.proven = Math.max(0, totalBytes - result.counter - result.intent - result.mismatch - result.unknown);
  return result;
}

function siteBytes(row: Record<string, any>) {
  return Number(row.bytes || row.total_bytes || row.totalBytes || row.observed_bytes || 0);
}

function siteLane(row: Record<string, any>) {
  return String(row.traffic_lane || row.trafficClass || row.traffic_class || "unknown_review");
}

function isServiceSite(row: Record<string, any>) {
  const lane = siteLane(row);
  return lane === "service_system" || String(row.trafficClass || row.traffic_class || "") === "service_background";
}

function isUsefulSiteLabel(label: string) {
  return Boolean(label)
    && !["n/a", "Client", "No site evidence"].includes(label)
    && !label.toLowerCase().includes("destination aggregate");
}

function inferredClientLane(selected?: Record<string, any>) {
  const channel = String(selected?.channel || "");
  if (channel.includes("A/Home") || channel.includes("Reality")) return "client_observed";
  if (Number(selected?.total_bytes || 0) > 0) return "client_observed";
  return "unknown_review";
}

function fallbackClientLaneRows(selected: Record<string, any> | undefined, route: string) {
  const total = siteBytes(selected || {});
  if (!selected || total <= 0) return [];
  return [{
    client_key: selected.client_key || selected.id || selected.device_key || selected.label || "",
    client_label: selected.client_label || selected.label || selected.device_label || "",
    channel: selected.channel || "Unknown",
    route,
    confidence: selected.confidence || "estimated",
    traffic_class: "client",
    traffic_lane: inferredClientLane(selected),
    dns_category: selected.channel?.includes("Reality") ? "user_content" : "unknown_domain",
    decision_hint: "monitor",
    enrichment_status: "inventory_fallback",
    bytes: total,
    total_bytes: total,
    via_vps_bytes: Number(selected.via_vps_bytes || 0),
    direct_bytes: Number(selected.direct_bytes || 0),
    unknown_bytes: Math.max(0, total - Number(selected.via_vps_bytes || 0) - Number(selected.direct_bytes || 0)),
    flows: Math.max(1, Number(selected.flows || selected.connections || selected.snapshot_samples || 1)),
    destinations_count: 1,
    last_seen_utc: selected.traffic_collected_at || selected.last_seen || selected.collected_at || "",
    fallback: true,
  }];
}

function fallbackClientDestinationRows(selected: Record<string, any> | undefined, route: string, lane = "all") {
  const total = siteBytes(selected || {});
  if (!selected || total <= 0) return [];
  const trafficLane = inferredClientLane(selected);
  if (lane !== "all" && lane !== trafficLane) return [];
  const reality = String(selected.channel || "").includes("Reality");
  const destination = reality ? "Home Reality ingress" : selected.label || selected.client_label || selected.id || "Client traffic";
  return [{
    client_key: selected.client_key || selected.id || selected.device_key || selected.label || "",
    client_label: selected.client_label || selected.label || selected.device_label || "",
    destination,
    destination_key: destination,
    destination_label: destination,
    category: reality ? "client.home_reality_ingress" : "client.observed",
    provider: reality ? "ghostroute" : "",
    route,
    confidence: selected.confidence || "estimated",
    traffic_class: "client",
    traffic_lane: trafficLane,
    dns_category: reality ? "user_content" : "unknown_domain",
    decision_hint: "monitor",
    enrichment_status: "inventory_fallback",
    bytes: total,
    total_bytes: total,
    via_vps_bytes: Number(selected.via_vps_bytes || 0),
    direct_bytes: Number(selected.direct_bytes || 0),
    unknown_bytes: Math.max(0, total - Number(selected.via_vps_bytes || 0) - Number(selected.direct_bytes || 0)),
    flows: Math.max(1, Number(selected.flows || selected.connections || selected.snapshot_samples || 1)),
    last_seen_utc: selected.traffic_collected_at || selected.last_seen || selected.collected_at || "",
    fallback: true,
  }];
}

function fallbackClientActivityRows(selected: Record<string, any> | undefined, route: string) {
  const total = siteBytes(selected || {});
  if (!selected || total <= 0) return [];
  return [{
    hour_key: selected.traffic_collected_at || selected.last_seen || selected.collected_at || new Date().toISOString(),
    bytes: total,
    route,
    mode: "snapshot",
  }];
}

function routeFromSiteRoutes(routes: Set<string>) {
  const clean = Array.from(routes).filter(Boolean);
  if (clean.length === 0) return "Unknown";
  if (clean.length === 1) return clean[0];
  return "Mixed";
}

function groupPopularSites(rows: Array<Record<string, any>>, kind: "client" | "service", limit: number) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if ((kind === "service") !== isServiceSite(row)) continue;
    const label = trafficDisplayDestination(row);
    if (!isUsefulSiteLabel(label)) continue;
    const key = label.toLowerCase();
    const current = grouped.get(key) || {
      ...row,
      label,
      destinationLabel: label,
      bytes: 0,
      total_bytes: 0,
      flows: 0,
      routes: new Set<string>(),
      lanes: new Set<string>(),
      last_seen_utc: row.last_seen_utc || row.collected_at || "",
    };
    current.bytes += siteBytes(row);
    current.total_bytes += siteBytes(row);
    current.flows += Number(row.flows || row.connections || 0);
    if (row.route) current.routes.add(String(row.route));
    current.lanes.add(siteLane(row));
    if (String(row.last_seen_utc || row.collected_at || "") > String(current.last_seen_utc || "")) {
      current.last_seen_utc = row.last_seen_utc || row.collected_at || "";
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0) || String(a.label).localeCompare(String(b.label)))
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      route: routeFromSiteRoutes(row.routes || new Set()),
      laneLabel: Array.from(row.lanes || []).filter(Boolean).map((lane) => title(String(lane))).slice(0, 2).join(", ") || title(siteLane(row)),
    }));
}

function dnsInterestRows(rows: Array<Record<string, any>>, limit: number) {
  return rows.slice(0, limit).map((row, index) => ({
    id: `dns-interest-${index}`,
    rank: index + 1,
    label: row.domain,
    destination: row.domain,
    destinationLabel: row.domain,
    bytes: 0,
    total_bytes: 0,
    flows: Number(row.count || 0),
    route: "dns-interest",
    laneLabel: "DNS interest",
    confidence: "dns-interest",
    dnsOnly: true,
  }));
}

function counterOnlyRows(rows: Array<Record<string, any>>, kind: "client" | "service", limit: number) {
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if ((kind === "service") !== isServiceSite(row)) continue;
    if (siteBytes(row) <= 0 && !row.accounting_bucket && !row.raw?.accounting_bucket) continue;
    const label = trafficDisplayDestination(row);
    if (isUsefulSiteLabel(label)) continue;
    const key = isServiceSite(row) ? "service-counter-only" : "client-counter-only";
    const current = grouped.get(key) || {
      ...row,
      id: key,
      label: "Traffic without site attribution",
      destination: "Traffic without site attribution",
      destinationLabel: "Traffic without site attribution",
      bytes: 0,
      total_bytes: 0,
      flows: 0,
      routes: new Set<string>(),
      laneLabel: "counter-only · destination not observed",
      counterOnly: true,
    };
    current.bytes += siteBytes(row);
    current.total_bytes += siteBytes(row);
    current.flows += Number(row.flows || row.connections || 0);
    if (row.route) current.routes.add(String(row.route));
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0))
    .slice(0, limit)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      route: routeFromSiteRoutes(row.routes || new Set()),
    }));
}

function counterFallbackRows(selected: Record<string, any> | undefined, rows: Array<Record<string, any>>, route: string, kind: "client" | "service") {
  if (!selected || kind === "service") return [];
  const selectedBytes = Math.max(
    siteBytes(selected),
    rows.reduce((max, row) => Math.max(max, siteBytes(row)), 0)
  );
  if (selectedBytes <= 0) return [];
  const selectedFlows = Math.max(
    Number(selected.flows || selected.connections || 0),
    rows.reduce((max, row) => Math.max(max, Number(row.flows || row.connections || 0)), 0)
  );
  return [{
    id: "client-counter-fallback",
    rank: 1,
    label: "Traffic without site attribution",
    destination: "Traffic without site attribution",
    destinationLabel: "Traffic without site attribution",
    bytes: selectedBytes,
    total_bytes: selectedBytes,
    flows: selectedFlows,
    route,
    laneLabel: "counter-only · destination not observed",
    counterOnly: true,
  }];
}

function PopularSitesList({ title: heading, rows, dnsFallback, counterFallback }: { title: string; rows: Array<Record<string, any>>; dnsFallback?: Array<Record<string, any>>; counterFallback?: Array<Record<string, any>> }) {
  const fallbackRows = [...(dnsFallback || []), ...(counterFallback || [])];
  const visible = rows.length ? rows : fallbackRows;
  return (
    <section className="card client-popular-sites-list">
      <div className="toolbar">
        <h3>{heading}</h3>
        <span className="subtle">{rows.length ? "byte-attributed traffic" : "fallback evidence"}</span>
      </div>
      {visible.length === 0 ? (
        <EmptyState title="No site-level traffic for this client" detail="Only client/channel counters were observed in the selected day." />
      ) : (
        <div className="detail-list">
          {visible.map((row) => (
            <div className="detail-row popular-site-row" key={`${row.label}-${row.rank}`}>
              <span>
                <strong>{row.rank}. {row.label}</strong>
                <small className="subtle block-detail">{row.laneLabel} · {row.flows || 0} {row.dnsOnly ? "DNS hits" : row.counterOnly ? "counter flows" : "flows"}</small>
              </span>
              <strong>
                {row.dnsOnly ? "not byte-attributed" : bytes(siteBytes(row))}
                <RouteBadge value={row.route || routeFromBytes(row)} />
              </strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function ClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const mobile = await isMobileRequest();
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const selectedClientParam = scalar(params.client) || "";
  const selectedLane = laneTabs.some((tab) => tab.value === scalar(params.lane)) ? String(scalar(params.lane)) : "all";
  const showInactive = scalar(params.showInactive) === "1";
  const listFilters = { ...filters, client: "all" };
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = boundedPageSize(scalar(params.pageSize), { desktop: 25, mobile: 10, min: 10, desktopMax: 100, mobileMax: 10 }, mobile);
  const clientsPage = listClientInventory({ page, pageSize, filters: listFilters, showInactive });
  const isUnattributed = (row: Record<string, any>) =>
    row.client_attributed === false ||
    row.attribution_state === "needs_attribution" ||
    row.role === "Needs attribution" ||
    row.role === "Unattributed mobile ingress source" ||
    (row.role === "Unknown device" && Number(row.total_bytes || 0) < 1024 * 1024);
  const inventoryRows = clientsPage.rows as Array<Record<string, any>>;
  const primaryRows = inventoryRows.filter((row) => !isUnattributed(row));
  const unattributedRows = inventoryRows.filter((row) => isUnattributed(row));
  const activeRows = inventoryRows.filter((row) => Number(row.total_bytes || 0) > 0);
  const knownRows = primaryRows.filter((row: Record<string, any>) => row.client_attributed !== false && !String(row.role || row.label || "").toLowerCase().includes("unknown"));
  const selected: Record<string, any> | undefined =
    inventoryRows.find((row) => selectedClientParam && matchesClientFilter(row, selectedClientParam)) ||
    primaryRows[0] ||
    inventoryRows[0];
  const selectedClientId = selectedClientValue(selected);
  const trafficRows = selected ? listFlowSessions({ page: 1, pageSize: mobile ? 25 : 80, filters: { ...listFilters, client: selectedClientId } }).rows : [];
  const model = buildClientsModel(filters, clientsPage.rows, trafficRows);
  const tokens = clientTokens(selected);
  const allSelectedFlows = selected ? trafficRows.filter((row: Record<string, any>) => belongsToClient(row, tokens)) : [];
  const selectedFlows = allSelectedFlows.slice(0, 8);
  const selectedDns = selected ? aggregateDnsInterest(model.dnsQueries.filter((row: Record<string, any>) => belongsToClient(row, tokens)), 8) : [];
  const selectedAlerts = selected ? model.alerts.filter((row: Record<string, any>) => belongsToClient(row, tokens)).slice(0, 5) : [];
  const selectedRoute = selected ? routeFromBytes(selected) : "Unknown";
  const rawSelectedActivity = selected ? listClientActivity(selected, filters.period || "today") : [];
  const selectedActivity = rawSelectedActivity.length ? rawSelectedActivity : fallbackClientActivityRows(selected, selectedRoute);
  const rawSelectedLaneRows = selected ? listClientLaneSummary(selected, filters.period || "today", { limit: 80 }) : [];
  const selectedLaneRows = rawSelectedLaneRows.length ? rawSelectedLaneRows : fallbackClientLaneRows(selected, selectedRoute);
  const selectedLaneSummary = summarizeLaneRows(selectedLaneRows);
  const rawSelectedLaneDestinations = selected ? listClientDestinationsByLane(selected, filters.period || "today", { lane: selectedLane, limit: 16 }) : [];
  const selectedLaneDestinations = rawSelectedLaneDestinations.length ? rawSelectedLaneDestinations : fallbackClientDestinationRows(selected, selectedRoute, selectedLane);
  const rawSelectedAllDestinations = selected ? listClientDestinationsByLane(selected, filters.period || "today", { lane: "all", limit: 120 }) : [];
  const selectedAllDestinations = rawSelectedAllDestinations.length ? rawSelectedAllDestinations : fallbackClientDestinationRows(selected, selectedRoute, "all");
  const selectedDomainBreakdown = selected ? listClientDomainBreakdown(selected, filters.period || "today", { limit: 120 }) : [];
  const selectedSiteRows = [...selectedAllDestinations, ...selectedDomainBreakdown];
  const selectedClientSites = groupPopularSites(selectedSiteRows, "client", 15);
  const selectedServiceSites = groupPopularSites(selectedSiteRows, "service", 8);
  const selectedClientFallbackSites = counterFallbackRows(selected, selectedLaneRows, selectedRoute, "client");
  const selectedServiceCounterSites = counterOnlyRows(selectedSiteRows, "service", 1);
  const selectedDnsFallback = dnsInterestRows(selectedDns, 15);
  const selectedRouteEvidence = selected ? listRouteEvidenceDefects(filters.period || "today", { client: selected, limit: 12 }) : [];
  const selectedEvidenceSummary = evidenceSummary(selectedRouteEvidence, Number(selected?.total_bytes || 0));
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "client" ? filters.trafficClass : undefined,
    search: filters.search,
    showInactive: showInactive ? "1" : undefined,
  };
  const laneHref = (lane: string) => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    next.set("page", String(clientsPage.page));
    next.set("pageSize", String(clientsPage.pageSize));
    if (selected) next.set("client", String(selectedClientId));
    if (lane !== "all") next.set("lane", lane);
    return `/clients?${next.toString()}`;
  };
  const clientHref = (row: Record<string, any>) => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    next.set("page", String(clientsPage.page));
    next.set("pageSize", String(clientsPage.pageSize));
    next.set("client", String(selectedClientValue(row)));
    if (selectedLane !== "all") next.set("lane", selectedLane);
    return `/clients?${next.toString()}`;
  };
  const isSelectedRow = (row: Record<string, any>) => selectedClientId ? selectedClientValue(row) === selectedClientId || matchesClientFilter(row, selectedClientId) : false;
  return (
    <ConsoleShell active="/clients" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <MetricCard label="Traffic-active" value={String(activeRows.length)} detail="clients with traffic in selected window" />
        <MetricCard label="Known/trusted" value={String(knownRows.length)} detail="operator-attributed or inferred" />
        <MetricCard label="Needs attribution" value={String(unattributedRows.length)} detail="active traffic not in client repo" />
        <MetricCard label="Inactive hidden" value={String((clientsPage as any).hiddenInactive || 0)} detail={showInactive ? "shown from client repo" : "registered clients without window traffic"} />
      </div>
      <div className="grid two clients-layout">
        <section className="card clients-card">
          <div className="toolbar">
            <h2>Device Inventory</h2>
            <div className="clients-toolbar-meta">
              <span className="subtle">{clientsPage.total} devices · traffic for selected window</span>
              <form className="inline-check-form" action="/clients">
                {Object.entries(filterParams).filter(([key, value]) => key !== "showInactive" && value).map(([key, value]) => (
                  <input key={key} type="hidden" name={key} value={String(value)} />
                ))}
                <input type="hidden" name="pageSize" value={String(clientsPage.pageSize)} />
                <label>
                  <input type="checkbox" name="showInactive" value="1" defaultChecked={showInactive} />
                  Show inactive registered clients
                </label>
                <button type="submit">Apply</button>
              </form>
            </div>
          </div>
          {clientsPage.rows.length === 0 ? (
            <EmptyState title="No factual inventory" />
          ) : (
            <>
              <div className="clients-table-scroll">
                <table className="table clients-table">
                  <thead>
                    <tr>
                      <th className="col-client">Device</th>
                      <th>Channel</th>
                      <th className="col-traffic">Window traffic</th>
                      <th>Owner/Profile</th>
                      <th>Type</th>
                      <th>Last seen</th>
                      <th>Status</th>
                      <th className="col-route">Route</th>
                    </tr>
                  </thead>
                  <tbody>
                    {primaryRows.map((row) => (
                      <tr key={row.id || row.label} className={`clickable-row ${isSelectedRow(row) ? "selected" : ""}`}>
                        <td><a className="row-link" href={clientHref(row)}>{row.device_label || row.label || row.id}</a></td>
                        <td><a className="row-link row-link-with-badges" href={clientHref(row)}><ChannelBadge value={row.channel} /></a></td>
                        <td><a className="row-link" href={clientHref(row)}>{bytes(row.total_bytes || 0)}</a></td>
                        <td><a className="row-link" href={clientHref(row)}>{row.owner || row.client_label || "Inventory"}</a></td>
                        <td><a className="row-link" href={clientHref(row)}>{row.device_type || row.role || "Unknown device"}</a></td>
                        <td><a className="row-link" href={clientHref(row)}>{timeWithMillis(row.display_ts_utc || row.last_seen || row.event_ts_utc || row.collected_at, true)}</a></td>
                        <td><a className="row-link row-link-with-badges" href={clientHref(row)}><StatusBadge value={row.status || "Inactive"} /></a></td>
                        <td><a className="row-link row-link-with-badges" href={clientHref(row)}><RouteBadge value={routeFromBytes(row)} /></a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {unattributedRows.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Needs attribution / low-signal sources</h3>
                  <div className="clients-table-scroll">
                    <table className="table clients-table">
                      <thead>
                        <tr>
                          <th className="col-client">Device</th>
                          <th>Channel</th>
                          <th className="col-traffic">Window traffic</th>
                          <th>Role</th>
                          <th>Last seen</th>
                          <th>Status</th>
                          <th className="col-route">Route</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unattributedRows.map((row) => (
                          <tr key={row.id || row.label} className={`clickable-row ${isSelectedRow(row) ? "selected" : ""}`}>
                            <td><a className="row-link" href={clientHref(row)}>{row.label || row.id}</a></td>
                            <td><a className="row-link row-link-with-badges" href={clientHref(row)}><ChannelBadge value={row.channel} /></a></td>
                            <td><a className="row-link" href={clientHref(row)}>{bytes(row.total_bytes || 0)}</a></td>
                            <td><a className="row-link" href={clientHref(row)}>{row.role || "Unknown device"}</a></td>
                            <td><a className="row-link" href={clientHref(row)}>{timeWithMillis(row.display_ts_utc || row.last_seen || row.event_ts_utc || row.collected_at, true)}</a></td>
                            <td><a className="row-link row-link-with-badges" href={clientHref(row)}><StatusBadge value={row.status || "Inactive"} /></a></td>
                            <td><a className="row-link row-link-with-badges" href={clientHref(row)}><RouteBadge value={routeFromBytes(row)} /></a></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              <Pagination
                basePath="/clients"
                page={clientsPage.page}
                pageSize={clientsPage.pageSize}
                total={clientsPage.total}
                totalPages={clientsPage.totalPages}
                extraParams={filterParams}
              />
            </>
          )}
        </section>
        {mobile ? null : <aside className="card side-panel">
          <div className="panel-title">
            <h2>{selected?.label || "Client details"}</h2>
            <ConfidenceBadge value={selected?.confidence} />
          </div>
          {!selected ? (
            <EmptyState title="Select a device after snapshots appear" />
          ) : (
            <>
              <div className="detail-list">
                <div className="detail-row"><span>Window traffic</span><strong>{bytes(selected.total_bytes || 0)}</strong></div>
                <div className="detail-row"><span>Owner/Profile</span><strong>{selected.owner || selected.client_label || "Inventory"}</strong></div>
                <div className="detail-row"><span>Device type</span><strong>{selected.device_type || selected.role || "Unknown device"}</strong></div>
                {selected.aliases?.length > 1 ? (
                  <div className="detail-row"><span>Observed labels</span><strong>{selected.aliases.slice(0, 4).join(", ")}</strong></div>
                ) : null}
                {selected.observed_identities?.length ? (
                  <div className="detail-row">
                    <span>Observed identities</span>
                    <strong>{selected.observed_identities.slice(0, 8).join(", ")}</strong>
                  </div>
                ) : null}
                <div className="detail-row"><span>Access channel</span><strong><ChannelBadge value={selected.channel} /></strong></div>
                <div className="detail-row"><span>Status</span><strong><StatusBadge value={selected.status || "Inactive"} /></strong></div>
                <div className="detail-row"><span>Last seen</span><strong>{timeWithMillis(selected.display_ts_utc || selected.last_seen || selected.event_ts_utc || selected.collected_at, true)}</strong></div>
                <div className="detail-row"><span>Traffic observed</span><strong>{selected.traffic_collected_at ? timeWithMillis(selected.traffic_collected_at, true) : "not in window"}</strong></div>
                <div className="detail-row"><span>Route behavior</span><strong><RouteBadge value={selectedRoute} /></strong></div>
                <div className="detail-row"><span>Confidence</span><strong>{selected.confidence || "unknown"}</strong></div>
              </div>
              <SplitBars
                vps={selected.via_vps_bytes || 0}
                direct={selected.direct_bytes || 0}
                unknown={Math.max(0, Number(selected.total_bytes || 0) - Number(selected.via_vps_bytes || 0) - Number(selected.direct_bytes || 0))}
              />
              <h3>Traffic lanes</h3>
              <div className="detail-list">
                {laneTabs.map((tab) => (
                  <div className="detail-row" key={tab.value}>
                    <span>
                      <a href={laneHref(tab.value)}>{tab.label}</a>
                      <small className="subtle block-detail">
                        {(selectedLaneSummary[tab.value]?.flows || 0)} flows · {(selectedLaneSummary[tab.value]?.destinations || 0)} destinations
                      </small>
                    </span>
                    <strong>{bytes(selectedLaneSummary[tab.value]?.bytes || 0)}</strong>
                  </div>
                ))}
              </div>
              <nav className="intelligence-tabs" aria-label="Client traffic lane filters">
                {laneTabs.map((tab) => (
                  <a className={`muted-button ${selectedLane === tab.value ? "active" : ""}`} href={laneHref(tab.value)} key={tab.value}>
                    {tab.label}
                  </a>
                ))}
              </nav>
              <h3>Route evidence</h3>
              <div className="detail-list">
                <div className="detail-row"><span>Proven</span><strong>{bytes(selectedEvidenceSummary.proven)}</strong></div>
                <div className="detail-row"><span>Counter allocated</span><strong>{bytes(selectedEvidenceSummary.counter)}</strong></div>
                <div className="detail-row"><span>Policy intent</span><strong>{bytes(selectedEvidenceSummary.intent)}</strong></div>
                <div className="detail-row"><span>Mismatch</span><strong>{bytes(selectedEvidenceSummary.mismatch)}</strong></div>
                <div className="detail-row"><span>Unknown</span><strong>{bytes(selectedEvidenceSummary.unknown)}</strong></div>
              </div>
              {selectedRouteEvidence.length ? (
                <div className="detail-list">
                  {selectedRouteEvidence.slice(0, 6).map((row: Record<string, any>) => (
                    <div className="detail-row" key={`${row.destination_key}-${row.route_evidence}-${row.route_verification}`}>
                      <span>
                        {trafficDisplayDestination(row)}
                        <small className="subtle block-detail">{title(row.route_evidence)} · {title(row.route_verification)} · {title(row.traffic_lane)}</small>
                      </span>
                      <strong>{bytes(row.bytes || row.total_bytes || 0)} <RouteBadge value={row.route} /></strong>
                    </div>
                  ))}
                </div>
              ) : <div className="subtle">No route evidence defects for the selected window.</div>}
              <h3>Client activity</h3>
              <ClientActivityChart rows={selectedActivity} />
              <h3>Destinations by lane</h3>
              {selectedLaneDestinations.length === 0 ? (
                <EmptyState title="No destinations for selected lane" />
              ) : (
                <div className="detail-list">
                  {selectedLaneDestinations.map((row: Record<string, any>) => (
                    <div className="detail-row" key={`${row.destination_key}-${row.traffic_lane}-${row.route}-${row.decision_hint}`}>
                      <span>
                        {trafficDisplayDestination(row)}
                        <small className="subtle block-detail">
                          {title(row.traffic_lane)} · {title(row.dns_category)} · {row.provider || row.category || title(row.decision_hint)}
                        </small>
                      </span>
                      <strong>{bytes(row.bytes || 0)} <RouteBadge value={row.route || routeFromBytes(row)} /></strong>
                    </div>
                  ))}
                </div>
              )}
              <h3 style={{ marginTop: 16 }}>DNS interest</h3>
              {selectedDns.length === 0 ? (
                <div className="subtle">No DNS rows tied to this client in the latest snapshots.</div>
              ) : (
                <div className="detail-list">
                  {selectedDns.map((row: Record<string, any>, idx: number) => (
                    <div className="detail-row" key={idx}>
                      <span>{row.domain}</span>
                      <strong>{row.count}</strong>
                    </div>
                  ))}
                </div>
              )}
              <h3 style={{ marginTop: 16 }}>Alerts</h3>
              {selectedAlerts.length === 0 ? (
                <div className="subtle">No client-specific alerts in latest snapshots.</div>
              ) : (
                <div className="detail-list">
                  {selectedAlerts.map((row: Record<string, any>, idx: number) => (
                    <div className="detail-row" key={idx}>
                      <span>
                        {row.title}
                        {row.detail ? <small className="subtle block-detail">{row.detail}</small> : null}
                      </span>
                      <strong>{row.severity}</strong>
                    </div>
                  ))}
                </div>
              )}
              <ConfidenceHelp />
              <RawEvidence value={{
                client: selected,
                laneSummary: selectedLaneRows,
                laneDestinations: selectedLaneDestinations,
                routeEvidence: selectedRouteEvidence,
                activity: selectedActivity,
                flows: selectedFlows,
                dns: selectedDns,
                alerts: selectedAlerts,
              }} />
            </>
          )}
        </aside>}
      </div>
      {!mobile && selected ? (
        <section className="client-popular-sites-section" style={{ marginTop: 14 }}>
          <div className="toolbar">
            <h2>Most popular sites for {selected.label || selected.client_label || selected.id}</h2>
            <span className="subtle">{filters.period || "today"} · traffic and DNS interest for selected client</span>
          </div>
          <div className="grid two">
            <PopularSitesList title="Client sites" rows={selectedClientSites} dnsFallback={selectedDnsFallback} counterFallback={selectedClientFallbackSites} />
            <PopularSitesList title="Service/system sites" rows={selectedServiceSites} counterFallback={selectedServiceCounterSites} />
          </div>
        </section>
      ) : null}
    </ConsoleShell>
  );
}
