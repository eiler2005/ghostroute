import { ConsoleShell } from "@/components/ConsoleShell";
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
          <div className="detail-row"><span>Access</span><strong>Tailnet-only via tailscale serve</strong></div>
          <div className="detail-row"><span>Data dir</span><strong>{dataDir()}</strong></div>
          <div className="detail-row"><span>Retention</span><strong>raw 7d, hourly aggregates 90d, backups 14d</strong></div>
          <div className="detail-row"><span>Mutating actions</span><strong>disabled / outside MVP</strong></div>
        </div>
      </section>
    </ConsoleShell>
  );
}
