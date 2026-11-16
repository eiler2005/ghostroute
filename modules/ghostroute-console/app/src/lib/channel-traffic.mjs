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
