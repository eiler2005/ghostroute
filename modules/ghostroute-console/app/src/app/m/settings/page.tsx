import { MobileShell } from "@/components/MobileShell";
import { ChannelBadge, RouteBadge, StatusBadge } from "@/components/Widgets";
import { buildSettingsModel } from "@/lib/server/selectors/settings";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { MobileSection } from "../mobile-ui";

function PolicyBadge({ value }: { value?: string }) {
  return <span className="badge">{String(value || "unknown").replace(/_/g, " ")}</span>;
}

function ReadonlyToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`readonly-toggle ${on ? "on" : "off"}`} title={`${label}: read-only policy state`}>
      <span aria-hidden="true" />
      <b>{on ? "On" : "Off"}</b>
    </span>
  );
}

function SummaryGrid({ summary }: { summary: Record<string, any> }) {
  return (
    <section className="mobile-kpis">
      <div><span>Home</span><strong>{summary.home_full_vps || 0}</strong></div>
      <div><span>A full</span><strong>{summary.channel_a_full_vps || 0}</strong></div>
      <div><span>B</span><strong>{summary.channel_b_profiles || 0}</strong></div>
      <div><span>C</span><strong>{summary.channel_c_profiles || 0}</strong></div>
    </section>
  );
}

export default async function MobileSettingsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildSettingsModel(filters);
  const policy = model.routingPolicy || {};
  const summary = policy.summary || {};
  const homeClients = Array.isArray(policy.home_wifi_lan_full_vps) ? policy.home_wifi_lan_full_vps : [];
  const profiles = Array.isArray(policy.channel_profiles) ? policy.channel_profiles : [];

  return (
    <MobileShell active="/m/settings" model={model} filters={filters} desktopPath="/settings">
      <section className="mobile-hero">
        <h1>Settings</h1>
        <p>Readonly routing policy and Console posture.</p>
      </section>
      <MobileSection title="Routing policy" detail="Sanitized selected-device snapshot">
        <SummaryGrid summary={summary} />
      </MobileSection>

      <MobileSection title="Home Wi-Fi/LAN full-VPS" detail={`${homeClients.length} selected clients`}>
        {homeClients.length === 0 ? (
          <div className="mobile-empty">No selected home full-VPS clients.</div>
        ) : (
          <div className="mobile-list">
            {homeClients.map((row: any) => (
              <div className="mobile-row" key={row.id || row.name}>
                <span>
                  <strong>{row.label || row.name}</strong>
                  <small>{row.selector || "reserved_source_ip"} · {row.ip_token || "ip-missing"} · {row.mac_token || "mac-missing"}</small>
                </span>
                <span className="mobile-row-meta">
                  <RouteBadge value={row.route || "VPS"} />
                  <ReadonlyToggle on={Boolean(row.full_vps)} label="Home full-VPS" />
                </span>
              </div>
            ))}
          </div>
        )}
      </MobileSection>

      <MobileSection title="Channel profiles" detail={`${profiles.length} profiles`}>
        {profiles.length === 0 ? (
          <div className="mobile-empty">No Channel A/B/C profiles in the snapshot.</div>
        ) : (
          <div className="mobile-list">
            {profiles.map((row: any) => (
              <div className="mobile-row" key={row.id || `${row.channel}:${row.profile}`}>
                <span>
                  <strong>{row.label || row.profile}</strong>
                  <small>{row.profile_type || "profile"} · {row.outbound || "managed split"}</small>
                </span>
                <span className="mobile-row-meta">
                  <ChannelBadge value={`Channel ${row.channel || "A"}`} />
                  {row.full_vps_supported ? (
                    <ReadonlyToggle on={Boolean(row.full_vps)} label="Profile full-VPS" />
                  ) : (
                    <PolicyBadge value={row.policy} />
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </MobileSection>

      <MobileSection title="Policy source" detail={policy.source?.path || "policy-snapshot.local.json"}>
        <div className="mobile-list">
          <div className="mobile-row">
            <span>
              <strong>Snapshot</strong>
              <small>{policy.generated_at || "not collected"}</small>
            </span>
            <span className="mobile-row-meta"><StatusBadge value={policy.status || "missing"} /></span>
          </div>
        </div>
      </MobileSection>
    </MobileShell>
  );
}
