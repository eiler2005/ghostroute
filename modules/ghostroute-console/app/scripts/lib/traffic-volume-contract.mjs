import assert from 'node:assert/strict';

export function assertTrafficVolumeContract(db) {
  const sum = (table, where = '') => Number(db.prepare(`select coalesce(sum(bytes),0) bytes from ${table} ${where}`).get().bytes);
  const detailBytes = sum('client_destination_by_lane');
  assert.equal(sum('client_traffic_by_lane', "where traffic_lane != 'all'"), detailBytes, 'classified lanes differ from destination evidence');
  const layers = { '5min': 'client_traffic_5min', hour: 'client_traffic_hourly', day: 'client_traffic_daily', week: 'client_traffic_weekly', month: 'client_traffic_monthly' };
  let volumeBytes = 0;
  for (const [layer, table] of Object.entries(layers)) {
    const expected = sum(table);
    const actual = Number(db.prepare("select coalesce(sum(bytes),0) bytes from client_traffic_by_lane where traffic_lane='all' and bucket_granularity=?").get(layer).bytes);
    assert.equal(actual, expected, `all-lane ${layer} volume differs from total pyramid`);
    volumeBytes += expected;
  }
  assert.equal(sum('client_traffic_by_lane', "where traffic_lane='all'"), volumeBytes, 'all lanes differ from measured volume');
  return { volumeBytes, detailBytes };
}
