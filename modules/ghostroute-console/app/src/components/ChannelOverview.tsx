import { bytes, shortDateTime, StatusBadge } from "@/components/Widgets";

type Traffic = { channel: string; bytes: number };
type Client = Traffic & { client: string; label: string; last_seen: string };
type Health = { channel: string; label: string; status: string; runtime: string; application: string; generated_at: string };
type Day = Traffic & { day: string };
type App = Traffic & { client: string; label: string; app: string; last_seen: string };

export function ChannelOverview({ traffic, clients, apps, daily, health, period, channel = "all", client = "all", search = "", sort = "traffic", view = "overview" }: { traffic: Traffic[]; clients: Client[]; apps: App[]; daily: Day[]; health: Health[]; period: string; channel?: string; client?: string; search?: string; sort?: string; view?: string }) {
  const channels = Array.from(new Set([...traffic.map(row => row.channel), ...health.map(row => row.label)])).sort();
  const channelClients = clients.filter(row => channel === "all" || row.channel === channel);
  const chosenClient = client;
  const needle = search.trim().toLowerCase();
  const filteredClients = channelClients.filter(row => (chosenClient === "all" || row.client === chosenClient) && (!needle || `${row.label} ${row.client}`.toLowerCase().includes(needle))).sort((a,b) => sort === "name" ? String(a.label).localeCompare(String(b.label)) : sort === "recent" ? String(b.last_seen).localeCompare(String(a.last_seen)) : b.bytes - a.bytes);
  const filteredApps = apps.filter(row => (channel === "all" || row.channel === channel) && (chosenClient === "all" || row.client === chosenClient) && (!needle || `${row.label} ${row.client} ${row.app}`.toLowerCase().includes(needle)));
  const filteredTraffic = chosenClient === "all" ? traffic.filter(row => channel === "all" || row.channel === channel) : channelClients.filter(row => row.client === chosenClient).map(row => ({ channel: row.channel, bytes: row.bytes }));
  const filteredDaily = daily.filter(row => channel === "all" || row.channel === channel);
  const filteredHealth = health.filter(row => channel === "all" || row.label === channel || row.channel === channel);
  const activeView = ["overview", "clients", "apps", "history"].includes(view) ? view : "overview";
  const periodLabel: Record<string, string> = { today: "Today", last7: "Last 7 days", last30: "Last 30 days", week: "This week", month: "This month" };
  const viewHref = (next: string) => {
    const params = new URLSearchParams({ period, channel, client: chosenClient, search, sort, view: next });
    return `?${params.toString()}`;
  };
  return <>
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Channels</h2>
      <form className="filters channel-filters" method="get">
        <input type="hidden" name="view" value={activeView} />
        <label>Period <select name="period" defaultValue={period}><option value="today">Today</option><option value="last7">Last 7 days</option><option value="last30">Last 30 days</option><option value="week">This week</option><option value="month">This month</option></select></label>
        <label>Channel <select name="channel" defaultValue={channel}><option value="all">All channels</option>{channels.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Client <select name="client" defaultValue={chosenClient}><option value="all">All clients</option>{chosenClient !== "all" && !channelClients.some(row => row.client === chosenClient) && <option value={chosenClient}>Selected client (no traffic in this period)</option>}{channelClients.map(row => <option key={`${row.channel}:${row.client}`} value={row.client}>{row.label || row.client}</option>)}</select></label>
        <label>Search <input name="search" defaultValue={search} placeholder="Client or app" /></label>
        <label>Sort clients <select name="sort" defaultValue={["traffic", "recent", "name"].includes(sort) ? sort : "traffic"}><option value="traffic">Traffic</option><option value="recent">Recent</option><option value="name">Name</option></select></label>
        <div className="channel-filter-actions"><button type="submit">Apply</button><a className="muted-button" href="?">Reset</a></div>
      </form>
      <nav className="intelligence-tabs" aria-label="Channel views">{[["overview", "Overview"], ["clients", "Clients"], ["apps", "Apps"], ["history", "History"]].map(([key, label]) => <a key={key} className={`muted-button ${activeView === key ? "active" : ""}`} aria-current={activeView === key ? "page" : undefined} href={viewHref(key)}>{label}</a>)}</nav>
      <details className="channel-evidence-notes"><summary>About traffic and collection · {periodLabel[period] || period}</summary>
        <p>Seven- and thirty-day windows include today in Moscow time. Channel totals follow the selected client; search only filters client and app lists. Measurements at different layers cannot be added to the VPS interface total.</p>
        <p>Route split may be unknown. Missing or inactive collection is not zero traffic. Channel D sessions appear after they close; Amn is collected only while enabled.</p>
      </details>
      {activeView === "overview" && <>
      <h3>Runtime health</h3>
      <p>Runtime status is not an authenticated application test. The runtime cards below cover D, anyT, Snell and Amn; see Health Center for other channel evidence.</p>
      <div className="channel-health-grid">{filteredHealth.map((row) => <div className="card" key={row.channel}>
        <div className="toolbar"><strong>{row.label}</strong><StatusBadge value={row.status} /></div>
        <p className="subtle">{row.application}</p>
        <details><summary>Runtime details</summary><small className="subtle block-detail">{row.runtime}{row.generated_at ? ` · ${shortDateTime(row.generated_at)}` : ""}</small></details>
        <a className="muted-button" href={`?${new URLSearchParams({ period, channel: row.label, client: "all", search: "", sort, view: "overview" }).toString()}`}>View channel</a>
      </div>)}</div>
      {!filteredHealth.length && <p>Runtime status is not available in this view; see Health Center.</p>}
      <h3>Traffic by channel</h3>
      {filteredTraffic.length ? <div className="detail-list">{filteredTraffic.map(row => <div className="detail-row" key={row.channel}><span>{row.channel}</span><strong>{bytes(row.bytes)}</strong></div>)}</div> : <p>No channel traffic observed for this period.</p>}
      </>}
    </section>
    {activeView === "clients" && <section className="card" style={{ marginTop: 14 }}>
      <h2>Clients by channel</h2>
      <p>Observed traffic and last recorded activity in the selected period; names require a verified private profile mapping.</p>
      {filteredClients.length ? <div className="live-table-wrap"><table className="table"><thead><tr><th>Channel</th><th>Client / profile</th><th>Traffic</th><th>Last observed interval</th></tr></thead><tbody>
        {filteredClients.map(row => <tr key={`${row.channel}:${row.client}`}><td>{row.channel}</td><td>{row.label || row.client}</td><td>{bytes(row.bytes)}</td><td>{row.last_seen ? shortDateTime(row.last_seen).replace(/:\d{2}\.\d{3}$/, "") : "Not observed"}</td></tr>)}
      </tbody></table></div> : <p>No client traffic observed for this period.</p>}
    </section>}
    {activeView === "apps" && <section className="card" style={{ marginTop: 14 }}>
      <h2>Observed apps by channel</h2>
      <p>Only destinations with client-facing app evidence are shown. Without search or a selected client, the 20 busiest channel profiles are examined; each time segment is limited to 200 destinations. These partial estimates are not a breakdown of the channel total; encrypted profile traffic may have no app attribution.</p>
      {filteredApps.length ? <div className="live-table-wrap"><table className="table"><thead><tr><th>Channel</th><th>Client / profile</th><th>App family</th><th>Observed evidence</th><th>Last observed interval</th></tr></thead><tbody>
        {filteredApps.map(row => <tr key={`${row.channel}:${row.client}:${row.app}`}><td>{row.channel}</td><td>{row.label}</td><td>{row.app}</td><td>{bytes(row.bytes)}</td><td>{row.last_seen ? shortDateTime(row.last_seen).replace(/:\d{2}\.\d{3}$/, "") : "Not observed"}</td></tr>)}
      </tbody></table></div> : <p>No app-specific destination evidence observed for this period.</p>}
    </section>}
    {activeView === "history" && <section className="card" style={{ marginTop: 14 }}>
      <h2>Daily channel history</h2>
      <p>Selected period · Earlier records can be incomplete. Missing days are not necessarily zero. Intervals are assigned to their end time.</p>
      {filteredDaily.length ? <div className="channel-history">{filteredDaily.map(row => <div className="channel-history-row" key={`chart:${row.day}:${row.channel}`}><span>{row.day} · {row.channel}</span><span className="channel-history-track"><span style={{ width: `${100 * row.bytes / Math.max(...filteredDaily.map(item => item.bytes))}%` }} /></span><strong>{bytes(row.bytes)}</strong></div>)}</div> : <p>No history observed.</p>}
    </section>}
  </>;
}
