import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { bytes, EmptyState, RouteBadge, StatusBadge } from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function LivePage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const activeFlows = model.flows.slice(0, 14);
  const activeClients = [...model.devices].sort((a, b) => (b.total_bytes || 0) - (a.total_bytes || 0)).slice(0, 10);
  const dnsRows = model.dnsQueries.slice(0, 8);

  return (
    <ConsoleShell active="/live" model={model} filters={filters}>
      <div className="grid cards">
        <section className="card"><h3>Mode</h3><StatusBadge value="POLLING" /><p>Snapshot based, not WebSocket live</p></section>
        <section className="card"><h3>Freshness</h3><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`}</strong><p>{model.freshnessStatus}</p></section>
        <section className="card"><h3>Flows</h3><strong>{model.flows.length}</strong><p>observed rows</p></section>
        <section className="card"><h3>Clients</h3><strong>{model.devices.length}</strong><p>observed devices</p></section>
        <section className="card"><h3>DNS</h3><strong>{model.dnsQueries.length}</strong><p>DNS-interest rows</p></section>
        <section className="card"><h3>Alerts</h3><strong>{model.alerts.length}</strong><p>open signals</p></section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="toolbar">
            <h2>Live activity (polling)</h2>
            <span className="subtle">latest factual flow rows</span>
          </div>
          {activeFlows.length === 0 ? (
            <EmptyState title="Нет activity snapshot" />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Client</th><th>Destination</th><th>Route</th><th>Traffic</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {activeFlows.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.client || row.channel}</td>
                    <td><Link href={`/traffic?flow=${idx}`}>{row.destination || row.family}</Link></td>
                    <td><RouteBadge value={row.route || "Unknown"} /></td>
                    <td>{bytes(row.bytes || row.total_bytes || row.via_vps_bytes || row.direct_bytes || 0)}</td>
                    <td>{row.confidence || "unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
          <div className="detail-list">
            <div className="detail-row"><span>Clients</span><strong>{model.devices.length}</strong></div>
            <div className="detail-row"><span>Router</span><strong>dnsmasq + ipset + sing-box</strong></div>
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
