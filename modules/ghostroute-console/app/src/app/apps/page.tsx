import { ConsoleShell } from "@/components/ConsoleShell";
import { bytes, ChannelBadge, EmptyState, Pagination, RouteBadge, StatusBadge, timeWithMillis } from "@/components/Widgets";
import { listAppFamilyRows } from "@/lib/server/selectors/apps";
import { listClientInventory, listClientSiteEvidence } from "@/lib/server/selectors/clients";
import { buildShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { dnsInterestTrafficClass } from "@/lib/traffic-window.mjs";
import { ndpiDiagnosticForApp } from "@/lib/ndpi-diagnostics.mjs";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function compactBytes(value: number) {
  return bytes(Number(value || 0));
}

function normalizeToken(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function labelToken(value: unknown) {
  return String(value || "").replace(/[_-]+/g, " ").trim();
}

function clientTokens(client?: Record<string, any>) {
  return [
    client?.client_key,
    client?.client_label,
    client?.device_key,
    client?.device_label,
    client?.label,
    client?.id,
    client?.ip,
    client?.profile,
    client?.client,
    ...(client?.aliases || []),
    ...(client?.observed_aliases || []),
    ...(client?.observed_identities || []),
  ].filter(Boolean).map(String);
}

function selectedClientValue(client?: Record<string, any>) {
  return client?.id || client?.device_key || client?.label || client?.client_key || client?.client_label || client?.device_label || "";
}

function matchesClientFilter(client: Record<string, any>, value?: string) {
  const target = normalizeToken(value);
  return Boolean(target) && clientTokens(client).some((token) => normalizeToken(token) === target);
}

function isPrimaryAppDevice(row: Record<string, any>) {
  const state = String(row.review_state || "");
  if (state && state !== "registry_known") return false;
  if (row.client_attributed === false || row.attribution_state === "needs_attribution") return false;
  return true;
}

function appHref(row: Record<string, any>, params: Record<string, string | undefined>) {
  const next = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) next.set(key, value);
  });
  next.set("client", String(selectedClientValue(row)));
  return `/apps?${next.toString()}`;
}

function dnsModeHref(params: Record<string, string | undefined>, selected: Record<string, any> | undefined, includeService: boolean) {
  const next = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value && key !== "showServiceDns") next.set(key, value);
  });
  if (selected) next.set("client", String(selectedClientValue(selected)));
  if (includeService) next.set("showServiceDns", "1");
  return `/apps?${next.toString()}`;
}

