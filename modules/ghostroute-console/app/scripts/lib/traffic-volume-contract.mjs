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
  for (const {payload_json} of db.prepare("select payload_json from traffic_window_snapshots where kind='dashboard'").all()) {
    const model = JSON.parse(payload_json), clients = model.devices || [];
    if (!clients.length) continue;
    const total = clients.reduce((n,row)=>n+Number(row.bytes || 0),0);
    assert.equal(model.totals.observedBytes,total,'dashboard total differs from complete client sum');
    assert.equal(model.dashboardAnalytics.channelTraffic.reduce((n,r)=>n+r.bytes,0),total,'channel volumes differ from complete client sum');
    assert.equal(model.totals.observedBytes,model.totals.viaVpsBytes+model.totals.directBytes+model.totals.unknownBytes,'dashboard route partition differs from total');
    if (model.window==='today') {
      assert.equal(model.dashboardAnalytics.trafficToday.totalBytes,total,'dashboard chart differs from client volume');
    }
  }
  return { volumeBytes, detailBytes };
}
