import { classifyAppFamily, isClientFacingAppFamily } from './app-family.mjs';

// The 'all' lane is already the sum of its detailed lanes; never sum both.
export function channelTrafficFromSegments(db, segments) {
  const totals = new Map();
  const statement = db.prepare(`
    select channel, sum(bytes) as bytes from client_traffic_by_lane
    where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?
      and traffic_lane = 'all'
    group by channel
  `);
  for (const segment of segments) {
    for (const row of statement.all(segment.granularity, segment.start, segment.end)) {
      const channel = String(row.channel || 'Unknown');
      totals.set(channel, (totals.get(channel) || 0) + Number(row.bytes || 0));
    }
  }
  return Array.from(totals, ([channel, bytes]) => ({ channel, bytes }))
    .filter((row) => row.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

export function channelTrafficHistory(db, start, end) {
  const daily = db.prepare(`
    select bucket_key as day, channel, sum(bytes) as bytes
      from client_traffic_by_lane
     where bucket_granularity = 'day' and bucket_start_utc >= ? and bucket_start_utc < ? and traffic_lane = 'all'
     group by bucket_key, channel having sum(bytes) > 0 order by bucket_key desc, bytes desc
  `).all(start, end);
  const clients = db.prepare(`
    select client_key as client, max(client_label) as label, sum(bytes) as bytes
      from client_traffic_by_lane
     where bucket_granularity = 'day' and bucket_start_utc >= ? and bucket_start_utc < ? and traffic_lane = 'all' and client_key != ''
     group by client_key having sum(bytes) > 0 order by bytes desc limit 10
  `).all(start, end);
  return { daily, clients };
}

// Combine mutually exclusive pyramid segments; "all" already includes detailed lanes.
export function channelClientsFromSegments(db, segments) {
  const grouped = new Map();
  const query = db.prepare(`
    select channel, client_key as client, max(client_label) as label,
           sum(bytes) as bytes, max(last_seen_utc) as last_seen
      from client_traffic_by_lane
     where bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?
       and traffic_lane = 'all' and client_key != ''
     group by channel, client_key having sum(bytes) > 0
  `);
  for (const segment of segments) for (const row of query.all(segment.granularity, segment.start, segment.end)) {
    const key = JSON.stringify([row.channel, row.client]);
    const current = grouped.get(key) || { ...row, bytes: 0 };
    current.bytes += Number(row.bytes || 0);
    if (String(row.last_seen || '') > String(current.last_seen || '')) current.last_seen = row.last_seen;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.bytes - a.bytes);
}


// Destination evidence is partial; do not distribute a profile counter over apps.
export function channelAppEvidence(db, segments, clients, options = {}) {
  const groups = new Map();
  const query = db.prepare(`
    select destination_label, category, provider, sum(bytes) as bytes, max(last_seen_utc) as last_seen
      from client_destination_by_lane
     where client_key = ? and bucket_granularity = ? and bucket_start_utc >= ? and bucket_start_utc < ?
       and channel = ? and traffic_lane != 'all' and bytes > 0
     group by destination_label, category, provider order by bytes desc limit 200
  `);
  const selectedClients = clients.filter(row => (!options.channel || options.channel === 'all' || row.channel === options.channel) && (!options.client || options.client === 'all' || row.client === options.client));
  // A search or explicit profile must not be restricted to the busiest 20.
  const examinedClients = options.search || (options.client && options.client !== 'all') ? selectedClients : selectedClients.slice(0, 20);
  for (const client of examinedClients) for (const segment of segments) {
    for (const row of query.all(client.client, segment.granularity, segment.start, segment.end, client.channel)) {
      const domain = String(row.destination_label || '').trim().toLowerCase();
      if (!domain.includes('.') || /^(\d{1,3}\.){3}\d{1,3}$/.test(domain) || /[\s:/]/.test(domain)) continue;
      const app = classifyAppFamily({ destination: domain, category: row.category, provider: row.provider });
      if (!isClientFacingAppFamily(app) || app.app_source !== 'app_family_catalog') continue;
      const key = JSON.stringify([client.channel, client.client, app.app_family]);
      const entry = groups.get(key) || { channel: client.channel, client: client.client, label: client.label || client.client, app: app.app_family, bytes: 0, last_seen: '' };
      entry.bytes += Number(row.bytes || 0);
      if (String(row.last_seen || '') > entry.last_seen) entry.last_seen = row.last_seen;
      groups.set(key, entry);
    }
  }
  const needle = String(options.search || '').trim().toLowerCase();
  return [...groups.values()].filter(row => !needle || `${row.label} ${row.client} ${row.app}`.toLowerCase().includes(needle)).sort((a, b) => b.bytes - a.bytes).slice(0, 30);
}
