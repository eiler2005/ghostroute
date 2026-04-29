import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, RawEvidence, StatusBadge } from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function HealthPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const checks = [
    ...(model.snapshots.health?.payload?.checks || []),
    ...(model.snapshots.leaks?.payload?.checks || []),
  ];
  const leakSnapshot = model.snapshots.leaks?.payload;
  return (
    <ConsoleShell active="/health" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        {model.statusCards.map((card) => (
          <section className="card" key={card.label}>
            <h3>{card.label}</h3>
            <StatusBadge value={card.status} />
            <p>{card.detail}</p>
          </section>
        ))}
      </div>
      <section className="card">
        <div className="toolbar">
          <h2>Health Center</h2>
          <span className="subtle">Router / VPS / Reality / DNS / leaks</span>
        </div>
        {checks.length === 0 ? (
          <EmptyState title="Нет фактических health checks" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Probe</th>
                <th>Status</th>
                <th>Message</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((row: any, idx: number) => (
                <tr key={idx}>
                  <td>{row.label || row.probe}</td>
                  <td><StatusBadge value={row.status} /></td>
                  <td>{row.message}</td>
                  <td>{typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence_json || row.evidence || {})}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>Leak-check evidence</h2>
          {!leakSnapshot ? (
            <EmptyState title="Нет leak-check snapshot" />
          ) : (
            <div className="detail-list">
              <div className="detail-row"><span>Overall</span><strong>{leakSnapshot.overall || "UNKNOWN"}</strong></div>
              <div className="detail-row"><span>Leak signals</span><strong>{(leakSnapshot.leaks || []).length}</strong></div>
              <div className="detail-row"><span>Evidence rows</span><strong>{(leakSnapshot.evidence || []).length}</strong></div>
              <div className="detail-row"><span>Confidence</span><strong>{leakSnapshot.confidence || "unknown"}</strong></div>
            </div>
          )}
          <RawEvidence value={{ checks, leakSnapshot }} />
        </section>
        <aside className="card">
          <h2>Freshness</h2>
          <div className="detail-list">
            <div className="detail-row"><span>Latest snapshot</span><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m ago`}</strong></div>
            <div className="detail-row"><span>Stale alert threshold</span><strong>30m</strong></div>
            <div className="detail-row"><span>Open signals</span><strong>{model.alerts.length}</strong></div>
          </div>
        </aside>
      </div>
    </ConsoleShell>
  );
}
