import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import {
  bytes,
  ChannelBadge,
  ConfidenceBadge,
  ConfidenceHelp,
  EmptyState,
  Pagination,
  RawEvidence,
  RouteBadge,
  routeFromBytes,
  shortDateTime,
  SplitBars,
  StatusBadge,
} from "@/components/Widgets";
import { buildPagedEvidenceContext, listClientInventory, listTrafficRows } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function clientTokens(client?: Record<string, any>) {
  return [client?.label, client?.id, client?.ip, client?.profile, client?.client, ...(client?.aliases || [])].filter(Boolean).map(String);
}

function belongsToClient(row: Record<string, any>, tokens: string[]) {
  if (tokens.length === 0) return false;
  const clientFields = [row.client, row.label, row.device_id, row.id, row.ip, row.source_ip].filter(Boolean).map(String);
  if (clientFields.some((value) => tokens.includes(value))) return true;
  const raw = JSON.stringify(row);
  return tokens.some((token) => token.length > 2 && raw.includes(token));
}

export default async function ClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(scalar(params.pageSize) || "25", 10) || 25));
  const clientsPage = listClientInventory({ page, pageSize, filters });
  const isUnattributed = (row: Record<string, any>) =>
    row.role === "Unattributed mobile ingress source" ||
    (row.role === "Unknown device" && Number(row.total_bytes || 0) < 1024 * 1024);
  const primaryRows = clientsPage.rows.filter((row) => !isUnattributed(row));
  const unattributedRows = clientsPage.rows.filter((row) => isUnattributed(row));
  const selected =
    clientsPage.rows.find((row) => filters.client !== "all" && (row.label === filters.client || row.id === filters.client)) ||
    primaryRows[0] ||
    clientsPage.rows[0];
  const trafficRows = selected ? listTrafficRows({ page: 1, pageSize: 80, filters: { ...filters, client: selected.label || selected.id } }).rows : [];
  const model = buildPagedEvidenceContext(filters, trafficRows);
  model.devices = clientsPage.rows;
  const selectedName = selected?.label || selected?.id || "";
  const tokens = clientTokens(selected);
  const selectedFlows = selected ? trafficRows.filter((row) => belongsToClient(row, tokens)).slice(0, 8) : [];
  const selectedDns = selected ? model.dnsQueries.filter((row) => belongsToClient(row, tokens)).slice(0, 8) : [];
  const selectedAlerts = selected ? model.alerts.filter((row) => belongsToClient(row, tokens)).slice(0, 5) : [];
  const selectedRoute = selected ? routeFromBytes(selected) : "Unknown";
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
    <ConsoleShell active="/clients" model={model} filters={filters}>
      <div className="grid two">
        <section className="card clients-card">
          <div className="toolbar">
            <h2>Устройства</h2>
            <span className="subtle">{clientsPage.total} known clients</span>
          </div>
          {clientsPage.rows.length === 0 ? (
            <EmptyState title="Нет фактической инвентаризации" />
          ) : (
            <>
              <table className="table clients-table">
                <thead>
                  <tr>
                    <th className="col-client">Device</th>
                    <th>Role</th>
                    <th>Last seen</th>
                    <th>Status</th>
                    <th>Channel</th>
                    <th className="col-route">Route</th>
                    <th className="col-traffic">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {primaryRows.map((row) => (
                    <tr
                      key={row.id || row.label}
                      className={(row.label || row.id) === selectedName ? "selected" : ""}
                    >
                      <td><Link href={`/clients?client=${encodeURIComponent(row.label || row.id)}`}>{row.label || row.id}</Link></td>
                      <td>{row.role || "Unknown device"}</td>
                      <td>{shortDateTime(row.last_seen || row.collected_at)}</td>
                      <td><StatusBadge value={row.status || "Inactive"} /></td>
                      <td><ChannelBadge value={row.channel} /></td>
                      <td><RouteBadge value={routeFromBytes(row)} /></td>
                      <td>{bytes(row.total_bytes || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {unattributedRows.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Unattributed ingress / low-signal sources</h3>
                  <table className="table clients-table">
                    <thead>
                      <tr>
                        <th className="col-client">Device</th>
                        <th>Role</th>
                        <th>Last seen</th>
                        <th>Status</th>
                        <th>Channel</th>
                        <th className="col-route">Route</th>
                        <th className="col-traffic">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unattributedRows.map((row) => (
                        <tr key={row.id || row.label} className={(row.label || row.id) === selectedName ? "selected" : ""}>
                          <td><Link href={`/clients?client=${encodeURIComponent(row.label || row.id)}`}>{row.label || row.id}</Link></td>
                          <td>{row.role || "Unknown device"}</td>
                          <td>{shortDateTime(row.last_seen || row.collected_at)}</td>
                          <td><StatusBadge value={row.status || "Inactive"} /></td>
                          <td><ChannelBadge value={row.channel} /></td>
                          <td><RouteBadge value={routeFromBytes(row)} /></td>
                          <td>{bytes(row.total_bytes || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
        <aside className="card side-panel">
          <div className="panel-title">
            <h2>{selected?.label || "Client details"}</h2>
            <ConfidenceBadge value={selected?.confidence} />
          </div>
          {!selected ? (
            <EmptyState title="Выберите устройство после появления snapshots" />
          ) : (
            <>
              <div className="detail-list">
                <div className="detail-row"><span>Total</span><strong>{bytes(selected.total_bytes || 0)}</strong></div>
                <div className="detail-row"><span>Device role</span><strong>{selected.role || "Unknown device"}</strong></div>
                {selected.aliases?.length > 1 ? (
                  <div className="detail-row"><span>Observed labels</span><strong>{selected.aliases.slice(0, 4).join(", ")}</strong></div>
                ) : null}
                <div className="detail-row"><span>Access channel</span><strong><ChannelBadge value={selected.channel} /></strong></div>
                <div className="detail-row"><span>Status</span><strong><StatusBadge value={selected.status || "Inactive"} /></strong></div>
                <div className="detail-row"><span>Last seen</span><strong>{shortDateTime(selected.last_seen || selected.collected_at)}</strong></div>
                <div className="detail-row"><span>Route behavior</span><strong><RouteBadge value={selectedRoute} /></strong></div>
                <div className="detail-row"><span>Confidence</span><strong>{selected.confidence || "unknown"}</strong></div>
              </div>
              <SplitBars vps={selected.via_vps_bytes || 0} direct={selected.direct_bytes || 0} />
              <h3>Top domains</h3>
              {selectedFlows.length === 0 ? (
                <EmptyState title="Нет доменов для выбранного клиента" />
              ) : (
                <div className="detail-list">
                  {selectedFlows.map((row, idx) => (
                    <div className="detail-row" key={idx}>
                      <span>{row.destinationLabel || row.destination || row.dns_qname || "n/a"}</span>
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
                  {selectedDns.map((row, idx) => (
                    <div className="detail-row" key={idx}>
                      <span>{row.domain || row.qname || "n/a"}</span>
                      <strong>{row.count || row.qtype || "seen"}</strong>
                    </div>
                  ))}
                </div>
              )}
              <h3 style={{ marginTop: 16 }}>Alerts</h3>
              {selectedAlerts.length === 0 ? (
                <div className="subtle">No client-specific alerts in latest snapshots.</div>
              ) : (
                <div className="detail-list">
                  {selectedAlerts.map((row, idx) => (
                    <div className="detail-row" key={idx}><span>{row.title}</span><strong>{row.severity}</strong></div>
                  ))}
                </div>
              )}
              <ConfidenceHelp />
              <RawEvidence value={{ client: selected, flows: selectedFlows, dns: selectedDns, alerts: selectedAlerts }} />
            </>
          )}
        </aside>
      </div>
    </ConsoleShell>
  );
}
