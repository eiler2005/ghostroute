import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, Pagination, bytes, ChannelBadge, ConfidenceBadge, RouteBadge, timeWithMillis } from "@/components/Widgets";
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
  const pageSize = Math.min(100, Math.max(25, Number.parseInt(scalar(params.pageSize) || "100", 10) || 100));
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
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };
  const flowHref = (idx: number) => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    if (diagnostics) next.set("diagnostics", "1");
    next.set("page", String(trafficPage.page));
    next.set("pageSize", String(trafficPage.pageSize));
    next.set("flow", String(idx));
    return `/traffic?${next.toString()}`;
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
          <section className="card live-stream-card route-table-card traffic-stream-card">
            <div className="live-stream-toolbar">
              <div className="live-stream-title">
                <h2>Flow Explorer</h2>
                <span>{trafficPage.total} rows · shown {rows.length}</span>
              </div>
              <div className="live-stream-actions">
                {diagnostics ? (
                  <Link className="muted-button traffic-mode-button" href="/traffic">Traffic only</Link>
                ) : (
                  <Link className="muted-button traffic-mode-button" href="/traffic?diagnostics=1">Diagnostics</Link>
                )}
              </div>
            </div>
            <div className="live-stream-meta traffic-stream-meta">
              {diagnostics
                ? "Diagnostics mode: technical DNS and route events are visible."
                : `${filters.trafficClass === "service_background" ? "Service/background" : filters.trafficClass === "unclassified" ? "Needs attribution" : filters.trafficClass === "client" ? "Client" : "All traffic"} flows by volume with policy, route and risk context.`}
            </div>
            <div className="live-stream-meta traffic-stream-meta">
              Detailed traffic: последний тяжелый snapshot, обновляется реже · estimated - counters/log summaries · hidden system/no-byte evidence: {trafficPage.hiddenCount}
            </div>
            <div className="live-table-wrap traffic-table-wrap">
              <table className="live-events-table traffic-table flow-events-table">
                <thead>
                  <tr>
                    <th className="col-time">Time</th>
                    <th className="col-client">Client</th>
                    <th className="col-destination">Destination</th>
                    <th className="col-port">Port</th>
                    <th className="col-route">Route</th>
                    <th className="col-policy">Policy / Rule</th>
                    <th className="col-traffic">Traffic</th>
                    <th className="col-duration">Duration</th>
                    <th className="col-risk">Risk</th>
                    <th className="col-confidence">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const href = flowHref(idx);
                    const destination = trafficDisplayDestination(row);
                    return (
                      <tr key={row.id} className={hasSelectedFlow && idx === selectedIndex ? "selected" : ""}>
                        <td className="col-time"><Link href={href}>{timeWithMillis(row.last_seen || row.event_ts || row.collected_at)}</Link></td>
                        <td className="col-client" title={row.client}><Link href={href}>{row.client}</Link></td>
                        <td className="col-destination" title={destination}>
                          <Link href={`/traffic/${encodeURIComponent(row.id)}`}>{destination}</Link>
                          <span className="inline-badges"><ChannelBadge value={row.channel} /></span>
                        </td>
                        <td className="col-port">{row.destination_port || "n/a"} <span>{row.protocol || "TCP"}</span></td>
                        <td className="col-route"><RouteBadge value={row.route} /></td>
                        <td className="col-policy" title={`${row.policy || row.rule_set || row.matched_rule || "DEFAULT"} ${row.matched_rule || row.outbound || ""}`}>
                          {row.policy || row.rule_set || row.matched_rule || "DEFAULT"}
                        </td>
                        <td className="col-traffic">{bytes(row.bytes || row.total_bytes || 0)} · {row.connections || 0} sessions</td>
                        <td className="col-duration">{durationLabel(row.duration_seconds)}</td>
                        <td className="col-risk">{riskBadge(row.risk)}</td>
                        <td className="col-confidence"><ConfidenceBadge value={row.confidence} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="live-card-footer">
              <Pagination
                basePath="/traffic"
                page={trafficPage.page}
                pageSize={trafficPage.pageSize}
                total={trafficPage.total}
                totalPages={trafficPage.totalPages}
                extraParams={{ ...filterParams, diagnostics: diagnostics ? "1" : undefined }}
              />
            </div>
          </section>
        </>
      )}
    </ConsoleShell>
  );
}
