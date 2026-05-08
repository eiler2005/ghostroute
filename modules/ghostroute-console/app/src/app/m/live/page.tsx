import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listLiveEvents } from "@/lib/server/selectors/live";
import { buildShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileLiveList, MobileSection, routeFilterForm, scalar } from "../mobile-ui";

export default async function MobileLivePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const livePage = listLiveEvents({ page, pageSize, filters });
  const model = buildShellModel(filters, { events: livePage.rows });
  const filterParams = {
    route: filters.route !== "all" ? filters.route : undefined,
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    search: filters.search || undefined,
  };
  return (
    <MobileShell active="/m/live" model={model} filters={filters} desktopPath="/live">
      {routeFilterForm({ action: "/m/live", route: filters.route, trafficClass: filters.trafficClass, search: filters.search })}
      <MobileSection title="Live event stream" detail={`${livePage.total} events`}>
        <MobileLiveList rows={livePage.rows} />
        <Pagination basePath="/m/live" page={livePage.page} pageSize={livePage.pageSize} total={livePage.total} totalPages={livePage.totalPages} extraParams={filterParams} />
      </MobileSection>
    </MobileShell>
  );
}