export default async function AppsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const selectedClientParam = scalar(params.client) || "";
  const includeServiceDns = scalar(params.showServiceDns) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(scalar(params.pageSize) || "25", 10) || 25));
  const inventory = listClientInventory({ page: 1, pageSize: 25, filters: { ...filters, client: "all" }, showInactive: false });
  const appDeviceRows = inventory.rows.filter(isPrimaryAppDevice);
  const selectedLookup = selectedClientParam
    ? listClientInventory({ page: 1, pageSize: 1, filters: { ...filters, client: selectedClientParam }, showInactive: true }).rows[0]
    : undefined;
  const selected =
    selectedLookup ||
    appDeviceRows.find((row: Record<string, any>) => selectedClientParam && matchesClientFilter(row, selectedClientParam)) ||
    appDeviceRows[0] ||
    inventory.rows[0];
  const selectedClientId = selectedClientValue(selected);
  const appFilters = { ...filters, client: selectedClientId || "all" };
  const apps = listAppFamilyRows({ page, pageSize, filters: appFilters, clientTarget: selected });
  const dnsRows = selected
    ? listClientSiteEvidence(selected, filters.period || "today", { limit: 300, includeService: includeServiceDns })
      .filter((row: Record<string, any>) => Number(row.dns_queries || row.count || 0) > 0 && row.domain)
      .sort((a: Record<string, any>, b: Record<string, any>) => Date.parse(String(b.latest || "")) - Date.parse(String(a.latest || "")) || Number(b.dns_queries || 0) - Number(a.dns_queries || 0))
      .slice(0, 25)
    : [];
  const model = buildShellModel(filters, { devices: inventory.rows });
  const totalBytes = apps.rows.reduce((sum: number, row: Record<string, any>) => sum + Number(row.bytes || row.total_bytes || 0), 0);
  const dnsEmptyDetail = totalBytes > 0
    ? "Byte counters are shown above as aggregate residual; no domain/DNS attribution was tied to this device in the current window."
    : "No DNS rows were tied to this selected device in the current window.";
  const extraParams = {
    period: filters.period !== "today" ? filters.period : undefined,
    route: filters.route !== "all" ? filters.route : undefined,
    channel: filters.channel !== "all" ? filters.channel : undefined,
    trafficClass: filters.trafficClass !== "all" ? filters.trafficClass : undefined,
    client: selectedClientId || undefined,
    showServiceDns: includeServiceDns ? "1" : undefined,
  };
  const selectedTitle = selected?.label || selected?.client_label || selected?.id || "selected device";

  return (
    <ConsoleShell active="/apps" model={model} filters={filters}>
      <section className="card">
        <div className="toolbar">
          <div>
            <h2>App Families</h2>
            <p className="subtle">Device-focused application view. Byte traffic, DNS evidence, and nDPI diagnostics stay separate.</p>
          </div>
          <span className="subtle">Selected: {selectedTitle}</span>
        </div>
        <div className="clients-table-scroll">
          <table className="table clients-table">
            <thead>
              <tr>
                <th className="col-client">Device</th>
                <th>Channel</th>
                <th className="col-traffic">Window traffic</th>
                <th>Owner/Profile</th>
                <th>Type</th>
                <th>Last seen</th>
                <th>Status</th>
                <th className="col-route">Route</th>
              </tr>
            </thead>
            <tbody>
              {appDeviceRows.map((row: Record<string, any>) => {
                const isSelected = selectedClientId ? selectedClientValue(row) === selectedClientId || matchesClientFilter(row, selectedClientId) : false;
                return (
                  <tr key={row.id || row.label} className={`clickable-row ${isSelected ? "selected" : ""}`}>
                    <td><a className="row-link" href={appHref(row, extraParams)}>{row.device_label || row.label || row.id}</a></td>
                    <td><a className="row-link row-link-with-badges" href={appHref(row, extraParams)}><ChannelBadge value={row.channel} /></a></td>
                    <td><a className="row-link" href={appHref(row, extraParams)}>{bytes(row.total_bytes || 0)}</a></td>
                    <td><a className="row-link" href={appHref(row, extraParams)}>{row.owner || row.client_label || "Inventory"}</a></td>
                    <td><a className="row-link" href={appHref(row, extraParams)}>{row.device_type || row.role || "Unknown device"}</a></td>
                    <td><a className="row-link" href={appHref(row, extraParams)}>{timeWithMillis(row.display_ts_utc || row.last_seen || row.event_ts_utc || row.collected_at, true)}</a></td>
                    <td><a className="row-link row-link-with-badges" href={appHref(row, extraParams)}><StatusBadge value={row.status || "Inactive"} /></a></td>
                    <td><a className="row-link row-link-with-badges" href={appHref(row, extraParams)}><RouteBadge value={row.route} /></a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <div>
            <h2>App families for {selectedTitle}</h2>
            <p className="subtle">Byte-ranked prepared application families. DNS query counts are shown as evidence only.</p>
          </div>
          <span className="subtle">{apps.total} families · {compactBytes(totalBytes)} on this page</span>
        </div>
        <div className="status-grid" style={{ marginBottom: 14 }}>
          <div className="status-card">
            <span className="subtle">nDPI diagnostic prototype</span>
            <strong>read-only</strong>
            <p className="subtle">Shows expected nDPI protocol beside our app-family label. It does not change routing or byte accounting.</p>
          </div>
        </div>
        {apps.rows.length === 0 ? (
          <EmptyState title="No app-family rows" detail="No prepared destination rows matched the selected device and filters." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>App family</th>
                <th>Traffic</th>
                <th>Route</th>
                <th>DNS signals</th>
                <th>nDPI</th>
                <th>Samples</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {apps.rows.map((row: Record<string, any>) => {
                const ndpi = ndpiDiagnosticForApp(row);
                return (
                  <tr key={row.app_family}>
                    <td>
                      <strong>{row.rank}. {row.app_family}</strong>
                      <small className="subtle block-detail">{row.app_category || "uncategorized"}</small>
                    </td>
                    <td>{compactBytes(row.bytes || row.total_bytes || 0)}</td>
                    <td><RouteBadge value={row.route} /></td>
                    <td>
                      {row.dns_queries || 0} queries
                      <small className="subtle block-detail">{row.app_source ? labelToken(row.app_source) : "byte evidence"}</small>
                    </td>
                    <td>
                      <strong>{ndpi.protocol || ndpi.expected || "n/a"}</strong>
                      <small className="subtle block-detail">{ndpi.status} · {ndpi.detail}</small>
                    </td>
                    <td>{(row.sample_domains || []).join(", ") || "not observed"}</td>
                    <td>
                      {row.confidence || row.app_confidence || "estimated"}
                      <small className="subtle block-detail">{[row.app_confidence, row.matched_pattern].filter(Boolean).map(labelToken).join(" · ") || "byte-ranked"}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          basePath="/apps"
          page={apps.page}
          pageSize={apps.pageSize}
          total={apps.total}
          totalPages={apps.totalPages}
          extraParams={extraParams}
        />
      </section>

      <section className="card client-popular-sites-list" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <h2>Latest DNS domains for {selectedTitle}</h2>
          <div className="clients-toolbar-meta">
            <span className="subtle">{includeServiceDns ? "Client + service DNS queries" : "Client-facing DNS queries"}</span>
            <a className={`muted-button ${includeServiceDns ? "active" : ""}`} href={dnsModeHref(extraParams, selected, !includeServiceDns)}>
              {includeServiceDns ? "Hide service DNS" : "Include service DNS"}
            </a>
          </div>
        </div>
        {dnsRows.length === 0 ? (
          <EmptyState title="No DNS domains for this device" detail={dnsEmptyDetail} />
        ) : (
          <div className="detail-list">
            {dnsRows.map((row: Record<string, any>, index: number) => (
              <div className="detail-row popular-site-row" key={`${row.domain}-${index}`}>
                <span>
                  <strong>{index + 1}. {row.domain}</strong>
                  <small className="subtle block-detail">{dnsInterestTrafficClass(row) === "service_background" ? "service/system DNS evidence" : "client-facing DNS evidence"}</small>
                </span>
                <strong>{row.dns_queries || row.count || 0} queries</strong>
              </div>
            ))}
          </div>
        )}
      </section>
    </ConsoleShell>
  );
}
