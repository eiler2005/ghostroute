import { ConsoleShell } from "@/components/ConsoleShell";
import { ConfidenceBadge, EmptyState, RawEvidence, shortDateTime, StatusBadge } from "@/components/Widgets";
import { buildIntelligenceModel } from "@/lib/server/selectors/intelligence";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { trafficClassLabel } from "@/lib/traffic-classification.mjs";

function countOf(counts: Record<string, number>, key: string) {
  return Number(counts[key] || 0);
}

function title(value?: string) {
  return String(value || "unknown").replace(/_/g, " ");
}

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function matchesView(row: Record<string, any>, view: string) {
  const category = String(row.category || "");
  const trafficClass = String(row.traffic_class || "");
  const lane = String(row.traffic_lane || "");
  const action = String(row.decision_hint || row.action_hint || "");
  if (view === "review") return ["block_candidate", "ask_user", "route_vps_candidate", "direct_candidate", "investigate"].includes(action) || lane === "unknown_review";
  if (view === "destinations") return true;
  if (view === "rules") return ["block_candidate", "ask_user", "route_vps_candidate", "direct_candidate", "investigate"].includes(action);
  if (view === "analytics") return lane === "privacy_risk" || category.startsWith("analytics.") || category.startsWith("tracker.");
  if (view === "cdn") return lane === "shared_infra" || category.startsWith("cdn.") || category === "unknown.shared_dns_answer";
  if (view === "unknown") return lane === "unknown_review" || trafficClass === "unclassified" || category.startsWith("unknown.");
  if (view === "client") return lane === "client_observed" || trafficClass === "client";
  if (view === "service_background") return lane === "service_system" || trafficClass === "service_background";
  return true;
}

function actionTone(value?: string) {
  const action = String(value || "monitor");
  if (action === "block_candidate") return "danger";
  if (action === "ask_user") return "review";
  if (action.includes("route")) return "warning";
  if (action === "allow") return "ok";
  return "monitor";
}

function ActionBadge({ value }: { value?: string }) {
  return <span className={`badge action-${actionTone(value)}`}>{title(value)}</span>;
}

