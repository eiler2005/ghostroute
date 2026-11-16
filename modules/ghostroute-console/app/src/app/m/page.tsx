import { MobileShell } from "@/components/MobileShell";
import { bytes } from "@/components/Widgets";
import { buildLightweightShellModel, getConsolePageSummary } from "@/lib/server/selectors/shell";
import { channelTrafficForPeriod } from "@/lib/server/selectors/dashboard";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { MobileAlarmList, MobileClientList, MobileDnsList, MobileFlowList, MobileLiveList, MobileSection } from "./mobile-ui";

export default async function MobileHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await todayOnlyFiltersFromSearchParams(Promise.resolve(params));
  const mobileHome = getConsolePageSummary("mobile_home")?.payload || {};
  const healthSummary = getConsolePageSummary("health_mobile")?.payload || {};
  const summaryAlarms = Array.isArray(mobileHome.alarms)
    ? mobileHome.alarms
    : Array.isArray(healthSummary.alarms) ? healthSummary.alarms : [];
  const model = buildLightweightShellModel(filters, {
    alerts: summaryAlarms,
    statusCards: Array.isArray(mobileHome.statusCards)
      ? mobileHome.statusCards
      : Array.isArray(healthSummary.statusCards) ? healthSummary.statusCards : undefined,
  });
  const flows = Array.isArray(mobileHome.flows) ? mobileHome.flows : [];
  const dnsRows = Array.isArray(mobileHome.dnsRows) ? mobileHome.dnsRows : [];
  const clients = Array.isArray(mobileHome.clients) ? mobileHome.clients : [];
  const live = Array.isArray(mobileHome.live) ? mobileHome.live : [];
  const alarms = summaryAlarms.slice(0, 5);
  const channelTraffic = channelTrafficForPeriod("today");
  return (
    <MobileShell active="/m" model={model} filters={filters} desktopPath="/">
      <section className="mobile-hero">
        <h1>GhostRoute Mobile</h1>
        <p>Fast read-only snapshot for iPhone and mobile browsers.</p>
      </section>
      <MobileSection title="Traffic by channel" detail="Today · device and profile counters" href="/m/channels">
        <p>Client evidence may be incomplete or estimated and is separate from the VPS total.</p>
        {channelTraffic.length ? channelTraffic.map((row) => <div className="detail-row" key={row.channel}><span>{row.channel}</span><strong>{bytes(row.bytes)}</strong></div>) : <p>No channel traffic observed</p>}
        <a className="muted-button" href="/m/channels?period=last30&view=history">30-day history</a>
      </MobileSection>
      <section className="mobile-kpis">
        <div><span>Observed</span><strong>{bytes(model.totals.observedBytes)}</strong></div>
        <div><span>Via VPS</span><strong>{bytes(model.totals.viaVpsBytes)}</strong></div>
        <div><span>Alerts</span><strong>{model.alerts.length}</strong></div>
      </section>
      <MobileSection title="Recent flows" href="/m/traffic"><MobileFlowList rows={flows} /></MobileSection>
      <MobileSection title="DNS interest" href="/m/dns"><MobileDnsList rows={dnsRows} /></MobileSection>
      <MobileSection title="Top clients" href="/m/clients"><MobileClientList rows={clients} /></MobileSection>
      <MobileSection title="Health Center" href="/m/health"><MobileAlarmList rows={alarms} /></MobileSection>
      <MobileSection title="Live events" href="/m/live"><MobileLiveList rows={live} /></MobileSection>
    </MobileShell>
  );
}
