import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, Pagination, bytes, ChannelBadge, ConfidenceBadge, RouteBadge, timeWithMillis } from "@/components/Widgets";
import { FlowDetailPanel } from "@/components/RouteExplanation";
import { buildRouteEvidenceForRow, buildRouteEvidenceSet } from "@/lib/server/evidence";
import { buildPagedEvidenceContext, listFlowSessions } from "@/lib/server/selectors/traffic";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { boundedPageSize, isMobileRequest } from "@/lib/server/mobile";
import { destinationEvidence, trafficDisplayDestination } from "@/lib/traffic-window.mjs";
import { trafficClassLabel } from "@/lib/traffic-classification.mjs";

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

function routeStatus(row: Record<string, any>) {
  const status = String(row.route_status || "").toLowerCase();
  if (status) return status;
  const verification = String(row.route_verification || "").toLowerCase();
  if (verification === "verified_vps" || verification === "verified_direct") return "verified";
  if (verification === "intent_only" || verification === "mismatch") return verification;
  return "unknown";
}

function dnsStatus(row: Record<string, any>) {
  const status = String(row.dns_status || "").toLowerCase();
  if (status) return status;
  const confidence = String(row.dns_link_confidence || "").toLowerCase();
  if (confidence === "no_dns_match") return "no_match";
  if (confidence === "low") return "shared";
  return confidence ? "exact" : "no_match";
}

function EvidenceBadge({ label, value }: { label: string; value?: string }) {
  const normalized = String(value || "unknown").replace(/_/g, " ");
  return <span className="badge evidence-status">{label} · {normalized}</span>;
}

function rowBytes(row: Record<string, any>) {
  return Number(row.bytes || row.total_bytes || 0);
}

function compactNumber(value: number) {
  if (value >= 1000) return value.toLocaleString("en-US");
  return String(value);
}

