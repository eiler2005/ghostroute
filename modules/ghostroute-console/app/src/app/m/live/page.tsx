import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { listLiveEvents } from "@/lib/server/selectors/live";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileFlowList, MobileLiveList, MobileSection, routeFilterForm, scalar } from "../mobile-ui";

export default async function MobileLivePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await todayOnlyFiltersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const activityPage = Math.max(1, Number.parseInt(scalar(params.activityPage) || "1", 10) || 1);
  const activityPageSize = mobilePageSize(scalar(params.activityPageSize));
  const livePage = listLiveEvents({ page, pageSize, filters });
  const activity = listFlowSessions({ page: activityPage, pageSize: activityPageSize, maxPageSize: 25, filters });
  const model = buildLightweightShellModel(filters, { events: livePage.rows, flows: activity.rows });
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
        <Pagination basePath="/m/live" page={livePage.page} pageSize={livePage.pageSize} total={livePage.total} totalPages={livePage.totalPages} extraParams={{ ...filterParams, activityPage: activity.page, activityPageSize: activity.pageSize }} />
      </MobileSection>
      <MobileSection title="Client activity summary" detail={`${activity.total} flow rows`}>
        <MobileFlowList rows={activity.rows} />
        <Pagination basePath="/m/live" page={activity.page} pageParam="activityPage" pageSizeParam="activityPageSize" pageSize={activity.pageSize} total={activity.total} totalPages={activity.totalPages} extraParams={{ ...filterParams, page: livePage.page, pageSize: livePage.pageSize }} />
      </MobileSection>
    </MobileShell>
  );
}
