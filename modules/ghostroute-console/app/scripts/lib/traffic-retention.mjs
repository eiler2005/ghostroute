export const MAX_TRAFFIC_RETENTION_DAYS = 90;

export function trafficRetentionDays(value, fallback, minimum = 1) {
  const parsed = Number(value ?? fallback);
  const days = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(MAX_TRAFFIC_RETENTION_DAYS, Math.max(minimum, days));
}

// Fixed schema-owned names only. Operator settings, audit and client credentials
// are outside this list. Bucket start time bounds coarse history conservatively.
const historyColumns = {
  normalized_devices: 'collected_at',
  normalized_flows: 'collected_at',
  normalized_dns: 'collected_at',
  traffic_facts: "coalesce(nullif(event_ts_utc, ''), collected_at)",
  traffic_clients: 'collected_at',
  traffic_dns_links: 'collected_at',
  traffic_attribution_gaps: 'collected_at',
  router_traffic_rollups: "coalesce(nullif(window_start_utc, ''), collected_at)",
  hourly_traffic: 'hour_key',
  events: 'occurred_at',
  route_decisions: 'occurred_at',
  flow_sessions: "coalesce(nullif(last_seen, ''), collected_at)",
  dns_query_log: "coalesce(nullif(event_ts_utc, ''), collected_at)",
  device_inventory: 'last_seen',
  destination_enrichment: 'last_seen',
  decision_candidates: 'updated_at_utc',
  filter_decisions: 'observed_at_utc',
  client_traffic_by_lane: 'bucket_start_utc',
  client_destination_by_lane: 'bucket_start_utc',
  client_route_evidence_defects: 'bucket_start_utc',
  traffic_window_snapshots: 'window_end_utc',
  top_clients_window: 'computed_at_utc',
  top_destinations_window: 'computed_at_utc',
};
for (const prefix of ['client_traffic', 'client_destination_traffic', 'dns_log']) {
  for (const [layer, column] of Object.entries({
    '5min': 'bucket_start_utc', hourly: 'hour_start_utc', daily: 'day_start_utc',
    weekly: 'week_start_utc', monthly: 'month_start_utc',
  })) historyColumns[`${prefix}_${layer}`] = column;
}

export function pruneTrafficHistory(db, now) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid traffic retention time');
  const cutoff = new Date(timestamp - MAX_TRAFFIC_RETENTION_DAYS * 86400000).toISOString();
  const deleted = {};
  for (const [table, column] of Object.entries(historyColumns)) {
    deleted[table] = db.prepare(`delete from ${table} where ${column} < ?`).run(cutoff).changes;
  }
  deleted.snapshots = db.prepare(`delete from snapshots
    where type in ('traffic', 'traffic_summary', 'traffic_facts', 'traffic_evidence', 'router_rollups', 'dns', 'live')
      and collected_at < ?`).run(cutoff).changes;
  return { max_days: MAX_TRAFFIC_RETENTION_DAYS, cutoff, deleted };
}
