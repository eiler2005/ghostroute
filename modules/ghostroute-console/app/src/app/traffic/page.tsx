import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, Pagination, bytes, ChannelBadge, ConfidenceBadge, RouteBadge } from "@/components/Widgets";
import { RouteExplanation } from "@/components/RouteExplanation";
import { buildRouteEvidenceSet } from "@/lib/server/evidence";
import { buildPagedEvidenceContext, listFlowSessions } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { trafficDisplayDestination } from "@/lib/traffic-window.mjs";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function durationLabel(seconds?: number) {
  const value = Number(seconds || 0);
  if (!value) return "n/a";
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
  if (value >= 60) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${value}s`;
}

function riskBadge(value?: string) {
  const risk = String(value || "low");
  return <span className={`badge risk-${risk.toLowerCase()}`}>{risk}</span>;
}

export default async function TrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const diagnostics = scalar(params.diagnostics) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(scalar(params.pageSize) || "10", 10) || 10));
  const trafficPage = listFlowSessions({ page, pageSize, filters, diagnostics });
  const model = buildPagedEvidenceContext(filters, trafficPage.rows);
  const evidenceSet = buildRouteEvidenceSet(model, { includeDiagnostics: diagnostics, limit: pageSize, fallbackToDiagnostics: true });
  const evidences = evidenceSet.evidences;
  const hasSelectedFlow = scalar(params.flow) !== undefined;
  const selectedIndex = Math.min(
    Math.max(Number.parseInt(scalar(params.flow) || "0", 10) || 0, 0),
    Math.max(evidences.length - 1, 0)
  );
  const evidence = hasSelectedFlow ? evidences[selectedIndex] || null : null;
  const rows = trafficPage.rows;
  const vpsRows = rows.filter((row) => row.route === "VPS").length;
  const suspiciousRows = rows.filter((row) => row.route === "Direct" && ["medium", "high"].includes(String(row.risk || ""))).length;
  const unknownRows = rows.filter((row) => !row.destination || row.destination === "unknown destination" || row.route === "Unknown").length;
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
      <div className="grid cards" style={{ marginBottom: 14 }}>
        <section className="card metric"><span>Active/completed flows</span><strong>{trafficPage.total}</strong><small>read-model rows for selected window</small></section>
        <section className="card metric"><span>Via VPS</span><strong>{vpsRows}</strong><small>matched stealth/VPS route rows</small></section>
        <section className="card metric"><span>Suspicious direct</span><strong>{suspiciousRows}</strong><small>direct rows with elevated risk</small></section>
        <section className="card metric"><span>Unknown destinations</span><strong>{unknownRows}</strong><small>needs attribution or DNS link</small></section>
      </div>
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
                <h2>Flow Explorer</h2>
                <p>
                  {diagnostics
                    ? "Diagnostics mode: technical DNS and route events are visible."
                    : `${filters.trafficClass === "service_background" ? "Service/background" : filters.trafficClass === "unclassified" ? "Needs attribution" : "Client"} flows by volume with policy, route and risk context.`}
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
            <table className="table traffic-table">
              <thead>
                <tr>
                  <th className="col-time">Time</th>
                  <th className="col-client">Client</th>
                  <th className="col-destination">Destination</th>
                  <th>Port</th>
                  <th className="col-route">Route</th>
                  <th>Policy / Rule</th>
                  <th className="col-traffic">Traffic</th>
                  <th>Duration</th>
                  <th>Risk</th>
                  <th className="col-confidence">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={row.id} className={idx === selectedIndex ? "selected" : ""}>
                    <td className="col-time"><Link href={`/traffic?flow=${idx}`}>{row.last_seen || row.event_ts || row.collected_at ? new Date(row.last_seen || row.event_ts || row.collected_at).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }) : "n/a"}</Link></td>
                    <td><Link href={`/traffic?flow=${idx}`}>{row.client}</Link></td>
                    <td>
                      <Link href={`/traffic/${encodeURIComponent(row.id)}`}>{trafficDisplayDestination(row)}</Link>
                      <span className="inline-badges"><ChannelBadge value={row.channel} /></span>
                    </td>
                    <td>{row.destination_port || "n/a"}<small className="subtle block-detail">{row.protocol || "TCP"}</small></td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>{row.policy || row.rule_set || row.matched_rule || "DEFAULT"}<small className="subtle block-detail">{row.matched_rule || row.outbound || "no matching rule evidence"}</small></td>
                    <td>{bytes(row.bytes || row.total_bytes || 0)}<small className="subtle block-detail">{row.connections || 0} sessions</small></td>
                    <td>{durationLabel(row.duration_seconds)}</td>
                    <td>{riskBadge(row.risk)}</td>
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
