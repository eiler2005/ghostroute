import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import {
  bytes,
  ChannelBadge,
  ConfidenceBadge,
  ConfidenceHelp,
  EmptyState,
  RawEvidence,
  RouteBadge,
  routeFromBytes,
  SplitBars,
} from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function clientTokens(client?: Record<string, any>) {
  return [client?.label, client?.id, client?.ip, client?.profile, client?.client].filter(Boolean).map(String);
}

function belongsToClient(row: Record<string, any>, tokens: string[]) {
  if (tokens.length === 0) return false;
  const clientFields = [row.client, row.label, row.device_id, row.id, row.ip, row.source_ip].filter(Boolean).map(String);
  if (clientFields.some((value) => tokens.includes(value))) return true;
  const raw = JSON.stringify(row);
  return tokens.some((token) => token.length > 2 && raw.includes(token));
}

export default async function ClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const evidenceModel = buildConsoleModel({ ...filters, client: "all" });
  const selected =
    evidenceModel.devices.find((row) => filters.client !== "all" && (row.label === filters.client || row.id === filters.client)) ||
    model.devices[0];
  const selectedName = selected?.label || selected?.id || "";
  const tokens = clientTokens(selected);
  const selectedFlows = selected ? evidenceModel.flows.filter((row) => belongsToClient(row, tokens)).slice(0, 8) : [];
  const selectedDns = selected ? evidenceModel.dnsQueries.filter((row) => belongsToClient(row, tokens)).slice(0, 8) : [];
  const selectedAlerts = selected ? evidenceModel.alerts.filter((row) => belongsToClient(row, tokens)).slice(0, 5) : [];
  const selectedRoute = selected ? routeFromBytes(selected) : "Unknown";
  return (
    <ConsoleShell active="/clients" model={model} filters={filters}>
      <div className="grid two">
        <section className="card">
          <div className="toolbar">
            <h2>Устройства</h2>
            <span className="subtle">{model.devices.length} observed clients</span>
          </div>
          {model.devices.length === 0 ? (
            <EmptyState title="Нет фактической инвентаризации" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="col-client">Device</th>
                  <th className="col-traffic">Total</th>
                  <th className="col-traffic">VPS</th>
                  <th className="col-traffic">Direct</th>
                  <th>Channel</th>
                  <th className="col-route">Route</th>
                  <th className="col-confidence">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {model.devices.map((row) => (
                  <tr
                    key={row.id || row.label}
                    className={(row.label || row.id) === selectedName ? "selected" : ""}
                  >
                    <td><Link href={`/clients?client=${encodeURIComponent(row.label || row.id)}`}>{row.label || row.id}</Link></td>
                    <td>{bytes(row.total_bytes || 0)}</td>
                    <td>{bytes(row.via_vps_bytes || 0)}</td>
                    <td>{bytes(row.direct_bytes || 0)}</td>
                    <td><ChannelBadge value={row.channel} /></td>
                    <td><RouteBadge value={routeFromBytes(row)} /></td>
                    <td><ConfidenceBadge value={row.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                <div className="detail-row"><span>Access channel</span><strong><ChannelBadge value={selected.channel} /></strong></div>
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
                      <span>{row.destination || row.family || "n/a"}</span>
                      <strong><RouteBadge value={row.route || routeFromBytes(row)} /></strong>
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
