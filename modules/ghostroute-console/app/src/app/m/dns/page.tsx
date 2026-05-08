import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listDnsQueryLog } from "@/lib/server/selectors/dns";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileDnsList, MobileSection, routeFilterForm, scalar } from "../mobile-ui";

export default async function MobileDnsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const dnsPage = listDnsQueryLog({ page, pageSize, filters: { ...filters, trafficClass: "all" } });
  const model = buildLightweightShellModel(filters, { dnsQueries: dnsPage.rows });
  const filterParams = {
    route: filters.route !== "all" ? filters.route : undefined,
    search: filters.search || undefined,
  };
  return (
    <MobileShell active="/m/dns" model={model} filters={filters} desktopPath="/dns">
      {routeFilterForm({ action: "/m/dns", route: filters.route, search: filters.search })}
      <MobileSection title="DNS Query Log" detail={`${dnsPage.total} rows`}>
        <MobileDnsList rows={dnsPage.rows} />
        <Pagination basePath="/m/dns" page={dnsPage.page} pageSize={dnsPage.pageSize} total={dnsPage.total} totalPages={dnsPage.totalPages} extraParams={filterParams} />
      </MobileSection>
    </MobileShell>
  );
}
