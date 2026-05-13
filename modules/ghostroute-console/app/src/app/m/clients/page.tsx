import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listClientInventory } from "@/lib/server/selectors/clients";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileClientList, MobileSection, scalar } from "../mobile-ui";

export default async function MobileClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const showInactive = scalar(params.showInactive) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const clientsPage = listClientInventory({ page, pageSize, filters, showInactive });
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
          <input type="hidden" name="search" value={filters.search || ""} />
          <label className="mobile-check-label">
            <input type="checkbox" name="showInactive" value="1" defaultChecked={showInactive} />
            Show inactive registered clients
          </label>
          <button type="submit">Apply</button>
        </form>
        <MobileClientList rows={clientsPage.rows} />
        <Pagination basePath="/m/clients" page={clientsPage.page} pageSize={clientsPage.pageSize} total={clientsPage.total} totalPages={clientsPage.totalPages} extraParams={filterParams} />
      </MobileSection>
    </MobileShell>
  );
}