function Sparkline({ values, tone = "ok" }: { values: number[]; tone?: "ok" | "warn" | "danger" }) {
  const clean = values.length ? values : [0];
  const max = Math.max(...clean, 1);
  const points = clean.map((value, index) => {
    const x = clean.length === 1 ? 100 : (index / (clean.length - 1)) * 100;
    const y = 40 - (Math.max(0, value) / max) * 34;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg className={`flow-sparkline flow-sparkline-${tone}`} viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function Donut({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <svg className="flow-donut" viewBox="0 0 42 42" aria-hidden="true">
      <circle cx="21" cy="21" r="15.5" pathLength="100" />
      <circle cx="21" cy="21" r="15.5" pathLength="100" strokeDasharray={`${pct} ${100 - pct}`} />
      <text x="21" y="22">{pct}%</text>
    </svg>
  );
}

export default async function TrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const mobile = await isMobileRequest();
  const filters = await todayOnlyFiltersFromSearchParams(Promise.resolve(params));
  const diagnostics = scalar(params.diagnostics) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = boundedPageSize(scalar(params.pageSize), { desktop: 50, mobile: 25, min: 25, desktopMax: 100, mobileMax: 25 }, mobile);
  const trafficPage = listFlowSessions({ page, pageSize, filters, diagnostics });
  const model = buildPagedEvidenceContext(filters, trafficPage.rows);
  const evidenceSet = buildRouteEvidenceSet(model, { includeDiagnostics: diagnostics, limit: pageSize, fallbackToDiagnostics: true });
  const evidences = evidenceSet.evidences;
  const rows = trafficPage.rows;
  const selectedFlowId = scalar(params.flow) || rows[0]?.id || "";
  const selectedRow = rows.find((row) => row.id === selectedFlowId) || rows[0] || null;
  const selectedRowIndex = selectedRow ? rows.indexOf(selectedRow) : 0;
  const selectedRowEvidence = selectedRow ? buildRouteEvidenceForRow(model, selectedRow, selectedRowIndex) : null;
  const evidence = evidences.find((item) => item.id === selectedFlowId) || selectedRowEvidence || evidences[0] || null;
  const selectedId = selectedRow?.id || evidence?.id || selectedFlowId;
  const vpsRows = rows.filter((row) => row.route === "VPS");
  const suspiciousRows = rows.filter((row) => row.route === "Direct" && ["medium", "high"].includes(String(row.risk || ""))).length;
  const unknownRows = rows.filter((row) => !row.destination || row.destination === "unknown destination" || row.route === "Unknown" || row.accounting_bucket).length;
  const totalBytes = rows.reduce((sum, row) => sum + rowBytes(row), 0);
  const vpsBytes = vpsRows.reduce((sum, row) => sum + rowBytes(row), 0);
  const vpsShare = totalBytes ? (vpsBytes / totalBytes) * 100 : 0;
  const topVps = [...vpsRows].sort((a, b) => rowBytes(b) - rowBytes(a)).slice(0, 3);
  const spark = rows.slice(0, 18).map(rowBytes).reverse();
  const filterParams = {
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    confidence: filters.confidence !== "all" ? filters.confidence : undefined,
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    client: filters.client !== "all" ? filters.client : undefined,
    search: filters.search,
  };
  const flowHref = (id: string) => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    if (diagnostics) next.set("diagnostics", "1");
    next.set("page", String(trafficPage.page));
    next.set("pageSize", String(trafficPage.pageSize));
    next.set("flow", id);
    return `/traffic?${next.toString()}`;
  };
  const modeHref = () => {
    const next = new URLSearchParams();
    Object.entries(filterParams).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    next.set("page", String(trafficPage.page));
    next.set("pageSize", String(trafficPage.pageSize));
    if (!diagnostics) next.set("diagnostics", "1");
    return `/traffic?${next.toString()}`;
  };

  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      <div className="traffic-workbench-heading">
        <div>
          <h2>Flow Explorer</h2>
          <p>Read-only analysis of prepared flows and routing decisions for the selected snapshot/read-model window.</p>
        </div>
        <div className="traffic-workbench-actions">
          <Link className="muted-button" href="/traffic">Reset filters</Link>
          <Link className="muted-button" href={modeHref()}>{diagnostics ? "Traffic only" : "Diagnostics"}</Link>
        </div>
      </div>

      <div className="flow-kpi-grid">
        <section className="card flow-kpi">
          <span>Active flows</span>
          <strong>{compactNumber(trafficPage.total)}</strong>
          <small>{diagnostics ? "traffic + diagnostic evidence rows" : "traffic rows in selected window"}</small>
          <Sparkline values={spark} />
        </section>
        <section className="card flow-kpi flow-kpi-wide">
          <div>
            <span>Top routed via VPS</span>
            <strong>{bytes(vpsBytes)}</strong>
            <small>{vpsRows.length} rows on current page</small>
          </div>
          <div className="flow-vps-breakdown">
            <Donut value={vpsShare} />
            <div>
              {topVps.length ? topVps.map((row) => (
                <small key={row.id} title={trafficDisplayDestination(row)}>
                  <span>{trafficDisplayDestination(row)}</span>
                  <b>{Math.round((rowBytes(row) / Math.max(vpsBytes, 1)) * 100)}%</b>
                </small>
              )) : <small>No VPS rows on this page</small>}
            </div>
          </div>
        </section>
        <section className="card flow-kpi flow-kpi-danger">
          <span>Suspicious direct flows</span>
          <strong>{suspiciousRows}</strong>
          <small>direct rows with elevated risk</small>
          <Sparkline values={rows.map((row) => row.route === "Direct" && ["medium", "high"].includes(String(row.risk || "")) ? rowBytes(row) : 0)} tone="danger" />
        </section>
        <section className="card flow-kpi flow-kpi-warn">
          <span>Unknown destinations</span>
          <strong>{unknownRows}</strong>
          <small>needs attribution or DNS link</small>
          <Sparkline values={rows.map((row) => (!row.destination || row.destination === "unknown destination" || row.route === "Unknown" || row.accounting_bucket) ? rowBytes(row) : 0)} tone="warn" />
        </section>
      </div>

      {rows.length === 0 ? (
        <section className="card">
          <EmptyState title="No traffic rows" detail="No today's traffic rows match the current filters." />
        </section>
      ) : (
        <div className="traffic-workbench">
          <section className="card live-stream-card route-table-card traffic-stream-card">
            <div className="live-stream-toolbar">
              <div className="live-stream-title">
                <h2>Flow Explorer</h2>
                <span>{trafficPage.total} rows · shown {rows.length}</span>
              </div>
              <div className="live-stream-actions">
                <div className="dense-top-pager">
                  <Pagination
                    basePath="/traffic"
                    page={trafficPage.page}
                    pageSize={trafficPage.pageSize}
                    total={trafficPage.total}
                    totalPages={trafficPage.totalPages}
                    extraParams={{ ...filterParams, diagnostics: diagnostics ? "1" : undefined, flow: selectedId || undefined }}
                  />
                </div>
              </div>
            </div>
            <div className="live-stream-meta traffic-stream-meta">
              {diagnostics
                ? "Diagnostics mode: technical DNS and route events are visible."
                : `${trafficClassLabel(filters.trafficClass || "all")} flows by volume with policy, route and risk context.`}
            </div>
            <div className="live-stream-meta traffic-stream-meta">
              Detailed traffic: latest full snapshot, refreshed less often · estimated - counters/log summaries · hidden system/no-byte evidence: {trafficPage.hiddenCount}
            </div>
            <div className="live-table-wrap traffic-table-wrap">
              <table className="live-events-table traffic-table flow-events-table">
                <thead>
                  <tr>
                    <th className="col-time">Time</th>
                    <th className="col-client">Client</th>
                    <th className="col-channel">Channel</th>
                    <th className="col-destination">Site / group</th>
                    <th className="col-route">Route</th>
                    <th className="col-evidence">Evidence</th>
                    <th className="col-policy">Policy / Rule</th>
                    <th className="col-traffic">Traffic</th>
                    <th className="col-duration">Duration</th>
                    <th className="col-risk">Risk</th>
                    <th className="col-confidence">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const href = flowHref(row.id);
                    const destination = destinationEvidence(row);
                    return (
                      <tr key={row.id} className={`clickable-row ${row.id === selectedId ? "selected" : ""}`}>
                        <td className="col-time"><Link className="row-link" href={href}>{timeWithMillis(row.display_ts_utc || row.last_seen || row.event_ts_utc || row.event_ts || row.collected_at, true)}</Link></td>
                        <td className="col-client" title={row.client}><Link className="row-link" href={href}>{row.client}</Link></td>
                        <td className="col-channel"><Link className="row-link row-link-with-badges" href={href}><ChannelBadge value={row.channel} /></Link></td>
                        <td className="col-destination" title={`${destination.label} · ${destination.kind}`}>
                          <Link className="row-link row-link-with-badges destination-cell" href={href}>
                            <span>{destination.label}</span>
                            <span className={`badge evidence-kind evidence-${String(destination.kind).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{destination.kind}</span>
                          </Link>
                        </td>
                        <td className="col-route"><Link className="row-link row-link-with-badges" href={href}><RouteBadge value={row.route} /></Link></td>
                        <td className="col-evidence">
                          <Link className="row-link row-link-with-badges" href={href}>
                            <EvidenceBadge label={row.intended_route || row.route || "Unknown"} value={routeStatus(row)} />
                            <EvidenceBadge label="DNS" value={dnsStatus(row)} />
                          </Link>
                        </td>
                        <td className="col-policy" title={`${row.policy || row.rule_set || row.matched_rule || "DEFAULT"} ${row.matched_rule || row.outbound || ""}`}>
                          <Link className="row-link" href={href}>{row.policy || row.rule_set || row.matched_rule || "DEFAULT"}</Link>
                        </td>
                        <td className="col-traffic"><Link className="row-link" href={href}>{bytes(row.bytes || row.total_bytes || 0)} · {row.connections || 0} sessions</Link></td>
                        <td className="col-duration"><Link className="row-link" href={href}>{durationLabel(row.duration_seconds)}</Link></td>
                        <td className="col-risk"><Link className="row-link row-link-with-badges" href={href}>{riskBadge(row.risk)}</Link></td>
                        <td className="col-confidence"><Link className="row-link row-link-with-badges" href={href}><ConfidenceBadge value={row.confidence} /></Link></td>
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
                extraParams={{ ...filterParams, diagnostics: diagnostics ? "1" : undefined, flow: selectedId || undefined }}
              />
            </div>
          </section>
          {mobile ? null : <FlowDetailPanel evidence={evidence} />}
        </div>
      )}
    </ConsoleShell>
  );
}
