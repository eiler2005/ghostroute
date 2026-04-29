import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState } from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { llmSafePayload, redactedMarkdown } from "@/lib/server/redaction";

export default async function ReportsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const snapshotCount = Object.values(model.snapshots).filter(Boolean).length;
  const payload = llmSafePayload(model);
  const preview = redactedMarkdown("GhostRoute Console LLM-safe Preview", payload);
  return (
    <ConsoleShell active="/reports" model={model} filters={filters}>
      <div className="grid two">
        <section className="card">
          <h2>Reports</h2>
          {snapshotCount === 0 ? (
            <EmptyState title="Нет snapshots для отчёта" />
          ) : (
            <div className="detail-list">
              <div className="detail-row"><span>Snapshots</span><strong>{snapshotCount}</strong></div>
              <div className="detail-row"><span>LLM-safe JSON</span><strong><Link href="/api/reports/llm-safe?format=json">Open</Link></strong></div>
              <div className="detail-row"><span>LLM-safe Markdown</span><strong><Link href="/api/reports/llm-safe?format=markdown">Open</Link></strong></div>
              <div className="detail-row"><span>Raw evidence</span><strong>Gated by explicit export only</strong></div>
              <div className="detail-row"><span>Sections</span><strong>{Object.keys(payload).join(", ")}</strong></div>
            </div>
          )}
        </section>
        <aside className="card side-panel">
          <h2>Redacted preview</h2>
          <pre className="codebox">{preview}</pre>
        </aside>
      </div>
    </ConsoleShell>
  );
}
