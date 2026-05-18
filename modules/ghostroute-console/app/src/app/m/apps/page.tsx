import { MobileShell } from "@/components/MobileShell";
import { bytes, ChannelBadge, RouteBadge } from "@/components/Widgets";
import { listAppDeviceRows, listAppFamilyRows } from "@/lib/server/selectors/apps";
import { listClientInventory, listClientSiteEvidence } from "@/lib/server/selectors/clients";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { dnsInterestTrafficClass, filterDnsInterestRows } from "@/lib/traffic-window.mjs";
import { ndpiDiagnosticForApp } from "@/lib/ndpi-diagnostics.mjs";
import { mobilePageSize, MobileSection, scalar } from "../mobile-ui";

function normalizeToken(value: unknown) {
  return String(value || "").trim().toLowerCase();
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

function appHref(row: Record<string, any>, includeServiceDns: boolean) {
  const next = new URLSearchParams();
  next.set("client", String(selectedClientValue(row)));
  if (includeServiceDns) next.set("showServiceDns", "1");
  return `/m/apps?${next.toString()}`;
}

function appDeviceLabel(row: Record<string, any>) {
  if (row.client_attributed === false || row.attribution_state === "needs_attribution") {
    const label = String(row.label || "").trim();
    if (label && label !== "Unknown LAN device") return label;
    return row.client_label || row.client_key || row.device_key || row.ip || "Unknown LAN device";
  }
  return row.device_label || row.label || row.id;
}

export default async function MobileAppsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const includeServiceDns = scalar(params.showServiceDns) === "1";
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const inventory = listClientInventory({ page: 1, pageSize: 12, filters: { ...filters, client: "all" }, showInactive: false });
  const appDeviceRows = listAppDeviceRows({ pageSize: 25, filters: { ...filters, client: "all" }, minBytes: 1024 * 1024 });
  const selectedClientParam = scalar(params.client) || "";
  const selectedLookup = selectedClientParam
    ? listClientInventory({ page: 1, pageSize: 1, filters: { ...filters, client: selectedClientParam }, showInactive: true }).rows[0]
    : undefined;
  const selected =
    selectedLookup ||
    appDeviceRows.find((row: Record<string, any>) => selectedClientParam && matchesClientFilter(row, selectedClientParam)) ||
    appDeviceRows[0] ||
    inventory.rows[0];
  const selectedClientId = selectedClientValue(selected);
  const apps = listAppFamilyRows({
    page,
    pageSize,
    filters: { ...filters, client: selectedClientId || "all" },
    clientTarget: selected,
  });
  const dnsAll = selected ? listClientSiteEvidence(selected, filters.period || "today", { limit: 120, includeService: includeServiceDns }) : [];
  const dnsFiltered = filterDnsInterestRows(dnsAll, { includeService: includeServiceDns });
  const dnsRows = (dnsFiltered.length > 0 || includeServiceDns ? dnsFiltered : dnsAll).slice(0, 12);
  const model = buildLightweightShellModel(filters, { devices: inventory.rows });
  const selectedTitle = selected?.label || selected?.client_label || selected?.id || "selected device";
  const totalBytes = apps.rows.reduce((sum: number, row: Record<string, any>) => sum + Number(row.bytes || row.total_bytes || 0), 0);
  const dnsModeParams = new URLSearchParams();
  if (selected) dnsModeParams.set("client", String(selectedClientId));
  if (!includeServiceDns) dnsModeParams.set("showServiceDns", "1");

  return (
    <MobileShell active="/m/apps" model={model} filters={filters} desktopPath={`/apps${selectedClientId ? `?client=${encodeURIComponent(String(selectedClientId))}` : ""}`}>
      <MobileSection title="Device Inventory" detail={`${appDeviceRows.length} active >= 1 MiB`}>
        <div className="mobile-list">
          {appDeviceRows.map((row: Record<string, any>) => (
            <a className="mobile-row" href={appHref(row, includeServiceDns)} key={row.id || row.label}>
              <span>
                <strong>{appDeviceLabel(row)}</strong>
                <small>{row.owner || row.client_label || row.device_type || row.role || "Inventory"}</small>
              </span>
              <span className="mobile-row-meta">
                <ChannelBadge value={row.channel} />
                <b>{bytes(row.total_bytes || 0)}</b>
              </span>
            </a>
          ))}
        </div>
      </MobileSection>

      <MobileSection title="App families" detail={selectedTitle}>
        {apps.rows.length === 0 ? (
          <div className="mobile-empty">No app-family rows for this device.</div>
        ) : (
          <div className="mobile-list">
            {apps.rows.map((row: Record<string, any>) => {
              const ndpi = ndpiDiagnosticForApp(row);
              return (
                <div className="mobile-row" key={row.app_family}>
                  <span>
                    <strong>{row.rank}. {row.app_family}</strong>
                    <small>{(row.sample_domains || []).slice(0, 2).join(", ") || row.app_category} · nDPI {ndpi.status}</small>
                  </span>
                  <span className="mobile-row-meta">
                    <RouteBadge value={row.route} />
                    <b>{bytes(row.bytes || row.total_bytes || 0)}</b>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </MobileSection>

      <MobileSection title="Latest DNS domains" detail={selectedTitle}>
        <a className={`mobile-action ${includeServiceDns ? "active" : ""}`} href={`/m/apps?${dnsModeParams.toString()}`}>
          {includeServiceDns ? "Hide service DNS" : "Include service DNS"}
        </a>
        {dnsRows.length === 0 ? (
          <div className="mobile-empty">
            {totalBytes > 0 ? "Byte counters are shown above as aggregate residual; no DNS domains were tied to this device." : "No DNS domains for this device."}
          </div>
        ) : (
          <div className="mobile-list">
            {dnsRows.map((row: Record<string, any>) => (
              <div className="mobile-row" key={row.domain}>
                <span>
                  <strong>{row.domain}</strong>
                  <small>{dnsInterestTrafficClass(row) === "service_background" ? "service/system DNS queries" : "client-facing DNS queries"}</small>
                </span>
                <span className="mobile-row-meta"><b>{row.count} queries</b></span>
              </div>
            ))}
          </div>
        )}
      </MobileSection>
    </MobileShell>
  );
}
