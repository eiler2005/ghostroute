import { ChannelOverview } from "@/components/ChannelOverview";
import { MobileShell } from "@/components/MobileShell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { buildLightweightShellModel, channelAppsForPeriod, channelClientsForPeriod, channelTrafficForPeriod, getChannelHealthRows, recentChannelTraffic } from "@/lib/server/selectors";

export default async function MobileChannelsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const sort = typeof params.sort === "string" ? params.sort : "traffic";
  const period = ["today", "week", "month"].includes(filters.period || "") ? filters.period! : "today";
  const traffic = channelTrafficForPeriod(period);
  const health = getChannelHealthRows();
  const channel = traffic.some(row => row.channel === filters.channel) || health.some(row => row.label === filters.channel) ? filters.channel : "all";
  const clients = channelClientsForPeriod(period);
  const client = clients.some(row => row.client === filters.client && (channel === "all" || row.channel === channel)) ? filters.client : "all";
  return <MobileShell active="/m/channels" model={buildLightweightShellModel(filters)} filters={filters} desktopPath="/channels">
    <ChannelOverview period={period} channel={channel} client={client} search={filters.search} sort={sort} health={health} traffic={traffic} clients={clients} apps={channelAppsForPeriod(period, { channel, client, search: filters.search })} daily={recentChannelTraffic().daily} />
  </MobileShell>;
}
