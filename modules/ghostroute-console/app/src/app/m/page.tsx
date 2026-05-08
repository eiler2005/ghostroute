import { MobileShell } from "@/components/MobileShell";
import { bytes } from "@/components/Widgets";
import { listClientInventory } from "@/lib/server/selectors/clients";
import { listDnsQueryLog } from "@/lib/server/selectors/dns";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { listLiveEvents } from "@/lib/server/selectors/live";
import { buildShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { MobileClientList, MobileDnsList, MobileFlowList, MobileLiveList, MobileSection } from "./mobile-ui";

export default async function MobileHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildShellModel(filters);
  const flows = listFlowSessions({ page: 1, pageSize: 5, filters }).rows;
  const dnsRows = listDnsQueryLog({ page: 1, pageSize: 5, filters: { ...filters, trafficClass: "all" } }).rows;
  const clients = listClientInventory({ page: 1, pageSize: 5, filters }).rows;
  const live = listLiveEvents({ page: 1, pageSize: 5, filters }).rows;
  return (
    <MobileShell active="/m" model={model} filters={filters} desktopPath="/">
      <section className="mobile-hero">
        <h1>GhostRoute Mobile</h1>
        <p>Fast read-only snapshot for iPhone and mobile browsers.</p>
      </section>
      <section className="mobile-kpis">
        <div><span>Observed</span><strong>{bytes(model.totals.observedBytes)}</strong></div>
        <div><span>Via VPS</span><strong>{bytes(model.totals.viaVpsBytes)}</strong></div>
        <div><span>Alerts</span><strong>{model.alerts.length}</strong></div>
      </section>
      <MobileSection title="Recent flows" href="/m/traffic"><MobileFlowList rows={flows} /></MobileSection>
      <MobileSection title="DNS interest" href="/m/dns"><MobileDnsList rows={dnsRows} /></MobileSection>
      <MobileSection title="Top clients" href="/m/clients"><MobileClientList rows={clients} /></MobileSection>
      <MobileSection title="Live events" href="/m/live"><MobileLiveList rows={live} /></MobileSection>
    </MobileShell>
  );
}