export default async function IntelligencePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildIntelligenceModel(filters);
  const intelligence = model.trafficIntelligence || {
    enrichments: [],
    candidates: [],
    summary: { total: 0, pendingCandidates: 0, byClass: {}, byLane: {}, byDnsCategory: {}, byRole: {}, byAction: {} },
  };
  const allRows = intelligence.enrichments;
  const activeView = scalar(params.view) || "all";
  const rows = allRows.filter((row) => matchesView(row, activeView));
  const candidates = intelligence.candidates;
  const summary = intelligence.summary;
  const trackerCount = countOf(summary.byLane || {}, "privacy_risk");
  const cdnCount = countOf(summary.byLane || {}, "shared_infra");
  const unknownCount = countOf(summary.byLane || {}, "unknown_review");
  const serviceCount = countOf(summary.byLane || {}, "service_system");
  const clientCount = countOf(summary.byLane || {}, "client_observed");
  const actionableCount = allRows.filter((row) => matchesView(row, "review")).length;
  const viewTabs = [
    { value: "all", label: "Overview", count: allRows.length },
    { value: "review", label: "Review Queue", count: actionableCount },
    { value: "destinations", label: "Destinations", count: allRows.length },
    { value: "rules", label: "Rules Preview", count: candidates.length },
    { value: "unknown", label: "Unknown / needs review", count: unknownCount },
  ];
  const viewHref = (view: string) => {
    const next = new URLSearchParams();
    Object.entries({
      period: filters.period,
      route: filters.route !== "all" ? filters.route : undefined,
      channel: filters.channel !== "all" ? filters.channel : undefined,
      confidence: filters.confidence !== "all" ? filters.confidence : undefined,
      trafficClass: "all",
      search: filters.search,
      view: view !== "all" ? view : undefined,
    }).forEach(([key, value]) => {
      if (value) next.set(key, String(value));
    });
    return `/intelligence?${next.toString()}`;
  };

  return (
    <ConsoleShell active="/intelligence" model={model} filters={filters}>
      <div className="traffic-workbench-heading">
        <div>
          <h2>Traffic Intelligence</h2>
          <p>Local read-only labels and review candidates derived from traffic facts, DNS links, and deterministic rules.</p>
        </div>
        <div className="traffic-workbench-actions">
          <a className="muted-button" href="/intelligence">Reset filters</a>
          <a className="muted-button" href="/traffic">Open flows</a>
        </div>
      </div>

      <div className="flow-kpi-grid intelligence-kpis">
        <section className="card flow-kpi">
          <span>Client traffic</span>
          <strong>{clientCount}</strong>
          <small>client-observed labels</small>
        </section>
        <section className="card flow-kpi">
          <span>Service/background</span>
          <strong>{serviceCount}</strong>
          <small>system, analytics, CDN delivery</small>
        </section>
        <section className="card flow-kpi">
          <span>Analytics/trackers</span>
          <strong>{trackerCount}</strong>
          <small>privacy-risk labels</small>
        </section>
        <section className="card flow-kpi">
          <span>CDN/shared</span>
          <strong>{cdnCount}</strong>
          <small>monitor or ask user</small>
        </section>
        <section className="card flow-kpi flow-kpi-warn">
          <span>Needs review</span>
          <strong>{unknownCount}</strong>
          <small>{summary.pendingCandidates} pending advisory candidates</small>
        </section>
      </div>

      <div className="grid two intelligence-layout">
        <section className="card route-table-card intelligence-table-card">
          <div className="toolbar">
            <div>
              <h2>Destination intelligence</h2>
              <p>{rows.length} rows · {trafficClassLabel(filters.trafficClass || "all")}</p>
            </div>
            <div className="inline-badges">
              <span className="badge">analytics/trackers {trackerCount}</span>
              <span className="badge">CDN {cdnCount}</span>
              <span className="badge">unknown {unknownCount}</span>
            </div>
          </div>
          <nav className="intelligence-tabs" aria-label="Traffic intelligence views">
            {viewTabs.map(({ value, label, count }) => (
              <a className={`muted-button ${activeView === value ? "active" : ""}`} href={viewHref(value)} key={value}>
                {label} <span>{count}</span>
              </a>
            ))}
          </nav>
          {rows.length === 0 ? (
            <EmptyState title="No intelligence rows" detail="Run collection/normalization or relax the current filters." />
          ) : (
            <div className="live-table-wrap intelligence-table-wrap">
              <table className="table intelligence-table">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Class</th>
                    <th>Lane / DNS</th>
                    <th>Category</th>
                    <th>Role / purpose</th>
                    <th>Decision hint</th>
                    <th>Confidence</th>
                    <th>Explanation</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.destination_key}>
                      <td>
                        <strong>{row.value || row.normalized_value || row.destination_key}</strong>
                        <small>{row.provider || row.kind || "local rules"}</small>
                      </td>
                      <td><span className="badge">{trafficClassLabel(row.traffic_class)}</span></td>
                      <td>
                        <strong>{title(row.traffic_lane)}</strong>
                        <small>{title(row.dns_category)}</small>
                      </td>
                      <td>{row.category || "unknown.domain"}</td>
                      <td>
                        <strong>{title(row.traffic_role)}</strong>
                        <small>{title(row.traffic_purpose)}</small>
                      </td>
                      <td><ActionBadge value={row.decision_hint || row.action_hint} /></td>
                      <td><ConfidenceBadge value={row.confidence} /></td>
                      <td>{row.human_explanation || "No local rule explanation."}</td>
                      <td>{shortDateTime(row.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card side-panel intelligence-panel">
          <h2>Advisory candidates</h2>
          <p>Dry-run only. These rows do not mutate filters, routes, blocking, or router/VPS state.</p>
          <div className="detail-list">
            {candidates.slice(0, 12).map((row) => (
              <div className="detail-row intelligence-candidate" key={row.candidate_id}>
                <span>
                  <strong>{row.destination_key || "destination"}</strong>
                  <small>{row.explanation || row.reason_code || "local rules"}</small>
                </span>
                <span>
                  <ActionBadge value={row.proposed_action} />
                  <StatusBadge value={row.status || "pending"} />
                </span>
              </div>
            ))}
            {candidates.length === 0 ? <div className="subtle">No advisory candidates in the current read model.</div> : null}
          </div>
          <h3>Split</h3>
          <div className="detail-list">
            {Object.entries(summary.byClass).map(([key, value]) => (
              <div className="detail-row" key={key}><span>{trafficClassLabel(key)}</span><strong>{value}</strong></div>
            ))}
          </div>
          <h3>Actions</h3>
          <div className="detail-list">
            {Object.entries(summary.byAction).map(([key, value]) => (
              <div className="detail-row" key={key}><span>{title(key)}</span><strong>{value}</strong></div>
            ))}
          </div>
          <RawEvidence value={{ summary, candidates: candidates.slice(0, 12) }} />
        </aside>
      </div>
    </ConsoleShell>
  );
}
