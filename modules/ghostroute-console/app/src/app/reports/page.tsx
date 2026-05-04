import Link from "next/link";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EmptyState, StatusBadge } from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { llmSafePayload } from "@/lib/server/redaction";

export default async function ReportsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildConsoleModel(filters);
  const snapshotCount = Object.values(model.snapshots).filter(Boolean).length;
  const payload = llmSafePayload(model);
  const sections = Object.keys(payload);
  const sampleFlow = model.flows[0] || {};
  const redactedFlow = payload.flows?.[0] || {};
  return (
    <ConsoleShell active="/reports" model={model} filters={filters}>
      <section className="card">
        <div className="toolbar">
          <div>
            <h2>Privacy / Redaction Mode</h2>
            <p>Безопасный экспорт для ревью: реальные имена, адреса и сырые идентификаторы уходят через sanitizer.</p>
          </div>
          <StatusBadge value="OK" />
        </div>
        {snapshotCount === 0 ? (
          <EmptyState title="Нет snapshots для отчёта" />
        ) : (
          <div className="redaction-grid">
            <section>
              <h3>Real view</h3>
              <div className="detail-list">
                <div className="detail-row"><span>Client</span><strong>{sampleFlow.client || "Device"}</strong></div>
                <div className="detail-row"><span>Domain</span><strong>{sampleFlow.destination || "example.invalid"}</strong></div>
                <div className="detail-row"><span>IP</span><strong>{sampleFlow.client_ip || "192.0.2.x"}</strong></div>
                <div className="detail-row"><span>Rule</span><strong>{sampleFlow.policy || sampleFlow.matched_rule || "STEALTH_DOMAINS"}</strong></div>
              </div>
            </section>
            <section>
              <h3>Redacted view</h3>
              <div className="detail-list">
                <div className="detail-row"><span>Client</span><strong>{redactedFlow.client || "Device A"}</strong></div>
                <div className="detail-row"><span>Domain</span><strong>{redactedFlow.destination || "managed-service.example"}</strong></div>
                <div className="detail-row"><span>IP</span><strong>{redactedFlow.client_ip || "192.0.2.x"}</strong></div>
                <div className="detail-row"><span>Rule</span><strong>{redactedFlow.matched_rule || "policy-redacted"}</strong></div>
              </div>
            </section>
          </div>
        )}
      </section>
      <div className="grid three" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>LLM-safe snapshot</h2>
          <div className="detail-list">
            <div className="detail-row"><span>Snapshots</span><strong>{snapshotCount}</strong></div>
            <div className="detail-row"><span>Sections</span><strong>{sections.join(", ")}</strong></div>
            <div className="detail-row"><span>Raw evidence</span><strong>export gated</strong></div>
          </div>
        </section>
        <section className="card">
          <h2>What is hidden</h2>
          <div className="detail-list">
            <div className="detail-row"><span>Device names</span><strong>pseudonyms</strong></div>
            <div className="detail-row"><span>IP addresses</span><strong>masked</strong></div>
            <div className="detail-row"><span>Secrets / URIs</span><strong>removed</strong></div>
          </div>
        </section>
        <section className="card">
          <h2>Exports</h2>
          <div className="operator-actions">
            <Link className="muted-button" href="/api/reports/llm-safe?format=json">JSON</Link>
            <Link className="muted-button" href="/api/reports/llm-safe?format=markdown">Markdown</Link>
          </div>
        </section>
      </div>
    </ConsoleShell>
  );
}
