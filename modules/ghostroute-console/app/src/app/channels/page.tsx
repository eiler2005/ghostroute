import { ChannelOverview } from "@/components/ChannelOverview";
import { ConsoleShell } from "@/components/ConsoleShell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { buildHealthModel, channelAppsForPeriod, channelClientsForPeriod, channelTrafficForPeriod, getChannelHealthRows, recentChannelTraffic } from "@/lib/server/selectors";

export default async function ChannelsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await filtersFromSearchParams(searchParams);
  const period = filters.period || "today";
  return <ConsoleShell active="/channels" model={buildHealthModel(filters)} filters={filters}>
    <ChannelOverview period={period} health={getChannelHealthRows()} traffic={channelTrafficForPeriod(period)} clients={channelClientsForPeriod(period)} apps={channelAppsForPeriod(period)} daily={recentChannelTraffic().daily} />
  </ConsoleShell>;
}
