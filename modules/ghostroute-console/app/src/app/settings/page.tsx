import { ConsoleShell } from "@/components/ConsoleShell";
import { TrafficTermsHelp } from "@/components/Widgets";
import { buildSettingsModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { clientRegistrySummary } from "@/lib/device-attribution.mjs";

function SettingsSection({ title, rows }: { title: string; rows: Array<Array<string | number>> }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="detail-list">
        {rows.map(([label, value]) => (
          <div className="detail-row" key={label}><span>{label}</span><strong>{value || "n/a"}</strong></div>
        ))}
      </div>
    </section>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildSettingsModel(filters);
  const registry = clientRegistrySummary();
  const unattributed = model.devices.filter((row) => row.role === "Unattributed mobile ingress source" || row.attribution_confidence === "unattributed").length;
  const inventory = model.settingsInventory || {};
  return (
    <ConsoleShell active="/settings" model={model} filters={filters}>
      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Settings</h2>
        <p>Readonly inventory of Console runtime, collectors, caches, access profile and safety gates. Secret-like values are shown only as configured/missing.</p>
      </section>
      <div className="grid two">
        <SettingsSection title="Runtime" rows={inventory.runtime || []} />
        <SettingsSection title="Collectors" rows={inventory.collectors || []} />
        <SettingsSection title="Retention / Cache" rows={inventory.retention || []} />
        <SettingsSection title="Access" rows={inventory.access || []} />
        <SettingsSection title="Data Sources" rows={inventory.dataSources || []} />
        <SettingsSection title="Read Models" rows={inventory.readModels || []} />
        <SettingsSection title="Collector Locks" rows={inventory.locks || []} />
        <SettingsSection title="Safety Gates" rows={inventory.safety || []} />
        <SettingsSection title="Notifications" rows={inventory.notifications || []} />
        <section className="card">
          <h2>Client registry</h2>
          <div className="detail-list">
            <div className="detail-row"><span>Canonical clients</span><strong>{registry.clients}</strong></div>
            <div className="detail-row"><span>Observed aliases</span><strong>{registry.aliases}</strong></div>
            <div className="detail-row"><span>Explicit MAC/IP aliases</span><strong>{registry.networkAliases}</strong></div>
            <div className="detail-row"><span>Unattributed diagnostics</span><strong>{unattributed}</strong></div>
            <div className="detail-row"><span>Unmatched reason</span><strong>{registry.unmatchedReason}</strong></div>
          </div>
        </section>
      </div>
      <section className="card" style={{ marginTop: 14 }}>
        <h2>Read-model rebuild state</h2>
        {(inventory.readModelState || []).length === 0 ? (
          <p>No read-model state rows yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Rebuilt</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {inventory.readModelState.map((row: any) => (
                <tr key={row.model}>
                  <td>{row.model}</td>
                  <td>{row.status}</td>
                  <td>{row.row_count}</td>
                  <td>{row.rebuilt_at}</td>
                  <td>{row.duration_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card terms-card" style={{ marginTop: 14 }}>
        <div>
          <h2>Что означают термины</h2>
          <p>Короткая справка по входам, выходам, правилам и confidence labels.</p>
        </div>
        <TrafficTermsHelp />
      </section>
    </ConsoleShell>
  );
}
