import { ChannelOverview } from "@/components/ChannelOverview";
import { MobileShell } from "@/components/MobileShell";
import { todayOnlyFiltersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { buildLightweightShellModel, channelAppsForPeriod, channelClientsForPeriod, channelTrafficForPeriod, getChannelHealthRows, recentChannelTraffic } from "@/lib/server/selectors";

export default async function MobileChannelsPage({ searchParams }: { searchParams?: SearchParams }) {
  const filters = await todayOnlyFiltersFromSearchParams(searchParams);
  return <MobileShell active="/m/channels" model={buildLightweightShellModel(filters)} filters={filters} desktopPath="/channels">
    <ChannelOverview period="today" health={getChannelHealthRows()} traffic={channelTrafficForPeriod("today")} clients={channelClientsForPeriod("today")} apps={channelAppsForPeriod("today")} daily={recentChannelTraffic().daily} />
  </MobileShell>;
}
