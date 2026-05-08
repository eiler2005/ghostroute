export function bytes(value: number) {
  if (!value) return "0 B";
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function shortDateTime(value?: string | number | Date) {
  if (!value) return "n/a";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function timeWithMillis(value?: string | number | Date, alwaysShowMillis = false) {
  if (!value) return "n/a";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const source = typeof value === "string" ? value : "";
  const hasExplicitMillis = /\.\d{1,9}(?:Z|[+-]\d\d:?\d\d)?$/.test(source);
  const millis = date.getMilliseconds();
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  const base = `${pick("hour")}:${pick("minute")}:${pick("second")}`;
  if (!alwaysShowMillis && !hasExplicitMillis && millis === 0) return base;
  return `${base}.${String(millis).padStart(3, "0")}`;
}

export function StatusBadge({ value }: { value?: string }) {
  const status = String(value || "UNKNOWN").toLowerCase();
  const slug = status.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  return <span className={`badge status-${slug}`}>{value || "UNKNOWN"}</span>;
}

export function ConfidenceBadge({ value }: { value?: string }) {
  return <span className={`badge confidence-${value || "unknown"}`}>{value || "unknown"}</span>;
}

export function RouteBadge({ value }: { value?: string }) {
  const route = String(value || "Unknown");
  return <span className={`badge route-badge route-${route.toLowerCase()}`}>{route}</span>;
}

export function ChannelBadge({ value }: { value?: string }) {
  const channel = String(value || "Unknown");
  const slug = channel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  return <span className={`badge channel-badge channel-${slug}`}>{channel}</span>;
}

export function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>Run `./modules/ghostroute-console/bin/ghostroute-console collect-once` to collect a factual snapshot.</span>
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

export function Pagination({
  basePath,
  page,
  pageParam = "page",
  pageSize,
  pageSizeParam = "pageSize",
  total,
  totalPages,
  extraParams = {},
}: {
  basePath: string;
  page: number;
  pageParam?: string;
  pageSize: number;
  pageSizeParam?: string;
  total: number;
  totalPages: number;
  extraParams?: Record<string, string | number | undefined>;
}) {
  const makeHref = (nextPage: number) => {
    const params = new URLSearchParams();
    params.set(pageParam, String(nextPage));
    params.set(pageSizeParam, String(pageSize));
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return `${basePath}?${params.toString()}`;
  };
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span>Showing {start}-{end} of {total}</span>
      <div>
        {page > 1 ? <a className="muted-button" href={makeHref(page - 1)}>Prev</a> : <span className="muted-button disabled-action">Prev</span>}
        <strong>{page} / {totalPages}</strong>
        {page < totalPages ? <a className="muted-button" href={makeHref(page + 1)}>Next</a> : <span className="muted-button disabled-action">Next</span>}
      </div>
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

export function SplitBars({ vps, direct, unknown = 0 }: { vps: number; direct: number; unknown?: number }) {
  const total = Math.max(vps + direct + unknown, 1);
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
      {unknown > 0 ? (
        <div className="split-line">
          <span>Unknown</span>
          <div className="bar"><span style={{ width: `${Math.round((unknown / total) * 100)}%` }} /></div>
          <strong>{bytes(unknown)}</strong>
        </div>
      ) : null}
    </div>
  );
}

export function ConfidenceHelp() {
  return (
    <div className="confidence-help">
      <div><strong>exact</strong><span>Counter, check or explicit report evidence.</span></div>
      <div><strong>estimated</strong><span>Derived from mixed counters or log summaries.</span></div>
      <div><strong>dns-interest</strong><span>DNS observation, not proof of routed traffic.</span></div>
      <div><strong>mixed</strong><span>Several sources disagree or the row combines VPS and Direct counters.</span></div>
      <div><strong>unknown</strong><span>Source did not provide enough evidence.</span></div>
    </div>
  );
}

export function TrafficTermsHelp() {
  return (
    <div className="terms-grid">
      <div>
        <h3>Route</h3>
        <p><strong>VPS</strong> - traffic went through `reality-out` / VPS egress.</p>
        <p><strong>Direct</strong> - traffic went through home/direct WAN.</p>
        <p><strong>Mixed</strong> - aggregate counters show both VPS and Direct.</p>
      </div>
      <div>
        <h3>Confidence</h3>
        <p><strong>exact</strong> - explicit log/report event: rule, outbound, IP or timestamp.</p>
        <p><strong>estimated</strong> - derived from counters or incomplete summaries.</p>
        <p><strong>dns-interest</strong> - DNS was observed, but route was not proven.</p>
      </div>
      <div>
        <h3>Rows</h3>
        <p><strong>Traffic row</strong> - client traffic with observed bytes/counters.</p>
        <p><strong>Evidence event</strong> - technical log event, not always traffic.</p>
        <p><strong>not observed</strong> - source did not contain that field.</p>
      </div>
      <div>
        <h3>IP / Rules</h3>
        <p><strong>egress IP</strong> - public IP that the destination site sees.</p>
        <p><strong>reality-out</strong> - sing-box outbound through the VPS Reality tunnel.</p>
        <p><strong>candidate</strong> - catalog hint, not necessarily an applied route rule.</p>
      </div>
      <div>
        <h3>Channel</h3>
        <p><strong>Home Wi-Fi/LAN</strong> - local device on router LAN.</p>
        <p><strong>Channel A/B/C</strong> - mobile/client lane used to enter GhostRoute.</p>
        <p><strong>ingress / egress</strong> - where traffic entered GhostRoute and where it exited.</p>
      </div>
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
