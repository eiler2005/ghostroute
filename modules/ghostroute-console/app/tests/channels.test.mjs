import test from 'node:test';
import assert from 'node:assert/strict';
import { channelId, explicitAccessChannel } from '../src/lib/channels.mjs';
import { normalizeRoutingPolicySnapshot } from '../src/lib/routing-policy-snapshot.mjs';
import { deviceRole } from '../src/lib/traffic-classification.mjs';

test('channel identity preserves explicit ingress before application hints', () => {
  for (const [value, id] of [['AnyTLS', 'anyT'], ['Channel anyT', 'anyT'], ['D', 'D'], ['Snell', 'Snell']]) {
    assert.equal(channelId(value), id);
    const row = { channel: value, client: 'Shadowrocket Naive', inbound: 'channel-c-in' };
    assert.equal(explicitAccessChannel(row), `Channel ${id}`);
    assert.equal(deviceRole(row), `Channel ${id} profile`);
  }
  assert.equal(explicitAccessChannel({ client: 'Shadowrocket', destination: 'anytls.example.invalid' }), '');
  assert.equal(explicitAccessChannel({ inbound_tag: 'channel-d-naiveproxy-socks-in' }), 'Channel D');
  assert.equal(explicitAccessChannel({ inbound_tag: 'channel-anytls-in' }), 'Channel anyT');
  assert.equal(explicitAccessChannel({ inbound_tag: 'snell-01' }), 'Channel Snell');
});

test('additive policy inventory never invents A or full-VPS support for new channels', () => {
  const result = normalizeRoutingPolicySnapshot({ channel_profiles: ['D', 'anytls', 'Snell', 'future'].map(channel => ({ channel, full_vps: true })) });
  assert.deepEqual(result.channel_profiles.map(row => row.channel), ['D', 'anyT', 'Snell', 'Unknown']);
  assert.ok(result.channel_profiles.every(row => !row.full_vps && !row.full_vps_supported));
  assert.equal(result.summary.channel_a_profiles, 0);
  assert.equal(result.summary.channel_anyt_profiles, 1);
  assert.equal(result.channel_profiles[0].lifecycle, 'experimental');
  assert.equal(result.channel_profiles[1].lifecycle, 'production');
  assert.ok(result.channel_profiles.every(row => row.coverage.includes('not established')));
});
