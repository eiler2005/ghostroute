import { ChannelOverview } from "@/components/ChannelOverview";
import { ConsoleShell } from "@/components/ConsoleShell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { buildHealthModel, channelAppsForPeriod, channelClientsForPeriod, channelTrafficForPeriod, getChannelHealthRows, recentChannelTraffic } from "@/lib/server/selectors";

export default async function ChannelsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const sort = typeof params.sort === "string" ? params.sort : "traffic";
  const view = typeof params.view === "string" ? params.view : "overview";
  const period = ["today", "week", "month", "last7", "last30"].includes(filters.period || "") ? filters.period! : "today";
  const traffic = channelTrafficForPeriod(period);
  const health = getChannelHealthRows();
  const channel = traffic.some(row => row.channel === filters.channel) || health.some(row => row.label === filters.channel) ? filters.channel : "all";
  const clients = channelClientsForPeriod(period);
  const client = filters.client || "all";
  return <ConsoleShell active="/channels" model={buildHealthModel(filters)} filters={filters}>
    <ChannelOverview period={period} channel={channel} client={client} search={filters.search} sort={sort} view={view} health={health} traffic={traffic} clients={clients} apps={view === "apps" ? channelAppsForPeriod(period, { channel, client, search: filters.search }) : []} daily={view === "history" ? recentChannelTraffic(client, period).daily : []} />
  </ConsoleShell>;
}
