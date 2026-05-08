import Link from "next/link";
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
  shortDateTime,
  SplitBars,
  StatusBadge,
} from "@/components/Widgets";
import { buildClientsModel, listClientActivity, listClientInventory } from "@/lib/server/selectors/clients";
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
  return client?.client_key || client?.id || client?.label || client?.device_key || client?.client_label || client?.device_label || "";
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

export default async function ClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const mobile = await isMobileRequest();
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = boundedPageSize(scalar(params.pageSize), { desktop: 25, mobile: 10, min: 10, desktopMax: 100, mobileMax: 10 }, mobile);
  const clientsPage = listClientInventory({ page, pageSize, filters });
  const isUnattributed = (row: Record<string, any>) =>
    row.role === "Unattributed mobile ingress source" ||
    (row.role === "Unknown device" && Number(row.total_bytes || 0) < 1024 * 1024);
  const primaryRows = clientsPage.rows.filter((row) => !isUnattributed(row));
  const unattributedRows = clientsPage.rows.filter((row) => isUnattributed(row));
  const activeRows = clientsPage.rows.filter((row) => Number(row.total_bytes || 0) > 0 || ["Online", "Recently seen"].includes(String(row.status || "")));
  const knownRows = primaryRows.filter((row) => !String(row.role || row.label || "").toLowerCase().includes("unknown"));
  const selected =
    clientsPage.rows.find((row) => filters.client !== "all" && matchesClientFilter(row, filters.client)) ||
    primaryRows[0] ||
    clientsPage.rows[0];
  const selectedClientId = selectedClientValue(selected);
  const trafficRows = selected ? listFlowSessions({ page: 1, pageSize: mobile ? 25 : 80, filters: { ...filters, client: selectedClientId } }).rows : [];
  const model = buildClientsModel(filters, clientsPage.rows, trafficRows);
  const tokens = clientTokens(selected);
  const allSelectedFlows = selected ? trafficRows.filter((row: Record<string, any>) => belongsToClient(row, tokens)) : [];
  const selectedFlows = allSelectedFlows.slice(0, 8);
  const selectedDns = selected ? aggregateDnsInterest(model.dnsQueries.filter((row: Record<string, any>) => belongsToClient(row, tokens)), 8) : [];
  const selectedAlerts = selected ? model.alerts.filter((row: Record<string, any>) => belongsToClient(row, tokens)).slice(0, 5) : [];
  const selectedRoute = selected ? routeFromBytes(selected) : "Unknown";
  const selectedActivity = selected ? listClientActivity(selected, filters.period || "today") : [];
  const selectedAttributedBytes = allSelectedFlows.reduce((sum, row) => sum + Number(row.bytes || row.total_bytes || 0), 0);
  const selectedUnattributedBytes = Math.max(0, Number(selected?.total_bytes || 0) - selectedAttributedBytes);
  const selectedDomainRows = selectedUnattributedBytes > 0
    ? [
        ...selectedFlows,
        {
          destination: "Unknown/Unattributed client traffic",
          destinationLabel: "Unknown/Unattributed client traffic",
          bytes: selectedUnattributedBytes,
          route: selectedRoute,
          accounting_bucket: true,
        },
      ]
    : selectedFlows;
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "client" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };
  const clientHref = (row: Record<string, any>) => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    next.set("page", String(clientsPage.page));
    next.set("pageSize", String(clientsPage.pageSize));
    next.set("client", String(selectedClientValue(row)));
    return `/clients?${next.toString()}`;
  };
  const isSelectedRow = (row: Record<string, any>) => selectedClientId ? matchesClientFilter(row, selectedClientId) : false;
  return (
    <ConsoleShell active="/clients" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <MetricCard label="Devices" value={String(clientsPage.total)} detail="inventory rows in selected view" />
        <MetricCard label="Known/trusted" value={String(knownRows.length)} detail="operator-attributed or inferred" />
        <MetricCard label="Unknown" value={String(unattributedRows.length)} detail="needs attribution review" />
        <MetricCard label="Active now" value={String(activeRows.length)} detail="traffic or recent status" />
      </div>
      <div className="grid two clients-layout">
        <section className="card clients-card">
          <div className="toolbar">
            <h2>Device Inventory</h2>
            <span className="subtle">{clientsPage.total} devices · traffic for selected window</span>
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
                        <td><Link className="row-link" href={clientHref(row)}>{row.device_label || row.label || row.id}</Link></td>
                        <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><ChannelBadge value={row.channel} /></Link></td>
                        <td><Link className="row-link" href={clientHref(row)}>{bytes(row.total_bytes || 0)}</Link></td>
                        <td><Link className="row-link" href={clientHref(row)}>{row.owner || row.client_label || "Inventory"}</Link></td>
                        <td><Link className="row-link" href={clientHref(row)}>{row.device_type || row.role || "Unknown device"}</Link></td>
                        <td><Link className="row-link" href={clientHref(row)}>{shortDateTime(row.last_seen || row.collected_at)}</Link></td>
                        <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><StatusBadge value={row.status || "Inactive"} /></Link></td>
                        <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><RouteBadge value={routeFromBytes(row)} /></Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {unattributedRows.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Unattributed ingress / low-signal sources</h3>
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
                            <td><Link className="row-link" href={clientHref(row)}>{row.label || row.id}</Link></td>
                            <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><ChannelBadge value={row.channel} /></Link></td>
                            <td><Link className="row-link" href={clientHref(row)}>{bytes(row.total_bytes || 0)}</Link></td>
                            <td><Link className="row-link" href={clientHref(row)}>{row.role || "Unknown device"}</Link></td>
                            <td><Link className="row-link" href={clientHref(row)}>{shortDateTime(row.last_seen || row.collected_at)}</Link></td>
                            <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><StatusBadge value={row.status || "Inactive"} /></Link></td>
                            <td><Link className="row-link row-link-with-badges" href={clientHref(row)}><RouteBadge value={routeFromBytes(row)} /></Link></td>
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
                <div className="detail-row"><span>Last seen</span><strong>{shortDateTime(selected.last_seen || selected.collected_at)}</strong></div>
                <div className="detail-row"><span>Traffic observed</span><strong>{selected.traffic_collected_at ? shortDateTime(selected.traffic_collected_at) : "not in window"}</strong></div>
                <div className="detail-row"><span>Route behavior</span><strong><RouteBadge value={selectedRoute} /></strong></div>
                <div className="detail-row"><span>Confidence</span><strong>{selected.confidence || "unknown"}</strong></div>
              </div>
              <SplitBars vps={selected.via_vps_bytes || 0} direct={selected.direct_bytes || 0} />
              <h3>Client activity</h3>
              <ClientActivityChart rows={selectedActivity} />
              <h3>Top domains</h3>
              {selectedDomainRows.length === 0 ? (
                <EmptyState title="No domains for selected client" />
              ) : (
                <div className="detail-list">
                  {selectedDomainRows.map((row: Record<string, any>, idx: number) => (
                    <div className="detail-row" key={idx}>
                      <span>{trafficDisplayDestination(row)}</span>
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
              <RawEvidence value={{ client: selected, activity: selectedActivity, flows: selectedFlows, dns: selectedDns, alerts: selectedAlerts }} />
            </>
          )}
        </aside>}
      </div>
    </ConsoleShell>
  );
}
