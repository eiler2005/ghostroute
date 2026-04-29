export function bytes(value: number) {
  if (!value) return "0 B";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function StatusBadge({ value }: { value?: string }) {
  const status = String(value || "UNKNOWN").toLowerCase();
  return <span className={`badge status-${status}`}>{value || "UNKNOWN"}</span>;
}

export function ConfidenceBadge({ value }: { value?: string }) {
  return <span className={`badge confidence-${value || "unknown"}`}>{value || "unknown"}</span>;
}

export function RouteBadge({ value }: { value?: string }) {
  const route = String(value || "Unknown");
  return <span className={`badge route-badge route-${route.toLowerCase()}`}>{route}</span>;
}

export function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>Запустите `./modules/ghostroute-console/bin/ghostroute-console collect-once`, чтобы собрать фактический snapshot.</span>
    </div>
  );
}

export function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="card metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

export function ProgressBar({ value, tone = "ok" }: { value: number; tone?: "ok" | "warn" | "crit" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`progress progress-${tone}`}>
      <span style={{ width: `${pct}%` }} />
      <strong>{pct}%</strong>
    </div>
  );
}

export function routeFromBytes(row: Record<string, any>) {
  const vps = Number(row.via_vps_bytes || row.reality_bytes || row.vps_connections || 0);
  const direct = Number(row.direct_bytes || row.wan_bytes || row.direct_connections || 0);
  if (vps > 0 && direct > 0) return "Mixed";
  if (vps > 0) return "VPS";
  if (direct > 0) return "Direct";
  return row.route || "Unknown";
}

export function SplitBars({ vps, direct }: { vps: number; direct: number }) {
  const total = Math.max(vps + direct, 1);
  return (
    <div className="split">
      <div className="split-line">
        <span>VPS</span>
        <div className="bar"><span style={{ width: `${Math.round((vps / total) * 100)}%` }} /></div>
        <strong>{bytes(vps)}</strong>
      </div>
      <div className="split-line">
        <span>Direct</span>
        <div className="bar"><span style={{ width: `${Math.round((direct / total) * 100)}%` }} /></div>
        <strong>{bytes(direct)}</strong>
      </div>
    </div>
  );
}

export function ConfidenceHelp() {
  return (
    <div className="confidence-help">
      <div><strong>exact</strong><span>Counter, check or explicit report evidence.</span></div>
      <div><strong>estimated</strong><span>Derived from mixed counters or log summaries.</span></div>
      <div><strong>dns-interest</strong><span>DNS observation, not proof of routed traffic.</span></div>
      <div><strong>unknown</strong><span>Source did not provide enough evidence.</span></div>
    </div>
  );
}

export function RawEvidence({ value }: { value: unknown }) {
  return (
    <details className="evidence-details">
      <summary>Show raw evidence</summary>
      <pre className="codebox">{JSON.stringify(value || {}, null, 2)}</pre>
    </details>
  );
}
