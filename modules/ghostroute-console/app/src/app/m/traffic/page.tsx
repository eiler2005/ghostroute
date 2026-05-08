import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileFlowList, MobileSection, routeFilterForm, scalar } from "../mobile-ui";

export default async function MobileTrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const trafficPage = listFlowSessions({ page, pageSize, filters });
  const model = buildLightweightShellModel(filters, { flows: trafficPage.rows });
  const filterParams = {
    route: filters.route !== "all" ? filters.route : undefined,
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    search: filters.search || undefined,
  };
  return (
    <MobileShell active="/m/traffic" model={model} filters={filters} desktopPath="/traffic">
      {routeFilterForm({ action: "/m/traffic", route: filters.route, trafficClass: filters.trafficClass, search: filters.search })}
      <MobileSection title="Flow Explorer" detail={`${trafficPage.total} rows`}>
        <MobileFlowList rows={trafficPage.rows} />
        <Pagination basePath="/m/traffic" page={trafficPage.page} pageSize={trafficPage.pageSize} total={trafficPage.total} totalPages={trafficPage.totalPages} extraParams={filterParams} />
      </MobileSection>
    </MobileShell>
  );
}
