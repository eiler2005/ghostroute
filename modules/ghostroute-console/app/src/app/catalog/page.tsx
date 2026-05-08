import { ConsoleShell } from "@/components/ConsoleShell";
import { ConfidenceBadge, EmptyState, Pagination, RawEvidence } from "@/components/Widgets";
import { CatalogReviewPanel } from "@/components/CatalogReviewPanel";
import { buildCatalogModel } from "@/lib/server/selectors/catalog";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { boundedPageSize, isMobileRequest } from "@/lib/server/mobile";

export default async function CatalogPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const mobile = await isMobileRequest();
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildCatalogModel(filters);
  const page = Math.max(1, Number.parseInt(Array.isArray(params.page) ? params.page[0] : params.page || "1", 10) || 1);
  const pageSize = boundedPageSize(Array.isArray(params.pageSize) ? params.pageSize[0] : params.pageSize, { desktop: 100, mobile: 25, min: 25, desktopMax: 1000, mobileMax: 25 }, mobile);
  const totalPages = Math.max(1, Math.ceil(model.catalog.length / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const offset = (effectivePage - 1) * pageSize;
  const catalogRows = model.catalog.slice(offset, offset + pageSize);
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
            <EmptyState title="No factual catalog snapshot" />
          ) : (
            <>
              <table className="table catalog-table">
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
                  {catalogRows.map((row, idx) => (
                    <tr key={`${row.domain || row.domain_or_cidr || "catalog"}-${offset + idx}`}>
                      <td>{row.domain || row.domain_or_cidr}</td>
                      <td>{row.source || row.kind || "n/a"}</td>
                      <td>{row.type || row.status || "observed"}</td>
                      <td>{row.hit_count || 0}</td>
                      <td><ConfidenceBadge value={row.confidence} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination basePath="/catalog" page={effectivePage} pageSize={pageSize} total={model.catalog.length} totalPages={totalPages} />
            </>
          )}
        </section>
        {mobile ? null : <aside className="card side-panel">
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
        </aside>}
      </div>
    </ConsoleShell>
  );
}
