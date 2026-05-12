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
  if (view === "analytics") return category.startsWith("analytics.") || category.startsWith("tracker.");
  if (view === "cdn") return category.startsWith("cdn.") || category === "unknown.shared_dns_answer";
  if (view === "unknown") return trafficClass === "unclassified" || category.startsWith("unknown.");
  if (view === "client") return trafficClass === "client";
  if (view === "service_background") return trafficClass === "service_background";
  if (view === "personal_cloud") return trafficClass === "personal_cloud";
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
    summary: { total: 0, pendingCandidates: 0, byClass: {}, byRole: {}, byAction: {} },
  };
  const allRows = intelligence.enrichments;
  const activeView = scalar(params.view) || "all";
  const rows = allRows.filter((row) => matchesView(row, activeView));
  const candidates = intelligence.candidates;
  const summary = intelligence.summary;
  const trackerCount = rows.filter((row) => String(row.category || "").startsWith("analytics.") || String(row.category || "").startsWith("tracker.")).length;
  const cdnCount = rows.filter((row) => String(row.category || "").startsWith("cdn.")).length;
  const unknownCount = countOf(summary.byClass, "unclassified");
  const serviceCount = countOf(summary.byClass, "service_background");
  const personalCount = countOf(summary.byClass, "personal_cloud");
  const clientCount = countOf(summary.byClass, "client");
  const viewTabs = [
    { value: "all", label: "All", count: allRows.length },
    { value: "client", label: "Client", count: clientCount },
    { value: "service_background", label: "Service/background", count: serviceCount },
    { value: "analytics", label: "Analytics & trackers", count: trackerCount },
    { value: "cdn", label: "CDN/shared", count: cdnCount },
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
          <small>interactive/user-facing labels</small>
        </section>
        <section className="card flow-kpi">
          <span>Service/background</span>
          <strong>{serviceCount}</strong>
          <small>system, analytics, CDN delivery</small>
        </section>
        <section className="card flow-kpi">
          <span>Personal cloud</span>
          <strong>{personalCount}</strong>
          <small>sync destinations to monitor</small>
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
