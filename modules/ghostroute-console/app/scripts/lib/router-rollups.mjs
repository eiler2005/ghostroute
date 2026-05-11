const defaultText = (value) => String(value || "");

export function routerMskTimestampToUtc(value, text = defaultText) {
  const raw = text(value || "");
  if (!raw) return "";
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

export function routerMskKey(value, layer, text = defaultText) {
  const raw = text(value || "");
  if (!raw) return "";
  if (layer === "monthly") return raw.slice(0, 7);
  return raw.slice(0, 10);
}

export function normalizeRouterRollups(db, snapshotId, type, collectedAt, payload, deps) {
  const {
    text,
    number,
    json,
    loadDeviceAttributions,
    buildInventoryNetworkHints,
    resolveOperatorClient,
  } = deps;
  const registry = loadDeviceAttributions();
  const networkHints = buildInventoryNetworkHints(db, registry);
  const insert = db.prepare(`
    insert or replace into router_traffic_rollups(snapshot_id, collected_at, kind, layer, window_start_utc, window_msk_key,
      client_key, client_label, client_ip, channel, route, traffic_class, destination_ip, bytes, via_vps_bytes,
      direct_bytes, unknown_bytes, flows, source, evidence_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writeRow = (kind, row) => {
    const layer = text(row.layer || "");
    const windowValue = row.window_start_msk || row.window_start || row.window_start_utc;
    const windowStart = routerMskTimestampToUtc(windowValue, text);
    if (!layer || !windowStart) return;
    const resolved = resolveOperatorClient({ client_ip: row.client_ip, channel: row.channel, raw: row }, registry, networkHints);
    insert.run(
      snapshotId,
      collectedAt,
      kind,
      layer,
      windowStart,
      routerMskKey(windowValue, layer, text),
      resolved.client_key,
      resolved.client_label,
      text(row.client_ip || ""),
      resolved.channel || text(row.channel || "Home Wi-Fi/LAN", "Home Wi-Fi/LAN"),
      text(row.route || "Unknown", "Unknown"),
      text(row.traffic_class || "client", "client"),
      kind === "destination" ? text(row.destination_ip || "") : "",
      number(row.bytes),
      number(row.via_vps_bytes),
      number(row.direct_bytes),
      number(row.unknown_bytes),
      number(row.flows),
      text(row.source || "router_edge_rollup", "router_edge_rollup"),
      json({ ...row, snapshot_type: type })
    );
  };
  for (const row of payload.traffic_totals || []) writeRow("total", row);
  for (const row of payload.traffic_destinations || []) writeRow("destination", row);
}
