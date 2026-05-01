import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, Pagination, bytes, ChannelBadge, ConfidenceBadge, RouteBadge } from "@/components/Widgets";
import { RouteExplanation } from "@/components/RouteExplanation";
import { buildRouteEvidenceSet } from "@/lib/server/evidence";
import { buildPagedEvidenceContext, listTrafficRows } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const diagnostics = scalar(params.diagnostics) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(scalar(params.pageSize) || "10", 10) || 10));
  const trafficPage = listTrafficRows({ page, pageSize, filters, diagnostics });
  const model = buildPagedEvidenceContext(filters, trafficPage.rows);
  const evidenceSet = buildRouteEvidenceSet(model, { includeDiagnostics: diagnostics, limit: pageSize, fallbackToDiagnostics: true });
  const evidences = evidenceSet.evidences;
  const hasSelectedFlow = scalar(params.flow) !== undefined;
  const selectedIndex = Math.min(
    Math.max(Number.parseInt(scalar(params.flow) || "0", 10) || 0, 0),
    Math.max(evidences.length - 1, 0)
  );
  const evidence = hasSelectedFlow ? evidences[selectedIndex] || null : null;
  const filterParams = {
    period: filters.period,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "client" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };

  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      {evidences.length === 0 ? (
        <section className="card">
          <EmptyState title="Нет traffic rows" />
        </section>
      ) : (
        <>
          {evidence ? <RouteExplanation evidence={evidence} all={evidences} /> : null}
          <section className="card route-table-card">
            <div className="toolbar">
              <div>
                <h2>Flow table</h2>
                <p>
                  {diagnostics
                    ? "Diagnostics mode: technical DNS and route events are visible."
                    : `${filters.trafficClass === "service_background" ? "Service/background" : filters.trafficClass === "unclassified" ? "Needs attribution" : "Client"} traffic by volume; DNS-only rows are not counted as traffic.`}
                </p>
              </div>
              <span className="subtle">{trafficPage.total} rows</span>
            </div>
            <div className="page-note">
              Detailed traffic: последний тяжелый snapshot, обновляется реже. `estimated` - оценка по counters/log summaries; `dns-interest` - DNS-запрос, не доказательство переданного трафика.
            </div>
            <div className="page-note">
              {diagnostics ? (
                <>Diagnostics visible · includes no-byte/live evidence · <Link href="/traffic">Hide diagnostics</Link></>
              ) : (
                <>Showing traffic rows only · {trafficPage.hiddenCount} system/no-byte evidence hidden · <Link href="/traffic?diagnostics=1">Show diagnostics</Link></>
              )}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th className="col-time">Time</th>
                  <th className="col-client">Client</th>
                  <th>Channel</th>
                  <th className="col-destination">Destination</th>
                  <th>Class</th>
                  <th className="col-route">Route</th>
                  <th className="col-traffic">Traffic</th>
                  <th className="col-conn">Conn</th>
                  <th className="col-confidence">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {evidences.map((row, idx) => (
                  <tr key={row.id} className={idx === selectedIndex ? "selected" : ""}>
                    <td className="col-time"><Link href={`/traffic?flow=${idx}`}>{row.eventTimeLabel}</Link></td>
                    <td><Link href={`/traffic?flow=${idx}`}>{row.client}</Link></td>
                    <td><ChannelBadge value={row.channel} /></td>
                    <td><Link href={`/traffic/${encodeURIComponent(row.id)}`}>{row.flow?.destinationLabel || row.destination}</Link></td>
                    <td>{row.flow?.trafficClassLabel || "Client"}</td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>{bytes(row.bytes)}</td>
                    <td>{row.connections}</td>
                    <td><ConfidenceBadge value={row.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              basePath="/traffic"
              page={trafficPage.page}
              pageSize={trafficPage.pageSize}
              total={trafficPage.total}
              totalPages={trafficPage.totalPages}
              extraParams={{ ...filterParams, diagnostics: diagnostics ? "1" : undefined }}
            />
          </section>
        </>
      )}
    </ConsoleShell>
  );
}
