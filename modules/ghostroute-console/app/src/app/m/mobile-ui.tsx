import { bytes, ChannelBadge, ConfidenceBadge, Pagination, RouteBadge, shortDateTime, timeWithMillis } from "@/components/Widgets";
import { trafficDisplayDestination } from "@/lib/traffic-window.mjs";

export const MOBILE_PAGE_SIZE = 10;
export const MOBILE_MAX_PAGE_SIZE = 25;

export function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function mobilePageSize(value?: string) {
  const parsed = Number.parseInt(value || String(MOBILE_PAGE_SIZE), 10) || MOBILE_PAGE_SIZE;
  return Math.min(MOBILE_MAX_PAGE_SIZE, Math.max(1, parsed));
}

export function routeFilterForm({
  action,
  route,
  trafficClass,
  search,
}: {
  action: string;
  route?: string;
  trafficClass?: string;
  search?: string;
}) {
  return (
    <form className="mobile-filter mobile-filter-grid" action={action}>
      <input name="search" defaultValue={search || ""} placeholder="Search" />
      <select name="route" defaultValue={route || "all"}>
        <option value="all">All routes</option>
        <option value="VPS">VPS</option>
        <option value="Direct">Direct</option>
        <option value="Mixed">Mixed</option>
        <option value="Unknown">Unknown</option>
      </select>
      {trafficClass !== undefined ? (
        <select name="trafficClass" defaultValue={trafficClass || "all"}>
          <option value="all">All traffic</option>
          <option value="client">Client</option>
          <option value="personal_cloud">Personal cloud</option>
          <option value="service_background">Service</option>
          <option value="unclassified">Needs attribution</option>
        </select>
      ) : null}
      <button type="submit">Apply</button>
    </form>
  );
}

export function MobileSection({
  title,
  detail,
  href,
  children,
}: {
  title: string;
  detail?: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mobile-card">
      <div className="mobile-card-title">
        <div>
          <h2>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
        {href ? <a href={href}>Open</a> : null}
      </div>
      {children}
    </section>
  );
}

export function MobileFlowList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No flow rows.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <a className="mobile-row" href={`/traffic/${encodeURIComponent(row.id)}`} key={row.id}>
          <span>
            <strong>{trafficDisplayDestination(row)}</strong>
            <small>{row.client || "Unknown client"} · {timeWithMillis(row.display_ts_utc || row.last_seen || row.event_ts_utc || row.event_ts || row.collected_at, true)}</small>
          </span>
          <span className="mobile-row-meta">
            <RouteBadge value={row.route} />
            <b>{bytes(row.bytes || row.total_bytes || 0)}</b>
          </span>
        </a>
      ))}
    </div>
  );
}

export function MobileDnsList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No DNS rows.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <a className="mobile-row" href={`/m/traffic?search=${encodeURIComponent(row.domain || row.dns_qname || "")}`} key={row.id}>
          <span>
            <strong>{row.domain || row.dns_qname || "n/a"}</strong>
            <small>{row.device_label || row.client_label || row.client || "Unknown"} · {timeWithMillis(row.display_ts_utc || row.event_ts_utc || row.event_ts || row.collected_at, true)}</small>
          </span>
          <span className="mobile-row-meta">
            <RouteBadge value={row.route} />
            <b>{row.answer_ip || row.dns_answer_ip || row.qtype || "n/a"}</b>
          </span>
        </a>
      ))}
    </div>
  );
}

export function MobileClientList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No client rows.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <a className="mobile-row" href={`/m/clients?client=${encodeURIComponent(row.id || row.label || "")}`} key={row.id || row.label}>
          <span>
            <strong>{row.device_label || row.label || row.id}</strong>
            <small>{row.owner || row.client_label || row.device_type || row.role || "Inventory"} · {shortDateTime(row.last_seen || row.collected_at)}</small>
          </span>
          <span className="mobile-row-meta">
            <ChannelBadge value={row.channel} />
            <b>{bytes(row.total_bytes || 0)}</b>
          </span>
        </a>
      ))}
    </div>
  );
}

export function MobileLiveList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No live events.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <div className="mobile-row" key={row.id}>
          <span>
            <strong>{row.event_type || "event"}</strong>
            <small>{row.client || row.origin || "System"} · {timeWithMillis(row.occurred_at)}</small>
          </span>
          <span className="mobile-row-meta">
            <RouteBadge value={row.route} />
            <b>{row.destinationLabel || row.destination || row.summary || "n/a"}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

export function MobileCatalogList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No catalog rows.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row, idx) => (
        <div className="mobile-row" key={`${row.domain || row.domain_or_cidr || "catalog"}-${idx}`}>
          <span>
            <strong>{row.domain || row.domain_or_cidr}</strong>
            <small>{row.source || row.kind || "catalog"}</small>
          </span>
          <span className="mobile-row-meta">
            <ConfidenceBadge value={row.confidence || row.status || row.type || "observed"} />
            <b>{row.hit_count || 0} hits</b>
          </span>
        </div>
      ))}
    </div>
  );
}

export function MobileHealthStatusList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No health checks.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <div className="mobile-row" key={row.label || row.title}>
          <span>
            <strong>{row.label || row.title}</strong>
            <small>{row.detail || row.source || "health check"}</small>
          </span>
          <span className="mobile-row-meta">
            <ConfidenceBadge value={row.status || "unknown"} />
            <b>{row.status || "unknown"}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

export function MobileAlarmList({ rows }: { rows: Array<Record<string, any>> }) {
  if (rows.length === 0) return <div className="mobile-empty">No alarm rows.</div>;
  return (
    <div className="mobile-list">
      {rows.map((row) => (
        <div className="mobile-row" key={row.id || `${row.source}-${row.title}`}>
          <span>
            <strong>{row.title || "alarm"}</strong>
            <small>{row.source || "console"} · {shortDateTime(row.created_at || row.collected_at)}</small>
          </span>
          <span className="mobile-row-meta">
            <ConfidenceBadge value={row.severity || "info"} />
            <b>{row.status || "open"}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

export { Pagination };
