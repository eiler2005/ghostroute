import { ConsoleShell } from "@/components/ConsoleShell";
import { SettingsActions } from "@/components/SettingsActions";
import { buildConsoleModel } from "@/lib/server/selectors";
import { dataDir } from "@/lib/server/paths";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function SettingsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
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
      <SettingsActions />
    </ConsoleShell>
  );
}
