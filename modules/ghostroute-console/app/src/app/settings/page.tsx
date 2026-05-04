import { ConsoleShell } from "@/components/ConsoleShell";
import { SettingsActions } from "@/components/SettingsActions";
import { TrafficTermsHelp } from "@/components/Widgets";
import { buildSettingsModel } from "@/lib/server/selectors";
import { dataDir } from "@/lib/server/paths";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { clientRegistrySummary } from "@/lib/device-attribution.mjs";

export default async function SettingsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildSettingsModel(filters);
  const registry = clientRegistrySummary();
  const unattributed = model.devices.filter((row) => row.role === "Unattributed mobile ingress source" || row.attribution_confidence === "unattributed").length;
  return (
    <ConsoleShell active="/settings" model={model} filters={filters}>
      <section className="card">
        <h2>Settings</h2>
        <div className="detail-list">
          <div className="detail-row"><span>Mode</span><strong>single-user read-only</strong></div>
          <div className="detail-row"><span>Access</span><strong>Caddy Basic Auth; Tailnet identity optional hardening</strong></div>
          <div className="detail-row"><span>Data dir</span><strong>{dataDir()}</strong></div>
          <div className="detail-row"><span>Retention</span><strong>raw 7d, hourly aggregates 90d, backups 14d</strong></div>
          <div className="detail-row"><span>Controlled actions</span><strong>confirmation + audit + no hidden router deploy</strong></div>
          <div className="detail-row"><span>Audit entries</span><strong>{model.auditLog.length}</strong></div>
          <div className="detail-row"><span>Ops runs</span><strong>{model.opsRuns.length}</strong></div>
        </div>
      </section>
      <section className="card" style={{ marginTop: 14 }}>
        <h2>Client registry</h2>
        <div className="detail-list">
          <div className="detail-row"><span>Canonical clients</span><strong>{registry.clients}</strong></div>
          <div className="detail-row"><span>Observed aliases</span><strong>{registry.aliases}</strong></div>
          <div className="detail-row"><span>Explicit MAC/IP aliases</span><strong>{registry.networkAliases}</strong></div>
          <div className="detail-row"><span>Unattributed diagnostics</span><strong>{unattributed}</strong></div>
          <div className="detail-row"><span>Unmatched reason</span><strong>{registry.unmatchedReason}</strong></div>
        </div>
      </section>
      <SettingsActions />
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
