import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, bytes, ChannelBadge, ConfidenceBadge, RouteBadge, TrafficTermsHelp } from "@/components/Widgets";
import { RouteExplanation } from "@/components/RouteExplanation";
import { buildRouteEvidence, buildRouteEvidences } from "@/lib/server/evidence";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildConsoleModel(filters);
  const evidences = buildRouteEvidences(model);
  const selectedIndex = Math.min(
    Math.max(Number.parseInt(scalar(params.flow) || "0", 10) || 0, 0),
    Math.max(evidences.length - 1, 0)
  );
  const evidence = buildRouteEvidence(model, selectedIndex);

  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      {!evidence ? (
        <section className="card">
          <EmptyState title="Нет выбранного flow" />
        </section>
      ) : (
        <>
          <RouteExplanation evidence={evidence} all={evidences} />
          <section className="card route-table-card">
            <div className="toolbar">
              <div>
                <h2>Flow table</h2>
                <p>Best evidence first: exact live route events, then DNS observations, then aggregate counter rows.</p>
              </div>
              <span className="subtle">{evidences.length} evidence rows</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th className="col-time">Time</th>
                  <th className="col-client">Client</th>
                  <th>Channel</th>
                  <th className="col-destination">Destination</th>
                  <th className="col-route">Route</th>
                  <th className="col-traffic">Traffic</th>
                  <th className="col-conn">Conn</th>
                  <th className="col-confidence">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {evidences.slice(0, 100).map((row, idx) => (
                  <tr key={row.id} className={idx === selectedIndex ? "selected" : ""}>
                    <td className="col-time"><Link href={`/traffic?flow=${idx}`}>{row.eventTimeLabel}</Link></td>
                    <td><Link href={`/traffic?flow=${idx}`}>{row.client}</Link></td>
                    <td><ChannelBadge value={row.channel} /></td>
                    <td><Link href={`/traffic/${idx}`}>{row.destination}</Link></td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>{bytes(row.bytes)}</td>
                    <td>{row.connections}</td>
                    <td><ConfidenceBadge value={row.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card terms-card">
            <div>
              <h2>Что означают термины</h2>
              <p>Короткая легенда для route, confidence и channel labels в таблице и деталях маршрута.</p>
            </div>
            <TrafficTermsHelp />
          </section>
        </>
      )}
    </ConsoleShell>
  );
}
