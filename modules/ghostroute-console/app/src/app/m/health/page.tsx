import { MobileShell } from "@/components/MobileShell";
import { buildHealthModel, listAlarmEvents } from "@/lib/server/selectors/health";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { MobileAlarmList, MobileHealthStatusList, MobileSection, Pagination, scalar, mobilePageSize } from "../mobile-ui";

export default async function MobileHealthPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const status = scalar(params.status) || "open";
  const alarms = listAlarmEvents({ page, pageSize, filters, status });
  const model = buildHealthModel(filters);
  const critical = alarms.rows.filter((row) => row.severity === "critical").length;
  const warning = alarms.rows.filter((row) => row.severity === "warning").length;

  return (
    <MobileShell active="/m/health" model={model} filters={filters} desktopPath="/health">
      <section className="mobile-kpis">
        <div><span>Health</span><strong>{model.statusCards.some((row) => row.status === "critical" || row.status === "fail") ? "Attention" : "OK"}</strong></div>
        <div><span>Critical</span><strong>{critical}</strong></div>
        <div><span>Warnings</span><strong>{warning}</strong></div>
      </section>

      <MobileSection title="Health Center" detail={`${model.statusCards.length} checks`}>
        <MobileHealthStatusList rows={model.statusCards} />
      </MobileSection>

      <MobileSection title="Alarm Center" detail={`${alarms.total} ${status} alarms`}>
        <MobileAlarmList rows={alarms.rows} />
        <Pagination basePath="/m/health" page={alarms.page} pageSize={alarms.pageSize} total={alarms.total} totalPages={alarms.totalPages} extraParams={{ status }} />
      </MobileSection>
    </MobileShell>
  );
}
