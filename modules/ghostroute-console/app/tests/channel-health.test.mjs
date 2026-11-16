import test from 'node:test';
import assert from 'node:assert/strict';
import { channelHealthRows } from '../src/lib/channel-health.mjs';
import { validateSnapshotPayload } from '../scripts/lib/snapshot-contracts.mjs';

test('channel health keeps missing, disabled, runtime, and application evidence separate', () => {
  const now = Date.parse('2026-11-15T08:00:00Z');
  const inventory = { channel_profiles: [{ channel: 'anyT' }] };
  assert.ok(channelHealthRows(inventory, null, now).every(row => row.status === 'NOT OBSERVED'));
  const snapshot = validateSnapshotPayload('channel_health', {
    schema_version: 1, generated_at: new Date(now).toISOString(), source: { command: 'channel-health-report' },
    channels: [
      { channel: 'D', enabled: false, policy_running: false },
      { channel: 'anyT', installed: true, enabled: true, policy_running: true, watch_running: true, policy_current: true },
      { channel: 'Snell', enabled: null, policy_running: true, watch_running: false, policy_current: false },
      { channel: 'Amn', enabled: false, installed: true, policy_running: false, ingress_running: false },
    ],
  });
  const rows = channelHealthRows(inventory, snapshot, now);
  assert.deepEqual(rows.map(row => row.status), ['DISABLED', 'OK', 'WARN', 'DISABLED']);
  assert.ok(rows.every(row => row.application === 'Application probe not observed'));
  assert.equal(rows[1].profiles, 1);
  assert.ok(channelHealthRows(inventory, snapshot, now + 76 * 60_000).every(row => row.status === 'STALE'));
  snapshot.channels[1].watch_running = false;
  assert.equal(channelHealthRows(inventory, snapshot, now)[1].status, 'CRIT');
});
