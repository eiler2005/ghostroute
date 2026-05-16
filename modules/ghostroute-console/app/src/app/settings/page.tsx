import { ConsoleShell } from "@/components/ConsoleShell";
import { ChannelBadge, RouteBadge, StatusBadge, TrafficTermsHelp } from "@/components/Widgets";
import { buildSettingsModel } from "@/lib/server/selectors/settings";
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

function PolicyBadge({ value }: { value?: string }) {
  const label = String(value || "unknown").replace(/_/g, " ");
  return <span className="badge">{label}</span>;
}

function ReadonlyToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`readonly-toggle ${on ? "on" : "off"}`} title={`${label}: read-only policy state`}>
      <span aria-hidden="true" />
      <b>{on ? "On" : "Off"}</b>
    </span>
  );
}

function RoutingPolicySection({ policy }: { policy: Record<string, any> }) {
  const homeClients = Array.isArray(policy.home_wifi_lan_full_vps) ? policy.home_wifi_lan_full_vps : [];
  const profiles = Array.isArray(policy.channel_profiles) ? policy.channel_profiles : [];
  const summary = policy.summary || {};
  return (
    <section className="card settings-policy-section">
      <div className="section-heading-row">
        <div>
          <h2>Routing policy</h2>
          <p>Readonly view of selected full-VPS sets and Channel A/B/C profile policy from the sanitized local policy snapshot.</p>
        </div>
        <StatusBadge value={policy.status || "missing"} />
      </div>

      <div className="policy-summary-grid">
        <div><span>Home full-VPS</span><strong>{summary.home_full_vps || 0}</strong></div>
        <div><span>Channel A full-VPS</span><strong>{summary.channel_a_full_vps || 0}</strong></div>
        <div><span>Channel B profiles</span><strong>{summary.channel_b_profiles || 0}</strong></div>
        <div><span>Channel C profiles</span><strong>{summary.channel_c_profiles || 0}</strong></div>
      </div>

      <h3>Home Wi-Fi/LAN full-VPS</h3>
      {homeClients.length === 0 ? (
        <p className="muted">No selected home Wi-Fi/LAN full-VPS clients in the sanitized snapshot.</p>
      ) : (
        <table className="table policy-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Selector</th>
              <th>Network tokens</th>
              <th>DNS</th>
              <th>Route</th>
              <th>Full-VPS</th>
            </tr>
          </thead>
          <tbody>
            {homeClients.map((row: any) => (
              <tr key={row.id || row.name}>
                <td>
                  <strong>{row.label || row.name}</strong>
                  <small>{row.interface || "br0"}</small>
                </td>
                <td>{row.selector || "reserved_source_ip"}</td>
                <td>
                  <span className="policy-token">{row.ip_token || "ip-missing"}</span>
                  <span className="policy-token">{row.mac_token || "mac-missing"}</span>
                </td>
                <td><StatusBadge value={row.strict_dns_status || "missing"} /></td>
                <td><RouteBadge value={row.route || "VPS"} /></td>
                <td><ReadonlyToggle on={Boolean(row.full_vps)} label="Home full-VPS" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Channel profiles</h3>
      {profiles.length === 0 ? (
        <p className="muted">No Channel A/B/C profiles in the sanitized snapshot.</p>
      ) : (
        <table className="table policy-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>Channel</th>
              <th>Type</th>
              <th>Policy</th>
              <th>Status</th>
              <th>Profile</th>
              <th>Full-VPS</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((row: any) => (
              <tr key={row.id || `${row.channel}:${row.profile}`}>
                <td><strong>{row.label || row.profile}</strong></td>
                <td><ChannelBadge value={`Channel ${row.channel || "A"}`} /></td>
                <td>{row.profile_type || "profile"}</td>
                <td><PolicyBadge value={row.policy} /></td>
                <td><StatusBadge value={row.status || "unknown"} /></td>
                <td><ReadonlyToggle on={Boolean(row.profile_enabled)} label="Profile enabled" /></td>
                <td>
                  {row.full_vps_supported ? (
                    <ReadonlyToggle on={Boolean(row.full_vps)} label="Profile full-VPS" />
                  ) : (
                    <span className="policy-not-supported">Not supported</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        <p>Readonly inventory of Console runtime, routing policy, collectors, caches, access profile and safety gates. Secret-like values are shown only as configured/missing.</p>
      </section>
      <RoutingPolicySection policy={model.routingPolicy || inventory.routingPolicy || {}} />
      <div className="grid two">
        <SettingsSection title="Routing Policy Source" rows={inventory.routingPolicyOverview || []} />
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
          <h2>What the terms mean</h2>
          <p>Short reference for ingress, egress, rules and confidence labels.</p>
        </div>
        <TrafficTermsHelp />
      </section>
    </ConsoleShell>
  );
}
