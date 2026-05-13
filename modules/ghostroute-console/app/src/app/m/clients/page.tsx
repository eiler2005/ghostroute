import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listClientInventory, listDnsQueryLog } from "@/lib/server/selectors/clients";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { aggregateDnsInterest } from "@/lib/traffic-window.mjs";
import { mobilePageSize, MobileClientList, MobileSection, scalar } from "../mobile-ui";

function normalizeToken(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function clientTokens(client?: Record<string, any>) {
  return [client?.client_key, client?.client_label, client?.device_key, client?.device_label, client?.label, client?.id, client?.ip, client?.profile, client?.client, ...(client?.aliases || []), ...(client?.observed_aliases || [])].filter(Boolean).map(String);
}

function matchesClientFilter(client: Record<string, any>, value?: string) {
  const target = normalizeToken(value);
  return Boolean(target) && clientTokens(client).some((token) => normalizeToken(token) === target);
}

function selectedClientValue(client?: Record<string, any>) {
  return client?.id || client?.device_key || client?.label || client?.client_key || client?.client_label || client?.device_label || "";
}

export default async function MobileClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const showInactive = scalar(params.showInactive) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const clientsPage = listClientInventory({ page, pageSize, filters, showInactive });
  const selectedClientParam = scalar(params.client) || "";
  const selectedLookup = selectedClientParam
    ? listClientInventory({ page: 1, pageSize: 1, filters: { ...filters, client: selectedClientParam }, showInactive: true }).rows[0]
    : undefined;
  const selected = selectedLookup || clientsPage.rows.find((row: Record<string, any>) => selectedClientParam && matchesClientFilter(row, selectedClientParam)) || clientsPage.rows[0];
  const selectedDnsRows = selected ? listDnsQueryLog({ page: 1, pageSize: 200, filters: { ...filters, trafficClass: "all", client: selectedClientValue(selected) } }).rows : [];
  const selectedDns = selected ? aggregateDnsInterest(selectedDnsRows, 8) : [];
  const model = buildLightweightShellModel(filters, { devices: clientsPage.rows });
  const filterParams = {
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search || undefined,
    showInactive: showInactive ? "1" : undefined,
  };
  return (
    <MobileShell active="/m/clients" model={model} filters={filters} desktopPath="/clients">
      <MobileSection title="Clients" detail={`${clientsPage.total} devices`}>
        <form className="mobile-filter" action="/m/clients">
          {filters.search ? <input type="hidden" name="search" value={filters.search} /> : null}
          <label className="mobile-check-label">
            <input type="checkbox" name="showInactive" value="1" defaultChecked={showInactive} />
            Show inactive registered clients
          </label>
          <button type="submit">Apply</button>
        </form>
        <MobileClientList rows={clientsPage.rows} />
        <Pagination basePath="/m/clients" page={clientsPage.page} pageSize={clientsPage.pageSize} total={clientsPage.total} totalPages={clientsPage.totalPages} extraParams={filterParams} />
      </MobileSection>
      <MobileSection title="Latest DNS domains" detail={selected?.label || selected?.client_label || "selected device"}>
        {selectedDns.length === 0 ? (
          <div className="mobile-empty">No DNS domains for this device.</div>
        ) : (
          <div className="mobile-list">
            {selectedDns.map((row: Record<string, any>) => (
              <div className="mobile-row" key={row.domain}>
                <span>
                  <strong>{row.domain}</strong>
                  <small>DNS queries for selected device</small>
                </span>
                <span className="mobile-row-meta"><b>{row.count} queries</b></span>
              </div>
            ))}
          </div>
        )}
      </MobileSection>
    </MobileShell>
  );
}
