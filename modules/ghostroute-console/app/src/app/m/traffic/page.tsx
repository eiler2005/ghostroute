import { MobileShell } from "@/components/MobileShell";
import { Pagination } from "@/components/Widgets";
import { buildDashboardModel } from "@/lib/server/selectors/dashboard";
import { listFlowSessions } from "@/lib/server/selectors/traffic";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { mobilePageSize, MobileFlowList, MobileSection, routeFilterForm, scalar } from "../mobile-ui";

export default async function MobileTrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await todayOnlyFiltersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const canUsePreparedFirstPage = page === 1
    && !filters.search
    && (filters.route || "all") === "all"
    && (filters.channel || "all") === "all"
    && (filters.confidence || "all") === "all"
    && (filters.client || "all") === "all";
  const preparedModel = canUsePreparedFirstPage ? buildDashboardModel(filters) : null;
  const preparedRows = preparedModel?.flows?.slice(0, pageSize) || [];
  const trafficPage = preparedRows.length
    ? {
        rows: preparedRows,
        total: preparedModel?.flows?.length || preparedRows.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil((preparedModel?.flows?.length || preparedRows.length) / pageSize)),
      }
    : listFlowSessions({ page, pageSize, filters });
  const model = preparedModel || buildLightweightShellModel(filters, { flows: trafficPage.rows });
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
