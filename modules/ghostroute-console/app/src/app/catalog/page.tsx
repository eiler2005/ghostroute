import { ConsoleShell } from "@/components/ConsoleShell";
import { ConfidenceBadge, EmptyState, RawEvidence } from "@/components/Widgets";
import { CatalogReviewPanel } from "@/components/CatalogReviewPanel";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

export default async function CatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const counts = model.catalog.reduce<Record<string, number>>((acc, row) => {
    const key = row.type || row.kind || row.status || "observed";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const preview = model.catalog.filter((row) => row.type === "candidates" || row.status === "candidate").slice(0, 8);
  return (
    <ConsoleShell active="/catalog" model={model} filters={filters}>
      <div className="grid two">
        <section className="card">
          <div className="toolbar">
            <div>
              <h2>Catalog</h2>
              <p>Read-only catalog view. Edits and deploys are outside MVP.</p>
            </div>
            <button className="muted-button disabled-action" disabled>Runtime deploy disabled</button>
          </div>
          {model.catalog.length === 0 ? (
            <EmptyState title="Нет фактического catalog snapshot" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Domain/CIDR</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Hits</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {model.catalog.slice(0, 200).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.domain || row.domain_or_cidr}</td>
                    <td>{row.source || row.kind || "n/a"}</td>
                    <td>{row.type || row.status || "observed"}</td>
                    <td>{row.hit_count || 0}</td>
                    <td><ConfidenceBadge value={row.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside className="card side-panel">
          <h2>Diff preview</h2>
          <div className="detail-list">
            {Object.entries(counts).map(([key, value]) => (
              <div className="detail-row" key={key}><span>{key}</span><strong>{value}</strong></div>
            ))}
          </div>
          <h3 style={{ marginTop: 16 }}>Candidate additions</h3>
          {preview.length === 0 ? (
            <div className="subtle">No candidate rows in latest snapshot.</div>
          ) : (
            <div className="detail-list">
              {preview.map((row, idx) => (
                <div className="detail-row" key={idx}><span>{row.domain}</span><strong>{row.hit_count || 0} hits</strong></div>
              ))}
            </div>
          )}
          <CatalogReviewPanel candidates={preview} />
          <h3 style={{ marginTop: 16 }}>Audit / reviews</h3>
          <div className="detail-list">
            {model.catalogReviews.slice(0, 8).map((row) => (
              <div className="detail-row" key={row.id}><span>{row.domain}</span><strong>{row.decision}</strong></div>
            ))}
            {model.catalogReviews.length === 0 ? <div className="subtle">No review actions yet.</div> : null}
          </div>
          <RawEvidence value={{ counts, candidates: preview, catalog: model.catalog.slice(0, 25) }} />
        </aside>
      </div>
    </ConsoleShell>
  );
}
