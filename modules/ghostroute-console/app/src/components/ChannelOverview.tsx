import { bytes, shortDateTime, StatusBadge } from "@/components/Widgets";

type Traffic = { channel: string; bytes: number };
type Client = Traffic & { client: string; label: string; last_seen: string };
type Health = { channel: string; label: string; status: string; runtime: string; application: string; generated_at: string };
type Day = Traffic & { day: string };
type App = Traffic & { client: string; label: string; app: string; last_seen: string };

export function ChannelOverview({ traffic, clients, apps, daily, health, period }: { traffic: Traffic[]; clients: Client[]; apps: App[]; daily: Day[]; health: Health[]; period: string }) {
  return <>
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Channels</h2>
      <p>Read-only channel evidence · {period}. Totals are measured at different layers and cannot be added to the VPS interface total. Other global filters do not apply here.</p>
      <p>Route split may be unknown. Missing or inactive collection is not zero traffic. Channel D sessions appear after they close; Amn is collected only while enabled.</p>
      <h3>Runtime health</h3>
      <p>Runtime status is not an authenticated application test. The runtime cards below cover D, anyT, Snell and Amn; see Health Center for other channel evidence.</p>
      <div className="detail-list">{health.map((row) => <div className="detail-row" key={row.channel}>
        <span><strong>{row.label}</strong><small className="subtle block-detail">{row.runtime} · {row.application}{row.generated_at ? ` · ${shortDateTime(row.generated_at)}` : ""}</small></span>
        <StatusBadge value={row.status} />
      </div>)}</div>
      <h3>Traffic by channel</h3>
      {traffic.length ? <div className="detail-list">{traffic.map(row => <div className="detail-row" key={row.channel}><span>{row.channel}</span><strong>{bytes(row.bytes)}</strong></div>)}</div> : <p>No channel traffic observed for this period.</p>}
    </section>
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Clients by channel</h2>
      <p>Observed traffic and last recorded activity in the selected period; names require a verified private profile mapping.</p>
      {clients.length ? <div className="live-table-wrap"><table className="table"><thead><tr><th>Channel</th><th>Client / profile</th><th>Traffic</th><th>Last observed</th></tr></thead><tbody>
        {clients.map(row => <tr key={`${row.channel}:${row.client}`}><td>{row.channel}</td><td>{row.label || row.client}</td><td>{bytes(row.bytes)}</td><td>{row.last_seen ? shortDateTime(row.last_seen) : "Not observed"}</td></tr>)}
      </tbody></table></div> : <p>No client traffic observed for this period.</p>}
    </section>
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Observed apps by channel</h2>
      <p>Only destinations with client-facing app evidence are shown, using up to the 20 busiest channel profiles and 200 destinations per time segment. These partial estimates are not a breakdown of the channel total; encrypted profile traffic may have no app attribution.</p>
      {apps.length ? <div className="live-table-wrap"><table className="table"><thead><tr><th>Channel</th><th>Client / profile</th><th>App family</th><th>Observed evidence</th><th>Last observed</th></tr></thead><tbody>
        {apps.map(row => <tr key={`${row.channel}:${row.client}:${row.app}`}><td>{row.channel}</td><td>{row.label}</td><td>{row.app}</td><td>{bytes(row.bytes)}</td><td>{row.last_seen ? shortDateTime(row.last_seen) : "Not observed"}</td></tr>)}
      </tbody></table></div> : <p>No app-specific destination evidence observed for this period.</p>}
    </section>
    <section className="card" style={{ marginTop: 14 }}>
      <h2>Daily channel history</h2>
      <p>Last 30 days; earlier records can be incomplete. Intervals are assigned to their end time.</p>
      {daily.length ? <div className="detail-list">{daily.map(row => <div className="detail-row" key={`${row.day}:${row.channel}`}><span>{row.day} · {row.channel}</span><strong>{bytes(row.bytes)}</strong></div>)}</div> : <p>No history observed.</p>}
    </section>
  </>;
}
